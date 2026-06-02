"""Personal-access-token + session-management coverage.

The backend ships three sensitive surfaces that the dashboard surfaces
to the user:

  - ``POST/GET/DELETE /me/tokens`` — long-lived bearer credentials
    (``auth_tokens`` table). The raw token is returned **once** at
    mint and never again.
  - ``POST /auth/sessions/revoke-all`` — kill-switch that nukes every
    active ``auth_sessions`` row for the caller. Originally docs-only
    "Does NOT revoke PATs"; per CRITICAL #1 the backend agent is wiring
    PAT revocation into the same path so credential-compromise events
    have a single button to push.
  - ``POST /auth/reset-password`` — already revokes PATs in the same
    transaction (main.py:899-903). We pin that behaviour here so a
    future refactor doesn't silently regress it.

Audit-log assertions (``member.tokens.created`` /
``member.sessions.revoked_all``) and the quota / rate-limit caps land
in the backend agent's parallel work; tests for those are marked
``xfail`` with a strict=False so they auto-flip to passing the moment
the corresponding code ships.

Fixtures reuse the conftest ``client`` / ``workspace`` / ``member``
pattern — no fresh app per test.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from notesci.config import settings
from notesci.db import get_conn


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


async def _mint(
    client: AsyncClient, headers: dict, *, label: str = "test-token",
    expires_in_days: int | None = None,
) -> dict:
    """Mint a single PAT and return the create response body."""
    payload: dict = {"label": label}
    if expires_in_days is not None:
        payload["expires_in_days"] = expires_in_days
    r = await client.post("/me/tokens", headers=headers, json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _claim_member(client: AsyncClient) -> dict:
    """Bootstrap a brand-new workspace + member and return the auth bundle.

    Useful for cases that need two distinct members in one test
    (e.g. cross-member 404)."""
    admin = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin},
        json={"slug": slug, "name": f"WS {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    ws = r.json()
    code = ws["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    return {
        "email": email,
        "password": "x" * 12,
        "token": body["token"],
        "member_id": body["member"]["id"],
        "workspace_id": body["member"]["workspace_id"],
        "headers": {"Authorization": f"Bearer {body['token']}"},
    }


# ---------------------------------------------------------------------------
# 1. Mint / list / delete
# ---------------------------------------------------------------------------


async def test_pat_mint_returns_token_once(
    client: AsyncClient, auth_headers: dict
):
    """POST /me/tokens returns the raw token + label + prefix; GET hides it."""
    created = await _mint(client, auth_headers, label="my-cli")
    assert created["token"], "raw token must be in the create response"
    assert created["label"] == "my-cli"
    assert created["display_prefix"]
    # The raw token's first 8 chars match the display prefix.
    assert created["token"].startswith(created["display_prefix"]), (
        f"display_prefix={created['display_prefix']!r} "
        f"is not a prefix of token={created['token']!r}"
    )

    # Subsequent list call must NOT echo the raw token.
    r = await client.get("/me/tokens", headers=auth_headers)
    assert r.status_code == 200, r.text
    rows = r.json()
    matches = [t for t in rows if t["id"] == created["id"]]
    assert matches, "minted PAT must appear in list"
    row = matches[0]
    assert "token" not in row, (
        "list endpoint leaked the raw token field — only prefix is safe"
    )
    assert row["display_prefix"] == created["display_prefix"]
    assert row["label"] == "my-cli"


async def test_pat_authenticates_as_member(
    client: AsyncClient, auth_headers: dict, member: dict
):
    """Using the raw token in ``Authorization: Bearer`` authenticates as
    the same member that minted it."""
    created = await _mint(client, auth_headers, label="auth-check")

    # Use only the PAT — drop the session-token header.
    r = await client.get(
        "/me", headers={"Authorization": f"Bearer {created['token']}"}
    )
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["id"] == member["member"]["id"], (
        "PAT resolved to a different member than the one that minted it"
    )


async def test_pat_revoked_rejected(
    client: AsyncClient, auth_headers: dict
):
    """After DELETE /me/tokens/{id}, the raw token is no longer accepted."""
    created = await _mint(client, auth_headers, label="revoke-me")
    pat_headers = {"Authorization": f"Bearer {created['token']}"}

    # Sanity: works before revocation.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 200, r.text

    r = await client.delete(
        f"/me/tokens/{created['id']}", headers=auth_headers
    )
    assert r.status_code == 204, r.text

    # The same raw token must now 401.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 401, r.text


async def test_pat_expires_at_honored(
    client: AsyncClient, auth_headers: dict
):
    """Mint with expires_in_days=1, then backdate expires_at via direct
    SQL — the token must be rejected as expired (401)."""
    created = await _mint(
        client, auth_headers, label="short-lived", expires_in_days=1
    )
    pat_headers = {"Authorization": f"Bearer {created['token']}"}

    # Sanity: still valid right after mint.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 200, r.text

    # Backdate expires_at to one hour ago.
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE auth_tokens SET expires_at=%s WHERE id=%s",
            (past, uuid.UUID(created["id"])),
        )
        await conn.commit()

    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 401, (
        f"expired PAT should be rejected with 401, got {r.status_code}: {r.text}"
    )


async def test_pat_cross_member_404(client: AsyncClient):
    """Member A cannot DELETE member B's token id — must 404 (not 403)
    with a generic ``*_not_found`` code so we don't leak existence."""
    a = await _claim_member(client)
    b = await _claim_member(client)
    b_token = await _mint(client, b["headers"], label="b-only")

    r = await client.delete(
        f"/me/tokens/{b_token['id']}", headers=a["headers"]
    )
    assert r.status_code == 404, r.text
    detail = r.json().get("detail", {})
    code = detail.get("code") if isinstance(detail, dict) else None
    assert code in ("token_not_found", "pat_not_found"), (
        f"unexpected typed error code: {detail!r}"
    )


# ---------------------------------------------------------------------------
# 2. Quota + rate limit — owned by the backend agent's #L? fix.
# ---------------------------------------------------------------------------


async def test_pat_quota_exceeded(client: AsyncClient, auth_headers: dict):
    """Minting more than 20 active PATs returns 400 ``pat_quota_exceeded``.

    Bounds the blast radius of a compromised account (see main.py
    around the create_personal_token handler — the 20-count cap is
    enforced before the INSERT).
    """
    # Need the rate limit off (which it is by default in tests) — the
    # mint loop fires 21 POSTs through the per-member throttle which
    # we exercise separately in ``test_pat_create_rate_limited``.
    for i in range(20):
        r = await client.post(
            "/me/tokens", headers=auth_headers, json={"label": f"quota-{i}"}
        )
        assert r.status_code in (200, 201), (i, r.status_code, r.text)
    # 21st must be refused.
    r = await client.post(
        "/me/tokens", headers=auth_headers, json={"label": "quota-21"}
    )
    assert r.status_code == 400, r.text
    detail = r.json().get("detail", {})
    code = detail.get("code") if isinstance(detail, dict) else None
    assert code == "pat_quota_exceeded", detail


async def test_pat_create_rate_limited(
    client: AsyncClient, auth_headers: dict, monkeypatch
):
    """5 mints in quick succession are fine; the 6th returns 429.

    The backend's per-member throttle is normally bypassed in the test
    suite (``NOTESCI_DISABLE_RATE_LIMITS=true`` in conftest); we flip
    that off just for this test via monkeypatch.
    """
    monkeypatch.setattr(
        settings, "notesci_disable_rate_limits", False, raising=False
    )
    for i in range(5):
        r = await client.post(
            "/me/tokens", headers=auth_headers, json={"label": f"rl-{i}"}
        )
        assert r.status_code in (200, 201), (i, r.text)
    r = await client.post(
        "/me/tokens", headers=auth_headers, json={"label": "rl-6"}
    )
    assert r.status_code == 429, r.text


# ---------------------------------------------------------------------------
# 3. Audit log — wired by the backend agent in the parallel sprint.
# ---------------------------------------------------------------------------


async def test_pat_create_writes_audit_event(
    client: AsyncClient, member: dict, auth_headers: dict
):
    """After minting a PAT, audit_log has a row with action
    ``member.tokens.created`` and target_id = the token id.
    The raw token MUST NOT appear in the metadata.

    ``GET /audit`` is admin-gated, so we promote the member first via
    a direct UPDATE (mirroring the helper in test_workspace_boundaries.py).
    """
    created = await _mint(client, auth_headers, label="audited")

    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role='admin' WHERE id=%s",
            (uuid.UUID(member["member"]["id"]),),
        )
        await conn.commit()

    r = await client.get(
        "/audit?action=member.tokens.created&limit=50", headers=auth_headers
    )
    assert r.status_code == 200, r.text
    events = r.json()
    matches = [e for e in events if e.get("target_id") == created["id"]]
    assert matches, (
        f"no member.tokens.created row for token {created['id']!r} "
        f"in {events!r}"
    )
    # The token string must not appear anywhere in the metadata.
    for ev in matches:
        meta_str = repr(ev.get("metadata", {}))
        assert created["token"] not in meta_str, (
            "audit metadata leaked the raw PAT — must store id/prefix only"
        )


# ---------------------------------------------------------------------------
# 4. /auth/sessions/revoke-all
# ---------------------------------------------------------------------------


async def test_sessions_revoke_all_kills_caller_session(client: AsyncClient):
    """POST /auth/sessions/revoke-all nukes every web session, including
    the calling tab's. The same bearer must 401 on the next request."""
    a = await _claim_member(client)

    # Sanity: session works before.
    r = await client.get("/me", headers=a["headers"])
    assert r.status_code == 200, r.text

    r = await client.post(
        "/auth/sessions/revoke-all", headers=a["headers"]
    )
    assert r.status_code == 204, r.text

    r = await client.get("/me", headers=a["headers"])
    assert r.status_code == 401, (
        f"session token must be rejected after revoke-all, "
        f"got {r.status_code}: {r.text}"
    )


@pytest.mark.xfail(
    reason="Backend agent is wiring revoke-all to also revoke PATs "
    "(CRITICAL #1). Current docstring says 'Does NOT revoke PATs'.",
    strict=False,
)
async def test_sessions_revoke_all_kills_pats(client: AsyncClient):
    """revoke-all should also revoke active PATs — credential-compromise
    needs a single switch."""
    a = await _claim_member(client)
    pat = await _mint(client, a["headers"], label="kill-me")
    pat_headers = {"Authorization": f"Bearer {pat['token']}"}

    # Sanity: PAT works.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 200, r.text

    r = await client.post(
        "/auth/sessions/revoke-all", headers=a["headers"]
    )
    assert r.status_code == 204, r.text

    # PAT should now be rejected.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 401, (
        f"PAT should be revoked alongside sessions, "
        f"got {r.status_code}: {r.text}"
    )


async def test_sessions_revoke_all_writes_audit(client: AsyncClient):
    """revoke-all writes one ``member.sessions.revoked_all`` audit row.

    ``GET /audit`` is admin-gated; we promote the member first. After
    revoke-all the session token is dead, but PATs survive (today),
    so the PAT is the natural read channel. If a future change kills
    PATs too, fall back to a fresh sign-in.
    """
    a = await _claim_member(client)
    # Promote so we can read /audit afterwards.
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role='admin' WHERE id=%s",
            (uuid.UUID(a["member_id"]),),
        )
        await conn.commit()
    pat = await _mint(client, a["headers"], label="audit-reader")

    r = await client.post(
        "/auth/sessions/revoke-all", headers=a["headers"]
    )
    assert r.status_code == 204, r.text

    reader_headers = {"Authorization": f"Bearer {pat['token']}"}
    r = await client.get(
        "/audit?action=member.sessions.revoked_all&limit=20",
        headers=reader_headers,
    )
    if r.status_code == 401:
        signin = await client.post(
            "/auth/signin",
            json={"email": a["email"], "password": a["password"]},
        )
        assert signin.status_code == 200, signin.text
        reader_headers = {
            "Authorization": f"Bearer {signin.json()['token']}"
        }
        r = await client.get(
            "/audit?action=member.sessions.revoked_all&limit=20",
            headers=reader_headers,
        )
    assert r.status_code == 200, r.text
    events = r.json()
    matches = [
        e for e in events
        if e["action"] == "member.sessions.revoked_all"
        and e.get("actor_member_id") == a["member_id"]
    ]
    assert matches, (
        f"no member.sessions.revoked_all row for member {a['member_id']!r} "
        f"in {events!r}"
    )


# ---------------------------------------------------------------------------
# 5. Password reset → PAT revocation
# ---------------------------------------------------------------------------


async def test_password_reset_revokes_pats(client: AsyncClient):
    """Completing a password reset must invalidate every active PAT for
    that member. (Pinned in main.py:899-903; this test guards regression.)"""
    a = await _claim_member(client)
    pat = await _mint(client, a["headers"], label="pre-reset")
    pat_headers = {"Authorization": f"Bearer {pat['token']}"}

    # Sanity: works.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 200, r.text

    # Mint a reset token directly via the helper used by /auth/forgot-password —
    # avoids the rate limit + email indirection.
    from notesci.auth import mint_password_reset_token
    async with get_conn() as conn:
        raw_reset = await mint_password_reset_token(
            conn, uuid.UUID(a["member_id"])
        )
        await conn.commit()

    new_password = "y" * 14
    r = await client.post(
        "/auth/reset-password",
        json={"token": raw_reset, "password": new_password},
    )
    assert r.status_code == 204, r.text

    # The PAT must now 401.
    r = await client.get("/me", headers=pat_headers)
    assert r.status_code == 401, (
        f"PAT should be revoked after password reset, "
        f"got {r.status_code}: {r.text}"
    )
