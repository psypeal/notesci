-- PageIndex tree-index storage.
--
-- One row per material that has had a hierarchical "table-of-contents"
-- tree built by PageIndex (vendored under backend/vendor/PageIndex/).
-- Stored alongside the vector index so the chat retriever can switch
-- between modes (vector kNN vs. reasoning-based tree-walk) on a per-
-- request basis without re-ingesting.
--
-- ``tree`` shape (PageIndex output, JSONB):
--   {
--     "doc_name": str,
--     "doc_description": str,
--     "structure": [ {node_id, title, start_index, end_index, summary,
--                     text, nodes: [...]}, ... ]
--   }
--
-- status:
--   * 'pending'  — queued / building (set by the pipeline before the
--                  LLM round-trips fire)
--   * 'ready'    — build succeeded and ``tree`` is populated
--   * 'failed'   — build raised; ``error`` carries the truncated message,
--                  retrieval falls back to vector for this material
--   * 'skipped'  — material too large (> notesci_pagetree_max_pages), or
--                  not a PDF; not retried automatically
--
-- The 1:1 FK with materials cascades on delete so removing a material
-- cleans its tree row in the same workspace-bounded cascade as chunks.

CREATE TABLE IF NOT EXISTS material_trees (
    material_id   UUID PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'ready', 'failed', 'skipped')),
    tree          JSONB,
    error         TEXT,
    model         TEXT,
    page_count    INTEGER,
    node_count    INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For "show me all trees ready in this project" lookups (e.g. the chat
-- retrieval picking tree-eligible materials).
CREATE INDEX IF NOT EXISTS material_trees_project_status_idx
  ON material_trees(project_id, status);
