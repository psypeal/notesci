# Cross-platform packaging — notesci

Status (2026-06-02): **packaging scaffolding prepped + hardened; NOT yet build-verified. One MAJOR blocker remains (Python backend not bundled — see below) before macOS/Windows/AppImage can actually run.**

This file is the source of truth for how notesci ships on macOS,
Windows, and the broader Linux ecosystem. The original `.deb`
(Debian/Ubuntu, system Postgres) keeps working unchanged; the new
formats below add coverage without disturbing the existing path.

| OS              | Format        | Postgres            | Pgvector           | CI runner       | Status |
|-----------------|---------------|---------------------|--------------------|-----------------|--------|
| Debian / Ubuntu | `.deb`        | system (`apt`)      | `postgresql-16-pgvector` | local + CI | shipping |
| Fedora / RHEL   | `.rpm`        | system (`dnf`)      | `pgvector` rpm     | CI (fedora)     | scaffold |
| Any Linux       | `.AppImage`   | **embedded**        | embedded `.so`     | CI (ubuntu-22)  | scaffold |
| Any Linux       | Flatpak       | **embedded** (sandbox) | embedded `.so`  | Flathub (later) | manifest only |
| macOS 11+       | `.dmg`        | **embedded**        | embedded `.dylib`  | CI (macos-14)   | scaffold |
| Windows 10+     | `.exe` (NSIS) | **embedded**        | embedded `.dll`    | CI (win-2022)   | scaffold |

**Decision (2026-05-28):** bundle Postgres into every installer that
can't rely on a system package manager. Users get a true one-click
experience on macOS / Windows / AppImage; ~120 MB installer growth is
acceptable for an offline-first research tool.

## Build-readiness status & blockers (2026-06-02)

What's been **prepped + hardened** this round (verified by code review +
`cargo check`/`tsc`, NOT by a real cross-platform build):

- `tauri.conf.json` now has `bundle.resources` (map form `"resources/pg/": "pg/"`)
  so the staged `pg/` tree lands at `resource_dir()/pg` — without this the
  embedded tree was never actually bundled.
- `build-pgvector.sh` installs into the **relocated** tree (DESTDIR +
  copy; PG marks `pkglibdir`/`datadir` `override` so `make install pkglibdir=…`
  is silently ignored).
- `build-pgvector-win.ps1` (NEW) — MSVC `nmake /F Makefile.win` build,
  self-bootstraps `vcvars64` via `vswhere`.
- `release.yml`: Windows step calls the ps1; Linux job builds the `.deb`
  **before** staging `pg/` (so the system-Postgres `.deb` doesn't embed PG —
  `bundle.resources` is global across targets), then builds rpm+appimage.
- `pg.rs`: dropped `shared_preload_libraries='vector'` (preloading would
  hard-fail a relocated tree); added `dynamic_library_path` (rewritten every
  launch since an AppImage's mount point changes) + `LD_LIBRARY_PATH`/
  `DYLD_LIBRARY_PATH` on the embedded PG commands.
- `build-appimage.sh` / `build-rpm.sh` (NEW) — local Linux convenience builds.

### Python backend bundling (prepped 2026-06-02 — Linux-verified)

The cross-platform bundles need the FastAPI backend too, not just Postgres
(`lib.rs` previously only found `/opt/notesci` or `../../backend`). Now done:

- **`packaging/embedded-python/fetch-python.sh`** — downloads
  python-build-standalone (CPython 3.12.13, tag `20260510`, `install_only`
  relocatable flavor) per OS/arch (linux / macos-arm64 / macos-x86_64 /
  windows), checksum-verified, flattened to `build/py-raw/<os>/`.
- **`packaging/embedded-python/build-backend-bundle.sh`** — `pip install`s
  the backend deps **directly into the standalone interpreter's
  site-packages** (NOT a venv — venvs pin absolute build-time paths and die
  on move), `--only-binary=:all:` (fail-at-build, never compile on a user's
  machine), stages `backend/src` (build-deb.sh's exclude set), prunes, sets
  the +x bit, and **smoke-tests** `uvicorn --version` + `import notesci.main`.
- **`tauri.conf.json`** bundles `python/ backend/ frontend/` alongside `pg/`
  (map form); committed `.gitkeep` placeholders keep the map valid for the
  `.deb`/dev builds.
- **`lib.rs`** gained a third `LayoutKind::Bundled` arm in `resolve_layout`
  (probes `resource_dir()/python/bin/python3` | `python.exe`); the call moved
  into `setup()` where `resource_dir()` exists. `spawn_backend` does a runtime
  `chmod +x` on the bundled interpreter (deb/rpm/AppImage re-tar can drop it).
- Per-OS staging wired into `release.yml` + `build-appimage.sh` +
  `build-rpm.sh`. **Cross-install is impossible** (pydantic-core/psycopg are
  per-OS native) — each OS/arch bundle builds on its own runner.

**Locally verified on Linux** (the one path runnable on the dev box): fetch
→ pip install → move the tree → run `python3 -m uvicorn`/`import notesci.main`
from the moved path (proves relocation; a venv would exit 127). macOS/Windows
relocation + Mach-O signing are first-CI items below.

### Verify-on-first-CI checklist (high-risk, can't be confirmed without a real build)

- [ ] **Resource path:** unzip the AppImage / inspect the .app and confirm
      the tree is at `$RESOURCE/pg/bin/postgres` (NOT `$RESOURCE/resources/pg/...`).
- [ ] **.deb stays system-PG:** confirm the `.deb` did NOT embed `pg/`
      (the CI guard `test ! -e resources/pg` enforces ordering) and an
      installed `.deb` takes `Mode::System`.
- [ ] **pgvector `$libdir` resolution (the big one):** start each embedded
      server and run `CREATE EXTENSION vector` on macOS, Windows, AppImage.
      Failure mode if wrong: `could not access file "$libdir/vector"`.
- [ ] **Linux relocation:** the Ubuntu-`.deb`-extracted `postgres` must find
      its own libpq/ICU/libxml (we set `LD_LIBRARY_PATH`, no rpath patch) and
      `SHAREDIR/extension/vector.control` (Debian PG may be built
      non-relocatable). If it fails: switch the Linux PG base to the
      **zonky.io** relocatable binaries — the EnterpriseDB Linux tarball URL
      404s, so EDB is NOT an option for Linux.
- [ ] **macOS arch:** `lipo -archs resources/pg/bin/postgres` must include
      `arm64` (macos-14 runners are Apple Silicon); recent EDB macOS builds
      regressed to x86_64-only.
- [ ] **Windows `vector.dll`:** `nmake install` puts it at `$PGROOT\lib\vector.dll`
      (NOT `lib\postgresql\`); confirm `postgres.exe`'s `$libdir` is `lib` and
      `prune-pg.sh` didn't delete it.
- [ ] **EDB Windows headers:** the *binaries* zip must contain
      `lib\postgres.lib` + `include\server\postgres.h` (the ps1 hard-fails
      without them).

## Embedded Postgres layout

When the Tauri shim sees a `pg/` directory next to its binary (in the
resource bundle), it switches to **embedded mode**:

```
<resource_dir>/
  pg/
    bin/postgres[.exe]
    bin/initdb[.exe]
    bin/psql[.exe]
    bin/pg_ctl[.exe]
    lib/...
    share/...
    lib/postgresql/vector.{so|dylib|dll}     # pgvector extension
    share/postgresql/extension/vector.control
    share/postgresql/extension/vector--*.sql
```

If `pg/` is absent (Debian `.deb` install), the shim falls back to the
system-Postgres path and behaves exactly like today.

**Data dir** (per-user, never bundled):

- macOS: `~/Library/Application Support/com.notesci.app/pg-data/`
- Windows: `%LOCALAPPDATA%\notesci\pg-data\`
- Linux: `$XDG_DATA_HOME/com.notesci.app/pg-data/` (default `~/.local/share/…`)

**Port:** `54329` (notesci-ish, dodges the default `5432`). The Tauri
shim probes for a free port at boot if `54329` is occupied.

**Role / db:** first launch runs `initdb`, then `pg_ctl start`, then
`psql -c "CREATE ROLE notesci LOGIN; CREATE DATABASE notesci OWNER notesci;"`.

## Per-OS Postgres + pgvector sourcing

| OS      | Postgres binaries | Pgvector |
|---------|-------------------|----------|
| Linux   | `apt install postgresql-16 postgresql-server-dev-16` → `pg_basebackup`-relocate | build from source (`make` + `make install`) |
| macOS   | `https://get.enterprisedb.com/postgresql/postgresql-16.x-osx-binaries.zip` | build from source against the bundled `pg_config` |
| Windows | `https://get.enterprisedb.com/postgresql/postgresql-16.x-windows-x64-binaries.zip` | precompiled DLL from pgvector releases, fallback to MSVC build |

Scripts that drive this live in `packaging/embedded-postgres/`:

- `fetch-pg.sh OS` — downloads the official binaries for `linux|macos|windows`
- `build-pgvector.sh PG_ROOT` — compiles pgvector against an extracted PG tree
- `prune-pg.sh PG_ROOT` — strips locales / docs / unused server modules to
  shrink the bundle (~250 MB → ~80 MB)

All three are idempotent and called from CI; they produce the `pg/`
tree that ends up inside the OS-specific bundle.

## Tauri Rust integration

`desktop/src-tauri/src/pg.rs` is the embedded-PG lifecycle module:

- `pg::detect_layout(resource_dir)` — returns `Embedded { pg_root, data_dir } | System`
- `pg::ensure_started(layout, port)` — initdb on first run, `pg_ctl start`,
  then waits for the port; returns the `DATABASE_URL`
- `pg::stop(layout)` — `pg_ctl stop -m fast` on app quit

`lib.rs::run()` calls `ensure_started` before `spawn_backend` and sets
`DATABASE_URL` in the child env so the backend uses the embedded PG
without changes. The system-PG path (current `.deb`) takes the `System`
branch and leaves `DATABASE_URL` untouched — the backend reads
`/etc/notesci/notesci.conf` as it does today.

## CI matrix

`.github/workflows/release.yml` (triggered on `v*` tag push) runs a
parallel matrix:

- `ubuntu-22.04` → `.deb`, `.rpm`, `.AppImage` (the AppImage embeds PG)
- `macos-14` → `.dmg` (embeds PG)
- `windows-2022` → `.exe` (NSIS, embeds PG)

Each job:

1. Checks out the tag
2. Installs Rust + Node + Python toolchains
3. Builds the frontend (`pnpm install && pnpm build`)
4. Runs `packaging/embedded-postgres/fetch-pg.sh` for the host OS (if needed)
5. Builds pgvector via `build-pgvector.sh`
6. Stages the `pg/` tree into `desktop/src-tauri/resources/`
7. Runs `cargo tauri build --target <triple>` with the OS-appropriate bundle target
8. Uploads the bundled artifact to the release

The Tauri-bundler handles the OS-native installer assembly (NSIS on
Windows, DMG on macOS, etc.) so this workflow doesn't reinvent that.

## Open questions / deferred

- **Code signing.**
  - macOS: requires an Apple Developer ID (~$99/yr). Unsigned `.dmg`
    works but triggers a Gatekeeper warning on first launch.
  - Windows: requires an EV cert (~$200/yr). Unsigned `.exe` works but
    SmartScreen warns on first run.
  - **Decision pending** — for an OSS project shipping to researchers,
    documented "right-click → Open" + "More info → Run anyway"
    instructions are acceptable until install count justifies the cost.
- **Auto-update.** Tauri 2's updater plugin requires signing keys + a
  hosted endpoint. Deferred until v0.2.x.
- **ARM builds.** macOS-14 runners are Apple Silicon, so `.dmg` is
  arm64 by default; we can add an `x86_64-apple-darwin` cross-build
  later. Linux + Windows: amd64-only for v0.1.
- **Flatpak submission.** `packaging/flatpak/com.notesci.app.yaml` is
  written but not submitted to Flathub yet — the review/discussion
  cycle takes weeks and isn't on the critical path.

## Local-build invocation

```bash
# Existing — unchanged
./packaging/build-deb.sh

# New (Linux host, builds AppImage with embedded PG)
./packaging/build-appimage.sh

# New (Linux host, builds RPM via tauri-bundler)
./packaging/build-rpm.sh

# macOS / Windows builds must run on their native OS.
# Locally:  cargo tauri build
# In CI:    triggered by tag push
```

## File map

```
packaging/
├── cross-platform.md                # THIS FILE — design + status
├── build-deb.sh                     # existing — unchanged
├── build-appimage.sh                # NEW — embedded-PG AppImage
├── build-rpm.sh                     # NEW — RPM via tauri-bundler
├── debian/                          # existing
├── desktop/                         # existing
├── docs/                            # existing
├── embedded-postgres/
│   ├── README.md                    # how the scripts compose
│   ├── fetch-pg.sh                  # downloads PG binaries per OS
│   ├── build-pgvector.sh            # compiles pgvector against vendored PG
│   └── prune-pg.sh                  # strips locales / docs / unused modules
├── flatpak/
│   └── com.notesci.app.yaml         # Flathub-submittable manifest
└── windows/
    └── nsis/                        # custom NSIS scripts (if needed beyond Tauri default)
```
