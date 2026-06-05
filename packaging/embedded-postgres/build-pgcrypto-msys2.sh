#!/usr/bin/env bash
# build-pgcrypto-msys2.sh - build PostgreSQL contrib/pgcrypto for MSYS2 UCRT64.
#
# The MSYS2 PostgreSQL package gives us the server/runtime tree, but pgcrypto is
# not always present in that binary package. notesci migrations require
# CREATE EXTENSION pgcrypto, so Windows release builds compile the contrib module
# from the matching PostgreSQL source release and install it into the MSYS2 PG
# tree before staging the embedded bundle.

set -euo pipefail

PG_VERSION="${PG_VERSION:-16.14}"
PG_MAJOR="${PG_VERSION%%.*}"
MSYS2_PREFIX="${MSYS2_PREFIX:-/ucrt64}"
PG_CONFIG="${PG_CONFIG:-$MSYS2_PREFIX/opt/pg-$PG_MAJOR/bin/pg_config}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$REPO_ROOT/build"
ARCHIVE="$BUILD/postgresql-$PG_VERSION.tar.bz2"
SRC="$BUILD/postgresql-$PG_VERSION-src"
URL="https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ ! -x "$PG_CONFIG" ]]; then
    echo "missing pg_config: $PG_CONFIG" >&2
    echo "Install mingw-w64-ucrt-x86_64-postgresql-$PG_MAJOR in an MSYS2 UCRT64 shell." >&2
    exit 1
fi

export PATH="$(dirname "$PG_CONFIG"):$MSYS2_PREFIX/bin:$PATH"

PKGLIBDIR="$("$PG_CONFIG" --pkglibdir)"
SHAREDIR="$("$PG_CONFIG" --sharedir)"
if [[ -f "$PKGLIBDIR/pgcrypto.dll" && -f "$SHAREDIR/extension/pgcrypto.control" ]]; then
    log "pgcrypto already installed under $PKGLIBDIR — skipping"
    exit 0
fi

mkdir -p "$BUILD"
if [[ ! -f "$ARCHIVE" ]]; then
    log "downloading PostgreSQL source $URL"
    curl -fL --retry 5 --retry-all-errors -o "$ARCHIVE" "$URL"
fi

rm -rf "$SRC"
log "extracting PostgreSQL source"
mkdir -p "$SRC"
tar -xjf "$ARCHIVE" --strip-components=1 -C "$SRC"

log "building contrib/pgcrypto against $PG_CONFIG"
(
    cd "$SRC/contrib/pgcrypto"
    make USE_PGXS=1 PG_CONFIG="$PG_CONFIG" clean || true
    make USE_PGXS=1 PG_CONFIG="$PG_CONFIG"
    make USE_PGXS=1 PG_CONFIG="$PG_CONFIG" install
)

[[ -f "$PKGLIBDIR/pgcrypto.dll" ]] || { echo "pgcrypto.dll missing after install: $PKGLIBDIR" >&2; exit 1; }
[[ -f "$SHAREDIR/extension/pgcrypto.control" ]] || { echo "pgcrypto.control missing after install: $SHAREDIR/extension" >&2; exit 1; }

log "pgcrypto installed into MSYS2 PostgreSQL $PG_MAJOR"
