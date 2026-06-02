"""Hybrid memory retrieval — vector + BM25 + recency, fused via RRF.

Why three signals:
    * **vector** (pgvector cosine) — semantic similarity for paraphrased
      questions. Hits the existing HNSW index on memories.embedding.
    * **bm25** (Postgres ``tsvector`` ts_rank_cd) — keyword anchor for
      names, identifiers, citation keys that vectors miss.
    * **recency** — recently-written memories are usually more relevant
      than older ones (a researcher's current preferences override their
      old ones). A simple ordered list keyed by created_at.

Why Reciprocal Rank Fusion: it needs no calibration between heterogeneous
score scales (cosine distance vs ts_rank vs raw time), and is robust to
one signal collapsing (empty result set, no embedding configured, etc).

The retriever is best-effort:
    * If no embedding provider is configured, the vector arm is skipped
      and we silently fuse the remaining two arms.
    * If pgvector raises (missing extension, dimension mismatch), the
      caller still gets BM25 + recency hits.
    * If everything fails, we return ``[]`` — the chat path stays
      responsive at the cost of un-grounded answers.

Only retrieves *approved, non-core, non-archived* rows. Core is pinned
into the prompt directly (see ``prompt.build_core_injection``) so it
must not show up here too.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from uuid import UUID

from pgvector.psycopg import register_vector_async

from ..agent.embeddings import (
    embedding_provider_available,
    make_embedding_model,
)
from ..db import get_conn
from .store import Scope

log = logging.getLogger(__name__)

DEFAULT_TOP_K = 5
# Pull this many candidates from each arm before fusion. Has to be
# bigger than the final top-k so the fuser has overlap to work with.
_ARM_CANDIDATES = 20
# RRF damping. Smaller => sharper rank-1 bias; 60 is the value from the
# original RRF paper (Cormack et al., SIGIR'09).
_RRF_K = 60


@dataclass
class RecalledMemory:
    id: UUID
    scope: str
    project_id: UUID | None
    kind: str
    title: str
    body: str
    source_session: UUID | None
    score: float
    created_at_iso: str


def _rrf_fuse(rankings: list[list[UUID]], k: int = _RRF_K) -> dict[UUID, float]:
    scored: dict[UUID, float] = {}
    for ranking in rankings:
        for rank, mid in enumerate(ranking):
            scored[mid] = scored.get(mid, 0.0) + 1.0 / (k + rank + 1)
    return scored


async def _scope_clause(
    scope: Scope, project_id: UUID | None
) -> tuple[str, tuple]:
    if scope == "project":
        return ("scope = 'project' AND project_id = %s", (project_id,))
    return ("scope = 'general' AND project_id IS NULL", ())


async def _vector_arm(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    query: str,
) -> list[UUID]:
    if not embedding_provider_available():
        return []
    try:
        embedder = make_embedding_model()
        qvec = await embedder.aembed_query(query)
    except Exception as exc:
        log.warning("memory vector arm: embedding failed: %s", exc)
        return []
    scope_sql, scope_params = await _scope_clause(scope, project_id)
    try:
        async with get_conn() as conn:
            await register_vector_async(conn)
            cur = await conn.execute(
                f"""
                SELECT id, embedding <=> %s::vector AS dist
                FROM memories
                WHERE member_id = %s AND archived_at IS NULL
                  AND kind <> 'core' AND embedding IS NOT NULL
                  AND {scope_sql}
                ORDER BY dist
                LIMIT %s
                """,
                (qvec, member_id, *scope_params, _ARM_CANDIDATES),
            )
            rows = await cur.fetchall()
    except Exception:
        log.warning("memory vector arm: query failed", exc_info=True)
        return []
    out: list[UUID] = []
    for r in rows:
        d = r[1]
        if d is None:
            continue
        f = float(d)
        if math.isnan(f) or math.isinf(f):
            continue
        out.append(r[0])
    return out


async def _bm25_arm(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    query: str,
) -> list[UUID]:
    scope_sql, scope_params = await _scope_clause(scope, project_id)
    # plainto_tsquery handles raw user text safely; phraseto_tsquery would
    # over-constrain ("hnsw recall" → "hnsw <-> recall" which misses
    # paraphrases that vector already catches anyway).
    try:
        async with get_conn() as conn:
            cur = await conn.execute(
                f"""
                SELECT id
                FROM memories
                WHERE member_id = %s AND archived_at IS NULL
                  AND kind <> 'core'
                  AND {scope_sql}
                  AND tsv @@ plainto_tsquery('english', %s)
                ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', %s)) DESC
                LIMIT %s
                """,
                (member_id, *scope_params, query, query, _ARM_CANDIDATES),
            )
            rows = await cur.fetchall()
    except Exception:
        log.warning("memory bm25 arm: query failed", exc_info=True)
        return []
    return [r[0] for r in rows]


async def _recency_arm(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
) -> list[UUID]:
    scope_sql, scope_params = await _scope_clause(scope, project_id)
    try:
        async with get_conn() as conn:
            cur = await conn.execute(
                f"""
                SELECT id FROM memories
                WHERE member_id = %s AND archived_at IS NULL
                  AND kind <> 'core'
                  AND {scope_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (member_id, *scope_params, _ARM_CANDIDATES),
            )
            rows = await cur.fetchall()
    except Exception:
        log.warning("memory recency arm: query failed", exc_info=True)
        return []
    return [r[0] for r in rows]


async def _hydrate(ids: list[UUID]) -> dict[UUID, tuple]:
    if not ids:
        return {}
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id, scope, project_id, kind, title, body, source_session, created_at "
            "FROM memories "
            "WHERE id = ANY(%s::uuid[])",
            (ids,),
        )
        rows = await cur.fetchall()
    return {r[0]: r for r in rows}


async def _bump_last_recalled(ids: list[UUID]) -> None:
    """Mark these rows as recently used so the LRU archive spares them.

    Best-effort: a failure here just means the LRU has slightly worse
    signal for one tick. Chat path must not break."""
    if not ids:
        return
    try:
        async with get_conn() as conn:
            await conn.execute(
                "UPDATE memories SET last_recalled_at = now() "
                "WHERE id = ANY(%s::uuid[])",
                (ids,),
            )
            await conn.commit()
    except Exception:
        log.warning("memory recall: last_recalled_at bump failed",
                    exc_info=True)


async def recall(
    *,
    member_id: UUID,
    scope: Scope,
    project_id: UUID | None,
    query: str,
    top_k: int = DEFAULT_TOP_K,
) -> list[RecalledMemory]:
    """Hybrid recall. Returns an empty list on any total failure rather
    than raising — the chat path is the caller and must not break.

    Side-effect: bumps ``last_recalled_at`` on every returned row, so
    the LRU-archive sweeper preserves rows that actually pay rent."""
    if not query.strip():
        return []
    vec_ids = await _vector_arm(
        member_id=member_id, scope=scope, project_id=project_id, query=query
    )
    bm_ids = await _bm25_arm(
        member_id=member_id, scope=scope, project_id=project_id, query=query
    )
    rec_ids = await _recency_arm(
        member_id=member_id, scope=scope, project_id=project_id
    )

    fused = _rrf_fuse([vec_ids, bm_ids, rec_ids])
    if not fused:
        return []

    ranked = sorted(fused.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    hydrated = await _hydrate([mid for mid, _ in ranked])

    out: list[RecalledMemory] = []
    for mid, score in ranked:
        row = hydrated.get(mid)
        if not row:
            continue
        out.append(
            RecalledMemory(
                id=row[0],
                scope=row[1],
                project_id=row[2],
                kind=row[3],
                title=row[4],
                body=row[5],
                source_session=row[6],
                score=score,
                created_at_iso=row[7].isoformat() if row[7] else "",
            )
        )
    await _bump_last_recalled([m.id for m in out])
    return out


def format_recall_block(memories: list[RecalledMemory]) -> str:
    """Render recalled memories as a system-message block.

    The phrasing is intentionally hedged ("the user previously told you")
    so a stale memory the user has changed their mind about doesn't get
    laundered into the model as a present-tense claim."""
    if not memories:
        return ""
    lines = ["The user previously told you:"]
    for m in memories:
        scope = "project" if m.scope == "project" else "general"
        prefix = f"{scope} {m.kind.replace('_', ' ')}"
        lines.append(f"  [{prefix}] {m.title}: {m.body}")
    return "\n".join(lines)
