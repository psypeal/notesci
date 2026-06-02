"""Audit log coverage.

The audit log (``audit_log`` table, surfaced by ``GET /audit``) is
the dashboard's reproducibility surface — every state-changing user
action writes a row. The two invariants pinned here:

  1. After a recognised action (``POST /projects`` → ``project.create``)
     a matching audit row exists.
  2. The audit log is workspace-scoped — workspace A never sees
     workspace B's events (already covered by
     ``test_workspace_boundaries.py`` but mirrored here for the
     focused audit suite).
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app


@pytest.fixture
async def audit_client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def _bootstrap(audit_client: AsyncClient) -> dict:
    admin = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await audit_client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin},
        json={"slug": slug, "name": f"Audit {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    code = r.json()["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await audit_client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    member_id = body["member"]["id"]
    # ``GET /audit`` is admin-gated (backend agent landed this in May 2026).
    # Bump the freshly-claimed member to admin via direct UPDATE so the
    # audit-log tests below can read /audit. Same pattern as
    # test_workspace_boundaries.py::_promote_to_admin.
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role='admin' WHERE id=%s",
            (uuid.UUID(member_id),),
        )
        await conn.commit()
    return {
        "headers": {"Authorization": f"Bearer {body['token']}"},
        "member_id": member_id,
    }


# ---------------------------------------------------------------------------
# 1. Project creation lands in the audit log
# ---------------------------------------------------------------------------


async def test_project_create_writes_audit_row(audit_client: AsyncClient):
    bs = await _bootstrap(audit_client)
    r = await audit_client.post(
        "/projects",
        headers=bs["headers"],
        json={"name": "Auditable Project"},
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]

    r = await audit_client.get("/audit?limit=50", headers=bs["headers"])
    assert r.status_code == 200, r.text
    events = r.json()

    # The audit action is ``project.create`` (see main.py line ~892).
    # (NOTE: CLAUDE.md / the prompt sometimes references ``project.created``
    # in past tense; the actual emitted action is ``project.create``.
    # This test pins the actual emitted action so the dashboard contract
    # stays stable.)
    project_events = [
        e for e in events
        if e["action"] == "project.create"
        and e["target_type"] == "project"
        and e["target_id"] == project_id
    ]
    assert project_events, f"no project.create row found in {events!r}"


async def test_member_claim_writes_audit_row(audit_client: AsyncClient):
    """Claiming an invite writes a ``member.claim`` row — pin it so the
    onboarding telemetry doesn't silently regress."""
    bs = await _bootstrap(audit_client)
    r = await audit_client.get("/audit?limit=50", headers=bs["headers"])
    assert r.status_code == 200
    events = r.json()
    claim_events = [e for e in events if e["action"] == "member.claim"]
    assert claim_events, f"no member.claim row found in {events!r}"
    # actor_member_id matches the freshly-claimed member.
    assert claim_events[0]["actor_member_id"] == bs["member_id"]


# ---------------------------------------------------------------------------
# 2. Workspace isolation
# ---------------------------------------------------------------------------


async def test_audit_log_does_not_leak_across_workspaces(
    audit_client: AsyncClient,
):
    """Workspace A's /audit must NOT include any row from workspace B."""
    a = await _bootstrap(audit_client)
    b = await _bootstrap(audit_client)
    # Create distinct projects in each workspace.
    r = await audit_client.post(
        "/projects", headers=a["headers"], json={"name": "A-only project"}
    )
    a_project_id = r.json()["id"]
    r = await audit_client.post(
        "/projects", headers=b["headers"], json={"name": "B-only project"}
    )
    b_project_id = r.json()["id"]

    r = await audit_client.get("/audit?limit=200", headers=a["headers"])
    events_a = r.json()
    r = await audit_client.get("/audit?limit=200", headers=b["headers"])
    events_b = r.json()

    targets_a = {(e["action"], e["target_id"]) for e in events_a}
    targets_b = {(e["action"], e["target_id"]) for e in events_b}

    assert ("project.create", a_project_id) in targets_a
    assert ("project.create", b_project_id) in targets_b
    # A's view doesn't see B's project_id and vice versa.
    assert ("project.create", b_project_id) not in targets_a, (
        "workspace A's audit log leaked workspace B's project_id"
    )
    assert ("project.create", a_project_id) not in targets_b, (
        "workspace B's audit log leaked workspace A's project_id"
    )


# ---------------------------------------------------------------------------
# 3. Filter parameters
# ---------------------------------------------------------------------------


async def test_audit_filter_by_action(audit_client: AsyncClient):
    """The ?action= filter narrows the result set to matching rows."""
    bs = await _bootstrap(audit_client)
    await audit_client.post(
        "/projects", headers=bs["headers"], json={"name": "P1"}
    )
    await audit_client.post(
        "/projects", headers=bs["headers"], json={"name": "P2"}
    )

    r = await audit_client.get(
        "/audit?action=project.create&limit=50", headers=bs["headers"]
    )
    assert r.status_code == 200
    actions = {e["action"] for e in r.json()}
    assert actions == {"project.create"}, (
        f"action filter let through other actions: {actions}"
    )


async def test_audit_invalid_limit_400(audit_client: AsyncClient):
    bs = await _bootstrap(audit_client)
    r = await audit_client.get("/audit?limit=0", headers=bs["headers"])
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_limit"
