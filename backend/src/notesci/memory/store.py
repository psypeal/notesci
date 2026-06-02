"""CRUD against the ``memories`` table.

Convention mirrors ``ingest.py``: tuple-row psycopg, ``get_conn()`` for
connection acquisition, manual ``conn.commit()`` at write sites. No ORM.

Scope rules enforced here (also CHECK'd in the schema, but caller errors
should be intelligible without round-tripping to PG):
    scope='general'  → project_id MUST be None.
    scope='project'  → project_id MUST be a real UUID.
The ``_validate_scope`` helper raises ``ValueError`` rather than letting
Postgres raise ``CheckViolation`` so the API layer gets a clean 400.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
from typing import Literal
from uuid import UUID

from pgvector.psycopg import register_vector_async

from ..db import get_conn

Scope = Literal["general", "project"]
Kind = Literal["core", "preference", "project_fact", "open_question", "reference"]

_VALID_KINDS: tuple[Kind, ...] = (
    "core",
    "preference",
    "project_fact",
    "open_question",
    "reference",
)


@dataclass
class MemoryRow:
    id: UUID
    member_id: UUID
    scope: Scope
    project_id: UUID | None
    kind: Kind
    title: str
    body: str
    source_session: UUID | None
    superseded_by: UUID | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    confidence: str | None = None
    last_recalled_at: datetime | None = None


def _validate_scope(scope: Scope, project_id: UUID | None) -> None:
    if scope == "general" and project_id is not None:
        raise ValueError("scope='general' must not carry a project_id")
    if scope == "project" and project_id is None:
        raise ValueError("scope='project' requires a project_id")


def _row_to_memory(row: tuple) -> MemoryRow:
    (
        mid,
        member_id,
        scope,
        project_id,
        kind,
        title,
        body,
        source_session,
        superseded_by,
        archived_at,
        created_at,
        updated_at,
        confidence,
        last_recalled_at,
    ) = row
    return MemoryRow(
        id=mid,
        member_id=member_id,
        scope=scope,
        project_id=project_id,
        kind=kind,
        title=title,
        body=body,
        source_session=source_session,
        superseded_by=superseded_by,
        archived_at=archived_at,
        created_at=created_at,
        updated_at=updated_at,
        confidence=confidence,
        last_recalled_at=last_recalled_at,
    )


_SELECT_COLS = (
    "id, member_id, scope, project_id, kind, title, body, "
    "source_session, superseded_by, archived_at, created_at, updated_at, "
    "confidence, last_recalled_at"
)

_WS_RE = re.compile(r"\s+")


def _norm_text(value: str) -> str:
    return _WS_RE.sub(" ", value).strip().lower()


async def save_memory(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    kind: Kind,
    title: str,
    body: str,
    embedding: list[float] | None = None,
    source_session: UUID | None = None,
    confidence: str | None = None,
) -> MemoryRow:
    """Insert one approved memory row. ``embedding`` may be None for
    rows we'll embed lazily (or core, which is never embedded — it's
    pinned into the prompt directly, not retrieved).

    ``confidence`` is the writer's self-assessed durability:
        * 'high'   — durable researcher pref / load-bearing fact. Always
                     persisted by callers; the sweeper-driven extractor
                     gates on this so only solid rows reach storage.
        * 'medium' — possibly durable; today we don't write these.
        * 'low'    — transient. Not written by the extractor.
    Hot-path ``memory_save`` (user explicitly said "remember X") writes
    'high' unconditionally — explicit intent is the strongest signal."""
    _validate_scope(scope, project_id)
    if kind not in _VALID_KINDS:
        raise ValueError(f"unknown memory kind: {kind!r}")
    if kind == "core":
        raise ValueError("use upsert_core() for core blocks")
    if not title.strip() or not body.strip():
        raise ValueError("memory title and body must be non-empty")
    if confidence is not None and confidence not in ("high", "medium", "low"):
        raise ValueError(f"invalid confidence: {confidence!r}")

    async with get_conn() as conn:
        if embedding is not None:
            await register_vector_async(conn)
        if scope == "project":
            scope_clause = "scope = 'project' AND project_id = %s"
            scope_params: tuple[object, ...] = (project_id,)
        else:
            scope_clause = "scope = 'general' AND project_id IS NULL"
            scope_params = ()
        existing = await (
            await conn.execute(
                f"""
                SELECT id FROM memories
                WHERE member_id = %s
                  AND {scope_clause}
                  AND kind = %s
                  AND archived_at IS NULL
                  AND (
                    lower(btrim(regexp_replace(title, '\\s+', ' ', 'g'))) = %s
                    OR lower(btrim(regexp_replace(body, '\\s+', ' ', 'g'))) = %s
                  )
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (
                    member_id,
                    *scope_params,
                    kind,
                    _norm_text(title),
                    _norm_text(body),
                ),
            )
        ).fetchone()
        if existing is not None:
            row = await (
                await conn.execute(
                    f"""
                    UPDATE memories
                    SET title = %s,
                        body = %s,
                        embedding = %s,
                        source_session = COALESCE(source_session, %s),
                        confidence = COALESCE(%s, confidence),
                        updated_at = now()
                    WHERE id = %s
                    RETURNING {_SELECT_COLS}
                    """,
                    (
                        title.strip(),
                        body.strip(),
                        embedding,
                        source_session,
                        confidence,
                        existing[0],
                    ),
                )
            ).fetchone()
            await conn.commit()
            return _row_to_memory(row)
        row = await (
            await conn.execute(
                f"INSERT INTO memories "
                f"(member_id, scope, project_id, kind, title, body, "
                f"embedding, source_session, confidence) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) "
                f"RETURNING {_SELECT_COLS}",
                (
                    member_id,
                    scope,
                    project_id,
                    kind,
                    title.strip(),
                    body.strip(),
                    embedding,
                    source_session,
                    confidence,
                ),
            )
        ).fetchone()
        await conn.commit()
    return _row_to_memory(row)


async def list_memories(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None = None,
    kind: Kind | None = None,
    include_archived: bool = False,
    limit: int = 200,
) -> list[MemoryRow]:
    _validate_scope(scope, project_id)
    clauses = ["member_id = %s", "scope = %s"]
    params: list[object] = [member_id, scope]
    if scope == "project":
        clauses.append("project_id = %s")
        params.append(project_id)
    else:
        clauses.append("project_id IS NULL")
    if kind is not None:
        clauses.append("kind = %s")
        params.append(kind)
    if not include_archived:
        clauses.append("archived_at IS NULL")
    where = " AND ".join(clauses)

    async with get_conn() as conn:
        rows = await (
            await conn.execute(
                f"SELECT {_SELECT_COLS} FROM memories "
                f"WHERE {where} "
                f"ORDER BY updated_at DESC LIMIT %s",
                (*params, limit),
            )
        ).fetchall()
    return [_row_to_memory(r) for r in rows]


async def update_memory(
    *,
    member_id: UUID,
    memory_id: UUID,
    kind: Kind,
    title: str,
    body: str,
    embedding: list[float] | None = None,
    confidence: str | None = None,
) -> MemoryRow | None:
    """Update one non-core memory row owned by ``member_id``.

    Returns None when the row is missing, archived, core-only, or belongs
    to another member. Scope is intentionally immutable; moving facts
    across scopes should be an explicit archive-and-create action so
    provenance remains understandable.
    """
    if kind not in _VALID_KINDS or kind == "core":
        raise ValueError(f"invalid memory kind: {kind!r}")
    if not title.strip() or not body.strip():
        raise ValueError("memory title and body must be non-empty")
    if confidence is not None and confidence not in ("high", "medium", "low"):
        raise ValueError(f"invalid confidence: {confidence!r}")

    async with get_conn() as conn:
        if embedding is not None:
            await register_vector_async(conn)
        row = await (
            await conn.execute(
                f"""
                UPDATE memories
                SET kind = %s,
                    title = %s,
                    body = %s,
                    embedding = %s,
                    confidence = COALESCE(%s, confidence),
                    updated_at = now()
                WHERE id = %s
                  AND member_id = %s
                  AND kind <> 'core'
                  AND archived_at IS NULL
                RETURNING {_SELECT_COLS}
                """,
                (
                    kind,
                    title.strip(),
                    body.strip(),
                    embedding,
                    confidence,
                    memory_id,
                    member_id,
                ),
            )
        ).fetchone()
        await conn.commit()
    return _row_to_memory(row) if row else None


async def archive_memory(*, member_id: UUID, memory_id: UUID) -> bool:
    """Soft-delete one memory row. Returns False if the row doesn't
    exist or belongs to a different member (workspace-isolation rule
    from CLAUDE.md: collapse cross-member lookups to a 'not found')."""
    async with get_conn() as conn:
        cur = await conn.execute(
            "UPDATE memories SET archived_at = now(), updated_at = now() "
            "WHERE id = %s AND member_id = %s AND archived_at IS NULL",
            (memory_id, member_id),
        )
        await conn.commit()
        return cur.rowcount > 0


async def get_core(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None = None,
) -> MemoryRow | None:
    """Fetch the singleton core block for a scope, or None if empty."""
    _validate_scope(scope, project_id)
    if scope == "project":
        project_clause = "project_id = %s"
        params: tuple = (member_id, project_id)
    else:
        project_clause = "project_id IS NULL"
        params = (member_id,)

    async with get_conn() as conn:
        row = await (
            await conn.execute(
                f"SELECT {_SELECT_COLS} FROM memories "
                f"WHERE member_id = %s AND kind = 'core' AND scope = '{scope}' "
                f"  AND {project_clause} AND archived_at IS NULL "
                f"LIMIT 1",
                params,
            )
        ).fetchone()
    return _row_to_memory(row) if row else None


async def upsert_core(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    title: str,
    body: str,
) -> MemoryRow:
    """Create or update the singleton core block for a scope.

    Empty body is allowed (lets the user 'clear' the block without
    archiving the row). Empty title gets a sensible default per scope."""
    _validate_scope(scope, project_id)
    title = title.strip() or (
        "Project context" if scope == "project" else "Researcher profile"
    )

    existing = await get_core(member_id=member_id, scope=scope, project_id=project_id)
    if existing is not None:
        async with get_conn() as conn:
            row = await (
                await conn.execute(
                    f"UPDATE memories SET title = %s, body = %s, updated_at = now() "
                    f"WHERE id = %s "
                    f"RETURNING {_SELECT_COLS}",
                    (title, body, existing.id),
                )
            ).fetchone()
            await conn.commit()
        return _row_to_memory(row)

    async with get_conn() as conn:
        row = await (
            await conn.execute(
                f"INSERT INTO memories "
                f"(member_id, scope, project_id, kind, title, body) "
                f"VALUES (%s, %s, %s, 'core', %s, %s) "
                f"RETURNING {_SELECT_COLS}",
                (member_id, scope, project_id, title, body),
            )
        ).fetchone()
        await conn.commit()
    return _row_to_memory(row)
