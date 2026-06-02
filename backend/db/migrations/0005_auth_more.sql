-- 0005_auth_more.sql — waitlist + password-reset + email-verification.
--
-- waitlist_signups: pre-claim signups from the public waitlist screen.
-- password_reset_tokens: 30-minute opaque tokens for the forgot/reset trio.
-- email_verification_tokens: 24-hour opaque tokens for the verify-email flow.
--
-- All token tables store sha256(raw_token); the raw token only ever
-- exists in the email body (or, in dev, the server's stdout log).

CREATE TABLE waitlist_signups (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               TEXT NOT NULL UNIQUE,
    field_of_research   TEXT,
    what_youd_do        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
    token_hash    TEXT PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_member_idx ON password_reset_tokens(member_id);
CREATE INDEX password_reset_tokens_expires_idx ON password_reset_tokens(expires_at);

CREATE TABLE email_verification_tokens (
    token_hash    TEXT PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_member_idx ON email_verification_tokens(member_id);
CREATE INDEX email_verification_tokens_expires_idx ON email_verification_tokens(expires_at);
