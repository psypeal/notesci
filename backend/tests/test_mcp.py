"""MCP host — catalog, install, and credential redaction.

Covers three slices the dashboard depends on:

  1. ``GET /mcp/catalog`` returns the curated marketplace entries —
     the dashboard's centerpiece is the catalog strip.
  2. Role gating — only owners/admins can ``POST /mcp/servers`` or
     ``PATCH``/``DELETE``. Members get 403 ``forbidden``.
  3. The redaction pass — secret-named keys in ``config.headers`` and
     the entire ``config.env`` map are replaced with ``"***"`` before
     the row leaves the API. This prevents the dashboard from leaking
     credentials back to a curious user.

The stdio-transport-restriction the prompt mentioned is **not yet
enforced** by the backend agent — every transport in the
``Literal["http", "stdio", "sse"]`` is currently accepted from an
admin. Marked with ``xfail`` so it goes green automatically when the
restriction lands.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app


@pytest.fixture
async def mcp_client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def _bootstrap_member(mcp_client: AsyncClient, *, admin: bool) -> dict:
    """Create a workspace + member; optionally promote to admin role."""
    admin_token = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await mcp_client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin_token},
        json={"slug": slug, "name": f"MCP {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    code = r.json()["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await mcp_client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    member_id = body["member"]["id"]

    # The first claimer of a fresh workspace is auto-promoted to admin
    # (see /auth/claim). Force the role explicitly here so this helper
    # is deterministic regardless of claim order.
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role = %s WHERE id = %s",
            ("admin" if admin else "member", uuid.UUID(member_id)),
        )
        await conn.commit()

    return {
        "headers": {"Authorization": f"Bearer {body['token']}"},
        "member_id": member_id,
    }


# ---------------------------------------------------------------------------
# 1. Catalog
# ---------------------------------------------------------------------------


async def test_catalog_returns_curated_entries(mcp_client: AsyncClient):
    member = await _bootstrap_member(mcp_client, admin=False)
    r = await mcp_client.get("/mcp/catalog", headers=member["headers"])
    assert r.status_code == 200, r.text
    entries = r.json()
    # Catalog is server-curated and currently has ~14 entries
    # (see CLAUDE.md > "MCP host with curated catalog"). Don't pin the
    # exact count — pin the shape and that we got some.
    assert isinstance(entries, list)
    assert entries, "catalog should not be empty"
    sample = entries[0]
    for key in (
        "id", "name", "category", "author", "description",
        "transport", "config", "default_grants",
    ):
        assert key in sample, f"catalog entry missing {key!r}: {sample}"


async def test_catalog_requires_auth(mcp_client: AsyncClient):
    r = await mcp_client.get("/mcp/catalog")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# 2. Role gating
# ---------------------------------------------------------------------------


async def test_member_role_cannot_install_mcp_server(
    mcp_client: AsyncClient,
):
    """A claimed (role='member') user gets 403 on POST /mcp/servers."""
    member = await _bootstrap_member(mcp_client, admin=False)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": "blocked",
            "name": "Blocked",
            "transport": "http",
            "config": {"url": "https://example.test"},
            "grants": {},
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "forbidden"


async def test_admin_role_can_install_mcp_server(mcp_client: AsyncClient):
    """A promoted (role='admin') user can install an MCP server."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"srv-{uuid.uuid4().hex[:6]}",
            "name": "Admin-installed",
            "transport": "http",
            "config": {"url": "https://example.test"},
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["transport"] == "http"


async def test_admin_cannot_install_stdio_via_raw_endpoint(
    mcp_client: AsyncClient,
):
    """stdio MCP servers shell out a command, which is an RCE surface
    on the backend host. Raw stdio installs through POST /mcp/servers
    are refused; admins must go through the curated catalog install."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"stdio-{uuid.uuid4().hex[:6]}",
            "name": "stdio mcp",
            "transport": "stdio",
            "config": {"command": "/bin/echo", "args": ["pwned"]},
            "grants": {},
        },
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "stdio_not_allowed"


# ---------------------------------------------------------------------------
# 3. Credential redaction
# ---------------------------------------------------------------------------


async def test_mcp_server_response_redacts_secret_headers(
    mcp_client: AsyncClient,
):
    """The Authorization header value should be ``"***"`` on the API
    response, regardless of what the admin sent in."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"hdr-{uuid.uuid4().hex[:6]}",
            "name": "Headers test",
            "transport": "http",
            "config": {
                "url": "https://example.test",
                "headers": {
                    "Authorization": "Bearer real-secret-token",
                    "X-Api-Key": "real-api-key",
                    "User-Agent": "notesci",  # not secret — must survive
                },
            },
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    headers_out = r.json()["config"]["headers"]
    assert headers_out["Authorization"] == "***"
    assert headers_out["X-Api-Key"] == "***"
    # Non-secret header passes through unchanged.
    assert headers_out["User-Agent"] == "notesci"


async def test_mcp_server_list_redacts_secret_env(mcp_client: AsyncClient):
    """For stdio servers (env-based credentials), the entire env map is
    redacted in the API response — every value becomes ``"***"``.

    Raw stdio installs are refused at the API layer (see the
    ``stdio_not_allowed`` test); the curated catalog is the only way
    in. We install ``firecrawl`` (a stdio entry with a
    ``FIRECRAWL_API_KEY`` env slot) and confirm the env values come
    back redacted."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/catalog/firecrawl/install",
        headers=member["headers"],
        json={},
    )
    assert r.status_code == 201, r.text
    env_out = r.json()["config"]["env"]
    # Catalog entry seeds ``FIRECRAWL_API_KEY: ""``; the redactor still
    # rewrites to ``"***"`` because *every* env value is treated as
    # secret.
    assert env_out == {"FIRECRAWL_API_KEY": "***"}


# ---------------------------------------------------------------------------
# 4. List / get also redact (defence in depth)
# ---------------------------------------------------------------------------


async def test_mcp_get_and_list_apply_redaction(mcp_client: AsyncClient):
    """The redactor must run on read paths too, not just on the
    install response — otherwise a refresh of the dashboard would leak."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"both-{uuid.uuid4().hex[:6]}",
            "name": "Both",
            "transport": "http",
            "config": {
                "url": "https://example.test",
                "headers": {"Authorization": "Bearer x"},
            },
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    sid = r.json()["id"]

    r = await mcp_client.get(
        f"/mcp/servers/{sid}", headers=member["headers"]
    )
    assert r.status_code == 200
    assert r.json()["config"]["headers"]["Authorization"] == "***"

    r = await mcp_client.get("/mcp/servers", headers=member["headers"])
    assert r.status_code == 200
    matched = [s for s in r.json() if s["id"] == sid]
    assert matched, "newly-installed server should be in the list"
    assert matched[0]["config"]["headers"]["Authorization"] == "***"
