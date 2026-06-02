"""Heuristic metadata extraction — Python port of the knowledge-vault
plugin's ``extract-metadata.sh``.

Given the first ~1500 characters of a PDF (already extracted to text by
``ingest.extract_pdf_text``), pull out a best-guess title, first-author
surname, and 4-digit year. The output feeds
:func:`derive_slug.derive_slug` so we can rename a material from
``download.pdf`` to ``vaswani-2017-attention`` in the workspace.

The pass is intentionally conservative — when the regexes don't agree,
:mod:`notesci.ingestion_pipeline` falls back to an LLM call via
``make_chat_model`` to refine the guess.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass


_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")

# Common journal/arXiv year markers — when present they raise our
# confidence in the extracted year and discourage matching DOI strings
# (e.g. 2202.xxxxx which is an arXiv ID not a year).
_YEAR_CONTEXT_RE = re.compile(
    r"(?:Published|Submitted|Accepted|Copyright|©|\(c\)|\bin\b|arXiv:[0-9]+\.[0-9]+v\d+\s*\[[^\]]+\]\s*)\s*(19\d{2}|20\d{2})",
    re.IGNORECASE,
)


# "Surname, F." / "Surname F" / "F. Surname". This is a best-effort
# capture of the FIRST author surname — the slug only needs the lead
# entity.
_AUTHOR_PATTERNS = [
    # "F. Surname, ..."
    re.compile(r"\b[A-Z]\.\s+([A-Z][a-zA-Z\-]{2,})\b"),
    # "Surname, F."
    re.compile(r"\b([A-Z][a-zA-Z\-]{2,})\s*,\s*[A-Z]\."),
    # "Surname et al."
    re.compile(r"\b([A-Z][a-zA-Z\-]{2,})\s+et\s+al\b"),
]


# Title-case word run from the FIRST non-empty line longer than 12 chars
# (skip arXiv banners and stray headers).
def _first_titleish_line(text: str) -> str | None:
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Skip arXiv preprint banners + URLs + version stamps.
        if re.match(r"^arXiv:|^https?://|^\d{4}\.\d+v\d+$", line):
            continue
        # Need at least a couple of words.
        if len(line) < 12 or " " not in line:
            continue
        return line
    return None


_KEYWORD_STOP = {
    "the", "a", "an", "of", "and", "for", "with", "in", "on", "to", "from",
    "by", "as", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "we", "our", "their", "its",
    "study", "studies", "research", "paper", "article", "report",
    "novel", "new", "improving", "improved", "analysis",
}


def _pick_keyword(title: str) -> str:
    """Take the first content-bearing word from the title."""
    if not title:
        return ""
    words = re.findall(r"[A-Za-z][A-Za-z0-9\-]{2,}", title)
    for w in words:
        if w.lower() in _KEYWORD_STOP:
            continue
        return w.lower()
    return words[0].lower() if words else ""


@dataclass
class ExtractedMetadata:
    title: str | None
    entity: str | None
    year: str | None
    keyword: str | None
    raw_first_lines: str


def extract_metadata(first_page_text: str, *, char_limit: int = 1500) -> ExtractedMetadata:
    """Pull title / first-author surname / year / keyword from the
    leading text of a PDF.

    Designed for ``ingest.extract_pdf_text(...).text`` — pass it
    verbatim and we'll only look at the leading ``char_limit`` chars so
    long full-text bodies don't slow the pass down.
    """
    head = (first_page_text or "")[:char_limit]
    raw_lines = "\n".join(head.splitlines()[:30])

    title = _first_titleish_line(head)

    entity: str | None = None
    for pat in _AUTHOR_PATTERNS:
        m = pat.search(head)
        if m:
            entity = m.group(1)
            break

    year: str | None = None
    m_ctx = _YEAR_CONTEXT_RE.search(head)
    if m_ctx:
        year = m_ctx.group(1)
    else:
        m_any = _YEAR_RE.search(head)
        if m_any:
            year = m_any.group(1)

    keyword = _pick_keyword(title or "")

    return ExtractedMetadata(
        title=title,
        entity=entity,
        year=year,
        keyword=keyword,
        raw_first_lines=raw_lines,
    )


def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Heuristic title/author/year extraction from PDF first-page text."
    )
    ap.add_argument(
        "path", help="Path to a UTF-8 text file containing PDF first-page text."
    )
    args = ap.parse_args()
    with open(args.path, encoding="utf-8") as f:
        text = f.read()
    md = extract_metadata(text)
    print(json.dumps(asdict(md), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
