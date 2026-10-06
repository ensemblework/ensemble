# Desktop app

`apps/desktop` is a [Tauri 2](https://v2.tauri.app/) window that runs Ensemble on this computer. It serves a static export of `apps/hub-web` and starts one Node sidecar (hub-api, the worker, and the scheduler) against an embedded PGlite database. There is no Docker, no hosted server, and no Postgres install.

`pnpm dev` and `pnpm --filter @ensemble/hub-web build` are unchanged. The export is a separate target (`ENSEMBLE_DESKTOP_EXPORT=1`). Set `ENSEMBLE_SITE_URL` to open a hosted site instead of the local bundle.

The Python agent-runtime is not bundled. With `ENSEMBLE_DESKTOP=1` the sidecar answers model calls in-process (`apps/hub-api/src/runtime/`, switch with `ENSEMBLE_INPROCESS_RUNTIME`), so chat and agent tasks work with a key pasted in Settings → Models. Plots export still needs the computer's own `python3` with matplotlib.

## Run it

Install Rust 1.87 or newer and the Tauri system libraries (WebKitGTK 4.1 on Linux, WebView2 on Windows, the system WebKit on macOS). The Edit menu's Cut, Copy, Paste and Select All items need libxdo on Linux. Building needs `libxdo-dev` (`libxdo-devel` on Fedora). At run time the `.deb` declares `libxdo3` and the `.rpm` declares `libxdo` (Fedora, or EPEL on RHEL). The AppImage carries its own copy. From the repo root:

```bash
pnpm desktop:export
pnpm --filter @ensemble/desktop dev
```

A dev build runs the sidecar from the workspace with `node --import tsx`. A packaged build uses `pnpm desktop:sidecar` first, which copies Node and a deployed hub-api into the bundle. The window opens at 1200×800. A second launch focuses the existing window.

The sidecar binds `127.0.0.1` on a random port and writes `api.json` (mode 0600) in the OS app-data folder for `com.ensemblework.desktop`. The Context Bridge and `scripts/ensemble-hook.mjs` read that file and otherwise keep `http://127.0.0.1:4000`.

## Build

```bash
pnpm desktop:build
```

Bundles are written under `apps/desktop/src-tauri/target/release/bundle/` (universal macOS builds use `target/universal-apple-darwin/release/bundle/`). The GitHub workflow [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) builds unsigned artifacts on pull requests, on every push to `desktop`, and on manual dispatch, and uploads them as `ensemble-desktop-macos`, `ensemble-desktop-windows`, and `ensemble-desktop-linux`:

| Runner | Bundles |
|---|---|
| macOS | universal `.app` and `.dmg` (arm64 + x64) |
| Windows | `.msi` and NSIS `.exe` |
| Linux | `.deb` and `.AppImage` |

Nothing is signed. There is no Apple certificate, no Windows Authenticode cert, and no Linux signing key. On macOS 14 and earlier, right-click the app → Open the first time; on macOS 15 and later, open it once, then System Settings → Privacy & Security → Open Anyway. Windows SmartScreen will warn. That is expected until signing is funded.

On a Mac, `pnpm desktop:dmg` builds an unsigned disk image locally. [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md) is the hand test for it.

## Local API

The window loads `ensemble://localhost` (on Windows, `http://ensemble.localhost`). The webview rewrites `/api` to the random loopback port and sends the launch token. It does not receive shell or filesystem permissions. Other origins, `mailto:`, and `tel:` open in the system browser. `javascript:` and `file:` are dropped.

The Ensemble menu exports a diagnostics file (versions and log tails, with the launch token and `ens_` keys removed) and checks for updates. An update is not installed while workspace jobs are running. Signing the updater artifacts needs the `TAURI_SIGNING_PRIVATE_KEY` secret; without it, CI builds unsigned installers.

Migrations run on launch. An existing database is copied into `backups/` first. A database written by a newer build is refused.

The key that encrypts saved model keys and the device token lives beside the data folder (`secret.key` next to `pglite/`), set by `src/desktop/main.ts` through `ENSEMBLE_SECRET_KEY_FILE`. A key left by an older build at `<app>/.ensemble/secret.key` is copied there once. The install folder is never written, so a read-only or replaced install keeps its saved keys. The `ensemble` CLI runs this same sidecar without the window ([26](26_CLI.md)); `scripts/assemble-desktop-sidecar.mjs --dest <dir>` packs it for the CLI.

`ENSEMBLE_SITE_URL` still opens a hosted origin instead of the local bundle. The packaged default does not.

## Motion style

The shell reads `localStorage["ensemble.appearance"]` and uses the `motion` field (`expressive`, `minimal-quiet`, or `minimal-dot`). It does not read or write `ensemble:motion-theme`. The probe calls `localStorage.getItem`, parses that JSON, and does not call `setItem`. A known value is copied to `motion.json`. An empty or unknown value does not clear a theme already saved. The offline page reads that copy from `shell_state`. With no copy, or when the system asks for reduced motion, the page shows the still Two-voices mark. A saved theme uses the dotted mark from the brand offline page.

The mark shown while the first connection is slow is brand.morph (`apps/desktop/ui/ensemble-morph.js` and `morph.css`), the single Expressive ribbon for every style. Motion style does not change that morph. Its durations live on `EnsembleMorph.BASE`. The wait before it appears is the slot's `data-delay` attribute, which the script reads; the shell does not keep a second copy of that number. Reduced motion shows the still mark after the same wait. The probe reports the theme through a `motion` URI the shell handles. The hosted page is not given Tauri commands. There is no tray.

Config directories, from the identifier `com.ensemblework.desktop`:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/com.ensemblework.desktop` |
| Windows | `%APPDATA%\com.ensemblework.desktop` |
| Linux | `$XDG_CONFIG_HOME/com.ensemblework.desktop` or `~/.config/com.ensemblework.desktop` |

Webview cookies live in the app data directory (`~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows, `~/.local/share/…` on Linux), which is separate from `site.json` on Linux.

For a one-off local run:

```bash
ENSEMBLE_SITE_URL=http://localhost:3000 pnpm desktop:dev
```

To bake a hosted origin into a build (still overridden by a saved URL or a runtime variable):

```bash
ENSEMBLE_SITE_URL=https://your-host.example pnpm desktop:build
```

The hosted site will be `https://app.ensemblework.com`. Until it is live, leave the default and point a build at it once it answers.

`ENSEMBLE_DESKTOP_EXTERNAL_LOG=/path/to/log` appends each URL handed to the system browser, one per line. It is for checking the navigation rule, not a user setting.

## Icon

The mark is **Two voices**. Raster files in `apps/desktop/src-tauri/icons/` are the recommended full-bleed set from `design/icons/app-icon/png/recommended/` (`ensemble-fullbleed-32.png`, `128`, `256` as `128x128@2x.png`, `1024` as `icon.png`, plus `ensemble.ico` and `ensemble.icns`). The SVG sources are `apps/desktop/src-tauri/icons/source/`, copied from `design/icons/app-icon/svg/ensemble-b-two-voices.svg` and `ensemble-b-two-voices-fullbleed.svg`. See `icons/SOURCE.txt` for the file map. Do not copy `tray-accent.png` or `tray-template.png`. Replace the rasters in place when a new export arrives. `tauri.conf.json` already points at those names.

## Known limits

- The default build ships the static export and the Node sidecar. `ENSEMBLE_SITE_URL` points the window at a hosted or dev site instead; the limits below about origins apply to that mode.
- Live updates inside the site still follow `NEXT_PUBLIC_HUB_API` baked into that site. Locally that is `http://127.0.0.1:4000`, which is a different origin from `http://localhost:3000` and is not rewritten. That is existing site behaviour, not a second desktop client.
- `http://localhost:3000` and `http://127.0.0.1:3000` are different origins. The session cookie belongs to the origin you configured. A link to the other one opens in the browser.
- Terminal passkeys and the code sandbox stay as they are on the server. This shell does not change them.
- macOS and Windows bundles are produced by CI and have not been launched here. Linux is the runtime that was exercised.
- The updater (`tauri-plugin-updater`) only installs signed updates, so CI builds without `TAURI_SIGNING_PRIVATE_KEY` cannot self-update. No code signing, no tray, no global shortcut. Quick capture remains `apps/quick-capture`.
- If the hosted site later sends a Content-Security-Policy that blocks the `motion` image, the shell stops receiving theme updates. The offline page keeps the last saved theme, or the still mark when nothing was saved.

## Phase 1b and mobile

**Phase 1b** is a later change to the hub, not a flag in this crate: a static export (or other client bundle) plus a client-side auth guard and bearer tokens, so the app can ship without a Next server in front. Do not start that by stripping middleware out of `apps/hub-web` from this shell. The session cookie, startup checks, `decrypt()`, and build env on the API stay untouched here so they do not collide with that work.

The local shell page is not the hosted origin. Tauri 2 serves it from `https://tauri.localhost` on macOS and Linux, and from `http://tauri.localhost` on Windows and Android unless `useHttpsScheme` is set. `tauri://localhost` is only for deep links, not the documented webview origin. This shell treats the `tauri.localhost` host and the `tauri:` scheme as the local page, so both forms stay in the window. On the Linux WebKit build exercised here, the offline page's location was `tauri://localhost`. A client bundle in phase 1b has to treat that webview origin as the app, and it still will not share `localStorage` with the hosted site.

**Mobile** (Tauri 2 Android, iOS, iPadOS) should reuse `src/site.rs` (URL choice and in-app vs browser) and `ui/` (the offline page). Keep new windowing code out of those files. Desktop-only pieces are already behind `cfg` for Android and iOS: the single-instance plugin, the menu, and window placement (`src/desktop.rs`). A mobile shell still needs its own WebView, a place to store `site.json`, and the same rule that the hosted origin gets no IPC. Signing, store listings, and a real host URL are separate from this phase.
