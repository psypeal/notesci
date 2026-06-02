import os
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from ..config import settings
from ..model_catalog import MODELS, PROVIDERS, provider_has_key


def apply_runtime_key(provider_id: str, api_key: str | None) -> None:
    """Set or clear a provider's API key at runtime.

    Mirrors :func:`config._export_provider_keys_to_env` for a single
    provider: writes both the pydantic settings field (so
    :func:`provider_has_key` notices) and the env var (so LangChain's
    ``init_chat_model`` picks it up on the next construction). Pass
    ``None`` or empty to clear.

    Used by the per-workspace ``provider_keys`` table loader on
    startup and by the ``/me/provider-keys`` endpoint when the user
    pastes a fresh key through Settings.
    """
    for p in PROVIDERS:
        if p.id != provider_id:
            continue
        value = (api_key or "").strip() or None
        setattr(settings, p.settings_attr, value)
        if value:
            os.environ[p.env_var] = value
        else:
            os.environ.pop(p.env_var, None)
        return


def resolve_default_model() -> str | None:
    """Resolve the model used when a request didn't pick one.

    Priority:
      1. ``settings.notesci_default_model`` — operator-set fallback. Only
         honoured if it points at a model whose provider key is configured.
      2. First available chat-kind model in catalog order — based on
         which provider keys are set. No hardcoded preference.
      3. ``None`` — no provider keys configured; caller must surface a
         configuration error rather than guess.

    Returns canonical ``"<provider>:<model_id>"`` or ``None``.
    """
    avail = {p.id for p in PROVIDERS if provider_has_key(p, settings)}
    configured = settings.notesci_default_model
    if configured:
        for m in MODELS:
            if m.id == configured and m.provider_id in avail:
                return configured
    for m in MODELS:
        if m.kind == "chat" and m.provider_id in avail:
            return m.id
    return None


def make_chat_model(
    model: str | None = None,
    *,
    cache: bool = False,
    thinking: bool = False,
    structured: type | None = None,
) -> BaseChatModel:
    """Provider-agnostic chat-model factory.

    Example::

        llm = make_chat_model("anthropic:claude-sonnet-4-6", cache=True)

    ``model`` is ``"<provider>:<model_id>"`` (e.g.
    ``"anthropic:claude-sonnet-4-6"``, ``"openai:gpt-4o"``,
    ``"google_genai:gemini-2.0-flash"``). When omitted, falls through
    to :func:`resolve_default_model` — which picks the first available
    model rather than imposing a hardcoded default on users.

    Optional flags gate provider-specific features so the call site
    doesn't have to know which provider it ended up on:

      * ``cache`` — when True, route to the provider's prompt-caching
        path (Anthropic ``prompt-caching-2024-07-31`` beta header).
        Silently ignored for providers that don't support caching.
      * ``thinking`` — when True, enables extended-thinking mode where
        the provider supports it (currently Anthropic).
      * ``structured`` — when set, wraps the returned chat model with
        ``with_structured_output(structured)`` so callers get a Pydantic
        instance back.

    This is the single chokepoint for LLM construction. Adding a
    feature here is preferable to instantiating a provider client
    elsewhere, because every call site benefits at once.
    """
    model_id = model or resolve_default_model()
    if not model_id:
        raise RuntimeError(
            "no chat model available — set at least one of "
            "ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / DEEPSEEK_API_KEY"
        )
    kwargs: dict[str, Any] = {}

    is_anthropic = model_id.startswith("anthropic:")
    is_openai = model_id.startswith("openai:")
    is_google = model_id.startswith("google_genai:") or model_id.startswith("google:")
    is_deepseek = model_id.startswith("deepseek:")

    if cache:
        # Prompt caching, provider-by-provider:
        #   * Anthropic — opt-in beta header. Cache breakpoints are still
        #     set by the caller via message ``cache_control`` blocks; the
        #     header just unlocks the feature.
        #   * OpenAI — automatic for prefixes >=1024 tokens, no flag.
        #   * Google Gemini — explicit context-cache resources; no
        #     equivalent per-request opt-in. No-op here.
        #   * DeepSeek — server-side cache, automatic. No-op.
        if is_anthropic:
            # extra_headers is the canonical LangChain pass-through for
            # Anthropic. default_headers also worked historically but
            # extra_headers is forwarded to every request, not just the
            # client constructor.
            kwargs["extra_headers"] = {
                "anthropic-beta": "prompt-caching-2024-07-31"
            }
    if thinking:
        # Extended thinking — currently Anthropic-only. OpenAI o-series
        # uses reasoning_effort instead; surface that here if/when we
        # ship it.
        if is_anthropic:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": 4096}

    # Silence the lint for unused branch markers — the booleans document
    # the provider matrix even when they don't gate anything yet.
    _ = (is_openai, is_google, is_deepseek)

    llm = init_chat_model(model_id, **kwargs)
    if structured is not None:
        # Provider-agnostic — LangChain dispatches to the right under-
        # the-hood mechanism (Anthropic tools, OpenAI JSON schema, etc.).
        llm = llm.with_structured_output(structured)
    return llm
