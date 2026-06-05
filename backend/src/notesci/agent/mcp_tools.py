"""Load MCP tools for the active request's workspace.

Connects to each enabled ``mcp_servers`` row via
``langchain-mcp-adapters.MultiServerMCPClient``, fetches tools, filters
by the row's ``grants`` jsonb, and namespaces tool names so multiple
servers can expose tools with the same underlying name without
collisions.

Returns ``(tools, tool_name_to_server_id)`` so the agent's tool node can
attribute audit-log rows to the correct ``mcp_servers.id``.

Connection lifecycle: a fresh client is constructed per call. For the
invite-only beta this is acceptable — stdio servers spawn a subprocess
each time, http servers reconnect cheaply. We can introduce a workspace-
level cache if call latency becomes a problem.

Robustness: per-server connection failures are logged and skipped; the
agent still runs (without that server's tools) rather than failing the
whole turn.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sys
import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from langchain_core.tools import BaseTool, StructuredTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from ..crypto import decrypt_config_secrets

log = logging.getLogger(__name__)


# --- Cache --------------------------------------------------------------
# Workspace-keyed cache of (tools, tool_to_server). Invalidated by:
#   1. Signature change (any of slug/transport/config/grants changes)
#   2. TTL expiry (default 60s; protects against stale connections)
#   3. Explicit invalidate_workspace_cache(workspace_id) — called by the
#      /mcp/servers CRUD endpoints when servers are installed / updated /
#      uninstalled, so the next /chat sees the new state immediately.

_CACHE_TTL_SECONDS = 300.0
_CACHE_MAX_ENTRIES = 50


@dataclass
class _CachedTools:
    signature: str
    tools: list[BaseTool]
    tool_to_server: dict[str, str]
    load_errors: dict[str, str]
    fetched_at: float  # time.monotonic()


_cache: dict[str, _CachedTools] = {}
_cache_lock = asyncio.Lock()

_ZOTERO_KEY_RE = re.compile(r"^[A-Za-z0-9]{8}$")
_ZOTERO_KEY_PATTERNS = (
    re.compile(r"\*\*Key:\*\*\s*`?([A-Za-z0-9]{8})`?"),
    re.compile(r"\(Key:\s*([A-Za-z0-9]{8})\)"),
    re.compile(r"\bKey:\s*`?([A-Za-z0-9]{8})`?"),
)
_ZOTERO_COLLECTION_TREE_RE = re.compile(
    r"\*\*(?P<name>[^*]+)\*\*\s+\(Key:\s*(?P<key>[A-Za-z0-9]{8})\)"
)
_ZOTERO_COLLECTION_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?!\*\*)(?P<name>[^\n()]{1,180}?)"
    r"\s+\(Key:\s*(?P<key>[A-Za-z0-9]{8})\)",
    re.MULTILINE,
)
_ZOTERO_COLLECTION_SEARCH_RE = re.compile(
    r"##\s+\d+\.\s*(?P<name>[^\n]+)\s+\*\*Key:\*\*\s*`?(?P<key>[A-Za-z0-9]{8})`?"
)
_ZOTERO_COLLECTION_LOOSE_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*|[├└│─]+\s*)?(?!\*\*)"
    r"(?P<name>[^\n()]{1,180}?)\s*"
    r"(?:"
    r"\((?:Key:\s*)?`?(?P<key_a>[A-Za-z0-9]{8})`?\)"
    r"|[-–—]\s*(?:Key:\s*)?`?(?P<key_b>[A-Za-z0-9]{8})`?"
    r")",
    re.MULTILINE,
)


def _signature(rows: list) -> str:
    """Fingerprint of the workspace's enabled MCP servers.

    Uses the raw config dict (including any ``fernet:`` ciphertext) —
    we just need a change-detector so any rotation of a header value
    (which changes the ciphertext) invalidates the cache. ``enabled``
    and ``updated_at`` are folded in so an admin toggling a server off
    invalidates immediately even if config/grants didn't change.
    """
    parts = sorted(
        (
            slug,
            transport,
            json.dumps(cfg or {}, sort_keys=True),
            json.dumps(grants or {}, sort_keys=True),
            bool(enabled),
            updated_at.isoformat() if updated_at is not None else "",
        )
        for _, slug, transport, cfg, grants, enabled, updated_at in rows
    )
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()


async def invalidate_workspace_cache(workspace_id: UUID | str) -> None:
    """Drop the cached tools for ``workspace_id``.

    Called by /mcp/servers install / update / uninstall handlers so the
    next /chat picks up the new state without waiting for the TTL.
    """
    async with _cache_lock:
        _cache.pop(str(workspace_id), None)


async def _evict_if_needed() -> None:
    if len(_cache) > _CACHE_MAX_ENTRIES:
        oldest = min(_cache, key=lambda k: _cache[k].fetched_at)
        _cache.pop(oldest, None)
# ------------------------------------------------------------------------


def _windows_extra_path_entries() -> list[str]:
    """Common per-user launcher locations missing from icon-launched apps.

    Windows desktop apps started from Explorer often inherit a shorter PATH
    than an interactive terminal. MCP stdio servers commonly depend on
    launchers such as uvx.exe and npx.cmd in per-user directories, so we
    explicitly add those well-known locations before resolving commands.
    """
    if sys.platform != "win32":
        return []
    raw: list[Path] = []
    exe_dir = Path(sys.executable).resolve().parent
    raw.extend([exe_dir, exe_dir / "Scripts"])
    if appdata := os.environ.get("APPDATA"):
        raw.append(Path(appdata) / "npm")
    if localappdata := os.environ.get("LOCALAPPDATA"):
        programs = Path(localappdata) / "Programs" / "Python"
        if programs.is_dir():
            raw.extend(path / "Scripts" for path in programs.glob("Python*") if path.is_dir())
    if userprofile := os.environ.get("USERPROFILE"):
        home = Path(userprofile)
        raw.extend([home / ".local" / "bin", home / ".cargo" / "bin"])
    out: list[str] = []
    seen: set[str] = set()
    for path in raw:
        try:
            text = str(path)
        except OSError:
            continue
        key = text.lower()
        if key in seen or not path.is_dir():
            continue
        seen.add(key)
        out.append(text)
    return out


def _stdio_env(config_env: dict | None) -> dict[str, str]:
    env = {str(k): str(v) for k, v in os.environ.items()}
    if config_env:
        env.update({str(k): str(v) for k, v in config_env.items()})
    if sys.platform == "win32":
        path_parts = _windows_extra_path_entries()
        existing = env.get("PATH")
        if existing:
            path_parts.extend(existing.split(os.pathsep))
        seen: set[str] = set()
        merged: list[str] = []
        for part in path_parts:
            part = part.strip()
            if not part:
                continue
            key = part.lower()
            if key in seen:
                continue
            seen.add(key)
            merged.append(part)
        if merged:
            env["PATH"] = os.pathsep.join(merged)
    return env


def _resolve_stdio_command(command: str, args: list[str], env: dict[str, str]) -> tuple[str, list[str]]:
    command = command.strip()
    if not command:
        raise ValueError("stdio transport requires config.command")

    # Explicit paths are respected; bare names are resolved to real .exe/.cmd
    # paths so Windows CreateProcess does not fail with WinError 2.
    if "/" in command or "\\" in command:
        return command, args

    resolved = shutil.which(command, path=env.get("PATH"))
    if resolved:
        return resolved, args

    if sys.platform == "win32" and command.lower() == "uvx":
        resolved_uv = shutil.which("uv", path=env.get("PATH"))
        if resolved_uv:
            return resolved_uv, ["tool", "run", *args]
        if importlib.util.find_spec("uv") is not None:
            return sys.executable, ["-m", "uv", "tool", "run", *args]

    hint = (
        "Install uv (for uvx-based MCP servers) or Node.js (for npx-based "
        "MCP servers), then restart notesci so the desktop app inherits PATH."
    )
    raise ValueError(f"stdio command {command!r} was not found. {hint}")


def _build_connection(transport: str, config: dict) -> dict[str, Any]:
    """Translate our ``mcp_servers.transport`` + ``config`` jsonb into a
    langchain-mcp-adapters connection dict.

    Raises ``ValueError`` if the row is missing required fields — caller
    skips the server with a warning.
    """
    if transport == "http":
        # In our schema "http" means the modern Streamable HTTP transport.
        url = config.get("url")
        if not url:
            raise ValueError("http transport requires config.url")
        out: dict[str, Any] = {"transport": "streamable_http", "url": url}
        if config.get("headers"):
            out["headers"] = config["headers"]
        return out
    if transport == "sse":
        url = config.get("url")
        if not url:
            raise ValueError("sse transport requires config.url")
        out = {"transport": "sse", "url": url}
        if config.get("headers"):
            out["headers"] = config["headers"]
        return out
    if transport == "stdio":
        command = config.get("command")
        if not command:
            raise ValueError("stdio transport requires config.command")
        args = list(config.get("args") or [])
        env = _stdio_env(config.get("env") if isinstance(config.get("env"), dict) else None)
        command, args = _resolve_stdio_command(str(command), args, env)
        out = {
            "transport": "stdio",
            "command": command,
            "args": args,
            "env": env,
        }
        if config.get("cwd"):
            out["cwd"] = config["cwd"]
        return out
    raise ValueError(f"unknown transport: {transport!r}")


def _is_tool_allowed(tool_name: str, grants: dict | None) -> bool:
    """Match a tool against the workspace's grants for its server.

    Grant shape (from the dashboard install modal):
      ``{"tools": [...], "allowAll": bool, "deniedTools": [...]}``

    deniedTools always wins. allowAll trumps tools-allowlist. If neither
    allowAll nor an allowed list is set, nothing is exposed (fail-closed).
    """
    if not grants:
        # Backward compatibility: older installations in the field could
        # ship an empty grants blob, which should behave like
        # unrestricted default access rather than "all denied".
        return True
    if tool_name in (grants.get("deniedTools") or []):
        return False
    if grants.get("allowAll"):
        return True
    if "allowAll" not in grants:
        # Missing allowAll is equivalent to no restriction in the legacy
        # shape; this preserves behavior for installs created before
        # grants were explicitly captured.
        return True
    return tool_name in (grants.get("tools") or [])


async def _invoke_mcp_tool(tool: BaseTool, args: dict[str, Any]) -> Any:
    """Invoke a LangChain MCP tool with a dict payload."""
    return await tool.ainvoke(args)


def _tool_arg_names(tool: BaseTool) -> set[str]:
    args = getattr(tool, "args", None)
    if isinstance(args, dict):
        return {str(key) for key in args}
    schema = getattr(tool, "args_schema", None)
    fields = getattr(schema, "model_fields", None)
    if isinstance(fields, dict):
        return {str(key) for key in fields}
    fields = getattr(schema, "__fields__", None)
    if isinstance(fields, dict):
        return {str(key) for key in fields}
    return set()


def _extract_zotero_collection_key(text: object) -> str | None:
    raw = str(text or "")
    for pattern in _ZOTERO_KEY_PATTERNS:
        match = pattern.search(raw)
        if match:
            return match.group(1).upper()
    return None


def _extract_zotero_collection_keys(text: object) -> list[str]:
    raw = str(text or "")
    keys: list[str] = []
    seen: set[str] = set()
    for pattern in _ZOTERO_KEY_PATTERNS:
        for match in pattern.finditer(raw):
            key = match.group(1).upper()
            if key in seen:
                continue
            seen.add(key)
            keys.append(key)
    return keys


def _normalize_zotero_collection_name(text: str) -> str:
    return " ".join(str(text or "").casefold().split())


def _zotero_match_name_key(match: re.Match[str]) -> tuple[str, str] | None:
    groups = match.groupdict()
    key = groups.get("key") or groups.get("key_a") or groups.get("key_b")
    name = groups.get("name")
    if not key or not name:
        return None
    return name.strip(), key.upper()


def _unique_zotero_collection_pairs(
    matches: list[re.Match[str]],
) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for match in matches:
        pair = _zotero_match_name_key(match)
        if pair is None or pair in seen:
            continue
        seen.add(pair)
        out.append(pair)
    return out


def _zotero_collection_tree_entries(text: object) -> list[tuple[int, str, str]]:
    entries: list[tuple[int, str, str]] = []
    for line in str(text or "").splitlines():
        matches = [
            *_ZOTERO_COLLECTION_TREE_RE.finditer(line),
            *_ZOTERO_COLLECTION_LINE_RE.finditer(line),
            *_ZOTERO_COLLECTION_LOOSE_LINE_RE.finditer(line),
        ]
        pair = next((p for p in (_zotero_match_name_key(m) for m in matches) if p), None)
        if pair is None:
            continue
        name, key = pair
        # Leading spaces are enough for the current 54yyyu/zotero-mcp
        # markdown tree. Preserve this as an integer depth so parent
        # collections can fall back to child collections when Zotero has
        # only subcollection items.
        indent = len(line) - len(line.lstrip(" \t"))
        entries.append((indent, name, key))
    return entries


def _zotero_descendant_collections(
    collection_tree: object,
    parent_key: str,
    *,
    limit: int = 12,
) -> list[tuple[str, str]]:
    entries = _zotero_collection_tree_entries(collection_tree)
    for idx, (indent, _name, key) in enumerate(entries):
        if key != parent_key.upper():
            continue
        descendants: list[tuple[str, str]] = []
        seen: set[str] = set()
        for child_indent, child_name, child_key in entries[idx + 1 :]:
            if child_indent <= indent:
                break
            if child_key in seen:
                continue
            seen.add(child_key)
            descendants.append((child_name, child_key))
            if len(descendants) >= limit:
                break
        return descendants
    return []


def _zotero_collection_matches_for_name(
    text: object,
    collection_name: str,
) -> list[tuple[str, str]]:
    wanted = _normalize_zotero_collection_name(collection_name)
    if not wanted:
        return []
    raw = str(text or "")
    matches = [
        *_ZOTERO_COLLECTION_TREE_RE.finditer(raw),
        *_ZOTERO_COLLECTION_LINE_RE.finditer(raw),
        *_ZOTERO_COLLECTION_LOOSE_LINE_RE.finditer(raw),
    ]
    pairs = _unique_zotero_collection_pairs(matches)
    exact = [
        (name, key)
        for name, key in pairs
        if _normalize_zotero_collection_name(name) == wanted
    ]
    if exact:
        return exact
    return [
        (name, key)
        for name, key in pairs
        if (
            wanted in _normalize_zotero_collection_name(name)
            or _normalize_zotero_collection_name(name) in wanted
        )
    ]


def _zotero_collection_search_matches_for_name(
    text: object,
    collection_name: str,
) -> list[tuple[str, str]]:
    wanted = _normalize_zotero_collection_name(collection_name)
    if not wanted:
        return []
    matches = list(_ZOTERO_COLLECTION_SEARCH_RE.finditer(str(text or "")))
    exact = [
        (match.group("name").strip(), match.group("key").upper())
        for match in matches
        if _normalize_zotero_collection_name(match.group("name")) == wanted
    ]
    if exact:
        return exact
    partial = [
        (match.group("name").strip(), match.group("key").upper())
        for match in matches
        if (
            wanted in _normalize_zotero_collection_name(match.group("name"))
            or _normalize_zotero_collection_name(match.group("name")) in wanted
        )
    ]
    return partial or [
        (match.group("name").strip(), match.group("key").upper())
        for match in matches
    ]


def _zotero_collection_key_arg_name(tool: BaseTool) -> str:
    arg_names = _tool_arg_names(tool)
    for candidate in (
        "collection_key",
        "collectionKey",
        "collection_id",
        "collectionId",
        "key",
        "id",
    ):
        if candidate in arg_names:
            return candidate
    return "collection_key"


def _zotero_bool(value: object, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"0", "false", "no", "off"}:
            return False
        if normalized in {"1", "true", "yes", "on"}:
            return True
    return bool(value)


def _zotero_positive_int(value: object, *, default: int, minimum: int = 1, maximum: int = 100) -> int:
    try:
        parsed = int(str(value).strip())
    except Exception:
        parsed = default
    return max(minimum, min(maximum, parsed))


def _zotero_collection_items_empty(result: object) -> bool:
    if result is None:
        return True
    text_blocks = _zotero_text_block_payload(result)
    if text_blocks is not None:
        return _zotero_collection_items_empty(text_blocks)
    if isinstance(result, (list, tuple, set, frozenset)):
        if len(result) == 0:
            return True
        if all(isinstance(item, str) for item in result):
            return _zotero_collection_items_empty("\n\n".join(result))
        return False
    if isinstance(result, dict):
        if not result:
            return True
        for key in ("items", "results", "data", "entries"):
            value = result.get(key)
            if isinstance(value, (list, tuple, set, frozenset)):
                if len(value) == 0:
                    return True
                value_text_blocks = _zotero_text_block_payload(list(value))
                if value_text_blocks is not None:
                    return _zotero_collection_items_empty(value_text_blocks)
                if all(isinstance(item, str) for item in value):
                    return _zotero_collection_items_empty("\n\n".join(value))
        for key in ("total", "count", "num_items"):
            if key not in result:
                continue
            total = result.get(key)
            if total == 0 or total == "0":
                return True
    text = _normalize_zotero_collection_name(str(result or ""))
    if not text:
        return True
    return (
        text in {"[]", "{}", "no items", "0 items"}
        or "no items found in collection" in text
        or "no items in collection" in text
        or "no items found" == text
        or text.startswith("no items found ")
        or text.startswith("0 items ")
        or " 0 items" in text
    )


def _zotero_text_block_payload(result: object) -> str | None:
    blocks: list[object] | None = None
    if isinstance(result, list):
        blocks = result
    elif isinstance(result, dict):
        for key in ("content", "blocks"):
            value = result.get(key)
            if isinstance(value, list):
                blocks = value
                break
    if not blocks:
        return None

    texts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            return None
        block_type = str(block.get("type") or "").casefold()
        if block_type not in {"text", "markdown", ""}:
            return None
        text = block.get("text") or block.get("content")
        if text not in (None, ""):
            texts.append(str(text))
    if not texts:
        return None
    return "\n\n".join(texts)


def _zotero_structured_items(result: object) -> list[object] | None:
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("items", "results", "data", "entries"):
            value = result.get(key)
            if isinstance(value, list):
                return value
        nested = result.get("data")
        if isinstance(nested, dict):
            for key in ("title", "itemType", "DOI", "url", "key"):
                if key in nested:
                    return [result]
        for key in ("title", "itemType", "DOI", "url", "key"):
            if key in result:
                return [result]
    return None


def _zotero_item_value(item: object, *keys: str) -> object:
    if not isinstance(item, dict):
        return None
    sources: list[dict[str, Any]] = [item]
    nested = item.get("data")
    if isinstance(nested, dict):
        sources.append(nested)
    for source in sources:
        for key in keys:
            value = source.get(key)
            if value not in (None, ""):
                return value
    return None


def _zotero_creator_names(creators: object) -> str:
    if not isinstance(creators, list):
        return ""
    names: list[str] = []
    for creator in creators[:4]:
        if not isinstance(creator, dict):
            continue
        name = creator.get("name")
        if not name:
            first = str(creator.get("firstName") or "").strip()
            last = str(creator.get("lastName") or "").strip()
            name = " ".join(part for part in (first, last) if part)
        if name:
            names.append(str(name))
    if len(creators) > 4:
        names.append("et al.")
    return ", ".join(names)


def _zotero_item_summary(item: object, index: int) -> str:
    if not isinstance(item, dict):
        text = str(item).strip() or "Untitled Zotero item"
        return f"## {index}. {text}"

    title = _zotero_item_value(item, "title", "shortTitle") or "Untitled Zotero item"
    item_type = _zotero_item_value(item, "itemType", "type")
    date = _zotero_item_value(item, "date", "year", "publicationYear")
    key = _zotero_item_value(item, "key", "itemKey")
    doi = _zotero_item_value(item, "DOI", "doi")
    url = _zotero_item_value(item, "url", "URL")
    creators = _zotero_creator_names(_zotero_item_value(item, "creators"))

    lines = [f"## {index}. {title}"]
    meta = []
    if creators:
        meta.append(str(creators))
    if date:
        meta.append(str(date))
    if item_type:
        meta.append(str(item_type))
    if meta:
        lines.append(f"- Metadata: {'; '.join(meta)}")
    if doi:
        lines.append(f"- DOI: {doi}")
    if url:
        lines.append(f"- URL: {url}")
    if key:
        lines.append(f"- Zotero key: {key}")
    return "\n".join(lines)


def _zotero_json_dump(result: object, *, max_chars: int = 24000) -> str:
    try:
        raw = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    except Exception:
        raw = str(result)
    if len(raw) <= max_chars:
        return raw
    return (
        raw[:max_chars]
        + f"\n... raw Zotero payload truncated by Notesci; {len(raw) - max_chars} characters omitted."
    )


def _zotero_format_tool_result(result: object) -> str:
    if isinstance(result, str):
        return result
    text_blocks = _zotero_text_block_payload(result)
    if text_blocks is not None:
        return text_blocks
    items = _zotero_structured_items(result)
    if items:
        summaries = "\n\n".join(
            _zotero_item_summary(item, idx)
            for idx, item in enumerate(items[:50], start=1)
        )
        if len(items) > 50:
            summaries += f"\n\n... {len(items) - 50} more Zotero items omitted from summary."
        raw = _zotero_json_dump(result)
        return f"{summaries}\n\n```json\n{raw}\n```"
    return _zotero_json_dump(result)


async def _resolve_zotero_collection_key(
    collection_ref: str,
    search_tool: BaseTool | None,
    collections_tool: BaseTool | None,
) -> tuple[str | None, str | None]:
    """Resolve a user-facing Zotero collection name to its 8-char key.

    Upstream ``zotero_get_collection_items`` requires ``collection_key``.
    Models often pass the visible collection name instead, especially on
    Windows real-machine sessions where the user asks for a named collection.
    Resolve the name in Notesci before the raw MCP server sees the call.
    """
    candidate = str(collection_ref or "").strip()
    if not candidate:
        return None, "No collection name or key was provided."
    if _ZOTERO_KEY_RE.fullmatch(candidate):
        return candidate.upper(), None

    if collections_tool is not None:
        try:
            payload: dict[str, Any] = {}
            if "limit" in _tool_arg_names(collections_tool):
                payload["limit"] = 5000
            result = await _invoke_mcp_tool(collections_tool, payload)
            matches = _zotero_collection_matches_for_name(result, candidate)
            if len(matches) == 1:
                return matches[0][1], None
            if len(matches) > 1:
                shown = ", ".join(f"{name} ({key})" for name, key in matches[:8])
                return None, (
                    f"Multiple Zotero collections match {candidate!r}: {shown}. "
                    "Copy one of these keys and retry with the exact "
                    "8-character collection_key."
                )
        except Exception as exc:
            log.warning("zotero collection listing failed for %r: %s", candidate, exc)

    if search_tool is not None:
        try:
            result = await _invoke_mcp_tool(search_tool, {"query": candidate})
            matches = _zotero_collection_search_matches_for_name(result, candidate)
            if len(matches) == 1:
                return matches[0][1], None
            if len(matches) > 1:
                shown = ", ".join(f"{name} ({key})" for name, key in matches[:8])
                return None, (
                    f"Multiple Zotero collections match {candidate!r}: {shown}. "
                    "Copy one of these keys and retry with the exact "
                    "8-character collection_key."
                )
            fallback_keys = _extract_zotero_collection_keys(result)
            if len(fallback_keys) == 1:
                return fallback_keys[0], None
            if len(fallback_keys) > 1:
                shown = ", ".join(fallback_keys[:8])
                return None, (
                    f"Multiple Zotero collection keys were returned for {candidate!r}: "
                    f"{shown}. Copy one of these keys and retry with the exact "
                    "8-character collection_key."
                )
            return None, (
                f"Could not resolve Zotero collection {candidate!r} to an "
                "8-character key. Use zotero_get_collections to inspect the "
                "available collections and retry with the displayed key."
            )
        except Exception as exc:
            log.warning("zotero collection search failed for %r: %s", candidate, exc)

    return None, (
        f"Could not resolve Zotero collection {candidate!r}. First call "
        "zotero_get_collections or zotero_search_collections and use the "
        "8-character collection key shown in the result."
    )


def _wrap_zotero_collection_items_tool(
    tool: BaseTool,
    search_tool: BaseTool | None,
    collections_tool: BaseTool | None,
) -> BaseTool:
    """Accept collection names for Zotero collection-item browsing.

    The upstream MCP tool is intentionally key-based. This wrapper keeps the
    same exposed tool name but makes Notesci more forgiving by resolving a
    human-readable collection name to the Zotero key first.
    """

    async def zotero_get_collection_items(
        collection_key: str = "",
        collection_name: str | None = None,
        collection: str | None = None,
        key: str | None = None,
        collection_id: str | None = None,
        collectionId: str | None = None,
        name: str | None = None,
        title: str | None = None,
        query: str | None = None,
        detail: str = "summary",
        limit: int | str | None = 50,
        include_subcollections: bool | str = True,
        max_child_collections: int | str | None = 25,
    ) -> str:
        collection_ref = (
            collection_key
            or collection_name
            or collection
            or key
            or collection_id
            or collectionId
            or name
            or title
            or query
            or ""
        )
        resolved_key, error = await _resolve_zotero_collection_key(
            collection_ref,
            search_tool,
            collections_tool,
        )
        if not resolved_key:
            return error or "Could not resolve Zotero collection key."
        upstream_args = _tool_arg_names(tool)
        key_arg = _zotero_collection_key_arg_name(tool)
        payload: dict[str, Any] = {key_arg: resolved_key}
        if "detail" in upstream_args:
            payload["detail"] = detail
        if "limit" in upstream_args:
            payload["limit"] = limit
        result = await _invoke_mcp_tool(
            tool,
            payload,
        )
        if (
            not _zotero_collection_items_empty(result)
            or not _zotero_bool(include_subcollections)
            or collections_tool is None
        ):
            return _zotero_format_tool_result(result)

        collection_payload: dict[str, Any] = {}
        if "limit" in _tool_arg_names(collections_tool):
            collection_payload["limit"] = 5000
        try:
            collection_tree = await _invoke_mcp_tool(collections_tool, collection_payload)
        except Exception as exc:
            log.warning("zotero child collection lookup failed for %s: %s", resolved_key, exc)
            return result

        descendants = _zotero_descendant_collections(collection_tree, resolved_key)
        if not descendants:
            return _zotero_format_tool_result(result)
        child_scan_limit = _zotero_positive_int(
            max_child_collections,
            default=25,
            minimum=1,
            maximum=100,
        )
        scanned_descendants = descendants[:child_scan_limit]

        child_outputs: list[str] = []
        for child_name, child_key in scanned_descendants:
            child_payload: dict[str, Any] = {key_arg: child_key}
            if "detail" in upstream_args:
                child_payload["detail"] = detail
            if "limit" in upstream_args:
                child_payload["limit"] = limit
            try:
                child_result = await _invoke_mcp_tool(tool, child_payload)
            except Exception as exc:
                child_outputs.append(
                    f"## Child collection: {child_name} (Key: {child_key})\n"
                    f"Error fetching child collection items: {exc}"
                )
                continue
            if _zotero_collection_items_empty(child_result):
                continue
            child_outputs.append(
                f"## Child collection: {child_name} (Key: {child_key})\n\n"
                f"{_zotero_format_tool_result(child_result)}"
            )

        if not child_outputs:
            checked = "\n".join(
                f"- {child_name} (Key: {child_key})"
                for child_name, child_key in scanned_descendants
            )
            return "\n\n".join(
                [
                    _zotero_format_tool_result(result),
                    "## Child collections checked",
                    checked,
                    (
                        "No direct items were returned from the parent or checked "
                        "child collections. Ask for a specific child collection key "
                        "to browse deeper."
                    ),
                ]
            )
        omitted = len(descendants) - len(scanned_descendants)
        if omitted > 0:
            child_outputs.append(
                f"Skipped {omitted} additional child collections. "
                "Ask for a specific child collection to browse deeper."
            )
        return "\n\n".join(
            [
                _zotero_format_tool_result(result),
                "## Items found in child collections",
                *child_outputs,
            ]
        )

    description = (
        f"{getattr(tool, 'description', '') or ''}\n\n"
        "Notesci accepts either the 8-character Zotero collection key or a "
        "human-readable collection name. Prefer collection_key when the key "
        "is known; otherwise pass the visible collection name as "
        "collection_name, collection, query, name, or title. collection_key, "
        "key, collection_id, and collectionId are accepted key aliases. "
        "Notesci resolves names before fetching items. If multiple collections match the name, "
        "copy one of the returned keys and retry with the exact 8-character "
        "collection_key. Parent collections are expanded to child collections "
        "when the parent has no direct items. Set include_subcollections=false "
        "to disable parent expansion. Set max_child_collections to bound scans "
        "in large Zotero libraries. Structured Zotero item payloads are "
        "summarized before raw JSON so titles, creators, dates, DOI, URLs, "
        "and Zotero keys are visible to the model."
    ).strip()
    return StructuredTool.from_function(
        coroutine=zotero_get_collection_items,
        name=tool.name,
        description=description,
        return_direct=getattr(tool, "return_direct", False),
    )


def _harden_zotero_tools(tools: list[BaseTool]) -> list[BaseTool]:
    by_original: dict[str, BaseTool] = {}
    for tool in tools:
        original = tool.name.split("__", 1)[1] if "__" in tool.name else tool.name
        by_original[original] = tool

    collection_items = by_original.get("zotero_get_collection_items")
    if collection_items is None:
        return tools

    wrapped_collection_items = _wrap_zotero_collection_items_tool(
        collection_items,
        by_original.get("zotero_search_collections"),
        by_original.get("zotero_get_collections"),
    )
    return [
        wrapped_collection_items if tool is collection_items else tool
        for tool in tools
    ]


async def load_workspace_mcp_tools(
    conn: psycopg.AsyncConnection,
    workspace_id: UUID,
    requested_slugs: set[str] | None = None,
) -> tuple[list[BaseTool], dict[str, str], dict[str, str]]:
    """Return enabled MCP tools for ``workspace_id`` and their owning server ids.

    Cache-aware: hits the in-process cache when the signature of enabled
    servers + grants is unchanged and the entry is within TTL. The DB query
    is always executed (it's cheap and gives us the freshest signature).
    """
    cur = await conn.execute(
        "SELECT id, slug, transport, config, grants, enabled, updated_at "
        "FROM mcp_servers WHERE workspace_id=%s AND enabled=true",
        (workspace_id,),
    )
    rows = await cur.fetchall()
    if requested_slugs is not None:
        wanted = {slug.lower() for slug in requested_slugs}
        rows = [row for row in rows if str(row[1]).lower() in wanted]

    cache_key = str(workspace_id)
    if requested_slugs is not None:
        cache_key = f"{cache_key}:{','.join(sorted(slug.lower() for slug in requested_slugs))}"
    if not rows:
        # Drop any stale cache entry for this workspace.
        async with _cache_lock:
            _cache.pop(cache_key, None)
        return [], {}, {}

    sig = _signature(rows)
    now = time.monotonic()
    async with _cache_lock:
        cached = _cache.get(cache_key)
        if (
            cached is not None
            and cached.signature == sig
            and (now - cached.fetched_at) < _CACHE_TTL_SECONDS
        ):
            return list(cached.tools), dict(cached.tool_to_server), dict(cached.load_errors)

    connections: dict[str, dict[str, Any]] = {}
    grants_by_slug: dict[str, dict] = {}
    server_id_by_slug: dict[str, str] = {}
    load_errors: dict[str, str] = {}
    for row in rows:
        # _signature() also reads the trailing columns; we only need the
        # first five for the connection build.
        sid, slug, transport, cfg, grants = row[0], row[1], row[2], row[3], row[4]
        # Decrypt headers / env in-place before handing the config to the
        # MCP client. Legacy plaintext rows pass through unchanged.
        runtime_cfg = decrypt_config_secrets(cfg or {})
        if str(slug).lower() == "obsidian":
            api_key = (runtime_cfg.get("env") or {}).get("OBSIDIAN_API_KEY")
            if not api_key or str(api_key).strip() in {"", "***"}:
                message = (
                    "OBSIDIAN_API_KEY is missing. Install and enable Obsidian's "
                    "Local REST API plugin, then paste its API key in Settings -> "
                    "MCP servers -> Obsidian -> Configure. The community server "
                    "runs as `uvx mcp-obsidian` and also supports OBSIDIAN_HOST "
                    "and OBSIDIAN_PORT."
                )
                log.warning("skipping MCP server %s (%s): %s", slug, transport, message)
                load_errors[str(slug)] = message
                continue
        try:
            connections[slug] = _build_connection(transport, runtime_cfg)
        except ValueError as e:
            log.warning(
                "skipping MCP server %s (%s): %s", slug, transport, e
            )
            load_errors[str(slug)] = str(e)
            continue
        grants_by_slug[slug] = grants or {}
        server_id_by_slug[slug] = str(sid)

    if not connections:
        return [], {}, load_errors

    # tool_name_prefix=True namespaces tools as "{slug}__{toolname}". This is
    # critical: multiple servers can expose tools called "search" or "read",
    # and the LLM sees them as distinct callable names.
    client = MultiServerMCPClient(connections, tool_name_prefix=True)

    out_tools: list[BaseTool] = []
    tool_to_server: dict[str, str] = {}

    for slug, server_id in server_id_by_slug.items():
        try:
            server_tools = await client.get_tools(server_name=slug)
        except Exception as e:
            log.warning("failed to load tools from MCP server %s: %s", slug, e)
            load_errors[str(slug)] = str(e)
            continue
        grants = grants_by_slug.get(slug, {})
        allowed_tools: list[BaseTool] = []
        for tool in server_tools:
            # With tool_name_prefix=True, tool.name is "{slug}__{original}".
            # Grant matching is against the original (un-prefixed) name.
            original = (
                tool.name.split("__", 1)[1] if "__" in tool.name else tool.name
            )
            if not _is_tool_allowed(original, grants):
                continue
            allowed_tools.append(tool)
        if str(slug).lower() == "zotero":
            allowed_tools = _harden_zotero_tools(allowed_tools)
        for tool in allowed_tools:
            out_tools.append(tool)
            tool_to_server[tool.name] = server_id

    async with _cache_lock:
        _cache[cache_key] = _CachedTools(
            signature=sig,
            tools=out_tools,
            tool_to_server=tool_to_server,
            load_errors=load_errors,
            fetched_at=now,
        )
        await _evict_if_needed()

    return out_tools, tool_to_server, load_errors
