# notesci frontend

Vite + React 19 + TypeScript + Tailwind v4. SPA against the FastAPI
backend (see `backend/`). Brand tokens are sourced from
`notesci/design_handoff_notesci_logo/snippets/tokens.css` — locked.

## Run

```bash
# 1. Backend (in another terminal — see backend/README.md)
cd ../backend && uv run fastapi dev src/notesci/main.py

# 2. Frontend dev server
pnpm install   # first time
pnpm dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to
`http://127.0.0.1:8000` so the frontend can call the backend without
CORS setup. See `vite.config.ts`.

Production build:

```bash
pnpm build      # tsc -b + vite build → dist/
```

The build is code-split — pdfjs-dist is lazy-loaded so the main bundle
stays around **465 KB / 132 KB gzip**, and the **PDF reader chunk
(~415 KB / 124 KB gzip + ~1.2 MB worker)** only downloads when the
user actually opens a PDF.

## What's wired

### Auth + onboarding (14 routes)

`/sign-in`, `/claim`, `/waitlist`, `/forgot-password`, `/reset-sent`,
`/reset-password`, `/verify-email`, `/invite/:code`, `/invite-claimed`,
`/invite-expired`, `/onboarding`. V1 "Editorial" split layout per the
design handoff — see `src/components/AuthLayout.tsx` for the
`FormColumn` + `Hero` composition. Form column padding/spacing lives
in `src/index.css` as explicit `.form-column*` classes (not Tailwind
arbitrary values, which were unreliable in some HMR states).

### Workspace shell (`/`)

- `TopBar` — Mark + sidebar toggle + project switcher + Default/Reading/
  Drafting layout pill + ⌘K command palette + Invite pill + Share +
  New session + avatar. Responsive: at narrow widths the search width
  shrinks and labels collapse to icon-only via the `.ws-topbar-*`
  media-query rules in `src/index.css`.
- `SidePanel` (left, **280 px** in all three layout modes) — project
  header + per-project search + Sessions + Materials with All/PDF/
  Notes/URLs filter chips.
- `ChatPane` (center) — editorial messages with citation chips,
  composer with `/draft`, `@source`, **in-chat ModelPill** (provider-
  grouped popover; greyed-out unavailable models with "no key"
  hint), ⌘↩ submit. Posts to `/chat` with the selected model id.
  Renders the `skills` indicator pill on AI bubbles when the backend's
  intent router activated a proprietary skill (`SCIENTIFIC DRAFTING`,
  `MANUSCRIPT POLISH`, `SLIDE DESIGN`). Each AI bubble shows a small
  subscript with the model that produced it (e.g. "Anthropic · Claude
  Sonnet 4.6") so users can see which model handled each turn.
- `GraphPane` (right) — **4 lenses**: Map (project-wide materials,
  default), Citations, Concepts, Reasoning. Real force-simulated
  layout (Verlet), wheel-zoom anchored on cursor, drag pan, click to
  pin, hover details card, fullscreen mode. Backed by
  `/projects/{id}/map` (Map lens) or `/sessions/{id}/graph?mode=...`
  (other lenses). ⌘0 / ⌘1 / ⌘2 / ⌘3 keyboard shortcuts.
- `ReaderPane` (Reading layout) — **inline pdf.js renderer** with
  toolbar (page nav / zoom / Fit-width / download). Real text layer
  for selection + copy. Bytes streamed from
  `/materials/{id}/file` via authenticated `apiBlob` fetch + blob URL
  (auth never appears in the iframe URL). Lazy-loaded via
  `React.lazy` so pdfjs only downloads when needed.
- `DrafterPane` (Drafting layout) — long-form editor backed by
  `/projects/{id}/draft` (server-persisted, debounced upsert, multi-tab
  sync via storage events). Hosts the **`WorkflowPanel`** (next).

### Drafting workflow (`WorkflowPanel`)

Pre-flight interview modal (prompt, paragraph structure, word count,
fully editable expert panel, web-search toggle, max iterations, **plus
optional per-stage model overrides for Draft / Polish / Review** in an
"Advanced" expander) → `POST /drafts/{id}/workflow` → background
pipeline runs (gather → draft → polish → review → iterate until all
APPROVE or `max_iterations`). UI polls `/drafts/{id}/workflow` every
~2 s for live status + per-stage timeline + per-reviewer votes (with
per-reviewer model attribution). The timeline header surfaces the
resolved per-stage models in one glance; the panel votes show which
model each reviewer used. "Apply to draft" pastes the approved final
into the Drafter body.

### Dashboard (routes under `/settings/*` + `/library`)

`profile`, `preferences`, `notifications`, `privacy`,
`roles`, `sso`, `audit`, `sources`, `mcp` (catalog), `mcp/installed`,
`models`, `citations`, `reproducibility`, `shortcuts`, `changelog`,
`/library`. The **MCP marketplace** fetches the catalog from
`/mcp/catalog` (server-curated with real install templates) and uses
`POST /mcp/catalog/{id}/install` for one-click install — no JSON for
the user to write. Entries marked `available: false` show as "coming
soon".

### Layout modes + empty states

- **Default**: chat + graph
- **Reading**: ReaderPane (60 %) + GraphPane (40 %)
- **Drafting**: DrafterPane (50 %, with WorkflowPanel) + ChatPane (50 %)
- Empty states for "no projects", "no materials", "no active session"
  use the design's illus. + CTA pattern.

### Responsive

Auth flow is fully mobile (390 × 844). Workspace shell + dashboard
are desktop-first; under 900 px both render `<SmallScreenNotice>`
with brand Lockup + shortcut links (the desktop tree is `display:
none` below the breakpoint).

## Project structure

```
frontend/src/
├── App.tsx                    react-router routes
├── pages/
│   ├── SignIn.tsx, Claim.tsx, Waitlist.tsx, …  (auth flow)
│   ├── Onboarding.tsx, InviteFriends.tsx, InviteLanding.tsx
│   ├── Workspace.tsx          the 3-pane shell (host of all layout modes)
│   └── dashboard/             settings pages + Library + MCP marketplace
├── components/
│   ├── AuthLayout.tsx, Field.tsx, Hero.tsx, Footer.tsx, …  (shared chrome)
│   ├── brand/{Mark,Wordmark,Lockup}.tsx          brand SVGs
│   ├── icons.tsx                                  unified icon set
│   └── workspace/
│       ├── TopBar.tsx, SidePanel.tsx
│       ├── ChatPane.tsx, ReaderPane.tsx, DrafterPane.tsx, GraphPane.tsx
│       ├── ModelPill.tsx                         in-chat model picker (popover)
│       ├── PdfReader.tsx                          pdf.js renderer (lazy)
│       └── WorkflowPanel.tsx                      drafting pipeline UI
└── lib/
    ├── api.ts                 fetch wrapper (`api`, `apiBlob`)
    ├── prefs.ts               PrefsState (defaultModel canonical id) + migration
    ├── models.ts              /providers/available cache + label helpers
    └── …
```

## What's intentionally not here yet

- **In-workspace collaboration** — notesci is a personal private
  knowledge base; there's no shared-editing, presence, or team surface
  inside a workspace, and none is planned. (Invite codes — every member
  gets 3 to bring in new users via the Invite page — are kept; that's
  the signup funnel, not collaboration. The Members dashboard section
  was retired.)
- **Mobile/tablet of the workspace shell** — gracefully refused below
  900 px today.
- **First-time onboarding tour** — flagged as an open question in the
  workspace handoff.
