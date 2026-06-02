# notesci · dashboard handoff

Settings, members, MCP marketplace, and library for the invite-only beta. No billing — distribution is invite-code based.

## Run locally
Open `notesci-dashboard.html` directly in a browser. It uses CDN React + Babel and inline JSX, so no build step needed.

## Files

| File | Role |
|---|---|
| `notesci-dashboard.html` | Entry point — loads all .jsx files in order |
| `design-canvas.jsx` | Pan/zoom canvas that lays artboards in sections |
| `mark.jsx` | notesci wordmark (shared with sign-in handoff) |
| `tweaks-panel.jsx` | Floating tweaks panel + persistent state |
| `ws-icons.jsx` | Inline-SVG icon set (shared with workspace) |
| `db-data.jsx` | Fixture data — members, MCPs, audit log, library |
| `db-chrome.jsx` | TopBar, left rail nav (NAV constant), page header pattern |
| `db-pages.jsx` | Profile, Preferences, Notifications, Privacy, Members, Roles, SSO, Audit, Sources, **Citations & export**, **Reproducibility**, Library, Beta panel |
| `db-mcp.jsx` | MCP marketplace, server detail, install modal, installed-MCPs page |
| `db-app.jsx` | Top-level — composes artboards into the design canvas + Tweaks panel |

## What's on the canvas (12 artboards)

1. **Connections · MCP marketplace** — browse · server detail · scope-grant install modal · installed MCPs with per-server config + call logs
2. **General** — Profile · Preferences · Notifications · Privacy & data (with hidden personal access token)
3. **Workspace** — Members & invites · Roles permission matrix · SSO (post-beta) · Audit log
4. **Connections · Sources** — Zotero / Notion / Drive / Readwise (separate from MCPs)
5. **Research** — Citations & export (APA/Chicago/Vancouver/MLA + format defaults) · Reproducibility (coming soon)
6. **Library** — cross-project search across projects, sessions, materials
7. **Empty state** — no MCPs installed

## Design decisions worth knowing

- **No "Developer" section in the rail.** Researchers and students aren't developers; API keys are buried as a quiet "Personal access token" row at the bottom of Privacy & data. Webhooks removed entirely.
- **MCP marketplace is the centerpiece** of the beta — it's the section users will actually return to. Treated with featured strip, category chips, search, install/scope-grant flow.
- **Beta is invite-only**, so no billing surface. The "BetaPanel" component (not currently routed in the canvas) sits ready for when that changes — it's the seat-management view for invite codes.
- **Per-page chrome is consistent**: every page has `<PageHeader eyebrow title desc action />` followed by `<SectionCard>`s with `lrow` rows. Keep this pattern when adding pages.
- **Two surface colors only**: `--paper` (warm cream) for the background, `#fff` for cards. `--paper-2` for inset blocks. Don't introduce more.
- **Section ids on `<DCSection>` must be unique across files** — design-canvas.jsx persists artboard layout to localStorage keyed on those ids. (We hit this once — the workspace project's "primary" id collided.)

## Tweaks panel
Three knobs (viewer role, MCP density, surface theme) — currently UI-only, wired but not driving conditional rendering yet. Use them as a starting point for "what would I want to flip live during a design review" controls.

## Known leftovers
- `APIKeysPage` and `WebhooksPage` still exist in `db-pages.jsx` but are not routed. Safe to delete on next pass.
- `db-data.jsx` still has `API_KEYS` and `WEBHOOKS` arrays for the same reason.
