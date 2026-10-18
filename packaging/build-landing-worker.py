#!/usr/bin/env python3
"""Build the static notesci.com module Worker; never bundle app/config files.

Usage: python3 packaging/build-landing-worker.py [landing] [build/worker.mjs]
Deploy through .github/workflows/deploy-landing.yml to green-sunset-4304.
"""

import hashlib
import json
from pathlib import Path
import sys


def landing_assets(directory):
    """An explicit allowlist keeps credentials and application routes out."""
    root = Path(directory)
    css = root.joinpath("styles.css").read_text(encoding="utf-8")
    html = root.joinpath("index.html").read_text(encoding="utf-8")
    if html.count('href="/styles.css"') != 1:
        raise ValueError("expected exactly one /styles.css link")
    version = hashlib.sha256(css.encode()).hexdigest()[:10]
    html = html.replace('href="/styles.css"', f'href="/styles.css?v={version}"')
    assets = {
        "/": [html, "text/html; charset=utf-8", 0],
        "/index.html": [html, "text/html; charset=utf-8", 0],
        "/styles.css": [css, "text/css; charset=utf-8", 3600],
    }
    for name in ("favicon.svg", "apple-touch-icon.svg", "brand-mark.svg"):
        assets[f"/{name}"] = [root.joinpath(name).read_text(encoding="utf-8"),
                               "image/svg+xml", 86400]
    return assets


def build(directory, output):
    assets = landing_assets(directory)
    # JSON string literals safely embed arbitrary static text without using
    # JavaScript template strings or interpreting ${...} in source HTML/CSS.
    worker = "const ROUTES = new Map(Object.entries(" + json.dumps(assets) + "));\n"
    worker += """
const headers = (type, cache = 'no-store') => ({
  'content-type': type,
  'cache-control': cache,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
});

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...headers('text/plain; charset=utf-8'), allow: 'GET, HEAD' },
      });
    }
    if (url.hostname === 'www.notesci.com') {
      url.hostname = 'notesci.com';
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: {
        location: url.toString(), 'cache-control': 'no-cache',
      } });
    }
    // Browsers can probe this legacy URL even when HTML declares the SVG.
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 301, headers: {
        location: '/favicon.svg', 'cache-control': 'public, max-age=86400',
      } });
    }
    const asset = ROUTES.get(url.pathname);
    if (!asset) {
      return new Response(request.method === 'HEAD' ? null :
        'Page not found. Visit https://notesci.com/', {
        status: 404, headers: headers('text/plain; charset=utf-8'),
      });
    }
    const [body, type, maxAge] = asset;
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: headers(type, `public, max-age=${maxAge}, must-revalidate`),
    });
  },
};
"""
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(worker, encoding="utf-8")
    print(f"wrote {destination}: {len(worker.encode())} bytes; {len(assets)} routes")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "landing",
          sys.argv[2] if len(sys.argv) > 2 else "build/worker.mjs")
