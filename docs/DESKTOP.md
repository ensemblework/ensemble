# Desktop app

Use Ensemble in a native window on macOS, Windows or Linux. Choose **With your Ensemble account** to work with the same data as the web app, or **Only on this computer** to keep Ensemble locally. No Docker, Postgres, Redis or separate Python model process is required.

Sandboxing: [24](24_DESKTOP_SANDBOXING.md). Pairing, remote tasks, Code tab and terminal: [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md). The CLI runs the same sidecar without a window: [26](26_CLI.md). Hand test: [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md).

## 1. How a computer uses Ensemble

Choose the mode on first launch. **With your account** opens your account’s web app and pairs this computer for tasks. **Only on this computer** opens the bundled Hub with local data. The choice is saved in `mode.json` in the data folder (§4).

| Mode | Window | Data | Ensemble's servers |
| --- | --- | --- | --- |
| With your account (`account`) | The account's web app (`https://app.ensemblework.com`), the same pages as a browser | The account: the web app and every device see the same pages, tasks and settings | Used. This computer is paired for tasks and AI subscriptions ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| Only on this computer (`local`) | The bundled Hub, served by the app | PGlite on this computer | Never |
| Developer site | `ENSEMBLE_SITE_URL` or a build-time URL (§9) | That origin's | That origin's |

Both modes run the same local runtime (hub-api, worker and scheduler on PGlite, §3). With an account it is this computer's runner; local only, it is the whole of Ensemble. The CLI runner ([26](26_CLI.md)) is the same runtime without a window (§3.3).

Local storage does not mean offline inference: model prompts go to the provider the person chose.

### 1.1 First run

1. Open the app and choose **With your Ensemble account** or **Only on this computer**. This choice appears when there is no saved `mode.json`.
2. Review whether the computer is already paired and how much local data it holds.
3. If you choose local only on a paired computer, confirm that it should unpair.

The start page is `apps/desktop/ui/`; `GET /api/desktop/account` supplies the pairing and data details, and `POST /api/desktop/mode` saves the choice.

### 1.2 Local only

- The runtime answers `localOnly: true` on `GET /api/auth/me` and `/api/shell`. The Hub then offers no included models (own API keys and AI subscriptions only), no pairing (Settings → Account → This computer), and **Move to your Ensemble account** in Settings → Account and the account menu.
- Nothing reaches Ensemble's servers: pairing (`POST /api/remote/pair`, the remote-task switch) is refused, the remote loop never connects, and `ensemble login` refuses to pair (`--mcp-only` still links editors to an account). Model calls go to the chosen provider; connected apps talk to their own services.
- Updates come from the newest desktop release on GitHub (`releases/latest/download/latest.json`), not the Ensemble API.
- Editors use MCP without the CLI. Connect your apps shows a stdio command (`GET /api/desktop/mcp`) for Claude Code, Cursor and other `mcpServers` apps, VS Code with Copilot, and Codex: this app's Node runs the Context Bridge, which finds the runtime through `api.json` and reads it again after the app restarts. The app has to be open.
- Connected apps: API-key and token apps and remote MCP servers work as on the web; their secrets are encrypted with this computer's `secret.key`. An OAuth app (Google, Microsoft, GitHub…) needs an OAuth app of your own (Settings → Connections), because Ensemble's shared OAuth apps live on its servers. Its redirect URI is `http://127.0.0.1:<port>/api/connectors/<provider>/callback`; register it as a desktop or native client, which accepts any loopback port. The browser then lands on `GET /api/desktop/connected`, a short page served by the runtime.
- Not available: included models, Ensemble Node, sharing with other people and public links, the web app and other devices.

### 1.3 Moving to an account

Local only becomes an account once; an account never goes back to local only. Start it from Settings → Account (or the account menu), or choose **With your Ensemble account** on first run of a computer that has local data.

1. Choose **Move to your Ensemble account** in Settings → Account or the account menu. On first run with existing local data, choose **With your Ensemble account**.
2. Choose **Continue in your browser** and sign in by any offered method. Keep **Move this computer’s data** selected to transfer the local work, or untick it in the start page or browser approval page.
3. Approve the matching code on `/link`. Verify your email before moving data or running tasks. Without verification, **Sign in without running tasks** signs in only; a requested move stops with “Verify your email in Ensemble first” and leaves the data unchanged.
4. After approval, the app transfers the selected data, pairs the computer, turns on remote tasks and opens Today in your account.

#### What moves to the account

The transfer includes (`TRANSFER_TABLES`, `apps/hub-api/src/transfer/schema.ts`): pages, tasks, boards, projects, people, repos, deliverables, meetings and notes, files (with their bytes), datasets, plots, diagrams, skills, chats, routines, reminders, layouts and settings.

What stays on the computer: sign-ins, saved model keys, connected apps and calendar feeds (encrypted with this computer's key), agent runs and their logs, undo history and the activity ledger. Re-add keys and reconnect apps in the account.

#### Existing account data and transfer limits

The account receives rows with `POST /api/transfer/rows` and finishes with `POST /api/transfer/finish` (`transfer/import.ts`, `transfer/routes.ts`):

- Rows keep their ids. Every column naming an account becomes the receiving account, a reference to another row stays only when that row is the account's, and an id another account already uses, or that is not a plain id, gets a new id (the computer rewrites its later rows). Each row is its own savepoint: a row that fails is skipped and counted, and the batch goes on.
- Files and datasets are measured on the account: size and hash come from the bytes received, a storage key from the computer is never kept, and the bytes go where the account keeps files. The computer asks `GET /api/transfer` for the largest file the account takes and leaves bigger files (and any row over 60 MB) in its local data, saying so.
- Where the account already has the same thing, its row wins and the computer's values only fill what it left empty: a project with the same name, a person with the same email (or name), a repo, an item from the same connected app, a setting. A skill with the same slug but different text, and a board with the same title, are added beside it, marked *(from this computer)*. Today's tiles the account lacks are added to its layout. Appearance stays the account's.
- Hosted file and dataset limits apply; what does not fit stays in the local data and the app says so. Scheduled routines arrive paused.
- A transfer key (`scope: "transfer"`) reaches only `/api/transfer*`, works for 24 hours and is revoked by `/finish`. Retrying is safe: rows already moved are counted, not copied again.

The local database stays on the computer as the runner's.

### 1.4 With an account

- The window opens `appUrl` from `mode.json` (`/today`) after the start page checks it can be reached; otherwise it shows the offline page.
- On the account's pages `window.__ENSEMBLE_DESKTOP__` carries the version, platform and mode, without `apiBase`. Those pages may call `show_account`, `open_in_browser` and `install_update` (`capabilities/updates.json`), nothing else. The launch token stays on the bundled Hub's own origin (§3.1).
- Signing in: the login page shows **Continue in your browser**, which opens the start page's sign-in (scope `web` alone once paired). Google, GitHub and Microsoft sign-in do not complete inside an embedded window.
- Connecting an app (OAuth, or an MCP server's sign-in) opens the same Ensemble page in the system browser, where the connection finishes; the window shows it on return.
- Pairing follows `ensemble login`: a computer already paired with that server for the same account (by the CLI or an earlier sign-in) keeps its device; another account signing in unpairs it and pairs it for that account. The runtime asks the server whose device it is (`GET /api/devices/self`) and compares it with the `accountId` of the sign-in.

The paired sidecar reports `sessionDelete: 1`: Node's confirmed session deletion stops active jobs and removes the underlying coding agent's saved history, not project files or sign-ins. Its computer-side receipts make retries safe; native errors remain visible. Update and restart the desktop runtime before deleting sessions from the web.

Native methods: [35 §8.9](35_ENSEMBLE_NODE.md#89-session-control-from-the-card).

When paired, the bundled runtime serves Node's original-file workspace (Code API 3, desktop 0.6.4+): version-checked text saves reach the original here, and file tools and commands report owner-only file references. Browsing and web-edit switches still apply.

The Node website owns the split editor and selected-line quotes; see [35 §8.18](35_ENSEMBLE_NODE.md#818-original-files-in-the-node-workspace).

Desktop 0.6.5 reports canonical file identities and individual edit times for last-editor/session quote routing, and modification times for refreshed binary previews. These are metadata, not copies of source files.

Desktop 0.6.6 uses file-scoped protection for Node's original viewer: a safe generated file is not blocked because its parent folder also holds protected files. This does not relax the node's execution grants or access to actual secrets and runtime data.

## 5. Platforms

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop build | Apple silicon and Intel | arm64 and x64 | arm64 and x64 |
| CLI package | arm64 and x64 | arm64 and x64 | arm64 and x64 |
| Local database | PGlite | PGlite | PGlite |
| OS sandbox ([24](24_DESKTOP_SANDBOXING.md)) | Seatbelt | Separate sandbox account after one elevated setup; local-drive work folders | bubblewrap, else Landlock |
| Folder picker | Native dialog | Native dialog | Native dialog |
| Notifications | System permission, app running | System permission, app running | Desktop notification service and permission, app running |

A missing sandbox backend is reported explicitly. On Linux the capability depends on kernel and namespaces; Landlock does not hide Unix sockets and needs TCP rule support to turn the network off. Path and argument checks do not replace OS confinement. The terminal's passkey unlock depends on the browser and the configured origin; IP-address aliases are not interchangeable ([16](16_CODE_TAB.md)).

Mobile native apps, the Mac App Store and Flatpak are not targets.

## 7. Releases and updates

Root `release.json` is the version for the native app, the interface, the API and the CLI; `scripts/release-version.mjs` checks every manifest against it.

A `desktop-v<version>` tag matching `tauri.conf.json` publishes after every platform builds. `scripts/desktop-release.mjs` checks the six updater packages and their signatures, gives the two Mac archives distinct names (`Ensemble_<v>_darwin-aarch64.app.tar.gz`, `…_darwin-x86_64.app.tar.gz`) and writes `latest.json` with `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` (the x64 NSIS installer), `windows-aarch64` (the arm64 NSIS installer), `linux-x86_64` (the amd64 AppImage) and `linux-aarch64` (the aarch64 AppImage). Everything uploads to a draft release, which is then published.

Updater signing uses `TAURI_SIGNING_PRIVATE_KEY` (applied with `src-tauri/tauri.signing.json`); publishing fails without signed packages, and PR builds may omit them.

Recovery: a dispatch with `target: macos-x64` rebuilds only the Intel artifact and does not publish. On `main`, `recovery_source_run` and `recovery_intel_run` skip the builds and run `scripts/publish-desktop-recovery.mjs`, which rejects incomplete Intel runs, mismatched tag and source trees and invalid signatures.

`scripts/verify-desktop-signatures.mjs` builds a verifier from `verify-desktop-signatures.rs` with Tauri's signature library and the configured public key.

OS code signing is not configured: Gatekeeper and SmartScreen may warn on first install. Updater signatures authenticate in-app updates only; they do not replace Apple notarization or Authenticode.

With an account (and on first run) the updater calls `GET https://api.ensemblework.com/api/desktop/update/:target/:arch/:current` (`apps/hub-api/src/routes/misc.ts`), which resolves only the latest published desktop tag, independent of CLI releases. The API validates the manifest version and official asset URLs.

Local only, it reads `https://github.com/ensemblework/ensemble/releases/latest/download/latest.json` (`mode::LOCAL_UPDATES_URL`), which works because `desktop.yml` publishes each desktop release as GitHub's latest and CLI releases never take that mark (`--latest=false`). Tauri verifies the signature either way.

### Check for and install an update

Open **Settings → Account → About Ensemble** to see the native and interface versions, check for an update and install it. The account window uses the same About page. `install_update` takes no URL or path. Active local jobs block installation (*Finish or stop your active tasks, then update again*); a successful install restarts the app.

Installs older than 0.4.0 cannot update in-app; install the current version once.

## 4. Folders

Find your local data and configuration in the operating-system folder below. These paths use the app identifier `com.ensemblework.desktop`.

| OS | Data (`api.json`, `runtime.lock`, `mode.json`, `pglite/`, `secret.key`, `backups/`, `remote.json`, `logs/sidecar.log`, `diagnostics/`; mode 0700 on Unix) | Config (`site.json`, `motion.json`) |
|---|---|---|
| macOS | `~/Library/Application Support/com.ensemblework.desktop` | same |
| Windows | `%APPDATA%\com.ensemblework.desktop` | same |
| Linux | `$XDG_DATA_HOME/com.ensemblework.desktop` or `~/.local/share/com.ensemblework.desktop` | `$XDG_CONFIG_HOME/com.ensemblework.desktop` or `~/.config/com.ensemblework.desktop` |

Webview cookies and storage are kept by the system webview, separate from `site.json`.

## 11. Limits

- With an account the window needs the network: there is no offline copy of the account. The local runtime keeps running agent tasks already on this computer.
- Local only: no sync, no other devices, no included models, no Ensemble Node, no sharing. OAuth connected apps need an OAuth app of your own.
- Local only becomes an account once, and an account does not go back. Sign-ins, model keys, connected apps and agent run history stay behind (§1.3).
- Google, GitHub and Microsoft sign-in, and connected apps' sign-ins, finish in the system browser, not inside the window.
- The Python model runtime is not bundled; plot export needs local Python with matplotlib.
- No OS code signing or notarization.
- No tray or global capture shortcut in the main app.
- OS sandbox capability varies by OS and setup and is reported explicitly ([24](24_DESKTOP_SANDBOXING.md)).
- No mobile native app.

## In the code

`apps/desktop` is a [Tauri 2](https://v2.tauri.app/) app for macOS, Windows and Linux. It opens the person's Ensemble account in its window, or keeps Ensemble entirely on the computer (§1). Either way it starts one Node sidecar (hub-api, the worker and the scheduler) on an embedded PGlite database; local only, it also serves a static export of `apps/hub-web`.

It needs no Docker, Postgres, Redis or Python model process.

The mode is written by `apps/hub-api/src/desktop/mode.ts` and read by `src-tauri/src/mode.rs`.

### Account transfer handoff

1. The start page (`#account`) asks the runtime to sign in: `POST /api/desktop/account/sign-in` starts the browser approval (`/api/cli/auth/start`) with the scopes `web` (sign the window in), `runner` (pair this computer) and `transfer` (when there is local data and **Move this computer's data** stays ticked). It signs in to the server this computer is already paired with, else `https://api.ensemblework.com`. The browser opens `/link`, where any sign-in method works; the person can untick the move there too. Without a verified email, `/link` offers **Sign in without running tasks** (`web` only); a move then stops with *Verify your email in Ensemble first* and nothing changes.
2. After approval the runtime sends the local data with a one-purpose transfer key, writes `mode.json` (`account`, `switchedAt`), pairs, turns remote tasks on, and leaves the window a one-time link.
3. The window opens `<app>/api/auth/handoff?code=…` (single use, 30 minutes), which starts a normal session and lands on Today.

### 3. Architecture

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
| `apps/desktop/src-tauri/src/lib.rs` | Window, single-instance lock, site resolution, the first screen by mode, commands |
| `src/mode.rs` | Reads `mode.json`; the local-only update address |
| `apps/desktop/ui/` | Start page: first-run choice, browser sign-in, the move to an account, offline |
| `src/desktop.rs` | Menu (Export diagnostics, Check for updates, Reload, Quit; Edit), updater |
| `src/site.rs` | Navigation rules, `desktop_init_script` (API rewrite and token) |
| `src/assets.rs` | The `ensemble` protocol serving the static export |
| `src/sidecar.rs` | Starting, attaching to and stopping the sidecar |
| `src/diagnostics.rs` | Redacted diagnostics report |
| `apps/hub-api/src/desktop/main.ts` | Sidecar entry: environment, runtime lock, secret key, PATH, PGlite, `startHub` |
| `apps/hub-api/src/desktop/runtime-lock.ts`, `user-path.ts` | One runtime per data folder; the person's PATH |
| `apps/hub-api/src/desktop/mode.ts`, `account.ts` | `mode.json`; `/api/desktop/account*`, `/api/desktop/mode`, `/api/desktop/mcp`, `/api/desktop/connected` |
| `apps/hub-api/src/desktop/control/` | Desktop control for Ensemble Node and coding runs: on Linux a private agent screen (a headless GNOME Shell) and the owner's real screen, keyboard and pointer, through `apps/hub-api/desktop-helper/linux/`; on macOS the owner's screen through cua-driver (`drivers/macos-cua.ts`), only in this app's own runtime ([25 §11](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#11-desktop-control-on-the-computer)) |
| `apps/hub-api/src/transfer/` | Moving local data into an account: export (computer) and import (account) |
| `apps/hub-api/src/lib/pglite-engine.ts` | PGlite open, backups, migrations |

Sandboxed commands start from TypeScript (`workspace/runner.ts`, `workspace/sandbox/spawn.ts`); there is no separate Rust execution broker.

#### 3.1 Shell and webview

Local only, the window loads the bundled Hub at `ensemble://localhost` (`http://ensemble.localhost` on Windows); with an account, the start page (`tauri://localhost`, `http://tauri.localhost` on Windows) and then the account's site; on first run, the start page.

`desktop_init_script` runs on every page but acts only on the bundled Hub's origin: there it rewrites `/api` and `/health` requests (and baked `http://127.0.0.1:4000` / `http://localhost:4000` URLs) to the sidecar's loopback port and adds the launch token. No other page sees the token. The webview has no shell or filesystem permission.

Navigation: in-app URLs stay in the window; other `http`, `https`, `mailto:` and `tel:` URLs open in the system browser; `javascript:`, `file:` and other schemes are dropped. On Linux, `target="_blank"` clicks are turned into `window.open` so the same rule applies.

Links go through Next's router, so pages switch in place. Each dynamic route (`/tasks/<id>`, `/pages/<id>`, `/files/<id>`, `/projects/<id>` and the rest) has one placeholder page in the export, `<route>/_/`; `src/assets.rs` serves it for any id, and `<route>/_/index.txt` for `<route>/<id>/index.txt`.

The page reads the real id from the address (`useDesktopParam` in `apps/hub-web/lib/desktop-param.ts`) and is keyed by it.

Capabilities (`src-tauri/capabilities/`): the app's own pages (start page and bundled Hub) may call `shell_state` (which gives the start page the local API's port and token), `connect_to`, `install_update`, `open_sign_in` (an Ensemble `/link` page in the system browser), `open_app` (the signed-in account's site), `open_local` and `show_account`, open the folder dialog (`dialog:allow-open`) and use notifications.

The official site `https://app.ensemblework.com` may call only `install_update`, `show_account` and `open_in_browser` (its own pages).

#### 3.2 Local API

The sidecar binds `127.0.0.1` on a random port with a random launch token and writes `api.json` (port, token, pid, which launcher started it, version; mode 0600) in the data folder (§4). The Context Bridge, `scripts/ensemble-hook.mjs` and the CLI read that file; without it they use `http://127.0.0.1:4000`. `ENSEMBLE_DISCOVERY_FILE` overrides the path.

The sidecar sets `ENSEMBLE_DESKTOP=1`, turns off `ENSEMBLE_DEV_AUTH_BYPASS`, uses an in-memory Redis replacement and replaces a default `ENSEMBLE_INTERNAL_TOKEN` with a random one. Local mode signs in through the desktop authorization path, not hosted signup.

#### 3.3 One runtime per computer

The desktop app and the CLI runner share the data folder, so a computer has one database, one pairing, one trusted-folder list and one sandbox setup. `runtime.lock` keeps a second sidecar off the database; the second one exits with code 75. A running sidecar checks every 30 seconds that the lock still names it, and one that finds another process named there stops its remote work, closes the database and exits 75 as well ([26 §4](26_CLI.md#use-the-cli-alongside-the-desktop-app)).

The shell attaches to a CLI runner that is already running (its `api.json` answers `/health` with its token), leaves it running on quit, and starts its own on the same port and token if that runner stops. A desktop-owned runtime stops with the app.

The packaged sidecar carries `scripts/ensemble-hook.mjs`, `scripts/ensemble-ask-mcp.mjs` and `desktop-discovery.mjs` at `app/scripts/hooks/`, on Linux the Landlock helper at `bin/landrun` (built from pinned source with Go; release builds require it), and on macOS the desktop control driver at `bin/cua-driver` with `bin/cua-driver.LICENSE` (`scripts/fetch-cua-driver.mjs`: cua-driver's universal release archive at the version and SHA-256 pinned in `apps/hub-api/desktop-helper/macos/cua-driver.json`, signed by its publisher; the build stops when the checksum differs). The CLI's sidecar leaves it out (`--no-cua-driver`): desktop control on a Mac runs only in this app's runtime, so macOS asks about its permissions for Ensemble ([25 §11.9](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#119-macos)).

#### 3.4 Storage, keys and migrations

The database is PGlite through the Prisma adapter, in `pglite/` under the data folder (`ENSEMBLE_DATA_DIR` overrides). Migrations run on launch.

Its sessions run in UTC whatever the computer's zone, as hosted Postgres does: `openPglite` (`apps/hub-api/src/lib/pglite-engine.ts`) starts PGlite with `TimeZone=UTC`, which overrides the zone `postgresql.conf` took from the computer when the database was created. Prisma stores UTC in the `timestamp(3)` columns, so `NOW()` and `CURRENT_TIMESTAMP` in raw SQL have to be UTC too.

An existing database is copied into `backups/` first (`ENSEMBLE_BACKUP_DIR` overrides); these same-disk copies are not off-machine backups. A database written by a newer build is refused: *This Ensemble database was written by a newer version of the app … Install that newer Ensemble, or restore a backup from the backups folder.*

The key that encrypts saved model keys and the device token is `secret.key` next to `pglite/`, passed as `ENSEMBLE_SECRET_KEY_FILE`. A key at hub-api's default location, `<app>/.ensemble/secret.key`, is copied there once. The install folder is never written, so a read-only or replaced install keeps its saved keys. The OS keychain is not used for this key.

The default workspace is `~/ensemble-workspace` (`ENSEMBLE_WORKSPACE_ROOT` overrides), shared with the CLI.

#### 3.5 Models, tools and PATH

The Python agent-runtime is not bundled. The sidecar answers model calls in-process (`apps/hub-api/src/runtime/`); `ENSEMBLE_INPROCESS_RUNTIME=0` switches to the Python HTTP runtime. Chat and agent tasks work with a key pasted in Settings → Assistant → Models. Plots export needs the computer's own `python3` with matplotlib.

A GUI app gets the system's bare PATH, so at start the sidecar takes the login shell's PATH and the usual install folders (`apps/hub-api/src/desktop/user-path.ts`, [26](26_CLI.md) §4). Claude Code, Codex, Cursor's agent, Copilot CLI, git and node are found as in the person's terminal, and a Codex set up with its own model provider gets the key its `config.toml` names from the login shell too.

Their subscriptions and other tools are not bundled.

Everything the CLI runner does (pairing, tasks and AI subscriptions, sessions, Ask Ensemble and chat turns, deleting sessions) runs in this same sidecar, so the app needs no CLI; only the `ensemble` terminal commands and `ensemble mcp` are the CLI's (in local only, Connect your apps gives editors this app's own MCP command, §1.2; with an account, editors use the hosted MCP or the CLI).

#### 3.6 Pairing and included models

The remote loop uses a device token and a lease, not inbound shell access. Jobs targeted at a device wait while it is offline; they never fall back to running on the host ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

With an account, included models run on Ensemble's server on the account's monthly credits ([33 §4](33_INCLUDED_AI.md#4-where-included-models-run)). Local only, the Hub offers none and says why, with **Move to your Ensemble account**. Credit enforcement lives on the account server; deleting local or hosted data does not renew the allowance.

#### 3.7 Dialogs, notifications, install path

Code folders use the Tauri dialog plugin (`core.invoke("plugin:dialog|open", { options })`, `apps/hub-web/lib/desktop-dialog.ts`); the chosen path still passes the API's path checks. `tauri-plugin-notification` shows reminder notifications after system permission while the app runs; browser sessions use browser notifications. Shortcuts use the host platform's modifier keys.

The sidecar receives `ENSEMBLE_INSTALL_PATH`, the installed executable. If that file stays missing for 10 minutes while the runtime survives, the next remote heartbeat stops remote tasks and assistant turns, revokes the device when reachable and forgets the pairing. An update that replaces the file within that time keeps the pairing.

The Ensemble menu's **Export diagnostics** writes a redacted report to `diagnostics/ensemble-diagnostics-<time>.txt` in the data folder.

### 2. Run it

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

### 6. Build and package

```bash
pnpm desktop:export     # static Hub → apps/hub-web/out (bundled as web/)
pnpm desktop:sidecar    # Node + deployed hub-api → apps/desktop/src-tauri/resources/sidecar/
pnpm desktop:build      # tauri build
```

`pnpm desktop:sidecar` runs `scripts/assemble-desktop-sidecar.mjs`; `--dest <dir>` packs the same sidecar for the CLI. Bundles land in `apps/desktop/src-tauri/target/<target>/release/bundle/`.

`.github/workflows/desktop.yml` builds on the `desktop` branch, `desktop-v*` tags and manual dispatch (not on pull requests, [37](37_PAUSED_CHECKS.md)) (`target`: all, `macos-arm64`, `macos-x64`, `windows`, `linux`, `linux-arm64`, `windows-arm64`). `scripts/desktop-targets.mjs` defines the matrix:

| Target | Runner | Bundles | Artifact |
| --- | --- | --- | --- |
| `macos-arm64` | `macos-15` | app, dmg | `ensemble-desktop-macos-arm64` |
| `macos-x64` | `macos-15-intel` | app, then `scripts/package-mac-dmg.mjs` | `ensemble-desktop-macos-x64` |
| `windows` | `windows-latest` | msi, nsis | `ensemble-desktop-windows` |
| `linux` | `ubuntu-22.04` | deb, rpm, AppImage | `ensemble-desktop-linux` |
| `linux-arm64` | `ubuntu-22.04-arm` | deb, rpm, AppImage | `ensemble-desktop-linux-arm64` |
| `windows-arm64` | `windows-11-arm` | nsis | `ensemble-desktop-windows-arm64` |

Each target builds on a runner of its own architecture, never a cross build: the sidecar packs the runner's Node, Prisma engines and landrun, so it matches the app's architecture. Both macOS targets carry the same universal cua-driver. Both Linux runners are Ubuntu 22.04, so both builds need glibc 2.35 or newer. Tauri cannot build an MSI for arm64, so Windows on Arm gets the NSIS installer only.

Prisma 6 builds its query engine for Windows on x64 only, so the Windows arm64 sidecar (the app's, and the `windows-arm64` CLI package's, [26 §1](26_CLI.md#1-install)) carries Prisma's Rust-free client instead: `assemble-desktop-sidecar.mjs` generates it from a copy of the schema with `engineType = "client"`, and a WASM module compiles each query that the PGlite adapter runs. `apps/hub-api/src/lib/pglite-adapter.ts` wraps the adapter for that client (it finds `engineType = "client"` in the generated client's schema): bytes go to PGlite as binary, timestamps get their UTC offset, and constraint errors get the kinds that make them P2002, P2003 and the rest, as the Rust engine does. Before it finishes, the script runs the migrations on an in-memory database with that client and checks that a duplicate comes back as P2002. The hosted API and every other target keep the Rust engine.

On Linux the sidecar carries Prisma's query engines for OpenSSL 3 and 1.1 (x64: Debian/Ubuntu and RHEL/Fedora builds; arm64: one of each OpenSSL), since a build machine's own pick can be the wrong one (`LINUX_ENGINES` in `scripts/assemble-desktop-sidecar.mjs`, which also loads the OpenSSL 3 engine before it finishes).

On Linux the `.deb` depends on `libxdo3` and the `.rpm` on `libxdo` (Fedora, or EPEL on RHEL); the AppImage carries its own copy.

The Intel disk image: `package-mac-dmg.mjs` creates a compressed APFS image with the app and an Applications link, checks the app's version and verifies the image, with bounded tool timeouts and no Finder automation.

On a Mac, `pnpm desktop:dmg` (`scripts/build-mac-dmg.sh`) builds an unsigned disk image for that Mac's chip.

Download names (`apps/landing/lib/download.ts`): `Ensemble_<v>_aarch64.dmg`, `Ensemble_<v>_x64.dmg`, `Ensemble_<v>_x64-setup.exe`, `Ensemble_<v>_x64_en-US.msi`, `Ensemble_<v>_amd64.AppImage`, `Ensemble_<v>_amd64.deb` and `Ensemble-<v>-1.x86_64.rpm` (Fedora, RHEL, openSUSE); on arm64, `Ensemble_<v>_arm64-setup.exe`, `Ensemble_<v>_aarch64.AppImage`, `Ensemble_<v>_arm64.deb` and `Ensemble-<v>-1.aarch64.rpm`. The AppImages run on other distributions.

### 8. Logo, icon and motion

The shell and the exported Hub use **Woven Chorus** in Satin Gold ([BRAND](BRAND.md)). `pnpm brand:build` generates `apps/desktop/ui/ensemble-morph.js`, `morph.css`, the static fallback and the packaged icons (PNG, multi-size ICO, and ICNS with the inset macOS tile) from `packages/brand`. SVG sources: `src-tauri/icons/source/woven-chorus.svg` and `woven-chorus-macos.svg`.

After an identity change run `pnpm brand:build`, `pnpm brand:check` and `node scripts/check-icons.mjs`. The launcher icon is static.

The first connection plays Infinity after a 180 ms delay. Failure stops the loop and shows the still mark with retry guidance. The OS reduced-motion preference shows the still mark; the Hub's own Reduce motion setting is not copied into the native startup screen.

The shell keeps a copy of the Hub's motion style in `motion.json` (`expressive`; `minimal-quiet` and `minimal-dot` map to it, other values are ignored).

The desktop app has no tray or global shortcut; Quick capture is a separate app ([20](20_QUICK_CAPTURE.md)).

### 9. Hosted origin override

For developers and self-hosted builds. When set, the window opens this URL instead of the modes in §1, and no local runtime starts. The URL is resolved in order: runtime `ENSEMBLE_SITE_URL`, the saved value in `site.json`, then a value baked in at build time. Packaged builds bake none.

```bash
ENSEMBLE_SITE_URL=https://your-host.example pnpm desktop:build   # bake a hosted origin
```

An override uses that origin's backend and sign-in; local data is not moved (§1.3 is how a local-only computer joins an account).

`ENSEMBLE_DESKTOP_EXTERNAL_LOG=/path/to/log` appends each URL handed to the system browser, one per line, for testing the navigation rule.

### 10. Tests

| Check | Command |
| --- | --- |
| Shell unit tests (navigation, the init script's origin guard, modes, assets, sidecar, diagnostics) | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| Sidecar, runtime lock, user PATH, the local database in UTC on a computer in another zone | `pnpm --filter @ensemble/hub-api test` |
| Prisma's Rust-free client on PGlite (the Windows arm64 sidecar) | `cd apps/hub-api && npx tsx --test src/lib/pglite-adapter.test.ts` |
| Moving local data into an account (ids, merges, hostile rows, the transfer key) | `cd apps/hub-api && npx tsx --test src/transfer/transfer.integration.test.ts src/routes/cli-auth.integration.test.ts` |
| WebKit and Chromium clicks against the export | `pnpm desktop:e2e` |
| Release scripts | `node --test scripts/desktop-release.test.mjs scripts/desktop-targets.test.mjs scripts/package-mac-dmg.test.mjs` |
| Installed app on a Mac | [desktop/MAC_CHECKLIST.md](desktop/MAC_CHECKLIST.md) |

Sandbox escape tests on macOS Seatbelt, Linux Landlock, Linux bubblewrap and the Windows sandbox account, and the macOS escape, trust and git-gate tests with the Mac image packager check, are paused in `full-checks.yml` and run by hand ([37](37_PAUSED_CHECKS.md)).
