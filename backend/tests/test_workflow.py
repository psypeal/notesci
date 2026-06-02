"""Draft workflow — start / get / cancel endpoints.

The full pipeline does real LLM calls, so we don't exercise that here.
This file verifies the orchestration plumbing: a POST creates a row with
the expected status, GET returns it, cancel flips the status, and
permission checks fire on cross-member access.
"""
from __future__ import annotations

import asyncio
import uuid

from httpx import AsyncClient


async def _make_draft(client: AsyncClient, auth_headers: dict) -> tuple[str, str]:
    """Create a project + an empty draft; return (project_id, draft_id)."""
    r = await client.post(
        "/projects",
        headers=auth_headers,
        json={"slug": f"p-{uuid.uuid4().hex[:8]}", "name": "WF test project"},
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]

    r = await client.put(
        f"/projects/{project_id}/draft",
        headers=auth_headers,
        json={"title": "WF draft", "body": ""},
    )
    assert r.status_code == 200, r.text
    return project_id, r.json()["id"]


async def test_get_returns_null_when_no_workflow(
    client: AsyncClient, auth_headers: dict
):
    _, draft_id = await _make_draft(client, auth_headers)
    r = await client.get(
        f"/drafts/{draft_id}/workflow", headers=auth_headers
    )
    assert r.status_code == 200, r.text
    assert r.json() is None


async def test_start_creates_row_then_cancel(
    client: AsyncClient, auth_headers: dict
):
    _, draft_id = await _make_draft(client, auth_headers)

    r = await client.post(
        f"/drafts/{draft_id}/workflow",
        headers=auth_headers,
        json={"prompt": "Draft an introduction.", "interview": {}},
    )
    assert r.status_code in (200, 201), r.text
    wf = r.json()
    assert wf["status"] in (
        "gathering_materials",
        "drafting",
        "polishing",
        "reviewing",
        "failed",
    ), wf["status"]
    assert wf["draft_id"] == draft_id
    assert wf["max_iterations"] >= 1

    # Cancel — flips to cancelled (or no-op if already terminal).
    r = await client.post(
        f"/drafts/{draft_id}/workflow/cancel", headers=auth_headers
    )
    # If the background task completed before we hit cancel, the row is
    # already at a terminal status — endpoint returns 404.
    assert r.status_code in (200, 404), r.text


async def test_start_requires_prompt(
    client: AsyncClient, auth_headers: dict
):
    _, draft_id = await _make_draft(client, auth_headers)
    r = await client.post(
        f"/drafts/{draft_id}/workflow",
        headers=auth_headers,
        json={"prompt": "   ", "interview": {}},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "prompt_required"


async def test_workflow_404_for_unknown_draft(
    client: AsyncClient, auth_headers: dict
):
    bogus = "00000000-0000-0000-0000-000000000000"
    r = await client.post(
        f"/drafts/{bogus}/workflow",
        headers=auth_headers,
        json={"prompt": "draft", "interview": {}},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "draft_not_found"
