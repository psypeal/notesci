-- Multiple drafts per (project, member).
--
-- The previous schema enforced UNIQUE (project_id, member_id), making
-- `drafts` an upsert surface for a single per-project document. The
-- Draft mode in the workspace now functions as a small library: chat
-- sessions can save AI replies as new drafts, and users can compose
-- ad-hoc quick notes. Drop the constraint and add a tiny convenience
-- index for sorting "the most-recently-touched draft in this project."
--
-- Existing rows continue to function: they're still keyed by id, and
-- the (project_id, member_id) lookup that used to read the singleton
-- now picks the most-recently-updated row (see /projects/{id}/draft
-- in main.py for the backward-compat shim).

ALTER TABLE drafts DROP CONSTRAINT drafts_project_id_member_id_key;

CREATE INDEX drafts_project_updated_idx
  ON drafts (project_id, member_id, updated_at DESC);
