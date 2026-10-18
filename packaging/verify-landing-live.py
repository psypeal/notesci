#!/usr/bin/env python3
"""Check deployed HTTPS content against this checkout, including the www redirect."""

import importlib.util
from pathlib import Path
import sys
import urllib.error
import urllib.request

USER_AGENT = "Notesci-Website-Check/1.0 (+https://github.com/psypeal/notesci)"


def request(url):
    return urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
    })


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
    for route, (expected, content_type, _) in assets.items():
        url = "https://notesci.com" + route
        with urllib.request.urlopen(request(url), timeout=20) as response:
            if response.status != 200:
                raise RuntimeError(f"{route}: HTTP {response.status}")
            if not response.headers.get("Content-Type", "").startswith(content_type):
                raise RuntimeError(f"{route}: unexpected content type")
            if response.read().decode("utf-8") != expected:
                raise RuntimeError(f"{route}: public content differs from this checkout")
        print(f"PASS: {url} — 200, expected content")
    print("PASS: www redirects to HTTPS apex; all six public routes match source")


if __name__ == "__main__":
    try:
        verify()
    except (OSError, RuntimeError) as error:
        print(f"Live verification failed: {error}", file=sys.stderr)
        sys.exit(1)
