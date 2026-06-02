# notesci · general chat handoff

The default surface users land on after sign-in. ChatGPT-style: thin sessions rail on the left, centered chat column. **No sources panel, no graph** — those are project-only features. When a thread becomes serious, users promote it to a project.

## Run locally
Open `notesci-general.html` in a browser. CDN React + Babel inline JSX — no build step.

## Files

| File | Role |
|---|---|
| `notesci-general.html` | Entry point — loads all .jsx files in order, defines design tokens |
| `design-canvas.jsx` | Pan/zoom canvas + artboard primitives (starter) |
| `tweaks-panel.jsx` | Floating tweaks panel (starter) |
| `mark.jsx` | notesci logo (shared with other handoffs) |
| `ws-icons.jsx` | Inline-SVG icon set (shared) — now includes `panel` / `panelFilled` for sidebar toggle |
| `gen-data.jsx` | Fixtures: sessions, messages, starter prompts |
| `gen-atoms.jsx` | `QuoteBlock`, `AssistantBlock`, `ChatBox` — the three message primitives |
| `gen-shell.jsx` | `GenTopBar`, `GenRail`, `GenRailCollapsed`, `GenFrame` |
| `gen-landing.jsx` | Landing / empty state |
| `gen-chat.jsx` | Active conversation with composer and conversation header |
| `gen-promote.jsx` | Promote-to-project banner + modal |
| `gen-app.jsx` | Composes artboards into the design canvas |

## On the canvas

**01 · Landing** — default screen on login. Editorial title, composer up front, starter-prompt chips, recent threads list, quiet "when to use a project" card.

**02 · Active conversation** — four artboards:
- Default state
- Web search on (composer Web button highlighted teal)
- Ad-hoc PDF attached
- Sidebar collapsed · focus mode (thin gutter with expand button)

**03 · Promote to project** — banner inline after ~3 messages + the modal where users choose how to carry contents over (bring everything · copy as starting point · start fresh).

## Key design decisions

- **Top bar mirrors the project workspace top bar** — same skeleton, swap the "project switcher" slot for a `GENERAL` mono pill with teal dot, and swap "Layout modes" for `Save as project · Share · New chat`.
- **One source of truth for "New chat"** — only in the top bar. The rail header is just the section label + collapse button.
- **Sidebar collapse uses Apple/Linear's panel icon** — `Icons.panelFilled` (subtle fill on left section) for hide, `Icons.panel` (outline) for show. Same icon family, different fills.
- **The V2 quote block is the user message block** (italic serif + indigo-capped hairline rule, no card). The assistant answers in plain serif paragraphs. Both share the same notebook voice.
- **Promote modal has 3 choices for carry-over** — `bring everything`, `copy as starting point` (chat stays in general), `start fresh` (empty project). Default = bring everything.
- **Sessions are flat with pin/star/archive** — no folders. PINNED → RECENT → ARCHIVED sections; archived rows render at 55% opacity.
- **No graph, no sources panel.** General chat allows web search + ad-hoc file drops but never persists into a library. To use a library, promote to a project.

## Design tokens
All defined in `notesci-general.html` `<style>`. Same palette as the rest of notesci — `--ink`, `--paper`, `--paper-2`, `--paper-3`, `--rule`, `--rule-2`, `--muted`, `--indigo`, `--indigo-soft`, `--teal`, `--teal-soft`, `--warn`. Fonts: Inter Tight (UI), Source Serif 4 (messages + editorial), JetBrains Mono (labels + metadata).

## Open questions for next pass
- Where exactly does the smart "promote" banner trigger fire? (Currently demoed at message 3.)
- Mobile layout for general chat — sessions rail likely becomes a drawer.
- Settings / account access — currently lives behind the avatar in the top bar but the menu isn't designed yet.
