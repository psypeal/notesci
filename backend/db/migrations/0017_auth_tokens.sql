-- 0017_auth_tokens.sql — Personal access tokens (PATs).
--
-- Distinct from ``auth_sessions``: PATs are long-lived, user-named
-- credentials that mirror the dashboard's "Personal access token" row.
-- ``token_hash`` stores sha256(raw) so a DB leak doesn't grant access;
-- the raw token is returned to the user exactly once at creation.
--
-- ``current_member`` accepts either an auth_sessions token OR an
-- auth_tokens token in the ``Authorization: Bearer`` header — we look
-- up sessions first, fall through to tokens on miss.

CREATE TABLE IF NOT EXISTS auth_tokens (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    -- Short display prefix (first 8 chars of the raw token) shown in
    -- the dashboard so the user can recognise which physical token a
    -- row corresponds to without revealing the secret.
    display_prefix TEXT NOT NULL,
    token_hash     BYTEA NOT NULL UNIQUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NULL,
    last_used_at   TIMESTAMPTZ NULL,
    revoked_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS auth_tokens_member_idx
    ON auth_tokens(member_id) WHERE revoked_at IS NULL;
