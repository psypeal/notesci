-- 0007_rate_limits.sql — sliding-window per-IP rate limit buckets.
--
-- Backs auth-endpoint rate limiting. Postgres-only so we don't need a
-- Redis dep for the invite-only beta. The bucket_key is opaque
-- ("<endpoint>:<ip>") and the (count, window_start) pair is updated
-- transactionally per request.
--
-- For multi-worker / production we'd want a faster store (Redis) and a
-- cleanup job for stale buckets. Acceptable for the beta.

CREATE TABLE rate_limits (
    bucket_key    TEXT PRIMARY KEY,
    count         INT NOT NULL DEFAULT 0,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT now()
);
