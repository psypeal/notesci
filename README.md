# notesci

notesci is an open-source, local-first research workspace for reading,
organizing, and writing with your own scientific materials.

It combines a desktop app, a FastAPI backend, Postgres/pgvector retrieval,
multi-provider chat models, local file ingestion, citations, MCP tools, and a
curated marketplace for skills, plugins, and MCP servers.

## Download

Installers are published on GitHub Releases:

https://github.com/psypeal/notesci/releases/tag/v0.1.0

Current packages:

| Platform | Package |
|---|---|
| Ubuntu / Debian | `.deb` |
| Fedora / RPM Linux | `.rpm` |
| macOS Apple Silicon | `.dmg` |
| Windows x64 | `.exe` NSIS installer |

The Linux AppImage build is still treated as best-effort. Use the `.deb` or
`.rpm` packages for local testing today.

## What notesci does

- Ingest PDFs, text, web pages, and project materials into a private research
  library.
- Chat with your uploaded sources using retrieval-grounded answers and
  citations.
- Browse internal source citations and external web sources from the chat UI.
- Use multiple model providers: Anthropic, OpenAI, Google, and DeepSeek.
- Configure custom chat and embedding providers where supported.
- Install curated MCP servers, plugins, and skills through a marketplace-style
  interface.
- Use local MCP integrations such as Zotero and Obsidian when configured.
- Draft and polish long-form research writing with a multi-stage workflow.

## Project status

notesci is early-stage open-source software. The v0.1.0 packages are intended
for local testing and feedback, not production-critical research workflows.

Known rough edges:

- Some backend tests and lint checks are currently advisory while older
  invite-era tests are updated.
- Code signing is not configured yet, so macOS and Windows may show unsigned
  app warnings.
- AppImage packaging is not the primary Linux distribution path yet.

## Architecture

| Area | Stack |
|---|---|
| Desktop shell | Tauri |
| Frontend | React, TypeScript, Vite |
| Backend | Python, FastAPI |
| Agent runtime | LangGraph, LangChain |
| Storage | Postgres, pgvector |
| Retrieval | chunked project materials + configurable embedding model |
| Integrations | MCP servers, local plugin/skill marketplace |

The desktop packages bundle the app shell and required runtime resources. The
Linux `.deb` package uses system Postgres dependencies; cross-platform bundles
embed more runtime components for one-click local testing.

## Repository layout

| Path | Purpose |
|---|---|
| `backend/` | FastAPI API, migrations, retrieval, chat agent, MCP host |
| `frontend/` | React workspace, chat UI, reader, marketplace, settings |
| `desktop/src-tauri/` | Tauri desktop app and installer configuration |
| `packaging/` | Linux/macOS/Windows packaging helpers |
| `landing/` | Static project landing page |
| `.github/workflows/` | CI and release packaging workflows |

More detailed implementation notes live in:

- `backend/README.md`
- `frontend/README.md`
- `packaging/cross-platform.md`
- `landing/README.md`

## Local development

Backend:

```bash
cd backend
uv sync
cp .env.example .env
uv run fastapi dev src/notesci/main.py
```

Frontend:

```bash
cd frontend
pnpm install
pnpm dev
```

Desktop:

```bash
cd desktop/src-tauri
cargo tauri dev
```

For local retrieval and ingestion, configure Postgres with pgvector and set the
required provider keys in the backend environment.

## Release process

Release packages are built by `.github/workflows/release.yml`.

The current public release is:

```text
v0.1.0
```

The workflow builds:

- Linux `.deb` and `.rpm`
- macOS `.dmg`
- Windows `.exe`

Tagging `v*` starts a release build and attaches produced artifacts to the
matching GitHub Release.

## License

This project is open source. See the repository license file for terms.
