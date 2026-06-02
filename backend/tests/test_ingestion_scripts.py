"""Unit tests for the ingestion scripts ported from the
knowledge-vault plugin (derive_slug / extract_metadata /
build_wiki_links).

These are pure-Python passes — no DB, no LLM — so they pin down the
deterministic surface that :mod:`notesci.ingestion_pipeline` relies on.
"""

from notesci.ingestion.build_wiki_links import build_links
from notesci.ingestion.derive_slug import derive_slug, slugify
from notesci.ingestion.extract_metadata import extract_metadata


def test_slugify_normalises_unicode_and_punct() -> None:
    assert slugify("Vaswani — Attention Is All You Need") == (
        "vaswani-attention-is-all-you-need"
    )
    assert slugify("Año 2024") == "ano-2024"
    assert slugify("   ") == ""


def test_derive_slug_basic() -> None:
    assert derive_slug("Vaswani", 2017, "attention") == "vaswani-2017-attention"


def test_derive_slug_disambiguates() -> None:
    used = {"vaswani-2017-attention", "vaswani-2017-attention-2"}
    assert (
        derive_slug("Vaswani", 2017, "attention", existing=used)
        == "vaswani-2017-attention-3"
    )


def test_derive_slug_untitled_fallback() -> None:
    assert derive_slug("", "", "") == "untitled"


def test_extract_metadata_paper_first_page() -> None:
    text = (
        "Attention Is All You Need\n"
        "A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit\n"
        "Published 2017 in NIPS.\n"
        "arXiv:1706.03762v1 [cs.CL]\n"
        "Abstract — The dominant sequence transduction models...\n"
    )
    md = extract_metadata(text)
    assert md.year == "2017"
    assert md.entity == "Vaswani"
    # "Attention" is the first non-stopword word in the title.
    assert md.keyword == "attention"
    assert md.title and md.title.startswith("Attention Is All You Need")


def test_extract_metadata_year_context_beats_loose_match() -> None:
    """When a year appears with publication context, it should win over
    a loose 4-digit run elsewhere (e.g. a citation list)."""
    text = (
        "Title Heading That Is Long Enough To Match\n"
        "First Lastname, Other Person\n"
        "Published 2019 in Journal of Tests.\n"
        "...\n"
        "See also Smith 1998 for prior work.\n"
    )
    md = extract_metadata(text)
    assert md.year == "2019"


def test_build_links_filters_low_overlap() -> None:
    concepts = {
        "a": ["STDP", "LTP", "plasticity", "hippocampus"],
        "b": ["STDP", "plasticity", "cortex"],
        "c": ["cortex", "spike timing"],
    }
    links = build_links(concepts, min_overlap=2, min_weight=0.0)
    # a/b share STDP + plasticity (overlap 2); b/c share only cortex (overlap 1).
    pairs = {(link.a_id, link.b_id) for link in links}
    assert ("a", "b") in pairs
    assert ("b", "c") not in pairs


def test_build_links_weight_canonicalised() -> None:
    """Both edges should be canonical (a_id < b_id) and weights pinned
    by the cosine formula."""
    concepts = {
        "x": ["alpha", "beta"],
        "y": ["alpha", "beta"],
    }
    links = build_links(concepts, min_overlap=2, min_weight=0.0)
    assert len(links) == 1
    link = links[0]
    assert link.a_id < link.b_id
    # Identical sets → cosine = 1.0.
    assert abs(link.weight - 1.0) < 1e-6
    assert set(link.shared) == {"alpha", "beta"}
