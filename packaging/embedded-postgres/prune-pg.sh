#!/usr/bin/env bash
# prune-pg.sh — strip locales / docs / unused modules from a PG tree.
#
# Usage: ./prune-pg.sh PG_ROOT
#
# A vanilla PG 16 install is ~250 MB; after pruning we ship ~80 MB.
# Safe — touches only files notesci doesn't load at runtime.

set -euo pipefail

PG_ROOT="${1:-}"
if [[ -z "$PG_ROOT" ]]; then
    echo "usage: $0 PG_ROOT" >&2
    exit 1
fi
PG_ROOT="$(cd "$PG_ROOT" && pwd)"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
before=$(du -sm "$PG_ROOT" | cut -f1)
log "pruning $PG_ROOT (currently ${before} MB)"

# Docs + manpages — never read at runtime.
rm -rf "$PG_ROOT/share/doc" "$PG_ROOT/share/man" "$PG_ROOT/doc" 2>/dev/null || true

# Locales — keep only en_US.UTF-8 (initdb default). Removing other
# locales is the single biggest size win on macOS/Windows builds.
if [[ -d "$PG_ROOT/share/locale" ]]; then
    find "$PG_ROOT/share/locale" -mindepth 1 -maxdepth 1 -type d \
        ! -name 'en' ! -name 'en_US' -exec rm -rf {} +
fi

# Contrib modules we don't use. notesci needs:
#   - vector (pgvector — installed by build-pgvector.sh)
#   - pg_trgm (used for tsv fallback fuzzy search)
#   - btree_gin (gin index optimization)
# Everything else can go.
KEEP_RE='vector|pg_trgm|btree_gin'
if [[ -d "$PG_ROOT/share/extension" ]]; then
    find "$PG_ROOT/share/extension" -mindepth 1 -maxdepth 1 \
        ! -regextype posix-extended ! -regex ".*/(${KEEP_RE})(\..*|--.*)?" \
        -exec rm -rf {} + 2>/dev/null || true
fi
if [[ -d "$PG_ROOT/lib/postgresql" ]]; then
    find "$PG_ROOT/lib/postgresql" -mindepth 1 -maxdepth 1 -type f \
        ! -regextype posix-extended ! -regex ".*/(${KEEP_RE})\.(so|dylib|dll)" \
        -name '*.so' -delete 2>/dev/null || true
    find "$PG_ROOT/lib/postgresql" -mindepth 1 -maxdepth 1 -type f \
        ! -regextype posix-extended ! -regex ".*/(${KEEP_RE})\.(so|dylib|dll)" \
        -name '*.dylib' -delete 2>/dev/null || true
fi

# Standalone client utilities we don't ship: pgbench, pg_dumpall (we use
# pg_dump for backups), psql shell utilities other than psql itself,
# replication helpers (single-user has no replicas).
for tool in pgbench pg_dumpall pg_receivewal pg_recvlogical pg_archivecleanup \
            pg_resetwal pg_test_fsync pg_test_timing pg_upgrade pg_verifybackup \
            pg_waldump pg_standby ecpg vacuumdb reindexdb clusterdb createuser \
            dropuser createdb dropdb; do
    rm -f "$PG_ROOT/bin/$tool" "$PG_ROOT/bin/$tool.exe" 2>/dev/null || true
done

# Strip debug symbols from binaries to shave more.
if command -v strip >/dev/null; then
    find "$PG_ROOT/bin" "$PG_ROOT/lib" -type f \
        \( -name '*.so' -o -name '*.so.*' -o -name 'postgres' -o -name 'psql' -o -name 'initdb' -o -name 'pg_ctl' \) \
        -exec strip --strip-unneeded {} + 2>/dev/null || true
fi

after=$(du -sm "$PG_ROOT" | cut -f1)
log "✅ pruned ${before} MB → ${after} MB"
