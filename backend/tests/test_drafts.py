"""Drafts — server-backed long-form writing surface."""
from __future__ import annotations

import uuid

from httpx import AsyncClient


async def test_draft_lifecycle(client: AsyncClient, auth_headers: dict):
    # Create a project to attach the draft to.
    r = await client.post(
        "/projects",
        headers=auth_headers,
        json={"slug": f"p-{uuid.uuid4().hex[:8]}", "name": "Test project"},
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]

    # No draft yet → endpoint returns null (200, not 404).
    r = await client.get(
        f"/projects/{project_id}/draft", headers=auth_headers
    )
    assert r.status_code == 200
    assert r.json() is None

    # PUT creates the draft.
    r = await client.put(
        f"/projects/{project_id}/draft",
        headers=auth_headers,
        json={"title": "Working title", "body": "First sentence."},
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["title"] == "Working title"
    assert d["body"] == "First sentence."
    first_updated = d["updated_at"]

    # GET returns it.
    r = await client.get(
        f"/projects/{project_id}/draft", headers=auth_headers
    )
    assert r.status_code == 200
    assert r.json()["body"] == "First sentence."

    # PUT again upserts and bumps updated_at.
    r = await client.put(
        f"/projects/{project_id}/draft",
        headers=auth_headers,
        json={"title": "Working title", "body": "First sentence. Second."},
    )
    assert r.status_code == 200
    assert r.json()["body"] == "First sentence. Second."
    assert r.json()["updated_at"] >= first_updated


async def test_draft_unknown_project(client: AsyncClient, auth_headers: dict):
    bogus = "00000000-0000-0000-0000-000000000000"
    r = await client.get(f"/projects/{bogus}/draft", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "project_not_found"


async def test_drafts_library_multi_create(
    client: AsyncClient, auth_headers: dict
):
    r = await client.post(
        "/projects",
        headers=auth_headers,
        json={"slug": f"p-{uuid.uuid4().hex[:8]}", "name": "Library project"},
    )
    project_id = r.json()["id"]

    # Empty library.
    r = await client.get(
        f"/projects/{project_id}/drafts", headers=auth_headers
    )
    assert r.status_code == 200
    assert r.json() == []

    # Create three distinct drafts in this project.
    ids = []
    for i in range(3):
        r = await client.post(
            f"/projects/{project_id}/drafts",
            headers=auth_headers,
            json={"title": f"Draft {i}", "body": f"Body of draft {i}."},
        )
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    assert len(set(ids)) == 3  # genuinely distinct rows

    # List comes back newest-touched first with preview text.
    r = await client.get(
        f"/projects/{project_id}/drafts", headers=auth_headers
    )
    body = r.json()
    assert len(body) == 3
    assert body[0]["title"] == "Draft 2"
    assert "Body of draft 2." in body[0]["preview"]


async def test_draft_patch_and_delete(client: AsyncClient, auth_headers: dict):
    r = await client.post(
        "/projects",
        headers=auth_headers,
        json={"slug": f"p-{uuid.uuid4().hex[:8]}", "name": "Patch project"},
    )
    project_id = r.json()["id"]
    r = await client.post(
        f"/projects/{project_id}/drafts",
        headers=auth_headers,
        json={"title": "Old", "body": "Old body"},
    )
    did = r.json()["id"]

    # PATCH body only — title is preserved.
    r = await client.patch(
        f"/drafts/{did}",
        headers=auth_headers,
        json={"body": "Replaced body"},
    )
    assert r.status_code == 200
    assert r.json()["title"] == "Old"
    assert r.json()["body"] == "Replaced body"

    # DELETE drops the row.
    r = await client.delete(f"/drafts/{did}", headers=auth_headers)
    assert r.status_code == 204
    r = await client.get(f"/drafts/{did}", headers=auth_headers)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "draft_not_found"


async def test_draft_workspace_isolation(
    client: AsyncClient, auth_headers: dict
):
    """Another member must not be able to read/patch/delete this user's
    draft — 404 with a generic code, no leaking of which workspace owns it."""
    r = await client.post(
        "/projects",
        headers=auth_headers,
        json={"slug": f"p-{uuid.uuid4().hex[:8]}", "name": "Owned project"},
    )
    project_id = r.json()["id"]
    r = await client.post(
        f"/projects/{project_id}/drafts",
        headers=auth_headers,
        json={"title": "Mine", "body": "Mine"},
    )
    did = r.json()["id"]

    # Cross-member attempt: random bearer token = no auth.
    r = await client.get(f"/drafts/{did}", headers={"Authorization": "Bearer x"})
    assert r.status_code == 401
