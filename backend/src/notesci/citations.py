"""Citation export — BibTeX rendering.

Other styles (APA / Chicago / Vancouver / MLA per the dashboard's Citations
& export page) are deferred. BibTeX is the most useful single format for
the research-notebook use case (paste into LaTeX), and it carries
machine-readable fields the other styles can be derived from later.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime


@dataclass
class CitationMaterial:
    id: str
    title: str | None
    uri: str | None
    source_type: str
    metadata: dict
    created_at: datetime


_BIBKEY_SAFE = re.compile(r"[^a-zA-Z0-9_]")


def _sanitize_bibkey(s: str) -> str:
    """BibTeX keys must be ASCII alphanumeric + a few separators."""
    s = _BIBKEY_SAFE.sub("_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "ref"


def _bibtex_escape(value: str) -> str:
    """Minimal BibTeX-field escaping. We brace-wrap, so we just need to
    escape literal braces and percent signs."""
    return value.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("%", r"\%")


def _arxiv_year(arxiv_id: str) -> int | None:
    """Derive year from the arXiv ID. New-format IDs start with YYMM."""
    m = re.match(r"^(\d{2})\d{2}\.", arxiv_id)
    if m:
        yy = int(m.group(1))
        return 2000 + yy if yy < 90 else 1900 + yy
    m = re.match(r"^[a-zA-Z\.\-]+/(\d{2})\d{5}", arxiv_id)
    if m:
        yy = int(m.group(1))
        return 2000 + yy if yy < 90 else 1900 + yy
    return None


def _entry(material: CitationMaterial) -> str:
    meta = material.metadata or {}
    arxiv_id = meta.get("arxiv_id")
    title = material.title or "Untitled"

    fields: list[tuple[str, str]] = []

    if arxiv_id:
        key = _sanitize_bibkey(f"arxiv_{arxiv_id}")
        arxiv_meta = meta.get("arxiv_meta") or {}
        year = _arxiv_year(arxiv_id) or material.created_at.year
        # If we have richer metadata, prefer that title.
        if arxiv_meta.get("title"):
            title = arxiv_meta["title"]
        fields.append(("title", _bibtex_escape(title)))
        if arxiv_meta.get("authors"):
            # BibTeX convention: authors joined by " and ".
            fields.append(
                ("author", _bibtex_escape(" and ".join(arxiv_meta["authors"])))
            )
        fields.append(("year", str(year)))
        fields.extend([
            ("archivePrefix", "arXiv"),
            ("eprint", _bibtex_escape(arxiv_id)),
            ("url", f"https://arxiv.org/abs/{_bibtex_escape(arxiv_id)}"),
        ])
        if arxiv_meta.get("primary_category"):
            fields.append(
                ("eprintclass", _bibtex_escape(arxiv_meta["primary_category"]))
            )
        if arxiv_meta.get("doi"):
            fields.append(("doi", _bibtex_escape(arxiv_meta["doi"])))
        if arxiv_meta.get("abstract"):
            fields.append(("abstract", _bibtex_escape(arxiv_meta["abstract"])))
    else:
        first_word = re.split(r"\s+", title)[0] if title else "ref"
        key = _sanitize_bibkey(f"{material.source_type}_{first_word}_{material.id[:8]}")
        fields.append(("title", _bibtex_escape(title)))
        if material.uri:
            fields.append(("url", _bibtex_escape(material.uri)))
        fields.append(("year", str(material.created_at.year)))
        fields.append((
            "note",
            f"Ingested into notesci on {material.created_at:%Y-%m-%d} "
            f"as {material.source_type}",
        ))

    rendered = ",\n  ".join(f"{k} = {{{v}}}" for k, v in fields)
    return f"@misc{{{key},\n  {rendered}\n}}"


def to_bibtex(materials: list[CitationMaterial]) -> str:
    if not materials:
        return "% no citations recorded for this session\n"
    return "\n\n".join(_entry(m) for m in materials) + "\n"
