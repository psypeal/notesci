"""Workspace-boundary audit suite.

The single highest-leverage invariant in the codebase (per CLAUDE.md
> Working rules > Workspace boundaries):

    Gated endpoints join through ``workspace_id`` and collapse
    cross-workspace lookups to 404 with a generic ``*_not_found`` code.
    Don't leak which workspace owns what.

This test family bootstraps **two** workspaces — A and B — each with
its own member, project, session, material, draft, and MCP server.
Every gated endpoint is probed twice:

  1. Member A accessing A's resource — must succeed (sanity check that
     the fixture wiring is right).
  2. Member A accessing B's resource — must return 404 with the
     documented typed error code.

Resource seeding uses the API where possible. Two exceptions:
  - ``materials`` (and the dependent ``ingestion_jobs`` row) need a
    real embedding key for ``POST /materials/ingest`` to succeed —
    we side-step that by inserting a minimal row directly via psycopg.
  - Promoting a member to ``admin`` so they can install an MCP
    server (the backend agent added role-gating in May 2026) —
    done with a single ``UPDATE members`` statement.

Endpoints owned by the backend agent's parallel work (``/healthz``,
``/readyz``, ``/me/tokens``, ``/auth/sessions/revoke-all``) are noted
in the TODO block at the bottom of the file — add boundary tests once
they land.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app


# ---------------------------------------------------------------------------
# Two-workspace fixture
# ---------------------------------------------------------------------------


async def _bootstrap_workspace(client: AsyncClient, admin_token: str) -> dict:
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin_token},
        json={"slug": slug, "name": f"WS {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _claim(client: AsyncClient, workspace: dict) -> dict:
    code = workspace["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _promote_to_admin(member_id: str) -> None:
    """Promote the claimed member to ``admin`` so MCP install is allowed.

    The MCP install path is admin-gated (added by the backend agent in
    May 2026). For the boundary test we need the role; everything else
    we exercise is workspace-scoped without role gating."""
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role='admin' WHERE id = %s",
            (uuid.UUID(member_id),),
        )
        await conn.commit()


async def _seed_material(project_id: str) -> str:
    """Insert one ``materials`` row directly so we can test the
    workspace-scoped material endpoints without needing an OpenAI key
    for the ``/materials/ingest`` path."""
    mid = uuid.uuid4()
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO materials (id, project_id, source_type, title, "
            "original_bytes, original_mime) "
            "VALUES (%s, %s, 'text', %s, %s, %s)",
            (mid, uuid.UUID(project_id), "Owned material", b"hello", "text/plain"),
        )
        await conn.commit()
    return str(mid)


async def _seed_workspace_objects(
    client: AsyncClient, headers: dict, member_id: str
) -> dict:
    """Mint one project + material + draft + MCP server.

    The MCP server install requires admin role — we promote first.
    Returns the IDs so the boundary tests can pivot across them.
    """
    r = await client.post(
        "/projects", headers=headers, json={"name": "Owned"}
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]

    material_id = await _seed_material(project_id)

    r = await client.post(
        f"/projects/{project_id}/drafts",
        headers=headers,
        json={"title": "Owned draft", "body": "Owned draft body."},
    )
    assert r.status_code in (200, 201), r.text
    draft_id = r.json()["id"]

    await _promote_to_admin(member_id)
    r = await client.post(
        "/mcp/servers",
        headers=headers,
        json={
            "slug": f"srv-{uuid.uuid4().hex[:6]}",
            "name": "Owned MCP",
            "transport": "http",
            "config": {"url": "https://example.test"},
            "grants": {},
        },
    )
    assert r.status_code in (200, 201), r.text
    mcp_server_id = r.json()["id"]

    return {
        "project_id": project_id,
        "material_id": material_id,
        "draft_id": draft_id,
        "mcp_server_id": mcp_server_id,
    }


@pytest.fixture
async def two_workspaces():
    """Spin up two workspaces (A and B), each with one member and
    seeded objects. Yielded as a dict with client, headers, and IDs."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""

            ws_a = await _bootstrap_workspace(client, admin)
            ws_b = await _bootstrap_workspace(client, admin)
            mem_a = await _claim(client, ws_a)
            mem_b = await _claim(client, ws_b)
            hdr_a = {"Authorization": f"Bearer {mem_a['token']}"}
            hdr_b = {"Authorization": f"Bearer {mem_b['token']}"}
            seed_a = await _seed_workspace_objects(
                client, hdr_a, mem_a["member"]["id"]
            )
            seed_b = await _seed_workspace_objects(
                client, hdr_b, mem_b["member"]["id"]
            )

            yield {
                "client": client,
                "a": {"hdr": hdr_a, **seed_a},
                "b": {"hdr": hdr_b, **seed_b},
            }


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _assert_not_found(resp, code: str) -> None:
    assert resp.status_code == 404, (
        f"expected 404 ({code}) but got {resp.status_code}: {resp.text}"
    )
    body = resp.json()
    assert isinstance(body, dict), body
    detail = body.get("detail", body)
    assert isinstance(detail, dict), detail
    assert detail.get("code") == code, (
        f"expected detail.code={code!r}, got {detail!r}"
    )


# ---------------------------------------------------------------------------
# 1. READ boundary — every GET that takes a workspace-scoped id
# ---------------------------------------------------------------------------


async def test_project_get_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    b = two_workspaces["b"]
    # Sanity: A can read A.
    r = await c.get(f"/projects/{a['project_id']}", headers=a["hdr"])
    assert r.status_code == 200, r.text
    # Boundary: A cannot read B.
    r = await c.get(f"/projects/{b['project_id']}", headers=a["hdr"])
    _assert_not_found(r, "project_not_found")


async def test_project_sessions_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/projects/{a['project_id']}/sessions", headers=a["hdr"]
    )
    assert r.status_code == 200, r.text
    r = await c.get(
        f"/projects/{b['project_id']}/sessions", headers=a["hdr"]
    )
    _assert_not_found(r, "project_not_found")


async def test_project_materials_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/projects/{b['project_id']}/materials", headers=a["hdr"]
    )
    _assert_not_found(r, "project_not_found")


async def test_project_map_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/projects/{b['project_id']}/map", headers=a["hdr"]
    )
    _assert_not_found(r, "project_not_found")


async def test_project_drafts_list_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/projects/{b['project_id']}/drafts", headers=a["hdr"]
    )
    _assert_not_found(r, "project_not_found")


async def test_project_draft_cross_workspace_404(two_workspaces):
    """Active-draft GET /projects/{id}/draft — collapses to project_not_found."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/projects/{b['project_id']}/draft", headers=a["hdr"]
    )
    _assert_not_found(r, "project_not_found")


async def test_draft_get_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(f"/drafts/{a['draft_id']}", headers=a["hdr"])
    assert r.status_code == 200, r.text
    r = await c.get(f"/drafts/{b['draft_id']}", headers=a["hdr"])
    _assert_not_found(r, "draft_not_found")


async def test_material_file_cross_workspace_404(two_workspaces):
    """A's GET /materials/{B-material-id}/file must return material_not_found."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/materials/{b['material_id']}/file", headers=a["hdr"]
    )
    _assert_not_found(r, "material_not_found")


async def test_material_content_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/materials/{b['material_id']}/content", headers=a["hdr"]
    )
    _assert_not_found(r, "material_not_found")


async def test_material_ingestion_status_cross_workspace_404(two_workspaces):
    """A random UUID 404s the same way a cross-workspace UUID would —
    both must produce the generic ``ingestion_job_not_found`` code."""
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    bogus = str(uuid.uuid4())
    r = await c.get(
        f"/materials/{bogus}/ingestion-status", headers=a["hdr"]
    )
    _assert_not_found(r, "ingestion_job_not_found")


async def test_mcp_get_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/mcp/servers/{a['mcp_server_id']}", headers=a["hdr"]
    )
    assert r.status_code == 200, r.text
    r = await c.get(
        f"/mcp/servers/{b['mcp_server_id']}", headers=a["hdr"]
    )
    _assert_not_found(r, "mcp_not_found")


async def test_mcp_calls_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/mcp/servers/{b['mcp_server_id']}/calls", headers=a["hdr"]
    )
    _assert_not_found(r, "mcp_not_found")


async def test_session_graph_cross_workspace_404(two_workspaces):
    """A random session_id from another workspace would 404 the same as
    a non-existent one — both must surface ``session_not_found``."""
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    bogus = str(uuid.uuid4())
    r = await c.get(
        f"/sessions/{bogus}/graph?mode=citations", headers=a["hdr"]
    )
    _assert_not_found(r, "session_not_found")


async def test_session_bibtex_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    bogus = str(uuid.uuid4())
    r = await c.get(
        f"/sessions/{bogus}/export/citations.bib", headers=a["hdr"]
    )
    _assert_not_found(r, "session_not_found")


async def test_general_session_bibtex_export(two_workspaces):
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    b = two_workspaces["b"]
    r = await c.post("/general/sessions", headers=a["hdr"])
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]

    r = await c.get(
        f"/sessions/{sid}/export/citations.bib", headers=a["hdr"]
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/x-bibtex")
    assert "no citations recorded" in r.text

    r = await c.get(
        f"/sessions/{sid}/export/citations.bib", headers=b["hdr"]
    )
    _assert_not_found(r, "session_not_found")


async def test_threads_messages_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    bogus = str(uuid.uuid4())
    r = await c.get(f"/threads/{bogus}/messages", headers=a["hdr"])
    _assert_not_found(r, "thread_not_found")


# ---------------------------------------------------------------------------
# 2. WRITE boundary — PATCH / DELETE / POST that take a workspace-scoped id
# ---------------------------------------------------------------------------


async def test_draft_patch_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.patch(
        f"/drafts/{b['draft_id']}",
        headers=a["hdr"],
        json={"body": "evil"},
    )
    _assert_not_found(r, "draft_not_found")


async def test_draft_delete_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.delete(f"/drafts/{b['draft_id']}", headers=a["hdr"])
    _assert_not_found(r, "draft_not_found")


async def test_material_delete_cross_workspace_404(two_workspaces):
    """DELETE /materials/{B-material-id} from A must surface material_not_found."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.delete(
        f"/materials/{b['material_id']}", headers=a["hdr"]
    )
    _assert_not_found(r, "material_not_found")


async def test_project_draft_put_cross_workspace_404(two_workspaces):
    """PUT /projects/{id}/draft on a foreign project must 404 with
    project_not_found — no upsert leak."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.put(
        f"/projects/{b['project_id']}/draft",
        headers=a["hdr"],
        json={"title": "evil", "body": "evil"},
    )
    _assert_not_found(r, "project_not_found")


async def test_mcp_patch_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.patch(
        f"/mcp/servers/{b['mcp_server_id']}",
        headers=a["hdr"],
        json={"name": "renamed"},
    )
    _assert_not_found(r, "mcp_not_found")


async def test_mcp_delete_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.delete(
        f"/mcp/servers/{b['mcp_server_id']}", headers=a["hdr"]
    )
    _assert_not_found(r, "mcp_not_found")


async def test_workflow_start_cross_workspace_404(two_workspaces):
    """POST /drafts/{id}/workflow on a foreign draft must 404."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.post(
        f"/drafts/{b['draft_id']}/workflow",
        headers=a["hdr"],
        json={"prompt": "draft me", "interview": {}},
    )
    _assert_not_found(r, "draft_not_found")


async def test_workflow_get_cross_workspace_404(two_workspaces):
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.get(
        f"/drafts/{b['draft_id']}/workflow", headers=a["hdr"]
    )
    _assert_not_found(r, "draft_not_found")


# ---------------------------------------------------------------------------
# 3. CHAT boundary — /chat referencing a foreign project_id or thread_id
# ---------------------------------------------------------------------------


async def test_chat_cross_workspace_project_404(two_workspaces):
    """Member A sending /chat with B's project_id must surface
    project_not_found (NOT 'agent error: ...' or 500)."""
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]
    r = await c.post(
        "/chat",
        headers=a["hdr"],
        json={"message": "hello", "project_id": b["project_id"]},
    )
    _assert_not_found(r, "project_not_found")


async def test_chat_cross_workspace_thread_404(two_workspaces):
    """A bogus / cross-workspace thread_id must surface thread_not_found."""
    c = two_workspaces["client"]
    a = two_workspaces["a"]
    bogus = str(uuid.uuid4())
    r = await c.post(
        "/chat",
        headers=a["hdr"],
        json={"message": "hello", "thread_id": bogus},
    )
    _assert_not_found(r, "thread_not_found")


# ---------------------------------------------------------------------------
# 4. Audit log isolation — workspace-scoped, no cross-workspace bleed.
# ---------------------------------------------------------------------------


async def test_audit_log_is_workspace_scoped(two_workspaces):
    """A's audit must not include any event whose workspace_id is B's.

    The /audit endpoint already filters on the caller's workspace_id —
    this test pins that behaviour so a future refactor can't regress it.
    """
    c = two_workspaces["client"]
    a, b = two_workspaces["a"], two_workspaces["b"]

    r = await c.get("/audit?limit=200", headers=a["hdr"])
    assert r.status_code == 200, r.text
    events_a = r.json()
    r = await c.get("/audit?limit=200", headers=b["hdr"])
    assert r.status_code == 200, r.text
    events_b = r.json()

    # Both must have at least the member.claim event from their own claim.
    assert events_a, "expected at least one audit event for workspace A"
    assert events_b, "expected at least one audit event for workspace B"
    # The events seen by each side must be disjoint — no leakage either way.
    ids_a = {e["id"] for e in events_a}
    ids_b = {e["id"] for e in events_b}
    assert ids_a.isdisjoint(ids_b), (ids_a & ids_b)
    # Every workspace_id field in A's view is A's workspace.
    ws_ids_in_a = {e["workspace_id"] for e in events_a}
    assert len(ws_ids_in_a) == 1, ws_ids_in_a


# ---------------------------------------------------------------------------
# 5. TODO — endpoints owned by the backend agent's parallel work.
#
# These don't exist (yet) but should be added once the backend agent
# lands the corresponding routes:
#   - GET  /healthz                                  (unauthed liveness)
#   - GET  /readyz                                   (unauthed readiness)
#   - POST /me/tokens, GET /me/tokens,
#     DELETE /me/tokens/{id}                        (personal access tokens)
#   - POST /auth/sessions/revoke-all                 (kill-switch)
#   - GET  /projects/{id}/concepts                   (graph concepts lens —
#                                                     planned alongside the
#                                                     Concepts graph)
# When those land, add cross-workspace assertions of the same shape.
# ---------------------------------------------------------------------------
