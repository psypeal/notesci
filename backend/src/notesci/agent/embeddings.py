"""Provider-agnostic embedding-model factory.

Mirrors :mod:`notesci.agent.providers` for chat models. Single chokepoint
for embedding-model construction.

The ``chunks.embedding`` column in the schema is sized for
``EMBEDDING_DIM`` (currently 1536, matching OpenAI's
``text-embedding-3-small`` default). Switching to a model with a different
dimension requires a new migration that re-embeds existing rows.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx
from langchain.embeddings import init_embeddings
from langchain_core.embeddings import Embeddings

from ..config import settings
from ..model_catalog import PROVIDERS, provider_has_key

# Locked to match the migration's vector(1536) column. Bump alongside the
# migration if/when the default embedding model changes dimension.
EMBEDDING_DIM = 1536


@dataclass
class CustomEmbeddingConfig:
    enabled: bool = False
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    dimension: int = EMBEDDING_DIM


_custom_config = CustomEmbeddingConfig()


def apply_custom_embedding_config(
    *,
    enabled: bool,
    base_url: str,
    model: str,
    api_key: str,
    dimension: int = EMBEDDING_DIM,
) -> None:
    global _custom_config
    _custom_config = CustomEmbeddingConfig(
        enabled=bool(enabled),
        base_url=(base_url or "").strip(),
        model=(model or "").strip(),
        api_key=(api_key or "").strip(),
        dimension=int(dimension or EMBEDDING_DIM),
    )


class OpenAICompatibleEmbeddings(Embeddings):
    """Small OpenAI-compatible embeddings client for custom endpoints."""

    def __init__(self, *, base_url: str, api_key: str, model: str, dimension: int):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimension = dimension

    def _endpoint(self) -> str:
        if self.base_url.endswith("/embeddings"):
            return self.base_url
        return f"{self.base_url}/embeddings"

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model, "input": texts}
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(self._endpoint(), headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise RuntimeError("custom embedding endpoint returned no data array")
        rows = sorted(rows, key=lambda r: r.get("index", 0) if isinstance(r, dict) else 0)
        vectors = [r.get("embedding") for r in rows if isinstance(r, dict)]
        if len(vectors) != len(texts):
            raise RuntimeError(
                f"custom embedding count mismatch: {len(vectors)} for {len(texts)} inputs"
            )
        for v in vectors:
            if not isinstance(v, list) or len(v) != self.dimension:
                got = len(v) if isinstance(v, list) else "invalid"
                raise RuntimeError(
                    f"custom embedding dimension mismatch: expected {self.dimension}, got {got}"
                )
        return vectors

    async def aembed_query(self, text: str) -> list[float]:
        return (await self.aembed_documents([text]))[0]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return asyncio.run(self.aembed_documents(texts))

    def embed_query(self, text: str) -> list[float]:
        return asyncio.run(self.aembed_query(text))


def _embedding_provider_ready(provider_id: str) -> bool:
    if provider_id == "openai" and settings.notesci_openai_chat_only:
        return False
    for p in PROVIDERS:
        if p.id == provider_id:
            return provider_has_key(p, settings)
    return True


def resolve_embedding_model(model: str | None = None) -> str | None:
    """Return an embedding model that can actually run with current keys."""
    if model:
        provider_id = model.split(":", 1)[0] if ":" in model else model
        return model if _embedding_provider_ready(provider_id) else None

    if (
        _custom_config.enabled
        and _custom_config.base_url
        and _custom_config.model
        and _custom_config.dimension == EMBEDDING_DIM
    ):
        return f"custom:{_custom_config.model}"

    configured = settings.notesci_default_embedding
    provider_id = configured.split(":", 1)[0] if ":" in configured else configured
    if _embedding_provider_ready(provider_id):
        return configured

    # Common desktop setup: user configured Google for chat, but did not
    # edit /etc/notesci/notesci.conf to change the embedding default away
    # from OpenAI. Gemini embeddings can be down-projected to the existing
    # vector(1536) schema, so use them as the safe fallback.
    if _embedding_provider_ready("google_genai"):
        return "google_genai:gemini-embedding-001"

    return None


def make_embedding_model(model: str | None = None) -> Embeddings:
    """Construct an ``Embeddings`` instance.

    ``model`` is ``"<provider>:<model_id>"`` (e.g.
    ``"openai:text-embedding-3-small"``,
    ``"google_genai:gemini-embedding-001"``). Falls back to
    ``settings.notesci_default_embedding``.

    Google's ``gemini-embedding-001`` defaults to 3072-dim output, but
    the ``chunks.embedding`` column is ``vector(1536)`` — so we pin the
    Matryoshka output dimension to ``EMBEDDING_DIM``. Gemini doesn't
    L2-normalize sub-3072 outputs, but that's harmless here: the HNSW
    index uses cosine ops and retrieval queries with ``<=>``, both
    scale-invariant.
    """
    model_id = resolve_embedding_model(model)
    if not model_id:
        raise RuntimeError(
            "no embedding model available — set OPENAI_API_KEY or GOOGLE_API_KEY"
        )
    if model_id.startswith("custom:"):
        return OpenAICompatibleEmbeddings(
            base_url=_custom_config.base_url,
            api_key=_custom_config.api_key,
            model=_custom_config.model,
            dimension=_custom_config.dimension,
        )
    kwargs: dict = {}
    if model_id.startswith("google_genai:") or model_id.startswith("google:"):
        kwargs["output_dimensionality"] = EMBEDDING_DIM
    return init_embeddings(model_id, **kwargs)


def embedding_provider_available(model: str | None = None) -> bool:
    """True when the embedding model's provider has an API key configured.

    The embedding path can't degrade the way chat retrieval can — a
    material with no vectors simply isn't retrievable — so ingest
    endpoints use this as a pre-flight to return a clean, actionable
    error instead of a raw provider-credentials stack trace.

    ``model`` is a canonical ``"<provider>:<model_id>"`` id; defaults to
    ``settings.notesci_default_embedding``.
    """
    model_id = resolve_embedding_model(model)
    if not model_id:
        return False
    provider_id = model_id.split(":", 1)[0] if ":" in model_id else model_id
    return _embedding_provider_ready(provider_id)
