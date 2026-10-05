# 20 · Quick capture companion

The Hub is a website. A website only sees the keyboard while its tab is focused, so Command-Control-Shift-U cannot be global from `apps/hub-web` alone.

## Choice

`apps/quick-capture` is a small [Tauri 2](https://v2.tauri.app/) shell: a system webview, a tray icon, and a global shortcut. It posts the sentence to `POST /api/capture` on loopback. Turning “remind Priya about the contract Friday” into a task happens in hub-api (`apps/hub-api/src/cowork/capture.ts`). The shell does not parse reminders.

This is the shell a later native port can grow, not a Mac-only helper and not a second browser.

| Decision | Why it stays portable |
|---|---|
| Tauri 2, system webview | The same window, tray, and shortcut APIs exist on macOS, Windows, and Linux. No Electron Chromium, no tkinter, no pyobjc. |
| No NSPanel and no `macos-private-api` | Those are macOS-only. The popup is a normal Tauri window. On macOS the process uses the Accessory activation policy so it can sit in the menu bar; that call is compiled only on macOS. |
| Shortcut modifiers per OS | `mod` in the shared file is Command on macOS (`Modifiers::SUPER` in Tauri’s enum, which is Command on a Mac). Windows and Linux use Ctrl+Alt+Shift and never the Super / Windows key. |
| One chord file | `packages/shared-types/src/capture-chord.json`. The Hub builds its binding from it. The shell compiles the same file in. |
| HTTP from Rust, rustls | The page only collects text. The token is not in the webview. rustls avoids a per-OS OpenSSL. |
| Config directory from the OS | Tauri’s app config dir: `~/Library/Application Support/com.ensemblework.capture` on macOS, `%APPDATA%\com.ensemblework.capture` on Windows, `$XDG_CONFIG_HOME/com.ensemblework.capture` or `~/.config/com.ensemblework.capture` on Linux. The file is `capture.json`, joined with the platform path API. On Unix it is mode `0600`. Windows keeps the user-profile ACL. |
| No `osascript` or other shell tools | The shell does not pick folders or drive the OS through a script. |

The in-app fallback stays in the Hub (`C` when you are not typing, and the same chord while the tab is focused). Shortcut labels read the webview platform. They do not assume a Mac.

| | macOS | Windows and Linux |
|---|---|---|
| Global shortcut | Command-Control-Shift-U | Ctrl+Alt+Shift+U |
| In the Hub tab | The same chord, and C when you are not typing | The same |

Those chords are not Cmd-Q, Cmd-W, Cmd-Tab, Ctrl-Alt-Delete, Alt-F4, or the Super key.

Linux note: a left-click on the tray icon does not emit a click on every desktop. The menu always has Quick capture. Right-click opens that menu.

## Run it

Install Rust 1.90 or newer and the Tauri system libraries for your OS (WebView2 on Windows, WebKitGTK 4.1 on Linux). Create a personal token in Settings → Editors & agents (it starts with `ens_`). It needs a full key, not the read-only Connect key.

```bash
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml -- --check
export ENSEMBLE_TOKEN=ens_...
export ENSEMBLE_API=http://127.0.0.1:4000
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml
```

`ENSEMBLE_TOKEN` and `ENSEMBLE_API` override `capture.json`. `--check` prints the chord for this OS and exits. It does not open a window.

macOS will ask for Accessibility permission the first time the shortcut is registered. If the OS refuses the shortcut, the tray menu and the Hub tab shortcut still work.

## What it does not do

- It does not read the browser cookie. A personal token is the credential.
- It does not change the shortcut from Settings. Edit `packages/shared-types/src/capture-chord.json`.
- It does not capture the microphone.
- It does not write to Google or Outlook.
