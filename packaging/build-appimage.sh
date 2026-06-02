#!/usr/bin/env bash
# build-appimage.sh — build a notesci .AppImage with embedded Postgres
# on a Linux host. Mirrors the CI Linux job's AppImage path so you can
# reproduce it locally.
#
# Usage:  ./packaging/build-appimage.sh
#
# Output: desktop/src-tauri/target/release/bundle/appimage/*.AppImage
#
# Idempotent — fetch/build/prune scripts skip work that's already done.
# Requires: pnpm, cargo, rust, git, curl, unzip, dpkg-deb, apt-get,
#           and the Tauri Linux build deps (libwebkit2gtk-4.1-dev,
#           libsoup-3.0-dev, librsvg2-dev, patchelf, libfuse2, ...).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_SCRIPTS="$REPO_ROOT/packaging/embedded-postgres"
RES_DIR="$REPO_ROOT/desktop/src-tauri/resources"
PG_RAW="$REPO_ROOT/build/pg-raw/linux"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }

need pnpm; need cargo; need git; need curl; need unzip

# ── 1. Frontend ────────────────────────────────────────────────
log "building frontend"
( cd "$REPO_ROOT/frontend" && pnpm install --frozen-lockfile && pnpm build )

# ── 2. Embedded Postgres + pgvector ────────────────────────────
log "fetch + build + prune embedded Postgres (linux)"
"$PG_SCRIPTS/fetch-pg.sh" linux
"$PG_SCRIPTS/build-pgvector.sh" "$PG_RAW"
"$PG_SCRIPTS/prune-pg.sh" "$PG_RAW"

# ── 3. Stage pg/ into the Tauri resource dir ───────────────────
# tauri.conf.json maps resources/pg/ -> $RESOURCE/pg via bundle.resources.
log "staging pg/ into $RES_DIR/pg"
rm -rf "$RES_DIR/pg"
mkdir -p "$RES_DIR"
cp -r "$PG_RAW" "$RES_DIR/pg"

# ── 3b. Embedded Python + backend deps + frontend dist ─────────
log "fetch python + build backend bundle (linux)"
"$REPO_ROOT/packaging/embedded-python/fetch-python.sh" linux
"$REPO_ROOT/packaging/embedded-python/build-backend-bundle.sh" linux "$REPO_ROOT/build/py-raw/linux"
log "staging python/ backend/ frontend/ into $RES_DIR"
rm -rf "$RES_DIR/python";   cp -r "$REPO_ROOT/build/py-raw/linux"   "$RES_DIR/python"
rm -rf "$RES_DIR/backend";  cp -r "$REPO_ROOT/build/backend-bundle" "$RES_DIR/backend"
rm -rf "$RES_DIR/frontend"; cp -r "$REPO_ROOT/frontend/dist"        "$RES_DIR/frontend"

# ── 4. Build the AppImage only ─────────────────────────────────
# AppImage embeds PG (Mode::Embedded). We build ONLY appimage here so
# the embedded pg/ doesn't accidentally get baked into a .deb (the .deb
# is meant to use system Postgres — build it with packaging/build-deb.sh
# WITHOUT pg/ staged).
log "cargo tauri build --bundles appimage"
( cd "$REPO_ROOT/desktop/src-tauri" \
  && { cargo install --locked tauri-cli --version "^2" 2>/dev/null || true; } \
  && cargo tauri build --bundles appimage )

OUT="$REPO_ROOT/desktop/src-tauri/target/release/bundle/appimage"
log "✅ AppImage(s) in $OUT"
ls -lh "$OUT"/*.AppImage 2>/dev/null || echo "no .AppImage found — check the build log" >&2
