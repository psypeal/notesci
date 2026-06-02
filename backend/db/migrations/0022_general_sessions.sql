-- 0022_general_sessions.sql — Allow sessions without a parent project.
--
-- Until now, every `sessions` row required `project_id`, so all chat
-- history lived inside a project. The new general page (`/` after sign-in)
-- needs a chat surface that isn't tied to any project — the user can
-- promote a thread to a project later, but until then the conversation
-- is just "general."
--
-- Three structural changes, in dependency order:
--   1. ADD `workspace_id` (nullable for backfill, then SET NOT NULL).
--      This denormalizes the workspace association onto sessions so
--      workspace-scoped boundary checks (the project's golden rule:
--      "endpoints join through workspace_id and collapse cross-
--      workspace lookups to a 404") work for both kinds of sessions
--      without forcing a JOIN through projects for general sessions.
--   2. ADD `kind` column with check constraint ('project' | 'general').
--      Existing rows get 'project' from DEFAULT.
--   3. DROP NOT NULL on project_id, then add a consistency CHECK
--      pairing `kind` with `project_id`:
--        - kind='project' MUST have project_id set
--        - kind='general' MUST NOT have project_id set
--      This makes the relationship unambiguous at the schema layer so
--      the application code can trust the discriminator.
--
-- Index on (workspace_id, kind, updated_at DESC) supports the future
-- general-sessions list endpoint (recent general chats per workspace)
-- without a sequential scan as the table grows.

ALTER TABLE sessions
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'
        CHECK (kind IN ('project', 'general'));

-- Backfill workspace_id for existing sessions (all currently belong to
-- a project, so workspace_id comes through that join).
UPDATE sessions
SET workspace_id = projects.workspace_id
FROM projects
WHERE sessions.project_id = projects.id
  AND sessions.workspace_id IS NULL;

ALTER TABLE sessions
    ALTER COLUMN workspace_id SET NOT NULL,
    ALTER COLUMN project_id DROP NOT NULL,
    ADD CONSTRAINT sessions_kind_project_consistency
        CHECK (
            (kind = 'project' AND project_id IS NOT NULL)
            OR (kind = 'general' AND project_id IS NULL)
        );

CREATE INDEX sessions_workspace_kind_idx
    ON sessions (workspace_id, kind, updated_at DESC);
