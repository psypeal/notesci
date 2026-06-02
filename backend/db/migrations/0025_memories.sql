-- 0025_memories.sql — long-term memory for general + project chats.
--
-- Single table, two scopes:
--   * scope='general'  → project_id IS NULL — bound to the member only.
--   * scope='project'  → project_id NOT NULL — never leaks across projects.
--
-- Three kinds of rows coexist:
--   * 'core'           — one editable markdown blob per scope, pinned in
--                        every system prompt for that scope. Singleton.
--   * 'preference'     — researcher prefs/style (citation style, prose
--                        tone, preferred frameworks).
--   * 'project_fact'   — concrete facts about the project / its corpus
--                        (e.g. "this project investigates HNSW recall").
--   * 'open_question'  — unresolved threads the user is working on.
--   * 'reference'      — pointers ("see Smith 2024 for the baseline").
--
-- All rows but 'core' share one HNSW + GIN-tsvector retrieval path; core
-- is fetched directly by scope and injected verbatim into the system
-- prompt. embedding is vector(1536) to match the existing migration 0002
-- choice (openai:text-embedding-3-small) — changing dim requires a new
-- re-embedding migration, same rule as chunks.
--
-- Status is auto-approved on insert (one open-source single-user app —
-- no human approval queue). archived_at is the tombstone; rows are kept
-- so we can show "superseded by" lineage in the UI.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL
                      CHECK (scope IN ('general', 'project')),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL
                      CHECK (kind IN ('core', 'preference',
                                      'project_fact', 'open_question',
                                      'reference')),
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    embedding       VECTOR(1536),
    tsv             tsvector GENERATED ALWAYS AS
                      (to_tsvector('english',
                                   coalesce(title, '') || ' ' || coalesce(body, '')))
                      STORED,
    source_session  UUID,
    superseded_by   UUID REFERENCES memories(id) ON DELETE SET NULL,
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK ((scope = 'project') = (project_id IS NOT NULL))
);

-- Singleton core block per (member, scope, project). NULLS NOT DISTINCT
-- lets the general scope (project_id IS NULL) collapse to one row too.
CREATE UNIQUE INDEX memories_core_singleton
    ON memories (member_id, scope, project_id)
    NULLS NOT DISTINCT
    WHERE kind = 'core' AND archived_at IS NULL;

-- Retrieval indexes — guard on archived_at so archived rows drop out of
-- search without us having to filter them out again at query time.
CREATE INDEX memories_hnsw
    ON memories USING hnsw (embedding vector_cosine_ops)
    WHERE archived_at IS NULL AND kind <> 'core';

CREATE INDEX memories_tsv
    ON memories USING gin (tsv)
    WHERE archived_at IS NULL AND kind <> 'core';

CREATE INDEX memories_scope_idx
    ON memories (member_id, scope, project_id, kind)
    WHERE archived_at IS NULL;
