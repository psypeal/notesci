-- drafts — server-backed long-form writing surface
--
-- One draft per (project, member). The Drafter pane in the workspace
-- writes here on a debounce so the surface survives reload, multi-tab,
-- and device switches. Body is plain text for now (Markdown
-- conventions). Drafts inherit the project's workspace via FK chain;
-- API endpoints scope by member_id so drafts stay private to the
-- author. Collaborative editing (CRDT, presence) is out of scope for
-- the beta.
--
-- The unique constraint makes the API a clean upsert (PUT
-- /projects/{id}/draft) instead of a list-then-pick. If we later want
-- multiple drafts per project per member we drop the constraint and
-- add a `slug` discriminator.

CREATE TABLE drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, member_id)
);

CREATE INDEX drafts_project_member_idx ON drafts (project_id, member_id);
CREATE INDEX drafts_member_updated_idx ON drafts (member_id, updated_at DESC);
