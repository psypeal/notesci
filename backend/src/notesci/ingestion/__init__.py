"""Notesci ingestion scripts — port of knowledge-vault's pipeline scripts.

Each module is both **importable** (Python functions used by
``notesci.ingestion_pipeline``) and **runnable** (``python -m
notesci.ingestion.derive_slug ...``) so that operators can
re-run a stage from the CLI without spinning up the FastAPI process.

The split mirrors the knowledge-vault plugin:
  * ``derive_slug``        — bibliographic slug from entity/year/keyword
  * ``extract_metadata``   — PDF-first-page text + heuristic title/year
  * ``build_wiki_links``   — concept-overlap edges between materials
"""
