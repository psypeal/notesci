"""Long-term memory for general + project chats.

Public API:
    save_memory   — insert one approved memory row (explicit or extracted).
    update_memory — edit one non-core memory row.
    list_memories — list (non-archived) rows scoped to member + general/project.
    archive       — soft-delete a memory.
    get_core      — fetch the singleton core block for a scope (None if empty).
    upsert_core   — create or update the singleton core block.

Three modules underpin this package:
    store     — CRUD against the memories table.
    prompt    — system-prompt injection (added in slice 2).
    retriever — hybrid recall (added in slice 3).
    extractor — background ADD-only extraction (added in slice 4).
"""

from .prompt import build_core_injection
from .retriever import RecalledMemory, format_recall_block, recall
from .store import (
    MemoryRow,
    archive_memory,
    get_core,
    list_memories,
    save_memory,
    update_memory,
    upsert_core,
)

__all__ = [
    "MemoryRow",
    "RecalledMemory",
    "archive_memory",
    "build_core_injection",
    "format_recall_block",
    "get_core",
    "list_memories",
    "recall",
    "save_memory",
    "update_memory",
    "upsert_core",
]
