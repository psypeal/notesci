"""Chat endpoint smoke tests.

The provider-routing tests in ``test_model_routing.py`` already cover
the happy path with a mocked ``make_chat_model``. This file pins down
the failure surface:

  - Invalid (well-formed but unknown) ``project_id`` → 404
    ``project_not_found``.
  - Cross-workspace ``project_id`` → 404 ``project_not_found`` (no leak).
  - Invalid ``project_id`` (bad UUID) → 400 ``invalid_project_id``.
  - When the agent raises, the response must be a typed error — not a
    free-form ``"agent error: <repr>"`` string. The backend agent's
    plan is to surface ``agent_failed``; this is marked ``xfail`` so
    it auto-flips when the typed-error fix lands.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage

from notesci.agent import providers as providers_module
from notesci.config import settings
from notesci.main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def chat_client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def _bootstrap(chat_client: AsyncClient) -> dict:
    admin = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await chat_client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin},
        json={"slug": slug, "name": f"Chat {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    code = r.json()["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await chat_client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    return {"headers": {"Authorization": f"Bearer {r.json()['token']}"}}


class _FakeLLM:
    """LangGraph-compatible stub — see test_model_routing.py."""
    def __init__(self, model_id=None):
        self.model_id = model_id

    def bind_tools(self, _tools):
        return self

    async def ainvoke(self, _msgs):
        return AIMessage(content="hi back")


class _FailingLLM:
    """LLM stub that always raises — for testing the error surface."""
    def __init__(self, model_id=None):
        self.model_id = model_id

    def bind_tools(self, _tools):
        return self

    async def ainvoke(self, _msgs):
        raise RuntimeError("provider went sideways")


class _FakeEmb:
    async def aembed_query(self, _q: str):
        return [0.0] * 1536


@pytest.fixture
def fake_chat(monkeypatch: pytest.MonkeyPatch):
    """Wire ``make_chat_model`` and ``make_embedding_model`` to stubs so
    /chat doesn't need an OpenAI key in CI."""

    def factory(model_id: str | None = None):
        return _FakeLLM(model_id)

    from notesci.agent import graph as graph_module
    from notesci import draft_workflow as wf_module
    monkeypatch.setattr(providers_module, "make_chat_model", factory)
    monkeypatch.setattr(graph_module, "make_chat_model", factory)
    monkeypatch.setattr(wf_module, "make_chat_model", factory)
    monkeypatch.setattr(
        graph_module, "make_embedding_model", lambda *a, **k: _FakeEmb()
    )
    monkeypatch.setattr(
        wf_module, "make_embedding_model", lambda *a, **k: _FakeEmb()
    )


@pytest.fixture
def failing_chat(monkeypatch: pytest.MonkeyPatch):
    """Same as ``fake_chat`` but the LLM raises so we can probe the
    error surface (typed-error coordination with the backend agent)."""
    def factory(model_id: str | None = None):
        return _FailingLLM(model_id)

    from notesci.agent import graph as graph_module
    from notesci import draft_workflow as wf_module
    monkeypatch.setattr(providers_module, "make_chat_model", factory)
    monkeypatch.setattr(graph_module, "make_chat_model", factory)
    monkeypatch.setattr(wf_module, "make_chat_model", factory)
    monkeypatch.setattr(
        graph_module, "make_embedding_model", lambda *a, **k: _FakeEmb()
    )
    monkeypatch.setattr(
        wf_module, "make_embedding_model", lambda *a, **k: _FakeEmb()
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


async def test_chat_happy_path(chat_client: AsyncClient, fake_chat):
    """A simple POST /chat with a real project_id returns the assistant
    reply and a thread_id."""
    bs = await _bootstrap(chat_client)
    r = await chat_client.post(
        "/projects", headers=bs["headers"], json={"name": "Smoke"}
    )
    project_id = r.json()["id"]

    r = await chat_client.post(
        "/chat",
        headers=bs["headers"],
        json={"message": "hello", "project_id": project_id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reply"]
    assert body["thread_id"]
    assert body["turn_seq"] == 0


# ---------------------------------------------------------------------------
# 404 / 400 surfaces
# ---------------------------------------------------------------------------


async def test_chat_unknown_project_404(
    chat_client: AsyncClient, fake_chat
):
    """A well-formed UUID that doesn't match any project surfaces
    project_not_found — no agent invocation, no 502."""
    bs = await _bootstrap(chat_client)
    bogus = str(uuid.uuid4())
    r = await chat_client.post(
        "/chat",
        headers=bs["headers"],
        json={"message": "hello", "project_id": bogus},
    )
    assert r.status_code == 404, r.text
    assert r.json()["detail"]["code"] == "project_not_found"


async def test_chat_malformed_project_400(
    chat_client: AsyncClient, fake_chat
):
    """A malformed UUID (not a uuid string at all) surfaces 400
    invalid_project_id — distinguishable from the not-found path."""
    bs = await _bootstrap(chat_client)
    r = await chat_client.post(
        "/chat",
        headers=bs["headers"],
        json={"message": "hello", "project_id": "not-a-uuid"},
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "invalid_project_id"


async def test_chat_missing_project_and_thread_400(
    chat_client: AsyncClient, fake_chat
):
    """Calling /chat with neither project_id nor thread_id surfaces
    project_id_required."""
    bs = await _bootstrap(chat_client)
    r = await chat_client.post(
        "/chat",
        headers=bs["headers"],
        json={"message": "orphan"},
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "project_id_required"


# ---------------------------------------------------------------------------
# Cross-workspace boundary (mirrors test_workspace_boundaries.py)
# ---------------------------------------------------------------------------


async def test_chat_cross_workspace_project_404(
    chat_client: AsyncClient, fake_chat
):
    """Member of workspace A sending /chat with workspace B's
    project_id must 404 project_not_found — same anti-leak rule."""
    a = await _bootstrap(chat_client)
    b = await _bootstrap(chat_client)
    r = await chat_client.post(
        "/projects", headers=b["headers"], json={"name": "B"}
    )
    b_project_id = r.json()["id"]

    r = await chat_client.post(
        "/chat",
        headers=a["headers"],
        json={"message": "hi", "project_id": b_project_id},
    )
    assert r.status_code == 404, r.text
    assert r.json()["detail"]["code"] == "project_not_found"


# ---------------------------------------------------------------------------
# Typed error surface — backend agent's planned ``agent_failed`` code.
# ---------------------------------------------------------------------------


async def test_chat_agent_error_returns_typed_code(
    chat_client: AsyncClient, failing_chat
):
    """When the agent raises, /chat must surface a typed error code —
    ``agent_failed`` in a dict detail — rather than the legacy
    ``"agent error: <repr>"`` free-form string. Pins the backend
    agent's May-2026 fix so a regression flips this test red."""
    bs = await _bootstrap(chat_client)
    r = await chat_client.post(
        "/projects", headers=bs["headers"], json={"name": "Err"}
    )
    project_id = r.json()["id"]

    r = await chat_client.post(
        "/chat",
        headers=bs["headers"],
        json={"message": "boom", "project_id": project_id},
    )
    assert r.status_code in (500, 502), r.text
    detail = r.json()["detail"]
    # The typed-error contract: detail is a dict with a `code` field —
    # not a free-form string like "agent error: RuntimeError(...)".
    assert isinstance(detail, dict), f"detail must be dict, got: {detail!r}"
    assert detail.get("code") == "agent_failed"
