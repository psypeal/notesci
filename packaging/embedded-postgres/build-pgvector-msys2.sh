#!/usr/bin/env bash
# build-pgvector-msys2.sh - build pgvector for the MSYS2 UCRT64 PostgreSQL tree.
#
# This is used by the Windows release workflow because the EDB binary archive
# CDN can reject GitHub-hosted runners. MSYS2 publishes PostgreSQL 16 packages
# through pacman, so we can build pgvector against that tree and then stage a
# relocatable runtime bundle for Tauri.

set -euo pipefail

PG_VERSION="${PG_VERSION:-16.14}"
PGVECTOR_VERSION="${PGVECTOR_VERSION:-0.8.0}"
PG_MAJOR="${PG_VERSION%%.*}"
MSYS2_PREFIX="${MSYS2_PREFIX:-/ucrt64}"
PG_CONFIG="${PG_CONFIG:-$MSYS2_PREFIX/opt/pg-$PG_MAJOR/bin/pg_config}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${WORKDIR:-$REPO_ROOT/build/pgvector-src-msys2}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ ! -x "$PG_CONFIG" ]]; then
    echo "missing pg_config: $PG_CONFIG" >&2
    echo "Install mingw-w64-ucrt-x86_64-postgresql-$PG_MAJOR in an MSYS2 UCRT64 shell." >&2
    exit 1
fi

export PATH="$(dirname "$PG_CONFIG"):$MSYS2_PREFIX/bin:$PATH"

PKGLIBDIR="$("$PG_CONFIG" --pkglibdir)"
SHAREDIR="$("$PG_CONFIG" --sharedir)"
if [[ -f "$PKGLIBDIR/vector.dll" && -f "$SHAREDIR/extension/vector.control" ]]; then
    log "pgvector already installed under $PKGLIBDIR — skipping"
    exit 0
fi

rm -rf "$WORKDIR"
log "cloning pgvector v$PGVECTOR_VERSION"
git clone --depth 1 --branch "v$PGVECTOR_VERSION" https://github.com/pgvector/pgvector.git "$WORKDIR"

log "building pgvector against $PG_CONFIG"
(
    cd "$WORKDIR"
    make PG_CONFIG="$PG_CONFIG" clean || true
    make PG_CONFIG="$PG_CONFIG"
    make PG_CONFIG="$PG_CONFIG" install
)

[[ -f "$PKGLIBDIR/vector.dll" ]] || { echo "vector.dll missing after install: $PKGLIBDIR" >&2; exit 1; }
[[ -f "$SHAREDIR/extension/vector.control" ]] || { echo "vector.control missing after install: $SHAREDIR/extension" >&2; exit 1; }

log "pgvector v$PGVECTOR_VERSION installed into MSYS2 PostgreSQL $PG_MAJOR"
