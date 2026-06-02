-- 0001_init.sql — base multi-tenant schema for notesci
--
-- Tables: workspaces, members, invites, projects, sessions.
-- LangGraph checkpointer tables (checkpoints, checkpoint_blobs,
-- checkpoint_writes, checkpoint_migrations) are managed separately by
-- langgraph-checkpoint-postgres and are NOT part of this migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE members (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    display_name        TEXT,
    affiliation         TEXT,
    orcid               TEXT,
    field_of_research   TEXT,
    topics              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    role                TEXT NOT NULL DEFAULT 'member'
                          CHECK (role IN ('member', 'admin')),
    email_verified_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, email)
);

CREATE INDEX members_workspace_idx ON members(workspace_id);

-- Invite codes follow the design-handoff "NS-XXXX-XXXX" format. Each
-- member is allocated 3 codes (post-onboarding screen and in-workspace
-- modal both use 3, locked May 2026). Unclaimed codes return to pool
-- after 14 days; we model that by setting expires_at on send and
-- letting a sweeper flip status to 'expired'.
CREATE TABLE invites (
    code                  TEXT PRIMARY KEY,
    workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issuer_member_id      UUID REFERENCES members(id) ON DELETE SET NULL,
    status                TEXT NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available', 'sent', 'claimed', 'expired')),
    sent_to_email         TEXT,
    sent_at               TIMESTAMPTZ,
    claimed_by_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    claimed_at            TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invites_issuer_idx ON invites(issuer_member_id);
CREATE INDEX invites_status_idx ON invites(status) WHERE status IN ('available', 'sent');
CREATE INDEX invites_workspace_idx ON invites(workspace_id);

CREATE TABLE projects (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    name                  TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_workspace_idx ON projects(workspace_id);

-- A session.id will be used as the LangGraph checkpointer thread_id once
-- /chat is wired through the auth/session layer. Until then /chat
-- accepts arbitrary thread_id strings.
CREATE TABLE sessions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    title                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_project_idx ON sessions(project_id);
