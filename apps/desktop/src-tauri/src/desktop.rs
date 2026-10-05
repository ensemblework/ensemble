//! Window behaviour that only exists on macOS, Windows, and Linux.
//! Mobile shells reuse the URL rules and the local page, not this file.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri_plugin_opener::OpenerExt;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, Window,
    WindowEvent,
};

static READY: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

pub fn mark_ready() {
    READY.store(true, Ordering::SeqCst);
}

pub fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let diagnostics = MenuItem::with_id(app, "diagnostics", "Export diagnostics", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", "Check for updates", true, None::<&str>)?;
    let reload_item = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let submenu = Submenu::with_items(app, "Ensemble", true, &[&diagnostics, &updates, &reload_item, &quit])?;
    // A custom menu replaces Tauri's default one. On macOS the webview only gets
    // Cmd+C, Cmd+V, Cmd+X, Cmd+A and Cmd+Z through Edit menu items, so without
    // this submenu paste (and copy, select all, undo) silently do nothing.
    // On Linux, muda 0.20's predefined Cut types "ctrl+X" through libxdo, and the
    // uppercase X makes that Ctrl+Shift+X, so the item does nothing. Linux gets its
    // own Cut item instead (see `linux_edit`); macOS and Windows keep the predefined one.
    #[cfg(target_os = "linux")]
    let cut = linux_edit::cut_item(app)?;
    #[cfg(not(target_os = "linux"))]
    let cut = PredefinedMenuItem::cut(app, None)?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&submenu, &edit])?;
    app.set_menu(menu)?;
    #[cfg(target_os = "linux")]
    {
        let handle = app.handle().clone();
        let _ = app.run_on_main_thread(move || linux_edit::show_cut_shortcut(&handle));
    }
    app.on_menu_event(|app, event| match event.id.as_ref() {
        "diagnostics" => {
            if let Err(error) = export_diagnostics(app) {
                eprintln!("ensemble desktop: diagnostics failed: {error}");
            }
        }
        "updates" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let message = check_for_updates(&app, true).await;
                eprintln!("ensemble desktop: {message}");
                if let Some(window) = app.get_webview_window("main") {
                    let text = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".into());
                    let _ = window.eval(&format!("console.info({text})"));
                }
            });
        }
        "reload" => reload(app),
        #[cfg(target_os = "linux")]
        linux_edit::CUT_ID => linux_edit::cut(app),
        "quit" => app.exit(0),
        _ => {}
    });
    Ok(())
}

/// Edit → Cut on Linux.
///
/// muda 0.20 (the version Tauri 2.12 pins) runs the predefined Cut item by sending
/// the key sequence "ctrl+X" through libxdo. libxdo reads the uppercase X as
/// Shift+X, so the webview gets Ctrl+Shift+X and nothing is cut. muda 0.21 drops
/// libxdo and fixes this, but Tauri does not accept muda 0.21 yet.
///
/// This item asks the focused WebKitWebView to run its own "Cut" editing command,
/// which is what WebKit runs for a real Ctrl+X: it fires the page's `cut` event and
/// moves the selection to the clipboard. It has no real accelerator, so a pressed
/// Ctrl+X still goes straight to the webview as before, and only the menu shows
/// the Ctrl+X label, the same way muda shows it for the predefined items.
#[cfg(target_os = "linux")]
mod linux_edit {
    use gtk::prelude::*;
    use tauri::menu::MenuItem;
    use tauri::{AppHandle, Manager};
    use webkit2gtk::WebViewExt;

    pub const CUT_ID: &str = "edit-cut";
    const CUT_TEXT: &str = "Cu&t";

    pub fn cut_item(app: &tauri::App) -> tauri::Result<MenuItem<tauri::Wry>> {
        MenuItem::with_id(app, CUT_ID, CUT_TEXT, true, None::<&str>)
    }

    pub fn cut(app: &AppHandle) {
        let window = app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
            .or_else(|| app.get_webview_window("main"));
        let Some(window) = window else { return };
        let result = window.with_webview(|webview| {
            webview.inner().execute_editing_command("Cut");
        });
        if let Err(error) = result {
            eprintln!("ensemble desktop: cut failed: {error}");
        }
    }

    /// Puts the Ctrl+X label on the Cut item of every window's menu bar.
    pub fn show_cut_shortcut(app: &AppHandle) {
        for window in app.webview_windows().into_values() {
            let Ok(vbox) = window.default_vbox() else { continue };
            for child in vbox.children() {
                if let Ok(bar) = child.downcast::<gtk::MenuBar>() {
                    label_cut_items(bar.upcast_ref());
                }
            }
        }
    }

    fn label_cut_items(shell: &gtk::MenuShell) {
        for child in shell.children() {
            let Ok(item) = child.downcast::<gtk::MenuItem>() else { continue };
            if let Some(submenu) = item.submenu().and_then(|menu| menu.downcast::<gtk::MenuShell>().ok()) {
                label_cut_items(&submenu);
                continue;
            }
            if !is_cut_label(item.label().as_deref()) {
                continue;
            }
            if let Some(label) = item.child().and_then(|child| child.downcast::<gtk::AccelLabel>().ok()) {
                label.set_accel(*gtk::gdk::keys::constants::x, gtk::gdk::ModifierType::CONTROL_MASK);
            }
        }
    }

    /// muda turns the "&" mnemonic marker into GTK's "_" before building the item.
    pub(super) fn is_cut_label(label: Option<&str>) -> bool {
        label.is_some_and(|label| label == CUT_TEXT.replace('&', "_"))
    }

    #[cfg(test)]
    mod tests {
        use super::is_cut_label;

        #[test]
        fn matches_only_the_cut_item_label() {
            assert!(is_cut_label(Some("Cu_t")));
            assert!(!is_cut_label(Some("_Copy")));
            assert!(!is_cut_label(Some("Cut")));
            assert!(!is_cut_label(None));
        }
    }
}

pub fn restore(window: &WebviewWindow) -> bool {
    let Some(path) = placement_path(window.app_handle()) else {
        return false;
    };
    let Some(placement) = read_placement(&path) else {
        return false;
    };
    if placement.width < 200 || placement.height < 200 {
        return placement.maximized;
    }
    let _ = window.set_size(Size::Physical(PhysicalSize {
        width: placement.width,
        height: placement.height,
    }));
    if position_is_usable(
        window,
        placement.x,
        placement.y,
        placement.width,
        placement.height,
    ) {
        let _ = window.set_position(Position::Physical(PhysicalPosition {
            x: placement.x,
            y: placement.y,
        }));
    }
    placement.maximized
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    if !matches!(
        event,
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
    ) {
        return;
    }
    save_placement(window);
}

fn export_diagnostics(app: &AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let (port, token, log_path) = if let Some(state) = app.try_state::<std::sync::Mutex<crate::sidecar::Sidecar>>() {
        if let Ok(sidecar) = state.lock() {
            (Some(sidecar.port), sidecar.token.clone(), Some(sidecar.log_path.clone()))
        } else {
            (None, String::new(), None)
        }
    } else {
        (None, String::new(), None)
    };
    let mut body = format!(
        "Ensemble desktop {}\nOS {} {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    if let Some(port) = port {
        body.push_str(&format!("local API 127.0.0.1:{port}\n"));
    } else {
        body.push_str("local API not running\n");
    }
    if let Some(log_path) = &log_path {
        body.push_str("\n--- sidecar log ---\n");
        body.push_str(&crate::sidecar::log_tail(log_path, 200));
        body.push('\n');
    }
    let redacted = crate::diagnostics::redact(&body, &[&token]);
    let path = crate::diagnostics::write_report(&data.join("diagnostics"), &redacted)?;
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
    Ok(())
}

pub async fn check_for_updates(app: &AppHandle, install: bool) -> String {
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return format!("Updates are not available ({error})."),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return "Ensemble is up to date.".into(),
        Err(error) => return format!("Could not check for updates ({error}). The app keeps running."),
    };
    if !install {
        return format!("Update {} is available.", update.version);
    }
    if jobs_running(app).await {
        return format!(
            "Update {} is ready. It will wait until workspace jobs finish.",
            update.version
        );
    }
    if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
        return format!("Could not install the update ({error}).");
    }
    app.request_restart();
    "Restarting to finish the update.".into()
}

async fn jobs_running(app: &AppHandle) -> bool {
    let (port, token) = {
        let Some(state) = app.try_state::<std::sync::Mutex<crate::sidecar::Sidecar>>() else {
            return false;
        };
        let Ok(guard) = state.lock() else { return false };
        (guard.port, guard.token.clone())
    };
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(4)).build() {
        Ok(client) => client,
        Err(_) => return true,
    };
    let url = format!("http://127.0.0.1:{port}/api/desktop/status");
    let Ok(response) = client.get(url).header("authorization", format!("Bearer {token}")).send().await else {
        return true;
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return true;
    };
    body.get("runningJobs").and_then(|value| value.as_u64()).unwrap_or(0) > 0
}

fn reload(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(current) = window.url() else { return };
    if crate::site::is_shell(&current) {
        let _ = window.eval("document.getElementById('connect')?.click()");
        return;
    }
    let _ = window.navigate(current);
}

fn save_placement(window: &Window) {
    let Some(path) = placement_path(window.app_handle()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if window.is_maximized().unwrap_or(false) {
        if let Some(mut previous) = read_placement(&path) {
            previous.maximized = true;
            let _ = write_placement(&path, &previous);
        }
        return;
    }
    let (Ok(size), Ok(pos)) = (window.inner_size(), window.outer_position()) else {
        return;
    };
    if size.width < 200 || size.height < 200 {
        return;
    }
    let _ = write_placement(
        &path,
        &Placement {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
        },
    );
}

fn position_is_usable(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    let right = x.saturating_add(width as i32);
    let bottom = y.saturating_add(height as i32);
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let monitor_right = origin.x.saturating_add(size.width as i32);
        let monitor_bottom = origin.y.saturating_add(size.height as i32);
        x < monitor_right && right > origin.x && y < monitor_bottom && bottom > origin.y
    })
}

fn placement_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window.json"))
}

fn read_placement(path: &std::path::Path) -> Option<Placement> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_placement(path: &std::path::Path, placement: &Placement) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(placement).map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| error.to_string())
}
