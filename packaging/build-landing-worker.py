#!/usr/bin/env python3
"""Generate the Cloudflare Worker that serves the notesci.com landing site.

notesci.com is served by a single module Worker (`green-sunset-4304`) that
embeds the static landing files as string constants and routes by path —
there is no Pages project and no assets binding. This script rebuilds that
worker's `worker.mjs` from the files in `landing/`, so the worker is always
a faithful mirror of the committed source.

Usage:
    python3 packaging/build-landing-worker.py [LANDING_DIR] [OUT_FILE]

Defaults: LANDING_DIR=landing, OUT_FILE=build/worker.mjs

Deploy (what .github/workflows/deploy-landing.yml does):
    curl -X PUT \
      "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/green-sunset-4304" \
      -H "Authorization: Bearer $TOKEN" \
      -F 'metadata={"main_module":"worker.mjs","compatibility_date":"2026-05-01"};type=application/json' \
      -F 'worker.mjs=@worker.mjs;filename=worker.mjs;type=application/javascript+module'
"""
import hashlib
import json
import os
import sys

LANDING = sys.argv[1] if len(sys.argv) > 1 else "landing"
OUT = sys.argv[2] if len(sys.argv) > 2 else "build/worker.mjs"


def read(name):
    with open(os.path.join(LANDING, name), encoding="utf-8") as f:
        return f.read()


def js(s):
    # json.dumps emits a valid JS double-quoted string literal: it escapes
    # backticks, ${, backslashes, and non-ASCII (arrows / em-dashes) safely.
    return json.dumps(s, ensure_ascii=True)


HTML = read("index.html")
CSS = read("styles.css")
FAVICON = read("favicon.svg")
APPLE_ICON = read("apple-touch-icon.svg")

assert "id=\"download\"" in HTML, "landing/index.html is missing the download section"

# Cache-bust the stylesheet: link it with a short content hash so a freshly
# deployed HTML never pairs with a stale, cached styles.css (HTML is cached
# 5 min, CSS 1 h — without this they can drift and the new markup renders
# unstyled). The worker routes by URL pathname, so the ?v= query is ignored
# for routing but forces browsers to refetch CSS whenever its content changes.
_css_ver = hashlib.sha256(CSS.encode("utf-8")).hexdigest()[:10]
_n = HTML.count('href="/styles.css"')
assert _n == 1, f"expected exactly one /styles.css link to version, found {_n}"
HTML = HTML.replace('href="/styles.css"', f'href="/styles.css?v={_css_ver}"')

worker = (
    "const HTML = " + js(HTML) + ";\n"
    "const CSS = " + js(CSS) + ";\n"
    "const FAVICON = " + js(FAVICON) + ";\n"
    "const APPLE_ICON = " + js(APPLE_ICON) + ";\n"
    "\n"
    "const TEXT = (body, type, maxAge = 300) => new Response(body, {\n"
    "  headers: {\n"
    "    'content-type': type,\n"
    "    'cache-control': `public, max-age=${maxAge}, must-revalidate`,\n"
    "    'x-content-type-options': 'nosniff',\n"
    "  },\n"
    "});\n"
    "\n"
    "const ROUTES = {\n"
    "  '/': () => TEXT(HTML, 'text/html; charset=utf-8'),\n"
    "  '/index.html': () => TEXT(HTML, 'text/html; charset=utf-8'),\n"
    "  '/styles.css': () => TEXT(CSS, 'text/css; charset=utf-8', 3600),\n"
    "  '/favicon.svg': () => TEXT(FAVICON, 'image/svg+xml', 86400),\n"
    "  '/apple-touch-icon.svg': () => TEXT(APPLE_ICON, 'image/svg+xml', 86400),\n"
    "};\n"
    "\n"
    "export default {\n"
    "  async fetch(request) {\n"
    "    const url = new URL(request.url);\n"
    "    if (url.hostname.startsWith('www.')) {\n"
    "      const target = new URL(request.url);\n"
    "      target.hostname = url.hostname.slice(4);\n"
    "      return Response.redirect(target.toString(), 301);\n"
    "    }\n"
    "    const route = ROUTES[url.pathname];\n"
    "    if (route) return route();\n"
    "    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });\n"
    "  },\n"
    "};\n"
)

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(worker)

print(f"wrote {OUT}: {len(worker)} bytes "
      f"(HTML {len(HTML)}, CSS {len(CSS)}, favicon {len(FAVICON)}, apple {len(APPLE_ICON)})")
