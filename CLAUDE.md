# notesci

notesci is a **personal private knowledge base** for scientific
research — e-document management, query, and drafting over one
researcher's own corpus. It is *not* a collaboration tool: there's no
team/sharing surface, and a workspace is simply one person's private
space. Backend (`backend/`) and frontend (`frontend/`) are built
end-to-end; production deploys to a Vultr VPS.

## Where to find what

| Need | Path |
|---|---|
| Backend code, routes, conventions, deploy | `backend/README.md` |
| Frontend code, wired pages, structure | `frontend/README.md` |
| Live API spec | `http://localhost:8000/docs` (Swagger) |
| Production deployment | `deploy/vultr.md` |
| Identity spec · drop-in SVGs · `tokens.css` + snippets | `notesci/design_handoff_notesci_logo/` (`README.md`, `assets/`, `snippets/`) |
| Auth flow spec | `notesci/notesci-signin-signup/design_handoff_signin/README.md` |
| Workspace UI spec | `notesci/notesci-user-interface/design_handoff_workspace/README.md` |
| Dashboard spec | `notesci/notesci-dashboard/design_handoff_dashboard/README.md` |
| Proprietary skills (silent activation) | `.claude/skills/` — briefs in `backend/src/notesci/skills.py` |

Each design-handoff folder has a `README.md` (the spec — read it before
touching that surface) plus `.jsx` files (mocks/`references/` — design
intent, **not** production code; reuse geometry + tokens, rebuild in the
chosen stack).

## Locked design decisions

Settled — don't re-litigate or invent alternatives; flag instead.

- **Identity** — teal + indigo pairing; custom NS lettermark; Inter
  Tight (UI), Source Serif 4 (editorial), JetBrains Mono (labels,
  codes, pills). Hi-fi: recreate pixel-perfect from the handoff. Use
  `snippets/tokens.css` as the token source of truth — don't redefine
  colors or add alt pairings / typefaces / logo variants without
  asking.
- **Auth** — invite-only product that grows by invitation: every
  member gets 3 invite codes (`NS-XXXX-XXXX`, case-insensitive) to
  bring in new users, surfaced via the **Invite page** (`/invites`) —
  this is the signup funnel and is core to the design, keep it.
  Workspaces are operator-bootstrapped via `POST /admin/workspaces` (no
  self-serve creation); the first member to claim a bootstrap code
  becomes that workspace's admin. **Retired:** the Members dashboard
  section — notesci is a personal knowledge base, so there's no
  in-workspace team surface. Primary CTAs are label-only — no trailing
  "→". Out of scope: magic-link, 2FA, dark mode, localization,
  in-workspace collaboration (shared editing, presence).
- **Workspace** — 3 panes (sidebar / chat / graph). Layout modes:
  Default, Reading, Drafting (Focus + Compare are deferred — don't
  build them). Graph lenses: Map (default, project-wide), Citations,
  Concepts, Reasoning (last three are session-scoped). SidePanel is
  280px in every mode. Below 900px renders `<SmallScreenNotice>`. No
  new tokens.
- **Dashboard** — Settings / MCP marketplace / Library; no billing
  surface. **Retired** (personal product, single-user workspace — don't
  reintroduce): the Members section, the Roles permission matrix, and
  SSO. The dashboard nav has no "WORKSPACE" group — settings are
  GENERAL / CONNECTIONS / RESEARCH / LIBRARY / HELP, and Audit log
  lives under GENERAL as personal account history. MCP marketplace is
  the centerpiece (server-curated catalog at `/mcp/catalog`). No
  "Developer" section, no Webhooks — API keys are a quiet
  Personal-access-token row under Privacy. Two surfaces only: `--paper`
  (page), `#fff` (cards), `--paper-2` (insets) — don't add more.

## Backend (locked decisions)

- **Python + FastAPI + LangGraph** — provider-agnostic agent runtime,
  durable state via the Postgres checkpointer.
- **Multi-provider LLM is a hard requirement** (Anthropic / OpenAI /
  Google / DeepSeek). Provider-locked SDKs were ruled out. Gate
  provider-specific features behind flags with fallbacks.
- **Single chokepoints — load-bearing.** Never instantiate provider
  clients directly: `make_chat_model()` / `make_embedding_model()`
  (`agent/providers.py`, `agent/embeddings.py`) are the only places.
  Same rule for skill briefs (`skills.py`) and the MCP catalog
  (`mcp_catalog.py`).
- **Postgres + pgvector** — HNSW index on `chunks.embedding`;
  `vector(1536)` is fixed by migration 0002 to match
  `openai:text-embedding-3-small` — changing the dimension needs a new
  re-embedding migration.
- **MCP host** — official Python MCP SDK + `langchain-mcp-adapters`;
  notesci is the multi-tenant host.
- **Per-request context** (tools, member_id, session_id, model
  override, activated_skills) flows through `agent.graph.RequestCtx`
  contextvar — not LangGraph `configurable`.
- **Workspace boundaries** — gated endpoints join through
  `workspace_id` and collapse cross-workspace lookups to a 404 with a
  generic `*_not_found` code. Don't leak ownership.
- **Telemetry / audit** writes are best-effort — failures are
  swallowed so the user flow never breaks because of logging.

## Frontend conventions

- Ship SVGs, not rasters (except required raster fallbacks: 180×180
  apple-touch-icon, 32×32 ICO).
- Every Enter-driven text input needs an IME-composition guard —
  `if (e.nativeEvent.isComposing || e.keyCode === 229) return` — or
  CJK input breaks.
