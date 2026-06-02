"""System-prompt injection for the core memory block.

The core block is the cheapest, highest-leverage memory we have: a
single editable markdown blob per scope, pinned into every system prompt
for that scope. No retrieval, no vector search — it's the "you've
already told me this" channel for facts the model should always have.

Returns ``None`` (so the caller can skip prepending a SystemMessage)
when the block doesn't exist or has been cleared to whitespace.
"""

from __future__ import annotations

from uuid import UUID

from .store import Scope, get_core


async def build_core_injection(
    *,
    member_id: UUID | str | None,
    scope: Scope,
    project_id: UUID | str | None,
) -> str | None:
    """Return the formatted system block for the scope's core memory.

    ``member_id`` may arrive as a string from FastAPI dependencies; cast
    to UUID at the boundary so ``store.py`` keeps its strict typing.
    Returns ``None`` for: missing member_id, no core row, empty body."""
    if member_id is None:
        return None
    mid = member_id if isinstance(member_id, UUID) else UUID(str(member_id))
    pid: UUID | None
    if project_id is None:
        pid = None
    else:
        pid = project_id if isinstance(project_id, UUID) else UUID(str(project_id))

    row = await get_core(member_id=mid, scope=scope, project_id=pid)
    if row is None:
        return None
    body = row.body.strip()
    if not body:
        return None

    header = (
        "Long-term context for this project"
        if scope == "project"
        else "Long-term context the user has saved"
    )
    return (
        f"{header} (treat as durable background you've already been told):\n\n"
        f"{body}"
    )
