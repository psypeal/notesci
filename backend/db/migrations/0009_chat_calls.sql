-- chat_calls — per-LLM-invocation telemetry
--
-- One row is written by the agent's call_model node every time the LLM
-- is invoked (initial reply + each tool-loop continuation). Captures
-- model attribution, latency, retrieval scope, and provider-reported
-- token counts for cost attribution. Failures to insert are swallowed
-- in the agent so this never breaks the chat path.
--
-- input_tokens / output_tokens / total_tokens are nullable because not
-- every provider surfaces usage on every call (streaming chunks, tool
-- continuations, older SDKs).

CREATE TABLE chat_calls (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER,
  duration_ms     INTEGER NOT NULL,
  retrieved_count INTEGER NOT NULL DEFAULT 0,
  had_tools       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_calls_session_idx ON chat_calls (session_id, created_at DESC);
CREATE INDEX chat_calls_member_idx  ON chat_calls (member_id, created_at DESC);
CREATE INDEX chat_calls_model_idx   ON chat_calls (model, created_at DESC);
