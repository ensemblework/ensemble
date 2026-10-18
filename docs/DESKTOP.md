# Desktop app

Desktop 0.3.3 carries the Woven Chorus icons, shared Hub themes and Expressive motion.

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

The Ensemble CLI's runner uses the same folder and the same sidecar (doc [26](26_CLI.md) §4), so a computer has one runtime. A `runtime.lock` keeps a second sidecar off the database: the shell attaches to a CLI runner that is already running (`api.json` answers `/health` with its token), leaves it running on quit, and starts its own on the same port and token if that runner stops. The packaged sidecar carries `scripts/ensemble-hook.mjs` and `scripts/ensemble-ask-mcp.mjs` at `app/scripts/hooks/`, and on Linux the Landlock helper at `bin/landrun` (built from pinned source with Go; release builds require it).

## Build

```bash
pnpm desktop:build
```

Release bundles are written under `apps/desktop/src-tauri/target/<target>/release/bundle/`. `.github/workflows/desktop.yml` builds separate macOS arm64 and x64 installers on matching native hosts, plus Windows x64 and Linux x64. The Node and Prisma sidecar architecture matches each app. Artifacts are `ensemble-desktop-macos-arm64`, `ensemble-desktop-macos-x64`, `ensemble-desktop-windows` and `ensemble-desktop-linux`.

A `desktop-v<version>` tag matching root `release.json` publishes the release after every platform succeeds. `scripts/desktop-release.mjs` checks all four updater packages/signatures, gives the two Mac archives distinct names and writes `latest.json`. Installers and signed updater packages are uploaded to a draft before publication. Updater signing uses `TAURI_SIGNING_PRIVATE_KEY`; publishing fails when signed packages are missing. PR builds may omit update signatures.

OS code-signing certificates are not configured: macOS Gatekeeper and Windows SmartScreen may warn on first install. Tauri updater signatures authenticate later in-app updates; they do not replace Apple notarization or Authenticode.
On a Mac, `pnpm desktop:dmg` builds an unsigned disk image locally. [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md) is the hand test for it.

## Local API

The window loads `ensemble://localhost` (on Windows, `http://ensemble.localhost`). The webview rewrites `/api` to the random loopback port and sends the launch token. It does not receive shell or filesystem permissions. Other origins, `mailto:`, and `tel:` open in the system browser. `javascript:` and `file:` are dropped.

**Moving between pages.** Links go through Next's router, so the sidebar, board and Files switch pages in place without repainting the app (`desktop_init_script` in `src/site.rs`). Until 13 Oct 2026 the init script turned every link click into a full page load, which flashed the whole window on each page change. A dynamic route (`/tasks/<id>`, `/pages/<id>`, `/files/<id>`, `/projects/<id>` and the rest) has one placeholder page in the export, `<route>/_/`; `src/assets.rs` serves it for any id, and its route data `<route>/_/index.txt` for `<route>/<id>/index.txt`, so these open in place too. The page reads the real id from the address on each render (`useDesktopParam` in `apps/hub-web/lib/desktop-param.ts`) and is keyed by it, so going from one task to another starts fresh as it does on the web. Checked with the Rust tests and the hub-web DOM tests; the WebKit and Chromium clicks in `src/desktop/desktop-ui.e2e.test.ts` need `pnpm desktop:e2e` and were not run on 13 Oct 2026.

**PATH.** A GUI app gets the system's bare PATH, so at start the sidecar takes the person's login-shell PATH and the usual install folders (`apps/hub-api/src/desktop/user-path.ts`, [26](26_CLI.md) §4): Claude Code, Codex, Cursor's agent, git and node are found as in their terminal.

**Downloads and version.** Every surface reads root `release.json`, checked by `scripts/release-version.mjs`. Settings → Account → About Ensemble shows the native version (from Tauri initialization metadata) and the interface version. It can check and install updates without a terminal. Local and hosted native windows share the same About component.

The download guide uses the canonical version for `Ensemble_<v>_aarch64.dmg`, `Ensemble_<v>_x64.dmg`, `Ensemble_<v>_x64-setup.exe`, `Ensemble_<v>_x64_en-US.msi`, `Ensemble_<v>_amd64.AppImage`, `Ensemble_<v>_amd64.deb` and (since 0.4.2) `Ensemble-<v>-1.x86_64.rpm` for Fedora, RHEL and openSUSE; the AppImage runs on any other distribution. Publish matching desktop and CLI tags after the merged build passes.

**Included models** (0.4.2, [33 §4](33_INCLUDED_AI.md#4-where-included-models-run)): connected to an account (Settings → Account → This computer), the app lists the account's included models and runs each call on Ensemble's server on the account's credits. Local only, it shows *Included models need your Ensemble account* with **Connect this computer**.

The updater calls `GET /api/desktop/update/:target/:arch/:current`, which resolves only the latest published **desktop** tag, independently of CLI releases. The API validates the manifest version and official asset URLs; Tauri verifies its signature. About’s only native command is `install_update`, permitted for the bundled app and official hosted origin, with no filesystem or shell permission. Active local jobs block installation until the person finishes or stops them. Successful installation restarts the app.

Desktop releases before 0.4.0 need one download/install to move to the working signed updater channel. Their old channel had no published update manifest. The Ensemble menu also exports redacted diagnostics.
Migrations run on launch. An existing database is copied into `backups/` first. A database written by a newer build is refused.

The key that encrypts saved model keys and the device token lives beside the data folder (`secret.key` next to `pglite/`), set by `src/desktop/main.ts` through `ENSEMBLE_SECRET_KEY_FILE`. A key left by an older build at `<app>/.ensemble/secret.key` is copied there once. The install folder is never written, so a read-only or replaced install keeps its saved keys. The `ensemble` CLI runs this same sidecar without the window ([26](26_CLI.md)); `scripts/assemble-desktop-sidecar.mjs --dest <dir>` packs it for the CLI.

`ENSEMBLE_SITE_URL` still opens a hosted origin instead of the local bundle. The packaged default does not.

## Logo and motion

The native shell and exported Hub use **Woven Chorus / Satin Gold**. `packages/brand` owns the approved artwork, five Expressive motions and the shared controller. `pnpm brand:build` generates `apps/desktop/ui/ensemble-morph.js`, `morph.css`, the static fallback and packaged icons. The default dark surface is Deep Petrol; the Hub also offers Smoked Aubergine and light mode.

The first connection uses Infinity after its slot's 180 ms delay. Failure stops the loop and shows the still logo with retry guidance. The OS reduced-motion preference shows the still mark. In the Hub, the separate account/browser Reduce motion setting is also honored. Native startup does not synchronize that toggle from the hosted origin; it follows the OS. Reconnecting replaces and destroys the previous controller.

Expressive is the single motion system. For compatibility, the read-only probe still reads `localStorage["ensemble.appearance"].motion` and stores a normalized `expressive` value in `motion.json`; legacy Quiet/Dot values map to Expressive. Unknown values are ignored. The official hosted page receives only the signed-update command; other shell commands remain unavailable. The desktop app has no tray; Quick capture's tray uses the generated monochrome/contrast-aware mark.

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

The mark is **Woven Chorus** on a Deep Petrol tile. `scripts/build-ensemble-brand.mjs` generates PNG (32, 128, 256, 512), multi-size ICO and ICNS assets from `packages/brand`; ICNS uses the inset macOS tile. SVG sources are `icons/source/woven-chorus.svg` and `woven-chorus-macos.svg`. `tauri.conf.json` references the generated filenames. Run `pnpm brand:build`, `pnpm brand:check` and `node scripts/check-icons.mjs` after an identity change. The OS launcher icon remains static.

## Known limits

- The default build ships the static export and the Node sidecar. `ENSEMBLE_SITE_URL` points the window at a hosted or dev site instead; the limits below about origins apply to that mode.
- Live updates inside the site still follow `NEXT_PUBLIC_HUB_API` baked into that site. Locally that is `http://127.0.0.1:4000`, which is a different origin from `http://localhost:3000` and is not rewritten. That is existing site behaviour, not a second desktop client.
- `http://localhost:3000` and `http://127.0.0.1:3000` are different origins. The session cookie belongs to the origin you configured. A link to the other one opens in the browser.
- Terminal passkeys and the code sandbox stay as they are on the server. This shell does not change them.
- macOS and Windows bundles are produced by CI and have not been launched here. Linux is the runtime that was exercised.
- The updater (`tauri-plugin-updater`) only installs signed updates, so CI builds without `TAURI_SIGNING_PRIVATE_KEY` cannot self-update. No code signing, no tray, no global shortcut. Quick capture remains `apps/quick-capture`.
- If the hosted site later sends a Content-Security-Policy that blocks the `motion` image, the shell stops receiving theme updates. The offline page still shows Woven Chorus; Expressive is the only supported motion system.

## Phase 1b and mobile

**Phase 1b** is a later change to the hub, not a flag in this crate: a static export (or other client bundle) plus a client-side auth guard and bearer tokens, so the app can ship without a Next server in front. Do not start that by stripping middleware out of `apps/hub-web` from this shell. The session cookie, startup checks, `decrypt()`, and build env on the API stay untouched here so they do not collide with that work.

The local shell page is not the hosted origin. Tauri 2 serves it from `https://tauri.localhost` on macOS and Linux, and from `http://tauri.localhost` on Windows and Android unless `useHttpsScheme` is set. `tauri://localhost` is only for deep links, not the documented webview origin. This shell treats the `tauri.localhost` host and the `tauri:` scheme as the local page, so both forms stay in the window. On the Linux WebKit build exercised here, the offline page's location was `tauri://localhost`. A client bundle in phase 1b has to treat that webview origin as the app, and it still will not share `localStorage` with the hosted site.

**Mobile** (Tauri 2 Android, iOS, iPadOS) should reuse `src/site.rs` (URL choice and in-app vs browser) and `ui/` (the offline page). Keep new windowing code out of those files. Desktop-only pieces are already behind `cfg` for Android and iOS: the single-instance plugin, the menu, and window placement (`src/desktop.rs`). A mobile shell still needs its own WebView, a place to store `site.json`, and the same rule that the hosted origin gets no IPC. Signing, store listings, and a real host URL are separate from this phase.

Desktop 0.3.8 includes the paired-run attachment handoff: original PDF/Office files and embedded diagram source are copied into the local runtime before the job starts. It shares the same 100 MB limit and lease checks as CLI 0.3.11 ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). The Hub UI uses the dedicated Pages browser, Appearance settings and default-profile quick assignment.

## Platform integration (16 Oct 2026)

Code inspection: the local web UI uses the installed Tauri dialog plugin via `core.invoke("plugin:dialog|open", { options })` for Code folders. The selected path still passes the existing API path checks. `tauri-plugin-notification` provides native reminder notifications after system permission; a running app is required. Browser sessions keep browser notifications. The shell grants only the local page the dialog and notification capabilities.

The sidecar receives `ENSEMBLE_INSTALL_PATH` pointing to the installed desktop executable. If that executable disappears while its runtime survives, the next remote heartbeat stops remote tasks/assistant turns, revokes when reachable and forgets the pairing. The hosted online indicator otherwise expires after the heartbeat window. The UI detects phones and hides shortcut settings there; desktop shortcuts keep the host platform’s modifier keys.

### Intel Mac disk-image recovery

`desktop-targets.mjs` selects the release matrix. Intel builds use Tauri’s `app` bundle (including the signed updater archive) and then `package-mac-dmg.mjs` creates a compressed APFS image with the app and an Applications link. It validates the app’s version and verifies the image, with bounded tool timeouts. No Finder automation or read-write volume resizing is needed. A workflow dispatch with `target: macos-x64` rebuilds only that artifact; branch recovery builds do not publish releases. Normal tags still build every platform. This packaging change does not alter the application version or runtime code.

Recovery publication runs on GitHub rather than downloading large installers through the operator’s connection. Supply `recovery_source_run` and `recovery_intel_run` to the desktop workflow on `main`; build jobs are skipped. The publisher rejects incomplete Intel runs, mismatched tag/source trees and invalid signatures. `scripts/verify-desktop-signatures.mjs` builds a temporary verifier from `verify-desktop-signatures.rs`, using Tauri’s signature library and the configured public key. The release stays a draft until all packages have uploaded.
