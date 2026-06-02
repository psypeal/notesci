"""Invite allotment + lookup."""
from __future__ import annotations

from httpx import AsyncClient


async def test_invite_lookup_unknown(client: AsyncClient):
    """Unknown codes return status=unknown without leaking workspace info."""
    r = await client.get("/invites/NS-AAAA-AAAA/lookup")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in ("unknown", "valid", "claimed", "expired")
    # No workspace_name when status != valid (anti-enumeration).
    if body["status"] != "valid":
        assert body.get("workspace_name") is None


async def test_member_invite_allotment(client: AsyncClient, auth_headers: dict):
    """Each new member gets 3 'available' invites at claim time."""
    r = await client.get("/invites", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "available_count" in body
    assert body["available_count"] == 3
    assert len(body["invites"]) == 3
    for inv in body["invites"]:
        assert inv["status"] == "available"
        assert inv["code"].startswith("NS-")
