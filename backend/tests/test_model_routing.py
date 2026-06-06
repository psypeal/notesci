"""Tests for the multi-provider model routing path.

Covers the four user-visible improvements:
  1. /providers/available returns the canonical catalog and reports
     `has_key` accurately for each provider.
  2. /chat threads ChatIn.model into make_chat_model and back into
     ChatOut.model_used so the UI can attribute each bubble.
  3. extract_text correctly strips reasoning blocks so reasoner models
     produce a non-empty bubble.
  4. The draft workflow honors per-stage model overrides
     (draft_model / polish_model / review_model in Interview).

All real LLM calls are monkeypatched — these tests verify the routing
*plumbing*, not provider behavior.
"""
from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from langchain_core.messages import AIMessage

from notesci.agent import providers as providers_module
from notesci.agent.messages import extract_text
from notesci.draft_workflow import Interview
from notesci.main import _last_visible_ai_text


# ---------------------------------------------------------------------------
# extract_text — the reasoner-content fix
# ---------------------------------------------------------------------------

def test_extract_text_str_passthrough():
    assert extract_text("hello world") == "hello world"


def test_extract_text_none():
    assert extract_text(None) == ""


def test_extract_text_list_of_blocks():
    content = [
        {"type": "text", "text": "Visible part. "},
        {"type": "thinking", "thinking": "internal cot"},
        {"type": "text", "text": "More visible."},
    ]
    assert extract_text(content) == "Visible part. More visible."


def test_extract_text_skips_reasoning_block():
    """DeepSeek-Reasoner emits a reasoning block alongside the text."""
    content = [
        {"type": "reasoning", "reasoning": "private chain of thought"},
        {"type": "text", "text": "the answer is 42"},
    ]
    assert extract_text(content) == "the answer is 42"


def test_extract_text_legacy_output_text():
    """Some older OpenAI SDK versions used type='output_text'."""
    content = [{"type": "output_text", "text": "ok"}]
    assert extract_text(content) == "ok"


def test_extract_text_string_blocks_in_list():
    content = ["plain ", "string ", "blocks"]
    assert extract_text(content) == "plain string blocks"


def test_last_visible_ai_text_skips_blank_protocol_messages():
    messages = [
        AIMessage(content=""),
        AIMessage(content=[
            {"type": "reasoning", "reasoning": "internal"},
            {"type": "text", "text": "Visible answer."},
        ]),
        AIMessage(content=""),
    ]

    assert _last_visible_ai_text(messages) == "Visible answer."


def test_last_visible_ai_text_returns_empty_when_no_visible_ai_text():
    assert _last_visible_ai_text([AIMessage(content="")]) == ""


# ---------------------------------------------------------------------------
# /providers/available — availability signal
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_providers_available_requires_auth(client: AsyncClient):
    r = await client.get("/providers/available")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_providers_available_reports_has_key(
    client: AsyncClient, auth_headers: dict, monkeypatch: pytest.MonkeyPatch
):
    """has_key reflects the runtime settings — not the env at import time."""
    from notesci.config import settings

    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-fake", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", None, raising=False)
    monkeypatch.setattr(settings, "google_api_key", None, raising=False)
    monkeypatch.setattr(settings, "deepseek_api_key", "ds-fake", raising=False)

    r = await client.get("/providers/available", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()

    by_id = {p["id"]: p for p in body["providers"]}
    assert by_id["anthropic"]["has_key"] is True
    assert by_id["openai"]["has_key"] is False
    assert by_id["deepseek"]["has_key"] is True
    assert by_id["google_genai"]["has_key"] is False

    # Models inherit availability from their provider.
    by_model = {m["id"]: m for m in body["models"]}
    assert by_model["anthropic:claude-sonnet-4-6"]["available"] is True
    assert by_model["openai:gpt-5.4"]["available"] is False
    assert by_model["deepseek:deepseek-chat"]["available"] is True

    # Fallback model picks the first available when default is unavailable.
    monkeypatch.setattr(
        settings, "notesci_default_model", "openai:gpt-5.4"
    )
    r2 = await client.get("/providers/available", headers=auth_headers)
    body2 = r2.json()
    assert body2["default_model"] == "openai:gpt-5.4"
    assert body2["fallback_model"] != "openai:gpt-5.4"
    # Should be some available model.
    available_ids = {m["id"] for m in body2["models"] if m["available"]}
    assert body2["fallback_model"] in available_ids


# ---------------------------------------------------------------------------
# /chat — model is threaded end-to-end and surfaced as model_used
# ---------------------------------------------------------------------------

class _FakeLLM:
    """Minimal LLM stand-in — records every model id make_chat_model
    is called with so a test can assert routing without hitting a provider."""
    last_model_id: str | None = None
    invocations: list[str] = []

    def __init__(self, model_id: str | None):
        self.model_id = model_id
        type(self).last_model_id = model_id
        type(self).invocations.append(model_id or "<default>")

    def bind_tools(self, _tools):
        return self

    async def ainvoke(self, _msgs):
        # Real AIMessage so LangGraph's message coercion is happy.
        return AIMessage(content="Hello from " + (self.model_id or "default"))


@pytest.fixture
def fake_chat_model(monkeypatch: pytest.MonkeyPatch):
    """Replace make_chat_model with a recording stub everywhere it's used."""
    _FakeLLM.invocations = []
    _FakeLLM.last_model_id = None

    def factory(model_id: str | None = None):
        return _FakeLLM(model_id)

    # main.py / agent/graph.py both import via this module, so patching the
    # source binding propagates everywhere.
    monkeypatch.setattr(providers_module, "make_chat_model", factory)
    # Also patch the symbol re-exported into agent.graph and draft_workflow.
    from notesci.agent import graph as graph_module
    from notesci import draft_workflow as wf_module
    monkeypatch.setattr(graph_module, "make_chat_model", factory)
    monkeypatch.setattr(wf_module, "make_chat_model", factory)

    return _FakeLLM


@pytest.fixture
def fake_embeddings(monkeypatch: pytest.MonkeyPatch):
    """Stub the embedder so /chat doesn't try to hit OpenAI for retrieval."""
    class _FakeEmb:
        async def aembed_query(self, _q: str):
            return [0.0] * 1536

    from notesci.agent import graph as graph_module
    from notesci import draft_workflow as wf_module
    monkeypatch.setattr(graph_module, "make_embedding_model", lambda *a, **k: _FakeEmb())
    monkeypatch.setattr(wf_module, "make_embedding_model", lambda *a, **k: _FakeEmb())


@pytest.mark.parametrize(
    "model_id",
    [
        "anthropic:claude-sonnet-4-6",
        "openai:gpt-5",
        "deepseek:deepseek-chat",
    ],
)
@pytest.mark.asyncio
async def test_chat_routes_per_request_model(
    model_id: str,
    client: AsyncClient,
    auth_headers: dict,
    fake_chat_model,
    fake_embeddings,
):
    # Need a project for /chat to resolve a session against.
    r = await client.post(
        "/projects", headers=auth_headers, json={"name": "Routing Test"}
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]

    r = await client.post(
        "/chat",
        headers=auth_headers,
        json={"message": "ping", "project_id": project_id, "model": model_id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The exact model id flowed all the way to make_chat_model.
    assert fake_chat_model.last_model_id == model_id
    # And back into the response so the UI can attribute the bubble.
    assert body["model_used"] == model_id
    assert body["turn_seq"] == 0
    assert body["reply"].endswith(model_id)


@pytest.mark.asyncio
async def test_chat_falls_back_to_resolved_default(
    client: AsyncClient,
    auth_headers: dict,
    fake_chat_model,
    fake_embeddings,
    monkeypatch: pytest.MonkeyPatch,
):
    """When the request carries no model, the server resolves one via
    ``resolve_default_model()`` — operator opt-in default if set,
    otherwise the first available provider model. No hardcoded default
    is imposed on the user."""
    from notesci.config import settings
    from notesci.agent.providers import resolve_default_model

    # Pin a single provider key so the resolver picks deterministically.
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-fake", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", None, raising=False)
    monkeypatch.setattr(settings, "google_api_key", None, raising=False)
    monkeypatch.setattr(settings, "deepseek_api_key", None, raising=False)
    # Operator hasn't set NOTESCI_DEFAULT_MODEL — we want to verify the
    # "no imposed default" path.
    monkeypatch.setattr(settings, "notesci_default_model", None, raising=False)

    r = await client.post(
        "/projects", headers=auth_headers, json={"name": "Default Model"}
    )
    project_id = r.json()["id"]

    r = await client.post(
        "/chat",
        headers=auth_headers,
        json={"message": "hi", "project_id": project_id},  # no model
    )
    assert r.status_code == 200, r.text
    # body.model was None, so make_chat_model is called with None.
    assert fake_chat_model.last_model_id is None
    body = r.json()
    # ChatOut.model_used surfaces the resolved model — the first available
    # Anthropic chat model since that's the only key set.
    resolved = resolve_default_model()
    assert resolved is not None
    assert body["model_used"] == resolved


@pytest.mark.asyncio
async def test_chat_honors_operator_default_when_available(
    client: AsyncClient,
    auth_headers: dict,
    fake_chat_model,
    fake_embeddings,
    monkeypatch: pytest.MonkeyPatch,
):
    """When the operator sets NOTESCI_DEFAULT_MODEL to a model whose
    provider key is configured, the resolver honors it over the
    catalog-first-available fallback."""
    from notesci.config import settings

    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-fake", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", None, raising=False)
    monkeypatch.setattr(settings, "google_api_key", None, raising=False)
    monkeypatch.setattr(settings, "deepseek_api_key", "ds-fake", raising=False)
    monkeypatch.setattr(
        settings, "notesci_default_model", "deepseek:deepseek-chat", raising=False,
    )

    r = await client.post(
        "/projects", headers=auth_headers, json={"name": "Operator Default"}
    )
    project_id = r.json()["id"]

    r = await client.post(
        "/chat",
        headers=auth_headers,
        json={"message": "hi", "project_id": project_id},  # no model
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_used"] == "deepseek:deepseek-chat"


# ---------------------------------------------------------------------------
# Per-stage model routing in the draft workflow
# ---------------------------------------------------------------------------

def test_interview_model_for_default_falls_back_to_top_level():
    iv = Interview()
    assert iv.model_for("draft", "anthropic:claude-sonnet-4-6") == "anthropic:claude-sonnet-4-6"
    assert iv.model_for("polish", "anthropic:claude-sonnet-4-6") == "anthropic:claude-sonnet-4-6"
    assert iv.model_for("review", "anthropic:claude-sonnet-4-6") == "anthropic:claude-sonnet-4-6"


def test_interview_model_for_per_stage_override_wins():
    iv = Interview(
        draft_model="anthropic:claude-sonnet-4-6",
        polish_model="openai:gpt-5",
        review_model="deepseek:deepseek-chat",
    )
    assert iv.model_for("draft", "anthropic:claude-opus-4-7") == "anthropic:claude-sonnet-4-6"
    assert iv.model_for("polish", "anthropic:claude-opus-4-7") == "openai:gpt-5"
    assert iv.model_for("review", "anthropic:claude-opus-4-7") == "deepseek:deepseek-chat"


def test_interview_from_dict_coerces_blank_strings_to_none():
    """The frontend sends '' for an unset per-stage picker — must become None."""
    iv = Interview.from_dict({
        "draft_model": "",
        "polish_model": "openai:gpt-5",
        "review_model": None,
    })
    assert iv.draft_model is None
    assert iv.polish_model == "openai:gpt-5"
    assert iv.review_model is None
