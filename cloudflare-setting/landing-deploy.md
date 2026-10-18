# notesci.com deployment and restoration

## Production target

The existing deployment is a Cloudflare **module Worker** named
**green-sunset-4304**, in the existing Notesci account. The repository documents
notesci.com and www.notesci.com as custom domains on that Worker. There is no
Cloudflare Pages project in this workflow.

GitHub Actions deploys the Worker from .github/workflows/deploy-landing.yml.
The existing GitHub repository is https://github.com/psypeal/notesci and its
production branch is **main**. The action uses the existing
CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets. Secret names were
verified; their values were neither retrieved nor copied.

## Observed shutdown, 18 October 2026

At approximately 13:01 UTC, both HTTPS domains returned HTTP **503** with:

```text
notesci is temporarily unavailable.
```

Headers included no-store, Retry-After: 86400 and X-Robots-Tag:
noindex, nofollow, noarchive. This is consistent with a deliberate suspension
response. Its author, deployment version and application date have not been
established. That response is not present in the tracked landing source.

Earlier landing documentation records the retirement of the hosted research
app and a move from a Vultr VPS to the static Cloudflare site. The legacy
Docker/Vultr instructions remain in deploy/vultr.md for reference; restoring
the public website does not require starting that stack or touching its data.

## Restoration scope and implications

- Publish an information site about the scientific-literature plugin direction.
- Clearly label hosted search, MCP/REST endpoints, collections, provenance/
  deduplication adapters, optional screening and host integrations as planned.
- Preserve links to the existing desktop project's source, support, releases
  and Apache 2.0 license. No verified commercial terms were present in the
  original landing source; do not fabricate them.
- Replace only the static Worker module. Keep the existing domain bindings.
- Do not start the historic app, connect LLM providers, add billing, expose
  credentials, change DNS, create paid services or migrate customer data.

The public website returning 200 is a website-access check. It does not by
itself establish payment-method approval, merchant compliance or launch
readiness. Do not submit a website-remediation assertion to Stripe until
public loading is independently verified.

### Publication attempt

The 18 October restoration commit was pushed to main. GitHub Actions run
39130922353 passed the Worker build and 27 initial route/method checks, but
Cloudflare rejected the upload with authentication error 10000. The existing
site remained at 503; live verification was skipped. This is an external
authentication rejection, not an automatic-approval rejection.

Final local review also added a /favicon.ico redirect to the existing SVG
icon; all 29 revised Worker checks pass locally. The follow-up commit uses
[skip ci] so saving that correction does not repeat the rejected upload.
The owner must restore valid access to the existing account and GitHub
deployment secrets before dispatching deploy-landing.yml against main.
Do not create or rotate credentials without the owner's authorization.

## Build, test and publish

```bash
python3 packaging/build-landing-worker.py landing build/worker.mjs
node --check build/worker.mjs
node packaging/test-landing-worker.mjs
git diff --check
```

A push to main that touches landing/, the builder, its test/verifier or this
deployment workflow **immediately triggers production deployment**.
Pushing a feature branch does not deploy. workflow_dispatch also deploys
the source at the selected workflow ref.

CI uses Node 22 and Python 3.12. It builds the explicit static-file allowlist,
checks routes/methods/content, uploads the module to the existing Worker and
runs packaging/verify-landing-live.py. The verifier checks the HTTPS www
redirect and exact HTML, CSS and SVG contents. Propagation is retried three
times, five seconds apart. A failed post-deployment verification does not
automatically revert the upload: inspect the returned run and public site.

Local preview uses a loopback-only static server. Browser review must check
desktop/mobile layout, in-page navigation, image loading, external links and
the prominent planned/available distinction.

## Rollback

Record the Cloudflare deployment version before publication when dashboard
access is available. Restoring that version in the Worker deployment history
is the way to restore the exact prior live module. Dashboard access was not
authenticated during initial inspection, so no previous Cloudflare version
has been recorded by this restoration.

A source-only rollback restores the nine landing/deployment paths from
pre-restoration ref 9e45266 in a normal new commit, followed by a push to main.
It redeploys the previous **tracked landing site**.
It does not necessarily recreate the manual 503 response. Keep unrelated
app commits and local changes intact; do not reset shared branch history.

HTML uses max-age=0 and revalidates on load. CSS is content-versioned; SVG
icons can remain cached for a day.
