-- materials.original_bytes — retain the raw uploaded source bytes
--
-- Currently used by the PDF ingest path so the reader pane can render
-- the actual file (not just the extracted text). URL ingests don't fill
-- this column — the source is still live on the web.
--
-- Beta-stage trade-off: we store bytes inline in Postgres rather than
-- offloading to S3/object storage. With the 50MB-per-file cap and
-- modest beta corpus sizes this is fine; migration to object storage
-- is straightforward when corpus growth or replication overhead
-- justifies it (the column would become a stable identifier instead).
--
-- TOAST handles compression + out-of-line storage automatically for
-- byte columns of this size, so reads of metadata-only queries stay
-- cheap.

ALTER TABLE materials ADD COLUMN original_bytes BYTEA;
ALTER TABLE materials ADD COLUMN original_mime  TEXT;
