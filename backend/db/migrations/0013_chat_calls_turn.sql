-- Add turn_seq to chat_calls so we can attribute each row to a specific
-- assistant turn (used by /threads/{id}/messages to surface the model
-- name beneath each AI bubble in the workspace UI).
--
-- turn_seq is the 0-indexed turn number = (number of human messages) - 1
-- at the time the model is invoked. NULL for legacy rows written before
-- this migration (they remain useful for aggregate cost analytics but
-- can't be attributed to a specific bubble).

ALTER TABLE chat_calls ADD COLUMN turn_seq INTEGER;

CREATE INDEX chat_calls_session_turn_idx
  ON chat_calls (session_id, turn_seq);
