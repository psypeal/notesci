#!/usr/bin/env bash
# fetch-pg.sh — download PostgreSQL 16 binaries for the target OS.
#
# Usage: ./fetch-pg.sh OS
#   where OS is "linux" | "macos" | "windows"
#
# Output: build/pg-raw/<OS>/ containing bin/, lib/, share/, ...
#
# Sources:
#   macOS / Windows: EnterpriseDB binary archives (official PG hosting partner).
#   Linux: extracted from the Ubuntu LTS postgresql-16 .deb so the libc
#          ABI matches AppImage runtime (glibc 2.35+).
#
# Idempotent — re-runs skip the download if the archive already exists.

set -euo pipefail

PG_VERSION="${PG_VERSION:-16.14}"
EDB_BASE="https://get.enterprisedb.com/postgresql"

OS="${1:-}"
if [[ -z "$OS" ]]; then
    echo "usage: $0 linux|macos|windows" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$REPO_ROOT/build/pg-raw"
mkdir -p "$BUILD"
DEST="$BUILD/$OS"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

download_archive() {
    local url="$1"
    local out="$2"

    if curl -fL --retry 5 --retry-all-errors --connect-timeout 30 \
        --user-agent "Mozilla/5.0 notesci-release-build" \
        -H "Accept: application/zip,application/octet-stream,*/*" \
        -o "$out" "$url"; then
        return 0
    fi

    if command -v powershell.exe >/dev/null 2>&1; then
        local out_win="$out"
        if command -v cygpath >/dev/null 2>&1; then
            out_win="$(cygpath -w "$out")"
        fi
        log "curl failed; retrying download with PowerShell"
        DOWNLOAD_URL="$url" DOWNLOAD_OUT="$out_win" powershell.exe -NoProfile -Command "\$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri \$env:DOWNLOAD_URL -OutFile \$env:DOWNLOAD_OUT -Headers @{ 'User-Agent' = 'Mozilla/5.0 notesci-release-build'; 'Accept' = 'application/zip,application/octet-stream,*/*' }"
        return 0
    fi

    return 1
}

download_first_archive() {
    local out="$1"
    shift
    local url
    for url in "$@"; do
        log "downloading $url"
        if download_archive "$url" "$out"; then
            return 0
        fi
    done
    return 1
}

if [[ "$OS" == "windows" && -d "$DEST/bin" && -f "$DEST/bin/postgres.exe" ]]; then
    log "$OS PG tree already at $DEST — skipping"
    exit 0
fi
if [[ "$OS" != "windows" && -d "$DEST/bin" && -x "$DEST/bin/postgres" ]]; then
    log "$OS PG tree already at $DEST — skipping"
    exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"

case "$OS" in
    macos)
        # EnterpriseDB ships universal2 binaries (x86_64 + arm64).
        ARCHIVE="postgresql-${PG_VERSION}-1-osx-binaries.zip"
        URLS=("$EDB_BASE/$ARCHIVE")
        if [[ "$PG_VERSION" == "16.14" ]]; then
            URLS+=("https://sbp.enterprisedb.com/getfile.jsp?fileid=1260222")
        fi
        download_first_archive "$BUILD/$ARCHIVE" "${URLS[@]}"
        log "extracting"
        ( cd "$BUILD" && unzip -q -o "$ARCHIVE" )
        # The zip lays out as `pgsql/{bin,lib,...}` — flatten into $DEST.
        mv "$BUILD/pgsql"/* "$DEST/"
        rmdir "$BUILD/pgsql"
        ;;

    windows)
        # EnterpriseDB Windows binaries archive.
        ARCHIVE="postgresql-${PG_VERSION}-1-windows-x64-binaries.zip"
        URLS=("$EDB_BASE/$ARCHIVE")
        if [[ "$PG_VERSION" == "16.14" ]]; then
            URLS+=("https://sbp.enterprisedb.com/getfile.jsp?fileid=1260202")
        fi
        download_first_archive "$BUILD/$ARCHIVE" "${URLS[@]}"
        log "extracting"
        ( cd "$BUILD" && unzip -q -o "$ARCHIVE" )
        mv "$BUILD/pgsql"/* "$DEST/"
        rmdir "$BUILD/pgsql"
        ;;

    linux)
        # No first-party portable archive for Linux; we extract from the
        # Ubuntu 22.04 postgresql-16 .deb. The resulting tree is
        # relocatable as long as the AppImage's libc ABI matches the
        # build host (we target Ubuntu 22.04, glibc 2.35+).
        log "extracting from Ubuntu postgresql-16 .deb"
        need_dpkg() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
        need_dpkg dpkg-deb
        need_dpkg apt-get
        need_dpkg apt-cache

        TMP="$BUILD/.linux-stage"
        rm -rf "$TMP" && mkdir -p "$TMP"
        # `apt-get download` pulls the .deb into cwd without installing.
        (
            cd "$TMP"
            download_ubuntu_pkg() {
                local pkg="$1"
                local version
                version="$(apt-cache madison "$pkg" | awk '$3 ~ /ubuntu/ { print $3; exit }')"
                if [[ -n "$version" ]]; then
                    apt-get download "$pkg=$version"
                else
                    apt-get download "$pkg"
                fi
            }

            ICU_PKG="$(apt-cache search libicu | awk '$1 ~ /^libicu[0-9]+$/ {print $1}' | sort -V | tail -n 1)"
            if [[ -z "$ICU_PKG" ]]; then
                echo "failed to resolve ICU package (expected libicu<version>)" >&2
                exit 1
            fi

            download_ubuntu_pkg postgresql-16
            download_ubuntu_pkg postgresql-client-16
            download_ubuntu_pkg libpq5
            download_ubuntu_pkg libxslt1.1
            download_ubuntu_pkg libxml2
            download_ubuntu_pkg "$ICU_PKG"
            if download_ubuntu_pkg postgresql-server-dev-16; then
                true
            else
                echo "warning: postgresql-server-dev-16 not available; using existing system headers" >&2
            fi
            for deb in *.deb; do
                dpkg-deb -x "$deb" "$TMP/root"
                rm -f "$deb"
            done
        )
        # Stage what we need under $DEST.
        mkdir -p "$DEST/bin" "$DEST/lib" "$DEST/share/postgresql"
        cp -a "$TMP/root/usr/lib/postgresql/16/bin/"*   "$DEST/bin/"   2>/dev/null || true
        cp -a "$TMP/root/usr/lib/postgresql/16/lib/"*   "$DEST/lib/"   2>/dev/null || true
        cp -a "$TMP/root/usr/share/postgresql/16/"*     "$DEST/share/postgresql/" 2>/dev/null || true
        # Bundle the shared libs the binaries link against.
        for so in libpq.so.5 libxslt.so.1 libxml2.so.2 libicuuc.so libicudata.so libicui18n.so; do
            cp -aL "$TMP/root/usr/lib/x86_64-linux-gnu/$so"* "$DEST/lib/" 2>/dev/null || true
        done

        # Bundle PostgreSQL server headers for local pgvector compilation.
        if [[ -d "$TMP/root/usr/include/postgresql" ]]; then
            rm -rf "$DEST/include"
            mkdir -p "$DEST/include"
            cp -a "$TMP/root/usr/include/postgresql" "$DEST/include/"
        fi
        rm -rf "$TMP"
        ;;

    *)
        echo "unknown OS: $OS" >&2
        exit 1
        ;;
esac

# EDB binary archives include GUI/admin extras that notesci never launches.
# pgAdmin.app also contains broken framework symlinks in newer macOS archives,
# which makes `cp -r` fail during Tauri resource staging. Keep only the server,
# client helpers, libraries, and extension/share files we actually need.
rm -rf \
    "$DEST/pgAdmin 4.app" \
    "$DEST/pgAdmin 4" \
    "$DEST/StackBuilder.app" \
    "$DEST/StackBuilder" \
    "$DEST/doc" \
    "$DEST/docs"

# Sanity check.
if [[ "$OS" == "windows" ]]; then
    if [[ ! -f "$DEST/bin/postgres.exe" ]]; then
        echo "postgres.exe missing after extract" >&2
        exit 1
    fi
    if [[ ! -f "$DEST/bin/initdb.exe" || ! -f "$DEST/bin/pg_ctl.exe" || ! -f "$DEST/bin/psql.exe" ]]; then
        echo "required Postgres helper binary missing after extract" >&2
        exit 1
    fi
else
    [[ -x "$DEST/bin/postgres" ]] || { echo "postgres binary missing after extract" >&2; exit 1; }
fi

log "✅ PG ${PG_VERSION} for $OS staged at $DEST ($(du -sh "$DEST" | cut -f1))"
