"""Auth flow — workspace bootstrap, claim, signin, /me, signout."""
from __future__ import annotations

import uuid

from httpx import AsyncClient


async def test_admin_bootstrap_requires_token(client: AsyncClient):
    """Without the X-Admin-Token header the admin endpoint refuses."""
    r = await client.post(
        "/admin/workspaces",
        json={"slug": "anyslug", "name": "x", "bootstrap_invites": 1},
    )
    assert r.status_code == 401


async def test_admin_bootstrap_creates_workspace(workspace: dict):
    """Fixture-bootstrapped workspace returns the expected shape."""
    assert workspace["slug"].startswith("t")
    assert len(workspace["bootstrap_invites"]) == 3
    for code in workspace["bootstrap_invites"]:
        assert code.startswith("NS-") and len(code) == 12


async def test_claim_invite_then_signin(client: AsyncClient, workspace: dict):
    """Claim an invite, then sign in with the same credentials."""
    code = workspace["bootstrap_invites"][1]  # use a different code than `member` fixture
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    pw = "test-password-12345"

    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": pw},
    )
    assert r.status_code in (200, 201), r.text
    claim_token = r.json()["token"]
    assert claim_token

    # Subsequent claims of the same code should fail.
    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": "other@test.local", "password": pw},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "code_claimed"

    # Sign in with the email + password.
    r = await client.post(
        "/auth/signin", json={"email": email, "password": pw}
    )
    assert r.status_code == 200, r.text
    assert r.json()["token"]

    # Wrong password gets the typed error.
    r = await client.post(
        "/auth/signin", json={"email": email, "password": "nope-nope-nope"}
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "invalid_credentials"


async def test_me_round_trip(client: AsyncClient, auth_headers: dict):
    r = await client.get("/me", headers=auth_headers)
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["email"]
    assert me["workspace_id"]
    assert me["role"] in ("owner", "admin", "member", "viewer")


async def test_unauth_endpoints_401(client: AsyncClient):
    r = await client.get("/me")
    assert r.status_code == 401
    r = await client.get("/projects")
    assert r.status_code == 401
