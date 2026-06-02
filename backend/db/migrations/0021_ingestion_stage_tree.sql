-- 0021_ingestion_stage_tree.sql — Add 'building_tree' to ingestion_stage.
--
-- Migration 0020 added the PageIndex tree-build stage to the ingestion
-- pipeline (ingestion_pipeline._stage_tree), but the ingestion_stage
-- enum still only had the seven original stages from 0015. Setting
-- stage='building_tree' on the ingestion_jobs row therefore failed with
-- `invalid input value for enum ingestion_stage: "building_tree"`,
-- causing the whole pipeline to fail AFTER concepts + wiki-links had
-- already been written. That left the material partly enriched and the
-- UI parked on stage=failed even though the early stages succeeded.
--
-- ALTER TYPE … ADD VALUE IF NOT EXISTS is the safe form: it's a no-op
-- if the value already exists (older clusters that were patched by
-- hand, or replays of this migration). Postgres requires ADD VALUE to
-- run outside of an enclosing transaction block — psycopg's default
-- migration runner already opens each .sql file in autocommit mode.

ALTER TYPE ingestion_stage ADD VALUE IF NOT EXISTS 'building_tree';
