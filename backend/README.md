# notesci backend

Python + FastAPI + LangGraph + Postgres/pgvector. Multi-provider LLM
support via LangChain's `init_chat_model`. See the project root
`CLAUDE.md` for stack rationale and locked decisions.

## Run it

```bash
# 1. Postgres + pgvector
docker compose up -d

# 2. Python deps (uv recommended)
uv sync

# 3. Configure
cp .env.example .env
# edit .env — set DATABASE_URL, NOTESCI_ADMIN_TOKEN, and at least one
# provider key (OPENAI_API_KEY is also needed for embeddings)

# 4. Run the API
uv run fastapi dev src/notesci/main.py
```

Live API docs at `http://localhost:8000/docs` (Swagger UI). The
authoritative endpoint reference is the OpenAPI spec; this README
just captures the conventions and what's wired beyond the spec.

```bash
# Health
curl http://localhost:8000/health

# Bootstrap a workspace + invite codes (admin-only)
curl -X POST http://localhost:8000/admin/workspaces \
  -H "X-Admin-Token: $NOTESCI_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"founders","name":"Founders","bootstrap_invites":3}'
```

## Tests

```bash
uv run pytest tests/             # 49 passing
```

Tests share the dev Postgres at `DATABASE_URL` and bootstrap their own
workspaces via the admin endpoint. Rate limits are disabled in tests
via `NOTESCI_DISABLE_RATE_LIMITS=true` (set automatically by
`tests/conftest.py`).

## Layout

```
backend/
├── Dockerfile, docker-compose.yml
├── db/migrations/                  applied lexically on startup
├── src/notesci/
│   ├── main.py                     FastAPI app + lifespan + every route
│   ├── config.py                   Pydantic settings (.env)
│   ├── db.py                       psycopg async pool + pgvector
│   ├── migrate.py                  in-house SQL migrator
│   ├── auth.py, sweeper.py, ratelimit.py, audit.py
│   ├── email_sender.py             Log + SMTP backends, 3 templates
│   ├── ingest.py                   text → chunks → embeddings
│   ├── citations.py, concepts.py   BibTeX + concept extraction
│   ├── skills.py                   Proprietary intent router
│   ├── mcp_catalog.py              Curated MCP marketplace catalog
│   ├── model_catalog.py            Canonical chat-model + provider catalog
│   ├── draft_workflow.py           Multi-stage drafting pipeline
│   └── agent/
│       ├── providers.py            chat-model factory (init_chat_model)
│       ├── embeddings.py           embedding-model factory
│       ├── messages.py             content-block extraction (handles reasoning models)
│       ├── graph.py                LangGraph: retrieve → call_model ↔ tools
│       └── mcp_tools.py            workspace MCP tool loader (cached)
└── tests/                          pytest-asyncio + httpx ASGITransport
```

### Adding a migration

Drop a file at `backend/db/migrations/NNNN_<slug>.sql` (zero-padded,
ordered lexically). Applied on next startup. The LangGraph
checkpointer's tables are managed separately via `saver.setup()`.

Migrations to date:

| # | File | What |
|---|------|------|
| 0001 | `init.sql` | workspaces / members / invites / projects / sessions |
| 0002 | `materials_and_chunks.sql` | materials + `chunks(embedding vector(1536))` + HNSW idx |
| 0003 | `auth.sql` | `members.password_hash` + `auth_sessions` |
| 0004 | `mcp.sql` | `mcp_servers` + `mcp_call_logs` |
| 0005 | `auth_more.sql` | `waitlist_signups`, reset/verify token tables |
| 0006 | `message_citations.sql` | per-turn citation refs (graph pane) |
| 0007 | `rate_limits.sql` | per-IP sliding-window limiter |
| 0008 | `audit_log.sql` | workspace activity feed |
| 0009 | `chat_calls.sql` | per-LLM-invocation telemetry |
| 0010 | `material_bytes.sql` | retain original bytes (PDF reader) |
| 0011 | `drafts.sql` | server-backed long-form drafts |
| 0012 | `draft_workflows.sql` | multi-stage drafting pipeline state |
| 0013 | `chat_calls_turn.sql` | `chat_calls.turn_seq` for per-bubble model attribution |

## What's wired

### Auth + sessions

- Public: `/auth/waitlist`, `/auth/claim` (NS-XXXX-XXXX, case-insensitive),
  `/auth/signin`, `/auth/forgot-password`, `/auth/reset-password`,
  `/invites/{code}/lookup`.
- Auth-gated: `/auth/signout`, `/me`, `PATCH /me`,
  `/auth/verify-email/{request,confirm}`.
- Rate-limited per IP (signin/claim 10/min, forgot/waitlist 5/min) →
  429 `rate_limited` + `Retry-After: 60`.
- Argon2id passwords, opaque 256-bit session tokens stored as sha256,
  30-day TTL. Typed error codes: `invalid_code`, `code_claimed`,
  `code_expired`, `email_in_use`, `invalid_credentials`,
  `invalid_or_expired_token`, `ambiguous_email`.
- On claim: the first member of a workspace becomes its `admin`; later
  claimers are `member`. 3 invite codes are auto-allocated per claim —
  invite-only growth is core to the product; the Invite page surfaces
  them so a member can bring in new users.

### Workspace + invites + audit

> `/invites*` is surfaced in the UI (the Invite page — every member's
> 3-code allotment). `/members` is intact but **not surfaced** — the
> Members dashboard section was retired when notesci was scoped to a
> personal knowledge base (a workspace is private, not a shared team).

- `/projects` CRUD, `/projects/{id}/{sessions,materials,draft,map}`,
  `/members`.
- Invites: `/invites` (own allotment with status sweep),
  `/invites/{code}/send` (assign recipient + 14-day TTL).
- Audit log: `/audit?action=&actor_member_id=&limit=&offset=`.
- Workspace-scoping codes collapse 404 + 403 to `project_not_found` /
  `thread_not_found` / `material_not_found` / `draft_not_found` so we
  don't leak cross-workspace IDs.

### Materials ingestion

- `/materials/ingest` (text), `/materials/ingest-url` (httpx +
  trafilatura, SSRF-guarded; arXiv URLs route to PDF + parallel
  arXiv export-API metadata fetch), `/materials/ingest-pdf`
  (multipart, 50 MB cap, magic-byte check, pypdf extraction off-loop).
- **PDF bytes are retained** since migration 0010 — `/materials/{id}/file`
  serves them with `Content-Type: application/pdf` for the inline
  pdf.js reader.
- All ingest paths chunk via `RecursiveCharacterTextSplitter`
  (1000/150 overlap), embed via the configured embedding model
  (`openai:text-embedding-3-small`, 1536 dim — fixed by migration
  0002), and write a `materials` row + N `chunks` rows.

### Drafts

- `/projects/{id}/draft` GET (own draft, returns null if absent),
  PUT (upsert; idempotent via unique `(project_id, member_id)`).
- One draft per (project, member). notesci is single-user, so in
  practice that's one draft per project; collaborative editing is not a
  goal of the product.

### Drafting workflow (multi-stage agentic pipeline)

- `POST /drafts/{id}/workflow` starts a fire-and-forget background
  task that runs **gather_materials → drafting → polishing →
  reviewing → revising → approved/failed/cancelled**.
- Stages:
  - **gather_materials**: top-k retrieval over project chunks; if
    insufficient, logs a `web_search_planned` event (real MCP
    web-search dispatch is queued for the next iteration).
  - **drafting**: LLM with the **content-research-writer** skill brief.
  - **polishing**: LLM with the **writing-clearly-and-concisely** brief.
  - **reviewing**: parallel LLM panel (`asyncio.gather`); each persona
    returns `VERDICT: APPROVE|REVISE` + `FEEDBACK`.
  - **revising**: any REVISE → loop back to drafting with consolidated
    feedback. Bounded by `max_iterations`.
- `GET /drafts/{id}/workflow` returns the row (status, iteration,
  raw / polished / final content, panel votes, event log).
- `POST /drafts/{id}/workflow/cancel` — soft cancel.
- `GET /drafts/{id}/workflow/events` — SSE re-emits state every 1.5 s
  while non-terminal.

### Chat (retrieval-grounded LangGraph agent)

- `POST /chat` and `POST /chat/stream` (SSE: `session` → `token`* →
  `retrieved` → `skills` → `done`).
- Either `thread_id` (continues an existing session) or `project_id`
  (mints a new `sessions` row) is required. **`thread_id` IS
  `sessions.id`**.
- Optional `model` field overrides `NOTESCI_DEFAULT_MODEL` per request
  (format `<provider>:<model_id>`).
- Agent graph: `START → retrieve → call_model ↔ tools → END`.
  Retrieve embeds the latest human message and pulls top-5 chunks
  scoped to the project; call_model prepends them as a system message
  with bracketed citation labels.
- **Skills router** (`src/notesci/skills.py`): regex-based intent
  detection runs against the latest human message; matched skills
  prepend their compressed brief to the agent's system context.
  Skill names flow back as `ChatOut.skills` for the UI indicator —
  brief contents stay server-side. Three skills today:
  `content-research-writer`, `scientific-slides`,
  `writing-clearly-and-concisely`.
- **Per-bubble model attribution**: `ChatOut.model_used` + `turn_seq`
  surface the resolved model id back to the UI. `/threads/{id}/messages`
  joins `chat_calls` per turn so historical AI bubbles show "Anthropic
  · Claude Sonnet 4.6" beneath the text.
- **Telemetry**: every LLM invocation writes a `chat_calls` row
  (session, member, model, token counts, duration_ms, retrieval count,
  turn_seq).

### Multi-provider model routing

- `GET /providers/available` returns `{providers, models, default_model,
  fallback_model}`. Auth-gated. Drives the Preferences dropdown, the
  in-chat model pill, and the per-stage workflow pickers — frontend
  has zero hardcoded model lists.
- `model_catalog.py` is the single source of truth: 4 providers
  (Anthropic, OpenAI, Google, DeepSeek), 7 chat/reasoning models.
  Adding a model is a one-line change there.
- **Per-stage workflow routing**: `Interview.draft_model`,
  `polish_model`, `review_model` (all optional — fall back to the
  workflow's top-level `model`, which itself falls back to server
  default). The orchestrator emits a `models_resolved` event so the UI
  timeline shows which model handled each stage.
- **Reasoning-content extraction** (`agent/messages.py:extract_text`):
  walks both string and list-of-blocks shapes so DeepSeek-Reasoner /
  Anthropic extended-thinking / OpenAI o-series produce non-empty
  bubbles instead of silently returning the empty string.

### Citations + sessions

- `/sessions/{id}/export/citations.bib` — BibTeX. arXiv-aware
  (archivePrefix/eprint, year from ID); others render as `@misc`.
- `/sessions/{id}/graph?mode=citations|concepts|reasoning` — backs the
  workspace graph pane's session-scoped lenses.
- `/projects/{id}/map` — **project-wide materials map** (the wiki view).
  Returns nodes for every material + bridging concepts that appear in
  ≥ 2 materials. No session needed.
- `/threads/{id}/messages` — caller's own thread history.

### MCP host + curated catalog

- `POST /mcp/servers` (install record), `GET /mcp/servers`,
  `GET /mcp/servers/{id}`, `PATCH`, `DELETE`,
  `GET /mcp/servers/{id}/calls` (per-server audit log).
- **`GET /mcp/catalog`** + **`POST /mcp/catalog/{entry_id}/install`** —
  curated marketplace with real install templates (Semantic Scholar,
  arXiv, Paper Search, HuggingFace, GitHub, Linear, Notion, Slack,
  Firecrawl, Tavily, Zotero, Obsidian; Jupyter + PubMed marked
  `available=false` until upstream MCP servers ship). One-click
  install — no JSON for the user.
- Tool loading is **real** via `langchain-mcp-adapters.MultiServerMCPClient`
  with grants enforcement (`allowAll | tools allowlist | deniedTools` —
  fail-closed). Per-workspace cache (60s TTL + signature invalidation
  + surgical invalidation on `/mcp/servers` mutations).
- Every tool call writes an `mcp_call_logs` row.

### Cleanup sweeper + email

- `src/notesci/sweeper.py` — asyncio task spawned by `lifespan`,
  configurable interval (`NOTESCI_SWEEP_INTERVAL_SECONDS`, default
  3600, `0` disables). Prunes expired auth sessions, ages out used
  reset/verify tokens after 7 d, drops stale rate_limits buckets,
  sweeps stale `sent` invites back to `available`.
- `src/notesci/email_sender.py` — pluggable: `LogEmailSender` (default,
  stdout) or `SmtpEmailSender` (`NOTESCI_EMAIL_BACKEND=smtp` +
  `NOTESCI_SMTP_*`). Three transactional templates render text + HTML
  (reset 30 min, verify 24 h, invite 14 d).

## Admin

- `POST /admin/workspaces` — operator-only (`X-Admin-Token` header).
  Returns 503 when the token isn't configured, 401 on mismatch.
  Creates a workspace + N bootstrap invite codes. The only way to
  create a new workspace.

## Conventions / gotchas

- **Multi-provider LLM** is a hard requirement. `make_chat_model()` and
  `make_embedding_model()` are single chokepoints — never instantiate
  Anthropic/OpenAI/etc clients directly elsewhere.
- **Per-request context** (tools, member_id, session_id, model
  override, activated_skills) flows through `agent.graph.RequestCtx`
  contextvar — not LangGraph `configurable` (which is for serializable
  config; tool objects don't checkpoint cleanly).
- **Workspace boundaries**: every gated endpoint joins through
  `workspace_id` and collapses cross-workspace lookups to 404 with a
  generic `*_not_found` code. Don't leak which workspace owns what.
- **Telemetry / audit** writes are best-effort — failures are
  swallowed so the chat path never breaks because of logging.

## Production deploy

The repo ships a multi-stage `Dockerfile` (uv builder + slim runtime,
healthcheck) and a top-level `docker-compose.prod.yml` with three
services (postgres + backend + nginx-served frontend). See
`/deploy/vultr.md` for the end-to-end Vultr deploy guide
(Caddy/Cloudflare TLS, port-25 caveat, snapshots, day-2 ops).

## What's intentionally not here yet

- **Real MCP web-search dispatch** inside the workflow gather stage —
  the agent's chat path can call MCP tools, but the workflow runner
  needs to extract the tool fetcher into a session-less helper before
  it can reuse them. Stub records intent in the event log today.
- **Workflow soft-cancel is not preemptive** — flips the row to
  `cancelled` but the background task continues to its current
  stage's natural end.
- APA / Chicago / Vancouver / MLA citation styles (BibTeX is the
  source of truth; deferred until someone asks).
- Async job queue (Arq / RQ / Celery / Temporal) — fire-and-forget
  asyncio tasks are fine for the beta.
- Reranker on top of pgvector — "good enough" without one for now.
