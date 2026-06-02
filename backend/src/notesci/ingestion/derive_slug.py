"""Bibliographic slug derivation — Python port of the knowledge-vault
plugin's ``derive-slug.sh``.

Builds ``<entity>-<year>-<keyword>`` slugs, sanitizes them
(lowercase, ASCII, hyphens), and disambiguates by appending ``-2``,
``-3``, … when the caller passes an ``existing`` collection.

Used by :func:`notesci.ingestion_pipeline.run_pipeline` to rename
uploaded materials so the workspace shows ``vaswani-2017-attention``
instead of ``download.pdf``.
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from collections.abc import Iterable


def slugify(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def derive_slug(
    entity: str,
    year: str | int | None,
    keyword: str,
    *,
    existing: Iterable[str] = (),
    max_len: int = 60,
) -> str:
    """Build ``<entity>-<year>-<keyword>``, sanitised + disambiguated.

    ``existing`` is the set of slugs already in use for the surrounding
    project so the caller can prevent collisions. Truncates the base to
    ``max_len`` *before* appending the disambiguation suffix so the
    output stays under ~64 chars even for long titles.
    """
    parts = [
        slugify(str(p)) for p in (entity, year, keyword) if slugify(str(p) if p else "")
    ]
    base = "-".join(parts) or "untitled"
    if len(base) > max_len:
        base = base[:max_len].rstrip("-")

    used = set(existing)
    candidate = base
    n = 2
    while candidate in used:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Derive a bibliographic slug from entity / year / keyword."
    )
    ap.add_argument("entity", help="First-author surname OR org abbreviation.")
    ap.add_argument("year", help="4-digit year (empty string if unknown).")
    ap.add_argument("keyword", help="1–2 short title words.")
    ap.add_argument(
        "--existing",
        nargs="*",
        default=(),
        help="Existing slugs to disambiguate against.",
    )
    args = ap.parse_args()
    print(derive_slug(args.entity, args.year, args.keyword, existing=args.existing))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
