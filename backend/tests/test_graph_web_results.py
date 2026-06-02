from __future__ import annotations

from notesci.agent.graph import _snippet_text


def test_snippet_text_replaces_empty_marker_with_source() -> None:
    title, text, source = _snippet_text({
        "uid": "12345678",
        "snippet": "[]",
    })

    assert source == "https://pubmed.ncbi.nlm.nih.gov/12345678/"
    assert text == "Source: https://pubmed.ncbi.nlm.nih.gov/12345678/"
    assert title == "Web result"


def test_snippet_text_extracts_recursive_nested_text() -> None:
    title, text, source = _snippet_text({
        "title": "Nested paper",
        "result": {
            "entry": {
                "AbstractText": ["Alpha beta"],
            },
        },
    })

    assert title == "Nested paper"
    assert text == "Alpha beta"
    assert source is None
