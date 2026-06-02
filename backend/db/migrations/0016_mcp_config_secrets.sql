-- 0016_mcp_config_secrets.sql — Encrypt-at-rest column for MCP secrets.
--
-- The existing ``config`` jsonb column is left in place for the legacy
-- rows; new writes encrypt the ``headers`` and ``env`` sub-fields via
-- ``crypto.encrypt_config_secrets`` and store them inline under the
-- same jsonb path (each value prefixed with ``fernet:``). The
-- ``config_encrypted`` raw bytea column below is reserved for a future
-- migration that promotes the entire config blob into a single
-- encrypted ciphertext — kept NULL for now so we can ship the
-- header-level encryption without touching every existing row.

ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS config_encrypted BYTEA NULL;
