-- 0002_materials_and_chunks.sql — RAG ingestion targets.
--
-- materials  : one row per ingested artifact (text paste, PDF, URL, etc.)
-- chunks     : split-text + embedding rows used for retrieval
--
-- chunks.embedding is vector(1536) — matches the default embedding model
-- in src/notesci/agent/embeddings.py (openai:text-embedding-3-small).
-- Changing the embedding model to a different dimension means a new
-- migration that ALTERs the column and re-embeds existing rows.

-- The pgvector image (pgvector/pgvector:pg16) preloads the `vector`
-- extension into the default DB, but a vanilla-Postgres / managed-DB
-- restore would not — declare it idempotently so any target works.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE materials (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_type   TEXT NOT NULL
                    CHECK (source_type IN
                          ('text', 'pdf', 'url', 'zotero', 'notion', 'drive', 'readwise')),
    title         TEXT,
    uri           TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX materials_project_idx ON materials(project_id);

CREATE TABLE chunks (
    id            BIGSERIAL PRIMARY KEY,
    material_id   UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    ord           INT NOT NULL,
    text          TEXT NOT NULL,
    embedding     VECTOR(1536),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (material_id, ord)
);

CREATE INDEX chunks_material_idx ON chunks(material_id);
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
