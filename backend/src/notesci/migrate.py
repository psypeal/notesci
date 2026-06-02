"""Tiny SQL migrator.

Reads ``backend/db/migrations/*.sql`` in lexical order and applies any not
yet recorded in ``schema_migrations``. Idempotent — re-running is a no-op.

The whole pass runs in a single transaction guarded by a transaction-
scoped advisory lock. Multiple uvicorn workers boot together; without the
lock they race on ``CREATE EXTENSION`` and the ``schema_migrations``
INSERT (one worker dies with a duplicate-key error). With it, the losing
worker blocks until the winner's transaction commits, then sees nothing
pending. The lock auto-releases when the transaction ends, so there's no
session-level lock to leak back into the pool.

Domain schema only. The LangGraph checkpointer manages its own tables via
``AsyncPostgresSaver.setup()`` and is not driven by this migrator.
"""
from __future__ import annotations

from pathlib import Path

import psycopg

# backend/db/migrations relative to this file (backend/src/notesci/migrate.py)
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"

# Stable arbitrary bigint key for the migration advisory lock — only has
# to be unique to this concern within the app.
_MIGRATION_LOCK_KEY = 0x4E4F5445_5343494D

_TRACKER_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


async def apply_migrations(conn: psycopg.AsyncConnection) -> list[str]:
    """Apply pending migrations on ``conn``. Returns versions newly applied.

    Runs as one transaction: the caller's connection context commits it
    on clean exit (and rolls back on error — making the pass atomic).
    ``pg_advisory_xact_lock`` serializes concurrent workers and is
    released automatically when that transaction ends.
    """
    # Blocks until acquired. A worker that loses the race waits here,
    # then re-reads schema_migrations below and finds ``pending`` empty.
    await conn.execute(
        "SELECT pg_advisory_xact_lock(%s)", (_MIGRATION_LOCK_KEY,)
    )
    await conn.execute(_TRACKER_DDL)

    cur = await conn.execute("SELECT version FROM schema_migrations")
    applied = {row[0] for row in await cur.fetchall()}

    pending = sorted(
        f for f in (MIGRATIONS_DIR.glob("*.sql") if MIGRATIONS_DIR.exists() else [])
        if f.stem not in applied
    )

    newly_applied: list[str] = []
    for f in pending:
        version = f.stem
        sql = f.read_text()
        await conn.execute(sql)
        await conn.execute(
            "INSERT INTO schema_migrations (version) VALUES (%s)", (version,)
        )
        newly_applied.append(version)

    return newly_applied
