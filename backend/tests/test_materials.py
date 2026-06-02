"""Materials lifecycle tests — listing, deletion, and cascade.

The text-paste / URL / PDF ingestion paths all need an OpenAI key for
embeddings, so the API-driven seeding path doesn't run cleanly in CI
without that key. Instead we exercise the workspace-scoped delete on
a hand-seeded ``materials`` row (with one chunk + one ingestion_job)
and assert the cascade tables come away clean.

This is the test that catches the kind of bug where someone changes a
foreign-key from ``ON DELETE CASCADE`` to ``NO ACTION`` and leaves
orphaned chunks (and their embeddings) hanging around the DB. The
materials delete docstring promises the cascade — pin it.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app


@pytest.fixture
async def materials_client():
    """Standalone fixture that doesn't use conftest.client — we need
    the AsyncClient open across multiple awaits so we can poke the
    DB between API calls."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


@pytest.fixture
async def workspace_with_project(materials_client: AsyncClient):
    """One workspace + member + project. Returns headers + project_id."""
    admin = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await materials_client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin},
        json={"slug": slug, "name": f"MAT {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    code = r.json()["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await materials_client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    headers = {"Authorization": f"Bearer {r.json()['token']}"}

    r = await materials_client.post(
        "/projects", headers=headers, json={"name": "Materials Project"}
    )
    assert r.status_code in (200, 201), r.text
    return {"headers": headers, "project_id": r.json()["id"]}


async def _insert_material_with_cascade_rows(project_id: str) -> str:
    """Insert one material row + one chunk + one ingestion_job + one
    material_concepts + one material_links so we can verify the cascade.

    Returns the material_id."""
    material_id = uuid.uuid4()
    pj = uuid.UUID(project_id)
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO materials (id, project_id, source_type, title) "
            "VALUES (%s, %s, 'text', %s)",
            (material_id, pj, "Cascade test material"),
        )
        # One chunk — schema is (material_id, ord, text, embedding);
        # embedding is vector(1536), all-zeros is fine for the cascade test.
        await conn.execute(
            "INSERT INTO chunks (material_id, ord, text, embedding) "
            "VALUES (%s, %s, %s, %s)",
            (
                material_id,
                0,
                "cascade chunk text",
                "[" + ",".join(["0.0"] * 1536) + "]",
            ),
        )
        # One ingestion_job.
        await conn.execute(
            "INSERT INTO ingestion_jobs "
            "(material_id, project_id, stage, progress) "
            "VALUES (%s, %s, 'ready', 1.0)",
            (material_id, pj),
        )
        # One material_concepts row.
        await conn.execute(
            "INSERT INTO material_concepts (material_id, concept, count) "
            "VALUES (%s, %s, %s)",
            (material_id, "test-concept", 1),
        )
        await conn.commit()
    return str(material_id)


async def _count(table: str, material_id: str, col: str = "material_id") -> int:
    """Helper — count rows in a table for the given material_id."""
    async with get_conn() as conn:
        cur = await conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {col} = %s",
            (uuid.UUID(material_id),),
        )
        return (await cur.fetchone())[0]


async def test_material_appears_in_project_listing(
    materials_client: AsyncClient, workspace_with_project: dict
):
    """A material seeded into the project shows up in /projects/{id}/materials."""
    c = materials_client
    h = workspace_with_project["headers"]
    project_id = workspace_with_project["project_id"]
    material_id = await _insert_material_with_cascade_rows(project_id)

    r = await c.get(f"/projects/{project_id}/materials", headers=h)
    assert r.status_code == 200, r.text
    ids = {m["id"] for m in r.json()}
    assert material_id in ids


async def test_material_delete_cascades_to_child_tables(
    materials_client: AsyncClient, workspace_with_project: dict
):
    """DELETE /materials/{id} should cascade-remove chunks,
    ingestion_jobs, and material_concepts."""
    c = materials_client
    h = workspace_with_project["headers"]
    project_id = workspace_with_project["project_id"]
    material_id = await _insert_material_with_cascade_rows(project_id)

    # Pre-delete: child rows exist.
    assert await _count("chunks", material_id) == 1
    assert await _count("ingestion_jobs", material_id) == 1
    assert await _count("material_concepts", material_id) == 1

    # DELETE returns 204.
    r = await c.delete(f"/materials/{material_id}", headers=h)
    assert r.status_code == 204, r.text

    # Subsequent GETs for material file / content / status return 404
    # with the documented codes.
    r = await c.get(f"/materials/{material_id}/file", headers=h)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "material_not_found"

    r = await c.get(f"/materials/{material_id}/content", headers=h)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "material_not_found"

    r = await c.get(
        f"/materials/{material_id}/ingestion-status", headers=h
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "ingestion_job_not_found"

    # Cascade: every child table is empty for this material_id.
    assert await _count("chunks", material_id) == 0
    assert await _count("ingestion_jobs", material_id) == 0
    assert await _count("material_concepts", material_id) == 0
    # message_citations is keyed by material_id too, and would have
    # cascaded too — assert it's 0 even though we didn't seed one (so
    # the count was 0 to start with, but if a future test seeds it
    # this assertion guards against a forgotten cascade FK).
    assert await _count("message_citations", material_id) == 0


async def test_material_delete_unknown_id_404(
    materials_client: AsyncClient, workspace_with_project: dict
):
    bogus = str(uuid.uuid4())
    r = await materials_client.delete(
        f"/materials/{bogus}", headers=workspace_with_project["headers"]
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "material_not_found"


async def test_material_delete_invalid_uuid_400(
    materials_client: AsyncClient, workspace_with_project: dict
):
    r = await materials_client.delete(
        "/materials/not-a-uuid", headers=workspace_with_project["headers"]
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_material_id"
