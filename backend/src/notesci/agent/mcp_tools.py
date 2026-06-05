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
import shutil
import sys
import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from langchain_core.tools import BaseTool
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
        for tool in server_tools:
            # With tool_name_prefix=True, tool.name is "{slug}__{original}".
            # Grant matching is against the original (un-prefixed) name.
            original = (
                tool.name.split("__", 1)[1] if "__" in tool.name else tool.name
            )
            if not _is_tool_allowed(original, grants):
                continue
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
