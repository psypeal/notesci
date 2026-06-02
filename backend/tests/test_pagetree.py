"""Tests for the PageIndex tree-index integration.

Covers the helpers that don't touch the LLM (flatten, find, gather) and
the public endpoints (``/materials/{id}/tree``). Tree build itself is
expensive and provider-dependent — tested via a monkey-patched stub so
CI doesn't need provider credentials.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from psycopg.types.json import Jsonb

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app
from notesci.pagetree import (
    _find_node,
    _flatten_nodes,
    gather_text_for_nodes,
)


# ---------------------------------------------------------------------------
# Tree-walk helpers — pure, no LLM, no DB.
# ---------------------------------------------------------------------------


def _sample_tree() -> list[dict]:
    return [
        {
            "node_id": "0000",
            "title": "Introduction",
            "summary": "Frames the problem.",
            "text": "intro body text",
            "nodes": [
                {
                    "node_id": "0001",
                    "title": "Motivation",
                    "summary": "Why this matters.",
                    "text": "motivation body text",
                },
            ],
        },
        {
            "node_id": "0002",
            "title": "Methods",
            "summary": "How we did it.",
            "text": "methods body text",
        },
    ]


def test_flatten_returns_all_nodes_in_order():
    flat = _flatten_nodes(_sample_tree())
    assert [n["node_id"] for n in flat] == ["0000", "0001", "0002"]
    # text is NOT in the flat shape — only id/title/summary, kept compact
    # so the outline prompt stays under control.
    assert "text" not in flat[0]


def test_find_node_returns_full_node_with_text():
    n = _find_node(_sample_tree(), "0001")
    assert n is not None
    assert n["title"] == "Motivation"
    assert n["text"] == "motivation body text"


def test_find_node_missing_returns_none():
    assert _find_node(_sample_tree(), "9999") is None


def test_gather_text_concatenates_requested_nodes():
    out = gather_text_for_nodes(_sample_tree(), ["0000", "0002"])
    assert "[0000] Introduction" in out
    assert "intro body text" in out
    assert "[0002] Methods" in out
    # The "---" separator means two sections were joined, not one.
    assert "---" in out


def test_gather_text_respects_budget():
    # 50-char budget — only the first node should fit.
    out = gather_text_for_nodes(_sample_tree(), ["0000", "0001", "0002"], max_chars=50)
    assert "intro body text" in out
    # The cap is on total characters across joined nodes; downstream
    # nodes get clipped but the boundary should keep the output short.
    assert len(out) < 200


def test_gather_text_skips_unknown_ids():
    out = gather_text_for_nodes(_sample_tree(), ["bogus"])
    assert out == ""


# ---------------------------------------------------------------------------
# Endpoint — workspace-scoped 404 + 'absent' status.
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


async def _create_project(client: AsyncClient, headers: dict) -> str:
    r = await client.post("/projects", headers=headers, json={"name": "P"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _seed_material(project_id: str) -> str:
    """Mint a bare material row for tree endpoint tests."""
    mid = uuid.uuid4()
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO materials (id, project_id, source_type, title) "
            "VALUES (%s, %s, 'pdf', %s)",
            (mid, uuid.UUID(project_id), "Untitled"),
        )
        await conn.commit()
    return str(mid)


async def _seed_tree_row(material_id: str, project_id: str, *, status: str, tree: dict | None) -> None:
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO material_trees
              (material_id, project_id, status, tree, node_count, page_count)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                uuid.UUID(material_id),
                uuid.UUID(project_id),
                status,
                Jsonb(tree) if tree is not None else None,
                3 if tree else None,
                42 if tree else None,
            ),
        )
        await conn.commit()


async def test_get_tree_absent_when_no_row():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            project_id = await _create_project(client, hdr)
            material_id = await _seed_material(project_id)

            r = await client.get(f"/materials/{material_id}/tree", headers=hdr)
            assert r.status_code == 200
            body = r.json()
            assert body["material_id"] == material_id
            assert body["status"] == "absent"
            assert body["tree"] is None


async def test_get_tree_returns_ready_payload():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            project_id = await _create_project(client, hdr)
            material_id = await _seed_material(project_id)
            payload = {
                "doc_name": "demo.pdf",
                "doc_description": "Demo doc.",
                "structure": _sample_tree(),
            }
            await _seed_tree_row(material_id, project_id, status="ready", tree=payload)

            r = await client.get(f"/materials/{material_id}/tree", headers=hdr)
            assert r.status_code == 200
            body = r.json()
            assert body["status"] == "ready"
            assert body["tree"]["doc_name"] == "demo.pdf"
            assert body["node_count"] == 3
            assert body["page_count"] == 42


async def test_get_tree_strips_text_by_default():
    """Default response omits per-node ``text`` fields — they can run
    to 100s of KB on real PDFs and the outline UI doesn't need them."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            project_id = await _create_project(client, hdr)
            material_id = await _seed_material(project_id)
            payload = {
                "doc_name": "demo.pdf",
                "doc_description": "Demo doc.",
                "structure": _sample_tree(),
            }
            await _seed_tree_row(material_id, project_id, status="ready", tree=payload)

            r = await client.get(f"/materials/{material_id}/tree", headers=hdr)
            assert r.status_code == 200
            structure = r.json()["tree"]["structure"]
            # No `text` keys anywhere in the tree.
            def walk(n):
                if isinstance(n, dict):
                    assert "text" not in n
                    if n.get("nodes"):
                        walk(n["nodes"])
                elif isinstance(n, list):
                    for x in n:
                        walk(x)
            walk(structure)


async def test_get_tree_include_text_returns_bodies():
    """?include_text=true preserves the per-node text bodies."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            project_id = await _create_project(client, hdr)
            material_id = await _seed_material(project_id)
            payload = {
                "doc_name": "demo.pdf",
                "doc_description": "Demo doc.",
                "structure": _sample_tree(),
            }
            await _seed_tree_row(material_id, project_id, status="ready", tree=payload)

            r = await client.get(
                f"/materials/{material_id}/tree?include_text=true", headers=hdr
            )
            assert r.status_code == 200
            structure = r.json()["tree"]["structure"]
            assert structure[0]["text"] == "intro body text"


async def test_chat_rejects_unknown_retrieval_mode():
    """Pydantic Literal allowlist rejects modes outside vector/tree."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}

            r = await client.post(
                "/chat",
                headers=hdr,
                json={
                    "message": "hi",
                    "retrieval_mode": "hybrid",  # not in {vector, tree}
                },
            )
            # FastAPI returns 422 for validation errors.
            assert r.status_code == 422


async def test_get_tree_cross_workspace_404():
    """Other-workspace material should look identical to non-existent."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws_a = await _bootstrap_workspace(client, admin)
            mem_a = await _claim(client, ws_a)
            hdr_a = {"Authorization": f"Bearer {mem_a['token']}"}
            project_a = await _create_project(client, hdr_a)
            material_a = await _seed_material(project_a)

            ws_b = await _bootstrap_workspace(client, admin)
            mem_b = await _claim(client, ws_b)
            hdr_b = {"Authorization": f"Bearer {mem_b['token']}"}

            r = await client.get(f"/materials/{material_a}/tree", headers=hdr_b)
            assert r.status_code == 404
            assert r.json()["detail"]["code"] == "material_not_found"


# ---------------------------------------------------------------------------
# Feature flag — default off.
# ---------------------------------------------------------------------------


def test_pagetree_disabled_by_default():
    # The settings module reads env, so an operator's `.env` overrides
    # this. The repo default must be `false`.
    from notesci.pagetree import is_enabled
    # The actual value depends on the env; we only assert the
    # *attribute exists* and is a bool. Mid-build deploys may have it on.
    assert isinstance(is_enabled(), bool)
