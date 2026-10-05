//! Desktop shell for Ensemble.
//!
//! The packaged app serves a static export and a local hub-api. Set
//! `ENSEMBLE_SITE_URL` to open a hosted site instead.
//!
//! `site` is the part a future Android or iOS shell can reuse. `desktop` is
//! the menu, single-instance lock, and window placement.

mod assets;
mod diagnostics;
mod sidecar;
mod site;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use site::{
    blank_target_script, decide, desktop_init_script, is_shell, local_app_url, motion_probe_script,
    motion_report_prefix, parse_motion_theme, parse_site_url, resolve_site_url, theme_from_motion_path,
    NavDecision, ResolvedSite, SiteSource, MOTION_THEME_KEY,
};

const MAIN_WINDOW: &str = "main";
const COMPILED_SITE_URL: Option<&str> = option_env!("ENSEMBLE_SITE_URL");

pub struct AppState {
    config_path: PathBuf,
    motion_path: PathBuf,
    url: String,
    source: SiteSource,
    last_error: Option<String>,
    hold_on_shell: bool,
    shell: Url,
    trust_navigation_until: Option<Instant>,
    /// Copy of the site's motion style. Absent means the offline page shows the still U.
    motion_theme: Option<String>,
}

struct ProbeFailure {
    hard: bool,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellView {
    url: String,
    source: SiteSource,
    error: Option<String>,
    hold: bool,
    motion_key: &'static str,
    motion_theme: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop::focus_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("ensemble", |_ctx, request| assets::respond(request.uri().path()))
        .register_uri_scheme_protocol("motion", |ctx, request| {
            if let Some(theme) = theme_from_motion_path(request.uri().path()) {
                store_motion_theme(ctx.app_handle(), theme);
            }
            tauri::http::Response::builder()
                .status(204)
                .header(tauri::http::header::CACHE_CONTROL, "no-store")
                .body(Vec::<u8>::new())
                .expect("empty motion response")
        })
        .on_window_event(|window, event| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::on_window_event(window, event);
        })
        .setup(|app| {
            let hosted = explicit_hosted_url();
            let local = if hosted.is_none() {
                let root = if cfg!(debug_assertions) {
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hub-web/out")
                } else {
                    app.path().resource_dir().map_err(|error| error.to_string())?.join("web")
                };
                assets::set_web_root(root);
                match sidecar::start(app) {
                    Ok(running) => {
                        let api = (running.port, running.token.clone());
                        app.manage(Mutex::new(running));
                        Some(api)
                    }
                    Err(error) => {
                        eprintln!("ensemble desktop: {error}");
                        None
                    }
                }
            } else {
                None
            };
            let state = load_state(app)?;
            app.manage(Mutex::new(state));
            let window = build_window(app, hosted.is_none(), local.as_ref())?;
            if let Ok(current) = window.url() {
                if is_shell(&current) {
                    if let Ok(mut guard) = app.state::<Mutex<AppState>>().lock() {
                        guard.shell = current;
                    }
                }
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                desktop::install_menu(app)?;
                let maximize = desktop::restore(&window);
                window.show()?;
                if maximize {
                    let _ = window.maximize();
                }
                desktop::mark_ready();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = desktop::check_for_updates(&handle, false).await;
                });
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![shell_state, connect_to])
        .build(tauri::generate_context!())
        .expect("Ensemble desktop failed to start")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                sidecar::stop(app);
            }
        });
}

fn explicit_hosted_url() -> Option<String> {
    std::env::var("ENSEMBLE_SITE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| COMPILED_SITE_URL.map(str::to_string).filter(|value| !value.trim().is_empty()))
}

fn load_state(app: &tauri::App) -> Result<AppState, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let config_path = dir.join("site.json");
    let motion_path = dir.join("motion.json");
    let saved = read_saved(&config_path);
    let env_value = std::env::var("ENSEMBLE_SITE_URL").ok();
    let resolved = resolve_site_url(env_value.as_deref(), saved.as_deref(), COMPILED_SITE_URL);
    Ok(state_from(config_path, motion_path, resolved))
}

fn state_from(config_path: PathBuf, motion_path: PathBuf, resolved: ResolvedSite) -> AppState {
    let motion_theme = read_motion(&motion_path);
    AppState {
        config_path,
        motion_path,
        url: resolved.url,
        source: resolved.source,
        hold_on_shell: resolved.error.is_some(),
        last_error: resolved.error,
        shell: Url::parse("http://tauri.localhost/").expect("shell origin"),
        trust_navigation_until: None,
        motion_theme,
    }
}

fn build_window(
    app: &mut tauri::App,
    local_mode: bool,
    local: Option<&(u16, String)>,
) -> Result<tauri::WebviewWindow, String> {
    let navigation = app.handle().clone();
    let popups = app.handle().clone();
    let start = if local_mode {
        WebviewUrl::External(local_app_url())
    } else if explicit_hosted_url().is_some() {
        let state = app.state::<Mutex<AppState>>();
        let guard = state.lock().map_err(|error| error.to_string())?;
        WebviewUrl::External(parse_site_url(&guard.url)?)
    } else {
        WebviewUrl::App("index.html".into())
    };
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, start)
        .title("Ensemble")
        .inner_size(1200.0, 800.0)
        .min_inner_size(880.0, 600.0)
        .center()
        .resizable(true)
        .visible(false)
        .background_color(tauri::window::Color(0x14, 0x12, 0x10, 0xff))
        .icon(tauri::include_image!("icons/128x128.png"))
        .map_err(|error| error.to_string())?;
    builder
        .initialization_script(initialization_script(local_mode, local))
        .on_navigation(move |url| on_navigation(&navigation, url))
        .on_new_window(move |url, _features| on_new_window(&popups, url))
        .build()
        .map_err(|error| error.to_string())
}

fn initialization_script(local_mode: bool, local: Option<&(u16, String)>) -> String {
    let mut parts = Vec::new();
    if local_mode {
        let (base, token) = match local {
            Some((port, token)) => (format!("http://127.0.0.1:{port}"), token.as_str()),
            None => (String::new(), ""),
        };
        parts.push(desktop_init_script(&base, token));
    }
    parts.push(blank_target_script().to_string());
    parts.push(motion_probe_script(motion_report_prefix()));
    parts.join("\n")
}

fn on_navigation(app: &tauri::AppHandle, url: &Url) -> bool {
    match decision_for(app, url) {
        NavDecision::Allow => {
            if !is_shell(url) && !navigation_is_trusted(app) {
                let app = app.clone();
                let target = url.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(failure) = probe(&target, Duration::from_secs(4)).await {
                        if failure.hard {
                            show_offline(&app, failure.message);
                        }
                    }
                });
            }
            true
        }
        NavDecision::OpenExternal => {
            open_external(app, url);
            false
        }
        NavDecision::Block => false,
    }
}

fn on_new_window(app: &tauri::AppHandle, url: Url) -> NewWindowResponse<tauri::Wry> {
    match decision_for(app, &url) {
        NavDecision::Allow if !is_shell(&url) => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.navigate(url);
            }
            NewWindowResponse::Deny
        }
        NavDecision::OpenExternal => {
            open_external(app, &url);
            NewWindowResponse::Deny
        }
        NavDecision::Allow | NavDecision::Block => NewWindowResponse::Deny,
    }
}

fn decision_for(app: &tauri::AppHandle, target: &Url) -> NavDecision {
    if is_shell(target) || matches!(target.scheme(), "about" | "blob") {
        return NavDecision::Allow;
    }
    let state = app.state::<Mutex<AppState>>();
    let Ok(guard) = state.lock() else {
        return NavDecision::Block;
    };
    match parse_site_url(&guard.url) {
        Ok(site) => decide(target, &site),
        Err(_) => match target.scheme() {
            "http" | "https" | "mailto" | "tel" => NavDecision::OpenExternal,
            _ => NavDecision::Block,
        },
    }
}

fn navigation_is_trusted(app: &tauri::AppHandle) -> bool {
    let state = app.state::<Mutex<AppState>>();
    let Ok(guard) = state.lock() else {
        return false;
    };
    guard
        .trust_navigation_until
        .is_some_and(|until| Instant::now() < until)
}

fn show_offline(app: &tauri::AppHandle, message: String) {
    let shell = {
        let state = app.state::<Mutex<AppState>>();
        let Ok(mut guard) = state.lock() else { return };
        guard.last_error = Some(message);
        guard.hold_on_shell = true;
        guard.shell.clone()
    };
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.navigate(shell);
    }
}

fn open_external(app: &tauri::AppHandle, url: &Url) {
    if let Ok(path) = std::env::var("ENSEMBLE_DESKTOP_EXTERNAL_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{url}");
        }
    }
    eprintln!("Opening in the system browser: {url}");
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("Could not open {url} ({error})");
    }
}

#[tauri::command]
fn shell_state(state: tauri::State<'_, Mutex<AppState>>) -> Result<ShellView, String> {
    let guard = state.lock().map_err(|error| error.to_string())?;
    Ok(ShellView {
        url: guard.url.clone(),
        source: guard.source,
        error: guard.last_error.clone(),
        hold: guard.hold_on_shell,
        motion_key: MOTION_THEME_KEY,
        motion_theme: guard.motion_theme.clone(),
    })
}

#[tauri::command]
async fn connect_to(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    url: String,
    save: bool,
) -> Result<(), String> {
    let chosen = url.trim().to_string();
    let parsed = parse_site_url(&chosen)?;
    if save {
        let path = {
            let guard = state.lock().map_err(|error| error.to_string())?;
            guard.config_path.clone()
        };
        write_site(&path, &chosen)?;
    }
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.url = chosen.clone();
        if save {
            guard.source = SiteSource::Saved;
        }
        guard.last_error = None;
        guard.hold_on_shell = false;
    }
    if let Err(failure) = probe(&parsed, Duration::from_secs(12)).await {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.last_error = Some(failure.message.clone());
        guard.hold_on_shell = true;
        return Err(failure.message);
    }
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.trust_navigation_until = Some(Instant::now() + Duration::from_secs(3));
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("The window is not open.")?;
    window.navigate(parsed).map_err(|error| error.to_string())?;
    Ok(())
}

async fn probe(url: &Url, timeout: Duration) -> Result<(), ProbeFailure> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| {
            eprintln!("ensemble desktop: HTTP client failed: {error}");
            ProbeFailure {
                hard: true,
                message: "Could not check the Ensemble server.".into(),
            }
        })?;
    match client.get(url.clone()).send().await {
        Ok(response) => {
            let status = response.status();
            drop(response);
            if status.is_server_error() && status.as_u16() >= 502 {
                return Err(ProbeFailure {
                    hard: true,
                    message: "The Ensemble server is not answering.".into(),
                });
            }
            Ok(())
        }
        Err(error) => {
            eprintln!("ensemble desktop: probe {url} failed: {error}");
            Err(ProbeFailure {
                hard: !error.is_timeout(),
                message: explain_network(&error),
            })
        }
    }
}

fn explain_network(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The Ensemble server did not answer in time.".into()
    } else if error.is_connect() {
        "Cannot connect to the Ensemble server. It may be stopped.".into()
    } else {
        "Cannot reach the Ensemble server.".into()
    }
}

fn store_motion_theme(app: &tauri::AppHandle, theme: &str) {
    let Some(theme) = parse_motion_theme(Some(theme)) else {
        return;
    };
    let Some(state) = app.try_state::<Mutex<AppState>>() else {
        return;
    };
    let path = {
        let Ok(guard) = state.lock() else { return };
        if guard.motion_theme.as_deref() == Some(theme) {
            return;
        }
        guard.motion_path.clone()
    };
    if write_motion(&path, theme).is_err() {
        return;
    }
    if let Ok(mut guard) = state.lock() {
        guard.motion_theme = Some(theme.to_string());
    };
}

fn read_motion(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parse_motion_theme(value.get("theme").and_then(|theme| theme.as_str())).map(str::to_string)
}

fn write_motion(path: &Path, theme: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "theme": theme }))
        .map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_saved(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("url")
        .and_then(|url| url.as_str())
        .map(str::to_string)
}

fn write_site(path: &Path, url: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "url": url }))
        .map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
