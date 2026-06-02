"""Shared fixtures for the notesci test suite.

The tests run against a live FastAPI ASGI instance (no network) using
httpx's ``ASGITransport``. They share the dev Postgres at
``DATABASE_URL`` — every test bootstraps its own workspace + invite +
member with random slugs/emails so concurrent runs don't collide. The
DB-backed sweeper is disabled (``NOTESCI_SWEEP_INTERVAL_SECONDS=0``) so
the test event loop doesn't carry a stray task.

A test admin token is forced via env so ``POST /admin/workspaces`` works
without depending on the operator's local ``.env``.
"""
from __future__ import annotations

import os
import secrets
import uuid

# Set env before importing the app — main.py reads settings at module-eval.
os.environ.setdefault("NOTESCI_ADMIN_TOKEN", "test-" + secrets.token_urlsafe(16))
os.environ.setdefault("NOTESCI_SWEEP_INTERVAL_SECONDS", "0")
os.environ.setdefault("NOTESCI_DISABLE_RATE_LIMITS", "true")
# Disable real email sends — log backend writes to stdout instead.
os.environ.setdefault("NOTESCI_EMAIL_BACKEND", "log")

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.main import app


@pytest.fixture
def admin_token() -> str:
    return settings.notesci_admin_token or ""


@pytest.fixture
async def client():
    """Async httpx client wired to the FastAPI ASGI app — no network."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


@pytest.fixture
async def workspace(client: AsyncClient, admin_token: str) -> dict:
    """Bootstrap a fresh workspace with N invite codes via the admin endpoint."""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin_token},
        json={"slug": slug, "name": "Test Workspace", "bootstrap_invites": 3},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture
async def member(client: AsyncClient, workspace: dict) -> dict:
    """Claim the first bootstrap invite into a fresh member; return token + id."""
    code = workspace["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture
def auth_headers(member: dict) -> dict:
    return {"Authorization": f"Bearer {member['token']}"}
