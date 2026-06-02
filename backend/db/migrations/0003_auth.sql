-- 0003_auth.sql — password auth + opaque session tokens.
--
-- Members get an argon2 password_hash. Session tokens are opaque random
-- strings; we store sha256(token) so a DB leak does not grant access.
-- The Authorization header carries the raw token; the auth layer hashes
-- it on lookup.

ALTER TABLE members ADD COLUMN password_hash TEXT;

CREATE TABLE auth_sessions (
    token_hash    TEXT PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_member_idx ON auth_sessions(member_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions(expires_at);
