-- Compounding-knowledge support: dedup + lineage + strength rating for
-- chat-filed materials.
--
-- 1. Index on the dedup hash stored under `metadata.filed_content_hash`
--    so the ingest endpoint can probe "has this exact answer already
--    been filed in this project?" in O(log n) instead of a seq scan.
--
-- 2. Index on the connection-strength tag so the project Map view can
--    cheaply filter out weak ("logically inferred, not in sources")
--    filings by default — the vault spec quarantines them from the
--    graph until confirmed by a future source.
--
-- 3. material_lineage records a DIRECTED edge from a cited source to
--    the filed material that derived from it. Symmetric with
--    material_links (concept-bridge edges) but separately tabled
--    because lineage is one-way and carries session/turn context. Used
--    by future graph views (e.g. a "derived from" lens) and by the
--    audit log when a filed answer is later promoted to strong.
CREATE INDEX IF NOT EXISTS materials_filed_hash_idx
  ON materials(project_id, (metadata->>'filed_content_hash'))
  WHERE metadata ? 'filed_content_hash';

CREATE INDEX IF NOT EXISTS materials_strength_idx
  ON materials((metadata->>'connection_strength'))
  WHERE metadata ? 'connection_strength';

CREATE TABLE IF NOT EXISTS material_lineage (
    source_id   UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    filed_id    UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
    session_id  UUID,
    turn_seq    INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, filed_id),
    CHECK (source_id <> filed_id)
);
CREATE INDEX IF NOT EXISTS material_lineage_filed_idx
  ON material_lineage(filed_id);
CREATE INDEX IF NOT EXISTS material_lineage_project_idx
  ON material_lineage(project_id);
