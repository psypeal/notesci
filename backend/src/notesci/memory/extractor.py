"""Memory extractor — batch, confidence-gated, off the chat hot path.

Two write paths exist now:

  1. **Background batch** (the normal case). The chat handler enqueues
     a job in ``memory_extraction_jobs`` on every turn. A sweeper picks
     up jobs whose session has been idle for ~10 min and runs ONE LLM
     call over the full conversation. The extractor returns facts with
     a ``confidence`` field; only ``high`` rows are persisted.

  2. **Hot-path tool** (``memory_save``). Bound onto the agent's
     toolset so the model can write a memory mid-turn when the user
     explicitly asks ("remember that…"). Explicit intent is the
     strongest possible signal — these write as ``confidence='high'``
     unconditionally.

Why this design (changed 2026-05-27, mem0/Letta-inspired):
  * Per-turn extraction wasted an LLM call on every "what does this
    paragraph mean" turn. Most turns produced nothing.
  * The model sees the full session arc instead of one fragment, so
    extraction quality is higher and dup rates lower.
  * The confidence gate stops "I want to plot this" transient state
    from polluting the table.
"""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ..agent.providers import make_chat_model
from ..db import get_conn
from .embedding import embed_memory_text
from .store import Kind, Scope, save_memory

log = logging.getLogger(__name__)


_EXTRACTOR_SYSTEM = """\
You are a memory extractor. You read a chat session transcript between a
researcher (USER) and an assistant. You extract DURABLE facts about the
user — preferences, working hypotheses, project facts, references they
asked you to remember — that should persist into FUTURE conversations.

Hard rules:
- Only extract things the USER asserted or explicitly asked you to
  remember. Do NOT extract anything from the assistant's reply unless
  the user clearly affirmed it.
- Skip transient task state ("plot this", "summarize section 2"),
  conversational filler, and anything re-derivable from the project's
  materials.
- Each fact must stand on its own — write as a full sentence, no
  pronouns that need session context to interpret.
- Tag each fact with a confidence:
    high   — durable across conversations (e.g. "I prefer Vancouver
             citations", "this project investigates HNSW recall").
             ONLY 'high' rows are persisted.
    medium — possibly durable but possibly task-specific.
    low    — transient. Mark these so you don't promote noise.
- Prefer extracting ZERO facts to padding. Most chats yield zero.
- A typical session yields 0-2 facts; an unusual one yields 4-5; never
  return more than 8.
- Map kind to one of:
    preference     — researcher prefs (style, tone, citation format)
    project_fact   — concrete facts about the project / its corpus
    open_question  — unresolved threads the user is working through
    reference      — pointers ("see Smith 2024 for the baseline")
"""


class _ExtractedFact(BaseModel):
    kind: Literal["preference", "project_fact", "open_question", "reference"]
    confidence: Literal["high", "medium", "low"]
    title: str = Field(description="A 3-8 word descriptive title.")
    body: str = Field(description="One full sentence stating the fact.")


class _ExtractedFacts(BaseModel):
    facts: list[_ExtractedFact] = Field(default_factory=list)


async def _load_session_transcript(
    session_id: UUID, since: object | None = None
) -> list[tuple[str, str]]:
    """Return [(role, content), …] in turn order from the checkpointer's
    messages, restricted to messages newer than ``since`` if provided.

    The chat history lives in the LangGraph Postgres checkpointer — see
    /threads/{thread_id}/messages in main.py for the read pattern. We
    reach into ``checkpoint_blobs`` here because the checkpointer is the
    one source of truth for the message list."""
    # Pull the latest checkpoint for the thread and walk back its
    # message list. The checkpointer stores messages under the same
    # ``messages`` channel the graph uses; the most recent checkpoint
    # has the full accumulated list.
    async with get_conn() as conn:
        cur = await conn.execute(
            """
            SELECT channel_values FROM checkpoints
            WHERE thread_id = %s
            ORDER BY checkpoint_id DESC
            LIMIT 1
            """,
            (str(session_id),),
        )
        row = await cur.fetchone()
    if not row:
        return []

    # channel_values is a JSON blob the checkpointer maintains. Different
    # checkpointer versions structure it differently — we go through the
    # same /threads endpoint code path elsewhere; here we keep it simple
    # and pull from message_citations + sessions's stored text by joining
    # to chat_calls — but the cleanest source is the checkpointer.
    # For now, just return what we have via the /threads helper.
    return await _load_via_thread_messages(session_id, since)


async def _load_via_thread_messages(
    session_id: UUID, since: object | None
) -> list[tuple[str, str]]:
    """Read messages via the existing /threads endpoint helper logic.

    Implementation deliberately delegates to the agent graph's
    checkpointer rather than parsing channel_values directly, so we
    track whatever serializer the checkpointer ships with."""
    from ..main import app  # late import — app holds the graph singleton
    graph = getattr(app.state, "graph", None)
    if graph is None:
        return []
    config = {"configurable": {"thread_id": str(session_id)}}
    try:
        snapshot = await graph.aget_state(config)
    except Exception:
        log.warning("extractor: aget_state failed", exc_info=True)
        return []
    messages = (snapshot.values or {}).get("messages") or []
    out: list[tuple[str, str]] = []
    for m in messages:
        role = getattr(m, "type", None) or "unknown"
        content = getattr(m, "content", "")
        if isinstance(content, list):
            # Anthropic-style content blocks — concatenate text blocks.
            parts: list[str] = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(str(c.get("text") or ""))
            content = "".join(parts)
        if not isinstance(content, str):
            content = str(content)
        if role in ("human", "ai") and content.strip():
            out.append(("USER" if role == "human" else "ASSISTANT", content))
    return out


def _render_transcript(turns: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"{role}: {text.strip()}" for role, text in turns)


async def extract_from_session(
    *,
    session_id: UUID,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    model: str | None = None,
) -> int:
    """Run one extraction LLM call over the whole session transcript.

    Returns the number of rows written (only ``confidence='high'``
    facts). Never raises — callers (the sweeper) treat failures as
    transient and retry on the next pass."""
    turns = await _load_via_thread_messages(session_id, None)
    if len(turns) < 2:
        # Need at least one full user/assistant exchange to extract from.
        return 0

    try:
        llm = make_chat_model(model, structured=_ExtractedFacts)
    except Exception:
        log.warning("extractor: cannot build model — skipping", exc_info=True)
        return 0

    transcript = _render_transcript(turns)
    if len(transcript) > 60_000:
        # Defensive cap — most sessions are well under this; very long
        # sessions get truncated to the last ~60k chars so we don't
        # blow up token budgets.
        transcript = transcript[-60_000:]

    try:
        result: _ExtractedFacts = await llm.ainvoke(
            [
                ("system", _EXTRACTOR_SYSTEM),
                ("user",
                 "Session transcript follows. Extract durable facts about "
                 "the USER, with confidence labels.\n\n" + transcript),
            ]
        )
    except Exception:
        log.warning("extractor: LLM call failed", exc_info=True)
        return 0

    if not result.facts:
        log.info("memory extraction: 0 facts (session=%s)", session_id)
        return 0

    written = 0
    skipped_low_conf = 0
    for fact in result.facts:
        if fact.confidence != "high":
            skipped_low_conf += 1
            continue
        try:
            embedding = await embed_memory_text(fact.title, fact.body)
            await save_memory(
                member_id=member_id,
                scope=scope,
                project_id=project_id,
                kind=fact.kind,  # type: ignore[arg-type]
                title=fact.title.strip()[:200] or "memory",
                body=fact.body.strip(),
                embedding=embedding,
                source_session=session_id,
                confidence="high",
            )
            written += 1
        except Exception:
            log.warning("extractor: save_memory failed for one fact",
                        exc_info=True)

    log.info(
        "memory extraction: wrote %d high-confidence facts "
        "(skipped %d low/medium) for session=%s",
        written, skipped_low_conf, session_id,
    )
    return written


# ---------------------------------------------------------------------
# Hot-path tool — "remember X" the user types in chat.
# ---------------------------------------------------------------------

_TOOL_KINDS: tuple[Kind, ...] = (
    "preference",
    "project_fact",
    "open_question",
    "reference",
)


def _make_memory_save_tool() -> StructuredTool:
    from ..agent.graph import get_request_ctx  # late import, breaks cycle

    class _SaveArgs(BaseModel):
        kind: Literal[
            "preference", "project_fact", "open_question", "reference"
        ]
        title: str = Field(description="A 3-8 word descriptive title.")
        body: str = Field(description="One full sentence stating the fact.")
        scope: Literal["auto", "general", "project"] = Field(
            default="auto",
            description=(
                "Where to save the memory. Use 'general' for user-level "
                "preferences, 'project' for active-project facts, or 'auto'."
            ),
        )

    async def _save(kind: str, title: str, body: str, scope: str = "auto") -> str:
        if kind not in _TOOL_KINDS:
            return f"error: invalid kind {kind!r}"
        if scope not in ("auto", "general", "project"):
            return f"error: invalid scope {scope!r}"
        ctx = get_request_ctx()
        if ctx.member_id is None:
            return "error: no member context — cannot save memory"
        try:
            member_id = (
                ctx.member_id if isinstance(ctx.member_id, UUID)
                else UUID(str(ctx.member_id))
            )
        except Exception:
            return "error: invalid member id"
        # Scope inference: when the active session is tied to a project,
        # save into that project's scope; otherwise into general.
        session_id = ctx.session_id
        active_project_id: UUID | None = None
        if session_id:
            try:
                async with get_conn() as conn:
                    row = await (
                        await conn.execute(
                            "SELECT project_id FROM sessions WHERE id=%s",
                            (session_id,),
                        )
                    ).fetchone()
                if row and row[0]:
                    active_project_id = row[0]
            except Exception:
                log.warning("memory_save: scope lookup failed", exc_info=True)

        resolved_scope: Scope
        project_id: UUID | None
        if scope == "general":
            resolved_scope = "general"
            project_id = None
        elif scope == "project":
            if active_project_id is None:
                return "error: no active project — cannot save project memory"
            resolved_scope = "project"
            project_id = active_project_id
        elif kind == "preference":
            # Researcher preferences should follow the user across
            # projects even when they are stated inside a project chat.
            resolved_scope = "general"
            project_id = None
        elif active_project_id is not None:
            resolved_scope = "project"
            project_id = active_project_id
        else:
            resolved_scope = "general"
            project_id = None

        embedding = await embed_memory_text(title, body)
        try:
            row = await save_memory(
                member_id=member_id,
                scope=resolved_scope,
                project_id=project_id,
                kind=kind,  # type: ignore[arg-type]
                title=title.strip()[:200] or "memory",
                body=body.strip(),
                embedding=embedding,
                source_session=(
                    UUID(str(session_id)) if session_id else None
                ),
                # Explicit user intent → highest confidence by definition.
                confidence="high",
            )
        except Exception as e:
            return f"error: {e}"
        return f"saved memory {row.id} as {row.kind}"

    return StructuredTool.from_function(
        coroutine=_save,
        name="memory_save",
        description=(
            "Save one durable fact to long-term memory so future "
            "conversations remember it. Use ONLY when the user explicitly "
            "asks you to remember something. By default, preferences are "
            "saved globally and project facts/questions/references are saved "
            "to the active project when one exists."
        ),
        args_schema=_SaveArgs,
    )


def memory_tools() -> list[StructuredTool]:
    """Return the memory toolset to merge into RequestCtx.tools."""
    return [_make_memory_save_tool()]
