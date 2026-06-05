#!/usr/bin/env bash
# stage-msys2-pg.sh - stage MSYS2 UCRT64 PostgreSQL into notesci's pg bundle.
#
# Output: build/pg-raw/windows/{bin,lib,share,include}
# The staged layout intentionally matches the EDB layout consumed by pg.rs:
# postgres helpers in bin/, extensions in lib/ + share/extension/.

set -euo pipefail

PG_VERSION="${PG_VERSION:-16.14}"
PG_MAJOR="${PG_VERSION%%.*}"
MSYS2_PREFIX="${MSYS2_PREFIX:-/ucrt64}"
PG_SOURCE="${PG_SOURCE:-$MSYS2_PREFIX/opt/pg-$PG_MAJOR}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$REPO_ROOT/build/pg-raw/windows"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ ! -f "$PG_SOURCE/bin/postgres.exe" ]]; then
    echo "missing MSYS2 PostgreSQL tree: $PG_SOURCE" >&2
    echo "Install mingw-w64-ucrt-x86_64-postgresql-$PG_MAJOR in an MSYS2 UCRT64 shell." >&2
    exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

log "staging PostgreSQL from $PG_SOURCE"
for dir in bin lib share include; do
    if [[ -d "$PG_SOURCE/$dir" ]]; then
        cp -a "$PG_SOURCE/$dir" "$DEST/$dir"
    fi
done

# MSYS2 places transitive runtime DLLs in /ucrt64/bin. Bundle them beside the
# PostgreSQL executables so initdb/pg_ctl/postgres resolve dependencies without
# requiring a global MSYS2 installation on user machines.
cp -a "$MSYS2_PREFIX/bin/"*.dll "$DEST/bin/" 2>/dev/null || true

# Normalize MSYS2's PostgreSQL extension layout to the EDB-compatible layout
# the desktop launcher and CI smoke tests expect.
mkdir -p "$DEST/share/extension"
if [[ -d "$DEST/share/postgresql/extension" ]]; then
    cp -a "$DEST/share/postgresql/extension/"* "$DEST/share/extension/" 2>/dev/null || true
fi

if [[ ! -f "$DEST/lib/vector.dll" ]]; then
    VECTOR_DLL="$(find "$DEST/lib" -maxdepth 3 -iname 'vector.dll' -print -quit)"
    if [[ -n "$VECTOR_DLL" ]]; then
        cp -a "$VECTOR_DLL" "$DEST/lib/vector.dll"
    fi
fi

if [[ ! -f "$DEST/share/extension/vector.control" ]]; then
    VECTOR_CONTROL="$(find "$DEST/share" -maxdepth 4 -iname 'vector.control' -print -quit)"
    if [[ -n "$VECTOR_CONTROL" ]]; then
        cp -a "$VECTOR_CONTROL" "$DEST/share/extension/vector.control"
    fi
fi

required=(
    "$DEST/bin/postgres.exe"
    "$DEST/bin/initdb.exe"
    "$DEST/bin/pg_ctl.exe"
    "$DEST/bin/psql.exe"
    "$DEST/bin/libpq.dll"
    "$DEST/lib/vector.dll"
    "$DEST/share/extension/vector.control"
)
for path in "${required[@]}"; do
    [[ -f "$path" ]] || { echo "missing staged artifact: $path" >&2; exit 1; }
done

log "MSYS2 PostgreSQL $PG_VERSION staged at $DEST ($(du -sh "$DEST" | cut -f1))"
