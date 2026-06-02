#!/usr/bin/env bash
# build-pgvector.sh — compile pgvector against an extracted PG tree.
#
# Usage: ./build-pgvector.sh PG_ROOT
#   where PG_ROOT contains bin/pg_config (and bin/postgres).
#
# Drops vector.{so|dylib|dll} into $PG_ROOT/lib/postgresql/ and the
# SQL + control files into $PG_ROOT/share/postgresql/extension/.
#
# Pinned to PGVECTOR_VERSION below. Idempotent.

set -euo pipefail

PGVECTOR_VERSION="0.8.0"
PGVECTOR_REPO="https://github.com/pgvector/pgvector.git"

PG_ROOT="${1:-}"
if [[ -z "$PG_ROOT" ]]; then
    echo "usage: $0 PG_ROOT" >&2
    exit 1
fi
PG_ROOT="$(cd "$PG_ROOT" && pwd)"

PG_CONFIG="$PG_ROOT/bin/pg_config"
[[ -x "$PG_CONFIG" ]] || { echo "no pg_config at $PG_CONFIG" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/build/pgvector-src"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Already installed in the RELOCATED tree? Skip. pg_config reports
# COMPILE-TIME paths (e.g. /usr/lib/postgresql/16 or /Library/...), so we
# check the staged tree directly — both candidate sharedir layouts.
if [[ -f "$PG_ROOT/share/postgresql/extension/vector.control" \
   || -f "$PG_ROOT/share/extension/vector.control" ]]; then
    log "pgvector already staged under $PG_ROOT — skipping"
    exit 0
fi

if [[ ! -d "$SRC/.git" ]]; then
    log "cloning pgvector @ $PGVECTOR_VERSION"
    git clone --depth 1 --branch "v$PGVECTOR_VERSION" "$PGVECTOR_REPO" "$SRC"
else
    log "pgvector source already present at $SRC"
fi

# Use the extracted PG's pg_config so the build links against the
# right server headers and installs into the relocated tree. PGXS
# (the PG extension build system) reads $PG_CONFIG and derives all
# its paths from it.
log "building pgvector via pgxs"
case "$(uname -s)" in
    Linux|Darwin)
        STAGE="$REPO_ROOT/build/pgv-stage"
        rm -rf "$STAGE"
        PG_VECTOR_CFLAGS=""
        if [[ -d "$PG_ROOT/include/postgresql/16/server" ]]; then
            PG_VECTOR_CFLAGS="-I$PG_ROOT/include/postgresql/16/server -I$PG_ROOT/include/postgresql/16/internal"
        elif [[ -d "$PG_ROOT/include/postgresql/server" ]]; then
            PG_VECTOR_CFLAGS="-I$PG_ROOT/include/postgresql/server -I$PG_ROOT/include/postgresql/internal"
        elif [[ -d "$PG_ROOT/include/postgresql/16" ]]; then
            PG_VECTOR_CFLAGS="-I$PG_ROOT/include/postgresql/16"
        elif [[ -d "$PG_ROOT/include" ]]; then
            PG_VECTOR_CFLAGS="-I$PG_ROOT/include"
        fi
        export PG_CPPFLAGS="$PG_VECTOR_CFLAGS"
        make -C "$SRC" clean >/dev/null 2>&1 || true
        make -C "$SRC" PG_CONFIG="$PG_CONFIG" PG_CPPFLAGS="$PG_CPPFLAGS"
        # PostgreSQL's Makefile.global marks pkglibdir / datadir with GNU
        # make `override`, so `make install pkglibdir=… datadir=…` is
        # SILENTLY IGNORED. Install into a throwaway DESTDIR (pg_config's
        # compile-time dirs are honored *under* it), then relocate the
        # two artifacts into the staged tree ourselves.
        make -C "$SRC" PG_CONFIG="$PG_CONFIG" PG_CPPFLAGS="$PG_CPPFLAGS" DESTDIR="$STAGE" install
        CT_PKGLIB="$("$PG_CONFIG" --pkglibdir)"
        CT_SHARE="$("$PG_CONFIG" --sharedir)"
        # The module (vector.so / vector.dylib) is what postgres loads via
        # $libdir. Copy it into every lib dir the relocated server might
        # treat as $libdir — the compile-time pkglibdir tail differs
        # (EnterpriseDB: …/lib, Ubuntu .deb: …/lib/postgresql/16/lib), and
        # pg.rs adds all of these to dynamic_library_path.
        mkdir -p "$PG_ROOT/lib" "$PG_ROOT/lib/postgresql"
        find "$STAGE$CT_PKGLIB" -maxdepth 1 -name 'vector.*' \
            -exec cp -a {} "$PG_ROOT/lib/" \; \
            -exec cp -a {} "$PG_ROOT/lib/postgresql/" \;
        # Extension control + SQL — drop into both candidate sharedir
        # layouts so CREATE EXTENSION finds the control file regardless of
        # whether the relocated server resolves SHAREDIR as share/ or
        # share/postgresql/.
        mkdir -p "$PG_ROOT/share/postgresql/extension" "$PG_ROOT/share/extension"
        cp -a "$STAGE$CT_SHARE/extension/"vector* "$PG_ROOT/share/postgresql/extension/" 2>/dev/null || true
        cp -a "$STAGE$CT_SHARE/extension/"vector* "$PG_ROOT/share/extension/" 2>/dev/null || true
        rm -rf "$STAGE"
        # Fail loudly if nothing landed (e.g. pkglibdir glob no-op).
        if ! ls "$PG_ROOT"/lib/vector.* >/dev/null 2>&1 \
           && ! ls "$PG_ROOT"/lib/postgresql/vector.* >/dev/null 2>&1; then
            echo "pgvector module (vector.{so,dylib}) not found after install" >&2
            exit 1
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*)
        # Windows build is via MSVC — see build-pgvector-win.ps1.
        echo "Windows: use build-pgvector-win.ps1 from PowerShell" >&2
        exit 2
        ;;
    *)
        echo "unsupported uname: $(uname -s)" >&2
        exit 1
        ;;
esac

log "✅ pgvector $PGVECTOR_VERSION staged into $PG_ROOT/{lib,share}"
