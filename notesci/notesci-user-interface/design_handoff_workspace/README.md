# notesci · workspace handoff

The post-sign-in product: a three-pane research-grounded chat workspace.

## What's here

- **`notesci-workspace.html`** — open this. Design canvas with four sections:
  - **01 · Primary workspace** — the canonical 3-pane app (sidebar / chat / graph)
  - **02 · Layout modes** — Reading & Drafting (toggled from the top-bar segmented control)
  - **03 · Graph spotlight** — three large frames showing the Citations / Concepts / Reasoning lenses
  - **04 · Empty states** — first-run, project-with-no-sources, fresh-session

## System

Same tokens as the sign-in handoff. Warm paper surfaces, indigo + teal brand, ink/muted text, JetBrains Mono for labels, Source Serif 4 for editorial moments. Workspace chrome is denser than the marketing surfaces — utilitarian by design.

## Decisions locked in v1

- **Layout modes**: Default · Reading · Drafting (Focus and Compare deferred)
- **Graph modes**: Citations · Concepts · Reasoning (Unified deferred — overlapped with Citations)
- **Layout switcher** lives in the top bar as a segmented control, next to the project name
- **Graph mode toggle** lives as a pill in the graph pane header

## Files

| File | Purpose |
|---|---|
| `mark.jsx` | Lockup / Mark — copied from the sign-in handoff |
| `ws-data.jsx` | Fixture data (project, sessions, materials, messages) |
| `ws-icons.jsx` | Inline SVG icon set |
| `ws-panes.jsx` | TopBar, SidePanel, ChatPane, GraphPane, GraphSVG, ReaderPane, DrafterPane |
| `ws-modes.jsx` | Layout compositions (Default / Reading / Drafting) |
| `ws-graph-spotlight.jsx` | Section 03 spotlight frames |
| `ws-empty.jsx` | Empty-state screens |
| `ws-app.jsx` | Top-level — lays everything out on the design canvas |
| `design-canvas.jsx`, `tweaks-panel.jsx` | Starter components |

## Tweaks panel

Toggle the panel in the toolbar. Controls:
- **Graph default mode** — Citations / Concepts / Reasoning
- **Density** — Comfortable / Compact
- **Theme** — Paper / Plain

## Open questions for next round

- Where does the **command palette** (⌘K) sit alongside the layout switcher?
- Mobile / tablet treatment of the 3-pane layout
- Onboarding tour for first-time workspace users
