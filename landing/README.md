# notesci landing page

A single static HTML page that fronts the open-source repo. **No build
step, no JS framework, no backend** — just `index.html`, `styles.css`,
and two SVG icons. Total payload ~20 KB on the wire (plus Google Fonts,
CDN-cached).

This site replaces the previously-hosted instance at `198.13.49.213`
once the Vultr VPS is decommissioned. The full app continues to live
under `../frontend/` and `../backend/` for self-hosters.

## Local preview

```bash
cd landing
python3 -m http.server 4173
# open http://localhost:4173/
```

## What's in here

| File | Purpose |
|---|---|
| `index.html` | The single page. Hero / about / features / self-host / footer. |
| `styles.css` | Brand tokens + layout. Mirrors `notesci/design_handoff_notesci_logo/snippets/tokens.css`. |
| `favicon.svg` | The notesci NS lettermark (teal + indigo on paper). |
| `apple-touch-icon.svg` | Rounded dark-tile variant for iOS home-screen pins. |

**Before going live**, update three hard-coded values:

1. `https://github.com/psypeal/notesci` — appears 3× in `index.html`. Set to the real repo URL.
2. The hero copy if the project framing changes.
3. (Optional) The `<meta property="og:image">` — currently points at the touch icon. Replace with a 1200×630 social card if you make one.

## Deploy to Cloudflare Pages

You have a custom domain already. Easiest path is the **Direct Upload**
flow (no GitHub integration required) — switch to git-connected later
if you want auto-deploy on push.

### Option A — Direct Upload (fastest first deploy)

1. Sign in to **dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets**.
2. Project name: `notesci-landing` (becomes `notesci-landing.pages.dev`).
3. Drag-drop the `landing/` folder, or zip its contents (`index.html` + `styles.css` + `favicon.svg` + `apple-touch-icon.svg`) and upload.
4. Click **Deploy site**. First deploy takes ~30 seconds.
5. Verify at `https://notesci-landing.pages.dev`.

### Option B — Git-connected (auto-deploy on push)

After the repo is published to GitHub:

1. **Workers & Pages → Create → Pages → Connect to Git → notesci repo**.
2. **Build settings**:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `landing`
   - Root directory: *(leave blank — it's the repo root)*
3. Deploy. Future pushes to `main` (or your default branch) rebuild automatically.

### Attach the custom domain

1. In the Pages project → **Custom domains → Set up a custom domain**.
2. Enter your domain (e.g. `notesci.com` or `www.notesci.com`).
3. Cloudflare prompts you for a **CNAME** record:
   - If your DNS is on Cloudflare: it adds the record itself, one click.
   - If your DNS is elsewhere: add `CNAME @ → notesci-landing.pages.dev` (or `www → notesci-landing.pages.dev`). Apex domains may need a CNAME flattening (or `ALIAS`/`ANAME` depending on the registrar).
4. Cloudflare issues a free TLS cert within ~5 minutes.
5. Confirm by visiting your domain over `https://`.

### Verify before destroying the Vultr instance

Don't tear down the VPS until you've confirmed all three:

- [ ] Landing loads at `https://yourdomain` over HTTPS.
- [ ] Favicon + touch icon render in the tab and on iOS "Add to Home Screen".
- [ ] DNS no longer points at `198.13.49.213` (`dig yourdomain +short` returns the Cloudflare CNAME target).

Then proceed with the Vultr decommission steps (see project root).

## Known follow-ups (not blocking)

- **Raster fallbacks** — no `apple-touch-icon.png` (180×180) or `favicon.ico` shipped. The SVG favicon works in every modern browser; iOS home-screen icon falls back to the SVG too. Add rasters later if you see fuzziness on legacy Safari.
- **Social card image** — `og:image` currently points at the touch-icon SVG. Some social platforms don't render SVG previews; a 1200×630 PNG would improve link unfurls on X, LinkedIn, Slack.
- **Analytics** — no analytics shipped. If you want lightweight stats, Cloudflare Pages includes free Web Analytics with one toggle in the dashboard (no script tag, no cookie banner needed).
