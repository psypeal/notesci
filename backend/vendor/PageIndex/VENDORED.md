# Vendored PageIndex (notesci fork)

Pinned, stripped-down copy of [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) used by notesci to build per-PDF hierarchical tree indices ("table-of-contents") for reasoning-based retrieval.

- **Upstream commit**: `dcda5656ba270cc30caaa9486a450d639e1d2081`
- **Upstream license**: MIT (see `LICENSE`)

## What was kept

- `pageindex/__init__.py` (trimmed — see modifications)
- `pageindex/page_index.py` (PDF tree builder, untouched)
- `pageindex/retrieve.py` (helpers for tree → section text)
- `pageindex/utils.py` (forked — see modifications)
- `pageindex/config.yaml` (defaults; routed via notesci providers)
- `LICENSE`

## What was stripped

- `pageindex/page_index_md.py` — markdown tree builder. notesci's ingest is PDF-first; markdown trees can be re-added later.
- `pageindex/client.py` — CLI wrapper. notesci has its own service layer (`backend/src/notesci/pagetree.py`).
- `run_pageindex.py` — CLI entry. Not used.
- `requirements.txt` — replaced by entries in `backend/pyproject.toml` (PyPDF2 + tiktoken; litellm and pymupdf are NOT added).
- `cookbook/`, `examples/`, `.github/`, `.claude/` — demo material, ~50 MB.

## Local modifications

All modifications live in `pageindex/utils.py` and `pageindex/__init__.py`. They follow a single rule: the vendored code must NOT import `litellm`, `pymupdf`, or `dotenv` at module-load time. Every LLM call goes through a pluggable backend that notesci wires to `make_chat_model()` (the multi-provider chokepoint per CLAUDE.md).

1. **`pageindex/utils.py`** — removed `import litellm`, `import pymupdf`, `from dotenv import load_dotenv`. Added a `_LLMBackend` registry and `configure_backend(...)` function. `llm_completion`, `llm_acompletion`, and `count_tokens` now call the registered backend (raising a clear `RuntimeError` if `configure_backend()` was never called). `get_page_tokens` defaults to PyPDF2; the PyMuPDF branch raises a clear error if PyMuPDF wasn't installed. Also: `import re` was added (upstream omits it but `get_first_start_page_from_text` / `get_last_start_page_from_text` reference it — latent NameError in dead code). `import PyPDF2` replaced by `import pypdf as PyPDF2` since notesci pins pypdf>=5.0, the renamed/maintained successor of PyPDF2. Retry budget in `llm_completion` / `llm_acompletion` reduced from 10 → 5 because notesci's `make_chat_model` already has its own retry surface and 10×LLM retries per prompt was excessive.

2. **`pageindex/__init__.py`** — dropped imports of the stripped modules (`page_index_md`, `client`). Only `page_index` and `retrieve` surfaces are re-exported.

3. **`pageindex/retrieve.py`** — same `import pypdf as PyPDF2` swap as `utils.py`. No other changes.

4. **Runtime patches in `backend/src/notesci/pagetree.py`** (not in this directory, but worth noting here so it surfaces during upstream sync): `JsonLogger` in both `pageindex.utils` and `pageindex.page_index` is overwritten with a `_NullJsonLogger` no-op so PageIndex builds don't write `./logs/<pdfname>_<ts>.json` to the container CWD (PII spillage + disk-fill risk). If a future upstream restructures the logger module path, re-check the monkey-patch targets.

## Updating from upstream

```bash
cd /tmp
git clone --depth 1 https://github.com/VectifyAI/PageIndex.git pi
# Diff against current vendored files to spot upstream drift:
diff -u pi/pageindex/page_index.py /path/to/backend/vendor/PageIndex/pageindex/page_index.py
# `page_index.py` and `retrieve.py` should pull cleanly.
# `utils.py` carries our LLM-backend hook — re-apply the modifications
# after pulling, OR keep the upstream file as `utils_upstream.py` and
# merge selectively. `__init__.py` must keep the trimmed re-exports.
```
