# Embedded Postgres bundling

Drives the `pg/` tree that gets staged into the OS-specific bundle for
macOS `.dmg`, Windows NSIS, and Linux `.AppImage`. The Debian `.deb`
keeps using system Postgres — these scripts are a no-op there.

See `../cross-platform.md` for the broader design.

## Scripts

| Script | Args | What it does |
|---|---|---|
| `fetch-pg.sh` | `OS` (`linux\|macos\|windows`) | Downloads the official PostgreSQL 16 binaries for the host platform into `build/pg-raw/<OS>/`. |
| `build-pgvector.sh` | `PG_ROOT` | (Linux/macOS) Compiles pgvector against `$PG_ROOT/bin/pg_config`, then **relocates** the artifacts into the staged tree (installs via a throwaway `DESTDIR` + copy — PG marks `pkglibdir`/`datadir` `override`, so `make install pkglibdir=…` is silently ignored). Lands `vector.{so,dylib}` in `$PG_ROOT/lib` + `$PG_ROOT/lib/postgresql`; control/SQL in both `$PG_ROOT/share/extension` and `…/share/postgresql/extension`. |
| `build-pgvector-win.ps1` | `-PgRoot <tree>` | (Windows) MSVC build via `nmake /F Makefile.win`; self-bootstraps the x64 `vcvars64` env via `vswhere`. Installs `vector.dll` → `$PgRoot\lib`, control/SQL → `$PgRoot\share\extension`. |
| `prune-pg.sh` | `PG_ROOT` | Strips locales / docs / unused contrib modules. ~250 MB → 80 MB. Keeps `vector`, `pg_trgm`, `btree_gin`. |

> The staged tree lives at `desktop/src-tauri/resources/pg`, kept as a
> `.gitkeep` placeholder in-repo so Tauri's `bundle.resources`
> (`"resources/pg/": "pg/"`) validates even when no PG is staged. The real
> tree is `rm -rf`'d + restaged per-OS by the build scripts / CI, and
> `pg.rs` reads it from `resource_dir()/pg`.

All three are idempotent. CI runs them in sequence:

```bash
./fetch-pg.sh "$RUNNER_OS_LOWER"
./build-pgvector.sh build/pg-raw/"$RUNNER_OS_LOWER"
./prune-pg.sh        build/pg-raw/"$RUNNER_OS_LOWER"
# Stage into the Tauri resource dir:
cp -r build/pg-raw/"$RUNNER_OS_LOWER" desktop/src-tauri/resources/pg
```

## Source-of-truth versions

Pinned at the top of each script. Keep these in sync:

- **PostgreSQL:** 16.4 (matches the `.deb` `postgresql-16` dependency)
- **pgvector:** 0.8.0 (latest stable as of 2026-05)

When bumping PG, also bump:

- `packaging/debian/control.in` (`Depends:` line)
- `desktop/src-tauri/tauri.conf.json` (Linux `deb.depends`)
- `desktop/src-tauri/src/pg.rs` (`POSTGRES_VERSION` const, used to format
  the data-dir path in case we ever need a major-version migration)
