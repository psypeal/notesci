"""Draft workflow — multi-stage agentic pipeline.

The user starts a workflow by answering an upfront interview, then the
backend runs the pipeline as a background asyncio task:

  1. gather_materials  — top-k retrieval over the project; if the
                         result count is below the target, kick off a
                         web search (via an installed Tavily / Firecrawl
                         MCP server, or a graceful skip if none is
                         available) and ingest the new sources back so
                         the project graph view picks them up
  2. draft             — invoke an LLM with the content-research-writer
                         skill brief + the gathered material excerpts;
                         output becomes ``raw_content``
  3. polish            — invoke an LLM with the writing-clearly-and-
                         concisely skill brief on the raw content
  4. review            — fan out the polished content to the user-
                         specified expert panel (each persona is its
                         own LLM invocation with a tight reviewer
                         prompt). Each reviewer returns APPROVE or
                         REVISE + structured feedback
  5. iterate / approve — if any reviewer voted REVISE, loop back to
                         step 2 with the consolidated feedback. If all
                         approved, freeze ``final_content`` and mark
                         the workflow ``approved``. Bounded by
                         ``max_iterations`` to prevent runaway loops

Every state transition + agent output excerpt + reviewer vote is
appended to the row's ``events`` jsonb so the UI can render a timeline
without a separate table. The orchestrator commits after every step so
a frontend refresh always reads the latest state.

Errors in any stage land in the ``error`` field and flip the status to
``failed``; the workflow stops there.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from langchain_core.messages import HumanMessage, SystemMessage
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .agent.embeddings import make_embedding_model
from .agent.messages import extract_text
from .agent.providers import make_chat_model, resolve_default_model
from .config import settings
from .db import get_conn
from .skills import compose_skill_system_message, detect_skills

# Default knobs. Each can be overridden in the interview body.
DEFAULT_MATERIAL_TOP_K = 8
DEFAULT_TARGET_MATERIAL_COUNT = 5
DEFAULT_MAX_ITERATIONS = 5
DEFAULT_WORD_COUNT = 800
# Web-search budget when materials are insufficient. We don't actually
# call out yet — see _maybe_search_web; this caps the number of queries
# the orchestrator would issue when the integration lands.
DEFAULT_WEB_SEARCH_BUDGET = 3


PanelVerdict = Literal["APPROVE", "REVISE"]


class PanelVerdictReply(BaseModel):
    """Structured-output schema for one reviewer's vote.

    Used when the underlying provider supports ``with_structured_output``;
    falls back to a text-parse otherwise (see ``_review_one``).
    """
    verdict: PanelVerdict = Field(
        ..., description="APPROVE if the section needs no required changes; "
                        "REVISE if any blocking issue remains."
    )
    feedback: str = Field(
        ..., description="One paragraph (≤6 sentences). Specific changes the "
                        "writer must make. Required even when APPROVE."
    )


@dataclass
class PanelMember:
    name: str
    persona: str  # short description, e.g. "rigorous methodologist"


@dataclass
class Interview:
    """Pre-flight answers — captured by the start endpoint and stored on the row.

    The three ``*_model`` fields let the user route different stages to
    different LLMs ("draft with Sonnet, polish with GPT-5, review with
    the cheapest"). Each defaults to ``None`` meaning "use the
    workflow's top-level ``model_override`` (or server default if that
    is also unset)."
    """
    word_count: int = DEFAULT_WORD_COUNT
    paragraph_structure: str = "intro · 3-4 body paragraphs · conclusion"
    panel: list[PanelMember] = field(default_factory=list)
    web_search: bool = True
    target_material_count: int = DEFAULT_TARGET_MATERIAL_COUNT
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    style_notes: str = ""
    draft_model: str | None = None
    polish_model: str | None = None
    review_model: str | None = None

    @classmethod
    def from_dict(cls, d: dict | None) -> "Interview":
        d = d or {}
        panel_raw = d.get("panel") or []

        def _model(v: Any) -> str | None:
            """Coerce empty strings to None — the UI sends '' for unset."""
            if v is None:
                return None
            s = str(v).strip()
            return s or None

        return cls(
            word_count=int(d.get("word_count") or DEFAULT_WORD_COUNT),
            paragraph_structure=d.get("paragraph_structure")
                or "intro · 3-4 body paragraphs · conclusion",
            panel=[
                PanelMember(name=p["name"], persona=p["persona"])
                for p in panel_raw
                if p.get("name") and p.get("persona")
            ],
            web_search=bool(d.get("web_search", True)),
            target_material_count=int(
                d.get("target_material_count") or DEFAULT_TARGET_MATERIAL_COUNT
            ),
            max_iterations=int(d.get("max_iterations") or DEFAULT_MAX_ITERATIONS),
            style_notes=d.get("style_notes") or "",
            draft_model=_model(d.get("draft_model")),
            polish_model=_model(d.get("polish_model")),
            review_model=_model(d.get("review_model")),
        )

    def model_for(self, stage: str, fallback: str | None) -> str | None:
        """Pick the model id for a given stage. Per-stage override wins;
        otherwise fall back to the workflow's top-level model (which
        itself falls back to server default at the factory).
        """
        if stage == "draft":
            return self.draft_model or fallback
        if stage == "polish":
            return self.polish_model or fallback
        if stage == "review":
            return self.review_model or fallback
        return fallback


def default_panel() -> list[PanelMember]:
    """Sensible default reviewer panel when the user doesn't customise."""
    return [
        PanelMember(
            name="Methodologist",
            persona="A rigorous reviewer who insists every claim is grounded in cited evidence and flags unsupported leaps.",
        ),
        PanelMember(
            name="Editor",
            persona="A senior science editor who enforces conciseness, accurate terminology, and a clear narrative arc.",
        ),
        PanelMember(
            name="Domain expert",
            persona="A practitioner in the paper's field who catches conceptual errors and missing context.",
        ),
    ]


# ---------------------------------------------------------------------------
# Event log helpers — every meaningful step appends an entry. The events
# list backs the workflow timeline in the UI; keep payloads small (no
# full draft contents — those live in raw_content / polished_content).
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _event(kind: str, **payload: Any) -> dict:
    return {"at": _now_iso(), "kind": kind, **payload}


# ---------------------------------------------------------------------------
# DB helpers — small wrappers so the orchestrator stays readable
# ---------------------------------------------------------------------------

# --- Supersede-safe writes -----------------------------------------------
# A new ``POST /drafts/{id}/workflow`` call against the same draft marks
# the previous row as ``cancelled`` and starts a fresh row. The previous
# orchestrator task is still running in the background — without this
# guard, its next ``UPDATE`` would happily overwrite the cancellation
# state and trample the new workflow's status if it shares the same
# row id (it won't — but the same race exists for in-place cancellation
# via the cancel endpoint). Every mutating statement now appends:
#
#     AND id=%s AND status NOT IN ('cancelled','failed','approved')
#
# and returns the workflow id on RETURNING so callers can detect the
# 0-row case and stop the loop early.
_TERMINAL_GUARD = " AND id=%s AND status NOT IN ('cancelled','failed','approved')"


class _Superseded(Exception):
    """Raised when an UPDATE didn't apply because the row is terminal.

    The orchestrator loop catches this and exits cleanly.
    """


async def _set_status(workflow_id: UUID, status: str, *, event: dict | None = None) -> None:
    async with get_conn() as conn:
        if event is not None:
            cur = await conn.execute(
                "UPDATE draft_workflows "
                "SET status=%s, updated_at=now(), "
                "    events = events || %s::jsonb "
                "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
                (status, Jsonb([event]), workflow_id, workflow_id),
            )
        else:
            cur = await conn.execute(
                "UPDATE draft_workflows SET status=%s, updated_at=now() "
                "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
                (status, workflow_id, workflow_id),
            )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))


async def _append_event(workflow_id: UUID, event: dict) -> None:
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE draft_workflows "
            "SET events = events || %s::jsonb, updated_at=now() "
            "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
            (Jsonb([event]), workflow_id, workflow_id),
        )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))


async def _save_raw(workflow_id: UUID, raw: str) -> None:
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE draft_workflows SET raw_content=%s, updated_at=now() "
            "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
            (raw, workflow_id, workflow_id),
        )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))


async def _save_polished(workflow_id: UUID, polished: str) -> None:
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE draft_workflows SET polished_content=%s, updated_at=now() "
            "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
            (polished, workflow_id, workflow_id),
        )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))


async def _save_panel_votes(workflow_id: UUID, votes: list[dict]) -> None:
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE draft_workflows SET panel_votes=%s, updated_at=now() "
            "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING id",
            (Jsonb(votes), workflow_id, workflow_id),
        )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))


async def _bump_iteration(workflow_id: UUID) -> int:
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE draft_workflows SET iteration = iteration + 1, updated_at=now() "
            "WHERE id=%s" + _TERMINAL_GUARD + " RETURNING iteration",
            (workflow_id, workflow_id),
        )
        row = await cur.fetchone()
        await conn.commit()
    if row is None:
        raise _Superseded(str(workflow_id))
    return int(row[0])


async def _finish(workflow_id: UUID, status: str, *, final: str | None = None,
                  error: str | None = None) -> None:
    """Set the terminal status. Allowed to overwrite an already-terminal
    row (e.g. cancelled → failed if the orchestrator hits an error after
    cancellation) so the most-recent reason wins."""
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE draft_workflows "
            "SET status=%s, final_content=%s, error=%s, "
            "    completed_at=now(), updated_at=now(), "
            "    events = events || %s::jsonb "
            "WHERE id=%s",
            (
                status,
                final,
                error,
                Jsonb([_event("workflow_complete", status=status, error=error)]),
                workflow_id,
            ),
        )
        await conn.commit()


# ---------------------------------------------------------------------------
# Stage 1 — gather materials. Top-k retrieval, optionally augmented by
# web search when the project doesn't have enough relevant chunks.
# ---------------------------------------------------------------------------

@dataclass
class MaterialHit:
    chunk_id: int
    material_id: str
    title: str | None
    text: str
    distance: float


async def _retrieve_project_materials(
    project_id: UUID, prompt: str, top_k: int
) -> list[MaterialHit]:
    embedder = make_embedding_model()
    qvec = await embedder.aembed_query(prompt)
    async with get_conn() as conn:
        from pgvector.psycopg import register_vector_async
        await register_vector_async(conn)
        cur = await conn.execute(
            "SELECT c.id, m.id, m.title, c.text, c.embedding <=> %s::vector AS dist "
            "FROM chunks c JOIN materials m ON m.id = c.material_id "
            "WHERE m.project_id = %s ORDER BY dist LIMIT %s",
            (qvec, project_id, top_k),
        )
        rows = await cur.fetchall()
    return [
        MaterialHit(
            chunk_id=r[0], material_id=str(r[1]), title=r[2],
            text=r[3], distance=float(r[4]),
        )
        for r in rows
    ]


async def _maybe_search_web(
    workflow_id: UUID, prompt: str, current_count: int, target_count: int,
    enable: bool, budget: int,
) -> int:
    """Issue web-search queries via an installed MCP web-search tool when
    the project's own materials are insufficient.

    Returns the number of new sources added. Currently a stub that records
    the intent in the event log; the actual MCP tool dispatch lands when
    the per-workspace tool fetcher is integrated with the workflow runner
    (right now it requires a chat session id). For now we record what
    *would* have been searched so the timeline stays informative and
    operators can manually fill the gap.
    """
    if not enable:
        return 0
    needed = max(0, target_count - current_count)
    if needed == 0:
        return 0
    await _append_event(workflow_id, _event(
        "web_search_planned",
        needed=needed, budget=budget, query=prompt,
        note="Will dispatch when a Tavily/Firecrawl MCP server is installed.",
    ))
    return 0


def _format_materials(hits: list[MaterialHit]) -> str:
    if not hits:
        return (
            "(no project materials matched the prompt — write from general "
            "knowledge and flag any factual claim that needs grounding)"
        )
    return "\n\n".join(
        f"[{i + 1}] {h.title or 'untitled'}\n{h.text.strip()}"
        for i, h in enumerate(hits)
    )


# ---------------------------------------------------------------------------
# Stage 2 — draft. content-research-writer skill brief + materials.
# ---------------------------------------------------------------------------

async def _stage_draft(
    workflow_id: UUID, prompt: str, interview: Interview,
    materials: list[MaterialHit], previous_feedback: str | None,
    model_override: str | None,
) -> str:
    skill_block = compose_skill_system_message(detect_skills("draft an abstract"))
    if not skill_block:
        # Force-load the writer skill even if the prompt didn't trigger it.
        from .skills import all_skills
        writer = next(s for s in all_skills() if s.name == "content-research-writer")
        skill_block = compose_skill_system_message([writer])
    assert skill_block

    materials_block = _format_materials(materials)
    instructions = (
        f"USER PROMPT: {prompt}\n\n"
        f"TARGET STRUCTURE: {interview.paragraph_structure}\n"
        f"TARGET WORD COUNT: ~{interview.word_count} words\n"
    )
    if interview.style_notes:
        instructions += f"STYLE NOTES: {interview.style_notes}\n"
    if previous_feedback:
        instructions += (
            "\nREVIEWER FEEDBACK FROM THE PREVIOUS ITERATION:\n"
            f"{previous_feedback}\n"
            "Address every point. Do not regress on rules already enforced.\n"
        )
    instructions += (
        "\nMATERIALS (cite by [N] inline; if you need a fact not present here, "
        "flag it with [SPECIFY: ...] rather than inventing):\n\n"
        f"{materials_block}\n\n"
        "Write the section now."
    )

    # cache=True: the skill brief + materials block is a long static
    # prefix that benefits from Anthropic prompt caching (no-op on
    # providers that don't expose per-request caching).
    llm = make_chat_model(model_override, cache=True)
    msgs = [SystemMessage(content=skill_block), HumanMessage(content=instructions)]
    t0 = time.monotonic()
    reply = await llm.ainvoke(msgs)
    duration_ms = int((time.monotonic() - t0) * 1000)
    text = extract_text(reply.content)

    await _append_event(workflow_id, _event(
        "draft_complete",
        chars=len(text), duration_ms=duration_ms,
        model=model_override or resolve_default_model(),
    ))
    return text


# ---------------------------------------------------------------------------
# Stage 3 — polish. writing-clearly-and-concisely skill brief.
# ---------------------------------------------------------------------------

async def _stage_polish(
    workflow_id: UUID, raw: str, interview: Interview, model_override: str | None,
) -> str:
    from .skills import all_skills
    editor = next(s for s in all_skills() if s.name == "writing-clearly-and-concisely")
    skill_block = compose_skill_system_message([editor])
    assert skill_block

    instructions = (
        "Edit the following draft. Apply your full ruleset. Preserve every number, "
        "citation marker [N], and scientific finding exactly. Output ONLY the edited "
        f"prose, no commentary, no word-count line.\n\nDRAFT:\n\n{raw}"
    )

    # Skill brief is the heavy static prefix — same caching rationale
    # as _stage_draft.
    llm = make_chat_model(model_override, cache=True)
    msgs = [SystemMessage(content=skill_block), HumanMessage(content=instructions)]
    t0 = time.monotonic()
    reply = await llm.ainvoke(msgs)
    duration_ms = int((time.monotonic() - t0) * 1000)
    text = extract_text(reply.content)
    await _append_event(workflow_id, _event(
        "polish_complete",
        chars_in=len(raw), chars_out=len(text), duration_ms=duration_ms,
        model=model_override or resolve_default_model(),
    ))
    return text


# ---------------------------------------------------------------------------
# Stage 4 — review. Parallel panel; each member is one LLM invocation.
# ---------------------------------------------------------------------------

_REVIEWER_SYSTEM = (
    "You are a peer reviewer with the following persona:\n\n"
    "  {persona}\n\n"
    "Read the SECTION below. Respond ONLY in this exact format:\n\n"
    "VERDICT: APPROVE\n"
    "or\n"
    "VERDICT: REVISE\n"
    "FEEDBACK: <one paragraph, ≤6 sentences, listing specific changes the writer must make>\n\n"
    "Rules for voting:\n"
    "- APPROVE only when the section meets your standard with no required changes.\n"
    "- REVISE for any blocking issue: unsupported claim, missing data, unclear logic, "
    "weak structure, factual error, AI-sounding language, or violations of the user's "
    "structural targets.\n"
    "- Be specific: name the sentence, paragraph, or claim that needs changing.\n"
    "- Do NOT request stylistic preferences as REVISE — only blockers."
)


async def _review_one(
    member: PanelMember, polished: str, model_override: str | None,
) -> dict:
    sys = _REVIEWER_SYSTEM.format(persona=member.persona)
    msgs = [SystemMessage(content=sys), HumanMessage(content=f"SECTION:\n\n{polished}")]
    t0 = time.monotonic()
    verdict: PanelVerdict = "REVISE"
    feedback = ""
    # Try structured output first — most providers support it. If the
    # provider/model rejects (older OpenAI completions endpoints, some
    # Google models), fall back to text parsing.
    try:
        llm = make_chat_model(model_override, structured=PanelVerdictReply)
        reply: PanelVerdictReply = await llm.ainvoke(msgs)
        verdict = reply.verdict
        feedback = (reply.feedback or "").strip()
    except Exception:
        # Fallback: plain chat call, parse VERDICT:/FEEDBACK: from text.
        llm = make_chat_model(model_override)
        raw_reply = await llm.ainvoke(msgs)
        text = extract_text(raw_reply.content)
        feedback = text.strip()
        for line in text.splitlines():
            s = line.strip().upper()
            if s.startswith("VERDICT:") and "APPROVE" in s:
                verdict = "APPROVE"
                break
            if s.startswith("VERDICT:") and "REVISE" in s:
                verdict = "REVISE"
                break
        upper = text.upper()
        marker = "FEEDBACK:"
        if marker in upper:
            idx = upper.index(marker)
            feedback = text[idx + len(marker):].strip()
    duration_ms = int((time.monotonic() - t0) * 1000)
    return {
        "name": member.name,
        "persona": member.persona,
        "verdict": verdict,
        "feedback": feedback,
        "duration_ms": duration_ms,
        "model": model_override or resolve_default_model(),
    }


async def _stage_review(
    workflow_id: UUID, polished: str, panel: list[PanelMember],
    model_override: str | None,
) -> list[dict]:
    if not panel:
        panel = default_panel()
    votes = await asyncio.gather(*[
        _review_one(m, polished, model_override) for m in panel
    ])
    await _save_panel_votes(workflow_id, list(votes))
    for v in votes:
        await _append_event(workflow_id, _event(
            "review_vote", reviewer=v["name"], verdict=v["verdict"],
            duration_ms=v["duration_ms"], model=v.get("model"),
        ))
    return list(votes)


def _consolidate_feedback(votes: list[dict]) -> str:
    parts = [f"From {v['name']} ({v['persona']}): {v['feedback']}"
             for v in votes if v["verdict"] == "REVISE"]
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Orchestrator entry point
# ---------------------------------------------------------------------------

async def run_workflow(
    workflow_id: UUID,
    project_id: UUID,
    member_id: UUID,
    prompt: str,
    interview_payload: dict | None,
    model_override: str | None = None,
) -> None:
    """Execute the full pipeline. Designed to run as a background task —
    every stage commits state so a UI refresh shows live progress.

    The function never raises; failures land in the row's ``error``
    field and the status flips to ``failed``.
    """
    interview = Interview.from_dict(interview_payload)
    if not interview.panel:
        interview.panel = default_panel()

    draft_model = interview.model_for("draft", model_override)
    polish_model = interview.model_for("polish", model_override)
    review_model = interview.model_for("review", model_override)

    try:
        await _append_event(workflow_id, _event(
            "models_resolved",
            top_level=model_override or resolve_default_model(),
            draft=draft_model or resolve_default_model(),
            polish=polish_model or resolve_default_model(),
            review=review_model or resolve_default_model(),
        ))
    except _Superseded:
        # The workflow row was cancelled / superseded before we got
        # started; nothing more to do.
        return

    try:
        # Stage 1: materials
        await _set_status(workflow_id, "gathering_materials",
                          event=_event("stage_enter", stage="gathering_materials"))
        materials = await _retrieve_project_materials(
            project_id, prompt, DEFAULT_MATERIAL_TOP_K
        )
        await _append_event(workflow_id, _event(
            "materials_retrieved", count=len(materials),
        ))
        if len(materials) < interview.target_material_count and interview.web_search:
            added = await _maybe_search_web(
                workflow_id, prompt,
                current_count=len(materials),
                target_count=interview.target_material_count,
                enable=True,
                budget=DEFAULT_WEB_SEARCH_BUDGET,
            )
            if added:
                materials = await _retrieve_project_materials(
                    project_id, prompt, DEFAULT_MATERIAL_TOP_K
                )

        previous_feedback: str | None = None
        polished = ""

        # Stages 2-4 inside the iteration loop
        while True:
            iteration = await _bump_iteration(workflow_id)

            # Stage 2: draft
            await _set_status(workflow_id, "drafting",
                              event=_event("stage_enter", stage="drafting",
                                           iteration=iteration))
            raw = await _stage_draft(
                workflow_id, prompt, interview, materials,
                previous_feedback, draft_model,
            )
            await _save_raw(workflow_id, raw)

            # Stage 3: polish
            await _set_status(workflow_id, "polishing",
                              event=_event("stage_enter", stage="polishing",
                                           iteration=iteration))
            polished = await _stage_polish(
                workflow_id, raw, interview, polish_model,
            )
            await _save_polished(workflow_id, polished)

            # Stage 4: panel review
            await _set_status(workflow_id, "reviewing",
                              event=_event("stage_enter", stage="reviewing",
                                           iteration=iteration))
            votes = await _stage_review(
                workflow_id, polished, interview.panel, review_model,
            )

            approves = sum(1 for v in votes if v["verdict"] == "APPROVE")
            if approves == len(votes):
                await _finish(workflow_id, "approved", final=polished)
                return

            if iteration >= interview.max_iterations:
                # Out of revision budget — record the votes and stop.
                await _finish(
                    workflow_id, "failed",
                    final=polished,
                    error=(f"Hit max_iterations={interview.max_iterations} with "
                           f"{approves}/{len(votes)} approvals."),
                )
                return

            # At least one REVISE — loop back to drafting with consolidated feedback.
            previous_feedback = _consolidate_feedback(votes)
            await _set_status(workflow_id, "revising",
                              event=_event("stage_enter", stage="revising",
                                           iteration=iteration,
                                           rejecters=[
                                               v["name"] for v in votes
                                               if v["verdict"] == "REVISE"
                                           ]))
    except _Superseded:
        # The row was cancelled / superseded mid-flight (cancel endpoint
        # or new workflow start). Don't flip to ``failed`` — the user
        # already saw the cancellation. Exit silently.
        return
    except Exception as exc:  # pragma: no cover — defensive
        await _finish(workflow_id, "failed", error=f"{type(exc).__name__}: {exc}")
