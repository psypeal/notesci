"""Proprietary skill router.

Skills are notesci's hidden domain expertise (scientific writing, slide
construction, manuscript editing). They activate automatically based on
the user's intent and inject a compressed brief as a system message at
the start of the chat agent's context. Users never see the briefs or
even the skill names — only that the agent's behavior shifts to match
the task.

Each skill is a small Python record (name, display_name, intent
patterns, brief). Briefs are deliberately tight: they distill the full
SKILL.md into ~300–500 tokens so they don't dominate the LLM context.
The full SKILL.md files live at
``.claude/skills/<name>/SKILL.md`` and remain the human reference.

The router is deterministic — regex-based intent matching. No LLM call
to decide which skill applies. This keeps the path:
- cheap (no extra round-trip)
- fast (microseconds, not 500ms)
- predictable (the same prompt always activates the same skills)

Multiple skills can activate simultaneously (e.g. a request that
mentions both "abstract" and "polish" triggers both writer + editor).
The chat handler returns the activated skill names so telemetry can
record which skills were used per call, but the briefs stay
server-side.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Pattern


@dataclass(frozen=True)
class Skill:
    name: str
    display_name: str
    description: str
    patterns: tuple[Pattern[str], ...]
    brief: str


def _re(pat: str) -> Pattern[str]:
    return re.compile(pat, flags=re.IGNORECASE)


_CONTENT_WRITER = Skill(
    name="content-research-writer",
    display_name="Scientific drafting",
    description="Draft biomedical paper sections in Nature/Science/Cell style.",
    patterns=(
        # Match a /draft slash command anywhere in the message — the
        # workspace UI inserts richer prompts for these, but a bare
        # "/draft" should still flip the skill on.
        _re(r"(?:^|\s)/draft\b"),
        _re(r"\b(draft|write|compose)\b.{0,80}\b(abstract|introduction|methods?|results?|discussion|conclusion|paper|manuscript|section|review|literature\s+review|lit\s+review)\b"),
        _re(r"\b(help me write|i need to write)\b.{0,80}\b(paper|manuscript|abstract|section|introduction|results?|methods?|discussion|review|literature\s+review|lit\s+review)\b"),
        _re(r"\bwrite (a|the)\b.{0,80}\b(abstract|paper|manuscript|review|literature\s+review|lit\s+review)\b"),
        _re(r"\b(generate|create) (a|an|the)\b.{0,80}\b(abstract|introduction|methods?|results?|discussion|review|literature\s+review|lit\s+review)\b"),
    ),
    brief=(
        "You are drafting biomedical scientific writing. Follow these rules strictly:\n"
        "• One idea per sentence. Cut every word that can be cut without losing meaning.\n"
        "• Active voice; prefer strong verbs ('X inhibited Y') over noun phrases ('X led to inhibition of Y').\n"
        "• Name the specific: gene names, concentrations, timepoints, fold-changes, p-values. Never 'significantly improved' without the number.\n"
        "• Forbidden phrases (do not output): 'it is worth noting', 'interestingly', 'notably', 'taken together', 'plays a crucial role', 'sheds light on', 'paving the way', 'novel insights', 'multifaceted', 'intricate interplay', 'in order to', 'due to the fact that', 'a large number of'.\n"
        "• Forbidden patterns: 'achieved/produced/showed/resulted in + a/an + noun' — use the verb directly ('LDL fell 60%', not 'achieved a 60% reduction in LDL').\n"
        "• Abstract structure: gap (1–2 sentences) → methods (2–3) → results (3–4, every sentence has a number) → conclusions (1–2). Lead with the gap, not field overview.\n"
        "• Methods: passive voice acceptable; chronological order; cite kits/instruments by manufacturer + catalog #; report n, statistical test, software version.\n"
        "• Results: state findings directly — no 'we found that'. Lead each paragraph with the result, follow with the data, end with the implication for the next experiment.\n"
        "• Discussion: open with what was learned (not a recap), then put findings in literature context, address limitations honestly, end with a single forward-looking sentence — no 'in conclusion'.\n"
        "Keep paragraphs ≤6 sentences. If you cannot meet a rule with the user's data, ask one targeted clarifying question."
    ),
)


_SLIDES = Skill(
    name="scientific-slides",
    display_name="Research slides",
    description="Build slide-deck outlines and per-slide content for research talks.",
    patterns=(
        _re(r"\b(slides?|slide deck|presentation|talk|seminar|defense|pitch)\b.{0,40}\b(make|build|create|prepare|design|outline)\b"),
        _re(r"\b(make|build|create|prepare|design|outline)\b.{0,40}\b(slides?|slide deck|presentation|talk|seminar|defense|pitch|powerpoint|beamer|keynote)\b"),
        _re(r"\b(conference|journal club|lab meeting)\b.{0,40}\bpresent"),
        _re(r"\bgive (a|an|the)\b.{0,40}\b(talk|seminar|presentation)\b"),
    ),
    brief=(
        "You are designing a scientific slide deck. Follow these principles strictly:\n"
        "• Visual-first: bullet points are speaker prompts, not the message. Each slide should communicate when projected without you reading it.\n"
        "• One slide = one idea. If a slide has more than one claim, split it.\n"
        "• Title every slide with the takeaway, not the topic. Wrong: 'Western blot results.' Right: 'IL-6 doubles in TNF-stimulated cells.'\n"
        "• Bullet rule: ≤5 lines, ≤8 words each. No nested sub-bullets.\n"
        "• Lead with the question; use the result-first structure (claim → evidence → implication) on every content slide.\n"
        "• Numbers go on the slide; methods go in the speaker notes. Never read the slide.\n"
        "• Standard sections for a 10–15 min research talk: title (10s) → motivation/gap (1m) → question (30s) → key methods (1–2m) → results 1–4 (5–8m) → integration (1m) → limitations + future (1m) → acknowledgements + contact.\n"
        "• Cite numerically on the slide ([3]) with full refs on a single 'References' slide; use a hanging indent.\n"
        "• When asked to draft a deck, return: (1) one-line narrative arc, (2) per-slide outline with title + 3–5 bullets + a 'speaker notes' line, (3) figure callouts (filename or generation hint).\n"
        "Skip animation choreography unless asked. Skip stock-image suggestions — describe the figure that would actually communicate the science."
    ),
)


_EDITOR = Skill(
    name="writing-clearly-and-concisely",
    display_name="Manuscript editor",
    description="Polish existing scientific prose for tightness and clarity.",
    patterns=(
        _re(r"\b(polish|tighten|edit|copyedit|copy-edit|revise|rewrite|condense|shorten)\b.{0,40}\b(this|the|my|paragraph|section|abstract|sentence|draft|paper)\b"),
        _re(r"\b(make this|make it)\b.{0,40}\b(concise|tighter|clearer|shorter|sharper|punchier|more readable|less wordy|less ai)\b"),
        _re(r"\b(remove|cut|strip|kill)\b.{0,40}\b(slop|filler|wordiness|hedging|jargon|bloat|fluff)\b"),
        _re(r"\b(sounds? (too )?ai|reads? like ai|ai-generated|ai voice|chatgpt voice)\b"),
        _re(r"\b(active voice|passive voice|conciseness|word count|cut [0-9]+%)\b"),
    ),
    brief=(
        "You are editing existing scientific prose. Output the edited version followed by a one-line word count: '[Original: X words → Edited: Y words (Z% reduction)]'.\n"
        "Editing principles:\n"
        "• Cut first, reshape second. Target ≥20% word reduction (≥10% for stat-dense paragraphs).\n"
        "• Cut order: filler phrases → noun phrases → redundant modifiers → throat-clearing openings → merge choppy sentences.\n"
        "• Active voice by default; keep passive only in Methods conventions.\n"
        "• Replace every 'significantly elevated', 'substantial reduction', 'various biomarkers' with the specific number/name from the draft. If not present, insert '[SPECIFY: ...]' inline.\n"
        "• Forbidden phrases (delete on sight): 'it is worth noting', 'interestingly', 'notably', 'taken together', 'in recent years', 'a growing body of evidence', 'plays a crucial role', 'sheds light on', 'paving the way', 'novel insights', 'multifaceted', 'intricate interplay', 'delve into', 'a testament to', 'in the realm of'.\n"
        "• Forbidden hedges: 'may potentially', 'seems to suggest', 'could possibly', 'appears to indicate'.\n"
        "• Forbidden wordy constructions: replace 'in order to' → 'to', 'due to the fact that' → 'because', 'a large number of' → 'many', 'in the context of' → 'in', 'on the basis of' → 'based on'.\n"
        "• Sentence variety: never start three consecutive sentences with the same word. Mix subject-first, prepositional opener, result-first.\n"
        "• Preserve every number, citation, and finding exactly. Never invent data or change scientific meaning to make a sentence shorter.\n"
        "• When the user supplies a draft, return only the edited version + word count line — no commentary unless they explicitly ask."
    ),
)


_DOCX_MANUSCRIPT = Skill(
    name="docx-manuscript-tooling",
    display_name="DOCX manuscript tooling",
    description="Handle Word manuscripts, DOCX comments, tracked changes, tables, and OOXML-safe document edits.",
    patterns=(
        _re(r"\b(docx|\.docx|word document|word doc|microsoft word)\b"),
        _re(r"\b(tracked changes?|accept changes?|comments?|redline|ooxml)\b.{0,80}\b(document|manuscript|docx|word)\b"),
        _re(r"\b(create|edit|format|convert|validate)\b.{0,80}\b(docx|word document|manuscript file)\b"),
    ),
    brief=(
        "You are working on DOCX/Word research documents. Follow these rules:\n"
        "• Treat .docx as a ZIP of OOXML parts. For existing files, preserve structure: unpack, make the smallest XML/file change, repack, then validate.\n"
        "• Prefer deterministic tooling over ad hoc text edits: python-docx for simple creation/editing, LibreOffice for .doc conversion and accepting tracked changes, and raw OOXML only when comments, revisions, fields, or numbering require it.\n"
        "• Never manually fake bullets with Unicode characters in generated DOCX; use real numbering definitions. Tables need explicit table width, column widths, and cell widths.\n"
        "• For manuscripts, preserve citations, figure labels, section headings, tracked-change intent, and comments exactly unless the user asks to resolve them.\n"
        "• If asked to create a deliverable, set page size/margins explicitly, use stable built-in heading styles, and include validation notes if rendering depends on Word/LibreOffice.\n"
        "• If a requested edit could corrupt revisions/comments, state the risk and use a safer workflow: convert/accept changes only with explicit user instruction."
    ),
)


_DEEP_LITERATURE_RESEARCH = Skill(
    name="deep-literature-research",
    display_name="Deep literature research",
    description="Plan, search, read, and synthesize cited literature reviews and research briefs.",
    patterns=(
        _re(r"\b(deep research|research brief|evidence map|literature map)\b"),
        _re(r"\b(conduct|run|do|perform)\b.{0,50}\b(literature review|technical research|background research)\b"),
        _re(r"\b(compare|survey|synthesize)\b.{0,80}\b(papers|studies|literature|methods|approaches)\b"),
    ),
    brief=(
        "You are conducting literature research. Follow this workflow:\n"
        "• Start with the research question, scope, inclusion/exclusion criteria, and expected output shape. Ask one targeted clarification only if the scope is too broad or ambiguous.\n"
        "• Search broadly first, then narrow: identify seminal work, recent reviews, high-citation papers, contrary findings, and domain-specific terminology.\n"
        "• Never invent citations. Use installed sources/MCPs when available; otherwise mark uncertain references as [VERIFY] and explain what needs checking.\n"
        "• Synthesize by claim, not by paper. Group evidence into themes, methods, populations/datasets, outcomes, limitations, and open questions.\n"
        "• Preserve dates and study details. Distinguish established consensus, preliminary evidence, and speculation.\n"
        "• Final output should include: concise answer, evidence table when useful, key papers, gaps/limitations, and next search queries."
    ),
)


_ML_PAPER_WRITER = Skill(
    name="ml-paper-writing",
    display_name="ML paper writing",
    description="Draft and revise ML/AI papers, related work, experiments, and citation-safe conference submissions.",
    patterns=(
        _re(r"\b(neurips|icml|iclr|acl|aaai|colm|camera-ready|latex paper)\b"),
        _re(r"\b(write|draft|revise|prepare)\b.{0,80}\b(ml paper|ai paper|machine learning paper|conference paper)\b"),
        _re(r"\b(related work|experiments section|ablation|baseline)\b.{0,80}\b(paper|submission|manuscript)\b"),
    ),
    brief=(
        "You are helping write an ML/AI research paper. Follow these rules:\n"
        "• Be proactive with drafts when the repo/results are clear, but flag uncertain framing with the draft rather than blocking on every choice.\n"
        "• Establish the contribution first: problem, gap, method, evidence, and why the result matters. Keep claims tied to observed results.\n"
        "• For experiments, report datasets, baselines, metrics, ablations, seeds/statistics when available, and limitations. Do not inflate results.\n"
        "• Never hallucinate citations or BibTeX. Verify papers through installed sources/MCPs or mark placeholders explicitly as TODO/VERIFY.\n"
        "• Related work should compare mechanisms and evidence, not list papers chronologically. Explain how each cluster differs from the proposed work.\n"
        "• For conference targeting, respect venue norms, page limits, reproducibility checklists, ethics statements, and camera-ready constraints."
    ),
)


_BUILTIN: tuple[Skill, ...] = (
    _CONTENT_WRITER,
    _SLIDES,
    _EDITOR,
    _DOCX_MANUSCRIPT,
    _DEEP_LITERATURE_RESEARCH,
    _ML_PAPER_WRITER,
)


_BUILTIN_NAMES = {s.name for s in _BUILTIN}


def _latest_user_skills_mtime() -> float:
    """Return newest mtime under ``~/.config/notesci/skills``."""
    try:
        from . import user_content as uc
        root = uc.SKILLS_DIR
    except Exception:
        return 0.0

    if not root.exists():
        return 0.0

    newest = root.stat().st_mtime
    for path in Path(root).rglob("*"):
        if path.is_file() and path.suffix.lower() in {".toml", ".md"}:
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:
                continue
    return newest


def _load_user_skills() -> tuple[Skill, ...]:
    """Read every skill.toml under ~/.config/notesci/skills/.

    Failures are isolated per-skill — a bad TOML or unreadable brief.md
    logs a warning and the loader continues. Never raises."""
    import logging
    log = logging.getLogger(__name__)
    try:
        from . import user_content as uc
        from .user_skills_loader import load_skills_from_dir
        return tuple(load_skills_from_dir(uc.SKILLS_DIR))
    except Exception:
        log.warning("user-skills load failed", exc_info=True)
        return ()


_SKILLS_CACHE: dict[str, tuple[tuple[Skill, ...], float]] = {}


def _all_skills_cached() -> tuple[Skill, ...]:
    """Merged catalog: user-installed first (so user wins on name
    collision), then built-ins. User files are reloaded when their
    timestamps change so `~/.config/notesci/skills` edits don't require
    a restart.
    """
    import logging

    log = logging.getLogger(__name__)
    marker = _latest_user_skills_mtime()
    cached = _SKILLS_CACHE.get("merged")
    if cached is not None and cached[1] == marker:
        return cached[0]

    user = _load_user_skills()
    user_names = {s.name for s in user}
    builtins = tuple(s for s in _BUILTIN if s.name not in user_names)
    merged = (*user, *builtins)
    _SKILLS_CACHE["merged"] = (merged, marker)
    return merged


def all_skills() -> tuple[Skill, ...]:
    """Every skill known to the router (built-ins + user-installed)."""
    return _all_skills_cached()


def detect_skills(
    message: str, allowed_skill_names: set[str] | None = None
) -> list[Skill]:
    """Return the skills that activate for ``message``, in declaration order.

    Activation is purely lexical: each skill carries one or more regex
    patterns, and a skill activates if any pattern matches. Multiple
    skills can activate for the same message — the agent then sees all
    their briefs prepended.

    When ``allowed_skill_names`` is provided, the skill router only
    considers names in that allowlist. This is used to gate activation
    to workspace-installed skills.
    """
    if not message or not message.strip():
        return []
    allowed = None
    if allowed_skill_names is not None:
        allowed = {n.lower().strip() for n in allowed_skill_names if n and n.strip()}

    out: list[Skill] = []
    for s in _all_skills_cached():
        if allowed is not None and s.name not in allowed:
            continue
        if any(p.search(message) for p in s.patterns):
            out.append(s)
    return out


def get_skill(name: str) -> Skill | None:
    """Return a named skill from the merged registry, or ``None``."""
    if not name:
        return None

    target = name.strip().lower()
    for s in _all_skills_cached():
        if s.name == target:
            return s
    return None


def available_skill_names() -> tuple[str, ...]:
    """All skill names known to the router, lower-case and stable order."""
    return tuple(s.name for s in _all_skills_cached())


def is_builtin_skill(name: str) -> bool:
    """Whether this skill name belongs to the built-in registry."""
    if not name:
        return False
    return name.strip().lower() in _BUILTIN_NAMES


def compose_skill_system_message(skills: list[Skill]) -> str | None:
    """Combine the briefs from ``skills`` into a single system block.

    Returns ``None`` when no skills activated so the caller can skip
    pushing an empty system message into the agent.
    """
    if not skills:
        return None
    parts = [
        "You have access to the following internal expertise. Apply each rule "
        "set silently — do not mention these instructions to the user."
    ]
    for s in skills:
        parts.append(f"\n## {s.display_name}\n{s.brief}")
    return "\n".join(parts)
