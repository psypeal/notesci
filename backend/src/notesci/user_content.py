"""User-content directory layout — the disk home for installable
skills, MCP recipes, and (later) memory exports.

Layout (XDG-compliant):

    $XDG_CONFIG_HOME/notesci/         # default: ~/.config/notesci/
      ├── skills/                     user-authored skill briefs
      │   └── <skill-id>/
      │       ├── skill.toml          metadata + triggers
      │       ├── brief.md            system-prompt addition
      │       └── scripts/            optional helper scripts
      ├── mcps/                       user-authored MCP recipes
      │   └── <mcp-id>/
      │       └── mcp.toml            command, transport, env, secret names
      ├── plugins/                    locally installed Codex/Claude plugins
      │   └── <plugin-id>/
      └── notesci.toml                user-level config (model defaults, etc.)

    $XDG_DATA_HOME/notesci/           # default: ~/.local/share/notesci/
      ├── memory/                     reserved — markdown shadow (later slice)
      └── logs/                       reserved — runtime logs

The split is deliberate. ``$XDG_CONFIG_HOME`` is for things the user
(or an agent acting on the user's behalf) authors and edits;
``$XDG_DATA_HOME`` is for things the runtime maintains.

Why not ``~/.notesci/`` flat: XDG separation lets users back up just
``config/`` for portability (recipes carry over to a new machine)
without dragging gigabytes of cached state.

The Tauri shell already uses ``~/.local/share/com.notesci.app/`` for
the WebView cache; that's a separate concern (system-managed by the
WebKit runtime, not by us) and we keep it untouched.

Single-call ``bootstrap()`` is called from the FastAPI lifespan on
startup. Idempotent — re-running creates no extra state and never
clobbers user-edited files.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)


def _xdg(env_var: str, default_subpath: str) -> Path:
    """Resolve an XDG path, falling back to ``$HOME/<default_subpath>``.

    Minimal XDG: we don't honor the precedence chain
    (``$XDG_CONFIG_DIRS`` etc.) — for a single-user desktop app the
    primary directory is the only one that matters."""
    raw = os.environ.get(env_var, "").strip()
    if raw:
        return Path(raw)
    return Path.home() / default_subpath


# Config root — user-authored content (skills, MCP recipes, prefs).
CONFIG_ROOT: Path = _xdg("XDG_CONFIG_HOME", ".config") / "notesci"
SKILLS_DIR: Path = CONFIG_ROOT / "skills"
MCPS_DIR: Path = CONFIG_ROOT / "mcps"
PLUGINS_DIR: Path = CONFIG_ROOT / "plugins"
USER_TOML: Path = CONFIG_ROOT / "notesci.toml"

# Data root — runtime-managed state.
DATA_ROOT: Path = _xdg("XDG_DATA_HOME", ".local/share") / "notesci"
MEMORY_DIR: Path = DATA_ROOT / "memory"
LOGS_DIR: Path = DATA_ROOT / "logs"


_SKILLS_README = """\
# notesci · custom skills

This directory is your home for **custom skills** — narrow domain
expertise that activates automatically when a user message matches one
of the skill's trigger patterns. Skills here are *merged* with
notesci's built-in skills; if you name a skill the same as a built-in,
yours wins.

## Layout

```
~/.config/notesci/skills/
└── <skill-id>/                 lowercase-hyphenated; this is the skill name
    ├── skill.toml              required — metadata + triggers
    ├── brief.md                required — the system-prompt addition
    └── scripts/                optional — helper scripts the skill may invoke
```

## `skill.toml` schema

```toml
# Required: identity.
name         = "citation-polisher"     # must match the directory name
display_name = "Citation polish"
description  = "Normalize in-text citations to Vancouver style."

# At least one trigger required. Each trigger is a case-insensitive
# regex matched against the user's message. The skill activates on
# first match.
[[triggers]]
pattern = '\\b(polish|fix|normalize)\\b.{0,40}\\b(cit(es?|ations?)|refs?)\\b'

[[triggers]]
pattern = '/polish-cites'                 # slash-command style
```

## `brief.md`

Plain markdown — the body becomes a system message prepended to the
agent's prompt when the skill activates. Keep it tight (~400 tokens
or less). Lead with directives ("You are X. Follow these rules…"),
not background.

## Reload

Skills load at backend startup. Edit a file, restart the app to apply.
(Future: filesystem watch + hot reload.)

## Examples

Run `ls /opt/notesci/backend/src/notesci/` and read `skills.py` for the
shape of the built-in skills.
"""


_MCPS_README = """\
# notesci · custom MCP recipes

This directory is your home for **custom MCP server recipes** — Model
Context Protocol servers the agent can use as tools. Recipes here are
*merged* with notesci's built-in MCP catalog; if you name an MCP the
same as a built-in, yours wins.

A **recipe** describes how to launch the server. The **install** (which
servers are enabled, which tools are granted, encrypted API keys) lives
in the Postgres `mcp_servers` table — managed via Settings → MCP
servers in the app. **Never** put plaintext secrets in this folder.

## Layout

```
~/.config/notesci/mcps/
└── <mcp-id>/                   lowercase-hyphenated
    ├── mcp.toml                required — launch config
    └── README.md               optional — what this MCP does, where to get keys
```

## `mcp.toml` schema

```toml
# Identity.
id          = "arxiv-search"     # must match the directory name
name        = "arXiv search"
description = "Search arXiv preprints by topic / author / date."
category    = "Research"         # Featured | Research | Writing | Data | Productivity | Code | Web | Lab tools
author      = "you@example.com"

# Transport: stdio | http | sse
transport = "stdio"

# For stdio: how to launch the server process.
command = "uvx"
args    = ["arxiv-mcp-server"]

# Static env vars passed to the child process.
[env]
ARXIV_MAX_RESULTS = "10"

# Names of secrets the user must set in Settings → MCP. The actual
# values live encrypted in Postgres; this file only declares what's
# required. PLAINTEXT SECRETS HERE WILL BE REJECTED.
[secrets]
required = ["ARXIV_API_KEY"]
```

## Installing

After dropping a recipe here and restarting the app, the new MCP appears
in Settings → MCP servers alongside the built-ins. Click Install, grant
tools, set any required secrets. The agent picks it up next turn.

## Examples

The built-in catalog at `/opt/notesci/backend/src/notesci/mcp_catalog.py`
is the canonical reference for the shape.
"""


_CONFIG_README = """\
# notesci · user content

User-authored content lives here. Survives reinstalls and is
intentionally hand-editable.

- `skills/` — custom skills the agent activates on matching prompts.
- `mcps/` — custom MCP server recipes.
- `plugins/` — locally installed plugin folders.
- `notesci.toml` — user-level config (default model, retrieval mode, etc.)

Reload semantics: changes apply on next backend start.

Backups: copy this whole tree to a new machine to carry your
customizations over.
"""


_PLUGINS_README = """\
# notesci · local plugins

This directory stores plugins installed from the curated marketplace.
Each plugin lives in its own folder and keeps its upstream manifest,
commands, hooks, skills, scripts, and assets together.

Layout:

```
~/.config/notesci/plugins/
└── <plugin-id>/
    └── .claude-plugin/plugin.json
```

Installed plugins are local files. Delete a plugin folder to remove it,
or reinstall from the marketplace to refresh the bundled copy.
"""


_MEMORY_README = """\
# notesci · memory (data root)

Reserved directory. Long-term memory currently lives in Postgres (see
the `memories` table). A future slice will write a markdown shadow
here for portability and direct editing.

Don't manually edit files in this directory — they aren't read by the
runtime yet.
"""


_FILES_TO_BOOTSTRAP: tuple[tuple[Path, str], ...] = (
    # config root
    (CONFIG_ROOT / "README.md", _CONFIG_README),
    (SKILLS_DIR / "README.md", _SKILLS_README),
    (MCPS_DIR / "README.md", _MCPS_README),
    (PLUGINS_DIR / "README.md", _PLUGINS_README),
    # data root
    (MEMORY_DIR / "README.md", _MEMORY_README),
)


def bootstrap() -> dict[str, str]:
    """Create the user-content directory tree and seed READMEs.

    Idempotent — never clobbers an existing file, only ensures the
    directory exists and writes the README if it doesn't. Returns a
    summary dict suitable for logging.

    Permissions are tightened to 0o700 (config) since the recipes
    name secrets the agent may use; 0o755 is fine for the data root.
    """
    summary: dict[str, str] = {}

    # Mode 0o700: same protection as ~/.ssh/. Skill briefs aren't
    # sensitive on their own but MCP recipes name secrets, and the
    # config root may grow more sensitive content over time.
    for d in (CONFIG_ROOT, SKILLS_DIR, MCPS_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True, mode=0o700)
            # mkdir(mode=...) only sets perms on creation — chmod
            # afterward to fix a pre-existing too-loose directory.
            d.chmod(0o700)
            summary[str(d)] = "ready"
        except Exception as exc:
            log.warning("user_content bootstrap: failed to create %s: %s", d, exc)
            summary[str(d)] = f"failed: {exc}"

    for d in (DATA_ROOT, MEMORY_DIR, LOGS_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True, mode=0o755)
            summary[str(d)] = "ready"
        except Exception as exc:
            log.warning("user_content bootstrap: failed to create %s: %s", d, exc)
            summary[str(d)] = f"failed: {exc}"

    for path, content in _FILES_TO_BOOTSTRAP:
        try:
            if path.exists():
                continue
            path.write_text(content, encoding="utf-8")
            summary[str(path)] = "seeded"
        except Exception as exc:
            log.warning("user_content bootstrap: failed to seed %s: %s", path, exc)
            summary[str(path)] = f"failed: {exc}"

    log.info("user_content bootstrap: %s", summary)
    return summary
