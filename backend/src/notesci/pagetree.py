"""Tree-index (PageIndex) integration.

notesci's primary retrieval is vector kNN over pgvector. This module
provides an *alternative* retrieval path — a hierarchical, table-of-
contents tree built by VectifyAI's PageIndex (vendored under
``backend/vendor/PageIndex/``). The trade-off lives in CLAUDE.md /
README: vector RAG is cheap and language-agnostic but suffers from the
classic similarity≠relevance gap; tree-search is more expensive per
query but better at multi-step reasoning over long structured docs.

What this module owns end-to-end:

  1. **Vendor wiring** — adds ``vendor/PageIndex`` to ``sys.path`` and
     configures the vendored ``pageindex.utils.llm_completion`` /
     ``llm_acompletion`` to route through ``make_chat_model()`` (the
     single chokepoint per project rules — PageIndex must not reach for
     OpenAI / Anthropic SDKs directly).
  2. **Build** — ``build_tree(pdf_bytes, *, model)`` runs the synchronous
     PageIndex pipeline on a worker thread and returns the structured
     tree (a ``dict`` with ``doc_name``, ``doc_description``, ``structure``).
  3. **Tree-walk retrieval** — ``select_relevant_nodes(tree, query, *, model)``
     asks the LLM which node ids in the tree are most relevant for a
     question, then ``gather_text_for_nodes(tree, node_ids)`` concatenates
     their stored text snippets so the chat node can ground its answer
     without paying for the embedding round-trip.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
from io import BytesIO
from pathlib import Path
from typing import Any

from .agent.providers import make_chat_model, resolve_default_model
from .config import settings

log = logging.getLogger(__name__)


# --- Vendor wiring -----------------------------------------------------------
#
# PageIndex lives at ``backend/vendor/PageIndex``. Adding it to sys.path
# here is the single seam — every other notesci import is unchanged.

_VENDOR_ROOT = Path(__file__).resolve().parent.parent.parent / "vendor" / "PageIndex"
if str(_VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(_VENDOR_ROOT))

# Lazy import so accidentally importing this module doesn't drag the
# vendor in until the feature is actually used.
class _NullJsonLogger:
    """No-op replacement for the vendor's ``JsonLogger``.

    Upstream's logger writes ``./logs/<pdfname>_<timestamp>.json`` to the
    CWD on every build — that's PDF body text + full prompt traces
    landing on the container filesystem (PII spillage + disk-fill risk
    + a filename derived from PDF /Title that's only sanitized for '/').
    We discard the trace; the structured outcome already lives in
    ``material_trees`` and Postgres telemetry.
    """

    def __init__(self, *_args, **_kwargs):
        pass

    def info(self, *_args, **_kwargs):
        pass

    def error(self, *_args, **_kwargs):
        pass

    def debug(self, *_args, **_kwargs):
        pass

    def exception(self, *_args, **_kwargs):
        pass

    def log(self, *_args, **_kwargs):
        pass


def _ensure_configured() -> None:
    """Import-and-configure the vendor on first use.

    Safe to call repeatedly — the second call is a no-op.
    """
    if getattr(_ensure_configured, "_done", False):
        return
    from pageindex.utils import configure_backend  # type: ignore
    # Replace the noisy ./logs JSON-trace writer with a no-op so
    # PageIndex builds don't leak document text onto the container FS.
    import pageindex.page_index as _pi  # type: ignore
    import pageindex.utils as _piu  # type: ignore
    _pi.JsonLogger = _NullJsonLogger  # type: ignore[attr-defined]
    _piu.JsonLogger = _NullJsonLogger  # type: ignore[attr-defined]

    def _sync_call(model: str | None, prompt: str) -> str:
        llm = make_chat_model(model)
        msg = llm.invoke(prompt)
        content = getattr(msg, "content", "") or ""
        if isinstance(content, list):
            # Anthropic returns a list of content blocks.
            content = "".join(
                seg.get("text", "") if isinstance(seg, dict) else str(seg)
                for seg in content
            )
        return content

    async def _async_call(model: str | None, prompt: str) -> str:
        llm = make_chat_model(model)
        msg = await llm.ainvoke(prompt)
        content = getattr(msg, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                seg.get("text", "") if isinstance(seg, dict) else str(seg)
                for seg in content
            )
        return content

    configure_backend(sync_call=_sync_call, async_call=_async_call)
    _ensure_configured._done = True  # type: ignore[attr-defined]


# --- Tree build -------------------------------------------------------------


def is_enabled() -> bool:
    """True when the tree-index feature is gated on.

    Off by default — building a tree is LLM-expensive (often dozens of
    calls per PDF). Operators flip ``NOTESCI_PAGETREE_ENABLED=true`` once
    the cost story is acceptable for their deployment.
    """
    return settings.notesci_pagetree_enabled


async def build_tree(
    pdf_bytes: bytes,
    *,
    model: str | None = None,
    max_pages: int = 200,
) -> dict[str, Any] | None:
    """Build a hierarchical tree index for the given PDF.

    Returns a dict ``{"doc_name", "doc_description", "structure"}`` on
    success, or ``None`` if the build failed (logged but not raised — a
    missing tree degrades gracefully to vector retrieval). The
    ``structure`` is the list-of-nodes shape PageIndex emits, with each
    node carrying ``title``, ``node_id``, ``start_index``, ``end_index``,
    ``summary``, and ``text`` for leaves.

    Runs the synchronous PageIndex pipeline in a worker thread so the
    asyncio loop isn't blocked. ``max_pages`` is a guardrail — PDFs
    larger than this skip the tree build because the LLM cost grows
    super-linearly.
    """
    _ensure_configured()
    if not pdf_bytes:
        return None

    # Quick page-count check — avoid spinning up the builder on giant docs.
    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(BytesIO(pdf_bytes))
        n_pages = len(reader.pages)
    except Exception:  # corrupt PDF or unsupported
        log.warning("pagetree: PDF could not be parsed for page count")
        return None
    if n_pages > max_pages:
        log.info(
            "pagetree: skipping tree build — %s pages exceeds max_pages=%s",
            n_pages,
            max_pages,
        )
        return None

    chosen_model = model or resolve_default_model()

    def _run() -> dict[str, Any] | None:
        # Imports are inside the worker so the vendor import cost only
        # hits the first build, not module import.
        from pageindex import page_index  # type: ignore

        try:
            result = page_index(
                doc=BytesIO(pdf_bytes),
                model=chosen_model,
                if_add_node_id="yes",
                if_add_node_summary="yes",
                if_add_node_text="yes",
                if_add_doc_description="yes",
            )
            return result
        except Exception:
            log.exception("pagetree: page_index build failed")
            return None

    return await asyncio.to_thread(_run)


# --- Tree-walk retrieval ----------------------------------------------------


def _flatten_nodes(tree: Any, into: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Return a flat list of ``{node_id, title, summary}`` dicts from the
    PageIndex tree shape. Skips the per-node ``text`` field — that's only
    needed when we actually grab a node's content for the LLM."""
    if into is None:
        into = []
    if isinstance(tree, dict):
        if tree.get("node_id"):
            into.append({
                "node_id": tree.get("node_id"),
                "title": tree.get("title") or "",
                "summary": tree.get("summary") or "",
            })
        if tree.get("nodes"):
            _flatten_nodes(tree["nodes"], into)
    elif isinstance(tree, list):
        for item in tree:
            _flatten_nodes(item, into)
    return into


def _find_node(tree: Any, node_id: str) -> dict[str, Any] | None:
    if isinstance(tree, dict):
        if tree.get("node_id") == node_id:
            return tree
        if tree.get("nodes"):
            found = _find_node(tree["nodes"], node_id)
            if found:
                return found
    elif isinstance(tree, list):
        for item in tree:
            found = _find_node(item, node_id)
            if found:
                return found
    return None


_NODE_ID_RE = re.compile(r"\b\d{4}\b")


async def select_relevant_nodes(
    tree: list[dict[str, Any]] | dict[str, Any],
    query: str,
    *,
    model: str | None = None,
    top_k: int = 4,
    doc_description: str | None = None,
) -> list[str]:
    """Ask the LLM which tree nodes are most relevant to ``query``.

    Returns a list of node_ids (the 4-digit strings PageIndex assigns
    via ``write_node_id``). Best-effort: parse errors collapse to an
    empty list, which the caller treats as "fall through to vector".
    """
    nodes = _flatten_nodes(tree)
    if not nodes:
        return []

    outline_lines = [
        f"  [{n['node_id']}] {n['title']}"
        + (f" — {n['summary'][:160]}" if n.get("summary") else "")
        for n in nodes
    ]
    outline = "\n".join(outline_lines[:200])  # cap to keep prompt under control
    desc = f"\nDocument description: {doc_description}\n" if doc_description else ""
    prompt = (
        "You are picking the most relevant sections of a long document to "
        "answer a question. The document is represented by a table-of-contents "
        "tree; each row is one section.\n"
        f"{desc}"
        "\nTree (id · title · summary):\n"
        f"{outline}\n\n"
        f"Question: {query}\n\n"
        f"Return the node ids of the top {top_k} sections most likely to answer "
        "the question. Reply with a JSON array of strings, e.g. "
        '["0003", "0017"]. Return ONLY the JSON array — no prose.'
    )
    try:
        llm = make_chat_model(model)
        msg = await llm.ainvoke(prompt)
    except Exception:
        log.exception("pagetree: select_relevant_nodes LLM call failed")
        return []

    text = getattr(msg, "content", "") or ""
    if isinstance(text, list):
        text = "".join(
            seg.get("text", "") if isinstance(seg, dict) else str(seg)
            for seg in text
        )
    text = text.strip()
    # Strip ```json fences if present.
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    # Try a strict parse first; fall back to regex extraction.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            ids = [str(x).zfill(4) for x in parsed if x is not None]
        else:
            ids = []
    except Exception:
        ids = _NODE_ID_RE.findall(text)

    valid = {n["node_id"] for n in nodes}
    # Dedupe while preserving order — the LLM occasionally repeats the
    # same id when it's the only relevant section, which would otherwise
    # double-count text in `gather_text_for_nodes`.
    seen: set[str] = set()
    deduped: list[str] = []
    for nid in ids:
        if nid in valid and nid not in seen:
            seen.add(nid)
            deduped.append(nid)
        if len(deduped) >= top_k:
            break
    return deduped


def gather_text_for_nodes(
    tree: list[dict[str, Any]] | dict[str, Any],
    node_ids: list[str],
    *,
    max_chars: int = 8000,
) -> str:
    """Concatenate the ``text`` fields of the requested tree nodes.

    Hard-caps the total length so a runaway selection can't blow the
    chat-model context window. Returns an empty string when no nodes
    matched (caller decides how to fall back).

    The cap is enforced as a final clip on the joined string — that
    way the per-node ``[id] title`` header and the ``---`` separator
    overhead can't slip the result over the budget.
    """
    # Dedup ids while preserving order — the LLM occasionally returns
    # the same node twice when it's the only relevant section, and
    # concatenating it twice would inflate the prompt.
    seen: set[str] = set()
    unique_ids: list[str] = []
    for nid in node_ids:
        if nid not in seen:
            seen.add(nid)
            unique_ids.append(nid)

    out: list[str] = []
    for nid in unique_ids:
        node = _find_node(tree, nid)
        if not node:
            continue
        chunk = (node.get("text") or "").strip()
        if not chunk:
            continue
        out.append(f"[{nid}] {node.get('title') or ''}\n{chunk}")
    joined = "\n\n---\n\n".join(out)
    if len(joined) > max_chars:
        joined = joined[:max_chars] + "…"
    return joined
