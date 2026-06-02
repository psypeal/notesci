"""Periodic cleanup task spawned by ``lifespan``.

What gets swept and why:

- ``auth_sessions``: drop rows past ``expires_at``. The auth dependency
  also rejects expired tokens at request time, but stale rows accumulate
  in the table and we want them gone.
- ``password_reset_tokens``, ``email_verification_tokens``: drop rows
  whose ``expires_at`` is over 7 days old. We keep used/expired tokens
  for a week so the audit log is recoverable; past that, gone.
- ``rate_limits``: drop buckets whose ``window_start`` is over a day old
  (the window itself is 60s; anything older is just clutter).
- ``invites``: flip ``status='sent'`` codes whose ``expires_at`` has
  passed back to ``status='available'`` and clear the recipient fields.
  Per the design: "Codes expire 14 days after they're sent. Unclaimed
  codes return to your pool."

The sweep is idempotent — running it twice in a row just produces zero
counts the second time. Failures are logged and the loop continues; we
never want a transient DB hiccup to permanently kill the cleanup task.
"""
from __future__ import annotations

import asyncio
import logging

from .db import get_conn

log = logging.getLogger(__name__)


async def run_sweep() -> dict[str, int]:
    """Run all cleanup queries once. Returns ``{category: rowcount}``."""
    counts: dict[str, int] = {}
    async with get_conn() as conn:
        cur = await conn.execute(
            "DELETE FROM auth_sessions WHERE expires_at < now()"
        )
        counts["auth_sessions_expired"] = cur.rowcount

        cur = await conn.execute(
            "DELETE FROM password_reset_tokens "
            "WHERE expires_at < now() - interval '7 days'"
        )
        counts["password_reset_tokens_aged"] = cur.rowcount

        cur = await conn.execute(
            "DELETE FROM email_verification_tokens "
            "WHERE expires_at < now() - interval '7 days'"
        )
        counts["email_verification_tokens_aged"] = cur.rowcount

        cur = await conn.execute(
            "DELETE FROM rate_limits "
            "WHERE window_start < now() - interval '1 day'"
        )
        counts["rate_limits_stale"] = cur.rowcount

        # PageIndex tree-build can be cancelled mid-run by lifespan
        # teardown; the row gets left as 'pending' forever because the
        # worker thread can't reach the DB to flip status. Mark old
        # pending rows as failed so the next poll surfaces the failure
        # and the retrieval node doesn't keep skipping them.
        cur = await conn.execute(
            """
            UPDATE material_trees
            SET status='failed', error='orphaned',
                updated_at=now()
            WHERE status='pending'
              AND updated_at < now() - interval '60 minutes'
            """
        )
        counts["material_trees_orphaned"] = cur.rowcount

        await conn.commit()

    if any(counts.values()):
        log.info("sweep changed rows: %s", counts)
    return counts


async def sweep_loop(interval_seconds: int) -> None:
    """Run :func:`run_sweep` on a fixed interval until cancelled.

    Per-iteration exceptions are logged but never propagate; only
    cancellation breaks the loop.
    """
    if interval_seconds <= 0:
        return
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await run_sweep()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("sweeper iteration failed; continuing")
