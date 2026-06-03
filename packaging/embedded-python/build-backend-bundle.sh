#!/usr/bin/env bash
# build-backend-bundle.sh — install the backend's deps INTO a relocatable
# python-build-standalone interpreter (not a venv — venvs pin absolute
# build-time paths and break when the tree is moved into the app bundle),
# stage the backend source, prune, and smoke-test that uvicorn runs from
# the (eventually moved) tree.
#
# Usage: ./build-backend-bundle.sh OS PY_ROOT
#   OS       = linux | macos-arm64 | macos-x86_64 | windows
#   PY_ROOT  = build/py-raw/<OS>   (output of fetch-python.sh)
#
# Outputs:
#   PY_ROOT/                 interpreter + deps installed into site-packages
#   build/backend-bundle/    backend source (its own bundle.resources entry)
#
# MUST run on a native runner of the target OS — pydantic-core / psycopg
# wheels are per-OS/arch; cross-installing is impossible. --only-binary
# guarantees we fail at build time rather than compile on a user's machine.

set -euo pipefail

OS="${1:-}"
PY_ROOT="${2:-}"
if [[ -z "$OS" || -z "$PY_ROOT" ]]; then
    echo "usage: $0 OS PY_ROOT" >&2
    exit 1
fi
PY_ROOT="$(cd "$PY_ROOT" && pwd)"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_SRC="$REPO_ROOT/backend"
BUNDLE_OUT="$REPO_ROOT/build/backend-bundle"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Interpreter — windows has no bin/ (python.exe at root); unix is bin/python3.
if [[ "$OS" == "windows" ]]; then
    PY="$PY_ROOT/python.exe"
else
    PY="$PY_ROOT/bin/python3"
fi
[[ -e "$PY" ]] || { echo "interpreter not found at $PY (run fetch-python.sh first)" >&2; exit 1; }

# ── 1. Pin deps to a lockfile (mirror build-deb.sh) ────────────
LOCK="$PY_ROOT/requirements.lock"
if command -v uv >/dev/null; then
    log "exporting pinned deps via uv"
    ( cd "$BACKEND_SRC" && uv export --quiet --no-dev --no-emit-project --format requirements-txt > "$LOCK" )
else
    log "uv not found — extracting deps from pyproject.toml (unpinned)"
    python3 - "$BACKEND_SRC/pyproject.toml" "$LOCK" <<'PY'
import sys, tomllib, pathlib
proj, out = sys.argv[1], sys.argv[2]
data = tomllib.loads(pathlib.Path(proj).read_text())
deps = data.get("project", {}).get("dependencies", [])
pathlib.Path(out).write_text("\n".join(deps) + "\n")
PY
fi
log "deps: $(grep -c . "$LOCK") lines"

# ── 2. Install into the standalone interpreter's site-packages ──
log "upgrading bundled pip"
"$PY" -m pip install --quiet --upgrade pip

log "installing backend deps (binary-only) into the bundled interpreter"
# --only-binary=:all: → fail loudly if any wheel is missing for this
# OS/arch rather than silently compiling from sdist on the build host.
"$PY" -m pip install --no-cache-dir --only-binary=:all: -r "$LOCK"

# ── 3. Stage backend source (mirror build-deb.sh exclude set) ───
log "staging backend source into $BUNDLE_OUT"
rm -rf "$BUNDLE_OUT"
mkdir -p "$BUNDLE_OUT"
if command -v rsync >/dev/null 2>&1; then
    rsync -a \
        --exclude='.env' --exclude='.env.*' --exclude='.venv' \
        --exclude='.git' --exclude='.claude' \
        --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='.pytest_cache' --exclude='.ruff_cache' \
        --exclude='tests' --exclude='build' --exclude='dist' \
        --exclude='*.egg-info' \
        --exclude='Dockerfile' --exclude='docker-compose*.yml' \
        "$BACKEND_SRC/" "$BUNDLE_OUT/"
else
    # Windows runners may not ship rsync. Fall back to a pure-copy mode.
    # We keep this path simple and deterministic; it's good enough for build inputs.
    cp -a "$BACKEND_SRC/." "$BUNDLE_OUT/"
    rm -rf "$BUNDLE_OUT/.env" "$BUNDLE_OUT/.venv" "$BUNDLE_OUT/.git" "$BUNDLE_OUT/.claude" "$BUNDLE_OUT/.pytest_cache" "$BUNDLE_OUT/.ruff_cache" "$BUNDLE_OUT/build" "$BUNDLE_OUT/dist" "$BUNDLE_OUT/tests"
    find "$BUNDLE_OUT" -type d -name '__pycache__' -exec rm -rf {} +
    find "$BUNDLE_OUT" -type d -name '*.egg-info' -exec rm -rf {} +
    find "$BUNDLE_OUT" -type f \( -name '*.pyc' -o -name 'Dockerfile' \) -delete
    for dcfile in "$BUNDLE_OUT"/docker-compose*.yml; do
        [ -e "$dcfile" ] && rm -f "$dcfile"
    done
fi

# ── 4. Prune the interpreter for size ──────────────────────────
log "pruning"
if [[ "$OS" == "windows" ]]; then STDLIB="$PY_ROOT/Lib"; else STDLIB="$PY_ROOT/lib/python3.12"; fi
for d in test lib2to3/tests idlelib tkinter turtledemo; do
    rm -rf "$STDLIB/$d" 2>/dev/null || true
done
find "$PY_ROOT" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
find "$PY_ROOT" -type f -name '*.pyc' -delete 2>/dev/null || true
rm -rf "$PY_ROOT/include" 2>/dev/null || true

# ── 5. Executable bit (so deb/rpm/appimage re-tar keeps it +x) ──
if [[ "$OS" != "windows" ]]; then
    chmod -R u+x "$PY_ROOT/bin" 2>/dev/null || true
    chmod u+x "$PY_ROOT"/lib/libpython3.12.* 2>/dev/null || true
fi

# ── 6. Relocatability + import smoke test (gates the build) ─────
log "smoke test: uvicorn + notesci import from the bundled tree"
"$PY" -m uvicorn --version
PYTHONPATH="$BUNDLE_OUT/src" "$PY" -c "import notesci.main; print('notesci.main import OK')"

log "✅ backend bundled: interpreter+deps in $PY_ROOT, source in $BUNDLE_OUT"
