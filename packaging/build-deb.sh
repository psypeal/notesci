#!/usr/bin/env bash
# build-deb.sh — assemble a native notesci .deb for local install.
#
# Usage:
#   ./packaging/build-deb.sh              # uses default version from pyproject.toml
#   ./packaging/build-deb.sh 0.2.0        # explicit version
#
# Output: ./build/notesci_VERSION_amd64.deb
#
# Idempotent — re-runs scrub the staging tree first.

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packaging"
BUILD_DIR="$REPO_ROOT/build"
VERSION="${1:-$(grep -E '^version = ' "$REPO_ROOT/backend/pyproject.toml" | head -1 | cut -d'"' -f2)}"
ARCH=amd64
STAGE="$BUILD_DIR/notesci_${VERSION}_${ARCH}"
DEB="$BUILD_DIR/notesci_${VERSION}_${ARCH}.deb"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "notesci .deb build · version $VERSION · arch $ARCH"

# ── Tooling sanity ────────────────────────────────────────────
need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }
need dpkg-deb
need pnpm
need gzip
need python3.12      # for `pip download` — needs to match target ABI
need cargo           # for building the Tauri desktop binary

HAVE_UV=0
command -v uv >/dev/null && HAVE_UV=1

# Reality check: Tauri 2 needs the system webkit/soup dev headers to
# link. Two strategies:
#   - LOCAL build (preferred when host has the deps): faster, simpler
#   - DOCKER build (fallback): uses packaging/Dockerfile.tauri-builder
#     to provide an isolated env with the right deps. Adds ~2 minutes
#     for the container start-up but avoids requiring sudo on the host.
TAURI_BUILD_MODE=local
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null || \
   ! pkg-config --exists libsoup-3.0 2>/dev/null; then
  if command -v docker >/dev/null && docker image inspect notesci-tauri-builder >/dev/null 2>&1; then
    TAURI_BUILD_MODE=docker
    log "host lacks webkit2gtk dev headers — falling back to docker builder"
  elif command -v docker >/dev/null; then
    log "building docker image notesci-tauri-builder (one-time, ~2min)"
    docker build -t notesci-tauri-builder -f "$PKG_DIR/Dockerfile.tauri-builder" "$PKG_DIR"
    TAURI_BUILD_MODE=docker
  else
    cat >&2 <<EOF
Cannot build Tauri binary: neither webkit2gtk dev headers nor docker
is available. Pick one:

  Option A — install build deps on the host:
    sudo apt install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev \\
      libjavascriptcoregtk-4.1-dev librsvg2-dev \\
      libayatana-appindicator3-dev build-essential pkg-config

  Option B — install docker so this script can use the bundled
  Dockerfile.tauri-builder instead:
    sudo apt install -y docker.io && sudo usermod -aG docker \$USER

EOF
    exit 1
  fi
fi

# ── Clean staging ─────────────────────────────────────────────
log "cleaning $STAGE"
rm -rf "$STAGE" "$DEB"
mkdir -p "$STAGE"

# ── DEBIAN/ control files ─────────────────────────────────────
log "writing DEBIAN/ control files"
mkdir -p "$STAGE/DEBIAN"
sed "s|__VERSION__|$VERSION|" "$PKG_DIR/debian/control.in" > "$STAGE/DEBIAN/control"
install -m 0755 "$PKG_DIR/debian/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$PKG_DIR/debian/prerm"    "$STAGE/DEBIAN/prerm"
install -m 0755 "$PKG_DIR/debian/postrm"   "$STAGE/DEBIAN/postrm"

# ── Backend source tree → /opt/notesci/backend ────────────────
log "staging backend source"
mkdir -p "$STAGE/opt/notesci"
# Include only what the runtime needs. Critical excludes — never ship:
#   .env*         — LOCAL DEV SECRETS (API keys, dev DB password). Real
#                   config lives in /etc/notesci/notesci.conf, seeded by
#                   postinst. Shipping .env would leak the build host's
#                   keys to every install.
#   .venv         — we build a fresh one below
#   .claude       — Claude Code session state, repo-local tooling
#   __pycache__/, *.pyc — regenerated on first import
#   .pytest_cache, .ruff_cache — dev artifacts
#   tests/        — not shipped
#   Dockerfile, docker-compose.yml — not relevant to .deb install
rsync -a \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.venv' \
  --exclude='.claude' \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='.dockerignore' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache' \
  --exclude='.ruff_cache' \
  --exclude='tests' \
  --exclude='build' \
  --exclude='dist' \
  --exclude='*.egg-info' \
  --exclude='Dockerfile' \
  --exclude='docker-compose*.yml' \
  "$REPO_ROOT/backend/" "$STAGE/opt/notesci/backend/"

# ── Frontend build → /opt/notesci/frontend ────────────────────
log "building frontend (pnpm build)"
( cd "$REPO_ROOT/frontend" && pnpm build >/dev/null )

log "staging frontend dist/"
mkdir -p "$STAGE/opt/notesci/frontend"
rsync -a "$REPO_ROOT/frontend/dist/" "$STAGE/opt/notesci/frontend/"

# ── Tauri desktop binary → /opt/notesci/bin/notesci ───────────
# Built after the frontend so Tauri's bundler can embed the dist/.
# We do NOT use `cargo tauri build` (which would produce a separate
# .deb); just compile the Rust binary and stage it ourselves so the
# full package (Tauri binary + Python venv + wheels + backend source
# + frontend + config + .desktop) ships as one .deb.
if [ "$TAURI_BUILD_MODE" = "docker" ]; then
  log "building Tauri desktop binary inside docker"
  docker run --rm \
    -v "$REPO_ROOT":/work \
    -v notesci-cargo-cache:/cargo-cache \
    -v notesci-cargo-target:/cargo-target \
    -e CARGO_HOME=/cargo-cache \
    -e CARGO_TARGET_DIR=/cargo-target \
    notesci-tauri-builder \
    bash -c "cd /work/desktop/src-tauri && cargo build --release --quiet && cp /cargo-target/release/notesci /work/desktop/src-tauri/target/release/notesci"
  # Note: docker writes the binary as root inside the host bind mount.
  # That's fine — chmod 0755 means we can still install it; dpkg-deb
  # rewrites ownership via --root-owner-group below.
else
  log "building Tauri desktop binary (cargo build --release)"
  ( cd "$REPO_ROOT/desktop/src-tauri" && cargo build --release --quiet )
fi

log "staging Tauri binary"
install -d -m 0755 "$STAGE/opt/notesci/bin"
install -m 0755 "$REPO_ROOT/desktop/src-tauri/target/release/notesci" \
  "$STAGE/opt/notesci/bin/notesci"

# ── Wheels → /opt/notesci/wheels (offline install bundle) ─────
# Ship pre-downloaded wheels alongside a pinned requirements.txt so
# the postinst can build the venv ON THE TARGET MACHINE using the
# target's Python — no cross-Python ABI mismatches, no PATH leaks
# from the build host, no need for internet at install time. The
# .deb stays self-contained but reinstall semantics improve: a
# broken venv can be rebuilt from the bundled wheels without
# touching the .deb.
log "extracting pinned dependencies"
REQ="$STAGE/opt/notesci/wheels/requirements.txt"
mkdir -p "$STAGE/opt/notesci/wheels"
if [ "$HAVE_UV" -eq 1 ]; then
  ( cd "$REPO_ROOT/backend" && uv export --quiet --no-dev --no-emit-project --format requirements-txt > "$REQ" )
else
  log "uv not available — falling back to pyproject.toml deps (unpinned)"
  python3.12 -c "
import tomllib, sys
with open('$REPO_ROOT/backend/pyproject.toml','rb') as f:
  d = tomllib.load(f)
sys.stdout.write('\n'.join(d['project']['dependencies']))
" > "$REQ"
fi

log "downloading wheels for $(wc -l < "$REQ" | tr -d ' ') deps (this takes a minute)"
# --only-binary=:all: refuses to fall back to sdist (source) tarballs.
# This catches the "package shipped no wheel for our platform" case at
# BUILD time instead of producing a .deb whose postinst then needs gcc
# + libpq-dev + libpython3.12-dev on the target to compile from source.
# If a dep is sdist-only we want to know NOW, not in the field.
#
# We let pip pick the host platform tag rather than pinning to e.g.
# manylinux2014 — newer C-extension wheels (argon2-cffi-bindings 25.x,
# etc.) only ship manylinux_2_28 / manylinux_2_34 tags, and a stricter
# pin would silently lose them. Since this .deb is amd64-only and we
# build on the same Ubuntu version as the install target, the host
# platform tag is the right one.
python3.12 -m pip download \
  --quiet \
  --no-cache-dir \
  --resume-retries 5 \
  --only-binary=:all: \
  --dest "$STAGE/opt/notesci/wheels" \
  -r "$REQ"

# Also bundle a pinned pip + setuptools + wheel so the postinst's
# venv has a known, audited installer rather than whatever ensurepip
# from the target's python3.12-venv ships.
python3.12 -m pip download \
  --quiet \
  --no-cache-dir \
  --resume-retries 5 \
  --only-binary=:all: \
  --dest "$STAGE/opt/notesci/wheels" \
  pip setuptools wheel

# ── Config + desktop entry + icons + docs ────────────────────
# Note: we INTENTIONALLY no longer ship a systemd unit. The Tauri
# desktop binary spawns the backend on app launch and kills it on
# app exit — that's the lifecycle now. Pre-Tauri installs that
# already have notesci.service are cleaned up by postinst.
log "staging /etc/notesci, /usr/share/applications, /usr/share/icons, /usr/share/doc"
install -d -m 0755 "$STAGE/etc/notesci"
install -m 0644 "$PKG_DIR/etc/notesci.conf.example" "$STAGE/etc/notesci/notesci.conf.example"

# Desktop entry — makes notesci show up in the apps menu.
install -d -m 0755 "$STAGE/usr/share/applications"
install -m 0644 "$PKG_DIR/desktop/notesci.desktop" \
  "$STAGE/usr/share/applications/notesci.desktop"

# Icons — hicolor theme, sized for the standard apps slots so window
# managers and launchers pick them up at the right resolution.
for size in 32 128 256 512; do
  install -d -m 0755 "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
done
install -m 0644 "$REPO_ROOT/desktop/src-tauri/icons/32x32.png"     "$STAGE/usr/share/icons/hicolor/32x32/apps/notesci.png"
install -m 0644 "$REPO_ROOT/desktop/src-tauri/icons/128x128.png"   "$STAGE/usr/share/icons/hicolor/128x128/apps/notesci.png"
install -m 0644 "$REPO_ROOT/desktop/src-tauri/icons/128x128@2x.png" "$STAGE/usr/share/icons/hicolor/256x256/apps/notesci.png"
install -m 0644 "$REPO_ROOT/desktop/src-tauri/icons/icon.png"       "$STAGE/usr/share/icons/hicolor/512x512/apps/notesci.png"

install -d -m 0755 "$STAGE/usr/share/doc/notesci"
install -m 0644 "$PKG_DIR/docs/copyright"        "$STAGE/usr/share/doc/notesci/copyright"
install -m 0644 "$PKG_DIR/docs/README.Debian"    "$STAGE/usr/share/doc/notesci/README.Debian"
# Minimal changelog so lintian doesn't complain.
{
  echo "notesci ($VERSION) unstable; urgency=low"
  echo
  echo "  * Local-build .deb of the current notesci tree."
  echo
  echo " -- notesci maintainers <noreply@notesci.com>  $(date -R)"
} | gzip -n9 > "$STAGE/usr/share/doc/notesci/changelog.Debian.gz"

# ── dpkg-deb assemble ─────────────────────────────────────────
log "running dpkg-deb --build"
mkdir -p "$BUILD_DIR"
# --root-owner-group forces all files to root:root in the .deb so
# tarball perms don't leak the build user's uid/gid.
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

# ── Summary ───────────────────────────────────────────────────
SIZE_MB=$(du -m "$DEB" | cut -f1)
log "✅ built $DEB ($SIZE_MB MB)"
echo
echo "Install:    sudo apt install --reinstall -y ./$(realpath --relative-to=. "$DEB")"
echo "Launch:     notesci                          # from app menu or terminal"
echo "Uninstall:  sudo apt remove notesci          # keeps DB + config"
echo "Purge:      sudo apt purge  notesci          # drops DB + config + user"
echo "Inspect:    dpkg-deb --contents $DEB | head"
