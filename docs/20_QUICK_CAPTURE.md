# 20 · Quick capture companion

A web page only sees the keyboard while its tab is focused, so the Hub alone cannot offer a global shortcut. `apps/quick-capture` is a small [Tauri 2](https://v2.tauri.app/) app (system webview, tray icon, global shortcut) that does. It is separate from the main desktop app, which has no tray or global shortcut ([DESKTOP](DESKTOP.md)).

The popup collects one sentence and posts it to `POST /api/capture` on loopback. hub-api (`apps/hub-api/src/cowork/capture.ts`) turns "remind Priya about the contract Friday" into a task; the shell does not parse anything.

## Shortcut

| | macOS | Windows and Linux |
|---|---|---|
| Global shortcut | Command-Control-Shift-U | Ctrl+Alt+Shift+U |
| In a focused Hub tab | The same chord, and `C` when you are not typing | The same |

The chord lives in one file, `packages/shared-types/src/capture-chord.json`. The Hub builds its binding from it (`packages/shared-types/src/shortcuts.ts`) and the shell compiles it in (`src-tauri/src/chord.rs`), so changing the global chord means editing that file and rebuilding. Settings → Shortcuts changes only the in-tab binding. `mod` is Command on macOS (`Modifiers::SUPER`); Windows and Linux use Ctrl+Alt+Shift and never the Super/Windows key. Shortcut labels follow the webview's platform.

If the OS refuses the shortcut, the tray menu and the in-tab shortcut still work. On some Linux desktops a left-click on the tray icon does nothing; the menu (right-click) always has **Quick capture** and **Quit**.

## How it is built

- The same window, tray and shortcut APIs on macOS, Windows and Linux. The popup is a normal Tauri window (no NSPanel, no `macos-private-api`). On macOS the process uses the Accessory activation policy so it sits in the menu bar.
- HTTP is sent from Rust with rustls; the token never enters the webview.
- No `osascript` or other shell tools.
- Config is `capture.json` in Tauri's app config folder: `~/Library/Application Support/com.ensemblework.capture` (macOS), `%APPDATA%\com.ensemblework.capture` (Windows), `$XDG_CONFIG_HOME/com.ensemblework.capture` or `~/.config/com.ensemblework.capture` (Linux). Mode 0600 on Unix; Windows keeps the user-profile ACL.
- The Cargo version must equal root `release.json`; `build.rs` checks it.

## Run it

Install a stable Rust toolchain and the Tauri system libraries (WebView2 on Windows, WebKitGTK 4.1 on Linux). Create a full personal token (`ens_…`) in Settings → Connections → Editors & agents; a read-only Connect key cannot create tasks.

```bash
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml -- --check   # prints this OS's chord, no window
export ENSEMBLE_TOKEN=ens_...
export ENSEMBLE_API=http://127.0.0.1:4000
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml
```

`ENSEMBLE_TOKEN` and `ENSEMBLE_API` override `capture.json`.

## Look

The app icon, header and tray mark are the generated Woven Chorus / Satin Gold assets from `pnpm brand:build` ([BRAND](BRAND.md)). The macOS tray uses a monochrome template; elsewhere the tray is gold on dark taskbars and ink on light ones. Saving plays a compact Beacon after 180 ms, stopped on success or error.

## Limits

- No browser cookie; the personal token is the credential.
- No microphone capture.
- No writes to Google or Outlook.
