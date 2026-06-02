-- 0018_indexes.sql — Indexes for graph + bibtex JOIN paths.
--
-- ``message_citations(material_id)`` is hit by:
--   * ``/projects/{id}/bibtex`` — collects distinct material_ids that
--     have at least one citation in the project's sessions
--   * Concept / reasoning graph builders that filter citations by
--     material
-- Without an explicit index Postgres has to seq-scan
-- ``message_citations`` for the material-side join, which gets slow
-- once the table tops a few thousand rows.
--
-- ``material_concepts(material_id)`` is already covered by the
-- compound PRIMARY KEY ``(material_id, concept)`` (the leftmost-column
-- rule makes the PK serve as an index for ``WHERE material_id=…``
-- queries), so no extra index is added here.

CREATE INDEX IF NOT EXISTS message_citations_material_idx
    ON message_citations(material_id);
