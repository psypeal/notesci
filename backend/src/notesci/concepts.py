"""Concept-extraction heuristics for the workspace graph pane.

This is a deliberately-simple regex-based pass — multi-word capitalized
phrases and 2-6 letter acronyms — with a stopword filter. Real NER
(scispacy for biomedical, spaCy with a model for general) is the upgrade
path; this is the cheapest thing that produces a useful graph and keeps
the iteration scope tight.

Usage:

    >>> extract_concepts("STDP and Long-Term Potentiation drive plasticity.")
    {'STDP', 'Long-Term Potentiation'}
"""
from __future__ import annotations

import re

# 2-6 uppercase letters; common acronym shape (STDP, LTP, mRNA escapes via length)
_ACRONYM_RE = re.compile(r"\b([A-Z]{2,6}(?:[A-Z0-9]{0,3}))\b")

# Capitalized phrases of 2+ words, possibly hyphenated.
# "Spike Timing", "Long-Term Potentiation", "Brodmann Area".
_PHRASE_RE = re.compile(
    r"\b([A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)+)\b"
)

# Common sentence-starter capitalized words that aren't real concepts.
_STOPWORD_LEADERS = {
    "The", "A", "An", "We", "Our", "However", "Furthermore", "Therefore",
    "This", "That", "These", "Those", "Here", "There", "From", "When", "While",
    "Although", "Despite", "Because", "If", "Then", "Such", "Some", "Many",
    "Most", "All", "Any", "Each", "Both", "Other", "Several", "Various",
    "Recent", "Current", "Future", "First", "Second", "Last", "Next",
}

# Bare-word acronyms we want to keep — the stopword filter must not eat them.
_ACRONYM_KEEP_OVERRIDE = {"DNA", "RNA", "MRI", "EEG", "fMRI", "GPU", "CPU", "API"}

# Acronyms that are usually false positives in technical text.
_ACRONYM_NOISE = {"USA", "UK", "EU", "AM", "PM"}


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def extract_concepts(text: str) -> set[str]:
    """Return a set of candidate concept strings extracted from ``text``.

    Splits ``text`` into sentences first so multi-word phrase matches
    don't bridge sentence boundaries (e.g. "Hippocampus" at the end of
    one sentence + "Long-Term Potentiation" at the start of the next
    must NOT collapse into one phrase). The strings are kept in their
    canonical (extracted) casing.
    """
    if not text:
        return set()

    out: set[str] = set()
    for sentence in _SENTENCE_SPLIT_RE.split(text):
        for m in _ACRONYM_RE.findall(sentence):
            if m in _ACRONYM_NOISE:
                continue
            if m in _ACRONYM_KEEP_OVERRIDE or len(m) >= 2:
                out.add(m)
        for m in _PHRASE_RE.findall(sentence):
            first = m.split()[0]
            if first in _STOPWORD_LEADERS:
                continue
            out.add(m)
    return out
