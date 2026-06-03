# notesci.com deploy

## What actually serves the site

notesci.com (and www.notesci.com) is served by a single **Cloudflare
module Worker** named **`green-sunset-4304`** in the
"Admin@notesci.com's Account" (`a56dd840d54fd2d12d2024b1ed3b8546`).
There is **no Pages project** — the worker embeds the landing files
(`index.html`, `styles.css`, `favicon.svg`, `apple-touch-icon.svg`) as
string constants and routes by path, with a `www` → apex 301. The
custom domains are bound to the worker service, so deploys never touch
DNS.

## Auto-deploy (wired)

`.github/workflows/deploy-landing.yml` runs on every push to `main`
that touches `landing/`:

1. `packaging/build-landing-worker.py` regenerates `build/worker.mjs`
   from `landing/` (so the worker is always a faithful mirror of the
   committed source — verified byte-identical to the live worker),
2. `node --check` validates it,
3. `curl PUT` uploads it to the `green-sunset-4304` Worker via the
   Cloudflare API,
4. it re-fetches https://notesci.com and asserts the new content is live.

**Secrets it uses** (already set on the repo):
- `CLOUDFLARE_API_TOKEN` — token with `Account › Workers Scripts › Edit`
- `CLOUDFLARE_ACCOUNT_ID` — `a56dd840d54fd2d12d2024b1ed3b8546`

So the normal workflow is now: edit `landing/`, commit, push → the site
redeploys itself within a minute. HTML is served with
`cache-control: max-age=300`, so a browser may show the old page for up
to 5 minutes (hard-refresh to bypass).

## Manual deploy (if ever needed)

```bash
python3 packaging/build-landing-worker.py landing build/worker.mjs
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/green-sunset-4304" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F 'metadata={"main_module":"worker.mjs","compatibility_date":"2026-05-01"};type=application/json' \
  -F 'worker.mjs=@build/worker.mjs;filename=worker.mjs;type=application/javascript+module'
```

## Token hygiene

The token used to bootstrap this is account-owned (`cfat_…`). Once it's
in GitHub secrets, give it a short TTL or rotate it in the CF dashboard;
the CI token is the only copy that needs to keep working.
