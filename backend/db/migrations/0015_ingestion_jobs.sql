-- 0015_ingestion_jobs.sql — Track multi-stage ingestion pipeline.
--
-- After a material is created, a pipeline runs asynchronously:
--   uploaded → extracting_metadata → renaming → chunking → embedding →
--   extracting_concepts → building_links → ready  (or → failed)
--
-- ingestion_jobs   : one row per pipeline run, polled by the UI for progress.
-- material_concepts: concepts extracted from a material (count for ranking).
-- material_links   : wiki-style associations between two materials, computed
--                    from concept overlap on ingest. Symmetric pairs are
--                    stored once with a_id < b_id to keep the table small.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ingestion_stage') THEN
        CREATE TYPE ingestion_stage AS ENUM (
            'uploaded',
            'extracting_metadata',
            'renaming',
            'chunking',
            'embedding',
            'extracting_concepts',
            'building_links',
            'ready',
            'failed'
        );
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stage       ingestion_stage NOT NULL DEFAULT 'uploaded',
    progress    REAL NOT NULL DEFAULT 0.0 CHECK (progress BETWEEN 0.0 AND 1.0),
    note        TEXT,
    error_code  TEXT,
    error_msg   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_material_idx
    ON ingestion_jobs(material_id);
CREATE INDEX IF NOT EXISTS ingestion_jobs_project_stage_idx
    ON ingestion_jobs(project_id, stage);

CREATE TABLE IF NOT EXISTS material_concepts (
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    concept     TEXT NOT NULL,
    count       INT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (material_id, concept)
);

CREATE INDEX IF NOT EXISTS material_concepts_concept_idx
    ON material_concepts(concept);

-- a_id < b_id keeps the pair canonical: a single row covers both
-- directions, and (a, b) PK prevents dupes.
CREATE TABLE IF NOT EXISTS material_links (
    a_id        UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    b_id        UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    weight      REAL NOT NULL DEFAULT 0.0,
    shared      JSONB NOT NULL DEFAULT '[]'::jsonb,
    kind        TEXT NOT NULL DEFAULT 'concept',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (a_id, b_id),
    CHECK (a_id < b_id)
);

CREATE INDEX IF NOT EXISTS material_links_project_idx
    ON material_links(project_id);
CREATE INDEX IF NOT EXISTS material_links_a_idx
    ON material_links(a_id);
CREATE INDEX IF NOT EXISTS material_links_b_idx
    ON material_links(b_id);
