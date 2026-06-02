"""Load user-authored MCP recipes from ``~/.config/notesci/mcps/``.

Each recipe is a folder containing ``mcp.toml`` describing how to
launch the MCP server. The user's *install* of an MCP (which servers
are enabled, granted tools, encrypted API keys) lives in Postgres'
``mcp_servers`` table; this loader only adds entries to the **catalog**
(the menu the install flow draws from).

PLAINTEXT SECRETS in ``mcp.toml`` are rejected — the recipe may *name*
required secrets (`[secrets] required = […]`), but actual values must
go through the encrypted-DB path. Anything that looks like a key
(env var assigned a long opaque value, or a key shaped like
``sk-…``/``api_key=…``) gets flagged and the recipe is rejected.

Failure isolation: a malformed recipe logs a warning and is skipped;
the loader never raises.
"""

from __future__ import annotations

import logging
import re
import tomllib
from pathlib import Path
from typing import Iterator

from .mcp_catalog import CatalogEntry, CatalogField, _allow_all, _source_fields_from_config

log = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")

_VALID_CATEGORIES = (
    "Featured", "Research", "Writing", "Data",
    "Productivity", "Code", "Web", "Lab tools",
)
_VALID_TRANSPORTS = ("http", "stdio", "sse")

# Heuristic secret detector — flags values that look like a token/key.
# Pattern: 16+ chars of mostly URL-safe alphabet (base64ish), or known
# vendor prefixes. False positives are acceptable: the cost of refusing
# a long opaque test value is one config edit, while the cost of
# accepting a real key is silent disk leakage.
_SECRET_VALUE_RE = re.compile(
    r"^("
    r"sk-[A-Za-z0-9_\-]{20,}"            # OpenAI-style
    r"|claude-[A-Za-z0-9_\-]{20,}"       # Anthropic-style
    r"|sk_live_[A-Za-z0-9]{20,}"         # Stripe-style
    r"|gho_[A-Za-z0-9]{20,}"             # GitHub OAuth-style
    r"|[A-Za-z0-9_\-]{40,}"              # generic long opaque blob
    r")$"
)
_SECRET_KEY_HINTS = ("token", "key", "secret", "password", "passwd", "api_key")


def _value_looks_like_secret(key: str, value: str) -> bool:
    """Return True if ``(key, value)`` smells like a plaintext secret."""
    k = key.lower()
    if any(hint in k for hint in _SECRET_KEY_HINTS):
        # The key NAME implies a secret. The value might be a port number,
        # an empty string, or "${OPENAI_API_KEY}" (a reference, not a
        # value). Only flag when the value also has secret-y entropy.
        v = value.strip()
        if v.startswith("${") and v.endswith("}"):
            return False
        if len(v) >= 16 and _SECRET_VALUE_RE.match(v):
            return True
    return False


def _load_one(mcp_dir: Path) -> CatalogEntry | None:
    """Parse one ``<mcp-dir>/mcp.toml`` into a CatalogEntry. None on error."""
    toml_path = mcp_dir / "mcp.toml"
    if not toml_path.is_file():
        return None

    try:
        meta = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        log.warning("mcp %s: mcp.toml parse failed: %s", mcp_dir.name, exc)
        return None

    entry_id = str(meta.get("id") or "").strip()
    if not entry_id or not _SLUG_RE.match(entry_id):
        log.warning(
            "mcp %s: invalid or missing 'id' (must be lowercase slug)",
            mcp_dir.name,
        )
        return None
    if entry_id != mcp_dir.name:
        log.warning(
            "mcp %s: id=%r doesn't match directory; using directory name",
            mcp_dir.name, entry_id,
        )
        entry_id = mcp_dir.name

    name = str(meta.get("name") or entry_id).strip()
    description = str(meta.get("description") or "").strip()
    author = str(meta.get("author") or "user").strip()
    category = str(meta.get("category") or "Productivity").strip()
    if category not in _VALID_CATEGORIES:
        log.warning(
            "mcp %s: invalid category %r — defaulting to 'Productivity'",
            entry_id, category,
        )
        category = "Productivity"

    transport = str(meta.get("transport") or "stdio").lower().strip()
    if transport not in _VALID_TRANSPORTS:
        log.warning("mcp %s: invalid transport %r", entry_id, transport)
        return None

    # Build the transport config dict in the same shape the built-in
    # CATALOG uses, so the install flow doesn't have to special-case
    # user recipes downstream.
    config: dict = {}
    if transport == "stdio":
        cmd = meta.get("command")
        if not cmd or not isinstance(cmd, str):
            log.warning("mcp %s: stdio transport requires 'command'", entry_id)
            return None
        args = meta.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            log.warning("mcp %s: 'args' must be a list of strings", entry_id)
            return None
        config = {"command": cmd, "args": list(args)}
    elif transport in ("http", "sse"):
        url = meta.get("url")
        if not url or not isinstance(url, str):
            log.warning("mcp %s: %s transport requires 'url'", entry_id, transport)
            return None
        config = {"url": url}

    env = meta.get("env") or {}
    if not isinstance(env, dict):
        log.warning("mcp %s: 'env' must be a table", entry_id)
        return None
    # Reject plaintext secrets in env vars.
    for k, v in env.items():
        if not isinstance(v, (str, int, float, bool)):
            log.warning("mcp %s: env[%r] must be a scalar; skipping recipe", entry_id, k)
            return None
        sv = str(v)
        if _value_looks_like_secret(str(k), sv):
            log.warning(
                "mcp %s: env[%r] looks like a plaintext secret — recipes must "
                "NOT contain secrets. Move it to the encrypted DB column via "
                "Settings → MCP. Recipe rejected.",
                entry_id, k,
            )
            return None
    config["env"] = {str(k): str(v) for k, v in env.items()}

    # Required-secret names go on the entry for the install UI to render
    # a "you need to set N secrets" hint. The names are not secrets; the
    # values are.
    secrets_block = meta.get("secrets") or {}
    required_secrets: list[str] = []
    if isinstance(secrets_block, dict):
        names = secrets_block.get("required") or []
        if isinstance(names, list):
            required_secrets = [str(s) for s in names if isinstance(s, str)]

    source_fields: tuple[CatalogField, ...] = _source_fields_from_config(
        config,
        required_secrets=required_secrets,
    )
    if "required_secrets" in config:
        del config["required_secrets"]

    show_in_sources = bool(source_fields)

    return CatalogEntry(
        id=entry_id,
        name=name,
        category=category,  # type: ignore[arg-type]
        author=author,
        description=description,
        rating=0.0,
        installs="custom",
        featured=False,
        official=False,
        available=True,
        icon="",
        disclaimer="",
        transport=transport,  # type: ignore[arg-type]
        config=config,
        default_grants=_allow_all(),
        show_in_sources=show_in_sources,
        source_fields=source_fields,
    )


def load_mcps_from_dir(root: Path) -> Iterator[CatalogEntry]:
    """Yield ``CatalogEntry`` instances for every valid recipe under
    ``root``. Lexical iteration order for deterministic merging."""
    if not root.is_dir():
        return
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        entry = _load_one(child)
        if entry is not None:
            log.info("loaded user MCP recipe: %s", entry.id)
            yield entry
