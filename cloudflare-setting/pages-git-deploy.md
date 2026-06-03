# Auto-deploy notesci.com on every push

Goal: every push to `main` that touches `landing/` republishes
notesci.com automatically — no more manual zip uploads.

## Why CI deploy, not the dashboard "Connect to Git"

notesci.com is a Cloudflare Pages **Direct Upload** project. Cloudflare
**cannot** convert a Direct-Upload project to a Git-connected one, and
the Git integration can only be authorized through the dashboard
GitHub-App OAuth flow (not the API/wrangler). So the dashboard route
forces you to **recreate the project and move the `notesci.com` custom
domain** (brief downtime).

The cleaner path keeps your existing project and domain untouched: a
GitHub Actions job that runs `wrangler pages deploy landing` against the
same project on every push. That's what
`.github/workflows/deploy-landing.yml` does.

## One-time setup (≈3 minutes)

You provide three values to GitHub; nothing in Cloudflare changes.

### 1. Create a scoped Cloudflare API token
Dashboard → **My Profile → API Tokens → Create Token → Custom token →
Get started**:
- **Permissions:** `Account` · `Cloudflare Pages` · **Edit** (just this one row)
- **Account Resources:** Include → *your specific account* (not "All accounts")
- (optional) set a TTL / IP filter for hygiene
- Create, and copy the token value.

This single permission is enough for `wrangler pages deploy` to an
existing project — *as long as the account ID is also supplied* (which
the workflow does via the `CLOUDFLARE_ACCOUNT_ID` secret).

### 2. Find your account ID and project name
- **Account ID:** Dashboard → **Workers & Pages** (the overview/right
  panel shows *Account ID*).
- **Project name:** the slug of your Pages project under **Workers &
  Pages** (e.g. `notesci`).

### 3. Add them to the repo
Either via GitHub UI (**Settings → Secrets and variables → Actions**) or
the `gh` CLI:

```bash
gh secret   set CLOUDFLARE_API_TOKEN          # paste the token at the prompt
gh secret   set CLOUDFLARE_ACCOUNT_ID         # paste the account ID
gh variable set CF_PAGES_PROJECT --body "notesci"   # your Pages project slug
```

(Project name is a **variable**, not a secret — it isn't sensitive, and
the workflow is skipped until it's set, so adding the workflow file
won't produce a failing run.)

### 4. Fire the first deploy
Actions → **deploy-landing** → **Run workflow** (or just push any change
under `landing/`). After it's green, every future `git push` to `main`
that touches `landing/` redeploys notesci.com on its own.

## Notes
- The workflow deploys to **production** with `--branch=main`. This
  assumes the project's production branch is `main` (the default). If
  yours differs, change the `--branch=` value in the workflow.
- Pushes that don't touch `landing/` are ignored (path filter), so app
  commits won't trigger a site deploy.

## Alternative: dashboard Git connection (not recommended here)
If you'd rather use Cloudflare's native Git integration, you must create
a **new** Pages project (Create → Pages → Connect to Git → `psypeal/
notesci`; Framework preset *None*, build command empty, output directory
`landing`), then move `notesci.com` + `www` from the old project to the
new one. This works but involves recreating the project and a brief
domain-swap gap — the CI approach above avoids both.

## If notesci.com turns out to be a Worker, not Pages
If the dashboard shows it under a **Worker** (Static Assets) instead of
a Pages project, the CI job changes to `wrangler deploy` with a
`wrangler.jsonc` (`"assets": { "directory": "./landing" }`). Say so and
that config can be generated instead.
