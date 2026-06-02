"""Long-term memory behavior tests."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from langchain_core.messages import AIMessage

from notesci.agent.graph import RequestCtx, reset_request_ctx, set_request_ctx
from notesci.auth import hash_password, mint_session
from notesci.config import settings
from notesci.db import get_conn
from notesci.memory.extractor import memory_tools


@pytest.fixture
def no_memory_embeddings(monkeypatch: pytest.MonkeyPatch):
    """Keep memory writes deterministic and offline in CI."""
    from notesci.memory import embedding as memory_embedding
    from notesci.memory import retriever as memory_retriever

    monkeypatch.setattr(
        memory_embedding, "embedding_provider_available", lambda: False
    )
    monkeypatch.setattr(
        memory_retriever, "embedding_provider_available", lambda: False
    )


async def _create_project(client: AsyncClient, headers: dict, name: str = "Memory") -> str:
    r = await client.post("/projects", headers=headers, json={"name": name})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _bootstrap_member(client: AsyncClient) -> dict:
    slug = f"mem-{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": settings.notesci_admin_token or ""},
        json={"slug": slug, "name": f"Memory {slug}"},
    )
    assert r.status_code in (200, 201), r.text
    workspace_id = uuid.UUID(r.json()["workspace_id"])
    member_id = uuid.uuid4()
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO members
                (id, workspace_id, email, password_hash, role)
            VALUES (%s, %s, %s, %s, 'admin')
            """,
            (member_id, workspace_id, email, hash_password("x" * 12)),
        )
        token, _expires = await mint_session(conn, member_id)
        await conn.commit()
    return {
        "headers": {"Authorization": f"Bearer {token}"},
        "member": {
            "id": str(member_id),
            "workspace_id": str(workspace_id),
            "email": email,
        },
    }


async def test_memory_fact_crud_dedup_and_archive(
    client: AsyncClient, no_memory_embeddings
):
    auth = await _bootstrap_member(client)
    auth_headers = auth["headers"]
    first = {
        "scope": "general",
        "project_id": None,
        "kind": "preference",
        "title": "Citation style",
        "body": "The user prefers Vancouver-style citations.",
    }
    r = await client.post("/memories", headers=auth_headers, json=first)
    assert r.status_code == 200, r.text
    created = r.json()

    # Same kind/scope/title updates the existing row instead of creating
    # a duplicate durable fact.
    second = {**first, "body": "The user prefers compact Vancouver citations."}
    r = await client.post("/memories", headers=auth_headers, json=second)
    assert r.status_code == 200, r.text
    deduped = r.json()
    assert deduped["id"] == created["id"]
    assert deduped["body"] == second["body"]

    r = await client.get("/memories?scope=general", headers=auth_headers)
    assert r.status_code == 200, r.text
    rows = [row for row in r.json() if row["kind"] != "core"]
    assert [row["id"] for row in rows].count(created["id"]) == 1

    r = await client.patch(
        f"/memories/{created['id']}",
        headers=auth_headers,
        json={
            "kind": "open_question",
            "title": "Open analysis question",
            "body": "The user is still deciding how to benchmark recall.",
        },
    )
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["kind"] == "open_question"
    assert updated["title"] == "Open analysis question"

    r = await client.delete(f"/memories/{created['id']}", headers=auth_headers)
    assert r.status_code == 204, r.text
    r = await client.get("/memories?scope=general", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert all(row["id"] != created["id"] for row in r.json())


async def test_project_chat_reads_general_and_project_core_memory(
    client: AsyncClient,
    no_memory_embeddings,
    monkeypatch: pytest.MonkeyPatch,
):
    from notesci.agent import graph as graph_module
    from notesci.memory import retriever as memory_retriever

    captured_messages = []

    class CaptureLLM:
        def bind_tools(self, _tools):
            return self

        async def ainvoke(self, messages):
            captured_messages.append(messages)
            return AIMessage(content="done")

    monkeypatch.setattr(graph_module, "make_chat_model", lambda _model=None: CaptureLLM())
    monkeypatch.setattr(graph_module, "embedding_provider_available", lambda: False)
    monkeypatch.setattr(memory_retriever, "embedding_provider_available", lambda: False)

    auth = await _bootstrap_member(client)
    auth_headers = auth["headers"]
    project_id = await _create_project(client, auth_headers)
    r = await client.put(
        "/memories/core",
        headers=auth_headers,
        json={
            "scope": "general",
            "project_id": None,
            "body": "The user prefers terse prose.",
        },
    )
    assert r.status_code == 200, r.text
    r = await client.put(
        "/memories/core",
        headers=auth_headers,
        json={
            "scope": "project",
            "project_id": project_id,
            "body": "This project studies recall benchmarks.",
        },
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/chat",
        headers=auth_headers,
        json={"message": "What should we optimize?", "project_id": project_id},
    )
    assert r.status_code == 200, r.text
    joined = "\n\n".join(
        getattr(message, "content", "")
        for message in captured_messages[-1]
        if getattr(message, "type", None) == "system"
    )
    assert "The user prefers terse prose." in joined
    assert "This project studies recall benchmarks." in joined

    captured_messages.clear()
    r = await client.post(
        "/chat",
        headers=auth_headers,
        json={
            "message": "Private question",
            "project_id": project_id,
            "memory_incognito": True,
        },
    )
    assert r.status_code == 200, r.text
    joined = "\n\n".join(
        getattr(message, "content", "")
        for message in captured_messages[-1]
        if getattr(message, "type", None) == "system"
    )
    assert "The user prefers terse prose." not in joined
    assert "This project studies recall benchmarks." not in joined


async def test_memory_save_tool_scopes_preferences_globally_inside_project(
    client: AsyncClient,
    no_memory_embeddings,
):
    auth = await _bootstrap_member(client)
    auth_headers = auth["headers"]
    member = auth["member"]
    project_id = await _create_project(client, auth_headers)
    session_id = uuid.uuid4()
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO sessions
                (id, project_id, workspace_id, created_by_member_id, kind)
            VALUES (%s, %s, %s, %s, 'project')
            """,
            (
                session_id,
                uuid.UUID(project_id),
                uuid.UUID(member["workspace_id"]),
                uuid.UUID(member["id"]),
            ),
        )
        await conn.commit()

    token = set_request_ctx(
        RequestCtx(
            member_id=member["id"],
            session_id=str(session_id),
        )
    )
    try:
        tool = memory_tools()[0]
        out = await tool.ainvoke(
            {
                "kind": "preference",
                "title": "Citation style",
                "body": "The user prefers Vancouver citations.",
            }
        )
    finally:
        reset_request_ctx(token)
    assert "saved memory" in out

    r = await client.get("/memories?scope=general", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert any(row["title"] == "Citation style" for row in r.json())

    r = await client.get(
        f"/memories?scope=project&project_id={project_id}",
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    assert all(row["title"] != "Citation style" for row in r.json())
