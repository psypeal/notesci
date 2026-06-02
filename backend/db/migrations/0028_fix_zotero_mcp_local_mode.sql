-- 0028_fix_zotero_mcp_local_mode.sql
--
-- The curated Zotero MCP entry described a local Zotero 7 connection,
-- but the installed config launched only the CLI root command and did
-- not set ZOTERO_LOCAL=true. Existing installs created from that broken
-- template need to be upgraded in place.

UPDATE mcp_servers
SET
    config = jsonb_set(
        jsonb_set(
            jsonb_set(
                config,
                '{args}',
                '["--from","zotero-mcp-server","zotero-mcp","serve","--transport","stdio"]'::jsonb,
                true
            ),
            '{env}',
            COALESCE(config->'env', '{}'::jsonb),
            true
        ),
        '{env,ZOTERO_LOCAL}',
        '"true"'::jsonb,
        true
    ),
    updated_at = now()
WHERE slug = 'zotero'
  AND transport = 'stdio'
  AND config->>'command' = 'uvx'
  AND config->'args' = '["--from","zotero-mcp-server","zotero-mcp"]'::jsonb
  AND COALESCE(config->'env'->>'ZOTERO_LOCAL', '') = ''
  AND COALESCE(config->'env'->>'ZOTERO_API_KEY', '') = '';
