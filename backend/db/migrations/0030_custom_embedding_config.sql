-- 0030_custom_embedding_config.sql — per-workspace custom embedding endpoint.
--
-- Custom embeddings are OpenAI-compatible `/embeddings` endpoints. The
-- dimension is intentionally fixed to 1536 because chunks.embedding and
-- memories.embedding are vector(1536); accepting arbitrary dimensions would
-- require a re-embedding migration.

CREATE TABLE IF NOT EXISTS workspace_embedding_config (
    workspace_id       UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    enabled            BOOLEAN NOT NULL DEFAULT FALSE,
    base_url           TEXT NOT NULL DEFAULT '',
    model              TEXT NOT NULL DEFAULT '',
    encrypted_api_key  TEXT NOT NULL DEFAULT '',
    dimension          INTEGER NOT NULL DEFAULT 1536 CHECK (dimension = 1536),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
