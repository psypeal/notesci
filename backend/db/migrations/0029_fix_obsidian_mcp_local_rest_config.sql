-- Obsidian catalog fix:
-- Use the community server requested for Notesci:
-- https://github.com/MarkusPfundstein/mcp-obsidian
-- It runs with `uvx mcp-obsidian` and talks to the Obsidian Local REST
-- API plugin through OBSIDIAN_API_KEY, OBSIDIAN_HOST, and OBSIDIAN_PORT.
-- Existing broken installs from earlier recipes are migrated to this
-- runtime shape; users still need to paste their Local REST API key.

UPDATE mcp_servers
   SET config = jsonb_build_object(
         'command', 'uvx',
         'args', jsonb_build_array('mcp-obsidian'),
         'env', jsonb_build_object(
           'OBSIDIAN_API_KEY', COALESCE(config->'env'->>'OBSIDIAN_API_KEY', ''),
           'OBSIDIAN_HOST', COALESCE(config->'env'->>'OBSIDIAN_HOST', '127.0.0.1'),
           'OBSIDIAN_PORT', COALESCE(config->'env'->>'OBSIDIAN_PORT', '27124')
         )
       ),
       updated_at = now()
 WHERE slug = 'obsidian'
   AND transport = 'stdio'
   AND (
     config->>'command' <> 'uvx'
     OR config->'args' <> jsonb_build_array('mcp-obsidian')
     OR config->'env' ? 'OBSIDIAN_VAULT_PATH'
     OR config->'env' ? 'OBSIDIAN_BASE_URL'
   );
