-- 0004_mcp.sql — MCP marketplace install records + call audit log.
--
-- mcp_servers: one row per (workspace, marketplace slug). Backs the
--              dashboard's "Connections · MCP marketplace" centerpiece —
--              specifically the "Installed MCPs" page with per-server
--              config + grant scope.
-- mcp_call_logs: audit trail of tool invocations the agent makes via
--              installed servers. Backs the per-server call-log surface
--              from the dashboard.
--
-- The actual MCP-client wiring into the LangGraph agent (i.e. invoking
-- tools defined by these servers) is intentionally NOT in this migration
-- — it lives in the agent layer in a later slice.

CREATE TABLE mcp_servers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installed_by  UUID REFERENCES members(id) ON DELETE SET NULL,
    slug          TEXT NOT NULL,    -- marketplace slug (e.g. "github", "drive")
    name          TEXT NOT NULL,    -- workspace-visible friendly name
    transport     TEXT NOT NULL
                    CHECK (transport IN ('http', 'stdio', 'sse')),
    -- transport-specific connection details: {url, command, args, env_keys}.
    -- TODO before GA: secret values must be encrypted at rest with a KMS
    -- key, not stored in jsonb. For the invite-only beta we trust members.
    config        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- scope grant from the install modal:
    --   {tools: [tool_name,...], allowAll: bool, deniedTools: [...]}
    grants        JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
);

CREATE INDEX mcp_servers_workspace_idx ON mcp_servers(workspace_id);

CREATE TABLE mcp_call_logs (
    id              BIGSERIAL PRIMARY KEY,
    server_id       UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
    session_id      UUID REFERENCES sessions(id) ON DELETE SET NULL,
    tool_name       TEXT NOT NULL,
    arguments       JSONB,
    result_summary  TEXT,           -- short string; full result is not retained
    error           TEXT,           -- non-null on failure
    duration_ms     INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mcp_call_logs_server_idx ON mcp_call_logs(server_id, created_at DESC);
CREATE INDEX mcp_call_logs_member_idx ON mcp_call_logs(member_id);
