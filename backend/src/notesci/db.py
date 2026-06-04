from contextlib import asynccontextmanager
from typing import AsyncIterator

import psycopg
from pgvector.psycopg import register_vector_async
from psycopg_pool import AsyncConnectionPool

from .config import settings

_pool: AsyncConnectionPool | None = None


async def init_pool() -> AsyncConnectionPool:
    global _pool
    if _pool is None:
        # Keep desktop startup failures fast. The previous 30s default
        # made Windows event-loop/DB failures look like a multi-minute
        # frozen launch because readiness polling kept waiting after the
        # pool was already doomed.
        _pool = AsyncConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=10,
            open=False,
            timeout=5.0,
            reconnect_timeout=10.0,
        )
        await _pool.open()
        async with _pool.connection() as conn:
            # `IF NOT EXISTS` still isn't atomic — two workers booting
            # together can both pass the existence check, and one loses
            # with a duplicate-key error on pg_extension. If a sibling
            # worker won the race the extension exists anyway, so swallow
            # it rather than crash the worker on startup.
            try:
                await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            except psycopg.errors.UniqueViolation:
                await conn.rollback()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def get_conn() -> AsyncIterator[psycopg.AsyncConnection]:
    pool = await init_pool()
    async with pool.connection() as conn:
        await register_vector_async(conn)
        yield conn
