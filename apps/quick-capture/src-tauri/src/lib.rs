//! Tray popup and global shortcut. Reminder parsing lives in hub-api.
//! This shell uses Tauri's window, tray, and shortcut APIs on macOS, Windows, and Linux.
//! It does not call macOS-only tools (no osascript, no NSPanel, no private macOS API).

mod chord;

pub use chord::chord_label;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use chord::{capture_endpoint, capture_shortcut, config_file};

struct Settings {
    api: String,
    token: String,
    config_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureStatus {
    chord: String,
    has_token: bool,
    api: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureReply {
    title: String,
    people: Vec<String>,
    due_label: Option<String>,
}

fn show_capture(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn load_settings(dir: PathBuf) -> Settings {
    let config_path = config_file(&dir);
    let mut api = String::from("http://127.0.0.1:4000");
    let mut token = String::new();
    if let Ok(bytes) = std::fs::read(&config_path) {
        if let Ok(stored) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(value) = stored.get("api").and_then(|value| value.as_str()) {
                if !value.is_empty() {
                    api = value.to_string();
                }
            }
            if let Some(value) = stored.get("token").and_then(|value| value.as_str()) {
                token = value.to_string();
            }
        }
    }
    if let Ok(value) = std::env::var("ENSEMBLE_API") {
        if !value.is_empty() {
            api = value;
        }
    }
    if let Ok(value) = std::env::var("ENSEMBLE_TOKEN") {
        if !value.is_empty() {
            token = value;
        }
    }
    Settings { api, token, config_path }
}

fn write_settings(path: &std::path::Path, api: &str, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "api": api, "token": token }))
        .map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn capture_status(state: tauri::State<'_, Mutex<Settings>>) -> Result<CaptureStatus, String> {
    let settings = state.lock().map_err(|error| error.to_string())?;
    Ok(CaptureStatus {
        chord: chord_label(std::env::consts::OS),
        has_token: !settings.token.is_empty(),
        api: settings.api.clone(),
    })
}

#[tauri::command]
fn save_token(state: tauri::State<'_, Mutex<Settings>>, api: String, token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    let api = api.trim().to_string();
    if token.is_empty() {
        return Err("Paste a personal token first.".into());
    }
    capture_endpoint(&api)?;
    let mut settings = state.lock().map_err(|error| error.to_string())?;
    write_settings(&settings.config_path, &api, &token)?;
    settings.api = api;
    settings.token = token;
    Ok(())
}

#[tauri::command]
async fn submit_capture(state: tauri::State<'_, Mutex<Settings>>, text: String) -> Result<CaptureReply, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Type a reminder first.".into());
    }
    let (api, token) = {
        let settings = state.lock().map_err(|error| error.to_string())?;
        (settings.api.clone(), settings.token.clone())
    };
    if token.is_empty() {
        return Err("Paste a personal token first.".into());
    }
    let url = capture_endpoint(&api)?;
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = body.get("error").and_then(|value| value.as_str()).unwrap_or("The Hub refused that reminder.");
        return Err(message.to_string());
    }
    let task = body.get("task").cloned().unwrap_or(serde_json::Value::Null);
    let parsed = body.get("parsed").cloned().unwrap_or(serde_json::Value::Null);
    let title = task.get("title").and_then(|value| value.as_str()).unwrap_or("Saved").to_string();
    let mut people = Vec::new();
    if let Some(rows) = parsed.get("matched").and_then(|value| value.as_array()) {
        for row in rows {
            if let Some(name) = row.get("name").and_then(|value| value.as_str()) {
                people.push(name.to_string());
            }
        }
    }
    if let Some(rows) = parsed.get("unmatched").and_then(|value| value.as_array()) {
        for row in rows {
            if let Some(name) = row.as_str() {
                people.push(name.to_string());
            }
        }
    }
    let due_label = parsed.get("dueLabel").and_then(|value| value.as_str()).map(str::to_string);
    Ok(CaptureReply { title, people, due_label })
}

#[tauri::command]
fn hide_capture(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
            app.manage(Mutex::new(load_settings(dir)));

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            let open = MenuItem::with_id(app, "open", "Quick capture", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = tray_icon(taskbar_is_dark(app));
            let mut tray = TrayIconBuilder::new().icon(icon);
            // macOS treats a black-and-alpha image named as a template. The SVG
            // state set cannot play in a native tray image, so the menu bar stays
            // on the static idle mark.
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(true);
            }
            tray
                .menu(&menu)
                .tooltip("Ensemble")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_capture(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_capture(tray.app_handle());
                    }
                })
                .build(app)?;

            let shortcut = capture_shortcut(std::env::consts::OS).map_err(|error| error.to_string())?;
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            show_capture(app);
                        }
                    })
                    .build(),
            )?;
            if let Err(error) = app.global_shortcut().register(shortcut) {
                eprintln!("Global shortcut was not registered ({error}). Use the tray menu, or the shortcut inside the Hub.");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture_status, save_token, submit_capture, hide_capture])
        .run(tauri::generate_context!())
        .expect("Ensemble Capture failed to start");
}

fn taskbar_is_dark(app: &tauri::App) -> bool {
    app.webview_windows()
        .values()
        .next()
        .and_then(|window| window.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(true)
}

fn tray_icon(dark: bool) -> tauri::image::Image<'static> {
    // Round-4 tray PNGs, decoded to straight RGBA. macOS gets the 16pt @2x
    // template (black + alpha). Windows and Linux get the accent mark: #9d8fff
    // on a dark taskbar, #7c6af7 on a light one. Animated tray SVGs are not
    // played here; a native tray image is a single bitmap.
    #[cfg(target_os = "macos")]
    {
        let _ = dark;
        let bytes: &[u8] = include_bytes!("../icons/tray-template.rgba");
        return tauri::image::Image::new_owned(bytes.to_vec(), 32, 32);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let bytes: &[u8] = if dark {
            include_bytes!("../icons/tray-accent-light.rgba")
        } else {
            include_bytes!("../icons/tray-accent.rgba")
        };
        tauri::image::Image::new_owned(bytes.to_vec(), 44, 44)
    }
}
