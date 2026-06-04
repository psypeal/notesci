// notesci desktop — library crate.
//
// On launch:
//   1. Loads environment from /etc/notesci/notesci.conf (or backend/.env
//      in dev) so the spawned backend has its DB password + API keys.
//   2. Spawns the Python backend (uvicorn) as a child process bound to
//      127.0.0.1 on a known port (BACKEND_PORT).
//   3. Polls /readyz until the backend is fully ready (the FastAPI
//      lifespan runs migrations + opens LangGraph's Postgres checkpointer
//      pool — cold-start can be a few seconds on the first install).
//   4. Navigates the main WebView to http://127.0.0.1:<port>/ — the
//      backend serves the React SPA from /opt/notesci/frontend via the
//      NOTESCI_STATIC_DIR fallback that main.py wires up.
//   5. Reveals the window.
//
// On exit:
//   6. CloseRequested -> kill_backend() sends SIGKILL to the child
//      (uvicorn handles graceful TERM but we don't want the app to
//      hang on close in pathological cases).
//
// The backend process lifecycle is mirror-image of the systemd unit
// from the pre-Tauri .deb: same env, same uvicorn invocation, same
// working dir. So both deployments use exactly one code path on the
// Python side.

mod pg;

use log::{info, warn};
use std::collections::HashMap;
use std::fs::OpenOptions;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use std::net::{Shutdown, TcpStream};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::WebviewBuilder;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

// Install layout — must match packaging/build-deb.sh + postinst.
const BACKEND_VENV_PYTHON: &str = "/opt/notesci/venv/bin/python";
const BACKEND_CWD: &str = "/opt/notesci/backend";
const BACKEND_PYTHONPATH: &str = "/opt/notesci/backend/src";
const FRONTEND_STATIC_DIR: &str = "/opt/notesci/frontend";
const CONFIG_FILE: &str = "/etc/notesci/notesci.conf";
// Session token written by the backend's local-mode bootstrap. We read
// it and inject into the WebView's localStorage so the user never sees
// a sign-in screen on a freshly installed single-user desktop.
// User-data dir (not /var/lib) so the backend, which runs as the user
// who launched the Tauri app — not the `notesci` system user — can
// write to it without elevated privileges. Path is computed at startup
// from $XDG_DATA_HOME / $HOME.
const TOKEN_FILENAME: &str = "session_token";

// Dev fallback — if /opt/notesci/* doesn't exist (cargo tauri dev from
// the repo), point at the in-tree backend + frontend instead. Lets us
// iterate without rebuilding the .deb every time.
const DEV_BACKEND_CWD: &str = "../../backend";
const DEV_BACKEND_PYTHONPATH: &str = "../../backend/src";
const DEV_FRONTEND_STATIC_DIR: &str = "../../frontend/dist";
const DEV_BACKEND_PYTHON: &str = "../../backend/.venv/bin/python";
const DEV_ENV_FILE: &str = "../../backend/.env";

// Backend bind. 127.0.0.1-only — desktop app is single-user; no LAN
// exposure. 8765 chosen to dodge the systemd-managed 8000 during the
// migration; once the systemd unit is removed (Slice 1c) we could move
// back to 8000.
const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 8765;

// Allow up to 300s for the backend to come up — first Windows install can
// spend extra time on embedded Postgres init and DB bootstrap.
// migrations + checkpointer init dominate. Subsequent launches are
// usually <2s.
const STARTUP_TIMEOUT_DEFAULT: Duration = Duration::from_secs(300);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(200);
const STARTUP_TIMEOUT_ENV: &str = "NOTESCI_BACKEND_STARTUP_TIMEOUT_SECS";
const STARTUP_LOG_FILE: &str = "backend-startup.log";
const STARTUP_LOG_TAIL_BYTES: usize = 8192;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Tauri-managed state — owns the backend child so on_window_event can
/// reach it to kill on exit.
struct BackendChild(Mutex<Option<Child>>);

/// Tauri-managed state — owns the embedded Postgres mode so
/// ``kill_backend`` can stop the cluster on exit. ``Mode::System``
/// when running against host Postgres (current Debian .deb path).
struct PgMode(Mutex<pg::Mode>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("notesci desktop starting");

    // Layout resolution + env loading happen inside setup() below, where
    // the Tauri resource dir is available — the Bundled (macOS / Windows /
    // AppImage) layout lives under resource_dir(), which can't be queried
    // until the app handle exists.

    let backend = BackendChild(Mutex::new(None));
    // Default to System mode — replaced below once we can ask Tauri
    // for the resource dir. System mode is the safe fallback if PG
    // detection fails for any reason (the system-PG .deb path still
    // works because the env file supplies DATABASE_URL there).
    let pg_state = PgMode(Mutex::new(pg::Mode::System));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            export_file,
            open_url,
            open_link_preview,
            capture_source,
            embed_preview,
            close_preview,
            capture_from_preview,
            start_preview_fetch,
            preview_bytes,
            cancel_preview_fetch
        ])
        .manage(backend)
        .manage(pg_state)
        .setup(move |app| {
            // Embedded Postgres lifecycle. ``pg::detect`` looks for a
            // ``pg/`` tree next to the Tauri bundle's resources (only
            // present in macOS / Windows / AppImage builds — the
            // Debian .deb keeps using system PG). When present, we
            // initdb + start the cluster and inject the resulting
            // DATABASE_URL into the backend's env so the FastAPI
            // process talks to our embedded instance instead of trying
            // to reach a host install that isn't there.
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("resource dir: {e}"))?;
            let user_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;
            let _ = std::fs::create_dir_all(&user_data_dir);
            let _ = std::fs::create_dir_all(user_data_dir.join("runtime"));

            // Resolve install layout now that resource_dir() is known. The
            // Bundled arm (macOS / Windows / AppImage) lives under the
            // resource dir; Installed (.deb /opt/notesci) and Dev don't
            // need it but resolve_layout takes it to probe for Bundled.
            let layout = resolve_layout(&resource_dir, &user_data_dir);
            info!("install layout: {:?}", layout.kind);
            // Invalidate the WebKit HTTP cache when the bundled frontend is
            // newer than last launch (so a .deb upgrade actually reaches the
            // user) — done before we navigate the WebView at the backend URL.
            maybe_invalidate_webview_cache(&layout, &user_data_dir);
            // Load env (/etc/notesci/notesci.conf on the .deb, backend/.env
            // in dev, a per-user conf for Bundled) so the child inherits DB
            // password + API keys.
            let mut env_overrides = load_env_file(&layout.env_file).unwrap_or_else(|e| {
                warn!("could not load {}: {}", layout.env_file.display(), e);
                HashMap::new()
            });
            info!("loaded {} env vars from config", env_overrides.len());
            let startup_timeout = backend_startup_timeout(&env_overrides);

            let pg_mode = pg::detect(&resource_dir, &user_data_dir);
            info!("pg mode: {:?}", pg_mode);
            let mut startup_error: Option<String> = None;
            match pg::ensure_started(&pg_mode) {
                Ok(Some(db_url)) => {
                    env_overrides.insert("DATABASE_URL".to_string(), db_url);
                }
                Ok(None) => {}
                Err(err) => {
                    match pg_mode {
                        pg::Mode::Embedded { .. } => {
                            startup_error = Some(format!("embedded postgres failed: {err}"));
                        }
                        _ => {
                            warn!("embedded pg did not start: {err}");
                        }
                    }
                }
            }
            // Stash for kill_backend on quit. State was registered with
            // Mode::System; replace with the detected mode.
            {
                let st: tauri::State<PgMode> = app.state();
                *st.0.lock().unwrap() = pg_mode;
            }

            // Backend lifecycle. We hide-to-tray on window close, so a
            // previous launch may have left the backend running (the
            // user can also forcibly kill the Tauri parent without it
            // taking the backend child with it). Probe the port first
            // and only spawn when nothing is listening — otherwise
            // reuse the existing process and just navigate.
            let already_up = std::net::TcpStream::connect_timeout(
                &format!("{}:{}", BACKEND_HOST, BACKEND_PORT)
                    .parse()
                    .expect("hard-coded addr parses"),
                Duration::from_millis(150),
            )
            .is_ok();
            if startup_error.is_none() {
                if !already_up {
                    match spawn_backend(&layout, &env_overrides) {
                        Ok(mut child) => {
                            info!(
                                "backend spawned, waiting for {}:{}",
                                BACKEND_HOST, BACKEND_PORT
                            );
                            if let Err(err) = wait_for_backend_child(
                                BACKEND_HOST,
                                BACKEND_PORT,
                                startup_timeout,
                                &mut child,
                            ) {
                                warn!("backend readiness check failed: {err}");
                                let status = child.try_wait().ok().flatten();
                                let tail = read_log_tail(
                                    &layout.backend_log,
                                    STARTUP_LOG_TAIL_BYTES,
                                )
                                .unwrap_or_else(|_| "(backend log unavailable)".to_string());
                                let reason = match status {
                                    Some(exit_status) => {
                                        format!(
                                            "backend exited before ready: {exit_status}\n\nbackend startup log:\n{tail}"
                                        )
                                    }
                                    None => {
                                        format!("{err}\n\nbackend startup log:\n{tail}")
                                    }
                                };
                                let _ = child.kill();
                                let _ = child.wait();
                                startup_error = Some(reason);
                            } else {
                                let state: tauri::State<BackendChild> = app.state();
                                *state.0.lock().unwrap() = Some(child);
                                info!("backend ready");
                            }
                        }
                        Err(err) => {
                            startup_error = Some(format!("failed to spawn backend: {err}"));
                        }
                    }
                } else {
                    // Existing process is already listening; still wait for app
                    // readiness so we only expose the UI once startup is complete.
                    if let Err(err) = wait_for_backend(
                        BACKEND_HOST,
                        BACKEND_PORT,
                        startup_timeout,
                    ) {
                        warn!("backend readiness check failed: {err}");
                        startup_error = Some(err);
                    } else {
                        info!("backend already running at {}:{} and ready", BACKEND_HOST, BACKEND_PORT);
                    }
                }
            }

            if startup_error.is_none() {
                // Point the WebView at the backend's URL and show it.
                // The backend in local mode rewrites index.html to seed
                // localStorage with the bootstrap session token (see
                // _spa_fallback in backend/main.py), so the SPA sees a
                // logged-in state on first paint — no need to do the
                // injection from this side.
                if let Some(win) = app.get_webview_window("main") {
                    let url = format!("http://{}:{}/", BACKEND_HOST, BACKEND_PORT);
                    let parsed = url
                        .parse()
                        .map_err(|e| format!("bad backend url {url}: {e}"))?;
                    win.navigate(parsed)
                        .map_err(|e| format!("navigate failed: {e}"))?;
                }
            } else {
                let reason = startup_error.clone().unwrap_or_else(|| "backend did not start".to_string());
                if let Some(win) = app.get_webview_window("main") {
                    if let Err(err) = show_startup_error_page(&win, &reason) {
                        warn!("{err}");
                    }
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                win.show().map_err(|e| format!("show failed: {e}"))?;
            }

            // System-tray indicator. GNOME shows this in the top bar
            // (via AppIndicator), KDE / XFCE / Windows in the
            // notification-area tray. Left-click toggles window
            // visibility, right-click reveals the menu (Show / Quit).
            // Failure here is non-fatal — the app still works without
            // a tray on platforms that don't support it.
            let show_item = MenuItem::with_id(app, "show", "Show notesci", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;
            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("notesci-tray")
                .tooltip("notesci")
                .menu(&menu);
            if let Some(ic) = icon {
                tray_builder = tray_builder.icon(ic);
            }
            let _ = tray_builder
                .on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => {
                        kill_backend(app_handle);
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click toggles. The Tauri tray fires several
                    // event types; only act on a real button release.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app_handle = tray.app_handle();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            match win.is_visible() {
                                Ok(true) => {
                                    let _ = win.hide();
                                }
                                _ => {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(app);

            Ok(())
        })
        .on_window_event(|win, event| {
            // Intercept close to avoid surprising quits from dialog windows.
            // On Windows, closing the main window fully exits the app
            // to avoid orphaned backend processes.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if win.label() == "main" {
                    api.prevent_close();
                    #[cfg(windows)]
                    {
                        let app_handle = win.app_handle();
                        kill_backend(&app_handle);
                        app_handle.exit(0);
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = win.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Debug)]
enum LayoutKind {
    /// Debian `.deb` install — system Python venv + backend under /opt/notesci.
    Installed,
    /// macOS / Windows / AppImage — relocatable Python + backend bundled in
    /// the Tauri resource dir (resource_dir()/python, /backend, /frontend).
    Bundled,
    /// `cargo tauri dev` from the repo — in-tree backend/.venv + frontend/dist.
    Dev,
}

#[derive(Debug)]
struct Layout {
    kind: LayoutKind,
    python: std::path::PathBuf,
    backend_cwd: std::path::PathBuf,
    pythonpath: std::path::PathBuf,
    static_dir: std::path::PathBuf,
    env_file: std::path::PathBuf,
    local_token: std::path::PathBuf,
    backend_log: std::path::PathBuf,
}

fn resolve_layout(resource_dir: &Path, user_data_dir: &Path) -> Layout {
    let local_token = user_data_dir.join(TOKEN_FILENAME);
    let backend_log = user_data_dir.join("runtime").join(STARTUP_LOG_FILE);

    // 1. Installed (.deb): system venv at /opt/notesci. Checked first so
    //    the Debian path is never shadowed by a stray bundled tree.
    if Path::new(BACKEND_VENV_PYTHON).exists() {
        return Layout {
            kind: LayoutKind::Installed,
            python: BACKEND_VENV_PYTHON.into(),
            backend_cwd: BACKEND_CWD.into(),
            pythonpath: BACKEND_PYTHONPATH.into(),
            static_dir: FRONTEND_STATIC_DIR.into(),
            env_file: CONFIG_FILE.into(),
            local_token,
            backend_log: backend_log.clone(),
        };
    }

    // 2. Bundled (macOS / Windows / AppImage): relocatable Python + backend
    //    staged into the resource dir (mirrors pg::detect). Windows has no
    //    bin/ — the interpreter is python/python.exe at the python/ root.
    let py_root = resource_dir.join("python");
    let bundled_python = if cfg!(windows) {
        py_root.join("python.exe")
    } else {
        py_root.join("bin").join("python3")
    };
    if bundled_python.exists() {
        let backend_cwd = resource_dir.join("backend");
        return Layout {
            kind: LayoutKind::Bundled,
            python: bundled_python,
            pythonpath: backend_cwd.join("src"),
            backend_cwd,
            static_dir: resource_dir.join("frontend"),
            // No /etc/notesci on macOS/Windows/AppImage; embedded PG (pg.rs)
            // supplies DATABASE_URL via env_overrides, API keys come from a
            // per-user conf created on demand under the data dir.
            env_file: user_data_dir.join("notesci.conf"),
            local_token,
            backend_log: backend_log.clone(),
        };
    }

    // 3. Dev (cargo tauri dev from the repo).
    Layout {
        kind: LayoutKind::Dev,
        python: DEV_BACKEND_PYTHON.into(),
        backend_cwd: DEV_BACKEND_CWD.into(),
        pythonpath: DEV_BACKEND_PYTHONPATH.into(),
        static_dir: DEV_FRONTEND_STATIC_DIR.into(),
        env_file: DEV_ENV_FILE.into(),
        local_token,
        backend_log,
    }
}

/// Parse a KEY=VALUE env file (systemd EnvironmentFile format, also
/// compatible with dotenv). Ignores blank lines and `#` comments.
/// Strips surrounding single/double quotes from values. Returns a map.
fn load_env_file(path: &Path) -> Result<HashMap<String, String>, std::io::Error> {
    let body = std::fs::read_to_string(path)?;
    let mut out = HashMap::new();
    for (i, raw_line) in body.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            warn!("env file {}:{} skipped (no `=`)", path.display(), i + 1);
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        // Strip surrounding quotes.
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .to_string();
        out.insert(key, value);
    }
    Ok(out)
}

fn backend_startup_timeout(env: &HashMap<String, String>) -> Duration {
    env.get(STARTUP_TIMEOUT_ENV)
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds.clamp(30, 900)))
        .unwrap_or(STARTUP_TIMEOUT_DEFAULT)
}

fn spawn_backend(layout: &Layout, env: &HashMap<String, String>) -> std::io::Result<Child> {
    // Belt-and-suspenders: the bundle re-tar (deb/rpm) and AppImage squashfs
    // don't reliably preserve the +x bit on the staged interpreter, and a
    // non-executable python means the backend never spawns. Restore it on
    // the Bundled interpreter before exec. (Unix only — Windows ignores it.)
    #[cfg(unix)]
    if matches!(layout.kind, LayoutKind::Bundled) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&layout.python) {
            let mut perm = meta.permissions();
            perm.set_mode(perm.mode() | 0o755);
            let _ = std::fs::set_permissions(&layout.python, perm);
        }
    }
    let port_str = BACKEND_PORT.to_string();
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&layout.backend_log)?;
    let log_for_stdout = log_file.try_clone()?;
    let mut cmd = Command::new(&layout.python);
    cmd.args([
        "-m",
        "notesci.serve",
        "--host",
        BACKEND_HOST,
        "--port",
        &port_str,
    ])
    .current_dir(&layout.backend_cwd)
    .env("PYTHONPATH", &layout.pythonpath)
    .env("NOTESCI_STATIC_DIR", &layout.static_dir)
    // Single-user desktop: the backend bootstraps a default workspace +
    // member on first launch and writes a session token to the path
    // below. We read it back below and inject into the WebView so the
    // user never sees a sign-in screen.
    .env("NOTESCI_LOCAL_MODE", "1")
    .env("NOTESCI_LOCAL_TOKEN_PATH", &layout.local_token);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::from(log_for_stdout));
    cmd.stderr(std::process::Stdio::from(log_file));
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

fn wait_for_backend(host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let addr = format!("{host}:{port}");
    let start = Instant::now();
    let mut last_error: Option<String> = None;
    while start.elapsed() < timeout {
        if let Err(err) = wait_for_readyz(&addr) {
            last_error = Some(err);
        } else {
            return Ok(());
        }
        thread::sleep(STARTUP_POLL_INTERVAL);
    }
    Err(format!(
        "backend at {addr} did not become ready within {:?}: {}",
        timeout,
        last_error.unwrap_or_else(|| "connection refused".to_string())
    ))
}

fn wait_for_backend_child(
    host: &str,
    port: u16,
    timeout: Duration,
    child: &mut Child,
) -> Result<(), String> {
    let addr = format!("{host}:{port}");
    let start = Instant::now();
    let mut last_error: Option<String> = None;
    while start.elapsed() < timeout {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("backend status check failed: {e}"))?
        {
            return Err(format!("backend process exited before ready: {status}"));
        }
        if let Err(err) = wait_for_readyz(&addr) {
            last_error = Some(err);
        } else {
            return Ok(());
        }
        thread::sleep(STARTUP_POLL_INTERVAL);
    }
    Err(format!(
        "backend at {addr} did not become ready within {:?}: {}",
        timeout,
        last_error.unwrap_or_else(|| "connection refused".to_string())
    ))
}

fn wait_for_readyz(addr: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("bad addr {addr}: {e}"))?,
        Duration::from_millis(500),
    )
    .map_err(|e| format!("connection failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| format!("readyz read timeout setup failed: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| format!("readyz write timeout setup failed: {e}"))?;
    let request = format!(
        "GET /readyz HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nUser-Agent: notesci-desktop\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("readyz write failed: {e}"))?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        let n = stream
            .read(&mut buf)
            .map_err(|e| format!("readyz read failed: {e}"))?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&buf[..n]);
        if response.len() > 4096 {
            break;
        }
    }
    let response = String::from_utf8_lossy(&response);
    let status = response.lines().next().unwrap_or("");

    if status.contains("200") {
        return Ok(());
    }

    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or("");
    Err(format!(
        "readyz status not ready: {} (body: {})",
        status, body
    ))
}

fn read_log_tail(path: &Path, max_bytes: usize) -> std::io::Result<String> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    let len = file.metadata()?.len();
    if len > max_bytes as u64 {
        file.seek(SeekFrom::End(-(max_bytes as i64)))?;
    } else {
        file.seek(SeekFrom::Start(0))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn show_startup_error_page(win: &tauri::WebviewWindow, reason: &str) -> Result<(), String> {
    win.navigate("about:blank".parse().map_err(|e| format!("invalid about:blank url: {e}"))?)
        .map_err(|e| format!("failed to navigate to startup error page: {e}"))?;
    let reason_block = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"/><title>notesci startup failed</title>\
<style>body{{font-family:Arial,Helvetica,sans-serif;background:#fff3f0;color:#3c2a24;padding:40px;line-height:1.5;}}\
h1{{margin:0 0 8px;font-size:24px;color:#9a342e;}}code{{word-break:break-word;background:#fff;color:#2d1b17;padding:8px 10px;border:1px solid #f2d5cf;display:block;max-width:100%;}}</style>\
</head><body><h1>notesci could not start the backend</h1><p>The local backend did not become ready.</p>\
<button onclick=\"window.location.reload()\" style=\"font-size:14px;padding:10px 16px;border-radius:8px;border:1px solid #c85c45;background:#cf4f3f;color:#fff;cursor:pointer;\">Retry</button>\
<p><strong>Reason:</strong></p><code>{reason}</code><p>Check logs and retry once the issue is resolved.</p></body></html>"
    );
    let script = format!(
        "document.open();document.write({});document.close();",
        serde_json::to_string(&reason_block)
            .map_err(|e| format!("json encode failed: {e}"))?
    );
    win.eval(&script)
        .map_err(|e| format!("failed to render startup error page: {e}"))?;
    Ok(())
}

/// Wipe per-user ``WebKitCache`` (and the
/// CacheStorage sibling) when the bundled frontend has changed since
/// the last launch. WebKitGTK uses heuristic caching when responses
/// lack ``Cache-Control`` headers, which means upgrading the .deb
/// doesn't reach the user without a manual cache wipe. We solve it
/// here so installs are self-healing: compare the on-disk
/// ``index.html`` mtime against a marker file we write each launch;
/// when the on-disk file is newer, drop the cache before the WebView
/// initialises so the next fetch repopulates from the new bundle.
fn maybe_invalidate_webview_cache(layout: &Layout, user_data_dir: &Path) {
    let index = layout.static_dir.join("index.html");
    let Ok(meta) = std::fs::metadata(&index) else {
        return;
    };
    let Ok(current_mtime) = meta.modified() else {
        return;
    };
    let data_dir = user_data_dir;
    let marker = data_dir.join(".frontend-mtime");
    let recorded = std::fs::read_to_string(&marker).ok();
    let current_stamp = match current_mtime.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs().to_string(),
        Err(_) => return,
    };
    if recorded.as_deref() == Some(current_stamp.as_str()) {
        return;
    }
    for sub in ["WebKitCache", "CacheStorage"] {
        let p = data_dir.join(sub);
        if p.exists() {
            if let Err(e) = std::fs::remove_dir_all(&p) {
                warn!("failed to wipe {}: {}", p.display(), e);
            } else {
                info!("invalidated webview cache at {}", p.display());
            }
        }
    }
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::write(&marker, current_stamp);
}

/// Save a binary blob into a user-chosen folder via the OS folder dialog.
///
/// On Linux ``rfd``'s synchronous ``FileDialog`` MUST run
/// on the GTK main thread; calling it from a worker (e.g.
/// ``spawn_blocking``) silently fails — the dialog never appears and
/// the call returns ``None``. ``AsyncFileDialog::pick_folder`` plays
/// nicely with the Tauri runtime: rfd internally dispatches to the
/// GTK loop and awaits a result via channels.
///
/// The base64 decode + disk write happen inside ``spawn_blocking``
/// after we have a target path — those are CPU-bound and safe off
/// the main thread.
#[tauri::command]
async fn export_file(suggested_name: String, base64: String) -> Result<Option<String>, String> {
    log::info!(
        "export_file: folder dialog opening, name={} size={}",
        suggested_name,
        base64.len()
    );
    let default_dir = default_export_dir();
    let dialog_result = rfd::AsyncFileDialog::new()
        .set_title("Export PDF to Folder")
        .set_directory(default_dir)
        .pick_folder()
        .await;
    let Some(folder_handle) = dialog_result else {
        log::info!("export_file: user cancelled folder picker");
        return Ok(None);
    };
    let path = unique_export_path(folder_handle.path().join(safe_export_name(&suggested_name)));
    log::info!("export_file: writing to {}", path.display());
    let write_result =
        tauri::async_runtime::spawn_blocking(move || write_base64_to_path(base64, path))
            .await
            .map_err(|e| format!("join: {e}"))?;
    write_result.map(Some)
}

fn default_export_dir() -> std::path::PathBuf {
    let dir = std::env::var_os("XDG_DOWNLOAD_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join("Downloads"))
        })
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn safe_export_name(suggested_name: &str) -> String {
    let raw = std::path::Path::new(suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf");
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_control() || ch == '/' || ch == '\\' {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let mut name = cleaned.trim().trim_matches('.').to_string();
    if name.is_empty() {
        name = "document.pdf".to_string();
    }
    if !name.to_ascii_lowercase().ends_with(".pdf") {
        name.push_str(".pdf");
    }
    name
}

fn unique_export_path(path: std::path::PathBuf) -> std::path::PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().map(std::path::Path::to_path_buf);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("pdf");
    for i in 1..1000 {
        let candidate_name = format!("{stem}-{i}.{ext}");
        let candidate = parent
            .as_ref()
            .map(|p| p.join(&candidate_name))
            .unwrap_or_else(|| std::path::PathBuf::from(&candidate_name));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

fn write_base64_to_path(base64: String, path: std::path::PathBuf) -> Result<String, String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let bytes = decode_base64(&base64).map_err(|e| format!("decode: {e}"))?;
    let mut f = std::fs::File::create(&path).map_err(|e| format!("create: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Minimal base64 decoder. Avoids pulling in a whole crate for this
/// one use site — handles the standard alphabet without padding
/// strictness so the JS-side ``btoa`` output works.
fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    let s = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for &c in s {
        let v: u32 = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("invalid char {:?}", c as char)),
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// True only for plain ``http(s)`` URLs. Guards the open-* commands so a
/// crafted citation can't smuggle ``javascript:`` / ``file:`` / other
/// schemes into a system-browser launch or an in-app navigation.
fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Open ``url`` in the user's default system browser.
///
/// The WebView's ``window.open(_, '_blank')`` is a silent no-op under
/// WebKitGTK, so the external-source modal's "Open in browser" button
/// routes through here. Uses the shell plugin's cross-platform opener
/// (xdg-open / open / ShellExecute under the hood).
#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("unsupported url scheme".into());
    }
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(url, None)
        .map_err(|e| format!("open failed: {e}"))
}

// Injected into the in-app browser-preview window before each page load.
// It mounts a single floating "Add to notesci" button. On click it reads
// the *rendered* page's title + visible text — which, unlike a server-side
// httpx fetch, has already cleared any Cloudflare / JS interstitial — and
// hands it to the ``capture_source`` command. That command re-broadcasts
// it as a ``source-captured`` event the main window ingests. This is the
// only path that works for publishers (JAMA, etc.) that 403 automated
// fetches: the WebView is a real browser, so the content is actually here.
const CAPTURE_INIT_JS: &str = r#"
(function () {
  function invoke(cmd, args) {
    var w = window;
    var inv = (w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)
      || (w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke);
    return inv ? inv(cmd, args) : Promise.reject(new Error('tauri ipc unavailable'));
  }
  function mount() {
    if (!document.body) return;
    if (document.getElementById('notesci-capture-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'notesci-capture-btn';
    btn.type = 'button';
    btn.textContent = '＋ Add to notesci';
    btn.setAttribute('style', [
      'position:fixed','bottom:18px','right:18px','z-index:2147483647',
      'padding:10px 16px','border-radius:999px','border:none',
      'background:#3a40d8','color:#fff',
      'font:600 13px/1 system-ui,-apple-system,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.28)','cursor:pointer','opacity:0.95'
    ].join(';'));
    btn.addEventListener('click', function () {
      var text = ((document.body && document.body.innerText) || '').trim();
      var title = (document.title || '').trim();
      if (text.length < 80) {
        btn.textContent = 'Wait for the page to load…';
        setTimeout(function () { btn.textContent = '＋ Add to notesci'; }, 1800);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Adding…';
      invoke('capture_source', { url: location.href, title: title, text: text })
        .then(function () { btn.textContent = '✓ Added to notesci'; })
        .catch(function () { btn.textContent = 'Failed — try again'; btn.disabled = false; });
    });
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  // Late re-mount for slow / JS-challenge pages that swap the body in
  // after the initial load.
  setTimeout(mount, 1500);
  setTimeout(mount, 4000);
})();
"#;

/// Open ``url`` in an in-app browser window.
///
/// Unlike an ``<iframe>`` — which publisher pages refuse to render via
/// ``X-Frame-Options`` / CSP ``frame-ancestors`` — a top-level native
/// WebView navigation isn't subject to framing restrictions, so the live
/// page actually appears. The window is bound to the ``source-preview``
/// capability, which grants the page exactly one command —
/// ``capture_source`` — so the injected "Add to notesci" button can hand
/// the rendered text back without exposing the rest of notesci's IPC.
///
/// A single reusable window (label ``source-preview``) is kept; repeat
/// clicks navigate the existing window instead of stacking new ones.
/// GTK window creation must happen on the main thread, so the build is
/// dispatched via ``run_on_main_thread``.
#[tauri::command]
fn open_link_preview(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("unsupported url scheme".into());
    }
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("bad url: {e}"))?;
    let window_title = match title {
        Some(t) if !t.trim().is_empty() => format!("{} — notesci", t.trim()),
        _ => "External source — notesci".to_string(),
    };
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app_for_main.get_webview_window("source-preview") {
            let _ = win.navigate(parsed);
            let _ = win.set_title(&window_title);
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
        match tauri::WebviewWindowBuilder::new(
            &app_for_main,
            "source-preview",
            tauri::WebviewUrl::External(parsed),
        )
        .title(window_title)
        .inner_size(1024.0, 800.0)
        .min_inner_size(480.0, 480.0)
        .resizable(true)
        .initialization_script(CAPTURE_INIT_JS)
        .build()
        {
            Ok(_) => {}
            Err(e) => warn!("preview window build failed: {e}"),
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

/// Receive the rendered title + visible text of the in-app browser
/// preview (sent by ``CAPTURE_INIT_JS``'s button) and re-broadcast it as a
/// ``source-captured`` event. The main window listens for that event and
/// runs the same ingestion as a URL add — except the text comes from a
/// real browser render, so Cloudflare-walled publishers work.
#[tauri::command]
fn capture_source(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    text: String,
) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("unsupported url scheme".into());
    }
    let payload = serde_json::json!({
        "url": url,
        "title": title,
        "text": text,
    });
    app.emit("source-captured", payload)
        .map_err(|e| format!("emit failed: {e}"))
}

// Label of the embedded child webview hosted inside the main window for
// the in-modal live preview.
const PREVIEW_WEBVIEW_LABEL: &str = "source-preview";

// Evaluated inside the embedded preview webview when the user clicks the
// modal's "＋ Add to notesci" strip button. Reads the *rendered* page —
// already past any Cloudflare / JS interstitial — and hands the text to
// ``capture_source``, which the main window ingests. Using eval (driven
// by a DOM button in the modal chrome) means the remote page needs no
// injected UI of its own for the embedded case.
const CAPTURE_EVAL_JS: &str = r#"
(function () {
  try {
    var text = ((document.body && document.body.innerText) || '').trim();
    var title = (document.title || '').trim();
    var w = window;
    var inv = (w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)
      || (w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke);
    if (inv) inv('capture_source', { url: location.href, title: title, text: text });
  } catch (e) {}
})();
"#;

/// Embed (or reposition) the in-app browser as a native child webview of
/// the main window, overlaid on the review modal's content area.
///
/// The frontend passes the modal host element's ``getBoundingClientRect``
/// (CSS px). The main window's webview fills the window's content area, so
/// those CSS coordinates map 1:1 to a child-webview ``LogicalPosition`` /
/// ``LogicalSize`` (DPR-independent). On the first call the child webview
/// is created (with the capture init script); subsequent calls — fired by
/// the frontend's ResizeObserver / window-resize handler — just move and
/// resize it so it tracks the modal. Requires the ``unstable`` Tauri
/// feature (``Window::add_child`` / ``get_webview``).
#[tauri::command]
fn embed_preview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("unsupported url scheme".into());
    }
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("bad url: {e}"))?;
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let pos = LogicalPosition::new(x.max(0.0), y.max(0.0));
        let size = LogicalSize::new(width.max(1.0), height.max(1.0));
        // Already embedded → just track the modal's new rect.
        if let Some(wv) = app_for_main.get_webview(PREVIEW_WEBVIEW_LABEL) {
            let _ = wv.set_position(pos);
            let _ = wv.set_size(size);
            return;
        }
        let Some(main) = app_for_main.get_window("main") else {
            warn!("embed_preview: no main window");
            return;
        };
        // No injected in-page button here — the modal's own "＋ Add to
        // notesci" strip button drives capture via ``capture_from_preview``
        // (eval). The standalone fallback window keeps CAPTURE_INIT_JS
        // because it has no surrounding modal chrome.
        let builder = WebviewBuilder::new(
            PREVIEW_WEBVIEW_LABEL,
            tauri::WebviewUrl::External(parsed),
        );
        if let Err(e) = main.add_child(builder, pos, size) {
            warn!("embed_preview: add_child failed: {e}");
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

/// Tear down the embedded preview webview (modal closed / live view
/// dismissed). No-op when nothing is embedded.
#[tauri::command]
fn close_preview(app: tauri::AppHandle) -> Result<(), String> {
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(wv) = app_for_main.get_webview(PREVIEW_WEBVIEW_LABEL) {
            let _ = wv.close();
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

/// Capture the embedded preview's rendered page (triggered by the modal's
/// "＋ Add to notesci" button). Evaluates ``CAPTURE_EVAL_JS`` inside the
/// preview webview, which reads the page text and invokes
/// ``capture_source`` → ``source-captured`` event → main-window ingest.
#[tauri::command]
fn capture_from_preview(app: tauri::AppHandle) -> Result<(), String> {
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(wv) = app_for_main.get_webview(PREVIEW_WEBVIEW_LABEL) {
            if let Err(e) = wv.eval(CAPTURE_EVAL_JS) {
                warn!("capture_from_preview: eval failed: {e}");
            }
        } else {
            warn!("capture_from_preview: no preview webview");
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

// ── In-modal live source preview ──────────────────────────────────
//
// Embedding a child webview *inside* the main window (Window::add_child)
// is broken on Linux/WebKitGTK: the content area is a vertical gtk::Box
// that ignores the requested (x,y) and stacks children, so a positioned
// overlay always lands in the wrong place (tauri-apps/tauri#10420). So
// instead of trying to position a webview over a modal, we render the
// source as DOM *inside* the modal: a small loader window opens the page,
// reads the bytes/text via a same-origin fetch, and hands them back; the
// frontend then renders a PDF through its own pdf.js reader, or HTML text
// inline. No native positioning involved.
//
// The loader window is VISIBLE (not hidden): Cloudflare's "security
// verification" is a JS challenge whose timers are throttled — and which
// Cloudflare refuses to clear — when the page is backgrounded
// (document.hidden). A foreground window lets the managed challenge
// auto-complete in a few seconds (and lets the user click an interactive
// one), after which the same-origin fetch returns the real content and
// the window closes itself.

const PREVIEW_FETCH_LABEL: &str = "source-fetch";

// Runs inside the loader window. Once the page has loaded (and any
// Cloudflare interstitial has had a chance to set its clearance cookie),
// it polls a same-origin fetch of the current URL: a PDF response comes
// back as chunked base64, an HTML response as the page's visible text.
// Challenge pages are retried for ~45s (enough for a managed challenge to
// auto-clear or for the user to complete an interactive one) before
// giving up. The result is handed to the ``preview_bytes`` command
// (granted to this window via the ``source-fetch`` capability).
const PREVIEW_FETCH_INIT_JS: &str = r#"
(function () {
  function inv(cmd, args) {
    var w = window;
    var f = (w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)
      || (w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke);
    return f ? f(cmd, args) : Promise.reject(new Error('ipc'));
  }
  function b64(buf) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < buf.length; i += CH) {
      bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));
    }
    return btoa(bin);
  }
  function looksLikeChallenge(html) {
    return /just a moment|checking your browser|cf-browser-verification|enable javascript and cookies|__cf_chl/i.test(html);
  }
  var tries = 0, MAX = 30, done = false;
  function send(payload) { if (!done) { done = true; inv('preview_bytes', payload); } }
  function attempt() {
    if (done) return;
    tries++;
    fetch(location.href, { credentials: 'same-origin' }).then(function (r) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      var isPdf = ct.indexOf('application/pdf') >= 0
        || (/\.pdf(\?|#|$)/i.test(location.href) && ct.indexOf('text/html') < 0);
      if (isPdf) {
        return r.arrayBuffer().then(function (ab) {
          send({ url: location.href, kind: 'pdf', contentType: ct, base64: b64(new Uint8Array(ab)), text: '' });
        });
      }
      return r.text().then(function (html) {
        if (looksLikeChallenge(html) && tries < MAX) { setTimeout(attempt, 1500); return; }
        var bodyText = ((document.body && document.body.innerText) || '').trim();
        var text = bodyText.length > 200 ? bodyText
          : html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        send({ url: location.href, kind: 'html', contentType: ct, base64: '', text: text });
      });
    }).catch(function (e) {
      if (tries < MAX) { setTimeout(attempt, 1500); }
      else { send({ url: location.href, kind: 'error', contentType: '', base64: '', text: String((e && e.message) || e) }); }
    });
  }
  function go() { setTimeout(attempt, 700); }
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go);
  setTimeout(attempt, 2500);
})();
"#;

/// Spawn (or reuse) a VISIBLE loader window that opens ``url`` in a real
/// browser so any Cloudflare / JS security check can actually complete
/// (a hidden/backgrounded page is throttled and the challenge never
/// clears). Once cleared, its init script fetches the page and reports it
/// via the ``preview-bytes`` event, after which ``preview_bytes`` closes
/// this window — the content then renders inside the review modal.
#[tauri::command]
fn start_preview_fetch(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err("unsupported url scheme".into());
    }
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("bad url: {e}"))?;
    info!("start_preview_fetch: {}", url);
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app_for_main.get_webview_window(PREVIEW_FETCH_LABEL) {
            let _ = win.navigate(parsed);
            let _ = win.show();
            let _ = win.set_focus();
            return;
        }
        match tauri::WebviewWindowBuilder::new(
            &app_for_main,
            PREVIEW_FETCH_LABEL,
            tauri::WebviewUrl::External(parsed),
        )
        .title("Completing the publisher’s security check — notesci")
        .inner_size(900.0, 800.0)
        .min_inner_size(420.0, 420.0)
        .center()
        .focused(true)
        .initialization_script(PREVIEW_FETCH_INIT_JS)
        .build()
        {
            Ok(_) => {}
            Err(e) => warn!("start_preview_fetch build failed: {e}"),
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

/// Close the loader window without waiting for a result — used when the
/// user dismisses the review modal or backs out mid-verification, so the
/// visible loader window doesn't linger.
#[tauri::command]
fn cancel_preview_fetch(app: tauri::AppHandle) -> Result<(), String> {
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app_for_main.get_webview_window(PREVIEW_FETCH_LABEL) {
            let _ = win.close();
        }
    })
    .map_err(|e| format!("dispatch to main thread failed: {e}"))?;
    Ok(())
}

/// Receive the loader window's fetched page (PDF bytes or HTML text),
/// re-broadcast it to the main window as a ``preview-bytes`` event, then
/// dispose of the loader window.
#[tauri::command]
fn preview_bytes(
    app: tauri::AppHandle,
    url: String,
    kind: String,
    content_type: String,
    base64: String,
    text: String,
) -> Result<(), String> {
    info!(
        "preview_bytes: kind={} content_type={} base64_len={} text_len={}",
        kind,
        content_type,
        base64.len(),
        text.len()
    );
    let payload = serde_json::json!({
        "url": url,
        "kind": kind,
        "contentType": content_type,
        "base64": base64,
        "text": text,
    });
    app.emit("preview-bytes", payload)
        .map_err(|e| format!("emit failed: {e}"))?;
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = app_for_main.get_webview_window(PREVIEW_FETCH_LABEL) {
            let _ = win.close();
        }
    });
    Ok(())
}

fn kill_backend(app_handle: &tauri::AppHandle) {
    let state: tauri::State<BackendChild> = app_handle.state();
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        let _ = child.kill();
        let _ = child.wait();
        info!("backend (pid {pid}) killed on app exit");
    }
    // Then stop embedded PG (no-op in system-PG mode). Order matters:
    // backend first so the connection pool drains cleanly before the
    // server it was talking to disappears, which keeps PG from logging
    // spurious "client connection lost" warnings on shutdown.
    let pg_state: tauri::State<PgMode> = app_handle.state();
    let pg_guard = pg_state.0.lock().unwrap();
    pg::stop(&pg_guard);
}
