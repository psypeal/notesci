-- 0023_provider_keys.sql — per-workspace LLM provider API keys.
--
-- Stores fernet-encrypted API keys for the four supported providers
-- (anthropic, openai, google_genai, deepseek) so the desktop user can
-- paste them through the Settings UI instead of hand-editing
-- /etc/notesci/notesci.conf. Keys override the env-var fallback in
-- providers.py — see the loader hook in main.py lifespan.
--
-- One row per (workspace_id, provider). The encrypted_key column holds
-- the output of crypto.encrypt_str (fernet:base64 ciphertext, or
-- plaintext when NOTESCI_SECRET_KEY is unset — same convention used by
-- mcp_servers.config).

CREATE TABLE IF NOT EXISTS provider_keys (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    encrypted_key   TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, provider)
);
