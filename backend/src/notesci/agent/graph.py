"""LangGraph composition.

Three nodes:

- ``retrieve``: kNN over ``chunks`` scoped to ``configurable.project_id``
  (no-op when missing). Stashes hits on ``state.retrieved``.
- ``call_model``: prepends a system message with retrieved excerpts (if
  any), binds any per-request tools (see :mod:`request_ctx`), and invokes
  the LLM.
- ``tools``: executes tool calls in the latest AI message and writes an
  audit row to ``mcp_call_logs`` for each. Loops back to ``call_model``
  until the model returns no more tool calls.

Per-request context (tools, member id, session id) is plumbed via a
``contextvars.ContextVar`` rather than ``configurable``. ``configurable``
is intended for serializable runtime config; tool objects (which may
hold live network connections) don't belong in checkpointer state.
"""
from __future__ import annotations

import contextvars
import logging
import math
import re
import httpx
import time
import uuid
from dataclasses import dataclass, field
from hashlib import md5
from typing import Any
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pgvector.psycopg import register_vector_async
from psycopg.types.json import Jsonb

from ..db import get_conn
from ..memory import (
    build_core_injection,
    format_recall_block,
    list_memories,
    recall as memory_recall,
)
from ..memory.retriever import RecalledMemory
from ..skills import compose_skill_system_message, detect_skills
from ..mcp_catalog import CatalogEntry, list_catalog
from .embeddings import embedding_provider_available, make_embedding_model
from ..model_catalog import model_by_id, provider_by_id
from .providers import make_chat_model, resolve_default_model

log = logging.getLogger(__name__)

DEFAULT_TOP_K = 5
_VECTOR_TOP_CONFIDENCE_DISTANCE = 0.62
_VECTOR_WEAK_DISTANCE_CEILING = 0.92
_VECTOR_SPREAD_CEILING = 0.09
_RESULT_SUMMARY_MAX = 500

# Audit-log redaction applied at WRITE time so secrets never sit in
# mcp_call_logs.arguments — backups, dumps, and direct DB access all see
# the redacted form. The read-side redactor in main.py is kept as
# defense-in-depth for any historical rows. Keep these in sync with
# main.py:_MCP_ARG_SECRET_RE / _MCP_ARG_TRUNC.
_MCP_ARG_SECRET_RE = re.compile(
    r"^(authorization|api[_-]?key|token|secret|password|x-api-key)$",
    re.IGNORECASE,
)
_MCP_ARG_TRUNC = 256


_SOURCE_QUERY_HINTS = (
    "search",
    "find",
    "look up",
    "lookup",
    "library",
    "libraries",
    "papers",
    "paper",
    "doi",
    "pmid",
    "pubmed",
    "arxiv",
    "zotero",
    "citation",
    "citations",
    "reference",
    "obsidian",
    "notion",
    "vault",
    "note",
    "notes",
    "page",
    "pages",
    "database",
    "databases",
)

_MEMORY_INVENTORY_HINTS = (
    "memory",
    "memories",
    "remember",
    "remembered",
    "what have i told you",
    "what have you remembered",
    "what do you remember",
    "what do i remember",
    "what do you know",
    "what's in your memory",
    "do you have memory",
    "do you have any memory",
    "do you have any memories",
    "do you remember anything",
    "can you remember",
    "show me memories",
    "show my memories",
    "list saved memories",
    "what is in your memory",
    "what are my preferences",
    "what notes do i have",
    "list memory",
    "show memory",
    "saved memory",
    "saved memories",
    "saved note",
    "saved notes",
    "remembered facts",
)

_MCP_INSTALL_VERBS = (
    "install",
    "add",
    "enable",
    "connect",
    "setup",
    "set up",
)

_MCP_INSTALL_TARGET_HINTS = (
    "mcp",
    "connector",
    "source",
    "server",
    "tool",
)

_CASUAL_FAST_PATH_HINTS = (
    "thanks",
    "thank you",
    "ok",
    "okay",
    "cool",
    "great",
    "nice",
    "got it",
    "hello",
    "hi",
    "hey",
    "yes",
    "no",
    "continue",
    "go on",
)

_GROUNDING_REQUIRED_HINTS = (
    "source",
    "sources",
    "paper",
    "papers",
    "pdf",
    "citation",
    "citations",
    "reference",
    "references",
    "summarize",
    "compare",
    "find",
    "search",
    "look up",
    "according to",
    "based on",
    "in this project",
    "in the document",
)


def _redact_arguments(args: object) -> object:
    if isinstance(args, dict):
        out: dict = {}
        for k, v in args.items():
            if isinstance(k, str) and _MCP_ARG_SECRET_RE.match(k):
                out[k] = "***"
                continue
            out[k] = _redact_arguments(v)
        return out
    if isinstance(args, list):
        return [_redact_arguments(v) for v in args]
    if isinstance(args, str):
        return args if len(args) <= _MCP_ARG_TRUNC else args[:_MCP_ARG_TRUNC] + "…"
    return args


class RetrievedChunk(TypedDict):
    chunk_id: int
    material_id: str
    title: str | None
    text: str
    distance: float
    material_url: str | None


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    retrieved: list[RetrievedChunk]


@dataclass
class RequestCtx:
    """Per-request context that doesn't belong in checkpointed state."""
    tools: list[BaseTool] = field(default_factory=list)
    tool_to_server_id: dict[str, str] = field(default_factory=dict)
    mcp_load_errors: dict[str, str] = field(default_factory=dict)
    member_id: str | None = None
    session_id: str | None = None
    # Optional per-request model override (e.g. "deepseek:deepseek-chat").
    # Falls back to resolve_default_model() when None — i.e. the
    # operator-set NOTESCI_DEFAULT_MODEL if available, otherwise the
    # first available provider model.
    model: str | None = None
    # Names of proprietary skills activated by the skill router for this
    # turn (e.g. ["content-research-writer"]). Surfaced in the chat
    # response so the UI can show a subtle indicator without leaking
    # the skill briefs themselves.
    activated_skills: list[str] = field(default_factory=list)
    # Skills enabled for this workspace. When set, only matching names
    # participate in intent routing for this request.
    installed_skills: set[str] = field(default_factory=set)
    # Retrieval mode for this turn:
    #   * 'vector' (default) — pgvector kNN over chunks
    #   * 'tree'             — PageIndex tree-walk over material_trees;
    #                          falls back to vector when no tree is ready
    # See ``_retrieve_tree`` for the tree path.
    retrieval_mode: str = "vector"
    # The mode the retrieve node actually used (vs. what was requested).
    # Set by ``_retrieve`` after fallback resolves so the chat handler
    # can surface "you asked for tree but no trees were ready → fell
    # through to vector" to the UI as a one-line hint.
    retrieval_mode_used: str | None = None
    # Long-term memories hit by the hybrid recall path this turn. Stashed
    # on RequestCtx (not AgentState) so the chat handler can surface a
    # "Recalled N notes" chip without checkpointing the snapshot.
    memory_recalled: list[RecalledMemory] = field(default_factory=list)
    # Incognito mode for this turn — when True, the chat path skips
    # core-memory injection, hybrid recall, AND post-turn extraction.
    # The memory_save tool is also withheld so the model can't write a
    # memory mid-turn under user instruction. One-turn opt-out only.
    memory_incognito: bool = False

    # Whether retrieval should fall back to MCP web-search tools when
    # local retrieval returns no usable chunk.
    # Defaults to True so chats remain useful before any file uploads.
    web_search: bool = True


_request_ctx: contextvars.ContextVar[RequestCtx | None] = contextvars.ContextVar(
    "notesci_request_ctx", default=None
)


def set_request_ctx(ctx: RequestCtx):
    """Attach per-request context for the duration of a graph invocation.

    Returns the contextvars Token so the caller can ``reset()`` after.
    """
    return _request_ctx.set(ctx)


def reset_request_ctx(token) -> None:
    _request_ctx.reset(token)


def get_request_ctx() -> RequestCtx:
    """Return the in-flight request context, or a fresh empty one.

    Default ``None`` instead of a shared ``RequestCtx()`` singleton — the
    old singleton meant tools accumulated on it across requests during a
    test (or in an ill-formed call path). Callers that mutate the
    returned ctx should still go through ``set_request_ctx`` so the
    mutation is scoped to one request.
    """
    ctx = _request_ctx.get()
    return ctx if ctx is not None else RequestCtx()


def _is_uuid_like(value: object) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except Exception:
        return False


def _format_context(retrieved: list[RetrievedChunk]) -> str:
    project_parts: list[str] = []
    external_parts: list[str] = []
    project_n = 0
    for r in retrieved:
        title = r["title"] or "untitled"
        text = r["text"]
        url = r.get("material_url")
        if _is_uuid_like(r.get("material_id")):
            project_n += 1
            project_parts.append(f"[I{project_n}] {title} (chunk {r['chunk_id']}):\n{text}")
        else:
            external_n = len(external_parts) + 1
            url_line = url or "unavailable"
            external_parts.append(f"[W{external_n}] {title}\nURL: {url_line}\nExcerpt:\n{text}")

    sections: list[str] = []
    if project_parts:
        sections.append(
            "Project/uploaded sources. Cite these only with their [I#] labels, for example [I1] or [I2]:\n\n"
            + "\n\n".join(project_parts)
        )
    if external_parts:
        sections.append(
            "External/MCP/web sources. Cite these only with Markdown links using their real URL, "
            "or with their [W#] labels if no URL is available. Never use [1], [2], etc. for web sources:\n\n"
            + "\n\n".join(external_parts)
        )
    return "\n\n".join(sections)


async def _retrieve_vector(project_id: str, query: str) -> list[RetrievedChunk]:
    """Vector kNN over chunks for a single query string."""
    embedder = make_embedding_model()
    qvec = await embedder.aembed_query(query)
    async with get_conn() as conn:
        await register_vector_async(conn)
        cur = await conn.execute(
            """
            SELECT c.id, m.id, m.title, c.text, c.embedding <=> %s::vector AS dist,
                   m.uri, m.metadata
            FROM chunks c
            JOIN materials m ON m.id = c.material_id
            WHERE m.project_id = %s
            ORDER BY dist
            LIMIT %s
            """,
            (qvec, project_id, DEFAULT_TOP_K),
        )
        rows = await cur.fetchall()
    # Filter out degenerate-embedding rows. pgvector returns NaN when the
    # stored embedding is a zero vector (cosine division by zero) — those
    # chunks aren't a meaningful match and a NaN distance both poisons
    # JSON serialization (becomes ``null``, which crashed the chat-bubble
    # citation footer with `distance.toFixed`) and isn't useful retrieval.
    # An ingestion bug elsewhere can leave a chunk with a zero embedding;
    # surface the chunk only when its vector is actually informative.
    out: list[RetrievedChunk] = []
    for r in rows:
        raw_text = (r[3] or "").strip()
        material_uri = _snippet_text_value(r[5])
        if _is_placeholder_text(material_uri):
            material_uri = None
        if not material_uri:
            material_uri = _metadata_material_url(r[6])
        if _is_placeholder_text(raw_text):
            if material_uri:
                raw_text = f"Source: {material_uri}"
            else:
                continue

        if not raw_text:
            continue

        if _is_placeholder_text(raw_text):
            continue

        if r[4] is None:
            continue
        d = float(r[4])
        if math.isnan(d) or math.isinf(d):
            continue
        out.append(
            RetrievedChunk(
                chunk_id=r[0],
                material_id=str(r[1]),
                title=r[2],
                text=raw_text,
                distance=d,
                material_url=_normalize_material_url(material_uri),
            )
        )
    return out


def _has_relevant_vector_signal(chunks: list[RetrievedChunk]) -> bool:
    """Heuristic: decide whether vector matches are likely useful."""
    if not chunks:
        return False

    # Best-match cutoff: very close neighbors are clearly useful.
    top = chunks[0]["distance"]
    if top <= _VECTOR_TOP_CONFIDENCE_DISTANCE:
        return True

    # Very distant top result is usually noise (for cosine distance on
    # normalized vectors, >1.0 is generally weak). Gate to web-search
    # when in this regime, but keep a conservative ceiling so we
    # don't miss useful low-quality corpora that still contain a signal.
    if top >= _VECTOR_WEAK_DISTANCE_CEILING:
        return False

    # If only one row is available we don't have a second-order spread
    # signal, so accept the first one only when it's not too weak.
    if len(chunks) == 1:
        return top <= 0.75

    second = chunks[1]["distance"]
    # In many practical corpora, a weak top result should only be used
    # when the second best isn't much farther away. A tiny spread
    # indicates a coherent local neighborhood rather than a single
    # accidental match.
    return second - top <= _VECTOR_SPREAD_CEILING


def _looks_like_web_tool(tool: BaseTool) -> bool:
    name = (tool.name or "").lower()
    desc = (getattr(tool, "description", "") or "").lower()
    unprefixed_name = name.split("__", 1)[1] if "__" in name else name
    # Many MCP servers expose lots of search-like tools (repo search,
    # source discovery, etc.) and we only want web-facing retrieval.
    # Prefer explicit web hints over generic search names.
    if "search_repos" in name or "search_repo" in name:
        return False
    if "zotero" in name or "zotero" in desc:
        zotero_source_markers = (
            "list_libraries",
            "get_collections",
            "get_collection_items",
            "list_feeds",
            "get_recent",
            "search_items",
            "semantic_search",
            "search_notes",
            "search_collections",
            "get_tags",
        )
        return any(marker in unprefixed_name for marker in zotero_source_markers)
    if any(server in name or server in desc for server in ("obsidian", "notion")):
        local_source_markers = (
            "search",
            "find",
            "list",
            "read",
            "get",
            "query",
            "page",
            "pages",
            "note",
            "notes",
            "database",
            "databases",
            "vault",
            "file",
            "files",
            "folder",
            "folders",
        )
        return any(marker in unprefixed_name for marker in local_source_markers)
    if "search" not in name:
        return False
    webish = ["web", "internet", "snippet", "url", "crawl", "query", "search"]
    return any(token in desc for token in webish) or any(
        token in name for token in ("tavily", "firecrawl", "search")
    )


def _looks_like_source_query(query: str) -> bool:
    q = (query or "").lower().strip()
    if not q:
        return False
    return any(token in q for token in _SOURCE_QUERY_HINTS)


def _looks_like_casual_fast_path(query: str | None) -> bool:
    q = _normalize_space_text(query or "")
    if not q:
        return True
    if any(token in q for token in _GROUNDING_REQUIRED_HINTS):
        return False
    words = q.split()
    if len(words) <= 4 and any(token == q or token in q for token in _CASUAL_FAST_PATH_HINTS):
        return True
    return len(words) <= 3


def _looks_like_memory_inventory_query(query: str | None) -> bool:
    q = (query or "").lower().strip()
    if not q:
        return False
    normalized = _normalize_space_text(q)
    return any(token in normalized for token in _MEMORY_INVENTORY_HINTS)


def _memory_row_to_recalled(memory_row: object) -> RecalledMemory | None:
    """Convert a memory row record from ``list_memories()`` into ``RecalledMemory``."""
    row_id = getattr(memory_row, "id", None)
    try:
        row_id_uuid = row_id if isinstance(row_id, uuid.UUID) else uuid.UUID(str(row_id))
    except (TypeError, ValueError):
        return None
    scope = getattr(memory_row, "scope")
    project_id = getattr(memory_row, "project_id", None)
    project_uuid = (
        project_id
        if isinstance(project_id, uuid.UUID)
        else (uuid.UUID(str(project_id)) if project_id is not None else None)
    )
    kind = getattr(memory_row, "kind")
    title = getattr(memory_row, "title", "")
    body = getattr(memory_row, "body", "")
    source_session = getattr(memory_row, "source_session", None)
    try:
        source_session_uuid = (
            source_session
            if isinstance(source_session, uuid.UUID) or source_session is None
            else uuid.UUID(str(source_session))
        )
    except (TypeError, ValueError):
        return None
    created_at = getattr(memory_row, "created_at", None)
    created_at_iso = created_at.isoformat() if hasattr(created_at, "isoformat") else ""
    return RecalledMemory(
        id=row_id_uuid,
        scope=scope,
        project_id=project_uuid,
        kind=kind,
        title=title,
        body=body,
        source_session=source_session_uuid,
        score=1.0,
        created_at_iso=created_at_iso,
    )


async def _load_memory_inventory_rows(
    member_id: str | None,
    project_id: str | uuid.UUID | None,
) -> list:
    if not member_id:
        return []
    try:
        mid = (
            member_id
            if isinstance(member_id, uuid.UUID)
            else uuid.UUID(str(member_id))
        )
    except (TypeError, ValueError):
        return []

    rows: list = []
    try:
        rows.extend(
            await list_memories(
                member_id=mid,
                scope="general",
                project_id=None,
                limit=8,
            )
        )
        if project_id:
            rows.extend(
                await list_memories(
                    member_id=mid,
                    scope="project",
                    project_id=(
                        project_id
                        if isinstance(project_id, uuid.UUID)
                        else uuid.UUID(str(project_id))
                    ),
                    limit=8,
                )
            )
    except Exception:
        log.warning("memory inventory load failed", exc_info=True)
        return []
    return rows


def _format_memory_inventory_block(memory_rows: list[object], *, max_items: int = 8) -> str:
    """Render a concise memory inventory system block for inventory-style prompts."""
    if not memory_rows:
        return "You do not currently have any saved long-term memory entries for the current scopes."

    # Keep the list short and stable even when a scope has many rows.
    lines = ["Here are saved long-term memories I currently have available:"]
    for row in memory_rows[:max_items]:
        scope = getattr(row, "scope", "")
        kind = (getattr(row, "kind", "") or "note").replace("_", " ")
        title = (getattr(row, "title", "") or "").strip()
        body = (getattr(row, "body", "") or "").strip()
        kind_label = f"{scope or 'general'} {kind}".strip()
        label = f"[{kind_label}]"
        lines.append(f"{label} {title}: {body}")
    return "\n".join(lines)


def _normalize_space_text(value: str) -> str:
    lowered = value.lower()
    replaced = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", replaced).strip()


def _looks_like_mcp_install_request(text: str | None) -> bool:
    q = _normalize_space_text(text or "")
    if not q:
        return False

    if not any(verb in q for verb in _MCP_INSTALL_VERBS):
        return False

    if any(token in q for token in _MCP_INSTALL_TARGET_HINTS):
        return True

    # If the user mentions a known MCP/source name without generic words
    # like "connector", still treat it as install intent.
    normalized_entries: set[str] = set()
    for entry in list_catalog():
        normalized_entries.update(_mcp_install_aliases(entry))
    return any(token and token in q.split() for token in normalized_entries)


def _mcp_install_aliases(entry: CatalogEntry) -> set[str]:
    aliases: set[str] = {entry.id.lower()}
    aliases.add(_normalize_space_text(entry.name))

    if entry.author:
        author = entry.author.strip().lower()
        aliases.add(_normalize_space_text(author))
        if "/" in author:
            aliases.add(author.split("/", 1)[1])

    split_aliases: set[str] = set()
    for alias in list(aliases):
        split_aliases.update(_normalize_space_text(alias).split())
        split_aliases.add(alias)

    return {a for a in split_aliases if len(a) >= 3}


def _mcp_catalog_entry_link(entry: CatalogEntry) -> str | None:
    author = (entry.author or "").strip()
    if not author:
        return None
    # Use an app-link so chat can reliably trigger in-app install logic
    # (instead of opening the upstream repository page).
    # Example: notesci://mcp/install/semantic-scholar
    return f"notesci://mcp/install/{entry.id}"


def _find_install_target_matches(text: str | None) -> list[CatalogEntry]:
    if not _looks_like_mcp_install_request(text):
        return []

    q = _normalize_space_text(text or "")
    if not q:
        return []

    tokens = set(q.split())
    matches: list[tuple[int, CatalogEntry]] = []

    for entry in list_catalog():
        if not entry.available:
            continue

        score = 0
        aliases = _mcp_install_aliases(entry)

        for alias in aliases:
            if not alias:
                continue

            if alias in q:
                score += 3

            if alias in tokens:
                score += 2

        if score > 0:
            matches.append((score, entry))

    if not matches:
        # Fallback: if user intent is explicit but no high-confidence
        # match exists, still offer available catalogs as suggestions.
        return [e for e in list_catalog() if e.available]

    matches.sort(key=lambda item: (item[0], item[1].name.lower()), reverse=True)
    return [entry for _score, entry in matches]


def _build_mcp_install_guidance(text: str | None) -> str | None:
    if not _looks_like_mcp_install_request(text):
        return None

    matches = _find_install_target_matches(text)
    if not matches:
        return None

    rendered: list[str] = []
    seen: set[str] = set()
    for entry in matches[:4]:
        link = _mcp_catalog_entry_link(entry)
        if not link or link in seen:
            continue
        seen.add(link)
        rendered.append(f"- [{entry.name}]({link})")

    if not rendered:
        return None

    return (
        "If the user asked for MCP install, provide one clickable link from this set and "
        "ask them to click it in Notesci:\n" + "\n".join(rendered)
    )


def _flatten_web_candidate(result: Any) -> list[dict[str, Any]]:
    if result is None:
        return []
    if isinstance(result, str):
        text = result.strip()
        return [{"text": text}] if text else []
    if isinstance(result, dict):
        # Common MCP response shapes:
        #  - tavily: {'results': [...]}
        #  - firecrawl: {'data': [...]} or {'markdown': '...'}
        for key in ("results", "items", "data", "docs", "documents", "hits"):
            value = result.get(key)
            if isinstance(value, list):
                return [x for x in value if x]
            if isinstance(value, dict):
                return [value]
        for key in ("content", "text", "summary", "answer"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return [{"text": value.strip()}]
        return [{"text": str(result)}]
    if isinstance(result, list):
        out: list[dict[str, Any]] = []
        for item in result:
            if isinstance(item, str):
                t = item.strip()
                if t:
                    out.append({"text": t})
            elif isinstance(item, dict):
                out.append(item)
        return out
    return [{"text": str(result)}]


def _snippet_text_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        # Tool payloads occasionally emit [] for snippets.
        if not value:
            return ""
        parts = [
            item_text
            for item in value
            for item_text in [_snippet_text_value(item)]
            if item_text
        ]
        return ", ".join(parts)
    if isinstance(value, dict):
        # Prefer explicit string fields first, then fall back to any
        # nested scalar-ish value we can flatten. PubMed-like payloads
        # sometimes nest snippets in a small object map, and generic
        # tool providers vary field names.
        for key in (
            "text",
            "snippet",
            "content",
            "summary",
            "description",
            "answer",
            "body",
            "abstract",
            "AbstractText",
            "message",
            "result",
            "value",
        ):
            nested = value.get(key)
            nested_text = _snippet_text_value(nested)
            if nested_text:
                return nested_text
        return ""
        return str(value).strip()


def _coalesce_text_value(value: Any, *, _depth: int = 0) -> str:
    """Recursively extract the first non-empty string-like value in a payload.

    This is a safety net for search tool payloads that place snippet text
    in unusual nesting (for example ``{"Abstract": ["..."]}`` or deeply
    nested dictionaries).

    A small depth cap avoids accidental pathological recursion on malformed
    tool output while still handling practical payloads.
    """
    if _depth > 4:
        return ""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value).strip()

    if isinstance(value, list):
        for item in value:
            item_text = _coalesce_text_value(item, _depth=_depth + 1)
            if item_text and not _is_placeholder_text(item_text):
                return item_text
        return ""

    if isinstance(value, dict):
        # Prefer obvious snippet-bearing keys first, then fallback through
        # remaining keys in stable insertion order.
        for key in (
            "text",
            "snippet",
            "content",
            "description",
            "summary",
            "answer",
            "body",
            "abstract",
            "Abstract",
            "AbstractText",
            "title_abstract",
            "Definition",
        ):
            if key in value:
                candidate = _coalesce_text_value(value[key], _depth=_depth + 1)
                if candidate and not _is_placeholder_text(candidate):
                    return candidate

        for candidate in value.values():
            nested = _coalesce_text_value(candidate, _depth=_depth + 1)
            if nested and not _is_placeholder_text(nested):
                return nested
        return ""

    return str(value).strip()


def _first_http_url(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith("http://") or candidate.startswith("https://"):
            return candidate
        return None
    if isinstance(value, dict):
        for key in (
            "url",
            "uri",
            "href",
            "link",
            "source",
            "source_url",
            "abstract_url",
            "full_text_url",
            "html",
        ):
            if key in value and isinstance(value[key], (str, list, dict)):
                found = _first_http_url(value[key])
                if found:
                    return found
        for nested in value.values():
            found = _first_http_url(nested)
            if found:
                return found
        return None
    if isinstance(value, list):
        for item in value:
            found = _first_http_url(item)
            if found:
                return found
        return None
    return None


def _normalize_material_url(raw_url: str | None) -> str | None:
    if not raw_url:
        return None
    candidate = raw_url.strip()
    if candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    return None


def _metadata_material_url(metadata: Any) -> str | None:
    # Preserve the robust extraction behavior from payload-level source
    # metadata (including PubMed / arXiv identifiers). This keeps
    # empty-chunk web rows citeable even when ``uri`` was never set.
    if isinstance(metadata, dict):
        source = _resolve_source_url(metadata)
        if source:
            return source
    return _normalize_material_url(_first_http_url(metadata))


def _is_placeholder_text(value: str) -> bool:
    normalized = "".join((value or "").lower().split())
    return normalized in {
        "",
        "[]",
        "{}",
        "[ ]",
        "{ }",
        "none",
        "null",
        "no snippet available.",
        "no snippet available",
        "undefined",
    }


def _resolve_source_url(row: dict[str, Any]) -> str | None:
    source = (
        row.get("url")
        or row.get("source")
        or row.get("link")
        or row.get("uri")
        or row.get("href")
        or row.get("pdf_url")
        or row.get("pdfUrl")
        or row.get("pdf")
        or row.get("open_access_pdf")
        or row.get("openAccessPdf")
        or row.get("landing_page_url")
        or row.get("landingPageUrl")
    )
    if source:
        source_text = _snippet_text_value(source)
        found = _first_http_url(source) or _first_http_url(source_text)
        return found or source_text or None
    source = _first_http_url(row)
    if source:
        return source

    doi = row.get("doi") or row.get("DOI")
    if doi:
        s = str(doi).strip()
        if s:
            if s.startswith("http://") or s.startswith("https://"):
                return s
            return f"https://doi.org/{s.removeprefix('doi:').strip()}"

    openalex_id = row.get("openalex_id") or row.get("openalex") or row.get("OpenAlex")
    if openalex_id:
        s = str(openalex_id).strip()
        if s:
            return s if s.startswith("http") else f"https://openalex.org/{s}"

    semantic_id = row.get("paperId") or row.get("paper_id") or row.get("semantic_scholar_id")
    if semantic_id:
        s = str(semantic_id).strip()
        if s:
            return f"https://www.semanticscholar.org/paper/{s}"

    # Many literature tools only return an identifier (PMID / arXiv / DOI)
    # and no explicit URL. Try to materialize a safe URL so the citation
    # stays click-openable.
    pubmed_id = (
        row.get("pmid")
        or row.get("PMID")
        or row.get("pubmed_id")
        or row.get("uid")
        or row.get("PubmedID")
        or row.get("PubMedID")
    )
    if pubmed_id:
        s = str(pubmed_id).strip()
        if s:
            return f"https://pubmed.ncbi.nlm.nih.gov/{s}/"

    arxiv_id = row.get("arxiv_id") or row.get("arXiv") or row.get("arxiv")
    if arxiv_id:
        s = str(arxiv_id).strip()
        if s:
            return f"https://arxiv.org/abs/{s}"

    return None


def _snippet_text(row: dict[str, Any]) -> tuple[str, str, str | None]:
    title = str(row.get("title") or row.get("name") or "").strip()

    source = _resolve_source_url(row)
    source_text = _snippet_text_value(source)
    source = source_text if source_text else None

    text = ""
    for key in (
        "snippet",
        "text",
        "content",
        "body",
        "summary",
        "description",
        "answer",
        "AbstractText",
        "Definition",
        "Abstract",
        "title_abstract",
    ):
        value = row.get(key)
        value_text = _snippet_text_value(value)
        if value_text:
            text = value_text
            break
    if not text:
        raw = row.get("Result")
        if isinstance(raw, str):
            text = re.sub(r"<[^>]+>", "", raw).strip()
        else:
            text = _snippet_text_value(raw)
    if not text:
        text = _coalesce_text_value(row)
    if not text:
        # Last-ditch fallback for MCPs that only expose non-text payloads.
        if source_text:
            text = f"Source: {source_text}"
    if _is_placeholder_text(text):
        text = f"Source: {source}" if source_text else "No snippet available."

    if not text and title:
        text = title

    if not text:
        text = "No snippet available."

    header = title if title else (f"{source}" if source else "Web result")
    if source and str(source) not in header:
        return header, f"{text}\n\nSource: {source}", source
    return header, text, source


def _extract_ddg_web_candidates(payload: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_candidate(candidate: dict[str, Any]) -> None:
        if len(candidates) >= limit:
            return
        title = str(candidate.get("title") or candidate.get("Heading") or "").strip()
        text = str(
            candidate.get("text")
            or candidate.get("snippet")
            or candidate.get("content")
            or candidate.get("Text")
            or candidate.get("AbstractText")
            or ""
        ).strip()
        if not text and isinstance(candidate.get("Result"), str):
            text = re.sub(r"<[^>]+>", "", str(candidate["Result"]))
        if not text:
            return
        url = str(
            candidate.get("url")
            or candidate.get("FirstURL")
            or candidate.get("source")
            or ""
        )
        source_key = f"{url}|{text}"
        if source_key in seen:
            return
        seen.add(source_key)
        candidates.append({
            "title": title or "Web result",
            "text": text,
            "url": url if url else None,
        })

    def walk_ddg_items(items: Any) -> None:
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict):
                continue
            nested = item.get("Topics")
            if isinstance(nested, list):
                walk_ddg_items(nested)
                continue
            add_candidate(item)

    abstract_text = payload.get("AbstractText")
    if isinstance(abstract_text, str) and abstract_text.strip():
        add_candidate(
            {
                "title": payload.get("Heading") or "Web result",
                "text": abstract_text,
                "url": payload.get("AbstractURL"),
            }
        )

    answer = payload.get("Answer")
    if isinstance(answer, str) and answer.strip():
        add_candidate(
            {
                "title": payload.get("Heading") or "Web answer",
                "text": answer,
                "url": payload.get("AbstractURL") or payload.get("DefinitionURL"),
            }
        )

    definition = payload.get("Definition")
    if isinstance(definition, str) and definition.strip():
        add_candidate(
            {
                "title": payload.get("DefinitionSource") or "Web definition",
                "text": definition,
                "url": payload.get("DefinitionURL"),
            }
        )

    walk_ddg_items(payload.get("RelatedTopics"))
    walk_ddg_items(payload.get("Results"))
    return candidates


async def _retrieve_web_fallback(
    query: str,
    limit: int = 5,
    project_id: str | None = None,
) -> list[RetrievedChunk]:
    query = query.strip()
    if not query:
        return []

    params = {
        "q": query,
        "format": "json",
        "no_html": 1,
        "no_redirect": 1,
        "skip_disambig": 1,
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get("https://api.duckduckgo.com/", params=params)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        log.debug("Web fallback failed for query=%r: %s", query, exc)
        return []

    rows = _extract_ddg_web_candidates(payload, limit)
    out: list[RetrievedChunk] = []
    for idx, row in enumerate(rows):
        if len(out) >= limit:
            break
        if not isinstance(row, dict):
            continue
        title, text, source = _snippet_text(row)
        if not text:
            continue
        material_id = (
            f"web-fallback:{md5((query + str(idx) + title).encode()).hexdigest()}"
        )
        chunk_id = idx
        persisted = None
        if project_id:
            persisted = await _persist_web_search_chunk(
                project_id,
                query,
                title=title,
                text=text,
                source_url=source,
            )
        if persisted:
            material_id, chunk_id = persisted
        out.append(
            RetrievedChunk(
                chunk_id=chunk_id,
                material_id=material_id,
                title=title,
                text=text,
                distance=float(idx),
                material_url=source,
            )
        )
    return out


async def _persist_web_search_chunk(
    project_id: str,
    query: str,
    *,
    title: str,
    text: str,
    source_url: str | None,
) -> tuple[str, int] | None:
    """Persist a web hit as a real material + chunk when possible."""
    try:
        project_uuid = uuid.UUID(project_id)
    except ValueError:
        return None

    normalized_title = (title or "").strip()[:255]
    normalized_text = text.strip()
    if _is_placeholder_text(normalized_text):
        normalized_text = (
            f"Source: {source_url}"
            if source_url and not _is_placeholder_text(source_url)
            else "No snippet available."
        )
    if not normalized_text:
        return None

    metadata = {
        "materialized_from": "web_search",
        "search_query": query,
        "source_url": source_url,
    }

    embedding = None
    if normalized_text and not _is_placeholder_text(normalized_text):
        if embedding_provider_available():
            try:
                embedding = (await make_embedding_model().aembed_documents([normalized_text]))[0]
            except Exception:
                log.debug(
                    "Failed to embed web-search chunk for %r",
                    source_url,
                    exc_info=True,
                )
                embedding = None

    async with get_conn() as conn:
        material_id: uuid.UUID | None = None
        if source_url:
            cur = await conn.execute(
                """
                SELECT id
                  FROM materials
                 WHERE project_id = %s
                   AND source_type = 'url'
                   AND uri = %s
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                (project_uuid, source_url),
            )
            existing = await cur.fetchone()
            if existing:
                material_id = existing[0]

        if material_id is None:
            try:
                row = await (
                    await conn.execute(
                        """
                        INSERT INTO materials
                          (project_id, source_type, title, uri, metadata)
                        VALUES (%s, %s, %s, %s, %s)
                        RETURNING id
                        """,
                        (
                            project_uuid,
                            "url",
                            normalized_title or None,
                            source_url,
                            Jsonb(metadata),
                        ),
                    )
                ).fetchone()
            except Exception:
                log.debug(
                    "Failed to materialize web search material for %r",
                    source_url,
                    exc_info=True,
                )
                return None
            material_id = row[0] if row else None

        if material_id is None:
            return None

        cur = await conn.execute(
            "SELECT id, text, embedding FROM chunks WHERE material_id=%s AND text=%s ORDER BY id ASC LIMIT 1",
            (material_id, normalized_text),
        )
        existing = await cur.fetchone()
        if not existing:
            cur = await conn.execute(
                "SELECT id, text, embedding FROM chunks WHERE material_id=%s ORDER BY created_at DESC LIMIT 1",
                (material_id,),
            )
            existing = await cur.fetchone()
        if existing:
            existing_chunk_id = existing[0]
            existing_text = existing[1] or ""
            existing_embedding = existing[2]
            if _is_placeholder_text(existing_text) and normalized_text != (existing_text or ""):
                await conn.execute(
                    "UPDATE chunks SET text = %s WHERE id = %s",
                    (normalized_text, existing_chunk_id),
                )
            if embedding is not None and not existing_embedding:
                await conn.execute(
                    "UPDATE chunks SET embedding = %s WHERE id = %s",
                    (embedding, existing_chunk_id),
                )
            await conn.commit()
            return str(material_id), int(existing_chunk_id)

        try:
            cur = await conn.execute(
                """
                INSERT INTO chunks (material_id, ord, text, embedding)
                VALUES (
                    %s,
                    COALESCE((
                        SELECT MAX(ord)
                        FROM chunks
                        WHERE material_id = %s
                    ), -1) + 1,
                    %s,
                    %s
                )
                RETURNING id
                """,
                (material_id, material_id, normalized_text, embedding),
            )
        except Exception:
            # Concurrent inserts can race; try once more by text.
            cur = await conn.execute(
                "SELECT id, text, embedding FROM chunks WHERE material_id=%s AND text=%s ORDER BY id ASC LIMIT 1",
                (material_id, normalized_text),
            )
            existing = await cur.fetchone()
            if not existing:
                cur = await conn.execute(
                    "SELECT id, text, embedding FROM chunks WHERE material_id=%s ORDER BY created_at DESC LIMIT 1",
                    (material_id,),
                )
                existing = await cur.fetchone()
            if existing:
                existing_chunk_id = existing[0]
                existing_text = existing[1] or ""
                existing_embedding = existing[2]
                if _is_placeholder_text(existing_text) and normalized_text != (existing_text or ""):
                    await conn.execute(
                        "UPDATE chunks SET text = %s WHERE id = %s",
                        (normalized_text, existing_chunk_id),
                    )
                if embedding is not None and not existing_embedding:
                    await conn.execute(
                        "UPDATE chunks SET embedding = %s WHERE id = %s",
                        (embedding, existing_chunk_id),
                    )
                await conn.commit()
                return str(material_id), int(existing_chunk_id)
            return None

        inserted = await cur.fetchone()
        await conn.commit()
    if not inserted:
        return None
    return str(material_id), int(inserted[0])


async def _retrieve_web(
    query: str,
    web_tools: list[BaseTool],
    limit: int = 5,
    project_id: str | None = None,
) -> list[RetrievedChunk]:
    query = query.strip()
    if not query:
        return []

    candidates = web_tools[:]
    # Deterministic ordering so UI traces are stable for snapshots.
    candidates.sort(key=lambda t: (_source_tool_priority(t, query), t.name))

    arg_variants = (
        {"query": query, "max_results": limit},
        {"query": query, "count": limit},
        {"query": query, "top_k": limit},
        {"query": query, "num_results": limit},
        {"q": query},
        {"search_query": query},
        {"input": query},
        {"limit": limit},
        {},
    )

    for tool in candidates:
        rows: list[dict[str, Any]] = []
        for args in arg_variants:
            try:
                raw = await tool.ainvoke(args)
            except Exception:
                # Try the next argument shape before selecting another
                # tool. Some servers are very strict, and a bad arg key
                # can throw a validation error that is not worth aborting
                # this retrieval fallback.
                continue
            rows = _flatten_web_candidate(raw)
            if rows:
                break
        if not rows:
            continue

        out: list[RetrievedChunk] = []
        for idx, row in enumerate(rows[:limit]):
            if isinstance(row, dict):
                title, text, source = _snippet_text(row)
            else:
                content = str(row).strip()
                if not content:
                    continue
                title, text, source = "Web result", content, None

            material_id = f"web:{md5((query + str(tool.name) + str(idx)).encode()).hexdigest()}"
            material_url = source
            chunk_id = idx
            if _is_placeholder_text(material_url):
                material_url = None
            out.append(
                RetrievedChunk(
                    chunk_id=chunk_id,
                    material_id=material_id,
                    title=title,
                    text=text,
                    distance=float(idx),
                    material_url=material_url,
                )
            )

        if out:
            return out

    return await _retrieve_web_fallback(query, limit=limit, project_id=project_id)


def _source_tool_priority(tool: BaseTool, query: str) -> int:
    """Prefer browse/list tools when the user asks to inspect a library.

    Generic alphabetical ordering can pick a strict or write-oriented Zotero
    tool before the safe no-arg browser tools. This keeps explicit requests
    like "use Zotero MCP to browse local libraries" on
    ``zotero_list_libraries`` / collection inventory instead of falling
    through to a web fallback.
    """
    name = (tool.name or "").lower()
    unprefixed_name = name.split("__", 1)[1] if "__" in name else name
    desc = (getattr(tool, "description", "") or "").lower()
    q = _normalize_space_text(query)

    if "zotero" in name or "zotero" in desc:
        asks_library_inventory = any(
            token in q
            for token in (
                "library",
                "libraries",
                "local library",
                "local libraries",
                "browse",
                "list",
            )
        )
        asks_collections = "collection" in q or "collections" in q
        asks_collection_items = asks_collections and any(
            token in q
            for token in (
                "item",
                "items",
                "paper",
                "papers",
                "reference",
                "references",
                "entry",
                "entries",
                "content",
                "contents",
                "inside",
                "from collection",
                "in collection",
            )
        )
        asks_recent = "recent" in q or "latest" in q or "newly added" in q
        asks_tags = "tag" in q or "tags" in q
        if asks_library_inventory and "list_libraries" in unprefixed_name:
            return 0
        if asks_collection_items and "get_collection_items" in unprefixed_name:
            return 0
        if asks_collection_items and "search_collections" in unprefixed_name:
            return 1
        if asks_collections and "get_collections" in unprefixed_name:
            return 0
        if asks_collections and "search_collections" in unprefixed_name:
            return 1
        if asks_recent and "get_recent" in unprefixed_name:
            return 0
        if asks_tags and "get_tags" in unprefixed_name:
            return 0
        if "search_items" in unprefixed_name or "semantic_search" in unprefixed_name:
            return 2
        if "search" in unprefixed_name:
            return 3
        if any(marker in unprefixed_name for marker in ("list_libraries", "get_collections", "get_recent")):
            return 4
        return 8

    if any(server in name or server in desc for server in ("obsidian", "notion")):
        asks_inventory = any(
            token in q
            for token in (
                "browse",
                "list",
                "show",
                "all",
                "workspace",
                "vault",
                "notes",
                "pages",
                "databases",
            )
        )
        if asks_inventory and any(
            marker in unprefixed_name
            for marker in (
                "list",
                "list_pages",
                "list_notes",
                "list_databases",
                "list_files",
                "get_pages",
                "get_notes",
                "get_databases",
                "get_files",
            )
        ):
            return 0
        if "search" in unprefixed_name or "find" in unprefixed_name or "query" in unprefixed_name:
            return 2
        if any(marker in unprefixed_name for marker in ("read", "get", "page", "note", "database", "file")):
            return 4
        return 8

    if "search" in name:
        return 5
    return 9


async def _retrieve_tree(project_id: str, query: str) -> list[RetrievedChunk]:
    """Reasoning-based retrieval over per-material trees.

    For each material in the project with a ready tree, ask the LLM
    which tree nodes are relevant to ``query``, then fold the resulting
    section text into ``RetrievedChunk`` shapes so the rest of the
    pipeline doesn't need to know the difference. Per-material call is
    O(1 LLM call) — the prompt only carries the tree outline, not the
    full text — so cost stays bounded even on a large project.
    """
    # Local import — keeps `agent.graph` decoupled from the optional
    # pagetree feature when it's disabled or absent.
    from ..pagetree import select_relevant_nodes, gather_text_for_nodes

    async with get_conn() as conn:
        cur = await conn.execute(
            """
            SELECT mt.material_id, m.title, mt.tree
              FROM material_trees mt
              JOIN materials m ON m.id = mt.material_id
             WHERE mt.project_id = %s AND mt.status = 'ready'
             ORDER BY m.created_at DESC
             LIMIT 5
            """,
            (project_id,),
        )
        rows = await cur.fetchall()

    if not rows:
        return []

    retrieved: list[RetrievedChunk] = []
    for material_id, title, tree_payload in rows:
        if not tree_payload:
            continue
        structure = tree_payload.get("structure") or []
        doc_description = tree_payload.get("doc_description") or ""
        try:
            node_ids = await select_relevant_nodes(
                structure,
                query,
                doc_description=doc_description,
                top_k=3,
            )
        except Exception:
            log.exception("tree-retrieve: node selection failed for %s", material_id)
            continue
        if not node_ids:
            continue
        text = gather_text_for_nodes(structure, node_ids, max_chars=4000)
        if not text:
            continue
        # We don't have a real chunk_id here — encode the picked node ids
        # so the citation surface can still link back to a location.
        retrieved.append(
            RetrievedChunk(
                chunk_id=0,
                material_id=str(material_id),
                title=title or None,
                text=f"(tree nodes: {','.join(node_ids)})\n{text}",
                distance=0.0,
                material_url=None,
            )
        )
    return retrieved


async def _retrieve(state: AgentState, config: RunnableConfig) -> dict:
    project_id = config.get("configurable", {}).get("project_id")
    last_user = next(
        (m for m in reversed(state["messages"]) if m.type == "human"), None
    )
    if not last_user:
        return {"retrieved": []}

    query = last_user.content if isinstance(last_user.content, str) else str(last_user.content)
    ctx = get_request_ctx()
    if _looks_like_casual_fast_path(query):
        ctx.retrieval_mode_used = "none"
        return {"retrieved": []}
    web_tools = [
        tool for tool in ctx.tools if _looks_like_web_tool(tool)
    ]

    # General chats (no project id) don't have material-grounded
    # retrieval, so route directly to web-search when enabled.
    if not project_id:
        if ctx.web_search:
            web_chunks = await _retrieve_web(query, web_tools, project_id=project_id)
            if web_chunks:
                ctx.retrieval_mode_used = "web"
                return {"retrieved": web_chunks}
        ctx.retrieval_mode_used = "none"
        return {"retrieved": []}

    # Explicit source/library lookup questions should prefer web-style
    # MCP tools (e.g., Zotero/Tavily/Firecrawl) first, even in
    # project chats. This avoids answering from stale local chunks when
    # the user explicitly asks for a fresh external/library query.
    if _looks_like_source_query(query) and ctx.web_search:
        web_chunks = await _retrieve_web(query, web_tools, project_id=project_id)
        if web_chunks:
            ctx.retrieval_mode_used = "web"
            return {"retrieved": web_chunks}

    # Project chats can try tree + vector first, and only fallback to web
    # if local retrieval fails/empties the result.
    retrieved: list[RetrievedChunk] = []

    if ctx.retrieval_mode == "tree":
        try:
            retrieved = await _retrieve_tree(project_id, query)
        except Exception as exc:
            # Tree retrieval is LLM-driven; a model failure shouldn't
            # take down the chat. Fall through to vector.
            log.warning("tree retrieval failed (%s); falling back to vector", exc)
            retrieved = []
        if retrieved:
            ctx.retrieval_mode_used = "tree"
            return {"retrieved": retrieved}
        # Graceful fallback — no trees ready yet means a freshly-uploaded
        # project should still answer via vector kNN rather than emit an
        # empty context block.
        log.info(
            "tree retrieval returned no rows for project %s — falling back to vector",
            project_id,
        )
        # Continue into the vector branch.

    # Vector retrieval needs an embedding provider. When none is
    # configured, skip it outright — otherwise every chat turn wastes
    # seconds (the provider SDK retries with backoff) on a doomed
    # /embeddings call before the except below catches it. The
    # pre-flight keeps the turn fast and the chat un-grounded but
    # responsive.
    if not embedding_provider_available():
        log.info(
            "vector retrieval skipped for project %s — no embedding provider configured",
            project_id,
        )
        if ctx.web_search:
            web_chunks = await _retrieve_web(
                query, web_tools, project_id=project_id
            )
            if web_chunks:
                ctx.retrieval_mode_used = "web"
                return {"retrieved": web_chunks}
        ctx.retrieval_mode_used = "none"
        return {"retrieved": []}

    # The provider is configured but may still reject a request at
    # runtime — degrade to un-grounded chat instead of bubbling the
    # error to the user.
    try:
        retrieved = await _retrieve_vector(project_id, query)
    except Exception as exc:
        log.warning(
            "vector retrieval skipped for project %s — embedding provider unavailable: %s",
            project_id,
            exc,
        )
        retrieved = []
        ctx.retrieval_mode_used = "none"
        if ctx.web_search:
            web_chunks = await _retrieve_web(
                query, web_tools, project_id=project_id
            )
            if web_chunks:
                ctx.retrieval_mode_used = "web"
                return {"retrieved": web_chunks}

    if retrieved and _has_relevant_vector_signal(retrieved):
        ctx.retrieval_mode_used = "vector"
        return {"retrieved": retrieved}

    if retrieved and not _has_relevant_vector_signal(retrieved):
        log.info(
            "vector retrieval considered weak for project %s (top distance %.4f) — "
            "falling back to web search",
            project_id,
            retrieved[0]["distance"],
        )
        retrieved = []
        if ctx.web_search:
            web_chunks = await _retrieve_web(
                query, web_tools, project_id=project_id
            )
            if web_chunks:
                ctx.retrieval_mode_used = "web"
                return {"retrieved": web_chunks}
        ctx.retrieval_mode_used = "none"
        return {"retrieved": []}

    if not retrieved and ctx.web_search:
        web_chunks = await _retrieve_web(
            query, web_tools, project_id=project_id
        )
        if web_chunks:
            ctx.retrieval_mode_used = "web"
            return {"retrieved": web_chunks}

    return {"retrieved": retrieved}


def _identity_block(model_id: str | None) -> str | None:
    """Compose a short "you are X by Y" system line for the active model.

    Why this exists: LLMs trained without strong identity grounding
    (notably DeepSeek-Chat, but also smaller variants of every provider)
    will hallucinate when asked "which model are you?" — DeepSeek
    replied "I'm Claude 3.5 Sonnet by Anthropic" in our own tests. The
    LangGraph checkpointer also keeps message history across model
    switches, so a fresh model will mirror whatever identity a previous
    turn used. A single line up front pins the model's self-id to what
    we actually routed the request to, so the reply is honest about
    which provider answered. Falls back to None when we can't resolve
    the catalog entry (e.g. operator added a model id that isn't in
    ``MODELS``); in that case we don't prepend anything rather than
    asserting an identity we can't back up.
    """
    if not model_id:
        return None
    m = model_by_id(model_id)
    if not m:
        return None
    p = provider_by_id(m.provider_id)
    provider_name = p.display_name if p else m.provider_id
    return (
        f"You are {m.label}, served by {provider_name} "
        f"(canonical id: {m.id}). "
        "When the user asks which model or provider they're talking to, "
        "answer with these exact names. Do not claim to be any other "
        "model or company — earlier turns in this thread may have been "
        "answered by a different model and their self-references aren't "
        "yours."
    )


def _mcp_install_policy_block() -> str:
    """Model contract for MCP/source installation requests.

    Without this explicit reminder, some chat models may reply with a generic
    "cannot modify your system" refusal when users ask about connectors.
    The app handles installation via clickable links, so the model should route
    users to the in-app flow instead of claiming lack of system access.
    """
    return (
        "When users ask about MCP/source installation, do not claim inability "
        "to access their machine or modify system settings.\n"
        "- If a catalog MCP matches their request, render a clickable Markdown "
        "install link.\n"
        "- Say that clicking the link in notesci will install the connector automatically.\n"
        "- Keep the action within that link; do not ask users to visit a repository "
        "homepage.\n"
        "- Do not include shell commands or ask the user to run `pip`, `npm`, or "
        "`uvx` manually.\n"
    )


_MCP_REFUSAL_REPLACEMENT_MARKERS: tuple[str, ...] = (
    "can't install or modify anything",
    "can not install or modify anything",
    "can't install or modify",
    "can not install or modify",
    "cannot modify anything on your system",
    "can't modify anything on your system",
    "don't have direct access",
    "do not have direct access",
    "can't run shell commands",
    "cannot run shell commands",
    "no access to mcp",
    "no installed tools",
    "can't find any tool",
)

_MCP_DEFERRED_TOOL_REPLY_MARKERS: tuple[str, ...] = (
    "let me check",
    "let me look",
    "let me start by listing",
    "let me look up",
    "i'll check",
    "i will check",
    "i'll look",
    "i will look",
    "checking your",
)


def _repair_mcp_refusal_reply(
    content: str,
    user_message: AnyMessage | None,
) -> str:
    """Replace legacy "I can't install MCPs" refusals with Notesci flow copy."""
    if not content:
        return content

    lowered = content.lower()
    if not any(marker in lowered for marker in _MCP_REFUSAL_REPLACEMENT_MARKERS):
        return content

    user_text = getattr(user_message, "content", None)
    if not isinstance(user_text, str):
        user_text = None

    guidance = _build_mcp_install_guidance(user_text)
    linked = f"\n\n{guidance}" if guidance else ""

    return (
        "I can’t run shell commands or edit your machine directly from chat, "
        "so I can’t install MCPs myself. "
        "Notesci handles connector installs automatically when you click a Notesci MCP link in the app."
        " If you want to install one, use the matching one-click link below."
        f"{linked}"
    )


def _repair_unexecuted_mcp_reply(
    content: str,
    user_message: AnyMessage | None,
    ctx: RequestCtx,
) -> str:
    """Do not surface placeholder MCP replies as final answers.

    Some models return "Let me check..." without emitting a tool call. In the
    non-streaming chat UI that becomes the final assistant message, which reads
    like a hung MCP call. If no tool call happened, be explicit rather than
    pretending work is in progress.
    """
    if not content:
        return content

    user_text = getattr(user_message, "content", None)
    if not isinstance(user_text, str) or not _looks_like_source_query(user_text):
        return content

    normalized = _normalize_space_text(content)
    if len(normalized) > 180:
        return content
    if not any(marker in normalized for marker in _MCP_DEFERRED_TOOL_REPLY_MARKERS):
        return content

    mcp_tool_names = sorted(ctx.tool_to_server_id.keys())
    if not mcp_tool_names:
        requested_servers = [
            server
            for server in ("obsidian", "notion", "zotero")
            if server in _normalize_space_text(user_text)
        ]
        failed_requested = [
            server for server in requested_servers if server in ctx.mcp_load_errors
        ]
        if failed_requested:
            server = failed_requested[0]
            error = ctx.mcp_load_errors.get(server) or "server failed to load"
            return (
                f"I could not use the {server} MCP because it failed to load this turn: "
                f"{error}. Open Settings -> MCP servers -> {server.title()} -> Configure "
                "and fix the runtime config, then retry. For Obsidian, make sure the "
                "Obsidian Local REST API plugin is enabled, env.OBSIDIAN_API_KEY is set, "
                "and the server command is `uvx mcp-obsidian`."
            )
        return (
            "I did not have any MCP tools available in that turn, so I could not "
            "browse the requested local source. Confirm the MCP server is installed "
            "and enabled, then retry."
        )

    requested_servers = [
        server
        for server in ("obsidian", "notion", "zotero")
        if server in _normalize_space_text(user_text)
    ]
    missing_requested = [
        server
        for server in requested_servers
        if not any(server in name.lower() for name in mcp_tool_names)
    ]
    if missing_requested:
        failed_requested = [
            server for server in missing_requested if server in ctx.mcp_load_errors
        ]
        if failed_requested:
            server = failed_requested[0]
            error = ctx.mcp_load_errors.get(server) or "server failed to load"
            return (
                f"I could not use the {server} MCP because it failed to load this turn: "
                f"{error}. Open Settings -> MCP servers -> {server.title()} -> Configure "
                "and fix the runtime config, then retry. For Obsidian, make sure the "
                "Obsidian Local REST API plugin is enabled, env.OBSIDIAN_API_KEY is set, "
                "and the server command is `uvx mcp-obsidian`."
            )
        missing = ", ".join(missing_requested)
        return (
            f"I did not have callable {missing} MCP tools in that turn, so I could "
            "not browse that source. Open Settings -> MCP servers, confirm the "
            "server is enabled and configured, then retry. For Obsidian, the "
            "server requires the Obsidian Local REST API plugin, env.OBSIDIAN_API_KEY, "
            "and command `uvx mcp-obsidian`."
        )

    relevant = [
        name
        for name in mcp_tool_names
        if any(
            token in name.lower()
            for token in (
                "zotero",
                "obsidian",
                "notion",
                "library",
                "collection",
                "search",
                "note",
                "page",
                "database",
                "file",
                "vault",
            )
        )
    ][:8]
    shown = ", ".join(relevant or mcp_tool_names[:8])
    return (
        "I did not actually receive an MCP tool result in that turn, so I should "
        "not claim I checked the source. Available relevant MCP tools were: "
        f"{shown}. Please retry the request; Notesci will now force a real MCP "
        "lookup or report the tool error."
    )


def _format_mcp_tool_status(
    ctx: RequestCtx,
    last_human_text: str | None,
) -> str | None:
    """Describe which MCP tools are actually loaded for this request.

    This avoids “I don’t see any tools” confusion when users just installed
    a connector and then immediately ask the model to use it.
    """
    mcp_tool_names = sorted(ctx.tool_to_server_id.keys())
    failed_servers = ctx.mcp_load_errors
    if not mcp_tool_names:
        if failed_servers:
            failed = "; ".join(
                f"{slug}: {error}" for slug, error in sorted(failed_servers.items())
            )
            return (
                "No MCP tools are currently callable in this turn. The following "
                f"enabled MCP servers failed to load: {failed}. Do not claim to use "
                "those MCPs; tell the user to configure or restart them."
            )
        return None

    # MCP tools are sent to the model as "{server}__{tool_name}" to avoid
    # name collisions across servers. Keep that exact naming in the model
    # contract so it can invoke the right endpoint.
    by_server: dict[str, list[str]] = {}
    for name in mcp_tool_names:
        server = name.split("__", 1)[0]
        by_server.setdefault(server, []).append(name)

    # Keep lines stable and predictable for tests, and bounded for large
    # catalogs.
    rendered = []
    for server in sorted(by_server):
        names = sorted(by_server[server])
        rendered.append(f"{server}: {', '.join(names)}")

    joined = " | ".join(rendered)
    if len(joined) > 800:
        # Preserve high-signal names while avoiding giant prompt bloat.
        q = _normalize_space_text(last_human_text or "")
        requested = [
            name
            for name in mcp_tool_names
            if any(token and token in name.lower() for token in q.split())
        ]
        front = requested[:8] if requested else mcp_tool_names[:10]
        joined = f"{', '.join(front)}..."

    q = _normalize_space_text(last_human_text or "")
    if "zotero" in by_server and "collection" in q:
        collection_item_intent = any(
            token in q
            for token in (
                "item",
                "items",
                "paper",
                "papers",
                "reference",
                "references",
                "entry",
                "entries",
                "content",
                "contents",
            )
        )
        if collection_item_intent:
            joined = (
                f"{joined} | Zotero collection workflow: resolve the "
                "8-character collection key first with "
                "zotero__zotero_search_collections or "
                "zotero__zotero_get_collections, then call "
                "zotero__zotero_get_collection_items(collection_key=...). "
                "Do not pass a human-readable collection name as collection_key. "
                "If the collection is in another Zotero library or group, call "
                "zotero__zotero_list_libraries and "
                "zotero__zotero_switch_library before resolving collections."
            )

    failure_guidance = ""
    requested_failed = [
        server for server in failed_servers if server.lower() in q
    ]
    if requested_failed:
        failed = "; ".join(
            f"{slug}: {failed_servers[slug]}" for slug in requested_failed
        )
        failure_guidance = (
            " The user requested an MCP server that failed to load this turn: "
            f"{failed}. Do not claim to use it. Explain the load failure and ask "
            "the user to configure or restart that MCP server."
        )

    # If the user asked a source-search style question, this push is
    # explicit: call a matching MCP tool before answering.
    guidance = ""
    if _looks_like_source_query(last_human_text or ""):
        guidance = (
            " The user asked a source/library-style query."
            " You must call at least one relevant MCP tool before drafting the"
            " final answer, even if local chunks are available. If a relevant"
            " MCP tool errors or returns no data, report that exact result."
            " Do not answer only with a promise such as 'Let me check' or"
            " 'I will look it up'; either use the tool now or state that no"
            " relevant MCP tool is available."
        )

    return (
        "The following MCP tools are installed and callable this turn: "
        f"{joined}. Prefer these tools before answering requests for file/library "
        "lookup, metadata, or web-like searches when available."
        f"{guidance}"
        f"{failure_guidance}"
    )


async def _call_model(state: AgentState, config: RunnableConfig) -> dict:
    ctx = get_request_ctx()
    project_id_cfg = config.get("configurable", {}).get("project_id")
    # Resolve the model id we're actually about to run on, so the identity
    # block (below) names whatever ``make_chat_model`` will route to —
    # falling back to the operator default if the per-call model is unset.
    effective_model = ctx.model or resolve_default_model()
    llm = make_chat_model(ctx.model)
    if ctx.tools:
        llm = llm.bind_tools(ctx.tools)

    msgs = list(state["messages"])

    # Compute the turn this call belongs to (0-indexed = number of human
    # messages so far minus 1). Stored on chat_calls so the UI can join
    # by (session_id, turn_seq) and surface the model under each AI
    # bubble in the workspace.
    turn_seq = sum(1 for m in msgs if m.type == "human") - 1

    # Skill activation — only on the first model call of a turn (when the
    # latest message is a fresh human message, not a tool-loop continuation).
    # Detection runs against the most recent human message; activated
    # briefs are prepended as their own system block so retrieval context
    # stays cleanly separate from skill instructions.
    last_human = next(
        (m for m in reversed(msgs) if m.type == "human"), None
    )
    last_human_text = getattr(last_human, "content", None)
    if not isinstance(last_human_text, str):
        last_human_text = None
    skill_block: str | None = None
    if last_human is not None and isinstance(last_human.content, str):
        activated = detect_skills(
            last_human.content,
            allowed_skill_names=ctx.installed_skills,
        )
        if activated:
            skill_block = compose_skill_system_message(activated)
            ctx.activated_skills = [s.name for s in activated]

    retrieved = state.get("retrieved") or []
    if retrieved:
        ctx_block = _format_context(retrieved)
        sys = SystemMessage(
            content=(
                "Relevant source excerpts:\n\n"
                f"{ctx_block}\n\n"
                "Use [I#] citations, such as [I1], only for project/uploaded sources. "
                "Use Markdown links or [W#] citations only for external/MCP/web sources. "
                "Never use bare numeric citations like [1] or [2]; those are ambiguous."
            )
        )
        msgs = [sys] + msgs

    if skill_block:
        # Skill brief goes FIRST so the agent reads it before the
        # retrieval context — domain rules frame how to use the sources.
        msgs = [SystemMessage(content=skill_block)] + msgs

    # Long-term memory has two channels:
    #   1. core   — singleton scope blocks, always pinned when present.
    #   2. recall — top-k hybrid search over extracted facts.
    # Project chats read BOTH global researcher memory and project memory:
    # user-level preferences should follow the researcher across projects,
    # while project facts stay project-local. Failures are swallowed —
    # memory must never break the chat path.
    memory_blocks: list[SystemMessage] = []
    if not ctx.memory_incognito:
        core_scopes: list[tuple[str, str | None]] = [("general", None)]
        if project_id_cfg:
            core_scopes.append(("project", project_id_cfg))
        for mem_scope, mem_project_id in core_scopes:
            try:
                core_block = await build_core_injection(
                    member_id=ctx.member_id,
                    scope=mem_scope,  # type: ignore[arg-type]
                    project_id=mem_project_id,
                )
                if core_block:
                    memory_blocks.append(SystemMessage(content=core_block))
            except Exception:
                log.warning(
                    "core memory injection failed for scope=%s",
                    mem_scope,
                    exc_info=True,
                )

        if (
            ctx.member_id
            and last_human is not None
            and isinstance(last_human.content, str)
            and not _looks_like_casual_fast_path(last_human.content)
        ):
            try:
                asks_for_memory_inventory = _looks_like_memory_inventory_query(
                    last_human.content
                )
                mid = (
                    ctx.member_id
                    if isinstance(ctx.member_id, uuid.UUID)
                    else uuid.UUID(str(ctx.member_id))
                )
                pid = (
                    project_id_cfg
                    if project_id_cfg is None or isinstance(project_id_cfg, uuid.UUID)
                    else uuid.UUID(str(project_id_cfg))
                )
                recalled: list[RecalledMemory]
                inventory_rows: list = []
                if asks_for_memory_inventory:
                    inventory_rows = await _load_memory_inventory_rows(
                        member_id=str(ctx.member_id),
                        project_id=project_id_cfg,
                    )
                    recalled = [
                        memory
                        for row in inventory_rows
                        if (memory := _memory_row_to_recalled(row)) is not None
                    ]
                else:
                    recalled = await memory_recall(
                        member_id=mid,
                        scope="general",
                        project_id=None,
                        query=last_human.content,
                        top_k=3 if pid else 5,
                    )
                    if pid is not None:
                        recalled.extend(
                            await memory_recall(
                                member_id=mid,
                                scope="project",
                                project_id=pid,
                                query=last_human.content,
                                top_k=5,
                            )
                        )
                unique_recalled: list[RecalledMemory] = []
                seen_memory_ids: set[str] = set()
                for memory in recalled:
                    key = str(memory.id)
                    if key in seen_memory_ids:
                        continue
                    seen_memory_ids.add(key)
                    unique_recalled.append(memory)
                ctx.memory_recalled = unique_recalled
                block = (
                    _format_memory_inventory_block(inventory_rows)
                    if asks_for_memory_inventory
                    else format_recall_block(unique_recalled)
                )
                if block:
                    memory_blocks.append(SystemMessage(content=block))
            except Exception:
                log.warning("memory recall failed", exc_info=True)

    if memory_blocks:
        msgs = memory_blocks + msgs

    # Identity grounding goes at the very top so the model reads "who am
    # I" before any skill brief, retrieval context, or thread history.
    # Prepending unconditionally is fine: identity is short, and prior
    # turns from a different model that confessed the wrong identity are
    # the exact reason this exists.
    identity = _identity_block(effective_model)
    if identity:
        msgs = [SystemMessage(content=identity)] + msgs

    # MCP-install guidance comes after identity so it can override generic
    # "cannot modify your system" refusals without weakening the model
    # grounding message.
    msgs = [SystemMessage(content=_mcp_install_policy_block())] + msgs
    install_guidance = _build_mcp_install_guidance(last_human_text)
    if install_guidance:
        msgs = [SystemMessage(content=install_guidance)] + msgs
    tool_status = _format_mcp_tool_status(
        ctx,
        last_human_text,
    )
    if tool_status:
        msgs = [SystemMessage(content=tool_status)] + msgs

    t0 = time.monotonic()
    reply = await llm.ainvoke(msgs)
    if isinstance(reply, AIMessage) and isinstance(reply.content, str):
        content = _repair_mcp_refusal_reply(reply.content, last_human)
        if not getattr(reply, "tool_calls", None):
            content = _repair_unexecuted_mcp_reply(content, last_human, ctx)
        if content != reply.content:
            reply = reply.model_copy(update={"content": content})
    duration_ms = int((time.monotonic() - t0) * 1000)

    # Best-effort token-usage telemetry. LangChain stores provider-reported
    # counts under .usage_metadata (input_tokens / output_tokens / total_tokens).
    # When the provider doesn't surface them, the row still records the call
    # with NULL counts so latency + model attribution are preserved.
    usage = getattr(reply, "usage_metadata", None) or {}
    await _log_chat_call(
        member_id=ctx.member_id,
        session_id=ctx.session_id,
        model=ctx.model,
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        total_tokens=usage.get("total_tokens"),
        duration_ms=duration_ms,
        retrieved_count=len(retrieved),
        had_tools=bool(ctx.tools),
        turn_seq=turn_seq if turn_seq >= 0 else None,
    )

    return {"messages": [reply]}


async def _log_chat_call(
    *,
    member_id: str | None,
    session_id: str | None,
    model: str | None,
    input_tokens: int | None,
    output_tokens: int | None,
    total_tokens: int | None,
    duration_ms: int,
    retrieved_count: int,
    had_tools: bool,
    turn_seq: int | None,
) -> None:
    """Insert a row into ``chat_calls`` (telemetry — never breaks the agent)."""
    if not session_id:
        return
    try:
        async with get_conn() as conn:
            await conn.execute(
                "INSERT INTO chat_calls "
                "(session_id, member_id, model, input_tokens, output_tokens, "
                " total_tokens, duration_ms, retrieved_count, had_tools, turn_seq) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    session_id,
                    member_id,
                    model or resolve_default_model(),
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    duration_ms,
                    retrieved_count,
                    had_tools,
                    turn_seq,
                ),
            )
            await conn.commit()
    except Exception:
        # Telemetry failures must never break the chat path — log for
        # observability but swallow the exception.
        log.warning("chat_calls write failed", exc_info=True)


async def _log_call(
    *,
    server_id: str | None,
    member_id: str | None,
    session_id: str | None,
    tool_name: str,
    arguments: dict,
    result_text: str | None,
    error: str | None,
    duration_ms: int,
) -> None:
    if not server_id:
        return  # unknown tool — nothing to attribute to
    try:
        async with get_conn() as conn:
            await conn.execute(
                "INSERT INTO mcp_call_logs "
                "(server_id, member_id, session_id, tool_name, arguments, "
                " result_summary, error, duration_ms) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    server_id,
                    member_id,
                    session_id,
                    tool_name,
                    Jsonb(_redact_arguments(arguments)),
                    (result_text[:_RESULT_SUMMARY_MAX] if result_text else None),
                    error,
                    duration_ms,
                ),
            )
            await conn.commit()
    except Exception:
        # Audit logging must never break the agent loop — log for
        # observability but swallow the exception.
        log.warning("mcp_call_logs write failed", exc_info=True)


async def _execute_tools(state: AgentState, config: RunnableConfig) -> dict:
    ctx = get_request_ctx()
    tools_by_name = {t.name: t for t in ctx.tools}

    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        return {}

    out_messages: list[ToolMessage] = []
    for tc in last.tool_calls:
        tool = tools_by_name.get(tc["name"])
        if not tool:
            out_messages.append(
                ToolMessage(
                    content=f"Unknown tool: {tc['name']}", tool_call_id=tc["id"]
                )
            )
            continue

        t0 = time.monotonic()
        result_text: str | None = None
        error: str | None = None
        try:
            result = await tool.ainvoke(tc["args"])
            result_text = str(result)
            out_messages.append(
                ToolMessage(content=result_text, tool_call_id=tc["id"])
            )
        except Exception as e:
            error = str(e)
            out_messages.append(
                ToolMessage(content=f"Tool error: {error}", tool_call_id=tc["id"])
            )
        duration_ms = int((time.monotonic() - t0) * 1000)

        await _log_call(
            server_id=ctx.tool_to_server_id.get(tc["name"]),
            member_id=ctx.member_id,
            session_id=ctx.session_id,
            tool_name=tc["name"],
            arguments=dict(tc["args"]),
            result_text=result_text,
            error=error,
            duration_ms=duration_ms,
        )

    return {"messages": out_messages}


def _route_after_model(state: AgentState) -> str:
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and getattr(last, "tool_calls", None):
        return "tools"
    return END


def build_graph(checkpointer: BaseCheckpointSaver | None = None):
    g = StateGraph(AgentState)
    g.add_node("retrieve", _retrieve)
    g.add_node("call_model", _call_model)
    g.add_node("tools", _execute_tools)
    g.add_edge(START, "retrieve")
    g.add_edge("retrieve", "call_model")
    g.add_conditional_edges(
        "call_model", _route_after_model, {"tools": "tools", END: END}
    )
    g.add_edge("tools", "call_model")
    return g.compile(checkpointer=checkpointer)
