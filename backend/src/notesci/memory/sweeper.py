"""Memory sweeper — owns extraction triggering AND growth bounds.

Two periodic tasks, run on different cadences:

  * ``process_pending_extractions`` (every 2 min). Picks jobs from
    ``memory_extraction_jobs`` where the session has been idle for
    ≥``IDLE_EXTRACT_SECONDS`` and either was never processed or has
    new turns since the last extraction. Runs one batch extraction
    per matched session.

  * ``enforce_cap_for_scope`` (run inline after each extraction).
    If a scope holds more than ``MAX_ROWS_PER_SCOPE`` non-archived
    non-core rows, archives the LRU rows (oldest by
    ``COALESCE(last_recalled_at, created_at)``) until the count is
    back at the cap.

Failure posture (matches ``sweeper.py``): a per-iteration exception
is logged but never propagates. Only task cancellation breaks the
loop. The memory layer must never wedge the backend.
"""

from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from ..db import get_conn
from .extractor import extract_from_session
from .store import Scope

log = logging.getLogger(__name__)

# How long a session must be idle before we extract. Long enough that
# the user has clearly stopped typing; short enough that fresh memories
# are available next time they open the app.
IDLE_EXTRACT_SECONDS = 10 * 60

# Hard ceiling per (member, scope, project_id). Extraction adds rows
# above this; the cap-enforcer archives oldest-LRU rows back down.
MAX_ROWS_PER_SCOPE = 200

# How many jobs to process per sweeper iteration. Each one is an LLM
# call — capping the batch keeps a flurry of session-idle wakeups from
# pegging the provider.
MAX_JOBS_PER_TICK = 8


async def _claim_pending_jobs(limit: int) -> list[tuple[UUID, UUID]]:
    """Return up to ``limit`` (session_id, member_id) tuples to process.

    Uses SKIP LOCKED so concurrent sweeper invocations (multi-worker
    deploys) don't double-process the same job."""
    async with get_conn() as conn:
        cur = await conn.execute(
            f"""
            SELECT session_id, member_id
            FROM memory_extraction_jobs
            WHERE last_message_at < now() - interval '{IDLE_EXTRACT_SECONDS} seconds'
              AND (
                processed_at IS NULL
                OR last_processed_message_at IS NULL
                OR last_processed_message_at < last_message_at
              )
            ORDER BY last_message_at ASC
            LIMIT %s
            FOR UPDATE SKIP LOCKED
            """,
            (limit,),
        )
        rows = await cur.fetchall()
    return [(r[0], r[1]) for r in rows]


async def _mark_processed(session_id: UUID) -> None:
    async with get_conn() as conn:
        await conn.execute(
            """
            UPDATE memory_extraction_jobs
            SET processed_at = now(),
                last_processed_message_at = last_message_at
            WHERE session_id = %s
            """,
            (session_id,),
        )
        await conn.commit()


async def _resolve_session_scope(session_id: UUID) -> tuple[Scope, UUID | None] | None:
    """Map a session to (scope, project_id) or None if the session has
    been deleted between enqueue and sweep."""
    async with get_conn() as conn:
        row = await (
            await conn.execute(
                "SELECT project_id FROM sessions WHERE id = %s",
                (session_id,),
            )
        ).fetchone()
    if not row:
        return None
    pid = row[0]
    return ("project" if pid else "general", pid)


async def enforce_cap_for_scope(
    member_id: UUID, scope: Scope, project_id: UUID | None
) -> int:
    """Archive LRU rows when a scope has more than MAX_ROWS_PER_SCOPE
    non-archived non-core rows. Returns the number archived."""
    if scope == "project":
        scope_sql = "scope = 'project' AND project_id = %s"
        scope_params: tuple = (project_id,)
    else:
        scope_sql = "scope = 'general' AND project_id IS NULL"
        scope_params = ()

    async with get_conn() as conn:
        cur = await conn.execute(
            f"""
            SELECT count(*) FROM memories
            WHERE member_id = %s AND {scope_sql}
              AND kind <> 'core' AND archived_at IS NULL
            """,
            (member_id, *scope_params),
        )
        row = await cur.fetchone()
        count = row[0] if row else 0
        if count <= MAX_ROWS_PER_SCOPE:
            return 0

        excess = count - MAX_ROWS_PER_SCOPE
        # Archive the LRU rows: ordered by last access (or creation if
        # never recalled) ascending. NULLS FIRST puts never-recalled
        # rows ahead of recently-recalled ones at the same timestamp.
        cur = await conn.execute(
            f"""
            WITH lru AS (
                SELECT id FROM memories
                WHERE member_id = %s AND {scope_sql}
                  AND kind <> 'core' AND archived_at IS NULL
                ORDER BY COALESCE(last_recalled_at, created_at) ASC NULLS FIRST
                LIMIT %s
            )
            UPDATE memories SET archived_at = now(), updated_at = now()
            WHERE id IN (SELECT id FROM lru)
            """,
            (member_id, *scope_params, excess),
        )
        archived = cur.rowcount
        await conn.commit()

    if archived:
        log.info(
            "memory cap enforced: archived %d rows (scope=%s project=%s)",
            archived, scope, project_id,
        )
    return archived


async def _process_one_job(session_id: UUID, member_id: UUID) -> None:
    """Run extraction for one job and enforce the per-scope cap."""
    scope_info = await _resolve_session_scope(session_id)
    if scope_info is None:
        # Session was deleted between enqueue and sweep — drop the job.
        await _mark_processed(session_id)
        return
    scope, project_id = scope_info
    try:
        await extract_from_session(
            session_id=session_id,
            member_id=member_id,
            scope=scope,
            project_id=project_id,
        )
    except Exception:
        log.warning(
            "memory sweeper: extract_from_session crashed for %s",
            session_id, exc_info=True,
        )

    # Even on extraction failure, mark the job processed so we don't
    # retry the same broken transcript every 2 min. The sweeper will
    # naturally pick the session up again when the user sends another
    # turn (last_message_at bumps past last_processed_message_at).
    await _mark_processed(session_id)

    try:
        await enforce_cap_for_scope(member_id, scope, project_id)
    except Exception:
        log.warning("memory sweeper: enforce_cap crashed", exc_info=True)


async def process_pending_extractions() -> int:
    """Run one pass of the extraction sweeper. Returns # jobs processed."""
    jobs = await _claim_pending_jobs(MAX_JOBS_PER_TICK)
    if not jobs:
        return 0
    log.info("memory sweeper: processing %d pending extraction jobs", len(jobs))
    for session_id, member_id in jobs:
        await _process_one_job(session_id, member_id)
    return len(jobs)


async def memory_sweep_loop(interval_seconds: int) -> None:
    """Periodic loop: process pending extraction jobs every ``interval``
    seconds. Same idempotent / failure-tolerant posture as
    ``sweeper.sweep_loop``."""
    if interval_seconds <= 0:
        return
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await process_pending_extractions()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("memory sweeper iteration failed; continuing")


async def enqueue_extraction_job(
    *, session_id: UUID, member_id: UUID
) -> None:
    """Upsert a job row, bumping last_message_at. Called from the chat
    handler on every turn. O(1) Postgres write, no LLM call. Never
    raises — failures are swallowed so the chat path stays clean."""
    try:
        async with get_conn() as conn:
            await conn.execute(
                """
                INSERT INTO memory_extraction_jobs
                    (session_id, member_id, last_message_at)
                VALUES (%s, %s, now())
                ON CONFLICT (session_id) DO UPDATE
                SET last_message_at = EXCLUDED.last_message_at
                """,
                (session_id, member_id),
            )
            await conn.commit()
    except Exception:
        log.warning("enqueue_extraction_job failed", exc_info=True)
