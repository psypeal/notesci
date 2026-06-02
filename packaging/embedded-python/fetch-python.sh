#!/usr/bin/env bash
# fetch-python.sh — download a relocatable CPython (python-build-standalone)
# for the target OS/arch. Mirrors embedded-postgres/fetch-pg.sh.
#
# Usage: ./fetch-python.sh OS
#   where OS is  linux | macos-arm64 | macos-x86_64 | windows
#
# Output: build/py-raw/<OS>/ containing (unix) bin/python3, lib/..., or
#         (windows) python.exe, Lib/, DLLs/ — flattened from the archive's
#         top-level `python/` dir.
#
# We use the `install_only` flavor: a flattened, ready-to-run, relocatable
# tree (finds its stdlib relative to the binary, no PYTHONHOME). Pinned to
# a dated release tag — these are NOT semver, so we pin + verify checksum.
#
# Idempotent — re-runs skip if the interpreter already exists.

set -euo pipefail

PYVER="3.12.13"
PBS_TAG="20260510"
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}"

OS="${1:-}"
if [[ -z "$OS" ]]; then
    echo "usage: $0 linux|macos-arm64|macos-x86_64|windows" >&2
    exit 1
fi

case "$OS" in
    linux)        TARGET="x86_64-unknown-linux-gnu" ;;
    macos-arm64)  TARGET="aarch64-apple-darwin" ;;
    macos-x86_64) TARGET="x86_64-apple-darwin" ;;
    windows)      TARGET="x86_64-pc-windows-msvc" ;;
    *) echo "unknown OS: $OS" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$REPO_ROOT/build/py-raw"
DEST="$BUILD/$OS"
mkdir -p "$BUILD"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ -x "$DEST/bin/python3" || -x "$DEST/python.exe" ]]; then
    log "$OS python tree already at $DEST — skipping"
    exit 0
fi

rm -rf "$DEST"

ARCHIVE_NAME="cpython-${PYVER}+${PBS_TAG}-${TARGET}-install_only.tar.gz"
# The '+' must be %2B-encoded in the URL path.
URL="${PBS_BASE}/cpython-${PYVER}%2B${PBS_TAG}-${TARGET}-install_only.tar.gz"
LOCAL="$BUILD/${OS}.tar.gz"

log "downloading $URL"
curl -fL --retry 3 -o "$LOCAL" "$URL"

# Best-effort SHA256 verification against the release SHA256SUMS.
verify_sha() {
    local sums; sums="$BUILD/SHA256SUMS"
    curl -fL --retry 3 -o "$sums" "${PBS_BASE}/SHA256SUMS" 2>/dev/null || {
        echo "WARN: could not fetch SHA256SUMS — skipping checksum" >&2; return 0; }
    local want; want="$(grep " ${ARCHIVE_NAME}\$" "$sums" | awk '{print $1}' | head -1)"
    [[ -z "$want" ]] && { echo "WARN: ${ARCHIVE_NAME} not in SHA256SUMS — skipping" >&2; return 0; }
    local got
    if command -v sha256sum >/dev/null; then got="$(sha256sum "$LOCAL" | awk '{print $1}')";
    elif command -v shasum >/dev/null; then got="$(shasum -a 256 "$LOCAL" | awk '{print $1}')";
    else echo "WARN: no sha256 tool — skipping" >&2; return 0; fi
    if [[ "$want" != "$got" ]]; then
        echo "checksum mismatch for ${ARCHIVE_NAME}: want $want got $got" >&2; exit 1
    fi
    log "checksum OK"
}
verify_sha

log "extracting"
mkdir -p "$DEST"
# The archive is rooted at a top-level `python/` dir; flatten into $DEST.
TMP="$BUILD/.${OS}-stage"
rm -rf "$TMP" && mkdir -p "$TMP"
tar -xzf "$LOCAL" -C "$TMP"
mv "$TMP/python"/* "$DEST/"
rm -rf "$TMP"

# Sanity check.
if [[ "$OS" == "windows" ]]; then
    [[ -x "$DEST/python.exe" || -f "$DEST/python.exe" ]] || { echo "python.exe missing after extract" >&2; exit 1; }
else
    [[ -x "$DEST/bin/python3" ]] || { echo "bin/python3 missing after extract" >&2; exit 1; }
fi

log "✅ CPython ${PYVER} for $OS staged at $DEST ($(du -sh "$DEST" | cut -f1))"
