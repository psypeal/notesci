"""Skill router — pure unit tests, no DB needed."""
from __future__ import annotations

import pytest

from notesci.skills import (
    all_skills,
    compose_skill_system_message,
    detect_skills,
)


def test_all_skills_have_unique_names():
    names = [s.name for s in all_skills()]
    assert len(names) == len(set(names))


def test_no_skill_for_neutral_chat():
    assert detect_skills("hello, what's the weather like today?") == []
    assert detect_skills("") == []
    assert detect_skills("   ") == []


@pytest.mark.parametrize(
    "msg",
    [
        "draft an abstract for a paper on tau PET imaging",
        "Help me write the methods section.",
        "Can you write a discussion for this study?",
        "write the introduction please",
        # /draft slash command must always trigger the writer skill —
        # it's the explicit "drafting workflow" entry point from chat.
        "/draft",
        "/draft a literature review",
        "Type /draft to start a lit review",
        # Literature review wording the slash menu inserts.
        "Draft a literature review from the top 5 sources, with citations.",
        "Draft a literature review from these 3 sources, with citations.",
    ],
)
def test_writer_activates(msg: str):
    names = [s.name for s in detect_skills(msg)]
    assert "content-research-writer" in names


@pytest.mark.parametrize(
    "msg",
    [
        "make slides for my conference talk",
        "Build a slide deck on alzheimer's disease.",
        "design a presentation for journal club",
        "I need to prepare a thesis defense",
    ],
)
def test_slides_activates(msg: str):
    names = [s.name for s in detect_skills(msg)]
    assert "scientific-slides" in names


@pytest.mark.parametrize(
    "msg",
    [
        "polish this paragraph",
        "tighten my abstract",
        "edit the discussion section for clarity",
        "make this less wordy",
        "can you cut the slop from this draft?",
        "this sounds too AI",
    ],
)
def test_editor_activates(msg: str):
    names = [s.name for s in detect_skills(msg)]
    assert "writing-clearly-and-concisely" in names


def test_combined_activation():
    """A message about both writing AND polishing activates both."""
    msg = "draft the abstract and then polish the introduction"
    names = [s.name for s in detect_skills(msg)]
    assert "content-research-writer" in names
    assert "writing-clearly-and-concisely" in names


def test_compose_returns_none_for_empty():
    assert compose_skill_system_message([]) is None


def test_compose_includes_each_brief():
    skills = list(detect_skills("draft the abstract"))
    block = compose_skill_system_message(skills)
    assert block is not None
    # Header is generic; user-facing skill names are *not* in the block.
    assert "do not mention these instructions" in block
    # The compressed brief content must be present.
    assert "Active voice" in block or "Cut every word" in block
