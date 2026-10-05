//! One Node process: hub-api, its worker, and its scheduler.
//!
//! The shell starts it, waits until the discovery file appears, and stops the
//! process group on quit. The API binds 127.0.0.1 on a random port.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

pub struct Sidecar {
    pid: Arc<Mutex<Option<u32>>>,
    stop: Arc<AtomicBool>,
    pub port: u16,
    pub token: String,
    pub log_path: PathBuf,
}

#[derive(Clone)]
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

#[derive(Deserialize)]
struct Discovery {
    port: u16,
    token: String,
}

pub fn start(app: &tauri::App) -> Result<Sidecar, String> {
    let data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&data, fs::Permissions::from_mode(0o700));
    }
    let log_dir = data.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let log_path = log_dir.join("sidecar.log");
    let discovery = data.join("api.json");
    let _ = fs::remove_file(&discovery);
    let token = random_token();
    let launch = launch_for(app)?;
    let stop = Arc::new(AtomicBool::new(false));
    let pid = Arc::new(Mutex::new(None));
    let child = spawn(&launch, &data, &discovery, &log_path, &token)?;
    {
        let mut slot = pid.lock().map_err(|error| error.to_string())?;
        *slot = Some(child.id());
    }
    watch(child, launch, data.clone(), discovery.clone(), log_path.clone(), token.clone(), stop.clone(), pid.clone());
    match wait_for_discovery(&discovery, &log_path, Duration::from_secs(45)) {
        Ok(found) if found.token == token => {
            eprintln!("ensemble desktop: local API on 127.0.0.1:{}", found.port);
            // Doc 25: remote tasks stay awake. macOS only; Linux has no App Nap.
            #[cfg(target_os = "macos")]
            keep_awake(data.clone(), stop.clone(), pid.clone());
            Ok(Sidecar {
                pid,
                stop,
                port: found.port,
                token,
                log_path,
            })
        }
        Ok(_) => {
            shutdown(&stop, &pid);
            Err("The local API wrote a discovery file this launch did not create.".into())
        }
        Err(error) => {
            shutdown(&stop, &pid);
            Err(error)
        }
    }
}

pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<Mutex<Sidecar>>() else {
        return;
    };
    let Ok(guard) = state.lock() else { return };
    shutdown(&guard.stop, &guard.pid);
}

fn shutdown(stop: &AtomicBool, pid: &Mutex<Option<u32>>) {
    stop.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = pid.lock() {
        if let Some(pid) = slot.take() {
            stop_pid(pid);
        }
    }
}

fn watch(mut child: Child, launch: Launch, data: PathBuf, discovery: PathBuf, log_path: PathBuf, token: String, stop: Arc<AtomicBool>, pid: Arc<Mutex<Option<u32>>>) {
    thread::spawn(move || {
        let mut restarts = 0;
        loop {
            let _ = child.wait();
            if stop.load(Ordering::SeqCst) {
                break;
            }
            restarts += 1;
            if restarts > 3 {
                let _ = append_log(&log_path, "sidecar exited and was not restarted again");
                if let Ok(mut slot) = pid.lock() {
                    *slot = None;
                }
                break;
            }
            thread::sleep(Duration::from_secs(1));
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match spawn(&launch, &data, &discovery, &log_path, &token) {
                Ok(next) => {
                    if let Ok(mut slot) = pid.lock() {
                        *slot = Some(next.id());
                    }
                    child = next;
                }
                Err(error) => {
                    let _ = append_log(&log_path, &format!("sidecar restart failed: {error}"));
                    break;
                }
            }
        }
    });
}

fn spawn(launch: &Launch, data: &Path, discovery: &Path, log_path: &Path, token: &str) -> Result<Child, String> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| error.to_string())?;
    let err = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .env("ENSEMBLE_DESKTOP", "1")
        .env("ENSEMBLE_DESKTOP_EMBED", "1")
        .env("ENSEMBLE_DESKTOP_TOKEN", token)
        .env("ENSEMBLE_DATA_DIR", data.join("pglite"))
        .env("ENSEMBLE_BACKUP_DIR", data.join("backups"))
        .env("ENSEMBLE_DISCOVERY_FILE", discovery)
        .env("HUB_API_HOST", "127.0.0.1")
        .env("HUB_API_PORT", "0")
        .env("REDIS_URL", "memory://desktop")
        .env("ENSEMBLE_DEV_AUTH_BYPASS", "false")
        .env("DATABASE_URL", "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop")
        .env("ENSEMBLE_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env_remove("NODE_ENV");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start the local API ({error})."))
}

fn launch_for(app: &tauri::App) -> Result<Launch, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hub-api");
        if !cwd.join("src/desktop/main.ts").is_file() {
            return Err(format!("Cannot find the hub-api sidecar at {}", cwd.display()));
        }
        // `node.exe`, not `node`. A `.cmd` shim cannot be spawned after Node's
        // batch-file hardening, and the dev shell must hit the real runtime.
        let program = if cfg!(windows) { "node.exe" } else { "node" };
        return Ok(Launch {
            program: PathBuf::from(program),
            args: vec!["--import".into(), "tsx".into(), "src/desktop/main.ts".into()],
            cwd,
        });
    }
    #[cfg(not(debug_assertions))]
    {
        let resource = app.path().resource_dir().map_err(|error| error.to_string())?;
        let base = resource.join("sidecar");
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let program = base.join(node_name);
        let cwd = base.join("app");
        if !program.is_file() {
            return Err(format!("The bundled Node runtime is missing ({}).", program.display()));
        }
        Ok(Launch {
            program,
            args: vec!["--import".into(), "tsx".into(), "src/desktop/main.ts".into()],
            cwd,
        })
    }
}

fn wait_for_discovery(path: &Path, log_path: &Path, timeout: Duration) -> Result<Discovery, String> {
    let started = Instant::now();
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Some(found) = parse_discovery(&text) {
                return Ok(found);
            }
        }
        if started.elapsed() > timeout {
            let tail = log_tail(log_path, 40);
            return Err(format!("The local API did not start.\n{tail}"));
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn parse_discovery(text: &str) -> Option<Discovery> {
    let value: Discovery = serde_json::from_str(text).ok()?;
    if value.port == 0 || value.token.len() < 16 {
        return None;
    }
    Some(value)
}

pub fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let mut text = String::new();
    let _ = file.read_to_string(&mut text);
    let kept: Vec<&str> = text.lines().rev().take(lines).collect();
    kept.into_iter().rev().collect::<Vec<_>>().join("\n")
}

fn append_log(path: &Path, line: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn stop_pid(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(400));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
}

/// The sidecar writes `remote.json` beside its data directory. The switch is off unless it says so.
fn remote_tasks_enabled(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    text.contains("\"enabled\": true") || text.contains("\"enabled\":true")
}

/// While remote tasks are on, `caffeinate -i -m -w <sidecar pid>` keeps the Mac from App Nap.
/// It ends when the sidecar process does. This is not NSProcessInfo; that needs an AppKit link.
#[cfg(target_os = "macos")]
fn keep_awake(data: PathBuf, stop: Arc<AtomicBool>, pid: Arc<Mutex<Option<u32>>>) {
    thread::spawn(move || {
        let mut awake: Option<Child> = None;
        while !stop.load(Ordering::SeqCst) {
            let on = remote_tasks_enabled(&data.join("remote.json"));
            if on && awake.is_none() {
                let sidecar = pid.lock().ok().and_then(|slot| *slot);
                if let Some(sidecar_pid) = sidecar {
                    if let Ok(child) = Command::new("/usr/bin/caffeinate")
                        .args(["-i", "-m", "-w", &sidecar_pid.to_string()])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        awake = Some(child);
                    }
                }
            } else if !on {
                if let Some(mut child) = awake.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            } else if let Some(child) = awake.as_mut() {
                if child.try_wait().ok().flatten().is_some() {
                    awake = None;
                }
            }
            thread::sleep(Duration::from_secs(2));
        }
        if let Some(mut child) = awake.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    });
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system random");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_json_needs_a_port_and_a_long_token() {
        assert!(parse_discovery(r#"{"port":4000,"token":"abcdefghijklmnop"}"#).is_some());
        assert!(parse_discovery(r#"{"port":0,"token":"abcdefghijklmnop"}"#).is_none());
        assert!(parse_discovery(r#"{"port":4000,"token":"short"}"#).is_none());
        assert!(parse_discovery("nope").is_none());
    }

    #[test]
    fn remote_switch_is_read_from_the_settings_file() {
        let dir = std::env::temp_dir().join(format!("ensemble-remote-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote.json");
        assert!(!remote_tasks_enabled(&path));
        fs::write(&path, "{\n  \"enabled\": false\n}\n").unwrap();
        assert!(!remote_tasks_enabled(&path));
        fs::write(&path, "{\n  \"enabled\": true\n}\n").unwrap();
        assert!(remote_tasks_enabled(&path));
        let _ = fs::remove_dir_all(&dir);
    }
}
