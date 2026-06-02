"""Workspace audit-log helpers.

``record_event`` writes a row to ``audit_log``. Callers pass a connection
when they want the event to share their transaction (e.g. claim flow);
otherwise they pass ``None`` and we open a fresh connection.

Events are intentionally non-blocking for the user-facing flow: errors
are logged but never raised. An audit-write failure must not break
sign-in.
"""
from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from .db import get_conn

log = logging.getLogger(__name__)


async def record_event(
    *,
    workspace_id: UUID,
    action: str,
    actor_member_id: UUID | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    conn: psycopg.AsyncConnection | None = None,
) -> None:
    """Insert one audit_log row. Best-effort; failures are logged."""
    sql = (
        "INSERT INTO audit_log "
        "(workspace_id, actor_member_id, action, target_type, target_id, metadata) "
        "VALUES (%s, %s, %s, %s, %s, %s)"
    )
    args = (
        workspace_id,
        actor_member_id,
        action,
        target_type,
        target_id,
        Jsonb(metadata or {}),
    )
    try:
        if conn is not None:
            await conn.execute(sql, args)
        else:
            async with get_conn() as own_conn:
                await own_conn.execute(sql, args)
                await own_conn.commit()
    except Exception:
        log.exception("audit record failed: action=%s target=%s", action, target_id)
