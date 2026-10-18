#!/usr/bin/env python3
"""Check deployed HTTPS content against this checkout, including the www redirect."""

import importlib.util
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

USER_AGENT = "Notesci-Website-Check/1.0 (+https://github.com/psypeal/notesci)"


def request(url):
    return urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
    })


def without_edge_beacon(html):
    """Allow only the observed standard Cloudflare Web Analytics injection.

    All application HTML must still match exactly. Do not ignore arbitrary
    script tags, markup changes or other edge transformations.
    """
    pattern = re.compile(
        r'''<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[A-Za-z0-9]+" integrity="sha512-[A-Za-z0-9+/=]+" data-cf-beacon='([^']+)' crossorigin="anonymous"></script>\n?'''
    )
    matches = list(pattern.finditer(html))
    if not matches:
        return html, False
    if len(matches) != 1:
        raise RuntimeError("unexpected multiple Cloudflare analytics injections")
    match = matches[0]
    try:
        config = json.loads(match.group(1))
    except json.JSONDecodeError:
        raise RuntimeError("unexpected Cloudflare analytics configuration") from None
    if (not isinstance(config, dict) or set(config) != {"version", "token", "r", "spa"}
            or not isinstance(config["version"], str)
            or not re.fullmatch(r"[0-9a-f]{32}", str(config["token"]))
            or not isinstance(config["r"], int) or not isinstance(config["spa"], int)):
        raise RuntimeError("unexpected Cloudflare analytics configuration")
    return html[:match.start()] + html[match.end():], True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify():
    path = Path(__file__).with_name("build-landing-worker.py")
    spec = importlib.util.spec_from_file_location("landing_builder", path)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    assets = builder.landing_assets("landing")
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(request("https://www.notesci.com/"), timeout=20)
        raise RuntimeError("www must redirect to the canonical site")
    except urllib.error.HTTPError as response:
        if response.code != 301 or response.headers.get("Location") != "https://notesci.com/":
            raise RuntimeError(f"unexpected www response: HTTP {response.code}") from None
    try:
        opener.open(request("https://notesci.com/favicon.ico"), timeout=20)
        raise RuntimeError("favicon.ico must redirect to the SVG icon")
    except urllib.error.HTTPError as response:
        if response.code != 301 or response.headers.get("Location") != "/favicon.svg":
            raise RuntimeError(f"unexpected favicon fallback: HTTP {response.code}") from None
    for route, (expected, content_type, _) in assets.items():
        url = "https://notesci.com" + route
        with urllib.request.urlopen(request(url), timeout=20) as response:
            if response.status != 200:
                raise RuntimeError(f"{route}: HTTP {response.status}")
            if not response.headers.get("Content-Type", "").startswith(content_type):
                raise RuntimeError(f"{route}: unexpected content type")
            actual = response.read().decode("utf-8")
            edge_beacon = False
            if content_type.startswith("text/html"):
                actual, edge_beacon = without_edge_beacon(actual)
            if actual != expected:
                raise RuntimeError(f"{route}: public content differs from this checkout")
        note = "; standard Cloudflare analytics injection identified" if edge_beacon else ""
        print(f"PASS: {url} — 200, expected content{note}")
    print("PASS: www and favicon fallback redirects; all six public assets match source")


if __name__ == "__main__":
    try:
        verify()
    except (OSError, RuntimeError) as error:
        print(f"Live verification failed: {error}", file=sys.stderr)
        sys.exit(1)
