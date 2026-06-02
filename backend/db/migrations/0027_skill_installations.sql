-- 0027_skill_installations.sql — per-workspace installed skills.
--
-- Skills were previously treated as always-on prompts. This table lets
-- users install only what a workspace actually needs, reducing context
-- footprint and preventing accidental activation when a prompt accidentally
-- matches unused domains.

CREATE TABLE workspace_skill_installations (
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installed_by  UUID REFERENCES members(id) ON DELETE SET NULL,
    skill_name    TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, skill_name)
);

CREATE INDEX workspace_skill_installations_workspace_idx
    ON workspace_skill_installations(workspace_id);

CREATE INDEX workspace_skill_installations_workspace_enabled_idx
    ON workspace_skill_installations(workspace_id, enabled);

CREATE OR REPLACE FUNCTION touch_workspace_skill_installations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_skill_installations_touch_updated_at
BEFORE UPDATE ON workspace_skill_installations
FOR EACH ROW
EXECUTE FUNCTION touch_workspace_skill_installations_updated_at();

-- Preinstall the shipped built-in skills so existing workspaces keep
-- previous behavior while gaining the new install-state controls.
INSERT INTO workspace_skill_installations (workspace_id, skill_name, enabled)
SELECT w.id, s.skill_name, TRUE
FROM workspaces AS w
CROSS JOIN (VALUES
    ('content-research-writer'),
    ('scientific-slides'),
    ('writing-clearly-and-concisely')
) AS s(skill_name)
ON CONFLICT DO NOTHING;
