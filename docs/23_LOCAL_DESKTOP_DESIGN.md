# 23 · Local desktop architecture

This is the implemented desktop architecture, inspected **18 Oct 2026**. The earlier local-first design, build order and unbuilt Rust-broker proposal have been replaced here with the current process/storage boundaries. [DESKTOP](DESKTOP.md) is the run/build guide; [24](24_DESKTOP_SANDBOXING.md) owns sandbox enforcement.

## 1. Local, hosted and paired use

| Mode | What runs where |
| --- | --- |
| Bundled desktop (default) | Tauri loads the static Hub; one local Node API owns PGlite, model adapters, jobs and scheduler |
| Hosted window override | `ENSEMBLE_SITE_URL` chooses a hosted/dev UI; its backend/data remain those of that origin |
| Local runtime paired to an account | Hosted assignments/subscription/included-model requests can reach the computer through the device protocol |
| CLI runner | The same local runtime without a desktop window; the desktop can attach to it |

Hosted web is already implemented. Pairing does not replicate every hosted record to the local database. A local model call can still send prompts to the person's configured provider; local storage does not mean offline inference. Included models require a paired account and execute on Ensemble's server. Supported subscriptions use the person's local sign-in.

## 2. Processes and trust boundaries

```text
Tauri window + static Hub
    → random loopback API, launch bearer token
    → hub-api sidecar: PGlite + model adapters + scheduler + workspace queue
    → workspace runner → detected OS sandbox → task commands

CLI → same discovery/runtime lock → same sidecar
Paired host ← device token / claims / progress / bounded files → local remote loop
```

`apps/desktop/src-tauri/src` owns window/menu, navigation, bundled assets, sidecar lifecycle, diagnostics and updater. `apps/hub-api/src/desktop/main.ts` starts the API. Sandboxed commands are launched by TypeScript `workspace/runner.ts` and `workspace/sandbox/spawn.ts`; there is no implemented Rust `ensemble-sbx` broker between every API tool and process.

The API and local runtime are trusted application code: they hold content and encrypted credential state. The webview receives narrow commands/capabilities and the launch token, not arbitrary shell access. Agent child processes receive the configured filesystem/network scope and scrubbed environment. [24](24_DESKTOP_SANDBOXING.md) describes OS-specific limitations.

## 3. Storage, discovery and migrations

The local database is **PGlite**, accessed through the Prisma adapter with the compatible migration path. It is not SQLite or a separately installed PostgreSQL server. Transient Redis behavior is replaced in-process; no Docker, Redis server or Python model sidecar is bundled.

`api.json` in the platform application-data directory records the loopback endpoint/token, with restricted permissions where supported. A runtime lock prevents a second sidecar from opening the same database. Desktop attaches to a healthy CLI-started runtime; quitting the window does not stop a runtime owned by the CLI. A desktop-owned runtime follows its own lifecycle.

Migrations run on launch after an existing database backup into `backups/`. A database from a newer build is refused. These same-disk backups are not off-machine disaster recovery or guaranteed encrypted full-database storage.

The encryption master key is `secret.key` beside `pglite/`, using `ENSEMBLE_SECRET_KEY_FILE`. An older application-folder key is migrated once. **OS keychain-backed master-key storage is not the implemented design.** Replacing a read-only install must not replace saved credentials. Data-directory paths are documented in [DESKTOP](DESKTOP.md).

## 4. UI and authentication

`scripts/export-desktop-web.mjs` produces the static Hub export. The `ensemble` asset protocol serves placeholder route bundles for actual task/page/file IDs; `useDesktopParam` reads the real URL. API requests target the discovered loopback API with its token. This is already built; it is not a future “Phase 1b”.

Local mode uses the desktop authorization path; it does not require public hosted signup to keep local work. Pairing an account is a separate explicit action. Hosted origin cookies/local storage do not become the local app's state. External URLs open through the system-browser rules; arbitrary file/javascript navigation is refused.

The shell has no general desktop tray/global shortcut. The separate Quick capture app does. Native folder dialogs and notifications are narrow installed capabilities; the selected path still passes API authorization and filesystem rules. Notifications require the app/runtime and OS permission.

## 5. Tasks, trust and code

The same workspace queue, assignment settings, engine adapters, checkpoint decisions and run evidence are used by desktop and CLI. Path trust is local to the computer. Ask, Review only and Run unattended are implemented; Review only is not the separate read-only access mode. Outside-folder read/read-write/none is explicit. [06](06_MODULE_WORKSPACE_AND_SURFACES.md), [24](24_DESKTOP_SANDBOXING.md).

GUI startup restores the login-shell/tool install PATH (`desktop/user-path.ts`) so supported CLIs can be discovered. It does not bundle those agents' subscriptions or every development tool. Native plot export may need the user's Python/scientific stack; browser plot execution has its separate path.

## 6. Pairing and included AI

The remote loop uses a device token and lease, not inbound remote shell access. Jobs stay targeted to their device while offline; they never fall back to host execution. Task context and supported attachments are copied in bounded form. Code review/file reads/terminal and subscription calls have their own explicit protocols ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

A paired desktop/CLI can list and call the account's included models through the hosted included-turn endpoint. Azure keys stay on the host and usage shares the account's monthly credits. Local-only calls show how to connect instead of silently using operator credentials ([33](33_INCLUDED_AI.md)).

## 7. Packaging and updates

`release.json` is the single source for interface/API/CLI/native version metadata. `desktop.yml` builds macOS Apple silicon/Intel, Windows x64 and Linux x64; the release/download code names the actual DMG, installer, AppImage/deb/rpm and updater assets. Do not infer that every build artifact has already been published.

Tauri verifies signed updater packages; OS code signing/notarization is a separate currently unconfigured release concern. About checks the desktop release channel and blocks installing while local work is active. Earlier installs without the working update channel need a current installer once. Intel DMG/recovery tooling is described in [DESKTOP](DESKTOP.md) and the environment guide.

## 8. Limits and verification

No full local/hosted data replication, mobile native app, Rust-only execution broker, shared system-wide network-domain approval proxy, bundled Python model runtime or keychain master-key store is claimed here. Supported sandbox capability varies by OS/kernel/setup and is reported explicitly.

Use native Rust tests, `pnpm desktop:e2e`, sidecar/CLI tests and [the Mac checklist](desktop/MAC_CHECKLIST.md) for the affected path. Passing a static export or mock test does not prove a released installer launched successfully on every OS. This documentation pass reads source; release/physical-machine evidence belongs to its specific PR/build.
