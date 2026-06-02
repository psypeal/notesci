"""Embedding helper for long-term memory rows.

Memory should still work when no embedding provider is configured. The
retriever falls back to BM25 + recency, so write paths treat embeddings
as an optional acceleration rather than a hard dependency.
"""

from __future__ import annotations

import logging

from ..agent.embeddings import embedding_provider_available, make_embedding_model

log = logging.getLogger(__name__)


async def embed_memory_text(title: str, body: str) -> list[float] | None:
    """Return an embedding for a memory row, or None on any provider failure."""
    if not embedding_provider_available():
        return None
    try:
        return await make_embedding_model().aembed_query(f"{title}\n{body}")
    except Exception:
        log.warning("memory embedding failed; storing row unembedded", exc_info=True)
        return None
