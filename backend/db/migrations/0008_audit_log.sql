-- 0008_audit_log.sql — workspace-scoped activity audit.
--
-- Backs the dashboard's Workspace > Audit log page. Distinct from
-- mcp_call_logs (which is per-tool-invocation telemetry); this is
-- people-and-policy events: who claimed when, who installed which MCP,
-- who sent which invite, etc.
--
-- actor_member_id is nullable so system events (admin workspace
-- bootstrap) have no actor.

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,    -- e.g. 'member.claim', 'invite.send', 'mcp.install'
    target_type     TEXT,             -- e.g. 'invite', 'mcp_server', 'project'
    target_id       TEXT,             -- UUID or other identifier as text
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_workspace_idx ON audit_log(workspace_id, created_at DESC);
CREATE INDEX audit_log_actor_idx     ON audit_log(actor_member_id);
CREATE INDEX audit_log_action_idx    ON audit_log(action);
