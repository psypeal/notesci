# Notesci public website

This directory is the static information site for https://notesci.com/.
It describes the scientific literature search, query and collection plugin
**in development**, while linking to the existing desktop research project.

There is no public search API, MCP endpoint, signup, checkout, hosted collection
storage or app backend in this deployment. Target integrations with ChatGPT,
Claude Code, Antigravity and DeepSeek-powered agents are **planned and unvalidated**.
The workflow illustration contains no live paper results.

## Local preview and checks

From the repository root:

```bash
python3 packaging/build-landing-worker.py landing build/worker.mjs
node --check build/worker.mjs
node packaging/test-landing-worker.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory landing
```

Inspect http://127.0.0.1:4173/ at desktop and mobile widths. The site needs
no JavaScript or package installation. The existing typography uses Google
Fonts with system fallbacks. License, source, support and desktop release
links go to the existing public GitHub project.

The Worker only embeds an explicit allowlist: index.html, styles.css,
brand-mark.svg, favicon.svg and apple-touch-icon.svg. It serves the HTML
at both / and /index.html, redirects www to the HTTPS apex and legacy
/favicon.ico requests to /favicon.svg, supports GET/HEAD,
returns 405 for other methods and 404 for other paths (including /api and /mcp).
Private config and app files cannot be included by directory traversal or
directory-wide uploads. CSS URLs have a content hash; HTML always revalidates.

## Existing production deployment

The production target is Cloudflare module Worker **green-sunset-4304**.
This is not Cloudflare Pages or OpenAI Sites. Both custom domains were already
bound to this Worker according to cloudflare-setting/landing-deploy.md.

A push to **main** touching landing/, the builder, its test/verifier, or the
landing workflow triggers **production deployment** through
.github/workflows/deploy-landing.yml. A branch push does not.

The existing GitHub secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
are used in CI. Do not print or copy their values into this directory.
The upload replaces the Worker's module; it does not restart the historic
Vultr app or expose the FastAPI backend. No DNS changes, new provider keys,
new paid services, customer data migrations or payment functionality are needed.

After publication:

```bash
python3 packaging/verify-landing-live.py
```

This checks the www redirect and all public assets against the exact local
source. Also inspect both domains in a browser. A successful deployment
request alone is not proof the site is publicly available.

## Rollback

Before publishing, record the current Cloudflare version if dashboard access
is available. Cloudflare's Worker deployment history is the preferred route
to restore the exact previous live response.

For a **source rollback**, create a commit restoring only the nine changed
landing/deployment paths from pre-restoration ref 9e45266, then push main;
the existing action redeploys the preceding tracked landing page.
That restores the old tracked website, not necessarily the manually deployed
503 shutdown response. Do not reset shared history, revert unrelated app
commits or delete the historic database.

See cloudflare-setting/landing-deploy.md for the observed outage and limits.
