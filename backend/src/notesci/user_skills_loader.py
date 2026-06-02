"""Load user-authored skills from ``~/.config/notesci/skills/``.

Each skill is a folder containing ``skill.toml`` + ``brief.md``. The
loader scans the directory, parses each, returns ``Skill`` instances
ready to merge into the router's catalog.

Failure isolation: a malformed skill folder logs a warning and is
skipped — never crashes the loader. The user might have a half-written
recipe; we don't want that to block all other skills.

This module is intentionally separate from ``skills.py`` (which holds
the built-in catalog literals) so the import graph stays clean:
``skills.py`` imports this module lazily, this module does not import
``skills.py``.
"""

from __future__ import annotations

import logging
import re
import tomllib
from pathlib import Path
from typing import Iterator

# Local import for the Skill dataclass — kept here so the loader is
# fully self-contained and can be unit-tested without the rest of the
# package wiring.
from .skills import Skill

log = logging.getLogger(__name__)

# Slug pattern matched by `name` and the folder name. Conservative —
# lowercase, digits, hyphens — to avoid surprises in URLs and paths.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")


def _load_one(skill_dir: Path) -> Skill | None:
    """Parse one ``<skill-dir>/skill.toml`` + ``brief.md``. None on error."""
    toml_path = skill_dir / "skill.toml"
    brief_path = skill_dir / "brief.md"

    if not toml_path.is_file():
        return None
    if not brief_path.is_file():
        log.warning("skill %s: missing brief.md", skill_dir.name)
        return None

    try:
        meta = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        log.warning("skill %s: skill.toml parse failed: %s", skill_dir.name, exc)
        return None

    name = str(meta.get("name") or "").strip()
    if not name or not _SLUG_RE.match(name):
        log.warning(
            "skill %s: invalid or missing 'name' (must be lowercase slug)",
            skill_dir.name,
        )
        return None
    if name != skill_dir.name:
        log.warning(
            "skill %s: name=%r doesn't match directory; using directory name",
            skill_dir.name, name,
        )
        name = skill_dir.name

    display_name = str(meta.get("display_name") or name).strip()
    description = str(meta.get("description") or "").strip()

    triggers = meta.get("triggers") or []
    if not isinstance(triggers, list) or not triggers:
        log.warning("skill %s: needs at least one [[triggers]] block", name)
        return None

    compiled: list[re.Pattern[str]] = []
    for i, trig in enumerate(triggers):
        if not isinstance(trig, dict):
            log.warning("skill %s: trigger #%d not a table; skipping", name, i)
            continue
        pat = str(trig.get("pattern") or "").strip()
        if not pat:
            log.warning("skill %s: trigger #%d has empty pattern", name, i)
            continue
        flag_text = str(trig.get("flags") or "i").lower()
        flags = 0
        if "i" in flag_text:
            flags |= re.IGNORECASE
        if "s" in flag_text:
            flags |= re.DOTALL
        if "m" in flag_text:
            flags |= re.MULTILINE
        try:
            compiled.append(re.compile(pat, flags=flags))
        except re.error as exc:
            log.warning(
                "skill %s: trigger #%d regex invalid (%s); skipping",
                name, i, exc,
            )

    if not compiled:
        log.warning("skill %s: all triggers were invalid; not registering", name)
        return None

    try:
        brief = brief_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        log.warning("skill %s: brief.md read failed: %s", name, exc)
        return None
    if not brief:
        log.warning("skill %s: brief.md is empty", name)
        return None

    return Skill(
        name=name,
        display_name=display_name,
        description=description,
        patterns=tuple(compiled),
        brief=brief,
    )


def load_skills_from_dir(root: Path) -> Iterator[Skill]:
    """Yield ``Skill`` instances for every valid subdir under ``root``.

    Reads in lexical order so the merge order in ``skills.py`` is
    deterministic. Folders without a valid ``skill.toml`` are silently
    ignored (no warning) — the README.md the bootstrap writes is
    explicitly not a skill folder.
    """
    if not root.is_dir():
        return
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        skill = _load_one(child)
        if skill is not None:
            log.info("loaded user skill: %s", skill.name)
            yield skill
