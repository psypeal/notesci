-- draft_workflows — multi-stage agentic pipeline that turns a draft +
-- a user prompt into reviewed, fact-grounded prose
--
-- Stages (linear, but the orchestrator can loop revising→drafting):
--   interviewing       — collecting structure / word count / panel config
--   gathering_materials — top-k retrieval over project chunks; web search
--                         when chunk count < target, results are ingested
--                         back into the project so the graph view reflects them
--   drafting           — agent invokes the content-research-writer skill
--   polishing          — agent invokes writing-clearly-and-concisely
--   reviewing          — parallel expert-panel reviewers vote APPROVE / REVISE
--   revising           — at least one reviewer requested changes; loop back
--                        to drafting with structured feedback
--   approved           — all panel members APPROVED, content frozen
--   failed             — max_iterations reached, or unrecoverable error
--   cancelled          — user cancelled
--
-- One active workflow per draft is the norm; if a user re-runs we mark
-- the prior workflow `cancelled` and create a new one. The frontend
-- streams progress via SSE; the row holds the latest state for refresh.
--
-- `interview` jsonb captures the pre-flight answers (paragraph structure,
-- word_count target, panel personas, web_search budget, etc.) so the
-- entire run is replayable from the row.
--
-- `events` jsonb is a chronological log of every state transition,
-- agent message excerpt, and reviewer vote — backs the workflow timeline
-- in the UI without needing a separate table for now.

CREATE TABLE draft_workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  interview       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL CHECK (status IN (
    'interviewing','gathering_materials','drafting','polishing',
    'reviewing','revising','approved','failed','cancelled'
  )),
  iteration       INTEGER NOT NULL DEFAULT 0,
  max_iterations  INTEGER NOT NULL DEFAULT 5,
  raw_content     TEXT,
  polished_content TEXT,
  final_content   TEXT,
  panel_votes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  events          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX draft_workflows_draft_idx   ON draft_workflows (draft_id, created_at DESC);
CREATE INDEX draft_workflows_member_idx  ON draft_workflows (member_id, created_at DESC);
CREATE INDEX draft_workflows_status_idx  ON draft_workflows (status) WHERE status IN ('interviewing','gathering_materials','drafting','polishing','reviewing','revising');
