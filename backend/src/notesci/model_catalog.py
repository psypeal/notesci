"""Canonical chat-model catalog.

Single source of truth for which LLM providers + model ids notesci
exposes to the UI. Used by ``GET /providers/available`` to drive:

  * the Preferences default-model dropdown
  * the in-chat model pill
  * the per-stage workflow model pickers

Each ``Provider`` carries the env-var name we look at to decide whether
its key is configured. Each ``ModelEntry`` carries a friendly label
(``"Claude Sonnet 4.6"``), a one-line description, and the provider id
so the UI can group them. ``id`` is the canonical
``"<provider>:<model_id>"`` string the backend hands to LangChain's
``init_chat_model`` — also the value persisted in ``chat_calls.model``.

Adding a model is a one-line change here. The frontend reads the catalog
at runtime, so no frontend redeploy is needed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Provider:
    id: str            # "anthropic"
    display_name: str  # "Anthropic"
    env_var: str       # "ANTHROPIC_API_KEY"
    settings_attr: str # "anthropic_api_key"


@dataclass(frozen=True)
class ModelEntry:
    id: str              # "anthropic:claude-sonnet-4-6"
    provider_id: str     # "anthropic"
    label: str           # "Claude Sonnet 4.6"
    description: str
    kind: Literal["chat", "reasoning"]
    # Recommended default for these workflow stages. UI uses this to
    # pre-select per-stage pickers without any user intervention.
    suggested_for: tuple[str, ...] = ()


PROVIDERS: tuple[Provider, ...] = (
    Provider("anthropic", "Anthropic", "ANTHROPIC_API_KEY", "anthropic_api_key"),
    Provider("openai", "OpenAI", "OPENAI_API_KEY", "openai_api_key"),
    Provider("google_genai", "Google", "GOOGLE_API_KEY", "google_api_key"),
    Provider("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "deepseek_api_key"),
)


MODELS: tuple[ModelEntry, ...] = (
    ModelEntry(
        id="anthropic:claude-opus-4-7",
        provider_id="anthropic",
        label="Claude Opus 4.7",
        description="Highest quality, slowest, priciest. Best for review panels and final polish.",
        kind="chat",
        suggested_for=("review",),
    ),
    ModelEntry(
        id="anthropic:claude-sonnet-4-6",
        provider_id="anthropic",
        label="Claude Sonnet 4.6",
        description="Balanced quality + speed. Default workhorse for chat and drafting.",
        kind="chat",
        suggested_for=("chat", "draft", "polish"),
    ),
    ModelEntry(
        id="openai:gpt-5.4",
        provider_id="openai",
        label="GPT-5.4",
        description="OpenAI flagship. Strong general reasoning and tool use.",
        kind="chat",
    ),
    ModelEntry(
        id="openai:gpt-5.4-mini",
        provider_id="openai",
        label="GPT-5.4 mini",
        description="Cheaper, faster OpenAI model. Good for high-volume polishing.",
        kind="chat",
    ),
    ModelEntry(
        id="google_genai:gemini-2.5-pro",
        provider_id="google_genai",
        label="Gemini 2.5 Pro",
        description="Google flagship. Strong reasoning + very long context. Needs paid billing linked on the API key's Cloud project.",
        kind="chat",
    ),
    ModelEntry(
        id="google_genai:gemini-2.5-flash",
        provider_id="google_genai",
        label="Gemini 2.5 Flash",
        description="Fast, cheap Google workhorse with long-context recall.",
        kind="chat",
    ),
    ModelEntry(
        id="google_genai:gemini-2.5-flash-lite",
        provider_id="google_genai",
        label="Gemini 2.5 Flash-Lite",
        description="Cheapest Gemini tier. High free-tier quota; good for bulk.",
        kind="chat",
    ),
    # DeepSeek's API doesn't return a confirmable model-version tag, so
    # we don't claim a specific generation (V3 / R1) in the label — the
    # endpoint id is the only thing we can stand behind. We surface only
    # the single plain "DeepSeek" chat endpoint; the separate reasoner
    # endpoint isn't exposed in the picker.
    ModelEntry(
        id="deepseek:deepseek-chat",
        provider_id="deepseek",
        label="DeepSeek",
        description="Inexpensive, capable. Solid choice when budget matters.",
        kind="chat",
    ),
)


def provider_by_id(pid: str) -> Provider | None:
    for p in PROVIDERS:
        if p.id == pid:
            return p
    return None


def model_by_id(mid: str) -> ModelEntry | None:
    for m in MODELS:
        if m.id == mid:
            return m
    return None


def provider_has_key(provider: Provider, settings_obj) -> bool:
    """True if the provider's API-key setting is non-empty."""
    val = getattr(settings_obj, provider.settings_attr, None)
    return bool(val and str(val).strip())


def label_for(model_id: str | None) -> str | None:
    """Friendly label for a canonical model id; falls back to the id itself."""
    if not model_id:
        return None
    m = model_by_id(model_id)
    return m.label if m else model_id


def display_path(model_id: str | None) -> str | None:
    """'Anthropic · Claude Sonnet 4.6' style — for per-bubble attribution."""
    if not model_id:
        return None
    m = model_by_id(model_id)
    if not m:
        return model_id
    p = provider_by_id(m.provider_id)
    return f"{p.display_name if p else m.provider_id} · {m.label}"
