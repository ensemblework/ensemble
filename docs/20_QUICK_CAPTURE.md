# 20 · Quick capture companion

Capture a task from anywhere on your computer with the Quick capture companion. Press its global shortcut, write one sentence and submit. For example, “remind Priya about the contract Friday” becomes a task.

Quick capture is separate from the main [desktop app](DESKTOP.md), which has no tray or global shortcut. A focused Hub tab can capture too, but a web page cannot hear a shortcut while another app is focused.

## Shortcut

| | macOS | Windows and Linux |
|---|---|---|
| Global shortcut | Command-Control-Shift-U | Ctrl+Alt+Shift+U |
| In a focused Hub tab | The same chord, and `C` when you are not typing | The same |

Change the shortcut in **Settings → Shortcuts** to change the focused Hub tab’s binding. The companion’s global shortcut stays as shown above. On Windows and Linux it uses Ctrl+Alt+Shift, not the Super or Windows key. Labels follow your platform.

If the OS refuses the shortcut, the tray menu and the in-tab shortcut still work. On some Linux desktops a left-click on the tray icon does nothing; the menu (right-click) always has **Quick capture** and **Quit**.

## Run it

To run the companion from source:

1. Install a stable Rust toolchain and the Tauri system libraries: WebView2 on Windows or WebKitGTK 4.1 on Linux.
2. Open **Settings → Connections → Editors & agents** and create a full personal token (`ens_…`). A read-only Connect key cannot create tasks.
3. Run the commands below with your token and local API address.

```bash
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml -- --check   # prints this OS's chord, no window
export ENSEMBLE_TOKEN=ens_...
export ENSEMBLE_API=http://127.0.0.1:4000
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml
```

`ENSEMBLE_TOKEN` and `ENSEMBLE_API` override `capture.json`.

## Limits

- No browser cookie; the personal token is the credential.
- No microphone capture.
- No writes to Google or Outlook.

## Look

The app icon, header and tray mark are the generated Woven Chorus / Satin Gold assets from `pnpm brand:build` ([BRAND](BRAND.md)). The macOS tray uses a monochrome template; elsewhere the tray is gold on dark taskbars and ink on light ones. Saving uses a local 16 px indicator after 250 ms and prevents duplicate submission. Success and failure clear the delay and indicator immediately.

Reduced motion keeps the status text and a still indicator.

## In the code

`apps/quick-capture` is a [Tauri 2](https://v2.tauri.app/) app using the system webview, tray and global-shortcut APIs. Its popup sends the sentence to `POST /api/capture` on loopback. `apps/hub-api/src/cowork/capture.ts` turns it into a task; the shell does no parsing.

The chord lives in one file, `packages/shared-types/src/capture-chord.json`. The Hub builds its binding from it (`packages/shared-types/src/shortcuts.ts`) and the shell compiles it in (`src-tauri/src/chord.rs`), so changing the global chord means editing that file and rebuilding. Settings → Shortcuts changes only the in-tab binding.

`mod` is Command on macOS (`Modifiers::SUPER`); Windows and Linux use Ctrl+Alt+Shift and never the Super/Windows key. Shortcut labels follow the webview's platform.

### How it is built

- The same window, tray and shortcut APIs on macOS, Windows and Linux. The popup is a normal Tauri window (no NSPanel, no `macos-private-api`). On macOS the process uses the Accessory activation policy so it sits in the menu bar.
- HTTP is sent from Rust with rustls; the token never enters the webview.
- No `osascript` or other shell tools.
- Config is `capture.json` in Tauri's app config folder: `~/Library/Application Support/com.ensemblework.capture` (macOS), `%APPDATA%\com.ensemblework.capture` (Windows), `$XDG_CONFIG_HOME/com.ensemblework.capture` or `~/.config/com.ensemblework.capture` (Linux). Mode 0600 on Unix; Windows keeps the user-profile ACL.
- The Cargo version must equal root `release.json`; `build.rs` checks it.
