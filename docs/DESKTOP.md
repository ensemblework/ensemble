# Desktop app

`apps/desktop` is a [Tauri 2](https://v2.tauri.app/) window that runs Ensemble on this computer. It serves a static export of `apps/hub-web` and starts one Node sidecar (hub-api, the worker and the scheduler) on an embedded PGlite database. Local use needs no Docker, Postgres, Redis, Python model process or hosted account. Pairing with an account is a separate, explicit step.

Sandboxing: [24](24_DESKTOP_SANDBOXING.md). Pairing, remote tasks, Code tab and terminal: [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md). The CLI runs the same sidecar without a window: [26](26_CLI.md). Hand test: [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md).

## 1. Modes

| Mode | What runs where |
| --- | --- |
| Bundled (default) | Tauri loads the static Hub; one local Node API owns PGlite, model adapters, jobs and the scheduler |
| Hosted window | `ENSEMBLE_SITE_URL` opens a hosted or dev UI instead; backend, sign-in and data are that origin's (§9) |
| Paired to an account | Hosted assignments, AI subscriptions and included-model calls reach the computer through the device protocol ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| CLI runner | The same runtime without a window; the desktop app attaches to it (§3.3) |

Local storage does not mean offline inference: model prompts go to the provider the person chose.

## 2. Run it

Install Rust 1.87 or newer and the Tauri system libraries (WebKitGTK 4.1 on Linux, WebView2 on Windows, the system WebKit on macOS). On Linux the Edit menu (Cut, Copy, Paste, Select All) needs libxdo: build with `libxdo-dev` (`libxdo-devel` on Fedora). From the repo root:

```bash
pnpm desktop:export              # static Hub export (ENSEMBLE_DESKTOP_EXPORT=1)
pnpm --filter @ensemble/desktop dev
```

`pnpm dev` and `pnpm --filter @ensemble/hub-web build` do not set `ENSEMBLE_DESKTOP_EXPORT`, so they are unaffected by the export. A dev build runs the sidecar from the workspace with `node --import tsx`. The window opens at 1200×800; a second launch focuses the existing window.

To point the window at the dev site instead of the bundle:

```bash
ENSEMBLE_SITE_URL=http://localhost:3000 pnpm desktop:dev
```

## 3. Architecture

```text
Tauri window + static Hub
    → random loopback port, launch bearer token
    → hub-api sidecar: PGlite + model adapters + scheduler + workspace queue
    → workspace runner → detected OS sandbox → task commands

CLI → same discovery file and runtime lock → same sidecar
Paired host ← device token / claims / progress / bounded files → local remote loop
```

| Path | Owns |
| --- | --- |
| `apps/desktop/src-tauri/src/lib.rs` | Window, single-instance lock, site resolution, commands |
| `src/desktop.rs` | Menu (Export diagnostics, Check for updates, Reload, Quit; Edit), updater |
| `src/site.rs` | Navigation rules, `desktop_init_script` (API rewrite and token) |
| `src/assets.rs` | The `ensemble` protocol serving the static export |
| `src/sidecar.rs` | Starting, attaching to and stopping the sidecar |
| `src/diagnostics.rs` | Redacted diagnostics report |
| `apps/hub-api/src/desktop/main.ts` | Sidecar entry: environment, runtime lock, secret key, PATH, PGlite, `startHub` |
| `apps/hub-api/src/desktop/runtime-lock.ts`, `user-path.ts` | One runtime per data folder; the person's PATH |
| `apps/hub-api/src/lib/pglite-engine.ts` | PGlite open, backups, migrations |

Sandboxed commands start from TypeScript (`workspace/runner.ts`, `workspace/sandbox/spawn.ts`); there is no separate Rust execution broker.

### 3.1 Shell and webview

The window loads `ensemble://localhost` (`http://ensemble.localhost` on Windows). `desktop_init_script` rewrites `/api` and `/health` requests (and baked `http://127.0.0.1:4000` / `http://localhost:4000` URLs) to the sidecar's loopback port and adds the launch token. The webview has no shell or filesystem permission.

Navigation: in-app URLs stay in the window; other `http`, `https`, `mailto:` and `tel:` URLs open in the system browser; `javascript:`, `file:` and other schemes are dropped. On Linux, `target="_blank"` clicks are turned into `window.open` so the same rule applies.

Links go through Next's router, so pages switch in place. Each dynamic route (`/tasks/<id>`, `/pages/<id>`, `/files/<id>`, `/projects/<id>` and the rest) has one placeholder page in the export, `<route>/_/`; `src/assets.rs` serves it for any id, and `<route>/_/index.txt` for `<route>/<id>/index.txt`. The page reads the real id from the address (`useDesktopParam` in `apps/hub-web/lib/desktop-param.ts`) and is keyed by it.

Capabilities (`src-tauri/capabilities/`): the local page may call `shell_state`, `connect_to` and `install_update`, open the folder dialog (`dialog:allow-open`) and use notifications. The official hosted origin `https://app.ensemblework.com` may call only `install_update`.

### 3.2 Local API

The sidecar binds `127.0.0.1` on a random port with a random launch token and writes `api.json` (port, token, pid, which launcher started it, version; mode 0600) in the data folder (§4). The Context Bridge, `scripts/ensemble-hook.mjs` and the CLI read that file; without it they use `http://127.0.0.1:4000`. `ENSEMBLE_DISCOVERY_FILE` overrides the path.

The sidecar sets `ENSEMBLE_DESKTOP=1`, turns off `ENSEMBLE_DEV_AUTH_BYPASS`, uses an in-memory Redis replacement and replaces a default `ENSEMBLE_INTERNAL_TOKEN` with a random one. Local mode signs in through the desktop authorization path, not hosted signup.

### 3.3 One runtime per computer

The desktop app and the CLI runner share the data folder, so a computer has one database, one pairing, one trusted-folder list and one sandbox setup. `runtime.lock` keeps a second sidecar off the database; the second one exits with code 75. The shell attaches to a CLI runner that is already running (its `api.json` answers `/health` with its token), leaves it running on quit, and starts its own on the same port and token if that runner stops. A desktop-owned runtime stops with the app.

The packaged sidecar carries `scripts/ensemble-hook.mjs`, `scripts/ensemble-ask-mcp.mjs` and `desktop-discovery.mjs` at `app/scripts/hooks/`, and on Linux the Landlock helper at `bin/landrun` (built from pinned source with Go; release builds require it).

### 3.4 Storage, keys and migrations

The database is PGlite through the Prisma adapter, in `pglite/` under the data folder (`ENSEMBLE_DATA_DIR` overrides). Migrations run on launch. An existing database is copied into `backups/` first (`ENSEMBLE_BACKUP_DIR` overrides); these same-disk copies are not off-machine backups. A database written by a newer build is refused: *This Ensemble database was written by a newer version of the app … Install that newer Ensemble, or restore a backup from the backups folder.*

The key that encrypts saved model keys and the device token is `secret.key` next to `pglite/`, passed as `ENSEMBLE_SECRET_KEY_FILE`. A key at hub-api's default location, `<app>/.ensemble/secret.key`, is copied there once. The install folder is never written, so a read-only or replaced install keeps its saved keys. The OS keychain is not used for this key.

The default workspace is `~/ensemble-workspace` (`ENSEMBLE_WORKSPACE_ROOT` overrides), shared with the CLI.

### 3.5 Models, tools and PATH

The Python agent-runtime is not bundled. The sidecar answers model calls in-process (`apps/hub-api/src/runtime/`); `ENSEMBLE_INPROCESS_RUNTIME=0` switches to the Python HTTP runtime. Chat and agent tasks work with a key pasted in Settings → Assistant → Models. Plots export needs the computer's own `python3` with matplotlib.

A GUI app gets the system's bare PATH, so at start the sidecar takes the login shell's PATH and the usual install folders (`apps/hub-api/src/desktop/user-path.ts`, [26](26_CLI.md) §4). Claude Code, Codex, Cursor's agent, Copilot CLI, git and node are found as in the person's terminal. Their subscriptions and other tools are not bundled.

### 3.6 Pairing and included models

The remote loop uses a device token and a lease, not inbound shell access. Jobs targeted at a device wait while it is offline; they never fall back to running on the host ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

Connected to an account (Settings → Account → This computer), the app lists the account's included models and runs each call on Ensemble's server on the account's monthly credits ([33 §4](33_INCLUDED_AI.md#4-where-included-models-run)). Local only, it shows *Included models need your Ensemble account* with **Connect this computer**. Credit enforcement lives on the account server; deleting local or hosted data does not renew the allowance.

### 3.7 Dialogs, notifications, install path

Code folders use the Tauri dialog plugin (`core.invoke("plugin:dialog|open", { options })`, `apps/hub-web/lib/desktop-dialog.ts`); the chosen path still passes the API's path checks. `tauri-plugin-notification` shows reminder notifications after system permission while the app runs; browser sessions use browser notifications. Shortcuts use the host platform's modifier keys.

The sidecar receives `ENSEMBLE_INSTALL_PATH`, the installed executable. If that file disappears while the runtime survives, the next remote heartbeat stops remote tasks and assistant turns, revokes the device when reachable and forgets the pairing.

The Ensemble menu's **Export diagnostics** writes a redacted report to `diagnostics/ensemble-diagnostics-<time>.txt` in the data folder.

## 4. Folders

From the identifier `com.ensemblework.desktop`:

| OS | Data (`api.json`, `runtime.lock`, `pglite/`, `secret.key`, `backups/`, `remote.json`, `logs/sidecar.log`, `diagnostics/`; mode 0700 on Unix) | Config (`site.json`, `motion.json`) |
|---|---|---|
| macOS | `~/Library/Application Support/com.ensemblework.desktop` | same |
| Windows | `%APPDATA%\com.ensemblework.desktop` | same |
| Linux | `$XDG_DATA_HOME/com.ensemblework.desktop` or `~/.local/share/com.ensemblework.desktop` | `$XDG_CONFIG_HOME/com.ensemblework.desktop` or `~/.config/com.ensemblework.desktop` |

Webview cookies and storage are kept by the system webview, separate from `site.json`.

## 5. Platforms

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop build | Apple silicon and Intel | x64 | x64 |
| CLI package | arm64 and x64 | x64 | arm64 and x64 |
| Local database | PGlite | PGlite | PGlite |
| OS sandbox ([24](24_DESKTOP_SANDBOXING.md)) | Seatbelt | Separate sandbox account after one elevated setup; local-drive work folders | bubblewrap, else Landlock |
| Folder picker | Native dialog | Native dialog | Native dialog |
| Notifications | System permission, app running | System permission, app running | Desktop notification service and permission, app running |

A missing sandbox backend is reported explicitly. On Linux the capability depends on kernel and namespaces; Landlock does not hide Unix sockets and needs TCP rule support to turn the network off. Path and argument checks do not replace OS confinement. The terminal's passkey unlock depends on the browser and the configured origin; IP-address aliases are not interchangeable ([16](16_CODE_TAB.md)).

Mobile native apps, the Mac App Store and Flatpak are not targets.

## 6. Build and package

```bash
pnpm desktop:export     # static Hub → apps/hub-web/out (bundled as web/)
pnpm desktop:sidecar    # Node + deployed hub-api → apps/desktop/src-tauri/resources/sidecar/
pnpm desktop:build      # tauri build
```

`pnpm desktop:sidecar` runs `scripts/assemble-desktop-sidecar.mjs`; `--dest <dir>` packs the same sidecar for the CLI. Bundles land in `apps/desktop/src-tauri/target/<target>/release/bundle/`.

`.github/workflows/desktop.yml` builds on pull requests, the `desktop` branch, `desktop-v*` tags and manual dispatch (`target`: all, `macos-arm64`, `macos-x64`, `windows`, `linux`). `scripts/desktop-targets.mjs` defines the matrix:

| Target | Runner | Bundles | Artifact |
| --- | --- | --- | --- |
| `macos-arm64` | `macos-14` | app, dmg | `ensemble-desktop-macos-arm64` |
| `macos-x64` | `macos-15-intel` | app, then `scripts/package-mac-dmg.mjs` | `ensemble-desktop-macos-x64` |
| `windows` | `windows-latest` | msi, nsis | `ensemble-desktop-windows` |
| `linux` | `ubuntu-22.04` | deb, rpm, AppImage | `ensemble-desktop-linux` |

The Node and Prisma sidecar matches each app's architecture. On Linux it carries Prisma's query engines for OpenSSL 3 and 1.1 (x64: Debian/Ubuntu and RHEL/Fedora builds; arm64: one of each OpenSSL), since a build machine's own pick can be the wrong one (`LINUX_ENGINES` in `scripts/assemble-desktop-sidecar.mjs`, which also loads the OpenSSL 3 engine before it finishes). On Linux the `.deb` depends on `libxdo3` and the `.rpm` on `libxdo` (Fedora, or EPEL on RHEL); the AppImage carries its own copy.

The Intel disk image: `package-mac-dmg.mjs` creates a compressed APFS image with the app and an Applications link, checks the app's version and verifies the image, with bounded tool timeouts and no Finder automation.

On a Mac, `pnpm desktop:dmg` (`scripts/build-mac-dmg.sh`) builds an unsigned disk image for that Mac's chip.

Download names (`apps/landing/lib/download.ts`): `Ensemble_<v>_aarch64.dmg`, `Ensemble_<v>_x64.dmg`, `Ensemble_<v>_x64-setup.exe`, `Ensemble_<v>_x64_en-US.msi`, `Ensemble_<v>_amd64.AppImage`, `Ensemble_<v>_amd64.deb` and `Ensemble-<v>-1.x86_64.rpm` (Fedora, RHEL, openSUSE). The AppImage runs on other distributions.

## 7. Releases and updates

Root `release.json` is the version for the native app, the interface, the API and the CLI; `scripts/release-version.mjs` checks every manifest against it.

A `desktop-v<version>` tag matching `tauri.conf.json` publishes after every platform builds. `scripts/desktop-release.mjs` checks the four updater packages and signatures, gives the two Mac archives distinct names (`Ensemble_<v>_darwin-aarch64.app.tar.gz`, `…_darwin-x86_64.app.tar.gz`) and writes `latest.json`. Everything uploads to a draft release, which is then published. Updater signing uses `TAURI_SIGNING_PRIVATE_KEY` (applied with `src-tauri/tauri.signing.json`); publishing fails without signed packages, and PR builds may omit them.

Recovery: a dispatch with `target: macos-x64` rebuilds only the Intel artifact and does not publish. On `main`, `recovery_source_run` and `recovery_intel_run` skip the builds and run `scripts/publish-desktop-recovery.mjs`, which rejects incomplete Intel runs, mismatched tag and source trees and invalid signatures. `scripts/verify-desktop-signatures.mjs` builds a verifier from `verify-desktop-signatures.rs` with Tauri's signature library and the configured public key.

OS code signing is not configured: Gatekeeper and SmartScreen may warn on first install. Updater signatures authenticate in-app updates only; they do not replace Apple notarization or Authenticode.

The updater calls `GET https://api.ensemblework.com/api/desktop/update/:target/:arch/:current` (`apps/hub-api/src/routes/misc.ts`), which resolves only the latest published desktop tag, independent of CLI releases. The API validates the manifest version and official asset URLs; Tauri verifies the signature.

Settings → Account → About Ensemble shows the native and interface versions and can check for and install updates (the hosted window shares the same About). `install_update` takes no URL or path. Active local jobs block installation (*Finish or stop your active tasks, then update again*); a successful install restarts the app. Installs older than 0.4.0 cannot update in-app; install the current version once.

## 8. Logo, icon and motion

The shell and the exported Hub use **Woven Chorus** in Satin Gold ([BRAND](BRAND.md)). `pnpm brand:build` generates `apps/desktop/ui/ensemble-morph.js`, `morph.css`, the static fallback and the packaged icons (PNG, multi-size ICO, and ICNS with the inset macOS tile) from `packages/brand`. SVG sources: `src-tauri/icons/source/woven-chorus.svg` and `woven-chorus-macos.svg`. After an identity change run `pnpm brand:build`, `pnpm brand:check` and `node scripts/check-icons.mjs`. The launcher icon is static.

The first connection plays Infinity after a 180 ms delay. Failure stops the loop and shows the still mark with retry guidance. The OS reduced-motion preference shows the still mark; the Hub's own Reduce motion setting is not copied into the native startup screen. The shell keeps a copy of the Hub's motion style in `motion.json` (`expressive`; `minimal-quiet` and `minimal-dot` map to it, other values are ignored).

The desktop app has no tray or global shortcut; Quick capture is a separate app ([20](20_QUICK_CAPTURE.md)).

## 9. Hosted origin override

The window URL is resolved in order: runtime `ENSEMBLE_SITE_URL`, the saved value in `site.json`, then a value baked in at build time. The packaged default is the local bundle.

```bash
ENSEMBLE_SITE_URL=https://your-host.example pnpm desktop:build   # bake a hosted origin
```

The official hosted UI is `https://app.ensemblework.com`. An override uses that origin's backend and sign-in; local data is not migrated, and the hosted origin's cookies and storage are not the local app's.

`ENSEMBLE_DESKTOP_EXTERNAL_LOG=/path/to/log` appends each URL handed to the system browser, one per line, for testing the navigation rule.

## 10. Tests

| Check | Command |
| --- | --- |
| Shell unit tests (navigation, assets, sidecar, diagnostics) | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| Sidecar, runtime lock, user PATH | `pnpm --filter @ensemble/hub-api test` |
| WebKit and Chromium clicks against the export | `pnpm desktop:e2e` |
| Release scripts | `node --test scripts/desktop-release.test.mjs scripts/desktop-targets.test.mjs scripts/package-mac-dmg.test.mjs` |
| Installed app on a Mac | [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md) |

CI (`ci.yml`) runs sandbox escape tests on macOS Seatbelt, Linux Landlock, Linux bubblewrap and the Windows sandbox account; `desktop.yml` also runs the macOS escape, trust and git-gate tests and verifies the Mac image packager.

## 11. Limits

- Local and hosted data are separate; pairing is not full synchronization.
- Included models need a paired account; other model calls go to the chosen provider.
- The Python model runtime is not bundled; plot export needs local Python with matplotlib.
- No OS code signing or notarization.
- No tray or global capture shortcut in the main app.
- OS sandbox capability varies by OS and setup and is reported explicitly ([24](24_DESKTOP_SANDBOXING.md)).
- No mobile native app.
