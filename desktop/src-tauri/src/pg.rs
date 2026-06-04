// pg.rs — embedded Postgres lifecycle.
//
// Three modes:
//   Mode::Embedded — `pg/` tree present in the Tauri resource dir.
//                    We own initdb / start / stop and hand the backend
//                    a DATABASE_URL pointed at the local instance.
//   Mode::System   — no `pg/` tree. Caller's env (e.g. the Debian .deb
//                    install with /etc/notesci/notesci.conf) wins.
//
// Used by lib.rs::run() — see the call sites there.
//
// All errors return ``String`` rather than a typed error enum so the
// shim can surface them straight into the Tauri startup error path
// without an additional conversion layer.

use log::{info, warn};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Embedded-PG port. Dodges the default 5432 so users running their
/// own Postgres on the host don't collide. If this port is occupied
/// at boot we surface an error rather than silently pick another —
/// changing the port means the notesci data dir migrates with it.
const EMBEDDED_PORT: u16 = 54329;

/// Role + database notesci uses inside the embedded instance. The
/// password is set on first-run by ``ensure_role`` so we never have
/// to ship a credential in the bundle.
const PG_ROLE: &str = "notesci";
const PG_DATABASE: &str = "notesci";

/// Where the embedded PG control files live, relative to the
/// per-user data dir. The trailing version segment is here to make a
/// future PG major-version upgrade (e.g. 16 → 17) a side-by-side
/// migration rather than an in-place blow-up.
const PG_DATA_SUBDIR: &str = "pg-data-16";

/// Embedded PG startup budget — initdb on a clean install is the long
/// pole (~10s). Subsequent boots are <1s.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(150);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub enum Mode {
    /// PG binaries bundled in the resource dir. We own initdb / start
    /// / stop and hand the backend the URL via env.
    Embedded {
        pg_root: PathBuf,
        data_dir: PathBuf,
        port: u16,
    },
    /// No `pg/` tree — fall through to the caller's env. Used on the
    /// Debian .deb install path where system Postgres is a dpkg dep.
    System,
}

/// Inspect the resource dir for `pg/bin/postgres[.exe]`. Present →
/// embedded mode; absent → system mode.
pub fn detect(resource_dir: &Path, user_data_dir: &Path) -> Mode {
    let pg_root = resource_dir.join("pg");
    let bin_name = if cfg!(windows) {
        "postgres.exe"
    } else {
        "postgres"
    };
    let bin_path = pg_root.join("bin").join(bin_name);
    if bin_path.exists() {
        Mode::Embedded {
            pg_root,
            data_dir: user_data_dir.join(PG_DATA_SUBDIR),
            port: EMBEDDED_PORT,
        }
    } else {
        Mode::System
    }
}

/// Bring the PG instance up. Returns ``Some(DATABASE_URL)`` in
/// embedded mode (the caller should set this in the backend's env),
/// ``None`` in system mode (caller's existing env wins).
pub fn ensure_started(mode: &Mode) -> Result<Option<String>, String> {
    match mode {
        Mode::System => {
            info!("pg: system mode — caller env supplies DATABASE_URL");
            Ok(None)
        }
        Mode::Embedded {
            pg_root,
            data_dir,
            port,
        } => {
            verify_embedded_pg_tree(pg_root)?;
            ensure_initdb(pg_root, data_dir)?;
            // Refresh the runtime conf every launch — pg_root (and thus
            // dynamic_library_path) changes for AppImage builds whose
            // mount point is per-run.
            write_runtime_conf(pg_root, data_dir)?;
            // Idempotent: pg_ctl no-ops if the server is already
            // running with the data dir it points to (PID file check).
            ensure_started_at(pg_root, data_dir, *port)?;
            wait_for_port("127.0.0.1", *port, STARTUP_TIMEOUT)?;
            // First-run setup — creates the notesci role + db if absent.
            ensure_role_and_db(pg_root, *port)?;
            let url = format!(
                "postgresql://{}:{}@127.0.0.1:{}/{}",
                PG_ROLE,
                embedded_password(),
                port,
                PG_DATABASE,
            );
            info!("pg: embedded instance up on 127.0.0.1:{port}");
            Ok(Some(url))
        }
    }
}

/// `pg_ctl stop -m fast`. Safe to call when not running — pg_ctl just
/// logs that there's nothing to stop.
pub fn stop(mode: &Mode) {
    if let Mode::Embedded {
        pg_root, data_dir, ..
    } = mode
    {
        let r = pg_command(pg_root, "pg_ctl")
            .args(["-D", &data_dir.to_string_lossy(), "-m", "fast", "stop"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status();
        match r {
            Ok(s) if s.success() => info!("pg: embedded instance stopped"),
            Ok(s) => warn!("pg: pg_ctl stop exited {s}"),
            Err(e) => warn!("pg: pg_ctl invocation failed: {e}"),
        }
    }
}

// ──────────────────────── helpers ─────────────────────────────

fn bin(pg_root: &Path, name: &str) -> PathBuf {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let path = pg_root.join("bin").join(format!("{name}{suffix}"));
    windows_compat_path(&path)
}

#[cfg(windows)]
fn windows_compat_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with(r"\\?\") || s.starts_with("//?/") {
        PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn windows_compat_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn verify_embedded_pg_tree(pg_root: &Path) -> Result<(), String> {
    let bin_dir = pg_root.join("bin");
    let required: Vec<PathBuf> = if cfg!(windows) {
        [
            "bin/postgres.exe",
            "bin/initdb.exe",
            "bin/pg_ctl.exe",
            "bin/psql.exe",
            "bin/icudt67.dll",
            "bin/icuin67.dll",
            "bin/icuuc67.dll",
            "bin/libpq.dll",
            "bin/libssl-3-x64.dll",
            "bin/libcrypto-3-x64.dll",
            "bin/libxml2.dll",
            "bin/zlib1.dll",
            "lib/vector.dll",
            "share/extension/vector.control",
        ]
        .iter()
        .map(|rel| pg_root.join(rel))
        .collect()
    } else {
        ["bin/postgres", "bin/initdb", "bin/pg_ctl", "bin/psql"]
            .iter()
            .map(|rel| pg_root.join(rel))
            .collect()
    };

    let missing: Vec<String> = required
        .iter()
        .filter(|path| !path.exists())
        .map(|path| {
            path.strip_prefix(pg_root)
                .unwrap_or(path)
                .display()
                .to_string()
        })
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    let listing = std::fs::read_dir(&bin_dir)
        .ok()
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "<unreadable>".to_string());

    Err(format!(
        "embedded Postgres bundle incomplete. missing [{}]; {} contains [{}]",
        missing.join(", "),
        bin_dir.display(),
        listing
    ))
}

/// A `Command` for an embedded PG binary with the bundled `lib/` dir on
/// the dynamic-linker search path. The relocated tree's binaries were
/// built with an rpath pointing at their original system prefix (e.g.
/// /usr/lib/... for the Ubuntu-.deb-extracted Linux tree), so without
/// this they fail to find their own bundled libpq / ICU / libxml. On
/// Windows we also prepend bundled bin/lib directories to PATH so helper
/// processes launched by initdb/pg_ctl resolve ICU and libpq from the
/// embedded tree instead of relying on global DLL search state.
fn pg_command(pg_root: &Path, name: &str) -> Command {
    let mut cmd = Command::new(bin(pg_root, name));
    cmd.current_dir(pg_root.join("bin"));
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut paths = vec![pg_root.join("bin"), pg_root.join("lib")];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    #[cfg(not(windows))]
    {
        let key = if cfg!(target_os = "macos") {
            "DYLD_LIBRARY_PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let libdir = pg_root.join("lib");
        let val = match std::env::var(key) {
            Ok(existing) if !existing.is_empty() => {
                format!("{}:{}", libdir.display(), existing)
            }
            _ => libdir.display().to_string(),
        };
        cmd.env(key, val);
    }
    cmd
}

/// Run `initdb` if the data dir is empty / absent. Idempotent.
fn ensure_initdb(pg_root: &Path, data_dir: &Path) -> Result<(), String> {
    // `PG_VERSION` is the marker file initdb writes — its presence
    // means the cluster is initialized regardless of empty state.
    if data_dir.join("PG_VERSION").is_file() {
        return Ok(());
    }
    info!("pg: initdb at {}", data_dir.display());
    std::fs::create_dir_all(data_dir).map_err(|e| format!("mkdir data dir: {e}"))?;
    set_secure_mode(data_dir)?;
    // ``--no-locale --encoding=UTF8`` keeps the cluster portable across
    // OS locale settings; ``--auth-host=trust`` works because the
    // server only listens on 127.0.0.1 and the OS user is the sole
    // human on this machine (single-user desktop). The conf is written
    // separately in ``ensure_started`` so it's refreshed on every launch.
    let out = pg_command(pg_root, "initdb")
        .args([
            "-D",
            &data_dir.to_string_lossy(),
            "--username",
            PG_ROLE,
            "--encoding",
            "UTF8",
            "--no-locale",
            "--auth-local=trust",
            "--auth-host=trust",
        ])
        .output()
        .map_err(|e| format!("initdb spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "initdb failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn set_secure_mode(_data_dir: &Path) -> Result<(), String> {
    // On Unix initdb refuses to run if the data dir is group/world
    // readable. We pre-emptively 0700 it so a previously-mode-0755
    // mkdir doesn't trip the check.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let p = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(_data_dir, p).map_err(|e| format!("chmod 0700 data dir: {e}"))?;
    }
    Ok(())
}

fn write_runtime_conf(pg_root: &Path, data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join("postgresql.auto.conf");
    // We write `postgresql.auto.conf` (not postgresql.conf) so an OS/PG
    // upgrade that rewrites postgresql.conf doesn't blow away our knobs.
    //
    // pgvector is loaded on demand by `CREATE EXTENSION vector`, so it
    // does NOT belong in shared_preload_libraries — preloading it would
    // HARD-FAIL the postmaster on a relocated tree where vector.{so,dylib}
    // isn't at the binary's compile-time $libdir. Instead we add every
    // plausible relocated lib dir to dynamic_library_path so on-demand
    // loading resolves it. This file is rewritten on EVERY launch because
    // an AppImage's mount point — and therefore pg_root — changes each
    // run, so a path baked at initdb time would go stale.
    let lib = pg_root.join("lib");
    let lib_pg = pg_root.join("lib").join("postgresql");
    let dlp = format!("$libdir:{}:{}", lib.display(), lib_pg.display());
    let body = format!(
        "listen_addresses = '127.0.0.1'\n\
         port = {EMBEDDED_PORT}\n\
         unix_socket_directories = ''\n\
         dynamic_library_path = '{dlp}'\n\
         # Conservative single-user defaults — keeps PG's RSS tiny when idle.\n\
         shared_buffers = '128MB'\n\
         max_connections = 50\n\
         log_destination = 'stderr'\n\
         logging_collector = off\n\
         log_min_messages = 'warning'\n"
    );
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

fn ensure_started_at(pg_root: &Path, data_dir: &Path, _port: u16) -> Result<(), String> {
    // The logfile lives inside the data dir so it doesn't pollute
    // user space and rotates with the cluster's lifecycle.
    let logfile = data_dir.join("pg-startup.log");
    let r = pg_command(pg_root, "pg_ctl")
        .args([
            "-D",
            &data_dir.to_string_lossy(),
            "-l",
            &logfile.to_string_lossy(),
            "-w", // wait for startup; pg_ctl exits 0 when ready
            "start",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("pg_ctl start spawn: {e}"))?;
    // pg_ctl returns 0 either when starting OR when already running —
    // both are fine for our purposes. Surface any other code.
    if !r.success() {
        return Err(format!(
            "pg_ctl start exited {r}; see {}",
            logfile.display()
        ));
    }
    Ok(())
}

fn wait_for_port(host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let addr = format!("{host}:{port}");
    let start = Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("bad addr {addr}: {e}"))?,
            Duration::from_millis(300),
        )
        .is_ok()
        {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "pg never became reachable on {addr} within {:?}",
        timeout
    ))
}

/// On the very first launch the cluster has only the bootstrap
/// superuser. We create the `notesci` role + database here (idempotent
/// — second run is a no-op when both exist).
fn ensure_role_and_db(pg_root: &Path, port: u16) -> Result<(), String> {
    // Run via the bootstrap superuser (also `notesci`, set in initdb).
    // The CREATE statements use IF NOT EXISTS where supported; for
    // CREATE DATABASE we check presence first since the IF NOT EXISTS
    // form was only added in PG 16 and the syntax differs.
    let sql = format!(
        "DO $$ BEGIN\n\
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN\n\
             CREATE ROLE \"{role}\" LOGIN PASSWORD '{pw}';\n\
           ELSE\n\
             ALTER ROLE \"{role}\" WITH LOGIN PASSWORD '{pw}';\n\
           END IF;\n\
         END $$;\n\
         SELECT 'created-or-exists';\n",
        role = PG_ROLE,
        pw = embedded_password(),
    );
    run_psql(pg_root, port, "postgres", &sql)?;
    // CREATE DATABASE can't run inside a DO block (no transactions).
    let exists = run_psql_query(
        pg_root,
        port,
        "postgres",
        &format!(
            "SELECT 1 FROM pg_database WHERE datname = '{}'",
            PG_DATABASE
        ),
    )?;
    if exists.trim().is_empty() {
        let stmt = format!("CREATE DATABASE \"{}\" OWNER \"{}\"", PG_DATABASE, PG_ROLE,);
        run_psql(pg_root, port, "postgres", &stmt)?;
    }
    Ok(())
}

fn run_psql(pg_root: &Path, port: u16, dbname: &str, sql: &str) -> Result<(), String> {
    let out = pg_command(pg_root, "psql")
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            &port.to_string(),
            "-U",
            PG_ROLE,
            "-d",
            dbname,
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
            "-c",
            sql,
        ])
        .output()
        .map_err(|e| format!("psql spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "psql failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn run_psql_query(pg_root: &Path, port: u16, dbname: &str, sql: &str) -> Result<String, String> {
    let out = pg_command(pg_root, "psql")
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            &port.to_string(),
            "-U",
            PG_ROLE,
            "-d",
            dbname,
            "-v",
            "ON_ERROR_STOP=1",
            "-At",
            "-c",
            sql,
        ])
        .output()
        .map_err(|e| format!("psql query spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "psql query failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Embedded-PG password. The instance is bound to 127.0.0.1 with
/// auth=trust, so the password is effectively a placeholder — but a
/// real password keeps DATABASE_URL well-formed and lets a curious
/// user with a `psql` client connect from outside the app if they
/// know it (we surface it via Settings → Privacy → Local DB).
fn embedded_password() -> &'static str {
    // Static for now; future work can derive a per-install random
    // value and stash it under $XDG_DATA_HOME so it survives upgrades.
    "notesci_local"
}
