#!/usr/bin/env bash
# build-rpm.sh — build a notesci .rpm on a Linux host via the Tauri
# bundler. Mirrors the CI Linux job's RPM path.
#
# Usage:
#   ./packaging/build-rpm.sh            # embedded Postgres (one-click)
#   NOSTAGE=1 ./packaging/build-rpm.sh  # system Postgres (dnf deps)
#
# Output: desktop/src-tauri/target/release/bundle/rpm/*.rpm
#
# tauri.conf.json's rpm.depends lists postgresql-server etc., i.e. the
# .rpm CAN lean on system Postgres like the .deb. But if the embedded
# pg/ tree is staged it gets bundled and pg.rs::detect() picks
# Mode::Embedded (embedded wins when pg/ is present). Choose:
#   - EMBEDDED rpm (default): true one-click, ~80MB larger.
#   - SYSTEM rpm  (NOSTAGE=1): relies on dnf postgresql-server + pgvector.
#
# Idempotent. Requires: pnpm, cargo, rust, git, curl, unzip, rpmbuild.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_SCRIPTS="$REPO_ROOT/packaging/embedded-postgres"
RES_DIR="$REPO_ROOT/desktop/src-tauri/resources"
PG_RAW="$REPO_ROOT/build/pg-raw/linux"
NOSTAGE="${NOSTAGE:-0}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }

need pnpm; need cargo; need git; need rpmbuild

# ── 1. Frontend ────────────────────────────────────────────────
log "building frontend"
( cd "$REPO_ROOT/frontend" && pnpm install --frozen-lockfile && pnpm build )

# ── 2/3. Embedded Postgres + stage (unless NOSTAGE=1) ──────────
if [[ "$NOSTAGE" == "1" ]]; then
  log "NOSTAGE=1 — building a SYSTEM-Postgres .rpm; removing any staged pg/ + python/"
  rm -rf "$RES_DIR/pg" "$RES_DIR/python" "$RES_DIR/backend" "$RES_DIR/frontend"
else
  log "fetch + build + prune embedded Postgres (linux)"
  "$PG_SCRIPTS/fetch-pg.sh" linux
  "$PG_SCRIPTS/build-pgvector.sh" "$PG_RAW"
  "$PG_SCRIPTS/prune-pg.sh" "$PG_RAW"
  log "fetch python + build backend bundle (linux)"
  "$REPO_ROOT/packaging/embedded-python/fetch-python.sh" linux
  "$REPO_ROOT/packaging/embedded-python/build-backend-bundle.sh" linux "$REPO_ROOT/build/py-raw/linux"
  log "staging pg/ python/ backend/ frontend/ into $RES_DIR"
  mkdir -p "$RES_DIR"
  rm -rf "$RES_DIR/pg";       cp -r "$PG_RAW"                         "$RES_DIR/pg"
  rm -rf "$RES_DIR/python";   cp -r "$REPO_ROOT/build/py-raw/linux"   "$RES_DIR/python"
  rm -rf "$RES_DIR/backend";  cp -r "$REPO_ROOT/build/backend-bundle" "$RES_DIR/backend"
  rm -rf "$RES_DIR/frontend"; cp -r "$REPO_ROOT/frontend/dist"        "$RES_DIR/frontend"
fi

# ── 4. Build the RPM only ──────────────────────────────────────
log "cargo tauri build --bundles rpm"
( cd "$REPO_ROOT/desktop/src-tauri" \
  && { cargo install --locked tauri-cli --version "^2" 2>/dev/null || true; } \
  && cargo tauri build --bundles rpm )

OUT="$REPO_ROOT/desktop/src-tauri/target/release/bundle/rpm"
log "✅ RPM(s) in $OUT"
ls -lh "$OUT"/*.rpm 2>/dev/null || echo "no .rpm found — check the build log" >&2
