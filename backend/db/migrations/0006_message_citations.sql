-- 0006_message_citations.sql — citation index for the graph lens.
--
-- After each /chat turn, the handler parses [N] markers from the AI reply
-- and looks them up against the turn's retrieved chunks. Each marker the
-- model used produces a row here. Backs the workspace graph pane's
-- "Citations" mode: edges are (assistant_turn -> chunk -> material).
--
-- turn_seq is 0-indexed and counted as (number of human messages in the
-- thread - 1) at write time. Multiple markers on the same turn produce
-- multiple rows.

CREATE TABLE message_citations (
    id            BIGSERIAL PRIMARY KEY,
    session_id    UUID   NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_seq      INT    NOT NULL,
    marker_n      INT    NOT NULL,
    chunk_id      BIGINT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    material_id   UUID   NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, turn_seq, marker_n)
);

CREATE INDEX message_citations_session_idx
    ON message_citations(session_id, turn_seq);
CREATE INDEX message_citations_chunk_idx
    ON message_citations(chunk_id);
