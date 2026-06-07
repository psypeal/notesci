import contextvars
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path as _Path
import re
import secrets
import sys
import time
import uuid
from collections import defaultdict
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID
from urllib.parse import quote, quote_plus, urlparse

# Defensive fallback for non-desktop launchers. The bundled desktop app
# normally enters through notesci.serve, which sets this before uvicorn
# creates the loop. Keeping the guard here protects direct imports on
# Windows where no event loop has been created yet.
if sys.platform == "win32":
    policy_cls = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if policy_cls is not None:
        asyncio.set_event_loop_policy(policy_cls())


def _ensure_psycopg_compatible_event_loop() -> None:
    if sys.platform != "win32":
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if "Proactor" in type(loop).__name__:
        raise RuntimeError(
            "notesci backend is running on Windows ProactorEventLoop, which "
            "psycopg cannot use for async connections. Launch the backend via "
            "`python -m notesci.serve` so the selector event-loop policy is "
            "installed before uvicorn starts."
        )


import psycopg

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

# Request-id contextvar — populated by RequestIdMiddleware. Read by the
# logging Formatter (set up below) so every log line carries the id of
# the in-flight request. Falls back to ``"-"`` outside the request scope.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default="-"
)


class _RequestIdLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get("-")
        return True


# Standard LogRecord attributes — anything else on the record is treated
# as an "extra" by the JSON formatter and merged into the output dict.
_LOGRECORD_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "asctime", "taskName",
}


class _JsonFormatter(logging.Formatter):
    """Emit each log line as a single JSON object.

    Includes ``timestamp``, ``level``, ``logger``, ``request_id``,
    ``message``, and any ``extra={}`` fields. ``exc_info`` is rendered
    as a multi-line ``exception`` string so structured-log consumers
    (Loki/Datadog/etc.) can still surface stack traces.
    """

    def format(self, record: logging.LogRecord) -> str:
        out: dict = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            out["exception"] = self.formatException(record.exc_info)
        # Surface any extras passed via logger.info("x", extra={"foo": 1}).
        for k, v in record.__dict__.items():
            if k in _LOGRECORD_RESERVED or k in out or k.startswith("_"):
                continue
            try:
                json.dumps(v)
                out[k] = v
            except (TypeError, ValueError):
                out[k] = repr(v)
        return json.dumps(out, default=str)


def _configure_logging() -> None:
    use_json = os.environ.get("NOTESCI_LOG_FORMAT", "").lower() == "json"
    root = logging.getLogger()
    # Don't double-attach our handler if FastAPI / uvicorn already did one.
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        h = logging.StreamHandler()
        if use_json:
            h.setFormatter(_JsonFormatter())
        else:
            h.setFormatter(logging.Formatter(
                "%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s"
            ))
        root.addHandler(h)
        root.setLevel(logging.INFO)
    elif use_json:
        # Operator switched to json mode after uvicorn already wired its
        # handler — swap the formatter in place so subsequent records
        # serialize as JSON. (No-op if it's already a _JsonFormatter.)
        for h in root.handlers:
            if isinstance(h, logging.StreamHandler) and not isinstance(
                h.formatter, _JsonFormatter
            ):
                h.setFormatter(_JsonFormatter())
    # Add the filter to every existing handler so the %(request_id)s
    # placeholder resolves even when uvicorn owns the handler list.
    for h in root.handlers:
        if not any(isinstance(f, _RequestIdLogFilter) for f in h.filters):
            h.addFilter(_RequestIdLogFilter())


_configure_logging()

_REQUEST_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .agent.graph import RequestCtx, build_graph, reset_request_ctx, set_request_ctx
from .agent.mcp_tools import (
    invalidate_workspace_cache as invalidate_mcp_cache,
    load_workspace_mcp_tools,
    _stdio_env as mcp_stdio_env,
)
from .agent.messages import extract_text
from .skills import all_skills, get_skill, is_builtin_skill
from .agent.providers import resolve_default_model
from .crypto import decrypt_config_secrets, encrypt_config_secrets, redact_config_for_api
from .model_catalog import MODELS, PROVIDERS, model_by_id, provider_has_key
from .audit import record_event
from .citations import CitationMaterial, to_bibtex
from .concepts import extract_concepts
from .auth import (
    CurrentMember,
    consume_email_verify_token,
    consume_password_reset_token,
    current_member,
    dummy_verify_password,
    hash_password,
    mint_email_verify_token,
    mint_password_reset_token,
    mint_session,
    signout,
    verify_password,
)
from .config import settings
from .db import close_pool, get_conn, init_pool
from .email_sender import (
    build_sender,
    reset_password_email,
    verify_email_email,
)
from .ingest import extract_pdf_text, fetch_and_extract_url, ingest_text
from .agent.embeddings import (
    EMBEDDING_DIM,
    apply_custom_embedding_config,
    embedding_provider_available,
    resolve_embedding_model,
)
from .ingestion_pipeline import create_job, run_pipeline
from .migrate import apply_migrations
from .ratelimit import enforce as rate_enforce
from .sweeper import sweep_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_psycopg_compatible_event_loop()
    await init_pool()
    async with get_conn() as conn:
        applied = await apply_migrations(conn)
        if applied:
            logger.info("applied migrations: %s", applied)
    # Eagerly initialise the Fernet (or warn if NOTESCI_SECRET_KEY is unset)
    # so operators learn at startup, not on the first MCP install.
    from .crypto import get_fernet
    get_fernet()
    # Bootstrap the user-content directory tree (~/.config/notesci/* and
    # ~/.local/share/notesci/*). Idempotent. Seeds README format-specs
    # so users — and the agent acting on their behalf — know where to
    # drop custom skills and MCP recipes. See user_content.py.
    from .user_content import bootstrap as _bootstrap_user_content
    _bootstrap_user_content()
    app.state.email = build_sender()
    app.state.background_tasks: set[asyncio.Task] = set()
    # Mark abandoned draft workflows as failed. If the process died
    # mid-workflow the orchestrator task is gone but the row still says
    # ``drafting`` / ``reviewing`` — surface the failure so the UI
    # doesn't poll a stale state forever.
    #
    # Multi-worker safe: take a pg advisory lock so only one worker
    # actually runs the sweep. Bumped the staleness threshold from
    # 15m to 60m because long-running drafts (large panel + max
    # iterations on a slow model) legitimately exceed 15m and we
    # don't want to false-positive failure them.
    _SWEEP_LOCK_KEY = 0x4E4F5445_5343495F  # "NOTESCI_" (8 ascii bytes)
    try:
        async with get_conn() as conn:
            cur = await conn.execute(
                "SELECT pg_try_advisory_lock(%s)", (_SWEEP_LOCK_KEY,)
            )
            got_lock = (await cur.fetchone())[0]
            if not got_lock:
                logger.info(
                    "workflow sweep skipped — another worker holds the lock"
                )
            else:
                try:
                    await conn.execute(
                        "UPDATE draft_workflows SET status='failed', "
                        "    error=COALESCE(error,'orphaned'), updated_at=now(), "
                        "    completed_at=COALESCE(completed_at, now()) "
                        "WHERE status NOT IN ('approved','failed','cancelled') "
                        "  AND updated_at < now() - interval '60 minutes'"
                    )
                    await conn.commit()
                finally:
                    # Release explicitly — the advisory lock is bound to
                    # the session, but we want the slot free immediately
                    # in case this worker restarts in a hot loop.
                    await conn.execute(
                        "SELECT pg_advisory_unlock(%s)", (_SWEEP_LOCK_KEY,)
                    )
                    await conn.commit()
    except Exception:
        logger.exception("startup workflow sweep failed")
    # Backfill: when a Fernet key is configured, opportunistically re-
    # encrypt any plaintext header/env values on existing mcp_servers
    # rows (those written before the key was provisioned). Idempotent —
    # already-encrypted values carry the ``fernet:`` prefix and pass
    # through encrypt_config_secrets unchanged.
    _BACKFILL_LOCK_KEY = 0x4E4F5445_5343495E  # "NOTESCI^"
    try:
        from .crypto import encrypt_config_secrets, get_fernet
        if get_fernet() is not None:
            async with get_conn() as conn:
                cur = await conn.execute(
                    "SELECT pg_try_advisory_lock(%s)", (_BACKFILL_LOCK_KEY,)
                )
                got_lock = (await cur.fetchone())[0]
                if not got_lock:
                    logger.info(
                        "mcp secret backfill skipped — another worker holds the lock"
                    )
                else:
                    try:
                        cur = await conn.execute(
                            "SELECT id, config FROM mcp_servers"
                        )
                        rows = await cur.fetchall()
                        updated = 0
                        for sid, cfg in rows:
                            if not cfg:
                                continue
                            re_cfg = encrypt_config_secrets(cfg)
                            if re_cfg != cfg:
                                await conn.execute(
                                    "UPDATE mcp_servers SET config=%s, "
                                    "  updated_at=now() WHERE id=%s",
                                    (Jsonb(re_cfg), sid),
                                )
                                updated += 1
                        if updated:
                            await conn.commit()
                            logger.info(
                                "mcp secret backfill: encrypted %d rows", updated
                            )
                    finally:
                        await conn.execute(
                            "SELECT pg_advisory_unlock(%s)",
                            (_BACKFILL_LOCK_KEY,),
                        )
                        await conn.commit()
    except Exception:
        logger.exception("startup mcp secret backfill failed")
    # Load per-workspace provider API keys from the DB and push them
    # into runtime settings + env so LangChain picks them up. The
    # single-user desktop app installs into a fresh workspace and
    # writes keys through Settings → Models & keys; without this
    # loader, those keys would only take effect after a restart.
    # With a single workspace today, "last write wins" is fine; if
    # multi-workspace lands later, switch to per-request resolution.
    try:
        from .crypto import decrypt_str
        from .agent.providers import apply_runtime_key
        async with get_conn() as conn:
            cur = await conn.execute(
                "SELECT provider, encrypted_key FROM provider_keys"
            )
            for prov, enc in await cur.fetchall():
                try:
                    apply_runtime_key(prov, decrypt_str(enc))
                except Exception:
                    logger.exception(
                        "failed to load provider key for %s", prov
                    )
    except Exception:
        logger.exception("startup provider_keys load failed")
    try:
        from .crypto import decrypt_str
        async with get_conn() as conn:
            cur = await conn.execute(
                "SELECT enabled, base_url, model, encrypted_api_key, dimension "
                "FROM workspace_embedding_config WHERE enabled = TRUE "
                "ORDER BY updated_at DESC LIMIT 1"
            )
            row = await cur.fetchone()
            if row:
                apply_custom_embedding_config(
                    enabled=row[0],
                    base_url=row[1],
                    model=row[2],
                    api_key=decrypt_str(row[3]),
                    dimension=row[4],
                )
    except Exception:
        logger.exception("startup custom embedding config load failed")
    # Single-user desktop bootstrap. On first launch (no members in DB)
    # create a default workspace + member, mint a session token, write
    # it to the path the Tauri shell reads + injects into the WebView's
    # localStorage. Subsequent launches reuse the existing token file
    # so the user stays signed in across restarts. No-op when
    # NOTESCI_LOCAL_MODE is unset.
    if settings.notesci_local_mode:
        try:
            await _bootstrap_local_session()
        except Exception:
            logger.exception("local-mode bootstrap failed")
    async with AsyncExitStack() as stack:
        saver = await stack.enter_async_context(
            AsyncPostgresSaver.from_conn_string(settings.database_url)
        )
        await saver.setup()
        app.state.graph = build_graph(saver)

        if settings.notesci_sweep_interval_seconds > 0:
            _spawn(
                sweep_loop(settings.notesci_sweep_interval_seconds),
                label="sweep_loop",
            )

        # Memory sweeper runs on a shorter cadence (every 2 min) since
        # its job is to catch idle sessions and run extraction promptly.
        # See memory/sweeper.py — picks up jobs idle >= IDLE_EXTRACT_SECONDS
        # and enforces the per-scope row cap inline after each extraction.
        from .memory.sweeper import memory_sweep_loop
        _spawn(memory_sweep_loop(120), label="memory_sweep_loop")
        try:
            yield
        finally:
            # Cancel every tracked background task, then wait up to 5s
            # for them to acknowledge cancellation. Anything still alive
            # after that is leaked into close_pool() which is expected
            # to clean up shared resources.
            pending = list(app.state.background_tasks)
            for t in pending:
                t.cancel()
            if pending:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*pending, return_exceptions=True),
                        timeout=5.0,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "background tasks didn't finish within 5s of shutdown"
                    )
    await close_pool()


async def _bootstrap_local_session() -> None:
    """Idempotent: create a local workspace + member + token if missing.

    Local-mode desktop runs as a single human user. We don't surface a
    sign-in screen because there's nobody to authenticate against — the
    OS already gates access to the machine. But the rest of the backend
    still expects ``member_id`` / ``workspace_id`` foreign keys on
    every row, so we keep the model intact and just bootstrap a
    headless account up front. The minted session token is written to
    ``settings.notesci_local_token_path`` (mode 0640) so the Tauri shell
    can inject it into the WebView's localStorage before navigation.
    """
    token_path = _Path(settings.notesci_local_token_path)
    async with get_conn() as conn:
        async with conn.transaction():
            cur = await conn.execute("SELECT id, workspace_id FROM members LIMIT 1")
            row = await cur.fetchone()
            if row is None:
                cur = await conn.execute(
                    "INSERT INTO workspaces (slug, name) VALUES (%s, %s) RETURNING id",
                    ("local", "Local"),
                )
                ws_id = (await cur.fetchone())[0]
                # Local member has no usable password — the row exists only
                # to satisfy FK constraints. Email is a sentinel; nothing
                # ever sends mail to it.
                cur = await conn.execute(
                    "INSERT INTO members "
                    "  (workspace_id, email, display_name, role, email_verified_at) "
                    "VALUES (%s, %s, %s, %s, now()) RETURNING id",
                    (ws_id, "local@notesci.app", "You", "admin"),
                )
                member_id = (await cur.fetchone())[0]
                logger.info("local-mode bootstrap: created workspace + member")
            else:
                member_id = row[0]

            # Reuse the on-disk token if it still validates — keeps the
            # user signed-in across upgrades. Otherwise mint fresh.
            existing = None
            try:
                if token_path.is_file():
                    existing = token_path.read_text().strip() or None
            except OSError:
                existing = None
            if existing:
                from .auth import hash_token
                cur = await conn.execute(
                    "SELECT 1 FROM auth_sessions "
                    "WHERE token_hash = %s AND member_id = %s "
                    "  AND expires_at > now()",
                    (hash_token(existing), member_id),
                )
                if await cur.fetchone() is not None:
                    return  # nothing to do — token still good
            token, _ = await mint_session(conn, member_id)
            token_path.parent.mkdir(parents=True, exist_ok=True)
            token_path.write_text(token)
            try:
                os.chmod(token_path, 0o640)
            except OSError:
                pass
            logger.info("local-mode bootstrap: wrote session token to %s", token_path)


def _read_local_mode_token() -> str | None:
    """Return the current desktop local-mode session token, if available."""
    if not settings.notesci_local_mode:
        return None
    try:
        return _Path(settings.notesci_local_token_path).read_text().strip() or None
    except OSError:
        return None


def _on_task_done(task: asyncio.Task, label: str) -> None:
    try:
        app.state.background_tasks.discard(task)
    except Exception:
        pass
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.exception(
            "background task %s failed", label, exc_info=exc
        )


def _spawn(coro, label: str) -> asyncio.Task:
    """Create a tracked background task.

    The task is added to ``app.state.background_tasks`` so the lifespan
    teardown can cancel it; on completion the done-callback removes it
    from the set and logs any unhandled exception via ``logger.exception``.
    """
    t = asyncio.create_task(coro, name=label)
    app.state.background_tasks.add(t)
    t.add_done_callback(lambda done: _on_task_done(done, label))
    return t


app = FastAPI(title="notesci backend", version="0.0.1", lifespan=lifespan)


class _RequestIdMiddleware(BaseHTTPMiddleware):
    """Mint or echo an ``X-Request-ID`` per request.

    Accepts a caller-supplied id only when it matches the UUIDv4 shape;
    anything else gets a fresh ``uuid4().hex`` so attackers can't inject
    crafted strings into our logs.
    """

    async def dispatch(self, request, call_next):
        incoming = request.headers.get("x-request-id")
        rid = incoming if incoming and _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(rid)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = rid
        return response


# Middleware order matters: Starlette wraps each newly-added middleware
# AROUND the previous stack, so the LAST add_middleware call ends up
# outermost (executes first on the way in, last on the way out). We
# want RequestId outermost so the request id is set before CORS — and
# before any other middleware — gets a chance to log.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["authorization", "content-type", "x-admin-token", "x-request-id"],
    max_age=600,
)
app.add_middleware(_RequestIdMiddleware)


class _StripApiPrefixMiddleware(BaseHTTPMiddleware):
    """Strip ``/api`` from incoming request paths so a frontend served
    from the same host (the .deb install layout) can hit the backend
    through the same conventional /api/* URL prefix it uses in dev
    (where the Vite proxy does the strip). Backend route definitions
    stay un-prefixed — this middleware adapts incoming requests so
    both layouts hit the same handlers."""

    async def dispatch(self, request, call_next):
        if request.url.path.startswith("/api/"):
            new_path = request.url.path[4:]
            request.scope["path"] = new_path
            raw = request.scope.get("raw_path")
            if raw and raw.startswith(b"/api/"):
                request.scope["raw_path"] = raw[4:]
        return await call_next(request)


app.add_middleware(_StripApiPrefixMiddleware)


@app.get("/auth/local-token")
async def local_auth_token():
    """Local desktop auth recovery endpoint.

    The Tauri shell normally receives the bootstrap token through the
    served ``index.html``. If localStorage is stale or cleared while the
    SPA stays mounted, authenticated calls would otherwise loop on 401
    until a hard reload. In local desktop mode, re-run the idempotent
    bootstrap and return the current token so the frontend can retry
    once. Non-local deployments do not expose this endpoint.
    """
    if not settings.notesci_local_mode:
        raise HTTPException(status_code=404, detail="not found")
    token = _read_local_mode_token()
    if not token:
        await _bootstrap_local_session()
        token = _read_local_mode_token()
    if not token:
        raise HTTPException(status_code=503, detail="local token unavailable")
    return {"token": token}


class ChatIn(BaseModel):
    message: str
    thread_id: str | None = None
    # When set, the retrieval node queries chunks scoped to this project
    # and threads top-k hits into the LLM context as a system message.
    project_id: str | None = None
    # Optional per-request model override. Format: "<provider>:<model_id>"
    # — e.g. "anthropic:claude-sonnet-4-6", "deepseek:deepseek-chat".
    # Falls back to ``resolve_default_model()`` when omitted — that's
    # the operator's ``NOTESCI_DEFAULT_MODEL`` if set, otherwise the
    # first available provider model. We don't impose a hardcoded default.
    model: str | None = None
    # Retrieval mode for this turn:
    #   * 'vector' (default) — pgvector kNN over chunks
    #   * 'tree'             — PageIndex hierarchical tree-walk; falls
    #                          back to vector if no trees are ready in
    #                          the project. Requires
    #                          NOTESCI_PAGETREE_ENABLED to build trees
    #                          on ingest in the first place.
    # Server-side allowlist — anything outside this Literal is rejected
    # with 422 by Pydantic so unknown modes can't leak into RequestCtx
    # state or future match statements.
    retrieval_mode: Literal["vector", "tree"] | None = None
    # When True for a single turn: skip core-memory injection, skip
    # hybrid recall, and skip post-turn extraction. The model also
    # doesn't see the memory_save tool. Matches Claude/ChatGPT incognito
    # semantics — one-turn read-and-write opt-out.
    memory_incognito: bool = False
    # Allow web-search fallback when local retrieval (tree/vector)
    # produces no useful chunks for this turn.
    web_search: bool = True


class RetrievedRef(BaseModel):
    chunk_id: int
    material_id: str
    title: str | None
    distance: float | None = None
    material_url: str | None = None
    marker_n: int | None = None
    source_kind: Literal["internal", "external"] = "internal"


class MemoryRecallOut(BaseModel):
    id: str
    scope: str
    project_id: str | None
    kind: str
    title: str
    body: str
    source_session: str | None = None


class ChatOut(BaseModel):
    reply: str
    thread_id: str
    retrieved: list[RetrievedRef] = []
    # Names of any proprietary skills the router activated for this
    # turn (e.g. ["content-research-writer"]). The UI surfaces these
    # as a subtle indicator; the actual skill content is hidden.
    skills: list[str] = []
    # The model that produced this reply, in canonical
    # "<provider>:<model_id>" form. Surfaced beneath each AI bubble
    # so users can see which model handled which turn.
    model_used: str | None = None
    # 0-indexed turn number this assistant message belongs to. The
    # client uses it to attach `model_used` to the right bubble when
    # we later refetch /threads/{id}/messages.
    turn_seq: int | None = None
    # The retrieval mode the server actually used for this turn. May
    # differ from the requested mode when local retrieval falls back
    # (tree→vector / vector→web / no-project→web). The UI uses this to
    # keep grounding state honest.
    retrieval_mode_used: str | None = None
    # Count of long-term memories the hybrid recall pulled for this turn
    # (independent of the chunk retrieval above). UI shows a "Recalled
    # N notes" chip so the user can see when memory influenced an answer.
    memory_recalled_count: int = 0
    # Full recalled-memory metadata for transparency in the response UI.
    # Historical thread reloads may not carry this yet; the count remains
    # backward-compatible for older bubbles.
    memory_recalled: list[MemoryRecallOut] = []


class ExternalPreviewIn(BaseModel):
    url: str


class ExternalPreviewOut(BaseModel):
    url: str
    title: str | None = None
    content: str


def _citation_markers(text: str) -> list[int]:
    markers: set[int] = set()
    for group in re.findall(r"\[((?:I?\d+)(?:\s*,\s*I?\d+)*)\]", text, flags=re.IGNORECASE):
        for raw in re.split(r"\s*,\s*", group):
            raw = re.sub(r"^I", "", raw, flags=re.IGNORECASE)
            try:
                markers.add(int(raw))
            except ValueError:
                continue
    return sorted(markers)


def _retrieved_source_kind(material_id: object) -> Literal["internal", "external"]:
    return "internal" if _as_uuid(material_id) is not None else "external"


def _retrieved_refs_from_chunks(chunks: list[dict]) -> list[RetrievedRef]:
    internal_n = 0
    external_n = 0
    refs: list[RetrievedRef] = []
    for r in chunks:
        kind = _retrieved_source_kind(r["material_id"])
        if kind == "internal":
            internal_n += 1
            marker_n = internal_n
        else:
            external_n += 1
            marker_n = external_n
        material_url = r.get("material_url")
        if kind == "external" and not material_url:
            title = (r.get("title") or "").strip()
            if title:
                material_url = "https://www.google.com/search?q=" + quote_plus(title)
        refs.append(
            RetrievedRef(
                chunk_id=r["chunk_id"],
                material_id=r["material_id"],
                title=r["title"],
                distance=r["distance"],
                material_url=material_url,
                marker_n=marker_n,
                source_kind=kind,
            )
        )
    return refs


def _memory_recall_to_out(memory) -> MemoryRecallOut:
    return MemoryRecallOut(
        id=str(memory.id),
        scope=memory.scope,
        project_id=str(memory.project_id) if memory.project_id else None,
        kind=memory.kind,
        title=memory.title,
        body=memory.body,
        source_session=(
            str(memory.source_session) if memory.source_session else None
        ),
    )


def _as_uuid(value: str) -> UUID | None:
    """Return a UUID for a DB key, or ``None`` if the value isn't UUID-like."""
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _resolve_chat_model(requested_model: str | None) -> str | None:
    """Resolve a per-request model override through catalog + key checks.

    - If ``requested_model`` is absent: delegate to
      :func:`resolve_default_model`.
    - If requested model exists and its provider has a configured API key:
      use it.
    - If requested model is stale / unknown / lacks a key: fall back to
      :func:`resolve_default_model` so a bad local preference doesn't
      hard-fail the chat turn.
    """
    if requested_model:
        entry = model_by_id(requested_model)
        if not entry:
            logger.info("chat request model %r not in catalog", requested_model)
            return resolve_default_model()
        provider = next((p for p in PROVIDERS if p.id == entry.provider_id), None)
        if provider and provider_has_key(provider, settings):
            return requested_model
        logger.info(
            "chat request model %r ignored; provider %s has no key",
            requested_model,
            entry.provider_id,
        )
        return resolve_default_model()
    return resolve_default_model()


def _require_admin_token(x_admin_token: str | None) -> None:
    """Raise 503 if admin endpoints aren't configured, 401 on mismatch.

    Admin token is intentionally separate from member sessions — it's a
    server-operator credential, not a user one. Comparison is constant-time.
    """
    expected = settings.notesci_admin_token
    if not expected:
        raise HTTPException(status_code=503, detail=_err("admin_disabled"))
    if not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail=_err("invalid_admin_token"))


class AdminWorkspaceIn(BaseModel):
    slug: str = Field(..., min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(..., min_length=1, max_length=200)


class AdminWorkspaceOut(BaseModel):
    workspace_id: str
    slug: str
    name: str


@app.post("/admin/workspaces", response_model=AdminWorkspaceOut, status_code=201)
async def admin_create_workspace(
    body: AdminWorkspaceIn, x_admin_token: str | None = Header(default=None)
) -> AdminWorkspaceOut:
    _require_admin_token(x_admin_token)
    async with get_conn() as conn:
        async with conn.transaction():
            try:
                cur = await conn.execute(
                    "INSERT INTO workspaces (slug, name) VALUES (%s, %s) RETURNING id",
                    (body.slug, body.name),
                )
            except psycopg.errors.UniqueViolation as e:
                raise HTTPException(
                    status_code=409, detail=_err("slug_taken")
                ) from e
            ws_id = (await cur.fetchone())[0]
            await record_event(
                conn=conn,
                workspace_id=ws_id,
                actor_member_id=None,  # system-initiated
                action="workspace.bootstrap",
                target_type="workspace",
                target_id=str(ws_id),
                metadata={"slug": body.slug},
            )
    return AdminWorkspaceOut(
        workspace_id=str(ws_id),
        slug=body.slug,
        name=body.name,
    )


@app.get("/health")
async def health() -> dict:
    async with get_conn() as conn:
        cur = await conn.execute("SELECT 1")
        row = await cur.fetchone()
    return {"ok": True, "db": row[0] == 1}


@app.get("/healthz")
async def healthz() -> dict:
    """Process-level liveness — always 200 unless the process is gone.

    Use for k8s liveness probes / load-balancer health checks. Does NOT
    touch the DB so a flaky Postgres won't get the pod killed; the
    readiness check (:func:`readyz`) is what gates traffic.
    """
    return {"status": "ok"}


@app.get("/readyz")
async def readyz() -> Response:
    """Readiness — 200 when the DB pool can answer ``SELECT 1`` within 1s.

    Returns 503 with ``{"status":"unready","reason":"db"}`` otherwise so
    the LB drains traffic until the DB recovers.
    """
    async def _ping() -> None:
        async with get_conn() as conn:
            await conn.execute("SELECT 1")

    try:
        await asyncio.wait_for(_ping(), timeout=1.0)
    except Exception:
        return Response(
            content='{"status":"unready","reason":"db"}',
            media_type="application/json",
            status_code=503,
        )
    return Response(
        content='{"status":"ok"}',
        media_type="application/json",
        status_code=200,
    )


# ---------------------------------------------------------------------------
# Auth — invite-claim sign up, password sign in, signout, /me.
# ---------------------------------------------------------------------------


class MemberOut(BaseModel):
    id: str
    workspace_id: str
    email: str
    display_name: str | None
    affiliation: str | None = None
    orcid: str | None = None
    field_of_research: str | None = None
    topics: list[str] = []
    role: str
    email_verified: bool = False


class MeUpdateIn(BaseModel):
    """Patch-style update for the post-claim onboarding screen.

    Each field is optional. Fields the client doesn't send are left
    untouched (Pydantic ``exclude_unset``). Sending ``null`` clears.
    """
    display_name: str | None = Field(None, max_length=200)
    affiliation: str | None = Field(None, max_length=200)
    orcid: str | None = Field(None, max_length=64)
    field_of_research: str | None = Field(None, max_length=200)
    topics: list[str] | None = Field(None, max_length=50)


_ME_COLUMNS = (
    "id, workspace_id, email, display_name, affiliation, orcid, "
    "field_of_research, topics, role, email_verified_at"
)


def _row_to_member_out(r) -> MemberOut:
    return MemberOut(
        id=str(r[0]),
        workspace_id=str(r[1]),
        email=r[2],
        display_name=r[3],
        affiliation=r[4],
        orcid=r[5],
        field_of_research=r[6],
        topics=list(r[7] or []),
        role=r[8],
        email_verified=r[9] is not None,
    )


class AuthOut(BaseModel):
    token: str
    expires_at: str
    member: MemberOut


class AuthSigninIn(BaseModel):
    email: str
    password: str


def _err(code: str, message: str | None = None) -> dict:
    return {"code": code, **({"message": message} if message else {})}


def _agent_http_error(exc: BaseException) -> HTTPException:
    """Map a LangGraph/agent exception to an HTTPException.

    Provider rate-limit / quota errors are surfaced as **429** with code
    ``rate_limited`` so the UI can suggest switching model or waiting,
    instead of mis-blaming the API key. Anything we can't classify
    falls through to a generic **502** ``agent_failed``.

    Detection is provider-agnostic — every major SDK exposes either a
    ``status_code`` integer (google-genai ``ClientError``, anthropic,
    openai) or a 429 / RESOURCE_EXHAUSTED marker in the message. We
    walk the ``__cause__`` / ``__context__`` chain because tenacity and
    langchain wrap the original error a couple of layers deep.
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    status: int | None = None
    msg = str(exc)
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        sc = getattr(cur, "status_code", None)
        if isinstance(sc, int):
            status = sc
            msg = str(cur)
            break
        cur = cur.__cause__ or cur.__context__
    text = msg.upper()
    is_rate_limit = (
        status == 429
        or "RESOURCE_EXHAUSTED" in text
        or "RATE LIMIT" in text
        or "QUOTA EXCEEDED" in text
        or "TOO MANY REQUESTS" in text
    )
    if is_rate_limit:
        short = (
            "Rate limit hit on the model provider. Try a different "
            "model, or wait a moment and retry."
        )
        m = re.search(r"retry in ([\d.]+)s", msg, re.IGNORECASE)
        if m:
            secs = int(float(m.group(1))) + 1
            short = (
                f"Rate limit hit on the model provider. Retry in ~{secs}s, "
                "or switch to a different model."
            )
        return HTTPException(
            status_code=429,
            detail=_err("rate_limited", short),
        )
    return HTTPException(
        status_code=502,
        detail=_err("agent_failed", "We couldn't complete that request."),
    )


@app.post("/auth/signin", response_model=AuthOut)
async def auth_signin(body: AuthSigninIn, request: Request) -> AuthOut:
    await rate_enforce(request, endpoint="auth_signin", limit=10)
    email = body.email.lower().strip()
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, workspace_id, password_hash, display_name, role "
            "FROM members WHERE email=%s "
            "ORDER BY created_at LIMIT 1",
            (email,),
        )
        row = await cur.fetchone()
        # The schema permits the same email across multiple workspaces
        # (UNIQUE is per-workspace), but we collapse every signin failure
        # — including the "email exists in multiple workspaces" case —
        # into a generic ``invalid_credentials`` so the response doesn't
        # disclose whether the email is known. Future:
        # ``?workspace=<slug>`` will disambiguate explicitly.
        if not row or not row[2]:
            # No row (or no password hash) — still spend an argon2 verify()
            # against a dummy hash so the response time matches the wrong-
            # password branch. Otherwise an attacker could enumerate
            # registered emails by timing alone.
            dummy_verify_password(body.password)
            raise HTTPException(status_code=401, detail=_err("invalid_credentials"))
        if not verify_password(body.password, row[2]):
            raise HTTPException(status_code=401, detail=_err("invalid_credentials"))
        member_id, ws_id, _hash, display_name, role = row
        token, expires = await mint_session(conn, member_id)
        await record_event(
            conn=conn,
            workspace_id=ws_id,
            actor_member_id=member_id,
            action="member.signin",
        )
        await conn.commit()
    return AuthOut(
        token=token,
        expires_at=expires.isoformat(),
        member=MemberOut(
            id=str(member_id),
            workspace_id=str(ws_id),
            email=email,
            display_name=display_name,
            role=role,
        ),
    )


@app.post("/auth/signout", status_code=204)
async def auth_signout(authorization: str | None = Header(default=None)) -> None:
    if authorization and authorization.lower().startswith("bearer "):
        await signout(authorization[7:].strip())


@app.post("/auth/sessions/revoke-all", status_code=204)
async def revoke_all_sessions(
    member: CurrentMember = Depends(current_member),
) -> Response:
    """Nuke every active web session for the caller.

    Includes the current tab — the frontend is expected to navigate to
    ``/sign-in`` immediately after a 204. Does NOT revoke PATs; those
    are managed individually via ``DELETE /me/tokens/{id}``.
    """
    async with get_conn() as conn:
        cur = await conn.execute(
            "DELETE FROM auth_sessions WHERE member_id=%s", (member.id,)
        )
        deleted = cur.rowcount or 0
        await record_event(
            conn=conn,
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="member.sessions.revoked_all",
            metadata={"count": deleted},
        )
        await conn.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Personal access tokens — long-lived bearer tokens for scripting / CLI.
# Separate from auth_sessions: PATs survive password resets unless the
# user revokes them.
# ---------------------------------------------------------------------------


class TokenCreateIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    expires_in_days: int | None = Field(None, ge=1, le=3650)


class TokenCreateOut(BaseModel):
    id: str
    label: str
    display_prefix: str
    token: str  # plaintext — shown exactly once
    created_at: str
    expires_at: str | None


class TokenListItem(BaseModel):
    id: str
    label: str
    display_prefix: str
    created_at: str
    expires_at: str | None
    last_used_at: str | None


@app.post("/me/tokens", response_model=TokenCreateOut, status_code=201)
async def create_personal_token(
    body: TokenCreateIn,
    request: Request,
    member: CurrentMember = Depends(current_member),
) -> TokenCreateOut:
    # Per-member throttle: cap at 5 creates / hour. Stops a compromised
    # session token from churning out long-lived PATs faster than the
    # rightful owner can revoke them.
    await rate_enforce(
        request,
        endpoint="pat_create",
        limit=5,
        window_seconds=3600,
        member_id=member.id,
    )
    raw = secrets.token_urlsafe(32)
    prefix = raw[:8]
    token_hash_hex = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    expires = None
    if body.expires_in_days is not None:
        from datetime import timedelta as _td
        expires = datetime.now(timezone.utc) + _td(days=body.expires_in_days)
    async with get_conn() as conn:
        # Cap active PATs/member at 20 — bound the blast radius of a
        # compromised account and keep the dashboard listing tractable.
        cur = await conn.execute(
            "SELECT count(*) FROM auth_tokens "
            "WHERE member_id=%s AND revoked_at IS NULL",
            (member.id,),
        )
        active_count = (await cur.fetchone())[0]
        if active_count >= 20:
            raise HTTPException(
                status_code=400,
                detail=_err(
                    "pat_quota_exceeded",
                    "You can have at most 20 active tokens.",
                ),
            )
        cur = await conn.execute(
            "INSERT INTO auth_tokens "
            "(member_id, label, display_prefix, token_hash, expires_at) "
            "VALUES (%s, %s, %s, %s, %s) "
            "RETURNING id, created_at",
            (
                member.id,
                body.label,
                prefix,
                bytes.fromhex(token_hash_hex),
                expires,
            ),
        )
        r = await cur.fetchone()
        new_id = r[0]
        # Audit (best-effort — never log the raw token, just the id + prefix).
        await record_event(
            conn=conn,
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="member.tokens.created",
            target_type="auth_token",
            target_id=str(new_id),
            metadata={"label": body.label, "prefix": prefix},
        )
        await conn.commit()
    return TokenCreateOut(
        id=str(new_id),
        label=body.label,
        display_prefix=prefix,
        token=raw,
        created_at=_iso(r[1]),
        expires_at=_iso(expires),
    )


@app.get("/me/tokens", response_model=list[TokenListItem])
async def list_personal_tokens(
    member: CurrentMember = Depends(current_member),
) -> list[TokenListItem]:
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, label, display_prefix, created_at, expires_at, "
            "       last_used_at "
            "FROM auth_tokens WHERE member_id=%s AND revoked_at IS NULL "
            "ORDER BY created_at DESC",
            (member.id,),
        )
        rows = await cur.fetchall()
    return [
        TokenListItem(
            id=str(r[0]),
            label=r[1],
            display_prefix=r[2],
            created_at=_iso(r[3]),
            expires_at=_iso(r[4]),
            last_used_at=_iso(r[5]),
        )
        for r in rows
    ]


@app.delete("/me/tokens/{token_id}", status_code=204)
async def revoke_personal_token(
    token_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    tid = _parse_uuid(token_id, "invalid_token_id")
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE auth_tokens SET revoked_at=now() "
            "WHERE id=%s AND member_id=%s AND revoked_at IS NULL",
            (tid, member.id),
        )
        if cur.rowcount == 0:
            await conn.commit()
            raise HTTPException(status_code=404, detail=_err("token_not_found"))
        await record_event(
            conn=conn,
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="member.tokens.revoked",
            target_type="auth_token",
            target_id=str(tid),
        )
        await conn.commit()
    return Response(status_code=204)


@app.get("/me", response_model=MemberOut)
async def me(member: CurrentMember = Depends(current_member)) -> MemberOut:
    async with get_conn() as conn:
        cur = await conn.execute(
            f"SELECT {_ME_COLUMNS} FROM members WHERE id=%s", (member.id,)
        )
        r = await cur.fetchone()
    return _row_to_member_out(r)


@app.patch("/me", response_model=MemberOut)
async def update_me(
    body: MeUpdateIn, member: CurrentMember = Depends(current_member)
) -> MemberOut:
    """Update the caller's profile fields. Backs the post-claim onboarding screen.

    Fields the client doesn't send are left untouched (PATCH semantics).
    Sending ``null`` clears a field. Per design, every field is skippable.
    """
    update = body.model_dump(exclude_unset=True)
    async with get_conn() as conn:
        if update:
            cols = list(update.keys())
            sets = ", ".join(f"{c}=%s" for c in cols) + ", updated_at=now()"
            params = [update[c] for c in cols] + [member.id]
            cur = await conn.execute(
                f"UPDATE members SET {sets} WHERE id=%s RETURNING {_ME_COLUMNS}",
                params,
            )
        else:
            cur = await conn.execute(
                f"SELECT {_ME_COLUMNS} FROM members WHERE id=%s", (member.id,)
            )
        r = await cur.fetchone()
        await conn.commit()
    return _row_to_member_out(r)


# ---------------------------------------------------------------------------
# Public waitlist — pre-claim signup form.
# ---------------------------------------------------------------------------


class WaitlistIn(BaseModel):
    email: str = Field(..., min_length=3)
    field_of_research: str | None = None
    what_youd_do: str | None = None


@app.post("/auth/waitlist", status_code=201)
async def waitlist(body: WaitlistIn, request: Request) -> dict:
    await rate_enforce(request, endpoint="auth_waitlist", limit=5)
    email = body.email.lower().strip()
    if "@" not in email:
        raise HTTPException(status_code=400, detail=_err("invalid_email"))
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO waitlist_signups (email, field_of_research, what_youd_do)
            VALUES (%s, %s, %s)
            ON CONFLICT (email) DO UPDATE SET
                field_of_research = EXCLUDED.field_of_research,
                what_youd_do = EXCLUDED.what_youd_do,
                updated_at = now()
            """,
            (email, body.field_of_research, body.what_youd_do),
        )
        await conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Forgot / reset password — three screens in design, two endpoints here.
# Email sending is not wired yet; the raw token is logged to stdout.
# ---------------------------------------------------------------------------


class ForgotPasswordIn(BaseModel):
    email: str = Field(..., min_length=3)


class ResetPasswordIn(BaseModel):
    token: str = Field(..., min_length=8)
    password: str = Field(..., min_length=8)


@app.post("/auth/forgot-password", status_code=204)
async def forgot_password(body: ForgotPasswordIn, request: Request) -> None:
    """Mint a reset token if the email exists; ALWAYS return 204.

    Returning 204 unconditionally avoids leaking whether an email is a
    notesci member.
    """
    await rate_enforce(request, endpoint="auth_forgot", limit=5)
    email = body.email.lower().strip()
    async with get_conn() as conn:
        cur = await conn.execute("SELECT id FROM members WHERE email=%s", (email,))
        row = await cur.fetchone()
        if row:
            member_id = row[0]
            token = await mint_password_reset_token(conn, member_id)
            await conn.commit()
            # Send the email out-of-band so the on-hit and on-miss branches
            # both return at the same instant — otherwise the on-hit branch
            # blocks on SMTP latency and an attacker can enumerate beta
            # member emails by timing alone.
            async def _send_reset() -> None:
                try:
                    await app.state.email.send(
                        reset_password_email(to=email, raw_token=token)
                    )
                except Exception:  # best-effort: don't leak via 500
                    logger.warning("failed to send reset email", exc_info=True)

            _spawn(_send_reset(), label="auth_forgot_email")


@app.post("/auth/reset-password", status_code=204)
async def reset_password(body: ResetPasswordIn) -> None:
    async with get_conn() as conn:
        async with conn.transaction():
            member_id = await consume_password_reset_token(conn, body.token)
            if not member_id:
                raise HTTPException(
                    status_code=400, detail=_err("invalid_or_expired_token")
                )
            await conn.execute(
                "UPDATE members SET password_hash=%s, updated_at=now() WHERE id=%s",
                (hash_password(body.password), member_id),
            )
            # Belt-and-braces: revoke every existing session for this member
            # so a stolen session token doesn't survive a password reset.
            await conn.execute(
                "DELETE FROM auth_sessions WHERE member_id=%s", (member_id,)
            )
            # Also revoke any active personal access tokens — they're long-
            # lived bearer creds and a password reset signals a credential-
            # compromise event, so we treat them like sessions. Inside the
            # same transaction so a partial failure rolls both back.
            await conn.execute(
                "UPDATE auth_tokens SET revoked_at=now() "
                "WHERE member_id=%s AND revoked_at IS NULL",
                (member_id,),
            )


# ---------------------------------------------------------------------------
# Email verification — request a token (auth-gated) and confirm with it.
# Currently informational only; we don't yet gate any feature on
# `members.email_verified_at`. The bit is recorded so future product
# decisions (e.g. limit invite issuance to verified members) can rely on it.
# ---------------------------------------------------------------------------


class VerifyEmailConfirmIn(BaseModel):
    token: str = Field(..., min_length=8)


@app.post("/auth/verify-email/request", status_code=204)
async def request_email_verification(
    member: CurrentMember = Depends(current_member),
) -> None:
    async with get_conn() as conn:
        token = await mint_email_verify_token(conn, member.id)
        await conn.commit()
    try:
        await app.state.email.send(
            verify_email_email(to=member.email, raw_token=token)
        )
    except Exception:
        logger.warning("failed to send verify email", exc_info=True)


@app.post("/auth/verify-email/confirm", status_code=204)
async def confirm_email_verification(body: VerifyEmailConfirmIn) -> None:
    async with get_conn() as conn:
        async with conn.transaction():
            member_id = await consume_email_verify_token(conn, body.token)
            if not member_id:
                raise HTTPException(
                    status_code=400, detail=_err("invalid_or_expired_token")
                )
            await conn.execute(
                "UPDATE members SET email_verified_at=now() WHERE id=%s",
                (member_id,),
            )


# ---------------------------------------------------------------------------
# Workspace surface — projects, sessions, materials, members.
#
# All read endpoints are scoped to the caller's workspace. Sessions are
# additionally scoped to the caller (each member sees their own chat
# history within a shared project). Materials are project-wide because
# the workspace UI treats sources as shared across all members in a
# project.
# ---------------------------------------------------------------------------


class ProjectIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class ProjectPatch(BaseModel):
    """Partial update for a project. Only ``name`` is patchable — a
    project's workspace and ownership are immutable once created."""
    name: str | None = None


class ProjectOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    created_at: str
    updated_at: str


class SessionListItem(BaseModel):
    id: str  # this is the LangGraph thread_id
    # Nullable since 0022_general_sessions: general (project-less) chats
    # carry workspace_id but no project_id. UI uses the absence to render
    # the GENERAL pill instead of the project name.
    project_id: str | None = None
    kind: str = "project"  # 'project' | 'general'
    title: str | None
    created_at: str
    updated_at: str


class SessionPatch(BaseModel):
    """Partial update for a chat session. Only ``title`` is patchable —
    a session's project and ownership are immutable once minted."""
    title: str | None = None


class MaterialListItem(BaseModel):
    id: str
    project_id: str
    source_type: str
    title: str | None
    uri: str | None
    created_at: str


class MaterialPatch(BaseModel):
    """Partial update for a material. Only ``title`` is patchable today —
    source bytes, project, and ingestion artifacts are immutable once the
    pipeline has run. Trimmed; an empty/whitespace-only value clears the
    title back to NULL and the UI falls back to the original filename
    (or "Untitled source")."""

    title: str | None = None


def _iso(dt) -> str:
    return dt.isoformat() if dt else None


def _is_placeholder_text(value: str | None) -> bool:
    normalized = "".join((value or "").lower().split())
    return normalized in {
        "",
        "[]",
        "{}",
        "[ ]",
        "{ }",
        "none",
        "null",
        "undefined",
        "no snippet available.",
        "no snippet available",
    }


def _material_display_text(
    raw_text: str | None,
    uri: str | None,
    metadata: dict | None = None,
) -> str:
    text = (raw_text or "").strip()
    if not _is_placeholder_text(text):
        return text
    source_url = _material_source_url(uri, metadata)
    if source_url:
        return f"Source: {source_url}"
    return ""


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
            "source_url",
            "url",
            "uri",
            "href",
            "link",
            "source",
            "abstract_url",
            "full_text_url",
            "html",
            "original_url",
            "fetched_url",
        ):
            if key in value:
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


def _material_source_from_metadata(metadata: dict | None) -> str | None:
    if not isinstance(metadata, dict):
        return None

    # First: pick explicit URL-like metadata keys.
    explicit = _first_http_url(metadata)
    if explicit:
        return explicit

    # PubMed / arXiv IDs are often persisted without a clickable URL.
    pubmed_id = (
        metadata.get("pmid")
        or metadata.get("PMID")
        or metadata.get("pubmed_id")
        or metadata.get("uid")
        or metadata.get("PubmedID")
        or metadata.get("PubMedID")
    )
    if pubmed_id:
        pmid = str(pubmed_id).strip()
        if pmid:
            return f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"

    arxiv_id = metadata.get("arxiv_id") or metadata.get("ARXIV_ID") or metadata.get("arXiv")
    if arxiv_id:
        sid = str(arxiv_id).strip()
        if sid:
            return f"https://arxiv.org/abs/{sid}"

    doi = metadata.get("doi") or metadata.get("DOI")
    if doi:
        did = str(doi).strip()
        if did:
            return f"https://doi.org/{did}"

    return None


def _material_source_url(uri: str | None, metadata: dict | None = None) -> str | None:
    if isinstance(uri, str):
        candidate = uri.strip()
        if candidate and not _is_placeholder_text(candidate):
            return candidate
    return _material_source_from_metadata(metadata)


@app.get("/projects", response_model=list[ProjectOut])
async def list_projects(
    member: CurrentMember = Depends(current_member),
) -> list[ProjectOut]:
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, workspace_id, name, created_at, updated_at "
            "FROM projects WHERE workspace_id=%s ORDER BY updated_at DESC",
            (member.workspace_id,),
        )
        rows = await cur.fetchall()
    return [
        ProjectOut(
            id=str(r[0]),
            workspace_id=str(r[1]),
            name=r[2],
            created_at=_iso(r[3]),
            updated_at=_iso(r[4]),
        )
        for r in rows
    ]


@app.post("/projects", response_model=ProjectOut, status_code=201)
async def create_project(
    body: ProjectIn, member: CurrentMember = Depends(current_member)
) -> ProjectOut:
    async with get_conn() as conn:
        cur = await conn.execute(
            "INSERT INTO projects (workspace_id, created_by_member_id, name) "
            "VALUES (%s, %s, %s) "
            "RETURNING id, workspace_id, name, created_at, updated_at",
            (member.workspace_id, member.id, body.name),
        )
        r = await cur.fetchone()
        await record_event(
            conn=conn,
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="project.create",
            target_type="project",
            target_id=str(r[0]),
            metadata={"name": body.name},
        )
        await conn.commit()
    return ProjectOut(
        id=str(r[0]),
        workspace_id=str(r[1]),
        name=r[2],
        created_at=_iso(r[3]),
        updated_at=_iso(r[4]),
    )


@app.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> ProjectOut:
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, workspace_id, name, created_at, updated_at "
            "FROM projects WHERE id=%s AND workspace_id=%s",
            (pj, member.workspace_id),
        )
        r = await cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail=_err("project_not_found"))
    return ProjectOut(
        id=str(r[0]),
        workspace_id=str(r[1]),
        name=r[2],
        created_at=_iso(r[3]),
        updated_at=_iso(r[4]),
    )


@app.patch("/projects/{project_id}", response_model=ProjectOut)
async def patch_project(
    project_id: str,
    body: ProjectPatch,
    member: CurrentMember = Depends(current_member),
) -> ProjectOut:
    """Rename a project. The name is trimmed and required — a project
    can't be nameless — so an empty/whitespace-only name is rejected
    with ``name_required`` rather than silently kept."""
    pj = _parse_uuid(project_id, "invalid_project_id")
    cleaned = (body.name or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=_err("name_required"))
    cleaned = cleaned[:200]
    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "UPDATE projects SET name = %s, updated_at = now() "
            "WHERE id = %s "
            "RETURNING id, workspace_id, name, created_at, updated_at",
            (cleaned, pj),
        )
        row = await cur.fetchone()
        await record_event(
            conn=conn,
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="project.rename",
            target_type="project",
            target_id=str(pj),
            metadata={"name": cleaned},
        )
        await conn.commit()
    return ProjectOut(
        id=str(row[0]),
        workspace_id=str(row[1]),
        name=row[2],
        created_at=_iso(row[3]),
        updated_at=_iso(row[4]),
    )


@app.delete("/projects/{project_id}", status_code=204)
async def delete_project(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    """Delete a project and everything under it. ``sessions``,
    ``materials``, ``drafts``, ``draft_workflows``, ``ingestion_jobs``
    and the ``material_*`` tables all cascade via their FK. The
    LangGraph checkpointer rows (keyed by ``thread_id`` = ``session_id``)
    aren't covered by an FK, so they're scrubbed best-effort for each of
    the project's sessions — same gap delete_session handles. Each
    checkpointer delete runs in its own savepoint so a missing
    checkpointer table can't poison the outer transaction."""
    pj = _parse_uuid(project_id, "invalid_project_id")
    async with get_conn() as conn:
        async with conn.transaction():
            await _assert_project_in_workspace(conn, pj, member.workspace_id)
            # Capture the session ids before the cascade removes them so
            # we can scrub their checkpointer state afterwards.
            cur = await conn.execute(
                "SELECT id FROM sessions WHERE project_id = %s", (pj,)
            )
            session_ids = [str(r[0]) for r in await cur.fetchall()]
            await conn.execute("DELETE FROM projects WHERE id = %s", (pj,))
            for sid in session_ids:
                for tbl in (
                    "checkpoint_writes",
                    "checkpoint_blobs",
                    "checkpoints",
                ):
                    try:
                        async with conn.transaction():
                            await conn.execute(
                                f"DELETE FROM {tbl} WHERE thread_id = %s",
                                (sid,),
                            )
                    except Exception:  # noqa: BLE001 — table may not exist
                        pass
            await record_event(
                conn=conn,
                workspace_id=member.workspace_id,
                actor_member_id=member.id,
                action="project.delete",
                target_type="project",
                target_id=str(pj),
                metadata={"sessions": len(session_ids)},
            )
    return Response(status_code=204)


@app.get("/projects/{project_id}/sessions", response_model=list[SessionListItem])
async def list_project_sessions(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> list[SessionListItem]:
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "SELECT id, project_id, title, created_at, updated_at "
            "FROM sessions WHERE project_id=%s AND created_by_member_id=%s "
            "ORDER BY updated_at DESC",
            (pj, member.id),
        )
        rows = await cur.fetchall()
    return [
        SessionListItem(
            id=str(r[0]),
            project_id=str(r[1]),
            title=r[2],
            created_at=_iso(r[3]),
            updated_at=_iso(r[4]),
        )
        for r in rows
    ]


async def _assert_session_owner(
    conn, session_id: UUID, member: CurrentMember
) -> UUID | None:
    """Confirm the session exists, was created by the caller, and lives
    in the caller's workspace. Returns the project_id (None for general
    sessions). Raises 404 ``session_not_found`` on any failure so
    cross-workspace probes can't distinguish 'not yours' from 'doesn't
    exist'.

    Authoritative column is ``sessions.workspace_id`` — set explicitly
    on insert by both project and general session creation paths since
    migration 0022 — so we don't need to JOIN ``projects``. The earlier
    INNER JOIN excluded general sessions (project_id NULL) and broke
    rename + delete for every general chat.
    """
    cur = await conn.execute(
        "SELECT project_id "
        "FROM sessions "
        "WHERE id = %s "
        "  AND created_by_member_id = %s "
        "  AND workspace_id = %s",
        (session_id, member.id, member.workspace_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=_err("session_not_found"))
    return row[0]


# ── General (project-less) sessions ─────────────────────────────────
# Backed by the kind='general' rows on the sessions table (see migration
# 0022). The general page (`/`) creates these on first message-send so
# the user can start chatting without committing to a project first; a
# later "promote to project" flow will migrate the messages into a fresh
# project row when the user decides the thread is worth keeping scoped.


class GeneralSessionCreate(BaseModel):
    title: str | None = None


@app.post(
    "/general/sessions",
    response_model=SessionListItem,
    status_code=201,
)
async def create_general_session(
    body: GeneralSessionCreate | None = None,
    member: CurrentMember = Depends(current_member),
) -> SessionListItem:
    """Mint a new general session in the caller's workspace. No project
    association; the agent will skip retrieval for any chat turns on
    this session (see agent/graph.py:_retrieve)."""
    title = body.title.strip() if body and body.title else None
    if title == "":
        title = None
    async with get_conn() as conn:
        cur = await conn.execute(
            "INSERT INTO sessions "
            "(workspace_id, created_by_member_id, kind, title) "
            "VALUES (%s, %s, 'general', %s) "
            "RETURNING id, project_id, kind, title, created_at, updated_at",
            (member.workspace_id, member.id, title),
        )
        r = await cur.fetchone()
        await conn.commit()
    return SessionListItem(
        id=str(r[0]),
        project_id=None,
        kind=r[2],
        title=r[3],
        created_at=_iso(r[4]),
        updated_at=_iso(r[5]),
    )


@app.get("/general/sessions", response_model=list[SessionListItem])
async def list_general_sessions(
    member: CurrentMember = Depends(current_member),
) -> list[SessionListItem]:
    """List the caller's general sessions in the caller's workspace,
    newest first. Used by the future general-page rail; the index
    sessions_workspace_kind_idx (migration 0022) supports this filter
    without a sequential scan."""
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, project_id, kind, title, created_at, updated_at "
            "FROM sessions "
            "WHERE workspace_id = %s "
            "  AND created_by_member_id = %s "
            "  AND kind = 'general' "
            "ORDER BY updated_at DESC",
            (member.workspace_id, member.id),
        )
        rows = await cur.fetchall()
    return [
        SessionListItem(
            id=str(r[0]),
            project_id=None,
            kind=r[2],
            title=r[3],
            created_at=_iso(r[4]),
            updated_at=_iso(r[5]),
        )
        for r in rows
    ]


@app.patch("/sessions/{session_id}", response_model=SessionListItem)
async def patch_session(
    session_id: str,
    body: SessionPatch,
    member: CurrentMember = Depends(current_member),
) -> SessionListItem:
    """Rename a chat session. Title is trimmed; an empty/whitespace-only
    title resets it to NULL so the UI falls back to 'Untitled session'."""
    sid = _parse_uuid(session_id, "invalid_session_id")
    new_title: str | None = None
    if body.title is not None:
        cleaned = body.title.strip()
        new_title = cleaned[:120] if cleaned else None
    async with get_conn() as conn:
        await _assert_session_owner(conn, sid, member)
        cur = await conn.execute(
            "UPDATE sessions SET title = %s, updated_at = now() "
            "WHERE id = %s "
            "RETURNING id, project_id, kind, title, created_at, updated_at",
            (new_title, sid),
        )
        row = await cur.fetchone()
        await conn.commit()
    # project_id is NULL for general sessions — keep that null in the
    # response shape so the frontend can render its GENERAL pill.
    return SessionListItem(
        id=str(row[0]),
        project_id=str(row[1]) if row[1] is not None else None,
        kind=row[2],
        title=row[3],
        created_at=_iso(row[4]),
        updated_at=_iso(row[5]),
    )


@app.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    """Delete a chat session. ``message_citations`` and ``chat_calls``
    cascade via their FK; the LangGraph checkpointer rows (keyed by
    thread_id = session_id) are cleaned best-effort so a deleted
    session doesn't leave orphaned conversation state behind."""
    sid = _parse_uuid(session_id, "invalid_session_id")
    async with get_conn() as conn:
        async with conn.transaction():
            await _assert_session_owner(conn, sid, member)
            await conn.execute("DELETE FROM sessions WHERE id = %s", (sid,))
            # Best-effort checkpointer cleanup. These tables are managed
            # by langgraph-checkpoint-postgres, not our migrations, so
            # guard each in case the schema isn't present yet.
            for tbl in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                try:
                    await conn.execute(
                        f"DELETE FROM {tbl} WHERE thread_id = %s", (str(sid),)
                    )
                except Exception:  # noqa: BLE001 — table may not exist
                    pass
    return Response(status_code=204)


@app.get("/projects/{project_id}/materials", response_model=list[MaterialListItem])
async def list_project_materials(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> list[MaterialListItem]:
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "SELECT id, project_id, source_type, title, uri, metadata, created_at "
            "FROM materials WHERE project_id=%s ORDER BY created_at DESC",
            (pj,),
        )
        rows = await cur.fetchall()
    return [
        MaterialListItem(
            id=str(r[0]),
            project_id=str(r[1]),
            source_type=r[2],
            title=r[3],
            uri=_material_source_url(r[4], r[5]),
            created_at=_iso(r[6]),
        )
        for r in rows
    ]


@app.get("/materials/{material_id}/file")
async def get_material_file(
    material_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    """Serve the raw uploaded bytes for a material (currently PDF only).

    Workspace-scoped: a 404 is returned both when the material doesn't
    exist AND when it belongs to another workspace, to avoid leaking
    cross-workspace material IDs. A 404 is also returned when bytes
    were not retained (URL/text ingests, or older PDFs ingested before
    migration 0010).
    """
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT m.original_bytes, m.original_mime, m.title, p.workspace_id "
            "FROM materials m JOIN projects p ON p.id = m.project_id "
            "WHERE m.id = %s",
            (mid,),
        )
        row = await cur.fetchone()

    if not row or row[3] != member.workspace_id:
        raise HTTPException(status_code=404, detail=_err("material_not_found"))
    bytes_, mime, title = row[0], row[1], row[2]
    if not bytes_:
        # Material exists but bytes weren't retained (URL/text/legacy upload).
        raise HTTPException(status_code=404, detail=_err("material_bytes_unavailable"))

    # MIME whitelist — refuse to serve anything other than a PDF inline.
    # Stops a future ingest path from accidentally letting an HTML or SVG
    # material be served with the inline Content-Disposition + sandbox
    # CSP we wrote for PDFs.
    if mime is not None and mime != "application/pdf":
        raise HTTPException(
            status_code=415,
            detail=_err(
                "unsupported_mime", "This material can't be served inline."
            ),
        )
    served_mime = "application/pdf"

    # Sanitize the title for the ASCII Content-Disposition filename: keep
    # only [A-Za-z0-9._-], fall back to material-<id>. The full title is
    # still surfaced over UTF-8 via the RFC 5987 ``filename*`` parameter
    # so non-ASCII titles aren't lost.
    safe_title = re.sub(r"[^A-Za-z0-9._-]+", "_", title or "")
    safe_title = safe_title.strip("._-") or f"material-{material_id}"
    if not safe_title.lower().endswith(".pdf"):
        safe_title += ".pdf"
    utf8_name = quote((title or safe_title), safe="")
    headers = {
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": (
            f'inline; filename="{safe_title}"; '
            f"filename*=UTF-8''{utf8_name}.pdf"
        ),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
    }
    return Response(content=bytes(bytes_), media_type=served_mime, headers=headers)


class MaterialTreeOut(BaseModel):
    """PageIndex tree-index payload for a material.

    Returned by ``GET /materials/{id}/tree``. ``status`` mirrors the
    ``material_trees`` table; ``tree`` is the PageIndex output JSON
    (``doc_name``, ``doc_description``, ``structure``) when ready, or
    ``None`` for pending/failed/skipped rows. Workspace-scoped 404 on
    cross-workspace access (same anti-side-channel rule as the other
    materials endpoints).

    By default, the response strips per-node ``text`` fields — those
    are body slices that can run to 100s of KB and are only needed
    when the caller actually wants section content. Pass
    ``?include_text=true`` to receive the full bodies. The outline
    (title + summary per node) is always returned.
    """

    material_id: str
    status: str
    tree: dict | None = None
    node_count: int | None = None
    page_count: int | None = None
    error: str | None = None
    model: str | None = None


def _strip_tree_text(value: Any) -> Any:
    """Return a deep-copy-like view of a PageIndex tree with ``text``
    fields stripped from every node. Used to slim the default
    ``/materials/{id}/tree`` response."""
    if isinstance(value, dict):
        return {k: _strip_tree_text(v) for k, v in value.items() if k != "text"}
    if isinstance(value, list):
        return [_strip_tree_text(v) for v in value]
    return value


@app.get(
    "/materials/{material_id}/tree",
    response_model=MaterialTreeOut,
)
async def get_material_tree(
    material_id: str,
    include_text: bool = False,
    member: CurrentMember = Depends(current_member),
) -> MaterialTreeOut:
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e

    async with get_conn() as conn:
        cur = await conn.execute(
            """
            SELECT mt.status, mt.tree, mt.node_count, mt.page_count,
                   mt.error, mt.model, p.workspace_id
              FROM materials m
              JOIN projects p ON p.id = m.project_id
         LEFT JOIN material_trees mt ON mt.material_id = m.id
             WHERE m.id = %s
            """,
            (mid,),
        )
        row = await cur.fetchone()

    if not row or row[6] != member.workspace_id:
        raise HTTPException(status_code=404, detail=_err("material_not_found"))

    # When there's no material_trees row yet, surface a benign 'absent'
    # status so the client can render a "no tree yet" hint instead of
    # treating it like an error.
    status, tree, node_count, page_count, err, model = row[:6]
    if status is None:
        return MaterialTreeOut(
            material_id=material_id, status="absent",
        )
    # Strip per-node `text` bodies by default — keeps the outline call
    # cheap and avoids shipping 100s of KB on every UI refresh.
    if tree and not include_text:
        tree = _strip_tree_text(tree)
    return MaterialTreeOut(
        material_id=material_id,
        status=status,
        tree=tree,
        node_count=node_count,
        page_count=page_count,
        error=err,
        model=model,
    )


class MaterialContentOut(BaseModel):
    """Concatenated ingested text for a material.

    Used by the Reader pane for notes / URLs / legacy PDFs without
    retained bytes — the original document text lives in the ``chunks``
    table after ingestion, so we stitch chunks back together in order.
    PDFs WITH retained bytes use ``/materials/{id}/file`` instead so
    the user gets the actual rendered document.
    """

    material_id: str
    content: str


@app.get(
    "/materials/{material_id}/content",
    response_model=MaterialContentOut,
)
async def get_material_content(
    material_id: str, member: CurrentMember = Depends(current_member)
) -> MaterialContentOut:
    """Return the material's full text (chunks concatenated in order).

    Workspace-scoped — 404 for cross-workspace access OR missing
    material, like ``/materials/{id}/file``.
    """
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT p.workspace_id, m.uri, m.metadata FROM materials m "
            "JOIN projects p ON p.id = m.project_id WHERE m.id = %s",
            (mid,),
        )
        row = await cur.fetchone()
        if not row or row[0] != member.workspace_id:
            raise HTTPException(status_code=404, detail=_err("material_not_found"))
        material_uri = row[1]
        material_metadata = row[2]

        cur = await conn.execute(
            "SELECT text FROM chunks WHERE material_id = %s ORDER BY ord ASC",
            (mid,),
        )
        rows = await cur.fetchall()

    chunks: list[str] = []
    seen: set[str] = set()
    for (raw_text,) in rows:
        text = _material_display_text(raw_text, material_uri, material_metadata)
        if text and text not in seen:
            chunks.append(text)
            seen.add(text)

    if not chunks:
        fallback_source = _material_source_url(material_uri, material_metadata)
        if isinstance(fallback_source, str) and fallback_source:
            chunks.append(f"Source: {fallback_source}")

    content = "\n\n".join(chunks)
    return MaterialContentOut(material_id=material_id, content=content)


@app.patch("/materials/{material_id}", response_model=MaterialListItem)
async def patch_material(
    material_id: str,
    body: MaterialPatch,
    member: CurrentMember = Depends(current_member),
) -> MaterialListItem:
    """Rename a material. Workspace-scoped: a 404 with `material_not_found`
    when the material doesn't belong to the caller's workspace (so the
    response doesn't disclose IDs across workspaces). The rename does NOT
    touch ``metadata->>'slug'`` — that's kept as the pipeline-derived
    canonical name; only the user-facing ``title`` changes. Downstream
    graph views (Map / Citations / Concepts / Reasoning lenses) read
    ``materials.title`` directly, so a single UPDATE here is enough to
    propagate the new label across every surface."""
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e
    new_title: str | None = None
    if body.title is not None:
        cleaned = body.title.strip()
        new_title = cleaned[:240] if cleaned else None
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT p.workspace_id FROM materials m "
            "JOIN projects p ON p.id = m.project_id WHERE m.id = %s",
            (mid,),
        )
        row = await cur.fetchone()
        if not row or row[0] != member.workspace_id:
            raise HTTPException(status_code=404, detail=_err("material_not_found"))
        cur = await conn.execute(
            "UPDATE materials SET title = %s "
            "WHERE id = %s "
            "RETURNING id, project_id, source_type, title, uri, created_at",
            (new_title, mid),
        )
        out = await cur.fetchone()
        await conn.commit()
    return MaterialListItem(
        id=str(out[0]),
        project_id=str(out[1]),
        source_type=out[2],
        title=out[3],
        uri=out[4],
        created_at=_iso(out[5]),
    )


@app.delete("/materials/{material_id}", status_code=204)
async def delete_material(
    material_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    """Delete a material and everything that hangs off it.

    All child tables (``chunks``, ``message_citations``,
    ``ingestion_jobs``, ``material_concepts``, ``material_links``)
    declare ``ON DELETE CASCADE`` against ``materials(id)`` — a single
    ``DELETE`` row removal therefore takes the embeddings, citations,
    pipeline state, and graph edges with it. Retained PDF bytes live
    on the same row, so deletion also reclaims the storage.

    Workspace-scoped: collapse 404 / 403 into a single
    ``material_not_found`` so the response doesn't disclose which
    workspace owns a foreign material id.
    """
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e
    async with get_conn() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "SELECT p.workspace_id FROM materials m "
                "JOIN projects p ON p.id = m.project_id WHERE m.id = %s",
                (mid,),
            )
            row = await cur.fetchone()
            if not row or row[0] != member.workspace_id:
                raise HTTPException(status_code=404, detail=_err("material_not_found"))
            await conn.execute("DELETE FROM materials WHERE id = %s", (mid,))
    return Response(status_code=204)


class IngestionStatusOut(BaseModel):
    job_id: str
    material_id: str
    stage: str
    progress: float
    note: str | None = None
    error_code: str | None = None
    error_msg: str | None = None
    updated_at: str


@app.get(
    "/materials/{material_id}/ingestion-status",
    response_model=IngestionStatusOut,
)
async def materials_ingestion_status(
    material_id: str, member: CurrentMember = Depends(current_member)
) -> IngestionStatusOut:
    """Latest ingestion-pipeline status for a material.

    The frontend polls this while the in-pane animation runs — once
    ``stage == 'ready'`` (or ``'failed'``) it stops the polling loop
    and refreshes the materials list to pick up the rename + links.
    """
    try:
        mid = UUID(material_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_material_id")) from e

    async with get_conn() as conn:
        cur = await conn.execute(
            """
            SELECT j.id::text, j.material_id::text, j.stage::text, j.progress,
                   j.note, j.error_code, j.error_msg, j.updated_at,
                   p.workspace_id
              FROM ingestion_jobs j
              JOIN projects p ON p.id = j.project_id
             WHERE j.material_id = %s
             ORDER BY j.created_at DESC
             LIMIT 1
            """,
            (mid,),
        )
        row = await cur.fetchone()

    if not row or row[8] != member.workspace_id:
        raise HTTPException(status_code=404, detail=_err("ingestion_job_not_found"))

    return IngestionStatusOut(
        job_id=row[0],
        material_id=row[1],
        stage=row[2],
        progress=float(row[3] or 0.0),
        note=row[4],
        error_code=row[5],
        error_msg=row[6],
        updated_at=row[7].isoformat() if row[7] else "",
    )


# ---------------------------------------------------------------------------
# Drafts — server-backed long-form writing surface
# ---------------------------------------------------------------------------


class DraftOut(BaseModel):
    id: str
    project_id: str
    title: str
    body: str
    updated_at: str
    created_at: str


class DraftSummary(BaseModel):
    """List-view payload — body is truncated to a preview so the
    `/projects/{id}/drafts` list endpoint stays small even when the
    project has dozens of long drafts."""
    id: str
    project_id: str
    title: str
    preview: str  # first ~200 chars of body, single-line collapsed
    updated_at: str
    created_at: str


class DraftPut(BaseModel):
    title: str
    body: str


class DraftCreate(BaseModel):
    """New-draft payload. All fields optional so the UI can `POST /drafts {}`
    to mint a blank draft for the quick-note flow."""
    title: str = ""
    body: str = ""


class DraftPatch(BaseModel):
    """Partial update. Both fields optional so the Drafter can debounce
    title-only edits without round-tripping the body."""
    title: str | None = None
    body: str | None = None


def _summarize_body(body: str, limit: int = 200) -> str:
    """Single-line preview of a draft body. Collapses internal
    whitespace + truncates to ``limit`` chars with an ellipsis."""
    s = " ".join(body.split())
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


async def _assert_draft_owner(
    conn, draft_id: UUID, member: CurrentMember
) -> tuple[UUID, UUID]:
    """Confirm the draft exists, belongs to the caller, and lives in a
    project inside the caller's workspace. Returns (project_id, member_id)
    for the row. Raises 404 with code ``draft_not_found`` on any failure
    so we don't leak which workspace owns what."""
    cur = await conn.execute(
        "SELECT d.project_id, d.member_id "
        "FROM drafts d JOIN projects p ON p.id = d.project_id "
        "WHERE d.id = %s AND d.member_id = %s AND p.workspace_id = %s",
        (draft_id, member.id, member.workspace_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=_err("draft_not_found"))
    return row[0], row[1]


@app.get("/projects/{project_id}/drafts", response_model=list[DraftSummary])
async def list_project_drafts(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> list[DraftSummary]:
    """List the caller's drafts in this project, newest-touched first.

    The Draft mode in the workspace renders this as a card/list library.
    Body is preview-truncated server-side so we don't ship megabytes
    when a project has dozens of long drafts.
    """
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "SELECT id, project_id, title, body, updated_at, created_at "
            "FROM drafts WHERE project_id = %s AND member_id = %s "
            "ORDER BY updated_at DESC",
            (pj, member.id),
        )
        rows = await cur.fetchall()
    return [
        DraftSummary(
            id=str(r[0]),
            project_id=str(r[1]),
            title=r[2],
            preview=_summarize_body(r[3]),
            updated_at=_iso(r[4]),
            created_at=_iso(r[5]),
        )
        for r in rows
    ]


@app.post(
    "/projects/{project_id}/drafts",
    response_model=DraftOut,
    status_code=201,
)
async def create_project_draft(
    project_id: str,
    body: DraftCreate,
    member: CurrentMember = Depends(current_member),
) -> DraftOut:
    """Create a new draft in this project.

    Used by:
      - the chat-side "Save to Draft" popup (writes the AI reply as a
        fresh draft entry), and
      - the Draft library's "+ New draft" button (mints a blank draft
        for quick-note composition).
    """
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "INSERT INTO drafts (project_id, member_id, title, body) "
            "VALUES (%s, %s, %s, %s) "
            "RETURNING id, project_id, title, body, updated_at, created_at",
            (pj, member.id, body.title, body.body),
        )
        row = await cur.fetchone()
        await conn.commit()
    return DraftOut(
        id=str(row[0]),
        project_id=str(row[1]),
        title=row[2],
        body=row[3],
        updated_at=_iso(row[4]),
        created_at=_iso(row[5]),
    )


@app.get("/drafts/{draft_id}", response_model=DraftOut)
async def get_draft(
    draft_id: str, member: CurrentMember = Depends(current_member)
) -> DraftOut:
    """Fetch a single draft. 404 ``draft_not_found`` if it isn't yours
    or doesn't live in your workspace."""
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e
    async with get_conn() as conn:
        await _assert_draft_owner(conn, did, member)
        cur = await conn.execute(
            "SELECT id, project_id, title, body, updated_at, created_at "
            "FROM drafts WHERE id = %s",
            (did,),
        )
        row = await cur.fetchone()
    return DraftOut(
        id=str(row[0]),
        project_id=str(row[1]),
        title=row[2],
        body=row[3],
        updated_at=_iso(row[4]),
        created_at=_iso(row[5]),
    )


@app.patch("/drafts/{draft_id}", response_model=DraftOut)
async def patch_draft(
    draft_id: str,
    body: DraftPatch,
    member: CurrentMember = Depends(current_member),
) -> DraftOut:
    """Partial update — title and/or body. Used by the Drafter editor's
    debounced save loop. Bumps ``updated_at`` on every write."""
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e

    fields: list[str] = []
    params: list = []
    if body.title is not None:
        fields.append("title = %s")
        params.append(body.title)
    if body.body is not None:
        fields.append("body = %s")
        params.append(body.body)
    if not fields:
        # Treat no-op patch as a touch — bumps updated_at.
        pass
    fields.append("updated_at = now()")
    params.append(did)

    async with get_conn() as conn:
        await _assert_draft_owner(conn, did, member)
        cur = await conn.execute(
            f"UPDATE drafts SET {', '.join(fields)} WHERE id = %s "
            "RETURNING id, project_id, title, body, updated_at, created_at",
            tuple(params),
        )
        row = await cur.fetchone()
        await conn.commit()
    return DraftOut(
        id=str(row[0]),
        project_id=str(row[1]),
        title=row[2],
        body=row[3],
        updated_at=_iso(row[4]),
        created_at=_iso(row[5]),
    )


@app.delete("/drafts/{draft_id}", status_code=204)
async def delete_draft(
    draft_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e
    async with get_conn() as conn:
        async with conn.transaction():
            await _assert_draft_owner(conn, did, member)
            await conn.execute("DELETE FROM drafts WHERE id = %s", (did,))
    return Response(status_code=204)


# --- Singleton-style backward-compat shims ----------------------------------
# Old clients (and the existing DrafterPane render path during a phased
# rollout) read/write "the project's draft" through these endpoints. With
# multiple drafts per project allowed, "the" draft = the most recently
# touched one. PUT upserts into that latest draft, or creates a new one
# when the project has none yet.


@app.get("/projects/{project_id}/draft", response_model=DraftOut | None)
async def get_project_draft(
    project_id: str, member: CurrentMember = Depends(current_member)
) -> DraftOut | None:
    """Return the most-recently-touched draft for this project, or null
    if the project has none. Backward-compat for the original
    single-draft Drafter UI."""
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "SELECT id, project_id, title, body, updated_at, created_at "
            "FROM drafts WHERE project_id = %s AND member_id = %s "
            "ORDER BY updated_at DESC LIMIT 1",
            (pj, member.id),
        )
        row = await cur.fetchone()
    if not row:
        return None
    return DraftOut(
        id=str(row[0]),
        project_id=str(row[1]),
        title=row[2],
        body=row[3],
        updated_at=_iso(row[4]),
        created_at=_iso(row[5]),
    )


@app.put("/projects/{project_id}/draft", response_model=DraftOut)
async def put_project_draft(
    project_id: str,
    body: DraftPut,
    member: CurrentMember = Depends(current_member),
) -> DraftOut:
    """Backward-compat upsert. Writes into the most-recently-touched
    draft when one exists; otherwise creates a new draft. Prefer the
    explicit POST/PATCH/DELETE endpoints for new code."""
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        cur = await conn.execute(
            "SELECT id FROM drafts WHERE project_id = %s AND member_id = %s "
            "ORDER BY updated_at DESC LIMIT 1",
            (pj, member.id),
        )
        existing = await cur.fetchone()
        if existing:
            cur = await conn.execute(
                "UPDATE drafts SET title = %s, body = %s, updated_at = now() "
                "WHERE id = %s "
                "RETURNING id, project_id, title, body, updated_at, created_at",
                (body.title, body.body, existing[0]),
            )
        else:
            cur = await conn.execute(
                "INSERT INTO drafts (project_id, member_id, title, body) "
                "VALUES (%s, %s, %s, %s) "
                "RETURNING id, project_id, title, body, updated_at, created_at",
                (pj, member.id, body.title, body.body),
            )
        row = await cur.fetchone()
        await conn.commit()
    return DraftOut(
        id=str(row[0]),
        project_id=str(row[1]),
        title=row[2],
        body=row[3],
        updated_at=_iso(row[4]),
        created_at=_iso(row[5]),
    )


# ---------------------------------------------------------------------------
# Draft workflow — multi-stage agentic pipeline
# ---------------------------------------------------------------------------


class WorkflowPanelMember(BaseModel):
    name: str
    persona: str


class WorkflowInterview(BaseModel):
    """Pre-flight answers the orchestrator captures before running the pipeline.

    All fields have safe defaults so the UI can ship a "skip everything"
    button — the workflow still runs, just with the default panel +
    word count.
    """
    word_count: int = 800
    paragraph_structure: str = "intro · 3-4 body paragraphs · conclusion"
    panel: list[WorkflowPanelMember] = []
    web_search: bool = True
    target_material_count: int = 5
    max_iterations: int = 5
    style_notes: str = ""


class WorkflowStartIn(BaseModel):
    prompt: str
    interview: WorkflowInterview = WorkflowInterview()
    # Optional per-workflow LLM override (same format as ChatIn.model).
    model: str | None = None


class WorkflowOut(BaseModel):
    id: str
    draft_id: str
    project_id: str
    status: str
    iteration: int
    max_iterations: int
    raw_content: str | None
    polished_content: str | None
    final_content: str | None
    panel_votes: list[dict]
    events: list[dict]
    error: str | None
    created_at: str
    updated_at: str
    completed_at: str | None


_WORKFLOW_COLS = (
    "id, draft_id, project_id, status, iteration, max_iterations, "
    "raw_content, polished_content, final_content, panel_votes, "
    "events, error, created_at, updated_at, completed_at"
)


def _row_to_workflow(r: tuple) -> WorkflowOut:
    return WorkflowOut(
        id=str(r[0]),
        draft_id=str(r[1]),
        project_id=str(r[2]),
        status=r[3],
        iteration=r[4],
        max_iterations=r[5],
        raw_content=r[6],
        polished_content=r[7],
        final_content=r[8],
        panel_votes=r[9] or [],
        events=r[10] or [],
        error=r[11],
        created_at=_iso(r[12]),
        updated_at=_iso(r[13]),
        completed_at=_iso(r[14]) if r[14] else None,
    )


async def _resolve_draft(conn, draft_id: UUID, member: CurrentMember) -> tuple[UUID, UUID]:
    """Return ``(draft_id, project_id)`` if the caller owns this draft.

    404 collapses cross-workspace + missing so we don't leak draft IDs.
    """
    cur = await conn.execute(
        "SELECT d.id, d.project_id, d.member_id, p.workspace_id "
        "FROM drafts d JOIN projects p ON p.id = d.project_id "
        "WHERE d.id = %s",
        (draft_id,),
    )
    row = await cur.fetchone()
    if (not row or row[2] != member.id or row[3] != member.workspace_id):
        raise HTTPException(status_code=404, detail=_err("draft_not_found"))
    return row[0], row[1]


@app.post("/drafts/{draft_id}/workflow", response_model=WorkflowOut, status_code=201)
async def start_draft_workflow(
    draft_id: str,
    body: WorkflowStartIn,
    member: CurrentMember = Depends(current_member),
) -> WorkflowOut:
    """Kick off a multi-stage workflow that drafts → polishes → reviews.

    The pipeline runs as a background asyncio task so the request
    returns immediately with the workflow row at status
    ``gathering_materials``. Clients then poll
    ``GET /drafts/{id}/workflow`` (or subscribe to the SSE event stream)
    for live progress.

    If a workflow is already in flight for this draft, it is cancelled
    and a new one starts — only one active workflow per draft.
    """
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e

    if not body.prompt.strip():
        raise HTTPException(status_code=400, detail=_err("prompt_required"))

    async with get_conn() as conn:
        _, project_id = await _resolve_draft(conn, did, member)
        # Cancel any in-flight workflow for this draft so the new run
        # starts cleanly.
        await conn.execute(
            "UPDATE draft_workflows SET status='cancelled', updated_at=now(), "
            "completed_at=now() "
            "WHERE draft_id=%s AND status NOT IN "
            "      ('approved','failed','cancelled')",
            (did,),
        )
        # Insert the new workflow row.
        cur = await conn.execute(
            "INSERT INTO draft_workflows "
            "(draft_id, project_id, member_id, prompt, interview, status, max_iterations) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            f"RETURNING {_WORKFLOW_COLS}",
            (
                did, project_id, member.id, body.prompt,
                Jsonb(body.interview.model_dump()),
                "gathering_materials",
                body.interview.max_iterations,
            ),
        )
        row = await cur.fetchone()
        await conn.commit()

    workflow_id = row[0]
    # Fire and forget. The orchestrator commits state after every stage,
    # so any client polling the GET endpoint sees live updates.
    from .draft_workflow import run_workflow
    _spawn(
        run_workflow(
            workflow_id=workflow_id,
            project_id=project_id,
            member_id=member.id,
            prompt=body.prompt,
            interview_payload=body.interview.model_dump(),
            model_override=body.model,
        ),
        label=f"draft_workflow:{workflow_id}",
    )

    return _row_to_workflow(row)


@app.get("/drafts/{draft_id}/workflow", response_model=WorkflowOut | None)
async def get_active_workflow(
    draft_id: str, member: CurrentMember = Depends(current_member)
) -> WorkflowOut | None:
    """Return the most recent workflow row for this draft (any status).

    Returns null when the draft has never had a workflow.
    """
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e

    async with get_conn() as conn:
        await _resolve_draft(conn, did, member)
        cur = await conn.execute(
            f"SELECT {_WORKFLOW_COLS} FROM draft_workflows "
            f"WHERE draft_id=%s ORDER BY created_at DESC LIMIT 1",
            (did,),
        )
        row = await cur.fetchone()
    return _row_to_workflow(row) if row else None


@app.post("/drafts/{draft_id}/workflow/cancel", response_model=WorkflowOut)
async def cancel_draft_workflow(
    draft_id: str, member: CurrentMember = Depends(current_member)
) -> WorkflowOut:
    """Mark the active workflow as cancelled.

    The background task continues to completion of its current stage
    (the orchestrator doesn't poll a cancellation flag yet) but its
    next ``_set_status`` call writes over the cancelled state. The
    final state will be whichever wins the race; cancellation is a
    soft signal, not a kill.
    """
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e

    async with get_conn() as conn:
        await _resolve_draft(conn, did, member)
        cur = await conn.execute(
            "UPDATE draft_workflows SET status='cancelled', updated_at=now(), "
            "completed_at=now() "
            "WHERE draft_id=%s AND status NOT IN "
            "      ('approved','failed','cancelled') "
            f"RETURNING {_WORKFLOW_COLS}",
            (did,),
        )
        row = await cur.fetchone()
        await conn.commit()
    if not row:
        raise HTTPException(status_code=404, detail=_err("no_active_workflow"))
    return _row_to_workflow(row)


@app.get("/drafts/{draft_id}/workflow/events")
async def stream_workflow_events(
    draft_id: str, member: CurrentMember = Depends(current_member)
):
    """Server-sent events: emits the latest workflow state every 1.5s
    until the workflow reaches a terminal status (approved/failed/cancelled).

    The frontend uses this to drive a live progress panel. Polling-based
    rather than push-based so it integrates cleanly with the existing
    HTTP stack — no extra Redis pub/sub, no websocket lifecycle to manage.
    """
    try:
        did = UUID(draft_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_draft_id")) from e

    async with get_conn() as conn:
        await _resolve_draft(conn, did, member)

    terminal = {"approved", "failed", "cancelled"}

    async def event_stream():
        last_event_count = -1
        last_status: str | None = None
        deadline = time.monotonic() + 600  # 10-minute hard cap per stream
        while time.monotonic() < deadline:
            async with get_conn() as conn:
                cur = await conn.execute(
                    f"SELECT {_WORKFLOW_COLS} FROM draft_workflows "
                    f"WHERE draft_id=%s ORDER BY created_at DESC LIMIT 1",
                    (did,),
                )
                row = await cur.fetchone()
            if not row:
                yield _sse_event({"type": "error", "message": "no_workflow"})
                return
            wf = _row_to_workflow(row)
            # Only push when something has changed to keep traffic light.
            if wf.status != last_status or len(wf.events) != last_event_count:
                yield _sse_event({"type": "state", "workflow": wf.model_dump()})
                last_status = wf.status
                last_event_count = len(wf.events)
            if wf.status in terminal:
                yield _sse_event({"type": "done", "status": wf.status})
                return
            await asyncio.sleep(1.5)
        yield _sse_event({"type": "timeout"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class GraphNode(BaseModel):
    id: str
    type: Literal["turn", "chunk", "material", "concept"]
    label: str
    preview: str | None = None
    chunk_id: int | None = None
    material_id: str | None = None
    turn_seq: int | None = None
    weight: int | None = None  # for concepts: number of materials it appears in


class GraphEdge(BaseModel):
    source: str
    target: str
    kind: Literal["citation", "provenance", "mention", "next"]


class GraphOut(BaseModel):
    mode: Literal["citations", "concepts", "reasoning"]
    nodes: list[GraphNode]
    edges: list[GraphEdge]


async def _build_reasoning_graph(conn, session_id: UUID) -> GraphOut:
    """Reasoning graph: turn-by-turn flow plus the citations that grounded
    each turn. Currently only includes turns that produced citations —
    "reasoning steps anchored in evidence". Turns without citations
    (e.g. a clarifying question with no retrieval grounding) aren't yet
    surfaced; expanding this requires walking the LangGraph checkpointer
    history rather than reading message_citations alone.
    """
    cur = await conn.execute(
        """
        SELECT mc.turn_seq, mc.marker_n, mc.chunk_id, mc.material_id,
               c.text, m.title
        FROM message_citations mc
        JOIN chunks c    ON c.id = mc.chunk_id
        JOIN materials m ON m.id = mc.material_id
        WHERE mc.session_id = %s
        ORDER BY mc.turn_seq, mc.marker_n
        """,
        (session_id,),
    )
    rows = await cur.fetchall()
    if not rows:
        return GraphOut(mode="reasoning", nodes=[], edges=[])

    nodes: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def _add_edge(source: str, target: str, kind: str) -> None:
        key = (source, target, kind)
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append(GraphEdge(source=source, target=target, kind=kind))  # type: ignore[arg-type]

    turn_seqs = sorted({r[0] for r in rows})
    for ts in turn_seqs:
        nid = f"turn:{ts}"
        nodes[nid] = GraphNode(
            id=nid, type="turn", label=f"Turn {ts + 1}", turn_seq=ts
        )

    # Sequential reasoning-flow edges between consecutive grounded turns.
    for prev, curr in zip(turn_seqs, turn_seqs[1:]):
        _add_edge(f"turn:{prev}", f"turn:{curr}", "next")

    # Per-citation edges: turn → chunk, chunk → material.
    for turn_seq, marker_n, chunk_id, material_id, chunk_text, material_title in rows:
        chunk_node_id = f"chunk:{chunk_id}"
        material_node_id = f"material:{material_id}"

        if chunk_node_id not in nodes:
            preview = (chunk_text or "")[:120]
            if chunk_text and len(chunk_text) > 120:
                preview += "…"
            nodes[chunk_node_id] = GraphNode(
                id=chunk_node_id,
                type="chunk",
                label=f"[{marker_n}]",
                preview=preview,
                chunk_id=chunk_id,
            )
        if material_node_id not in nodes:
            nodes[material_node_id] = GraphNode(
                id=material_node_id,
                type="material",
                label=material_title or "untitled",
                material_id=str(material_id),
            )

        _add_edge(f"turn:{turn_seq}", chunk_node_id, "citation")
        _add_edge(chunk_node_id, material_node_id, "provenance")

    return GraphOut(mode="reasoning", nodes=list(nodes.values()), edges=edges)


async def _build_concepts_graph(conn, session_id: UUID) -> GraphOut:
    """Concepts graph: read concepts for cited materials from the
    ``material_concepts`` table populated by the ingestion pipeline.

    Falls back to a runtime extraction over the material's title +
    arXiv abstract when the table has no rows for a material — this
    keeps the graph populated for legacy materials ingested before
    migration 0015.
    """
    cur = await conn.execute(
        """
        SELECT DISTINCT m.id, m.title, m.metadata
        FROM message_citations mc
        JOIN materials m ON m.id = mc.material_id
        WHERE mc.session_id = %s
        ORDER BY m.id
        """,
        (session_id,),
    )
    rows = await cur.fetchall()
    if not rows:
        return GraphOut(mode="concepts", nodes=[], edges=[])

    material_ids = [r[0] for r in rows]
    # Bulk-fetch concepts for every cited material in one round trip.
    cur = await conn.execute(
        "SELECT material_id, concept FROM material_concepts "
        "WHERE material_id = ANY(%s)",
        (material_ids,),
    )
    concept_rows = await cur.fetchall()
    concepts_by_material: dict[str, set[str]] = {}
    for mid, c in concept_rows:
        concepts_by_material.setdefault(str(mid), set()).add(c)

    per_material: dict[str, tuple[str, set[str]]] = {}
    for mid, title, metadata in rows:
        key = str(mid)
        cs = concepts_by_material.get(key)
        if cs is None:
            # Legacy fallback: extract on the fly when the pipeline
            # never populated material_concepts for this row.
            text_parts: list[str] = []
            if title:
                text_parts.append(title)
            if metadata and isinstance(metadata, dict):
                am = metadata.get("arxiv_meta") or {}
                if am.get("abstract"):
                    text_parts.append(am["abstract"])
            cs = extract_concepts(
                ". ".join(p.rstrip(".") for p in text_parts if p)
            )
        per_material[key] = (title or "untitled", cs)

    concept_weight: dict[str, int] = {}
    for _, concepts in per_material.values():
        for c in concepts:
            concept_weight[c] = concept_weight.get(c, 0) + 1

    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    for mid, (label, _) in per_material.items():
        nodes.append(GraphNode(
            id=f"material:{mid}", type="material", label=label, material_id=mid,
        ))
    for c, w in concept_weight.items():
        nodes.append(GraphNode(id=f"concept:{c}", type="concept", label=c, weight=w))
    for mid, (_label, concepts) in per_material.items():
        for c in concepts:
            edges.append(GraphEdge(
                source=f"concept:{c}", target=f"material:{mid}", kind="mention",
            ))
    return GraphOut(mode="concepts", nodes=nodes, edges=edges)


@app.get("/projects/{project_id}/map", response_model=GraphOut)
async def project_map(
    project_id: str,
    include_weak: bool = False,
    member: CurrentMember = Depends(current_member),
) -> GraphOut:
    """Project-wide materials map — the "wiki view" of every ingested
    source in the project.

    Topology: every material is a node; for each material we extract
    concepts from its title + (when present) its arXiv abstract; concepts
    that appear in 2+ materials become hub nodes that visually link the
    related sources together. This is the always-on overview that lets
    a researcher see the shape of their corpus before they start a chat
    session.

    Empty when the project has no materials yet — the UI then shows the
    "ingest some sources" empty state.
    """
    pj = _parse_uuid(project_id, "invalid_project_id")

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, pj, member.workspace_id)
        # Quarantine weak filings (chat-filed answers with zero
        # supporting citations) from the default Map view per the
        # compounding-knowledge spec. Real sources (no
        # `connection_strength` metadata) always pass through; only
        # filings explicitly tagged 'weak' are hidden.
        weak_clause = "" if include_weak else (
            " AND (metadata->>'connection_strength' IS NULL "
            "OR metadata->>'connection_strength' <> 'weak')"
        )
        cur = await conn.execute(
            "SELECT id, title FROM materials "
            f"WHERE project_id = %s{weak_clause} ORDER BY created_at DESC",
            (pj,),
        )
        rows = await cur.fetchall()
        if not rows:
            return GraphOut(mode="concepts", nodes=[], edges=[])
        material_ids = [r[0] for r in rows]
        # Bulk-fetch concepts from the ingestion pipeline's table — no
        # runtime extraction. Materials ingested pre-0015 fall through
        # the inner ``if cs is None`` branch and pick up their concepts
        # from the title/abstract regex as a last-resort fallback.
        cur = await conn.execute(
            "SELECT material_id, concept FROM material_concepts "
            "WHERE material_id = ANY(%s)",
            (material_ids,),
        )
        concept_rows = await cur.fetchall()
        # Hoist the existing-id set out of the any() generator — otherwise
        # we'd rebuild it once per material on the worst case.
        existing_mids = {cr[0] for cr in concept_rows}
        # Also pull metadata for legacy fallback only when needed.
        legacy_meta: dict[str, dict] = {}
        if any(r[0] not in existing_mids for r in rows):
            cur = await conn.execute(
                "SELECT id, title, metadata FROM materials "
                "WHERE id = ANY(%s)",
                (material_ids,),
            )
            for mid, title, metadata in await cur.fetchall():
                legacy_meta[str(mid)] = {"title": title, "metadata": metadata}

    concepts_by_material: dict[str, set[str]] = {}
    for mid, c in concept_rows:
        concepts_by_material.setdefault(str(mid), set()).add(c)

    per_material: dict[str, tuple[str, set[str]]] = {}
    for mid, title in rows:
        key = str(mid)
        cs = concepts_by_material.get(key)
        if cs is None:
            meta = legacy_meta.get(key) or {}
            text_parts: list[str] = []
            if meta.get("title"):
                text_parts.append(meta["title"])
            md = meta.get("metadata")
            if md and isinstance(md, dict):
                am = md.get("arxiv_meta") or {}
                if am.get("abstract"):
                    text_parts.append(am["abstract"])
            cs = extract_concepts(
                ". ".join(p.rstrip(".") for p in text_parts if p)
            )
        per_material[key] = (title or "untitled", cs)

    concept_weight: dict[str, int] = {}
    for _, concepts in per_material.values():
        for c in concepts:
            concept_weight[c] = concept_weight.get(c, 0) + 1
    bridging = {c for c, w in concept_weight.items() if w >= 2}

    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []

    for mid, (label, _) in per_material.items():
        nodes.append(GraphNode(
            id=f"material:{mid}", type="material", label=label, material_id=mid,
        ))
    for c in bridging:
        nodes.append(GraphNode(
            id=f"concept:{c}", type="concept", label=c,
            weight=concept_weight[c],
        ))
    for mid, (_label, concepts) in per_material.items():
        for c in concepts:
            if c not in bridging:
                continue
            edges.append(GraphEdge(
                source=f"concept:{c}",
                target=f"material:{mid}",
                kind="mention",
            ))

    return GraphOut(mode="concepts", nodes=nodes, edges=edges)


@app.get("/sessions/{session_id}/graph", response_model=GraphOut)
async def session_graph(
    session_id: str,
    mode: Literal["citations", "concepts", "reasoning"] = "citations",
    member: CurrentMember = Depends(current_member),
) -> GraphOut:
    """Workspace graph pane data feed.

    ``citations`` is implemented: edges are
    ``assistant_turn → chunk → material`` derived from message_citations.
    ``concepts`` and ``reasoning`` are deferred — they need entity
    extraction and step decomposition pipelines respectively.
    """
    sid = _parse_uuid(session_id, "invalid_session_id")

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id "
            "WHERE s.id=%s AND s.created_by_member_id=%s "
            "AND p.workspace_id=%s",
            (sid, member.id, member.workspace_id),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail=_err("session_not_found"))

        if mode == "concepts":
            return await _build_concepts_graph(conn, sid)
        if mode == "reasoning":
            return await _build_reasoning_graph(conn, sid)
        # mode is constrained to the Literal — fall through means citations.

        cur = await conn.execute(
            """
            SELECT mc.turn_seq, mc.marker_n, mc.chunk_id, mc.material_id,
                   c.text, m.title
            FROM message_citations mc
            JOIN chunks c    ON c.id = mc.chunk_id
            JOIN materials m ON m.id = mc.material_id
            WHERE mc.session_id = %s
            ORDER BY mc.turn_seq, mc.marker_n
            """,
            (sid,),
        )
        rows = await cur.fetchall()

    nodes: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def _add_edge(source: str, target: str, kind: str) -> None:
        key = (source, target, kind)
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append(GraphEdge(source=source, target=target, kind=kind))  # type: ignore[arg-type]

    for turn_seq, marker_n, chunk_id, material_id, chunk_text, material_title in rows:
        turn_node_id = f"turn:{turn_seq}"
        chunk_node_id = f"chunk:{chunk_id}"
        material_node_id = f"material:{material_id}"

        if turn_node_id not in nodes:
            nodes[turn_node_id] = GraphNode(
                id=turn_node_id,
                type="turn",
                label=f"Turn {turn_seq + 1}",
                turn_seq=turn_seq,
            )
        if chunk_node_id not in nodes:
            preview = (chunk_text or "")[:120]
            if chunk_text and len(chunk_text) > 120:
                preview += "…"
            nodes[chunk_node_id] = GraphNode(
                id=chunk_node_id,
                type="chunk",
                label=f"[{marker_n}]",
                preview=preview,
                chunk_id=chunk_id,
            )
        if material_node_id not in nodes:
            nodes[material_node_id] = GraphNode(
                id=material_node_id,
                type="material",
                label=material_title or "untitled",
                material_id=str(material_id),
            )

        _add_edge(turn_node_id, chunk_node_id, "citation")
        _add_edge(chunk_node_id, material_node_id, "provenance")

    return GraphOut(mode="citations", nodes=list(nodes.values()), edges=edges)


@app.get("/sessions/{session_id}/export/citations.bib")
async def export_session_citations_bibtex(
    session_id: str, member: CurrentMember = Depends(current_member)
) -> Response:
    """Export the session's cited materials as BibTeX.

    Cited = anything in ``message_citations`` for this session. Each
    distinct material renders as one entry; arXiv materials use
    ``archivePrefix``/``eprint``, others use plain ``@misc`` with title +
    URL + ingest-date note.
    """
    sid = _parse_uuid(session_id, "invalid_session_id")
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id FROM sessions "
            "WHERE id=%s AND created_by_member_id=%s AND workspace_id=%s",
            (sid, member.id, member.workspace_id),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail=_err("session_not_found"))

        cur = await conn.execute(
            """
            SELECT DISTINCT m.id, m.title, m.uri, m.source_type, m.metadata, m.created_at
            FROM message_citations mc
            JOIN materials m ON m.id = mc.material_id
            WHERE mc.session_id = %s
            ORDER BY m.created_at
            """,
            (sid,),
        )
        rows = await cur.fetchall()

    materials = [
        CitationMaterial(
            id=str(r[0]),
            title=r[1],
            uri=r[2],
            source_type=r[3],
            metadata=r[4] or {},
            created_at=r[5],
        )
        for r in rows
    ]
    body = to_bibtex(materials)
    return Response(
        content=body,
        media_type="application/x-bibtex",
        headers={
            "Content-Disposition": f'attachment; filename="notesci-{session_id}.bib"',
        },
    )


class AuditEntryOut(BaseModel):
    id: int
    workspace_id: str
    actor_member_id: str | None
    action: str
    target_type: str | None
    target_id: str | None
    metadata: dict
    created_at: str


@app.get("/audit", response_model=list[AuditEntryOut])
async def list_audit_log(
    member: CurrentMember = Depends(current_member),
    limit: int = 50,
    offset: int = 0,
    action: str | None = None,
    actor_member_id: str | None = None,
) -> list[AuditEntryOut]:
    """Workspace audit log. Backs the dashboard's Workspace > Audit log page.

    Admin-gated: members shouldn't see workspace-wide admin actions
    (mcp.install, member.update, ...) — those leak operational structure
    that's only useful to owners/admins.
    """
    _require_workspace_admin(member)
    if not 1 <= limit <= 200:
        raise HTTPException(status_code=400, detail=_err("invalid_limit"))
    if offset < 0:
        raise HTTPException(status_code=400, detail=_err("invalid_offset"))

    where = ["workspace_id = %s"]
    params: list = [member.workspace_id]
    if action:
        where.append("action = %s")
        params.append(action)
    if actor_member_id:
        try:
            params.append(UUID(actor_member_id))
            where.append("actor_member_id = %s")
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=_err("invalid_actor_member_id")
            ) from e
    params.extend([limit, offset])

    async with get_conn() as conn:
        cur = await conn.execute(
            f"""
            SELECT id, workspace_id, actor_member_id, action,
                   target_type, target_id, metadata, created_at
            FROM audit_log
            WHERE {' AND '.join(where)}
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
            """,
            params,
        )
        rows = await cur.fetchall()
    return [
        AuditEntryOut(
            id=r[0],
            workspace_id=str(r[1]),
            actor_member_id=str(r[2]) if r[2] else None,
            action=r[3],
            target_type=r[4],
            target_id=r[5],
            metadata=r[6] or {},
            created_at=_iso(r[7]),
        )
        for r in rows
    ]


@app.get("/members", response_model=list[MemberOut])
async def list_workspace_members(
    limit: int = 50,
    offset: int = 0,
    member: CurrentMember = Depends(current_member),
) -> list[MemberOut]:
    """List members in the caller's workspace. Paginated.

    Backs the dashboard's Members & invites page. Default limit 50,
    max 200. Newest first so the most recently joined members surface
    on the first page. Only the columns the list view needs are
    projected — full profile (ORCID, topics, affiliation) is available
    via ``GET /me`` for the caller and would only be valuable here if
    we ever build a workspace-wide profile browser.
    """
    if not 1 <= limit <= 200:
        raise HTTPException(status_code=400, detail=_err("invalid_limit"))
    if offset < 0:
        raise HTTPException(status_code=400, detail=_err("invalid_offset"))
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, workspace_id, email, display_name, role, "
            "       email_verified_at "
            "FROM members WHERE workspace_id=%s "
            "ORDER BY created_at DESC, id "
            "LIMIT %s OFFSET %s",
            (member.workspace_id, limit, offset),
        )
        rows = await cur.fetchall()
    return [
        MemberOut(
            id=str(r[0]),
            workspace_id=str(r[1]),
            email=r[2],
            display_name=r[3],
            role=r[4],
            email_verified=r[5] is not None,
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# MCP host — install records, scope grants, audit log.
#
# Backs the dashboard's "Connections · MCP marketplace" centerpiece. This
# slice is data-only: it persists installs and exposes them. Wiring the
# agent to actually invoke tools from installed servers is the next slice.
# ---------------------------------------------------------------------------


class McpServerIn(BaseModel):
    slug: str = Field(..., min_length=1, max_length=64)
    name: str = Field(..., min_length=1, max_length=200)
    transport: Literal["http", "stdio", "sse"]
    config: dict = Field(default_factory=dict)
    grants: dict = Field(default_factory=dict)


class McpServerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    config: dict | None = None
    grants: dict | None = None
    enabled: bool | None = None


class McpServerOut(BaseModel):
    id: str
    workspace_id: str
    installed_by: str | None
    slug: str
    name: str
    transport: str
    config: dict
    grants: dict
    enabled: bool
    created_at: str
    updated_at: str


class McpCallOut(BaseModel):
    id: int
    server_id: str
    tool_name: str
    arguments: dict | None
    result_summary: str | None
    error: str | None
    duration_ms: int | None
    created_at: str


class McpServerStatusOut(BaseModel):
    status: Literal["ready", "failed", "missing_config"]
    tool_count: int
    error: str | None = None
    checked_at: str


def _mcp_row_to_out(r) -> McpServerOut:
    """Serialise an ``mcp_servers`` row for the API.

    Secret-ish fields under ``config.headers`` (Authorization, api_key,
    token, …) and *every* value under ``config.env`` are replaced with
    the literal ``"***"`` — see :func:`crypto.redact_config_for_api`.
    The runtime config used by the MCP client is read separately via
    :func:`crypto.decrypt_config_secrets` and never returned to the API
    surface.
    """
    return McpServerOut(
        id=str(r[0]),
        workspace_id=str(r[1]),
        installed_by=str(r[2]) if r[2] else None,
        slug=r[3],
        name=r[4],
        transport=r[5],
        config=redact_config_for_api(r[6] or {}),
        grants=r[7] or {},
        enabled=r[8],
        created_at=_iso(r[9]),
        updated_at=_iso(r[10]),
    )


def _require_workspace_admin(member: CurrentMember) -> None:
    """Raise 403 when the caller isn't a workspace admin.

    MCP install / update / delete endpoints are restricted to admins
    because a malicious config (stdio command, attacker-controlled URL)
    can RCE the backend or exfiltrate workspace data. ``admin`` is the
    only elevated role the schema permits (see the ``members_role_check``
    constraint) — the workspace's first claimer is granted it.
    """
    if member.role != "admin":
        raise HTTPException(
            status_code=403,
            detail=_err(
                "forbidden", "Only workspace admins can manage MCP servers."
            ),
        )


_MCP_COLUMNS = (
    "id, workspace_id, installed_by, slug, name, transport, "
    "config, grants, enabled, created_at, updated_at"
)


# --- LLM provider availability + model catalog -----------------------------


class ProviderInfo(BaseModel):
    id: str
    display_name: str
    has_key: bool
    env_var: str


class ModelInfo(BaseModel):
    id: str
    provider_id: str
    label: str
    description: str
    kind: Literal["chat", "reasoning"]
    available: bool
    suggested_for: list[str] = []


class EmbeddingAvailability(BaseModel):
    available: bool
    model: str | None
    provider_id: str | None
    label: str | None
    supported_provider_ids: list[str]


class ProvidersAvailableOut(BaseModel):
    providers: list[ProviderInfo]
    models: list[ModelInfo]
    # Operator-set fallback model. Null when ``NOTESCI_DEFAULT_MODEL`` is
    # unset — that's the deliberate stance: the system doesn't impose a
    # default; users choose. The UI uses ``fallback_model`` (always set
    # when at least one provider key exists) to show what would actually
    # be used if the user hasn't picked.
    default_model: str | None
    # First model the UI should auto-pick when the user's saved
    # preference is unavailable (e.g. they picked GPT-5 but the OpenAI
    # key is no longer configured). When ``default_model`` is set and
    # available, that's used; otherwise the first available model wins.
    # Null only when NO provider keys are configured.
    fallback_model: str | None
    embedding: EmbeddingAvailability


@app.get("/providers/available", response_model=ProvidersAvailableOut)
async def providers_available(
    _member: CurrentMember = Depends(current_member),
) -> ProvidersAvailableOut:
    """Report which providers have keys + the canonical model catalog.

    Auth-gated: callers must be signed in to learn the server's key
    configuration (don't expose the surface to unauthenticated probes).

    Drives:
      * Preferences default-model dropdown
      * In-chat model pill
      * Per-stage workflow model pickers
    """
    providers_out: list[ProviderInfo] = []
    available_provider_ids: set[str] = set()
    for p in PROVIDERS:
        ok = provider_has_key(p, settings)
        if ok:
            available_provider_ids.add(p.id)
        providers_out.append(
            ProviderInfo(
                id=p.id, display_name=p.display_name, has_key=ok, env_var=p.env_var,
            )
        )

    models_out: list[ModelInfo] = []
    for m in MODELS:
        models_out.append(
            ModelInfo(
                id=m.id,
                provider_id=m.provider_id,
                label=m.label,
                description=m.description,
                kind=m.kind,
                available=m.provider_id in available_provider_ids,
                suggested_for=list(m.suggested_for),
            )
        )

    # `default_model` is what the operator opted-in to; it can be None.
    # `fallback_model` is what the system will ACTUALLY use when the user
    # has no preference — operator default if available, else the first
    # available model. This is what the UI surfaces in the picker.
    default_model = settings.notesci_default_model
    fallback: str | None = None
    if default_model and any(
        mi.id == default_model and mi.available for mi in models_out
    ):
        fallback = default_model
    else:
        fallback = next((mi.id for mi in models_out if mi.available), None)

    embedding_model = resolve_embedding_model()
    embedding_provider = (
        embedding_model.split(":", 1)[0]
        if embedding_model and ":" in embedding_model
        else embedding_model
    )
    embedding_labels = {
        "openai:text-embedding-3-small": "OpenAI · text-embedding-3-small",
        "google_genai:gemini-embedding-001": "Google · gemini-embedding-001",
    }
    if embedding_model and embedding_model.startswith("custom:"):
        embedding_labels[embedding_model] = f"Custom · {embedding_model.split(':', 1)[1]}"

    return ProvidersAvailableOut(
        providers=providers_out,
        models=models_out,
        default_model=default_model,
        fallback_model=fallback,
        embedding=EmbeddingAvailability(
            available=embedding_model is not None,
            model=embedding_model,
            provider_id=embedding_provider,
            label=embedding_labels.get(embedding_model or "", embedding_model),
            supported_provider_ids=["openai", "google_genai", "custom"],
        ),
    )


# --- Provider API keys (per-workspace, paste-once) ------------------------


_VALID_PROVIDER_IDS = {p.id for p in PROVIDERS}


class ProviderKeyStatus(BaseModel):
    provider_id: str
    display_name: str
    env_var: str
    set: bool
    last4: str | None = None
    updated_at: str | None = None


class ProviderKeysOut(BaseModel):
    keys: list[ProviderKeyStatus]


class CustomEmbeddingConfigOut(BaseModel):
    enabled: bool
    base_url: str
    model: str
    dimension: int = EMBEDDING_DIM
    api_key_set: bool = False
    updated_at: str | None = None


class CustomEmbeddingConfigIn(BaseModel):
    enabled: bool = False
    base_url: str = Field(default="", max_length=2048)
    model: str = Field(default="", max_length=256)
    api_key: str | None = Field(default=None, max_length=2048)
    dimension: int = EMBEDDING_DIM


class ProviderKeyIn(BaseModel):
    api_key: str = Field(min_length=1, max_length=512)


@app.get("/me/provider-keys", response_model=ProviderKeysOut)
async def get_provider_keys(
    member: CurrentMember = Depends(current_member),
) -> ProviderKeysOut:
    """Status of every provider's stored API key.

    Returns presence + last-4 only — the secret is never echoed back.
    Combines DB-stored keys (workspace-scoped, written via PUT below)
    with the env-var fallback so the UI can show "set via env" when an
    operator wired a key through ``/etc/notesci/notesci.conf``.
    """
    from .crypto import decrypt_str
    db_keys: dict[str, tuple[str, str]] = {}
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT provider, encrypted_key, updated_at FROM provider_keys "
            "WHERE workspace_id = %s",
            (member.workspace_id,),
        )
        for prov, enc, ts in await cur.fetchall():
            try:
                plain = decrypt_str(enc)
            except Exception:
                plain = ""
            db_keys[prov] = (plain, ts.isoformat() if ts else "")

    out: list[ProviderKeyStatus] = []
    for p in PROVIDERS:
        db_plain, db_ts = db_keys.get(p.id, ("", ""))
        env_val = os.environ.get(p.env_var, "") or ""
        plain = db_plain or env_val
        is_set = bool(plain.strip())
        out.append(
            ProviderKeyStatus(
                provider_id=p.id,
                display_name=p.display_name,
                env_var=p.env_var,
                set=is_set,
                last4=plain[-4:] if is_set and len(plain) >= 4 else None,
                updated_at=db_ts or None,
            )
        )
    return ProviderKeysOut(keys=out)


@app.put("/me/provider-keys/{provider_id}", status_code=204)
async def put_provider_key(
    provider_id: str,
    body: ProviderKeyIn,
    member: CurrentMember = Depends(current_member),
) -> Response:
    """Upsert a provider's API key for the caller's workspace.

    The key is fernet-encrypted at rest (when ``NOTESCI_SECRET_KEY`` is
    configured) and immediately applied to runtime settings + env so
    the next chat request picks it up without restarting the backend.
    """
    if provider_id not in _VALID_PROVIDER_IDS:
        raise HTTPException(404, "provider_not_found")
    from .crypto import encrypt_str
    from .agent.providers import apply_runtime_key

    enc = encrypt_str(body.api_key.strip())
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO provider_keys "
            "  (workspace_id, provider, encrypted_key, updated_at) "
            "VALUES (%s, %s, %s, now()) "
            "ON CONFLICT (workspace_id, provider) DO UPDATE SET "
            "  encrypted_key = EXCLUDED.encrypted_key, updated_at = now()",
            (member.workspace_id, provider_id, enc),
        )
        await conn.commit()
    apply_runtime_key(provider_id, body.api_key.strip())
    return Response(status_code=204)


@app.delete("/me/provider-keys/{provider_id}", status_code=204)
async def delete_provider_key(
    provider_id: str,
    member: CurrentMember = Depends(current_member),
) -> Response:
    """Remove a provider's stored API key.

    Falls back to the env-var value (if any) for subsequent requests.
    The runtime env var is only cleared when no env-var fallback was
    set in the first place — operator-set env keys take precedence
    again once the per-workspace override is gone.
    """
    if provider_id not in _VALID_PROVIDER_IDS:
        raise HTTPException(404, "provider_not_found")
    from .agent.providers import apply_runtime_key
    async with get_conn() as conn:
        await conn.execute(
            "DELETE FROM provider_keys WHERE workspace_id = %s AND provider = %s",
            (member.workspace_id, provider_id),
        )
        await conn.commit()
    # If an env-var fallback exists, re-apply it; otherwise clear.
    env_var = next((p.env_var for p in PROVIDERS if p.id == provider_id), None)
    apply_runtime_key(provider_id, os.environ.get(env_var or "", ""))
    return Response(status_code=204)


@app.get("/me/embedding-config", response_model=CustomEmbeddingConfigOut)
async def get_embedding_config(
    member: CurrentMember = Depends(current_member),
) -> CustomEmbeddingConfigOut:
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT enabled, base_url, model, encrypted_api_key, dimension, updated_at "
            "FROM workspace_embedding_config WHERE workspace_id = %s",
            (member.workspace_id,),
        )
        row = await cur.fetchone()
    if not row:
        return CustomEmbeddingConfigOut(
            enabled=False,
            base_url="",
            model="",
            dimension=EMBEDDING_DIM,
            api_key_set=False,
            updated_at=None,
        )
    return CustomEmbeddingConfigOut(
        enabled=bool(row[0]),
        base_url=row[1] or "",
        model=row[2] or "",
        dimension=row[4] or EMBEDDING_DIM,
        api_key_set=bool(row[3]),
        updated_at=_iso(row[5]),
    )


@app.put("/me/embedding-config", response_model=CustomEmbeddingConfigOut)
async def put_embedding_config(
    body: CustomEmbeddingConfigIn,
    member: CurrentMember = Depends(current_member),
) -> CustomEmbeddingConfigOut:
    if body.dimension != EMBEDDING_DIM:
        raise HTTPException(
            status_code=400,
            detail=_err(
                "invalid_embedding_dimension",
                f"Custom embedding endpoints must return {EMBEDDING_DIM}-dimensional vectors.",
            ),
        )
    base_url = body.base_url.strip().rstrip("/")
    model = body.model.strip()
    if body.enabled and (not base_url or not model):
        raise HTTPException(
            status_code=400,
            detail=_err(
                "embedding_config_incomplete",
                "Base URL and model are required when custom embeddings are enabled.",
            ),
        )
    from .crypto import decrypt_str, encrypt_str

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT encrypted_api_key FROM workspace_embedding_config "
            "WHERE workspace_id = %s",
            (member.workspace_id,),
        )
        existing = await cur.fetchone()
        existing_key = existing[0] if existing else ""
        encrypted_key = (
            encrypt_str(body.api_key.strip())
            if body.api_key is not None and body.api_key.strip()
            else existing_key
        )
        await conn.execute(
            "INSERT INTO workspace_embedding_config "
            "(workspace_id, enabled, base_url, model, encrypted_api_key, dimension, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, now()) "
            "ON CONFLICT (workspace_id) DO UPDATE SET "
            "enabled = EXCLUDED.enabled, base_url = EXCLUDED.base_url, "
            "model = EXCLUDED.model, encrypted_api_key = EXCLUDED.encrypted_api_key, "
            "dimension = EXCLUDED.dimension, updated_at = now()",
            (
                member.workspace_id,
                body.enabled,
                base_url,
                model,
                encrypted_key,
                EMBEDDING_DIM,
            ),
        )
        await conn.commit()

    apply_custom_embedding_config(
        enabled=body.enabled,
        base_url=base_url,
        model=model,
        api_key=decrypt_str(encrypted_key),
        dimension=EMBEDDING_DIM,
    )
    return await get_embedding_config(member)


# --- Skills (proprietary domain expertise the agent activates) ------------


class SkillTrigger(BaseModel):
    """Human-readable summary of one regex pattern. Compiled patterns
    aren't sent over the wire — we surface a sanitised version so the
    user sees what kinds of phrases activate the skill without having
    to parse regex syntax."""
    sample: str


class SkillInfo(BaseModel):
    name: str
    display_name: str
    description: str
    triggers: list[SkillTrigger]
    installed: bool = False
    enabled: bool = False
    source: str = "builtin"


class SkillInstallOut(BaseModel):
    name: str
    installed: bool
    enabled: bool
    updated_at: str


class SkillInstallPatch(BaseModel):
    enabled: bool | None = None


async def _workspace_skills(
    conn,
    workspace_id: UUID,
) -> tuple[dict[str, tuple[bool, bool]], dict[str, str | None]]:
    """Return installed/disabled status + installer identity for workspace skills.

    Returns:
        installed: skill name -> (installed, enabled)
        installed_by: skill name -> member id who last touched install
    """
    cache_key = str(workspace_id)
    cached = _WORKSPACE_SKILLS_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < _WORKSPACE_SKILLS_TTL_SECONDS:
        installed, installed_by = cached[1]
        return dict(installed), dict(installed_by)

    cur = await conn.execute(
        "SELECT skill_name, enabled, installed_by FROM workspace_skill_installations "
        "WHERE workspace_id=%s",
        (workspace_id,),
    )
    installed: dict[str, tuple[bool, bool]] = {}
    installed_by: dict[str, str | None] = {}
    for name, enabled, by in await cur.fetchall():
        if isinstance(name, str):
            n = name.strip().lower()
            installed[n] = (True, bool(enabled))
            installed_by[n] = str(by) if by else None
    _WORKSPACE_SKILLS_CACHE[cache_key] = (
        time.monotonic(),
        (dict(installed), dict(installed_by)),
    )
    return installed, installed_by


_WORKSPACE_SKILLS_TTL_SECONDS = 300
_WORKSPACE_SKILLS_CACHE: dict[
    str,
    tuple[float, tuple[dict[str, tuple[bool, bool]], dict[str, str | None]]],
] = {}


def _invalidate_workspace_skills_cache(workspace_id: UUID) -> None:
    _WORKSPACE_SKILLS_CACHE.pop(str(workspace_id), None)


@app.get("/skills", response_model=list[SkillInfo])
async def list_skills(
    member: CurrentMember = Depends(current_member),
) -> list[SkillInfo]:
    """Catalog of installable skills with workspace install state.

    Skills only affect the session when enabled here, so users can
    manage context load and install only what each workspace needs.
    """
    async with get_conn() as conn:
        installed, _ = await _workspace_skills(conn, member.workspace_id)

    out: list[SkillInfo] = []
    for s in all_skills():
        is_installed, is_enabled = installed.get(s.name, (False, False))
        triggers = [SkillTrigger(sample=_humanise_pattern(p.pattern)) for p in s.patterns]
        out.append(
            SkillInfo(
                name=s.name,
                display_name=s.display_name,
                description=s.description,
                triggers=triggers,
                installed=is_installed,
                enabled=is_enabled if is_installed else False,
                source="user" if not is_builtin_skill(s.name) else "builtin",
            )
        )
    return out


@app.get("/skills/installed", response_model=list[str])
async def list_installed_skills(member: CurrentMember = Depends(current_member)) -> list[str]:
    """Return workspace-installed skill names, ordered for stable UI output."""
    async with get_conn() as conn:
        installed, _ = await _workspace_skills(conn, member.workspace_id)
    return sorted(name for name, state in installed.items() if state[0] and state[1])


@app.post("/skills/{skill_name}/install", response_model=SkillInstallOut, status_code=201)
async def install_skill(
    skill_name: str,
    member: CurrentMember = Depends(current_member),
) -> SkillInstallOut:
    """Enable and mark a skill for this workspace.

    Unknown names return 404. Re-installing an existing row idempotently
    flips it on and rewrites the installer metadata.
    """
    skill = get_skill(skill_name)
    if skill is None:
        raise HTTPException(status_code=404, detail=_err("skill_not_found"))

    async with get_conn() as conn:
        row = await conn.execute(
            "INSERT INTO workspace_skill_installations "
            "(workspace_id, installed_by, skill_name, enabled, updated_at) "
            "VALUES (%s, %s, %s, TRUE, now()) "
            "ON CONFLICT (workspace_id, skill_name) "
            "DO UPDATE SET enabled = TRUE, installed_by = EXCLUDED.installed_by, "
            "updated_at = now() "
            "RETURNING updated_at, installed_by",
            (member.workspace_id, member.id, skill.name),
        )
        updated = await row.fetchone()
        await conn.commit()
    _invalidate_workspace_skills_cache(member.workspace_id)

    if not updated:
        raise HTTPException(status_code=500, detail=_err("skill_install_failed"))

    installed_by = str(updated[1]) if updated[1] else None
    # Keep audit visibility for workspace diagnostics.
    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="skill.install",
        target_type="skill",
        target_id=skill.name,
        metadata={"installed_by": installed_by},
    )

    return SkillInstallOut(
        name=skill.name,
        installed=True,
        enabled=True,
        updated_at=_iso(updated[0]),
    )


@app.post("/skills/{skill_name}/uninstall", status_code=204)
async def uninstall_skill(
    skill_name: str,
    member: CurrentMember = Depends(current_member),
) -> None:
    """Remove one workspace skill installation.

    A 404 means the requested skill wasn't installed here.
    """
    async with get_conn() as conn:
        cur = await conn.execute(
            "DELETE FROM workspace_skill_installations "
            "WHERE workspace_id=%s AND skill_name=%s",
            (member.workspace_id, skill_name.strip().lower()),
        )
        removed = cur.rowcount
        await conn.commit()
    _invalidate_workspace_skills_cache(member.workspace_id)

    if removed == 0:
        raise HTTPException(
            status_code=404,
            detail=_err("skill_not_installed"),
        )

    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="skill.uninstall",
        target_type="skill",
        target_id=skill_name.strip().lower(),
    )


@app.patch("/skills/{skill_name}", response_model=SkillInstallOut)
async def update_skill_install(
    skill_name: str,
    body: SkillInstallPatch,
    member: CurrentMember = Depends(current_member),
) -> SkillInstallOut:
    """Toggle one workspace-installed skill."""
    if body.enabled is None:
        raise HTTPException(
            status_code=400,
            detail=_err("invalid_payload", "Enabled is required."),
        )

    if get_skill(skill_name) is None:
        raise HTTPException(status_code=404, detail=_err("skill_not_found"))

    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE workspace_skill_installations "
            "SET enabled=%s, updated_at=now() "
            "WHERE workspace_id=%s AND skill_name=%s "
            "RETURNING updated_at",
            (body.enabled, member.workspace_id, skill_name.strip().lower()),
        )
        updated = await cur.fetchone()
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=_err("skill_not_installed"),
            )
        await conn.commit()
    _invalidate_workspace_skills_cache(member.workspace_id)

    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="skill.update",
        target_type="skill",
        target_id=skill_name.strip().lower(),
        metadata={"enabled": body.enabled},
    )

    return SkillInstallOut(
        name=skill_name.strip().lower(),
        installed=True,
        enabled=body.enabled,
        updated_at=_iso(updated[0]),
    )


def _humanise_pattern(pat: str) -> str:
    """Best-effort human-readable rendering of a regex pattern. Strips
    common regex metachars so the dashboard shows "draft … abstract"
    instead of "\\b(draft|write|compose)\\b.{0,80}\\b(abstract|...)\\b".
    Not bidirectional; just a hint."""
    # Drop alternation parens but keep the first alternative.
    s = re.sub(r"\(\?:([^)|]+)\|[^)]*\)", r"\1", pat)
    s = re.sub(r"\(([^)|]+)\|[^)]*\)", r"\1", s)
    # Drop common metacharacters.
    s = re.sub(r"\\b|\\s\*|\\s\+|\\s\?|\^|\$|\.\{[^}]*\}", " ", s)
    s = re.sub(r"\\.", "", s)
    # Collapse whitespace runs.
    s = re.sub(r"\s+", " ", s).strip()
    return s[:140] + ("…" if len(s) > 140 else "")


class McpCatalogField(BaseModel):
    label: str
    path: str
    placeholder: str | None = None
    secret: bool = False
    help_url: str | None = None


class McpCatalogEntry(BaseModel):
    id: str
    name: str
    category: str
    author: str
    description: str
    rating: float
    installs: str
    featured: bool = False
    official: bool = False
    available: bool = True
    # Per-server icon slug — resolved to the catalog id when the entry
    # didn't set an explicit override. The frontend maps it to an SVG.
    icon: str
    # Install-time disclaimer text — empty for most servers. When set,
    # the marketplace gates install behind an acknowledgement modal.
    disclaimer: str = ""
    transport: str
    config: dict
    default_grants: dict
    # Exposed for the Sources page to render only source connectors and
    # build the connect/configure form from a single source of truth.
    show_in_sources: bool = False
    source_fields: list[McpCatalogField] = Field(default_factory=list)
    # For stdio connectors, the command used as launcher (e.g. uvx / npx).
    launcher: str | None = None


class McpInstallFromCatalog(BaseModel):
    """Body for ``POST /mcp/catalog/{id}/install`` — copies the catalog
    entry's transport + config + default grants into a fresh
    ``mcp_servers`` row. ``slug_override`` lets the caller pick a
    custom slug when they're installing the same MCP server twice
    (e.g. two GitHub orgs side by side); defaults to the catalog id.
    """
    slug_override: str | None = None


class McpInstallFromLink(BaseModel):
    """Body for ``POST /mcp/install-from-link`` — links can be:
    - ``notesci://mcp/install/<catalog_id>``
    - ``https://github.com/<owner>/<repo>``
    """
    link: str


def _extract_mcp_install_candidate(raw_link: str) -> str | None:
    """Normalize an install action URL to a catalog-match candidate.

    Accepts Notesci scheme links and GitHub repository links. Returns
    lower-case ``entry id``-style tokens, for example ``zotero`` or
    ``54yyyu/zotero-mcp``.
    """
    try:
        parsed = urlparse(raw_link)
    except Exception:
        return None

    if parsed.scheme == "notesci":
        host = (parsed.hostname or "").lower()
        parts = [part.lower() for part in parsed.path.split("/") if part]
        if host == "mcp" and len(parts) >= 2 and parts[0] == "mcp" and parts[1] == "install":
            return parts[2].lower() if len(parts) >= 3 and parts[2] else None
        if host == "install" and parts:
            return parts[0].lower().strip()
        if parsed.query:
            for p in parsed.query.split("&"):
                if p.lower().startswith("id="):
                    parsed_id = p.split("=", 1)[1]
                    return parsed_id.lower().strip()
        return None

    if parsed.scheme in {"http", "https"} and parsed.hostname:
        host = parsed.hostname.lower()
        if host not in {"github.com", "www.github.com"}:
            return None
        parts = [part.lower() for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            return None
        owner = parts[0]
        repo = parts[1].replace(".git", "")
        return f"{owner}/{repo}" if repo else owner

    return None


def _catalog_entry_matches_candidate(entry, candidate: str) -> bool:
    """Return True when a catalog entry should be installed for a candidate."""
    c = candidate.strip().lower()
    if not c:
        return False

    author = (entry.author or "").strip().lower()
    split = c.split("/", 1)
    owner = split[0]
    repo = split[1] if len(split) > 1 else ""

    return (
        entry.id.lower() == c
        or author == c
        or author == owner
        or author == repo
        or (repo and author.endswith(f"/{repo}"))
        or (repo and author.startswith(f"{owner}/"))
    )


def _resolve_catalog_entry_from_link(raw_link: str):
    from .mcp_catalog import list_catalog

    candidate = _extract_mcp_install_candidate(raw_link)
    if not candidate:
        return None

    return next(
        (e for e in list_catalog() if _catalog_entry_matches_candidate(e, candidate)),
        None,
    )


async def _install_mcp_catalog_entry(
    member: CurrentMember,
    entry,
    *,
    slug_override: str | None = None,
) -> Any:
    """Create an installed MCP server row from a catalog entry."""
    slug = slug_override or entry.id
    async with get_conn() as conn:
        try:
            cur = await conn.execute(
                f"INSERT INTO mcp_servers "
                f"(workspace_id, installed_by, slug, name, transport, config, grants) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {_MCP_COLUMNS}",
                (
                    member.workspace_id,
                    member.id,
                    slug,
                    entry.name,
                    entry.transport,
                    Jsonb(
                        encrypt_config_secrets(
                            _seed_catalog_config(entry, member)
                        )
                    ),
                    Jsonb(entry.default_grants),
                ),
            )
        except psycopg.errors.UniqueViolation as e:
            raise HTTPException(
                status_code=409, detail=_err("mcp_already_installed")
            ) from e
        row = await cur.fetchone()
        await conn.commit()
    await invalidate_mcp_cache(member.workspace_id)
    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="mcp.install",
        target_type="mcp_server",
        target_id=str(row[0]),
        metadata={"slug": row[3], "transport": row[5], "catalog_id": entry.id},
    )
    return row


MarketplaceType = Literal["mcp", "skill", "plugin"]


class MarketplaceSummary(BaseModel):
    id: str
    type: MarketplaceType
    name: str
    description: str
    publisher: str
    category: str
    version: str | None = None
    verified: bool = False
    available: bool = True
    installed: bool = False
    enabled: bool = False
    rating: float | None = None
    install_count: str | None = None
    badges: list[str] = Field(default_factory=list)


class MarketplaceDetail(MarketplaceSummary):
    details: dict = Field(default_factory=dict)
    permissions: list[str] = Field(default_factory=list)
    install_notes: str | None = None


def _plugin_catalog() -> list[dict]:
    """Curated local plugin marketplace entries.

    Plugins install as local folders under ``~/.config/notesci/plugins``.
    Sources live under the backend package so the Debian artifact can
    install them without depending on repository-only sibling folders.
    """
    resources = _Path(__file__).resolve().parent / "plugin_resources"
    return [
        {
            "id": "knowledge-vault",
            "name": "Knowledge Vault",
            "description": (
                "Project-scoped research vault with ingestion commands, "
                "bibliographic slugs, PageIndex indexing, and query workflows."
            ),
            "publisher": "psypeal",
            "category": "Research",
            "version": "2.4.0",
            "source": resources / "knowledge-vault",
            "verified": True,
            "badges": ["local files", "commands", "skills"],
            "permissions": [
                "Installs command, hook, skill, script, and asset files locally.",
                "May run plugin scripts when invoked by a compatible host.",
                "Keeps user data in the local plugin/vault folders.",
            ],
            "install_notes": (
                "Installed into ~/.config/notesci/plugins/knowledge-vault."
            ),
        },
        {
            "id": "docx-toolkit",
            "name": "DOCX Toolkit",
            "description": (
                "Word manuscript tooling for DOCX creation, tracked-change "
                "cleanup, comments, validation, and OOXML inspection."
            ),
            "publisher": "davila7/claude-code-templates",
            "category": "Writing",
            "version": "1.0.0",
            "source": resources / "docx-toolkit",
            "verified": False,
            "badges": ["docx", "ooxml", "tracked changes"],
            "permissions": [
                "Installs local document-processing scripts and skill instructions.",
                "May invoke LibreOffice, pandoc, npm docx, or OOXML helpers when used by a compatible host.",
                "Works on local document files selected by the user.",
            ],
            "install_notes": (
                "Installed into ~/.config/notesci/plugins/docx-toolkit."
            ),
        }
    ]


def _plugin_installed(plugin_id: str) -> bool:
    try:
        from . import user_content as uc
        return (
            uc.PLUGINS_DIR
            / plugin_id
            / ".claude-plugin"
            / "plugin.json"
        ).is_file()
    except Exception:
        return False


async def _install_plugin_from_catalog(plugin_id: str, member: CurrentMember) -> dict:
    import shutil

    _require_workspace_admin(member)
    entry = next((p for p in _plugin_catalog() if p["id"] == plugin_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=_err("plugin_not_found"))
    source = entry["source"]
    if not source.is_dir():
        raise HTTPException(
            status_code=400,
            detail=_err(
                "plugin_unavailable",
                "This plugin source is not bundled in this build.",
            ),
        )

    from . import user_content as uc

    target = uc.PLUGINS_DIR / plugin_id
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, dirs_exist_ok=True)
    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="plugin.install",
        target_type="plugin",
        target_id=plugin_id,
        metadata={"path": str(target), "version": entry.get("version")},
    )
    return entry


def _mcp_summary(entry, installed_slugs: set[str]) -> MarketplaceSummary:
    badges: list[str] = [entry.transport]
    if entry.official:
        badges.append("official")
    if entry.disclaimer:
        badges.append("review")
    return MarketplaceSummary(
        id=entry.id,
        type="mcp",
        name=entry.name,
        description=entry.description,
        publisher=entry.author,
        category=entry.category,
        verified=entry.official,
        available=entry.available,
        installed=entry.id in installed_slugs,
        enabled=entry.id in installed_slugs,
        rating=entry.rating,
        install_count=entry.installs,
        badges=badges,
    )


def _skill_summary(skill, installed: dict[str, tuple[bool, bool]]) -> MarketplaceSummary:
    is_installed, is_enabled = installed.get(skill.name, (False, False))
    return MarketplaceSummary(
        id=skill.name,
        type="skill",
        name=skill.display_name,
        description=skill.description,
        publisher="notesci" if is_builtin_skill(skill.name) else "local",
        category="Research",
        version=None,
        verified=is_builtin_skill(skill.name),
        available=True,
        installed=is_installed,
        enabled=is_enabled if is_installed else False,
        badges=[
            "builtin" if is_builtin_skill(skill.name) else "local",
            "on-demand context",
        ],
    )


@app.get("/marketplace/resources", response_model=list[MarketplaceSummary])
async def list_marketplace_resources(
    member: CurrentMember = Depends(current_member),
) -> list[MarketplaceSummary]:
    """Unified incremental-disclosure marketplace.

    This list view intentionally returns only light metadata and install
    state. Heavy fields such as MCP config templates, skill triggers, and
    plugin permissions are returned by the detail endpoint.
    """
    from .mcp_catalog import list_catalog

    async with get_conn() as conn:
        mcp_cur = await conn.execute(
            "SELECT slug, enabled FROM mcp_servers WHERE workspace_id=%s",
            (member.workspace_id,),
        )
        installed_mcps = {
            slug for slug, enabled in await mcp_cur.fetchall() if enabled
        }
        installed_skills, _ = await _workspace_skills(conn, member.workspace_id)

    out: list[MarketplaceSummary] = []
    out.extend(_mcp_summary(e, installed_mcps) for e in list_catalog())
    out.extend(_skill_summary(s, installed_skills) for s in all_skills())
    for p in _plugin_catalog():
        installed = _plugin_installed(p["id"])
        out.append(
            MarketplaceSummary(
                id=p["id"],
                type="plugin",
                name=p["name"],
                description=p["description"],
                publisher=p["publisher"],
                category=p["category"],
                version=p["version"],
                verified=p["verified"],
                available=p["source"].is_dir(),
                installed=installed,
                enabled=installed,
                badges=p["badges"],
            )
        )
    return out


@app.get(
    "/marketplace/resources/{resource_type}/{resource_id}",
    response_model=MarketplaceDetail,
)
async def get_marketplace_resource(
    resource_type: MarketplaceType,
    resource_id: str,
    member: CurrentMember = Depends(current_member),
) -> MarketplaceDetail:
    async with get_conn() as conn:
        installed_skills, _ = await _workspace_skills(conn, member.workspace_id)
        mcp_cur = await conn.execute(
            "SELECT slug, enabled FROM mcp_servers WHERE workspace_id=%s",
            (member.workspace_id,),
        )
        installed_mcps = {
            slug for slug, enabled in await mcp_cur.fetchall() if enabled
        }

    if resource_type == "mcp":
        from .mcp_catalog import get_entry

        entry = get_entry(resource_id)
        if entry is None:
            raise HTTPException(status_code=404, detail=_err("catalog_entry_not_found"))
        base = _mcp_summary(entry, installed_mcps).model_dump()
        return MarketplaceDetail(
            **base,
            details={
                "transport": entry.transport,
                "config": entry.config,
                "default_grants": entry.default_grants,
                "source_fields": [
                    {
                        "label": f.label,
                        "path": f.path,
                        "secret": f.secret,
                        "help_url": f.help_url,
                    }
                    for f in entry.source_fields
                ],
            },
            permissions=(
                ["Can call any tool exposed by this MCP server."]
                if entry.default_grants.get("allowAll")
                else [
                    f"Allowed tools: {', '.join(entry.default_grants.get('tools') or [])}",
                    f"Denied tools: {', '.join(entry.default_grants.get('deniedTools') or [])}",
                ]
            ),
            install_notes=entry.disclaimer or None,
        )

    if resource_type == "skill":
        skill = get_skill(resource_id)
        if skill is None:
            raise HTTPException(status_code=404, detail=_err("skill_not_found"))
        base = _skill_summary(skill, installed_skills).model_dump()
        return MarketplaceDetail(
            **base,
            details={
                "triggers": [
                    {"sample": _humanise_pattern(p.pattern)} for p in skill.patterns
                ],
                "context": "A compressed brief is injected only when a trigger matches.",
                "source": "builtin" if is_builtin_skill(skill.name) else "local",
            },
            permissions=[
                "Adds a compact system brief to matching chat turns.",
                "Does not expose the full brief text in the UI.",
            ],
        )

    plugin = next((p for p in _plugin_catalog() if p["id"] == resource_id), None)
    if plugin is None:
        raise HTTPException(status_code=404, detail=_err("plugin_not_found"))
    installed = _plugin_installed(plugin["id"])
    return MarketplaceDetail(
        id=plugin["id"],
        type="plugin",
        name=plugin["name"],
        description=plugin["description"],
        publisher=plugin["publisher"],
        category=plugin["category"],
        version=plugin["version"],
        verified=plugin["verified"],
        available=plugin["source"].is_dir(),
        installed=installed,
        enabled=installed,
        badges=plugin["badges"],
        details={
            "install_path": f"~/.config/notesci/plugins/{plugin['id']}",
            "manifest": ".claude-plugin/plugin.json",
        },
        permissions=plugin["permissions"],
        install_notes=plugin["install_notes"],
    )


@app.post(
    "/marketplace/resources/{resource_type}/{resource_id}/install",
    response_model=MarketplaceDetail,
    status_code=201,
)
async def install_marketplace_resource(
    resource_type: MarketplaceType,
    resource_id: str,
    member: CurrentMember = Depends(current_member),
) -> MarketplaceDetail:
    if resource_type == "mcp":
        _require_workspace_admin(member)
        from .mcp_catalog import get_entry

        entry = get_entry(resource_id)
        if entry is None:
            raise HTTPException(status_code=404, detail=_err("catalog_entry_not_found"))
        if not entry.available:
            raise HTTPException(status_code=400, detail=_err("catalog_entry_unavailable"))
        await _install_mcp_catalog_entry(member, entry)
        return await get_marketplace_resource(resource_type, resource_id, member)

    if resource_type == "skill":
        skill = get_skill(resource_id)
        if skill is None:
            raise HTTPException(status_code=404, detail=_err("skill_not_found"))
        async with get_conn() as conn:
            row = await conn.execute(
                "INSERT INTO workspace_skill_installations "
                "(workspace_id, installed_by, skill_name, enabled, updated_at) "
                "VALUES (%s, %s, %s, TRUE, now()) "
                "ON CONFLICT (workspace_id, skill_name) "
                "DO UPDATE SET enabled = TRUE, installed_by = EXCLUDED.installed_by, "
                "updated_at = now() "
                "RETURNING updated_at",
                (member.workspace_id, member.id, skill.name),
            )
            updated = await row.fetchone()
            await conn.commit()
        if not updated:
            raise HTTPException(status_code=500, detail=_err("skill_install_failed"))
        await record_event(
            workspace_id=member.workspace_id,
            actor_member_id=member.id,
            action="skill.install",
            target_type="skill",
            target_id=skill.name,
        )
        return await get_marketplace_resource(resource_type, resource_id, member)

    await _install_plugin_from_catalog(resource_id, member)
    return await get_marketplace_resource(resource_type, resource_id, member)


class SystemToolsOut(BaseModel):
    uvx: bool
    npx: bool
    uv: bool


@app.get("/system/tools", response_model=SystemToolsOut)
async def get_system_tools(
    _member: CurrentMember = Depends(current_member),
) -> SystemToolsOut:
    """Report whether the system launchers MCP servers depend on are
    available on PATH. Used by the Sources page to gate stdio-transport
    Connect buttons and show install instructions when missing."""
    import importlib.util
    import shutil

    def available(name: str) -> bool:
        path = mcp_stdio_env({}).get("PATH", "")
        if shutil.which(name, path=path) is not None:
            return True
        if name == "uvx" and shutil.which("uv", path=path) is not None:
            return True
        if name == "uvx" and importlib.util.find_spec("uv") is not None:
            return True
        return False

    return SystemToolsOut(
        uvx=available("uvx"),
        npx=available("npx"),
        uv=available("uv"),
    )


@app.get("/mcp/catalog", response_model=list[McpCatalogEntry])
async def list_mcp_catalog(
    member: CurrentMember = Depends(current_member),
) -> list[McpCatalogEntry]:
    """Return the curated marketplace catalog.

    Auth-gated so we can later personalise the ordering by the caller's
    ``field_of_research`` (currently returns the static curated list).
    """
    from .mcp_catalog import list_catalog

    def _entry_launcher(entry) -> str | None:
        if entry.transport != "stdio":
            return None
        raw = str(entry.config.get("command") or "").strip()
        if not raw:
            return None
        # Keep only the executable name (`uvx`, `npx`, etc.), not
        # arguments or wrapper prefixes.
        return _Path(raw).name

    return [
        McpCatalogEntry(
            id=e.id,
            name=e.name,
            category=e.category,
            author=e.author,
            description=e.description,
            rating=e.rating,
            installs=e.installs,
            featured=e.featured,
            official=e.official,
            available=e.available,
            icon=e.icon or e.id,
            disclaimer=e.disclaimer,
            transport=e.transport,
            config=e.config,
            default_grants=e.default_grants,
            show_in_sources=e.show_in_sources,
            launcher=_entry_launcher(e),
            source_fields=[
                {
                    "label": f.label,
                    "path": f.path,
                    "placeholder": f.placeholder,
                    "secret": f.secret,
                    "help_url": f.help_url,
                }
                for f in e.source_fields
            ],
        )
        for e in list_catalog()
    ]


def _seed_catalog_config(entry, member: CurrentMember) -> dict:
    """Return a copy of a catalog entry's config with values notesci
    can legitimately supply on the user's behalf already filled in.

    Currently just ``PUBMED_EMAIL``: NCBI's Entrez API requires a
    contact email (not a secret — purely a courtesy address so NCBI can
    reach you about heavy usage), and ``mcp-simple-pubmed`` raises
    ``ValueError`` and exits if it's unset. The catalog ships it as an
    empty placeholder, so without this the server crashes on first
    spawn and the agent sees zero PubMed tools. The installing member's
    own email is exactly the value NCBI wants, so we fill it.

    ``copy.deepcopy`` is mandatory — ``entry.config`` is shared by the
    module-level ``CATALOG`` tuple and must never be mutated.
    """
    import copy

    config = copy.deepcopy(entry.config)
    env = config.get("env")
    if isinstance(env, dict) and "PUBMED_EMAIL" in env and not env["PUBMED_EMAIL"]:
        env["PUBMED_EMAIL"] = member.email
    return config


@app.post(
    "/mcp/catalog/{entry_id}/install",
    response_model=McpServerOut,
    status_code=201,
)
async def install_mcp_from_catalog(
    entry_id: str,
    body: McpInstallFromCatalog,
    member: CurrentMember = Depends(current_member),
) -> McpServerOut:
    """One-click install: copy a curated catalog entry into the workspace.

    Equivalent to POSTing /mcp/servers with the entry's pre-vetted
    transport + config, but the operator only has to confirm — they
    don't need to write JSON. Catalog entries marked
    ``available=False`` are rejected with a typed error so the UI can
    show a "coming soon" state without wasting an install round-trip.
    """
    _require_workspace_admin(member)
    from .mcp_catalog import get_entry
    entry = get_entry(entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail=_err("catalog_entry_not_found"))
    if not entry.available:
        raise HTTPException(status_code=400, detail=_err("catalog_entry_unavailable"))

    row = await _install_mcp_catalog_entry(
        member, entry, slug_override=body.slug_override
    )
    return _mcp_row_to_out(row)


@app.post("/mcp/install-from-link", response_model=McpServerOut, status_code=201)
async def install_mcp_from_link(
    body: McpInstallFromLink,
    member: CurrentMember = Depends(current_member),
) -> McpServerOut:
    """Install a catalog MCP by clickable link.

    This accepts Notesci in-chat links and recognized GitHub URLs.
    It resolves to the matching catalog entry and executes the same
    vetted install path used by catalog clicks.
    """
    _require_workspace_admin(member)
    candidate_entry = _resolve_catalog_entry_from_link(body.link)
    if not candidate_entry:
        raise HTTPException(
            status_code=404,
            detail=_err("catalog_entry_not_found"),
        )

    if not candidate_entry.available:
        raise HTTPException(
            status_code=400, detail=_err("catalog_entry_unavailable")
        )

    row = await _install_mcp_catalog_entry(member, candidate_entry)
    return _mcp_row_to_out(row)


@app.post("/mcp/servers", response_model=McpServerOut, status_code=201)
async def install_mcp_server(
    body: McpServerIn, member: CurrentMember = Depends(current_member)
) -> McpServerOut:
    _require_workspace_admin(member)
    # Raw stdio installs are blocked: the curated catalog can ship a
    # stdio entry because we vet the command, but a free-form
    # ``POST /mcp/servers`` with ``transport='stdio'`` lets any admin
    # run arbitrary code in the backend process. Force admins to go
    # through the catalog install path for stdio servers.
    if body.transport == "stdio":
        raise HTTPException(
            status_code=400,
            detail=_err(
                "stdio_not_allowed",
                "Install stdio MCP servers via the curated catalog only.",
            ),
        )
    async with get_conn() as conn:
        try:
            cur = await conn.execute(
                f"INSERT INTO mcp_servers "
                f"(workspace_id, installed_by, slug, name, transport, config, grants) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {_MCP_COLUMNS}",
                (
                    member.workspace_id,
                    member.id,
                    body.slug,
                    body.name,
                    body.transport,
                    Jsonb(encrypt_config_secrets(body.config)),
                    Jsonb(body.grants),
                ),
            )
        except psycopg.errors.UniqueViolation as e:
            raise HTTPException(
                status_code=409, detail=_err("mcp_already_installed")
            ) from e
        r = await cur.fetchone()
        await conn.commit()
    await invalidate_mcp_cache(member.workspace_id)
    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="mcp.install",
        target_type="mcp_server",
        target_id=str(r[0]),
        metadata={"slug": r[3], "transport": r[5]},
    )
    return _mcp_row_to_out(r)


@app.get("/mcp/servers", response_model=list[McpServerOut])
async def list_mcp_servers(
    member: CurrentMember = Depends(current_member),
) -> list[McpServerOut]:
    async with get_conn() as conn:
        cur = await conn.execute(
            f"SELECT {_MCP_COLUMNS} FROM mcp_servers "
            f"WHERE workspace_id=%s ORDER BY created_at",
            (member.workspace_id,),
        )
        rows = await cur.fetchall()
    return [_mcp_row_to_out(r) for r in rows]


async def _load_mcp_server(
    conn: psycopg.AsyncConnection, server_id: UUID, workspace_id: UUID
):
    cur = await conn.execute(
        f"SELECT {_MCP_COLUMNS} FROM mcp_servers "
        f"WHERE id=%s AND workspace_id=%s",
        (server_id, workspace_id),
    )
    return await cur.fetchone()


def _parse_uuid(s: str, code: str) -> UUID:
    try:
        return UUID(s)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err(code)) from e


def _preserve_redacted_config_values(existing: object, incoming: object) -> object:
    """Merge redacted config edits without storing literal "***" secrets."""
    if incoming == "***":
        return existing
    if isinstance(existing, dict) and isinstance(incoming, dict):
        return {
            key: _preserve_redacted_config_values(existing.get(key), value)
            for key, value in incoming.items()
        }
    if isinstance(existing, list) and isinstance(incoming, list):
        return [
            _preserve_redacted_config_values(
                existing[i] if i < len(existing) else None,
                value,
            )
            for i, value in enumerate(incoming)
        ]
    return incoming


@app.get("/mcp/servers/{server_id}", response_model=McpServerOut)
async def get_mcp_server(
    server_id: str, member: CurrentMember = Depends(current_member)
) -> McpServerOut:
    sid = _parse_uuid(server_id, "invalid_server_id")
    async with get_conn() as conn:
        r = await _load_mcp_server(conn, sid, member.workspace_id)
    if not r:
        raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
    return _mcp_row_to_out(r)


@app.post("/mcp/servers/{server_id}/status", response_model=McpServerStatusOut)
async def check_mcp_server_status(
    server_id: str, member: CurrentMember = Depends(current_member)
) -> McpServerStatusOut:
    sid = _parse_uuid(server_id, "invalid_server_id")
    async with get_conn() as conn:
        row = await _load_mcp_server(conn, sid, member.workspace_id)
        if not row:
            raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
        slug = row[3]
        await invalidate_mcp_cache(member.workspace_id)
        tools, _tool_to_server, errors = await load_workspace_mcp_tools(
            conn,
            member.workspace_id,
            requested_slugs={slug},
        )
    error = errors.get(slug)
    if error:
        status: Literal["ready", "failed", "missing_config"] = (
            "missing_config" if "missing" in error.lower() else "failed"
        )
        return McpServerStatusOut(
            status=status,
            tool_count=0,
            error=error,
            checked_at=datetime.now(timezone.utc).isoformat(),
        )
    return McpServerStatusOut(
        status="ready",
        tool_count=len(tools),
        error=None,
        checked_at=datetime.now(timezone.utc).isoformat(),
    )


@app.patch("/mcp/servers/{server_id}", response_model=McpServerOut)
async def update_mcp_server(
    server_id: str,
    body: McpServerPatch,
    member: CurrentMember = Depends(current_member),
) -> McpServerOut:
    _require_workspace_admin(member)
    sid = _parse_uuid(server_id, "invalid_server_id")

    sets: list[str] = []
    params: list = []
    if body.name is not None:
        sets.append("name=%s")
        params.append(body.name)
    if body.config is not None:
        sets.append("config=%s")
        params.append(None)
    if body.grants is not None:
        sets.append("grants=%s")
        params.append(Jsonb(body.grants))
    if body.enabled is not None:
        sets.append("enabled=%s")
        params.append(body.enabled)
    if not sets:
        raise HTTPException(status_code=400, detail=_err("nothing_to_update"))
    sets.append("updated_at=now()")
    params.extend([sid, member.workspace_id])

    async with get_conn() as conn:
        if body.config is not None:
            cur_existing = await conn.execute(
                "SELECT config FROM mcp_servers WHERE id=%s AND workspace_id=%s",
                (sid, member.workspace_id),
            )
            existing_row = await cur_existing.fetchone()
            if not existing_row:
                raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
            merged_config = _preserve_redacted_config_values(
                decrypt_config_secrets(existing_row[0] or {}),
                body.config,
            )
            params[sets.index("config=%s")] = Jsonb(
                encrypt_config_secrets(merged_config)
            )
        cur = await conn.execute(
            f"UPDATE mcp_servers SET {', '.join(sets)} "
            f"WHERE id=%s AND workspace_id=%s RETURNING {_MCP_COLUMNS}",
            params,
        )
        r = await cur.fetchone()
        await conn.commit()
    if not r:
        raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
    await invalidate_mcp_cache(member.workspace_id)
    return _mcp_row_to_out(r)


@app.delete("/mcp/servers/{server_id}", status_code=204)
async def uninstall_mcp_server(
    server_id: str, member: CurrentMember = Depends(current_member)
) -> None:
    _require_workspace_admin(member)
    sid = _parse_uuid(server_id, "invalid_server_id")
    async with get_conn() as conn:
        cur = await conn.execute(
            "DELETE FROM mcp_servers WHERE id=%s AND workspace_id=%s",
            (sid, member.workspace_id),
        )
        await conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
    await invalidate_mcp_cache(member.workspace_id)
    await record_event(
        workspace_id=member.workspace_id,
        actor_member_id=member.id,
        action="mcp.uninstall",
        target_type="mcp_server",
        target_id=str(sid),
    )


# Headers/argument keys whose values are treated as secret in the
# /mcp/servers/{id}/calls audit feed. Tool authors sometimes log auth
# headers verbatim; redact defensively rather than rely on every
# upstream tool being well-behaved.
_MCP_ARG_SECRET_RE = re.compile(
    r"^(authorization|api[_-]?key|token|secret|password|x-api-key)$",
    re.IGNORECASE,
)
_MCP_ARG_TRUNC = 256


def _redact_mcp_arguments(args: object) -> object:
    """Return a copy of ``args`` with secret-shaped keys redacted and
    every string value truncated to ``_MCP_ARG_TRUNC`` chars.

    Recursively descends into nested dicts/lists so nested OAuth blobs
    are scrubbed too. Non-string, non-collection values pass through.
    """
    if isinstance(args, dict):
        out: dict = {}
        for k, v in args.items():
            if isinstance(k, str) and _MCP_ARG_SECRET_RE.match(k):
                out[k] = "***"
                continue
            out[k] = _redact_mcp_arguments(v)
        return out
    if isinstance(args, list):
        return [_redact_mcp_arguments(v) for v in args]
    if isinstance(args, str):
        return args if len(args) <= _MCP_ARG_TRUNC else args[:_MCP_ARG_TRUNC] + "…"
    return args


@app.get("/mcp/servers/{server_id}/calls", response_model=list[McpCallOut])
async def list_mcp_calls(
    server_id: str,
    limit: int = 50,
    offset: int = 0,
    member: CurrentMember = Depends(current_member),
) -> list[McpCallOut]:
    """List recent MCP tool-call audit rows for one server.

    Arguments are redacted (secret-shaped keys → ``***``, string values
    truncated to 256 chars) before returning so the audit feed never
    accidentally surfaces an API key the LLM forwarded into a tool call.
    """
    sid = _parse_uuid(server_id, "invalid_server_id")
    if not 1 <= limit <= 200:
        raise HTTPException(status_code=400, detail=_err("invalid_limit"))
    if offset < 0:
        raise HTTPException(status_code=400, detail=_err("invalid_offset"))

    async with get_conn() as conn:
        # Authorize: server must be in caller's workspace.
        if not await _load_mcp_server(conn, sid, member.workspace_id):
            raise HTTPException(status_code=404, detail=_err("mcp_not_found"))
        cur = await conn.execute(
            "SELECT id, server_id, tool_name, arguments, result_summary, "
            "error, duration_ms, created_at "
            "FROM mcp_call_logs WHERE server_id=%s "
            "ORDER BY created_at DESC LIMIT %s OFFSET %s",
            (sid, limit, offset),
        )
        rows = await cur.fetchall()
    return [
        McpCallOut(
            id=r[0],
            server_id=str(r[1]),
            tool_name=r[2],
            arguments=_redact_mcp_arguments(r[3]),
            result_summary=r[4],
            error=r[5],
            duration_ms=r[6],
            created_at=_iso(r[7]),
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Chat / threads / materials
# ---------------------------------------------------------------------------


async def _assert_project_in_workspace(
    conn, project_id: UUID, workspace_id: UUID
) -> None:
    """Raise 404 if the project doesn't exist OR isn't in the caller's workspace.

    We deliberately collapse 404 and 403 into a single "project_not_found" so
    we don't leak the existence of cross-workspace projects.
    """
    cur = await conn.execute(
        "SELECT workspace_id FROM projects WHERE id = %s", (project_id,)
    )
    row = await cur.fetchone()
    if not row or row[0] != workspace_id:
        raise HTTPException(status_code=404, detail=_err("project_not_found"))


def _derive_session_title(first_message: str) -> str | None:
    """Make a concise session title from the first user message.

    Heuristic, not LLM — instant, free, deterministic. Strips a leading
    slash-command token, collapses whitespace, and caps the length so
    the SidePanel row stays single-line. Returns ``None`` for an empty
    message so the caller leaves the title NULL ('Untitled session').
    """
    text = (first_message or "").strip()
    # Drop a leading "/command" token — the prompt body is the meaningful
    # part, not the command name.
    text = re.sub(r"^/[\w-]+\s*", "", text).strip()
    if not text:
        return None
    # Collapse internal whitespace/newlines to single spaces.
    text = re.sub(r"\s+", " ", text)
    # Cap at ~6 words OR 56 chars, whichever is shorter, with an ellipsis
    # when we actually truncated.
    words = text.split(" ")
    capped = " ".join(words[:9])
    if len(capped) > 56:
        capped = capped[:55].rstrip() + "…"
    elif len(words) > 9:
        capped = capped + "…"
    # Title-case only if the message is all-lower (don't mangle acronyms
    # or already-capitalised text).
    if capped == capped.lower():
        capped = capped[:1].upper() + capped[1:]
    return capped or None


async def _resolve_session(
    conn, member: CurrentMember, *, thread_id: str | None, project_id: str | None
) -> tuple[UUID, UUID | None]:
    """Return ``(session_id, project_id_or_None)`` for a /chat call.

    - With ``thread_id``: validate the session belongs to the caller and is
      in their workspace; ignore the incoming ``project_id`` (the session's
      own project wins). General sessions resolve here with project_id=None.
    - Without ``thread_id``: ``project_id`` is required (this path is only
      for project chats; general sessions are minted via the dedicated
      ``POST /general/sessions`` endpoint).
    """
    if thread_id:
        try:
            sid = UUID(thread_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=_err("invalid_thread_id")) from e
        # Use sessions.workspace_id directly (denormalized in 0022) so the
        # lookup works for both kinds without forcing a JOIN through
        # projects (which would NULL out for kind='general').
        cur = await conn.execute(
            "SELECT project_id, workspace_id "
            "FROM sessions "
            "WHERE id = %s AND created_by_member_id = %s",
            (sid, member.id),
        )
        row = await cur.fetchone()
        if not row or row[1] != member.workspace_id:
            raise HTTPException(status_code=404, detail=_err("thread_not_found"))
        return sid, row[0]

    if not project_id:
        raise HTTPException(status_code=400, detail=_err("project_id_required"))
    try:
        pj = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e
    await _assert_project_in_workspace(conn, pj, member.workspace_id)

    cur = await conn.execute(
        "INSERT INTO sessions (project_id, workspace_id, created_by_member_id, kind) "
        "VALUES (%s, %s, %s, 'project') RETURNING id",
        (pj, member.workspace_id, member.id),
    )
    sid = (await cur.fetchone())[0]
    await conn.commit()
    return sid, pj


@app.post("/chat", response_model=ChatOut)
async def chat(
    body: ChatIn, member: CurrentMember = Depends(current_member)
) -> ChatOut:
    async with get_conn() as conn:
        session_id, project_id = await _resolve_session(
            conn, member, thread_id=body.thread_id, project_id=body.project_id
        )
        # Load every enabled MCP server's granted tools for this
        # workspace. _call_model binds the full set to whichever model
        # the turn runs on, so all models get all installed MCPs
        # automatically — see agent/mcp_tools.py.
        mcp_slugs = _requested_mcp_slugs_for_turn(body.message)
        t_mcp = time.monotonic()
        tools, tool_to_server, mcp_load_errors = await load_workspace_mcp_tools(
            conn,
            member.workspace_id,
            requested_slugs=mcp_slugs,
        )
        tools, tool_to_server = _filter_mcp_tools_for_turn(
            tools,
            tool_to_server,
            body.message,
        )
        logger.info(
            "chat timing: mcp_load_ms=%d mode=%s tools=%d failures=%d",
            int((time.monotonic() - t_mcp) * 1000),
            "all" if mcp_slugs is None else ("skip" if not mcp_slugs else ",".join(sorted(mcp_slugs))),
            len(tools),
            len(mcp_load_errors),
        )
        installed_skill_map, _ = await _workspace_skills(conn, member.workspace_id)
        installed_skills = {
            name for name, (_installed, enabled) in installed_skill_map.items() if enabled
        }

    # Hot-path memory tool: the model can call memory_save mid-turn
    # when the user explicitly asks ("remember that…"). Scope (general
    # vs project) is auto-inferred from the active session inside the
    # tool — see memory/extractor.py. Withheld in incognito so the model
    # can't bypass the user's read-and-write opt-out via tool call.
    if not body.memory_incognito and _turn_wants_memory_tools(body.message):
        from .memory.extractor import memory_tools as _memory_tools
        tools = [*tools, *_memory_tools()]

    # General sessions have no project — omit project_id from the
    # configurable so the agent's retrieve node sees it as missing and
    # short-circuits to "no grounding" (see agent/graph.py:_retrieve).
    configurable: dict[str, str] = {"thread_id": str(session_id)}
    if project_id is not None:
        configurable["project_id"] = str(project_id)
    config = {"configurable": configurable}
    state = {"messages": [HumanMessage(content=body.message)]}
    effective_model = _resolve_chat_model(body.model)
    req_ctx = RequestCtx(
        tools=tools,
        tool_to_server_id=tool_to_server,
        mcp_load_errors=mcp_load_errors,
        member_id=str(member.id),
        session_id=str(session_id),
        model=effective_model,
        retrieval_mode=(body.retrieval_mode or "vector"),
        web_search=body.web_search,
        memory_incognito=body.memory_incognito,
        installed_skills=installed_skills,
    )
    token = set_request_ctx(req_ctx)
    try:
        out = await app.state.graph.ainvoke(state, config=config)
    except Exception as e:
        logger.exception("agent error")
        raise _agent_http_error(e) from e
    finally:
        reset_request_ctx(token)

    # Touch session.updated_at and persist citations (parsed [N] markers
    # from the AI reply against this turn's retrieved chunks).
    retrieved_list = list(out.get("retrieved") or [])
    final_text = _last_visible_ai_text(list(out.get("messages") or []))
    final_text_was_empty = not final_text
    if final_text_was_empty:
        logger.warning(
            "agent completed with no visible assistant text session_id=%s model=%s",
            session_id,
            effective_model,
        )
        final_text = _EMPTY_MODEL_REPLY
    markers = _citation_markers(final_text)
    # turn_seq = 0-indexed turn number = (number of human messages) - 1.
    turn_seq = sum(1 for m in out["messages"] if m.type == "human") - 1

    async with get_conn() as conn:
        # On the first turn, auto-name the session from the opening
        # message. COALESCE keeps any title the user already set (e.g.
        # via the rename menu) — we never clobber a deliberate name.
        if turn_seq == 0:
            derived = _derive_session_title(body.message)
            await conn.execute(
                "UPDATE sessions SET updated_at = now(), "
                "title = COALESCE(title, %s) WHERE id = %s",
                (derived, session_id),
            )
        else:
            await conn.execute(
                "UPDATE sessions SET updated_at = now() WHERE id = %s",
                (session_id,),
            )
        if markers and retrieved_list and turn_seq >= 0:
            internal_retrieved = [
                r for r in retrieved_list if _as_uuid(r["material_id"]) is not None
            ]
            rows_to_insert = []
            for n in markers:
                idx = n - 1  # markers are 1-based
                if 0 <= idx < len(internal_retrieved):
                    r = internal_retrieved[idx]
                    material_uuid = _as_uuid(r["material_id"])
                    rows_to_insert.append(
                        (
                            session_id,
                            turn_seq,
                            n,
                            r["chunk_id"],
                            material_uuid,
                        )
                    )
            if rows_to_insert:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        "INSERT INTO message_citations "
                        "(session_id, turn_seq, marker_n, chunk_id, material_id) "
                        "VALUES (%s, %s, %s, %s, %s) "
                        "ON CONFLICT DO NOTHING",
                        rows_to_insert,
                    )
        await conn.commit()

    retrieved = _retrieved_refs_from_chunks(retrieved_list)

    # Memory: enqueue an extraction job (cheap UPSERT — no LLM call on
    # the hot path). The sweeper picks the job up once the session has
    # been idle for IDLE_EXTRACT_SECONDS and runs ONE batch extraction
    # over the whole conversation. Skipped in incognito (the user
    # explicitly opted out of memory write for this turn). Per-turn
    # extraction was retired 2026-05-27 — see memory/extractor.py and
    # memory/sweeper.py for the rationale.
    if (
        not final_text_was_empty
        and not body.memory_incognito
        and body.message.strip()
        and final_text.strip()
    ):
        from .memory.sweeper import enqueue_extraction_job
        _spawn(
            enqueue_extraction_job(session_id=session_id, member_id=member.id),
            label="memory_extract_enqueue",
        )

    return ChatOut(
        reply=final_text,
        thread_id=str(session_id),
        retrieved=retrieved,
        skills=list(req_ctx.activated_skills),
        model_used=effective_model,
        turn_seq=turn_seq if turn_seq >= 0 else None,
        retrieval_mode_used=req_ctx.retrieval_mode_used,
        memory_recalled_count=len(req_ctx.memory_recalled),
        memory_recalled=[
            _memory_recall_to_out(memory) for memory in req_ctx.memory_recalled
        ],
    )


def _sse_event(payload: dict) -> str:
    """Format one SSE message. Multi-line payloads are JSON so we never
    have to worry about embedded newlines in the protocol."""
    return f"data: {json.dumps(payload)}\n\n"


_EMPTY_MODEL_REPLY = (
    "The model request completed, but the provider returned no visible text. "
    "Try sending the request again, or switch to another model."
)


def _last_visible_ai_text(messages: list[Any]) -> str:
    """Return the last non-empty assistant text from a graph snapshot.

    Tool-call-only AI messages and tool outputs are internal protocol
    messages. They must not become the visible assistant response, or the UI
    can render a successful turn as silence.
    """
    for msg in reversed(messages):
        if getattr(msg, "type", None) != "ai":
            continue
        text = extract_text(getattr(msg, "content", None)).strip()
        if text:
            return text
    return ""


_EXPLICIT_MCP_ALIASES = {
    "obsidian": ("obsidian",),
    "zotero": ("zotero",),
    "notion": ("notion",),
    "scihub": ("scihub", "sci-hub", "sci hub"),
    "paper-search": ("paper-search", "paper search"),
    "pubmed": ("pubmed", "pub med"),
    "semantic-scholar": ("semantic-scholar", "semantic scholar"),
}
_MCP_LOAD_HINTS = (
    "mcp",
    "connector",
    "source",
    "sources",
    "web",
    "internet",
    "online",
    "library",
    "libraries",
    "collection",
    "collections",
    "vault",
    "database",
    "databases",
    "doi",
    "paper",
    "papers",
    "article",
    "articles",
    "literature",
    "full text",
    "pdf",
    "pubmed",
    "arxiv",
    "scihub",
    "sci-hub",
    "paper search",
    "semantic scholar",
    "semantic-scholar",
    "search",
    "look up",
    "lookup",
)


_ZOTERO_COLLECTION_ITEM_HINTS = (
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


def _requested_mcp_slugs_for_turn(message: str) -> set[str] | None:
    """Return MCP slugs to load for this turn.

    ``set()`` means skip MCP loading entirely. ``None`` means generic source
    intent, so load every enabled MCP. A non-empty set limits startup to the
    explicitly requested server(s), avoiding slow stdio process discovery on
    normal chat turns.
    """
    text = (message or "").lower()
    explicit = {
        slug
        for slug, aliases in _EXPLICIT_MCP_ALIASES.items()
        if any(alias in text for alias in aliases)
    }
    if explicit:
        return explicit
    if (
        ("collection" in text or "collections" in text)
        and any(hint in text for hint in _ZOTERO_COLLECTION_ITEM_HINTS)
    ):
        return {"zotero"}
    if any(hint in text for hint in _MCP_LOAD_HINTS):
        return None
    return set()


_MCP_WRITE_HINTS = (
    "write",
    "create",
    "update",
    "delete",
    "remove",
    "append",
    "patch",
    "replace",
    "publish",
    "post",
    "send",
    "save",
)
_MCP_READ_TOOL_HINTS = (
    "search",
    "find",
    "list",
    "read",
    "get",
    "query",
    "fetch",
    "download",
    "browse",
    "metadata",
    "doi",
    "paper",
    "article",
    "pdf",
    "note",
    "notes",
    "page",
    "pages",
    "database",
    "file",
    "files",
    "collection",
    "library",
    "tag",
    "tags",
    "vault",
)


def _turn_wants_mcp_write(message: str) -> bool:
    text = (message or "").lower()
    return any(hint in text for hint in _MCP_WRITE_HINTS)


def _filter_mcp_tools_for_turn(
    tools: list[Any],
    tool_to_server: dict[str, str],
    message: str,
) -> tuple[list[Any], dict[str, str]]:
    """Bind fewer MCP tools on normal browse/search turns.

    MCP servers often expose broad write/admin tools. For source-browsing
    prompts, binding every tool makes tool choice slower and less reliable.
    Keep the full set only when the user asks for a mutation.
    """
    if not tools or _turn_wants_mcp_write(message):
        return tools, tool_to_server
    filtered = [
        tool
        for tool in tools
        if any(hint in getattr(tool, "name", "").lower() for hint in _MCP_READ_TOOL_HINTS)
    ]
    if not filtered:
        return tools, tool_to_server
    allowed = {getattr(tool, "name", "") for tool in filtered}
    return filtered, {
        name: server_id for name, server_id in tool_to_server.items() if name in allowed
    }


_MEMORY_TOOL_HINTS = (
    "remember",
    "save this",
    "save that",
    "store this",
    "note that",
    "don't forget",
    "memory",
    "memories",
)


def _turn_wants_memory_tools(message: str) -> bool:
    text = (message or "").lower()
    return any(hint in text for hint in _MEMORY_TOOL_HINTS)


@app.post("/chat/stream")
async def chat_stream(
    body: ChatIn, member: CurrentMember = Depends(current_member)
):
    """Streaming counterpart to /chat. Yields SSE events:

      - ``{"type": "session", "thread_id": "<uuid>"}`` — first event,
        so the client can wire up the thread before tokens arrive.
      - ``{"type": "token", "text": "<chunk>"}`` — repeated, AI tokens
        as they arrive from LangGraph's ``stream_mode="messages"``.
      - ``{"type": "retrieved", "chunks": [...]}`` — after the graph
        completes, lists the chunks the agent grounded on.
      - ``{"type": "done"}`` — terminal, signals the stream is finished.
      - ``{"type": "error", "message": "..."}`` — on failure.
    """
    async with get_conn() as conn:
        session_id, project_id = await _resolve_session(
            conn, member, thread_id=body.thread_id, project_id=body.project_id
        )
        mcp_slugs = _requested_mcp_slugs_for_turn(body.message)
        t_mcp = time.monotonic()
        tools, tool_to_server, mcp_load_errors = await load_workspace_mcp_tools(
            conn,
            member.workspace_id,
            requested_slugs=mcp_slugs,
        )
        tools, tool_to_server = _filter_mcp_tools_for_turn(
            tools,
            tool_to_server,
            body.message,
        )
        logger.info(
            "chat timing: mcp_load_ms=%d mode=%s tools=%d failures=%d",
            int((time.monotonic() - t_mcp) * 1000),
            "all" if mcp_slugs is None else ("skip" if not mcp_slugs else ",".join(sorted(mcp_slugs))),
            len(tools),
            len(mcp_load_errors),
        )
        installed_skill_map, _ = await _workspace_skills(conn, member.workspace_id)
        installed_skills = {
            name for name, (_installed, enabled) in installed_skill_map.items() if enabled
        }

    if not body.memory_incognito and _turn_wants_memory_tools(body.message):
        from .memory.extractor import memory_tools as _memory_tools
        tools = [*tools, *_memory_tools()]

    # Same configurable shape as /chat — general sessions omit project_id
    # so the agent skips retrieval cleanly instead of trying to query
    # against the string "None".
    configurable: dict[str, str] = {"thread_id": str(session_id)}
    if project_id is not None:
        configurable["project_id"] = str(project_id)
    config = {"configurable": configurable}
    state = {"messages": [HumanMessage(content=body.message)]}
    effective_model = _resolve_chat_model(body.model)

    async def event_stream():
        req_ctx = RequestCtx(
            tools=tools,
            tool_to_server_id=tool_to_server,
            mcp_load_errors=mcp_load_errors,
            member_id=str(member.id),
            session_id=str(session_id),
            model=effective_model,
            retrieval_mode=(body.retrieval_mode or "vector"),
            web_search=body.web_search,
            memory_incognito=body.memory_incognito,
            installed_skills=installed_skills,
        )
        token = set_request_ctx(req_ctx)
        try:
            yield _sse_event({"type": "session", "thread_id": str(session_id)})
            try:
                async for chunk, _meta in app.state.graph.astream(
                    state, config=config, stream_mode="messages"
                ):
                    # ``messages`` mode emits both AI streaming chunks and
                    # full tool-output messages; only forward AI text.
                    if getattr(chunk, "type", None) != "AIMessageChunk":
                        continue
                    text = extract_text(getattr(chunk, "content", None))
                    if text:
                        yield _sse_event({"type": "token", "text": text})
            except Exception as exc:
                logger.exception("agent error during /chat/stream")
                # Mirror /chat's rate-limit detection over the SSE
                # protocol so clients can show the right copy.
                mapped = _agent_http_error(exc)
                detail = mapped.detail if isinstance(mapped.detail, dict) else {}
                yield _sse_event({
                    "type": "error",
                    "code": detail.get("code", "agent_failed"),
                    "message": detail.get("message"),
                })
                return

            # Post-stream: persist citations and emit them, mirroring /chat.
            snapshot = await app.state.graph.aget_state(config)
            messages = snapshot.values.get("messages", []) if snapshot else []
            retrieved = snapshot.values.get("retrieved", []) if snapshot else []
            final_text = _last_visible_ai_text(list(messages))
            final_text_was_empty = not final_text
            if final_text_was_empty:
                logger.warning(
                    "agent stream completed with no visible assistant text "
                    "session_id=%s model=%s",
                    session_id,
                    effective_model,
                )
                final_text = _EMPTY_MODEL_REPLY
            markers = _citation_markers(final_text)
            turn_seq = sum(1 for m in messages if m.type == "human") - 1

            async with get_conn() as conn:
                if turn_seq == 0:
                    derived = _derive_session_title(body.message)
                    await conn.execute(
                        "UPDATE sessions SET updated_at = now(), "
                        "title = COALESCE(title, %s) WHERE id = %s",
                        (derived, session_id),
                    )
                else:
                    await conn.execute(
                        "UPDATE sessions SET updated_at = now() WHERE id = %s",
                        (session_id,),
                    )
                if markers and retrieved and turn_seq >= 0:
                    internal_retrieved = [
                        r for r in retrieved if _as_uuid(r["material_id"]) is not None
                    ]
                    rows = [
                        (
                            session_id,
                            turn_seq,
                            n,
                            internal_retrieved[n - 1]["chunk_id"],
                            _as_uuid(internal_retrieved[n - 1]["material_id"]),
                        )
                        for n in markers
                        if 0 <= n - 1 < len(internal_retrieved)
                    ]
                    if rows:
                        async with conn.cursor() as cur:
                            await cur.executemany(
                                "INSERT INTO message_citations "
                                "(session_id, turn_seq, marker_n, chunk_id, material_id) "
                                "VALUES (%s, %s, %s, %s, %s) "
                                "ON CONFLICT DO NOTHING",
                                rows,
                            )
                await conn.commit()

            if (
                not final_text_was_empty
                and not body.memory_incognito
                and body.message.strip()
                and final_text.strip()
            ):
                from .memory.sweeper import enqueue_extraction_job
                _spawn(
                    enqueue_extraction_job(session_id=session_id, member_id=member.id),
                    label="memory_extract_enqueue",
                )

            yield _sse_event({
                "type": "retrieved",
            "chunks": [ref.model_dump() for ref in _retrieved_refs_from_chunks(retrieved)],
        })
            if req_ctx.activated_skills:
                yield _sse_event({
                    "type": "skills",
                    "skills": list(req_ctx.activated_skills),
                })
            if req_ctx.memory_recalled:
                recalled = [
                    _memory_recall_to_out(memory).model_dump()
                    for memory in req_ctx.memory_recalled
                ]
                yield _sse_event({
                    "type": "memory",
                    "memory_recalled_count": len(recalled),
                    "memory_recalled": recalled,
                })
            yield _sse_event({
                "type": "done",
                "thread_id": str(session_id),
                "final_text": final_text,
                "model_used": effective_model,
                "retrieval_mode_used": req_ctx.retrieval_mode_used,
                "turn_seq": turn_seq if turn_seq >= 0 else None,
                "memory_recalled_count": len(req_ctx.memory_recalled),
            })
        finally:
            reset_request_ctx(token)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/threads/{thread_id}/messages")
async def thread_messages(
    thread_id: str, member: CurrentMember = Depends(current_member)
) -> dict:
    """Return the persisted message history for a thread, oldest first.

    Each AI message carries the model that produced it (joined from
    ``chat_calls`` by ``(session_id, turn_seq)``). For multi-call turns
    (tool loops) we surface the model from the *final* call, since
    that's the one whose text the user actually sees.
    """
    try:
        sid = UUID(thread_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_thread_id")) from e

    async with get_conn() as conn:
        # Use sessions.workspace_id (denormalized in 0022) so both project
        # and general sessions resolve through the same boundary check.
        cur = await conn.execute(
            "SELECT id FROM sessions "
            "WHERE id = %s AND created_by_member_id = %s AND workspace_id = %s",
            (sid, member.id, member.workspace_id),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail=_err("thread_not_found"))

        # turn_seq -> model used (latest call wins for tool-loop turns).
        cur = await conn.execute(
            "SELECT DISTINCT ON (turn_seq) turn_seq, model FROM chat_calls "
            "WHERE session_id = %s AND turn_seq IS NOT NULL "
            "ORDER BY turn_seq, created_at DESC",
            (sid,),
        )
        model_by_turn: dict[int, str] = {row[0]: row[1] for row in await cur.fetchall()}

        cur = await conn.execute(
            "SELECT mc.turn_seq, mc.marker_n, mc.chunk_id, mc.material_id, m.title, m.uri, m.metadata "
            "FROM message_citations mc "
            "LEFT JOIN materials m ON m.id = mc.material_id "
            "WHERE mc.session_id = %s "
            "ORDER BY mc.turn_seq, mc.marker_n",
            (sid,),
        )
        citations_by_turn: dict[int, list[RetrievedRef]] = defaultdict(list)
        for row in await cur.fetchall():
            turn_seq = row[0]
            _marker_n = row[1]
            chunk_id = row[2]
            material_id = row[3]
            title = row[4]
            uri = row[5]
            metadata = row[6]
            if _marker_n is None:
                # Defensive: the column shouldn't be NULL, but keep
                # this robust when older rows are read from mixed
                # environments.
                continue
            if title is None and uri is None and metadata is None:
                # The cited material no longer exists. Do not emit a
                # clickable citation chip that cannot open anything.
                continue
            material_url = _material_source_url(uri, metadata)
            refs = citations_by_turn[turn_seq]
            marker_n = int(_marker_n)
            while len(refs) < marker_n:
                refs.append(
                    RetrievedRef(
                        chunk_id=0,
                        material_id="",
                        title=None,
                        material_url=None,
                        distance=0.0,
                        marker_n=len(refs) + 1,
                        source_kind="internal",
                    )
                )
            refs[marker_n - 1] = RetrievedRef(
                chunk_id=chunk_id,
                material_id=str(material_id),
                title=title,
                material_url=material_url,
                distance=0.0,
                marker_n=marker_n,
                source_kind="internal",
            )

    config = {"configurable": {"thread_id": str(sid)}}
    snapshot = await app.state.graph.aget_state(config)
    messages = snapshot.values.get("messages", []) if snapshot else []
    snapshot_retrieved = list(snapshot.values.get("retrieved", []) if snapshot else [])
    snapshot_internal_refs = {
        ref.marker_n: ref
        for ref in _retrieved_refs_from_chunks(snapshot_retrieved)
        if ref.source_kind == "internal" and ref.marker_n is not None
    }
    latest_turn_seq = sum(1 for m in messages if m.type == "human") - 1

    # Walk messages in order, assigning each AI bubble the turn_seq of
    # the most recent human message before it.
    out: list[dict] = []
    current_turn = -1
    for m in messages:
        if m.type == "human":
            current_turn += 1
            out.append({
                "role": "human",
                "content": extract_text(m.content),
                "turn_seq": current_turn,
            })
        elif m.type == "ai":
            text = extract_text(m.content)
            if not text:
                # Skip empty AI messages (typically tool-call-only turns).
                continue
            retrieved_refs = list(citations_by_turn.get(current_turn, []))
            if current_turn == latest_turn_seq and snapshot_retrieved:
                for marker_n in _citation_markers(text):
                    while len(retrieved_refs) < marker_n:
                        retrieved_refs.append(
                            RetrievedRef(
                                chunk_id=0,
                                material_id="",
                                title=None,
                                material_url=None,
                                distance=0.0,
                                marker_n=len(retrieved_refs) + 1,
                                source_kind="internal",
                            )
                        )
                    existing = retrieved_refs[marker_n - 1]
                    if existing.material_id or existing.material_url:
                        continue
                    ref = snapshot_internal_refs.get(marker_n)
                    if ref is not None:
                        retrieved_refs[marker_n - 1] = ref
            out.append({
                "role": "ai",
                "content": text,
                "turn_seq": current_turn if current_turn >= 0 else None,
                "model_used": model_by_turn.get(current_turn),
                "retrieved": [
                    {
                        "chunk_id": r.chunk_id,
                        "material_id": r.material_id,
                        "title": r.title,
                        "distance": r.distance,
                        "material_url": r.material_url,
                        "marker_n": r.marker_n,
                        "source_kind": r.source_kind,
                    }
                    for r in retrieved_refs
                ],
            })
        # Skip system/tool messages — they're internal scaffolding.

    return {"thread_id": str(sid), "messages": out}


class IngestIn(BaseModel):
    project_id: str
    text: str
    title: str | None = None
    source_type: str = "text"
    uri: str | None = None
    metadata: dict | None = None
    # When set, this ingest is a "filed answer" from chat: the
    # backend will (1) dedup by content hash, (2) compute a connection
    # strength from the originating turn's message_citations, (3) write
    # material_lineage edges from each cited source → the new material,
    # and (4) cap per-concept graph density at 8 materials, dropping
    # the weakest filed entries to make room.
    filed_from_session_id: str | None = None
    filed_from_turn_seq: int | None = None


class IngestOut(BaseModel):
    material_id: str
    chunk_count: int
    # Background-pipeline tracker — present for PDF / URL uploads so the
    # UI can render a progress chip while metadata extraction, slug
    # rename, concept extraction, and wiki-link building catch up. Null
    # for the synchronous text-paste endpoint where there's nothing left
    # to monitor.
    job_id: str | None = None
    # True when the dedup hash matched an existing filed material in
    # the project: the existing material_id is returned, no new row
    # was created. Frontend uses this to swap the toast copy
    # ("Already filed — see existing source" vs "Filed as source").
    already_filed: bool = False
    # 'weak' | 'moderate' | 'strong' for chat-filed materials; null
    # otherwise. Weak = no supporting citations (inferred only); moderate
    # = 1 citation; strong = 2+ independent citations. Weak materials
    # are quarantined from the project Map graph by default.
    connection_strength: str | None = None


_FILED_HASH_NORMALIZER = re.compile(r"\s+")


def _filed_content_hash(text: str) -> str:
    """sha256 of whitespace-normalised text. Used to dedup chat-filed
    answers so the same reply doesn't accumulate as N near-identical
    materials each time the user re-clicks 'File as source'. We collapse
    runs of whitespace but otherwise preserve content so a single
    edit changes the hash."""
    normalised = _FILED_HASH_NORMALIZER.sub(" ", text).strip().lower()
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


_STRENGTH_ORDER = {"weak": 0, "moderate": 1, "strong": 2}


def _strength_from_citation_count(count: int) -> str:
    """Map citation count → connection strength per the vault spec:
    2+ sources = strong, 1 = moderate, 0 = weak (logically inferred,
    quarantined from the graph until a future source confirms)."""
    if count >= 2:
        return "strong"
    if count == 1:
        return "moderate"
    return "weak"


async def _filed_dedup_hit(
    conn, project_id: UUID, content_hash: str
) -> UUID | None:
    """Return the existing material_id if a previously-filed answer in
    this project has the same content hash. None on miss. Uses the
    partial index from migration 0019 so this is O(log n)."""
    cur = await conn.execute(
        "SELECT id FROM materials "
        "WHERE project_id = %s "
        "AND metadata->>'filed_content_hash' = %s "
        "LIMIT 1",
        (project_id, content_hash),
    )
    row = await cur.fetchone()
    return row[0] if row else None


async def _resolve_filing_provenance(
    conn,
    *,
    project_id: UUID,
    session_id: UUID,
    turn_seq: int,
    member_id: UUID,
) -> tuple[str, list[UUID]]:
    """Look up the originating chat turn's message_citations and return
    (strength, [unique cited material_ids]). The unique-ids list drives
    both the strength rating and the lineage edges.

    Sessions are personal — bind to ``created_by_member_id`` so a member
    cannot file someone else's session as their own and inherit that
    session's citation provenance / lineage edges / strength rating.
    On a session-not-owned-by-caller mismatch this returns weak + empty,
    same shape as a session with no citations."""
    cur = await conn.execute(
        "SELECT DISTINCT mc.material_id "
        "FROM message_citations mc "
        "JOIN sessions s ON s.id = mc.session_id "
        "WHERE mc.session_id = %s AND mc.turn_seq = %s "
        "AND s.project_id = %s "
        "AND s.created_by_member_id = %s",
        (session_id, turn_seq, project_id, member_id),
    )
    rows = await cur.fetchall()
    cited_ids = [r[0] for r in rows]
    return _strength_from_citation_count(len(cited_ids)), cited_ids


# Density cap for the concept→materials graph. Vault spec says 8.
_FILED_CONCEPT_DENSITY_CAP = 8


async def _enforce_concept_density_cap(
    conn,
    *,
    project_id: UUID,
    new_material_id: UUID,
    new_strength: str,
) -> int:
    """For each concept on the new filed material, count distinct
    project materials carrying that concept. When the count exceeds
    the cap, evict according to strength: if the new material is weak,
    drop the new concept link; otherwise look for a weaker existing
    filed material with the concept and drop ITS link to make room.
    Real (non-filed) materials are never evicted — they have implicit
    'real' strength which outranks every filed strength.
    Returns the number of links dropped (telemetry)."""
    cur = await conn.execute(
        "SELECT concept FROM material_concepts WHERE material_id = %s",
        (new_material_id,),
    )
    new_concepts = [r[0] for r in await cur.fetchall()]
    dropped = 0
    new_rank = _STRENGTH_ORDER.get(new_strength, 0)
    for concept in new_concepts:
        cur = await conn.execute(
            "SELECT count(*) FROM material_concepts mc "
            "JOIN materials m ON m.id = mc.material_id "
            "WHERE m.project_id = %s AND mc.concept = %s",
            (project_id, concept),
        )
        count_row = await cur.fetchone()
        count = int(count_row[0]) if count_row else 0
        if count <= _FILED_CONCEPT_DENSITY_CAP:
            continue
        if new_strength == "weak":
            # New filing is weak — drop the new link.
            await conn.execute(
                "DELETE FROM material_concepts WHERE material_id = %s AND concept = %s",
                (new_material_id, concept),
            )
            dropped += 1
            continue
        # Look for a weaker existing FILED material to evict. Real
        # materials (no 'connection_strength' metadata) outrank all
        # filed entries, so they stay.
        cur = await conn.execute(
            "SELECT m.id, m.metadata->>'connection_strength' "
            "FROM material_concepts mc "
            "JOIN materials m ON m.id = mc.material_id "
            "WHERE m.project_id = %s AND mc.concept = %s AND m.id <> %s "
            "AND m.metadata ? 'connection_strength'",
            (project_id, concept, new_material_id),
        )
        candidates = await cur.fetchall()
        # Find the weakest candidate strictly below new_rank.
        weakest_id: UUID | None = None
        weakest_rank = new_rank
        for cand_id, cand_strength in candidates:
            rank = _STRENGTH_ORDER.get(cand_strength or "weak", 0)
            if rank < weakest_rank:
                weakest_rank = rank
                weakest_id = cand_id
        if weakest_id is not None:
            await conn.execute(
                "DELETE FROM material_concepts WHERE material_id = %s AND concept = %s",
                (weakest_id, concept),
            )
            dropped += 1
        else:
            # No weaker filed material to evict; drop the new link to
            # keep within the cap.
            await conn.execute(
                "DELETE FROM material_concepts WHERE material_id = %s AND concept = %s",
                (new_material_id, concept),
            )
            dropped += 1
    return dropped


async def _write_lineage(
    conn,
    *,
    new_material_id: UUID,
    cited_ids: list[UUID],
    project_id: UUID,
    session_id: UUID,
    turn_seq: int,
) -> None:
    """Write material_lineage edges from each cited source → the new
    filed material. Conflict-tolerant so re-filing (e.g. after a
    dedup-miss race) doesn't blow up."""
    for source_id in cited_ids:
        if source_id == new_material_id:
            continue
        await conn.execute(
            "INSERT INTO material_lineage "
            "(source_id, filed_id, project_id, session_id, turn_seq) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (source_id, filed_id) DO NOTHING",
            (source_id, new_material_id, project_id, session_id, turn_seq),
        )


@app.post("/materials/ingest", response_model=IngestOut)
async def materials_ingest(
    body: IngestIn,
    request: Request,
    member: CurrentMember = Depends(current_member),
) -> IngestOut:
    # Cap text ingest — each call may also trigger LLM work via the
    # downstream pipeline (and PageIndex tree-build when enabled), so
    # bound the per-IP burst so one client can't burn the workspace's
    # LLM credits with a tight loop.
    await rate_enforce(request, endpoint="materials_ingest", limit=60)
    # Pre-flight: ingestion writes chunk embeddings, so it hard-requires
    # an embedding provider. Fail fast with an actionable code instead
    # of a raw provider-credentials stack trace deep in ingest_text.
    if not embedding_provider_available():
        raise HTTPException(
            status_code=400,
            detail=_err(
                "embedding_provider_unavailable",
                "Source indexing needs an embedding provider. Set "
                "OPENAI_API_KEY, GOOGLE_API_KEY, or a custom embedding endpoint in Settings.",
            ),
        )
    try:
        project_uuid = UUID(body.project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    # Resolve compounding-knowledge metadata BEFORE the ingest call so
    # the dedup short-circuit can return without spending an embedding
    # round-trip on a duplicate.
    is_chat_filing = body.filed_from_session_id is not None
    content_hash: str | None = None
    connection_strength: str | None = None
    cited_ids: list[UUID] = []
    session_uuid: UUID | None = None
    turn_seq: int | None = None
    augmented_metadata: dict = dict(body.metadata or {})

    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, project_uuid, member.workspace_id)

        if is_chat_filing:
            try:
                session_uuid = UUID(body.filed_from_session_id)
            except ValueError as e:
                raise HTTPException(
                    status_code=400, detail=_err("invalid_session_id"),
                ) from e
            turn_seq = body.filed_from_turn_seq
            # Caveat #1 — dedup by content hash.
            content_hash = _filed_content_hash(body.text)
            existing_id = await _filed_dedup_hit(conn, project_uuid, content_hash)
            if existing_id is not None:
                return IngestOut(
                    material_id=str(existing_id),
                    chunk_count=0,
                    already_filed=True,
                    connection_strength=None,
                )
            # Caveat #2 — strength from supporting citations. Bound to
            # the caller's member id so a workspace-mate cannot hijack
            # another member's session for free citation provenance.
            if turn_seq is not None:
                connection_strength, cited_ids = await _resolve_filing_provenance(
                    conn,
                    project_id=project_uuid,
                    session_id=session_uuid,
                    turn_seq=turn_seq,
                    member_id=member.id,
                )
            else:
                connection_strength = "weak"
            augmented_metadata.update({
                "filed_from": augmented_metadata.get("filed_from", "chat"),
                "filed_content_hash": content_hash,
                "filed_from_session_id": str(session_uuid),
                "filed_from_turn_seq": turn_seq,
                "connection_strength": connection_strength,
            })

        try:
            # Chat-filing bundles material+chunks with lineage/concepts/
            # density-cap into a single transaction so a mid-bundle
            # failure can't leave a stale `filed_content_hash` orphan
            # (which would block re-filing forever).
            result = await ingest_text(
                conn,
                project_id=project_uuid,
                text=body.text,
                title=body.title,
                source_type=body.source_type,
                uri=body.uri,
                metadata=augmented_metadata,
                commit=not is_chat_filing,
            )
        except ValueError as e:
            logger.warning("ingest validation failed", exc_info=True)
            raise HTTPException(
                status_code=400, detail=_err("ingest_invalid", str(e)),
            ) from e
        except Exception as e:
            logger.exception("ingestion error in /materials/ingest")
            raise HTTPException(
                status_code=502,
                detail=_err("ingestion_failed", "Failed to ingest material."),
            ) from e

        if is_chat_filing:
            # Caveat #4 — lineage edges.
            if cited_ids and session_uuid is not None and turn_seq is not None:
                await _write_lineage(
                    conn,
                    new_material_id=result.material_id,
                    cited_ids=cited_ids,
                    project_id=project_uuid,
                    session_id=session_uuid,
                    turn_seq=turn_seq,
                )
            # Run concept extraction inline so the new material's
            # concepts are immediately available for the density cap +
            # project Map view. PDF/URL ingest does this in a background
            # job (ingestion_pipeline) but the chat-filing path is
            # synchronous — users expect the new node to appear in the
            # map right away.
            concept_text = f"{body.title or ''}\n{body.text}"
            concepts = extract_concepts(concept_text)
            if concepts:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        "INSERT INTO material_concepts (material_id, concept) "
                        "VALUES (%s, %s) ON CONFLICT (material_id, concept) DO NOTHING",
                        [(result.material_id, c) for c in concepts],
                    )
            # Caveat #3 — concept density cap (applies only to chat
            # filings; PDFs/URLs are real sources and bypass the cap).
            if connection_strength is not None:
                await _enforce_concept_density_cap(
                    conn,
                    project_id=project_uuid,
                    new_material_id=result.material_id,
                    new_strength=connection_strength,
                )
            await conn.commit()

    return IngestOut(
        material_id=str(result.material_id),
        chunk_count=result.chunk_count,
        already_filed=False,
        connection_strength=connection_strength,
    )


class IngestUrlIn(BaseModel):
    project_id: str
    url: str = Field(..., min_length=8, max_length=2048)
    title: str | None = None
    model: str | None = None


@app.post("/external/preview", response_model=ExternalPreviewOut)
async def external_preview(
    body: ExternalPreviewIn,
    request: Request,
    member: CurrentMember = Depends(current_member),
) -> ExternalPreviewOut:
    # Read-only preview for MCP/web results. This deliberately does not
    # create a material, chunk, embedding, or citation row; the user must
    # explicitly choose "Add to project sources" after reviewing.
    await rate_enforce(request, endpoint="external_preview", limit=120)
    try:
        ext = await fetch_and_extract_url(body.url)
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=_err("preview_invalid", "We couldn't process that URL."),
        ) from e
    except Exception as e:
        logger.warning("external preview fetch failed", exc_info=True)
        raise HTTPException(
            status_code=502,
            detail=_err("preview_fetch_failed", "We couldn't fetch that external source."),
        ) from e

    title = getattr(ext, "title", None)
    content = (
        getattr(ext, "text", None)
        or getattr(ext, "content", None)
        or getattr(ext, "markdown", None)
        or ""
    ).strip()
    if not content:
        raise HTTPException(
            status_code=422,
            detail=_err("preview_empty", "That source did not expose readable text."),
        )
    return ExternalPreviewOut(url=body.url, title=title, content=content[:200_000])


@app.post("/materials/ingest-url", response_model=IngestOut)
async def materials_ingest_url(
    body: IngestUrlIn,
    request: Request,
    member: CurrentMember = Depends(current_member),
) -> IngestOut:
    # URL ingest fetches an external resource AND runs the same pipeline
    # as PDF ingest (metadata extract, concepts, links, optional tree).
    # Tighter cap than text ingest because fetch egress amplifies abuse.
    await rate_enforce(request, endpoint="materials_ingest_url", limit=30)
    if not embedding_provider_available():
        raise HTTPException(
            status_code=400,
            detail=_err(
                "embedding_provider_unavailable",
                "Source indexing needs an embedding provider. Set "
                "OPENAI_API_KEY, GOOGLE_API_KEY, or a custom embedding endpoint in Settings.",
            ),
        )
    try:
        project_uuid = UUID(body.project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    effective_model = _resolve_chat_model(body.model)

    # Workspace check first — same anti-side-channel rule as PDF ingest.
    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, project_uuid, member.workspace_id)

    try:
        ext = await fetch_and_extract_url(body.url)
    except ValueError as e:
        logger.warning("ingest validation failed", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=_err("ingest_invalid", "We couldn't process that URL."),
        ) from e
    except Exception as e:  # httpx.HTTPError + everything else
        # Do not echo the raw httpx error — it can carry resolver state,
        # internal hostnames, or proxy hints that aid SSRF recon. Log
        # server-side, return a generic client-facing message.
        logger.warning("url fetch failed", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=_err("url_fetch_failed", "We couldn't fetch that URL."),
        ) from e

    if not ext.text:
        raise HTTPException(status_code=400, detail=_err("empty_url_content"))

    async with get_conn() as conn:
        try:
            result = await ingest_text(
                conn,
                project_id=project_uuid,
                text=ext.text,
                title=body.title or ext.title or body.url,
                source_type="url",
                uri=ext.final_url,
                metadata={
                    "original_url": body.url,
                    "fetched_url": ext.final_url,
                    "content_type": ext.content_type,
                    "extracted_title": ext.title,
                    **(ext.extra or {}),
                },
            )
        except ValueError as e:
            logger.warning("ingest validation failed", exc_info=True)
            raise HTTPException(
                status_code=400,
                detail=_err("ingest_invalid", "We couldn't process that URL."),
            ) from e
        except Exception as e:
            logger.exception("ingestion error in /materials/ingest-url")
            raise HTTPException(
                status_code=502,
                detail=_err("ingestion_failed", "Failed to ingest material."),
            ) from e
        job_id = await create_job(
            conn, material_id=result.material_id, project_id=project_uuid
        )
    _spawn(
        run_pipeline(
            job_id=job_id,
            material_id=result.material_id,
            project_id=project_uuid,
            full_text=ext.text,
            original_filename=body.url,
            fallback_title=body.title or ext.title or body.url,
            model=effective_model,
        ),
        label="ingest_url_pipeline",
    )
    return IngestOut(
        material_id=str(result.material_id),
        chunk_count=result.chunk_count,
        job_id=str(job_id),
    )


# 50 MB hard cap on uploaded PDFs. Larger papers exist (full thesis,
# textbook scans) but they need a streaming path; punt for the beta.
_PDF_MAX_BYTES = 50 * 1024 * 1024


@app.post("/materials/ingest-pdf", response_model=IngestOut)
async def materials_ingest_pdf(
    request: Request,
    project_id: str = Form(...),
    model: str | None = Form(default=None),
    file: UploadFile = File(...),
    member: CurrentMember = Depends(current_member),
) -> IngestOut:
    # PDF ingest is the most expensive path — text extract + chunk +
    # embed synchronously, then a background pipeline that (with the
    # pagetree flag on) runs many LLM calls per document. Cap to 20/window
    # so a single client cannot burn the workspace bill.
    await rate_enforce(request, endpoint="materials_ingest_pdf", limit=20)
    if not embedding_provider_available():
        raise HTTPException(
            status_code=400,
            detail=_err(
                "embedding_provider_unavailable",
                "Source indexing needs an embedding provider. Set "
                "OPENAI_API_KEY, GOOGLE_API_KEY, or a custom embedding endpoint in Settings.",
            ),
        )
    try:
        project_uuid = UUID(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_project_id")) from e

    effective_model = _resolve_chat_model(model)

    # Authorize before doing any expensive work or surfacing PDF errors —
    # otherwise cross-workspace requests would leak via different error codes.
    async with get_conn() as conn:
        await _assert_project_in_workspace(conn, project_uuid, member.workspace_id)

    contents = await file.read()
    if len(contents) > _PDF_MAX_BYTES:
        raise HTTPException(status_code=413, detail=_err("file_too_large"))
    if not contents.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail=_err("not_a_pdf"))

    try:
        extraction = await asyncio.get_running_loop().run_in_executor(
            None, extract_pdf_text, contents
        )
    except ValueError as e:
        logger.warning("ingest validation failed", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=_err("ingest_invalid", "We couldn't process that PDF."),
        ) from e

    if not extraction.text:
        raise HTTPException(status_code=400, detail=_err("empty_pdf"))

    async with get_conn() as conn:
        try:
            result = await ingest_text(
                conn,
                project_id=project_uuid,
                text=extraction.text,
                title=file.filename or "uploaded.pdf",
                source_type="pdf",
                metadata={
                    "pages": extraction.page_count,
                    "size_bytes": len(contents),
                    "filename": file.filename,
                },
                original_bytes=contents,
                original_mime="application/pdf",
            )
        except ValueError as e:
            logger.warning("ingest validation failed", exc_info=True)
            raise HTTPException(
                status_code=400,
                detail=_err("ingest_invalid", "We couldn't process that PDF."),
            ) from e
        except Exception as e:
            logger.exception("ingestion error in /materials/ingest-pdf")
            raise HTTPException(
                status_code=502,
                detail=_err("ingestion_failed", "Failed to ingest material."),
            ) from e
        job_id = await create_job(
            conn, material_id=result.material_id, project_id=project_uuid
        )
    # Pipeline (rename → metadata → concepts → wiki links) runs in the
    # background so the user gets the material immediately. Errors are
    # captured on the job row — the material stays searchable either way.
    _spawn(
        run_pipeline(
            job_id=job_id,
            material_id=result.material_id,
            project_id=project_uuid,
            full_text=extraction.text,
            original_filename=file.filename,
            fallback_title=file.filename,
            model=effective_model,
        ),
        label="ingest_pdf_pipeline",
    )
    return IngestOut(
        material_id=str(result.material_id),
        chunk_count=result.chunk_count,
        job_id=str(job_id),
    )


# ── Long-term memory (general + project chats) ─────────────────────
# Single table backs both scopes (see migration 0025). The core block
# (singleton per scope) is pinned into the system prompt; non-core rows
# feed the future hybrid retriever (slice 3). All routes scope by
# ``member.id`` so a workspace boundary breach collapses to a 404.

from . import memory as _memory_pkg  # local import to keep section co-located


class MemoryCoreOut(BaseModel):
    scope: str
    project_id: str | None
    title: str
    body: str
    updated_at: str | None


class MemoryCoreIn(BaseModel):
    scope: str
    project_id: str | None = None
    title: str = ""
    body: str


class MemoryRowIn(BaseModel):
    scope: str
    project_id: str | None = None
    kind: str
    title: str
    body: str


class MemoryRowPatchIn(BaseModel):
    kind: str
    title: str
    body: str


class MemoryRowOut(BaseModel):
    id: str
    scope: str
    project_id: str | None
    kind: str
    title: str
    body: str
    source_session: str | None
    archived_at: str | None
    created_at: str
    updated_at: str
    confidence: str | None
    last_recalled_at: str | None


def _validate_memory_scope_args(scope: str, project_id: str | None) -> UUID | None:
    if scope not in ("general", "project"):
        raise HTTPException(status_code=400, detail=_err("invalid_scope"))
    if scope == "project":
        if not project_id:
            raise HTTPException(status_code=400, detail=_err("project_id_required"))
        try:
            return UUID(project_id)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=_err("invalid_project_id")
            ) from e
    if project_id:
        raise HTTPException(
            status_code=400, detail=_err("project_id_forbidden_for_general")
        )
    return None


def _validate_memory_kind(kind: str) -> str:
    if kind not in ("preference", "project_fact", "open_question", "reference"):
        raise HTTPException(status_code=400, detail=_err("invalid_memory_kind"))
    return kind


def _row_to_memory_out(row: "_memory_pkg.MemoryRow") -> MemoryRowOut:
    return MemoryRowOut(
        id=str(row.id),
        scope=row.scope,
        project_id=str(row.project_id) if row.project_id else None,
        kind=row.kind,
        title=row.title,
        body=row.body,
        source_session=str(row.source_session) if row.source_session else None,
        archived_at=_iso(row.archived_at) if row.archived_at else None,
        created_at=_iso(row.created_at),
        updated_at=_iso(row.updated_at),
        confidence=row.confidence,
        last_recalled_at=(
            _iso(row.last_recalled_at) if row.last_recalled_at else None
        ),
    )


async def _assert_project_membership(member: CurrentMember, project_id: UUID) -> None:
    """Confirm the project lives in the member's workspace — same 404
    collapse pattern as other gated endpoints. Avoids cross-workspace
    project_id leakage through the memory surface."""
    async with get_conn() as conn:
        row = await (
            await conn.execute(
                "SELECT 1 FROM projects WHERE id=%s AND workspace_id=%s",
                (project_id, member.workspace_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=_err("project_not_found"))


@app.get("/memories/core", response_model=MemoryCoreOut)
async def get_memory_core(
    scope: str,
    project_id: str | None = None,
    member: CurrentMember = Depends(current_member),
) -> MemoryCoreOut:
    pj = _validate_memory_scope_args(scope, project_id)
    if pj is not None:
        await _assert_project_membership(member, pj)
    row = await _memory_pkg.get_core(
        member_id=member.id, scope=scope, project_id=pj  # type: ignore[arg-type]
    )
    if row is None:
        return MemoryCoreOut(
            scope=scope,
            project_id=project_id,
            title="",
            body="",
            updated_at=None,
        )
    return MemoryCoreOut(
        scope=row.scope,
        project_id=str(row.project_id) if row.project_id else None,
        title=row.title,
        body=row.body,
        updated_at=_iso(row.updated_at),
    )


@app.put("/memories/core", response_model=MemoryCoreOut)
async def put_memory_core(
    body_in: MemoryCoreIn,
    member: CurrentMember = Depends(current_member),
) -> MemoryCoreOut:
    pj = _validate_memory_scope_args(body_in.scope, body_in.project_id)
    if pj is not None:
        await _assert_project_membership(member, pj)
    row = await _memory_pkg.upsert_core(
        member_id=member.id,
        scope=body_in.scope,  # type: ignore[arg-type]
        project_id=pj,
        title=body_in.title,
        body=body_in.body,
    )
    return MemoryCoreOut(
        scope=row.scope,
        project_id=str(row.project_id) if row.project_id else None,
        title=row.title,
        body=row.body,
        updated_at=_iso(row.updated_at),
    )


@app.post("/memories", response_model=MemoryRowOut)
async def create_memory_row(
    body_in: MemoryRowIn,
    member: CurrentMember = Depends(current_member),
) -> MemoryRowOut:
    pj = _validate_memory_scope_args(body_in.scope, body_in.project_id)
    if pj is not None:
        await _assert_project_membership(member, pj)
    kind = _validate_memory_kind(body_in.kind)
    if not body_in.title.strip() or not body_in.body.strip():
        raise HTTPException(status_code=400, detail=_err("empty_memory"))
    from .memory.embedding import embed_memory_text

    embedding = await embed_memory_text(body_in.title, body_in.body)
    row = await _memory_pkg.save_memory(
        member_id=member.id,
        scope=body_in.scope,  # type: ignore[arg-type]
        project_id=pj,
        kind=kind,  # type: ignore[arg-type]
        title=body_in.title,
        body=body_in.body,
        embedding=embedding,
        confidence="high",
    )
    return _row_to_memory_out(row)


@app.get("/memories", response_model=list[MemoryRowOut])
async def list_memory_rows(
    scope: str,
    project_id: str | None = None,
    kind: str | None = None,
    include_archived: bool = False,
    member: CurrentMember = Depends(current_member),
) -> list[MemoryRowOut]:
    pj = _validate_memory_scope_args(scope, project_id)
    if pj is not None:
        await _assert_project_membership(member, pj)
    rows = await _memory_pkg.list_memories(
        member_id=member.id,
        scope=scope,  # type: ignore[arg-type]
        project_id=pj,
        kind=kind,  # type: ignore[arg-type]
        include_archived=include_archived,
    )
    return [_row_to_memory_out(r) for r in rows]


@app.patch("/memories/{memory_id}", response_model=MemoryRowOut)
async def update_memory_row(
    memory_id: str,
    body_in: MemoryRowPatchIn,
    member: CurrentMember = Depends(current_member),
) -> MemoryRowOut:
    try:
        mid = UUID(memory_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_memory_id")) from e
    kind = _validate_memory_kind(body_in.kind)
    if not body_in.title.strip() or not body_in.body.strip():
        raise HTTPException(status_code=400, detail=_err("empty_memory"))
    from .memory.embedding import embed_memory_text

    embedding = await embed_memory_text(body_in.title, body_in.body)
    row = await _memory_pkg.update_memory(
        member_id=member.id,
        memory_id=mid,
        kind=kind,  # type: ignore[arg-type]
        title=body_in.title,
        body=body_in.body,
        embedding=embedding,
        confidence="high",
    )
    if row is None:
        raise HTTPException(status_code=404, detail=_err("memory_not_found"))
    return _row_to_memory_out(row)


@app.delete("/memories/{memory_id}", status_code=204)
async def archive_memory_row(
    memory_id: str, member: CurrentMember = Depends(current_member)
) -> None:
    try:
        mid = UUID(memory_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_err("invalid_memory_id")) from e
    ok = await _memory_pkg.archive_memory(member_id=member.id, memory_id=mid)
    if not ok:
        raise HTTPException(status_code=404, detail=_err("memory_not_found"))


# ── Frontend static-asset serving (the .deb install case) ──────────
# When NOTESCI_STATIC_DIR points at a directory, the backend serves the
# built SPA from it: any GET that doesn't match an API route is treated
# as either a static file or (for SPA client-routed paths) the index
# shell. In dev this var is unset and the Vite dev server handles the
# frontend; this block is a no-op.
_STATIC_DIR_ENV = os.environ.get("NOTESCI_STATIC_DIR")
if _STATIC_DIR_ENV:
    _STATIC_DIR = _Path(_STATIC_DIR_ENV).resolve()
    _INDEX_HTML = _STATIC_DIR / "index.html"

    # Cache policy for the SPA:
    #   * /assets/* — content-hashed by Vite, safe to cache forever.
    #   * everything else (index.html, /favicon.svg, raw paths used as
    #     SPA shells) — must revalidate every load so the user picks
    #     up a freshly installed build immediately. Without the
    #     no-cache hint, WebKitGTK happily serves yesterday's
    #     index.html and the new bundle hashes never get fetched.
    _IMMUTABLE_HEADERS = {
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    _NO_CACHE_HEADERS = {
        "Cache-Control": "no-cache, must-revalidate",
    }

    def _read_local_token() -> str | None:
        """Best-effort load of the bootstrap session token.

        Local-mode lifespan writes ``settings.notesci_local_token_path``
        on first launch (or reuses the existing one). We read it lazily
        on every index.html serve so a freshly minted token after the
        old one expired is picked up without a process restart.
        """
        if not settings.notesci_local_mode:
            return None
        try:
            return _Path(settings.notesci_local_token_path).read_text().strip() or None
        except OSError:
            return None

    def _index_html_with_local_token() -> Response:
        """Inject ``localStorage['notesci_token']`` into the SPA shell.

        Replaces ``<head>`` with ``<head><script>…</script>`` so the
        token is seeded before ``index-<hash>.js`` parses and reads it
        via ``getToken()`` in ``lib/api``. The script only runs when a
        token is actually available — non-local-mode deploys serve the
        unmodified shell and fall back to the sign-in flow.
        """
        body = _INDEX_HTML.read_text(encoding="utf-8")
        tok = _read_local_token()
        if tok:
            # JSON-encode to safely embed inside a <script> tag.
            safe = json.dumps(tok)
            inject = (
                "<head><script>try{localStorage.setItem('notesci_token',"
                + safe
                + ")}catch(e){}</script>"
            )
            body = body.replace("<head>", inject, 1)
        return Response(
            content=body,
            media_type="text/html; charset=utf-8",
            headers=_NO_CACHE_HEADERS,
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa_fallback(full_path: str):
        # Don't shadow Swagger / OpenAPI / Redoc.
        if full_path in ("openapi.json", "docs", "redoc") or full_path.startswith(
            ("docs/", "redoc/")
        ):
            raise HTTPException(status_code=404)

        # Literal asset (e.g. /assets/index-abc.js, /favicon.svg).
        if full_path:
            target = (_STATIC_DIR / full_path).resolve()
            # Path-traversal guard — never serve files outside the
            # configured static dir even if the URL contains "..".
            try:
                target.relative_to(_STATIC_DIR)
            except ValueError as exc:
                raise HTTPException(status_code=404) from exc
            if target.is_file():
                headers = (
                    _IMMUTABLE_HEADERS
                    if full_path.startswith("assets/")
                    else _NO_CACHE_HEADERS
                )
                return FileResponse(target, headers=headers)

        # Client-routed SPA path (e.g. /sign-in, /p/abc123) — serve the
        # SPA shell so React Router can take over on the client.
        if _INDEX_HTML.is_file():
            return _index_html_with_local_token()
        raise HTTPException(status_code=404)
