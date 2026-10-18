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
- Position Notesci as a commercial literature service with upcoming free trial
  access and paid plans in development. Remove source/download/GitHub-first
  marketing, desktop offering and the Apache/GitHub website footer.
- Preserve the repository LICENSE and visibility unchanged. No verified service
  support/policy destinations or commercial terms were provided; do not fabricate them.
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

## Later read-only access check and commercial correction

The existing browser session is now authenticated to the documented Notesci
account a56dd840d54fd2d12d2024b1ed3b8546. The Worker overview and Quick Edit
editor are accessible. The active version shown is f58450b3 (prefix). The
unchanged editor shows a disabled Deploy control; effective publish permission
has not been tested. No editor content, secrets, credentials or deployments
were changed during this access check.

The verified GitHub error is only code 10000, Authentication error. Its root
cause (for example token validity versus scope versus account selection) is
not established. A dashboard publication route may avoid changing the GitHub
secret, but no further production attempt is authorized in this read-only
check, and publication is held for the corrected commercial presentation.

Official existing editor destination:
https://dash.cloudflare.com/a56dd840d54fd2d12d2024b1ed3b8546/workers/services/edit/green-sunset-4304/production

The free-trial CTA currently opens real availability information: trial access
is upcoming. There is no signup, checkout or fabricated inquiry destination.
The owner must confirm a monitored public email or approved contact form for
trial inquiries/support before an actionable inquiry CTA can be added.
No trial price, duration, quota or paid-plan price is invented.

## Approved production publication, 18 October 2026

The owner explicitly approved replacing the maintenance page through the
existing authenticated Cloudflare editor. The complete tested module was
copied back out of the editor and matched byte-for-byte before deployment.
The editor reported zero problems after an explicit string-body conversion.

- Active version: fef72f4b-0968-4b95-a0fa-e61c12ddeb46, Ready, 100% traffic.
- Prior maintenance version: f58450b3-2a90-4381-9429-faa3ef36872c.
- Deployed module source: 2add253e0c5ebd32db531b2adb08e018a7efd7cc.
- Module SHA256: 6eeb4c8af68702fb08a26540d79ba244c6b9e8dd8f407242605410f0644d11e0.
- The original maintenance module was saved locally as a rollback copy.

Both HTTPS domains now load the approved page (www redirects to the apex).
The homepage, index.html, CSS and all three SVG assets return 200. The legacy
favicon redirect also passes. Live desktop/tablet/mobile review passes: the
paired CTAs are 174x48px on larger screens and 335x48px in the 390px mobile
stack, with visible focus and no horizontal overflow.

Cloudflare adds its Web Analytics beacon to HTML at the edge. This setting
was not changed in the publication task. The live verifier identifies only
the observed standard beacon and still requires the application HTML/CSS/SVG
contents to match source exactly; unknown changes continue to fail. See
https://developers.cloudflare.com/web-analytics/get-started/ for automatic
beacon injection behavior.

No Stripe final submission or agreement acceptance was performed as part of
publication. Website availability does not establish payment-method approval
or availability of the planned trial, signup, checkout or agent APIs. The
earlier GitHub-to-Cloudflare API authentication failure remains unrepaired;
production was successfully published through the existing Dashboard session.
