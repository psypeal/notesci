"""Health endpoint — verifies the FastAPI app boots and the DB is reachable."""
from __future__ import annotations

from httpx import AsyncClient


async def test_health(client: AsyncClient):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["db"] is True
