-- 0026_memory_sanity.sql — bound the memory layer.
--
-- Three things change:
--   1. Per-turn extraction is retired. A new ``memory_extraction_jobs``
--      queue lets the chat handler enqueue an extraction with O(1) cost;
--      a sweeper picks up jobs whose session has been idle for 10+ min
--      and runs a SINGLE LLM call over the whole conversation. ~95%
--      fewer extraction LLM calls per session in normal use.
--   2. Rows have to earn their keep. ``confidence`` is set at write
--      time (only 'high' rows are persisted); ``last_recalled_at`` is
--      bumped whenever the retriever returns a row, so the LRU archive
--      can age out rows that never pay rent.
--   3. ``memory_extraction_jobs`` is a deliberately tiny table — at
--      most one row per (session, last_message_at). The sweeper marks
--      ``processed_at`` rather than deleting so re-runs are idempotent.

-- ── access tracking on memories ────────────────────────────────────
ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS confidence       TEXT
        CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
    ADD COLUMN IF NOT EXISTS last_recalled_at TIMESTAMPTZ;

-- LRU-archive driver: ORDER BY COALESCE(last_recalled_at, created_at) ASC.
-- A partial index on (member_id, scope, project_id) ordered by that
-- coalesced timestamp would index every row in every scope, so keep
-- it simple — the row counts per scope are bounded (~200) and a seq
-- scan over 200 rows is faster than an index lookup anyway.

-- ── extraction job queue ───────────────────────────────────────────
-- One job row per (session_id) — UPSERT bumps last_message_at on each
-- new turn. The sweeper picks up jobs where:
--     processed_at IS NULL  AND  now() - last_message_at > '10 min'
-- and runs one extraction over the full session transcript.
CREATE TABLE memory_extraction_jobs (
    session_id        UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    member_id         UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    last_message_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at      TIMESTAMPTZ,
    last_processed_message_at TIMESTAMPTZ,
    enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeper's filter: ``processed_at IS NULL OR last_processed_message_at < last_message_at``
-- (i.e. either never processed, or new turns since last extraction).
CREATE INDEX memory_extraction_jobs_pending
    ON memory_extraction_jobs (last_message_at)
    WHERE processed_at IS NULL
       OR last_processed_message_at IS NULL
       OR last_processed_message_at < last_message_at;
