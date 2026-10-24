# 26 · Ensemble CLI: the `ensemble` app in your terminal, a runner, and MCP for editors

Type `ensemble` in a project folder and Ensemble opens full-screen in the terminal:

1. **Tasks** (default tab): agent runs on this computer (needs you, running, queued, stopped, done) and every question or permission waiting on you, answered right there.
2. **Chat**: your agent. Claude Code, Codex, Cursor's agent or GitHub Copilot on your own sign-in, working in the folder under your run profile with your Ensemble board loaded; or Ensemble Code (the assistant with a configured model source).

`ensemble` starts this computer's runtime in the background if it is not running, so tasks assigned from [app.ensemblework.com](https://app.ensemblework.com) or a phone run here, in shared folders, with the model keys saved on the account (or added here). It keeps running after you leave the app. `ensemble mcp` is a read-only MCP server over your hosted Ensemble context; editors start it themselves. For editor context only, the **hosted MCP URL** needs no install (§5).

| What | Where |
|---|---|
| CLI (npm name `ensemblework`, command `ensemble`) | `apps/cli`; the app is `apps/cli/src/tui` (Ink and React, bundled into the same file) |
| Packaging | `scripts/package-cli.mjs`, `packaging/`, `.github/workflows/cli-release.yml` |
| Install scripts | `apps/landing/public/install.sh`, `install.ps1`, served at `https://ensemblework.com/install.sh` and `/install.ps1` |
| User guide | [ensemblework.com/download](https://ensemblework.com/download); in the Hub, Connect your apps and Settings → Connections → Connected computers |

## 1. Install

| OS | Command |
|---|---|
| macOS, Linux (Homebrew) | `brew install ensemblework/tap/ensemble` |
| macOS, Linux (script) | `curl -fsSL https://ensemblework.com/install.sh \| sh` |
| Windows (PowerShell) | `irm https://ensemblework.com/install.ps1 \| iex` |
| Windows (Scoop) | `scoop bucket add ensemblework https://github.com/ensemblework/scoop-bucket` then `scoop install ensemblework/ensemble` |
| Debian, Ubuntu | download `ensemble-cli_<version>_amd64.deb` (or `arm64`) from the newest `cli-v*` release, then `sudo apt install ./ensemble-cli_*_amd64.deb` |
| Fedora, RHEL, openSUSE | `sudo dnf install ./ensemble-cli-<version>-1.x86_64.rpm` (or `zypper install`) |

winget (`EnsembleWork.EnsembleCLI`), npm (`ensemblework`) and AUR (`ensemble-cli-bin`) metadata is generated, but publication depends on release credentials (§7); the download guide lists only available channels.

Every channel installs the same archive per target (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`):

```
ensemble/bin/ensemble        POSIX launcher (resolves symlinks)
ensemble/bin/ensemble.exe    Windows launcher (apps/cli/launcher, Go); ensemble.cmd fallback
ensemble/lib/ensemble.mjs    the CLI, bundled with esbuild (apps/cli/scripts/build.mjs)
ensemble/sidecar/node        Node runtime
ensemble/sidecar/app/        hub-api, as the desktop sidecar uses it
```

The archive is large because it carries Node, Prisma and PGlite. The launchers set `ENSEMBLE_LAUNCHER` (the path as invoked) and `ENSEMBLE_SIDECAR_DIR`. Script installs are per user: `~/.local/share/ensemble-cli/<version>` with a link at `~/.local/bin/ensemble`, and `%LOCALAPPDATA%\Programs\Ensemble\<version>` plus a `current` folder on the user PATH. `ENSEMBLE_VERSION` pins a version, `ENSEMBLE_INSTALL_DIR` moves the install, and `ENSEMBLE_DOWNLOAD_BASE` points the scripts at another download location (for packaging checks). Both scripts verify the archive against `SHA256SUMS.txt`.

### 1.1 Testing CLI

`ensemble-test` is a separate build of this CLI for `test.ensemblework.com`, not a flag on the production command. Install commands and testing/promotion workflow: [36](36_WEB_TESTING.md#install-the-testing-cli). It connects only to `https://api-test.ensemblework.com`; production `ensemble` defaults and native-app integration are unchanged. `ensemble-test status --json` reports `channel: "testing"` and its API. Its version contains `-testing.<build>`.

| Surface | Testing identity |
| --- | --- |
| Command/install | `ensemble-test`; `~/.local/share/ensemble-test-cli/<version>/ensemble-test`, link `~/.local/bin/ensemble-test`; Windows `%LOCALAPPDATA%\Programs\Ensemble Testing\<version>\ensemble-test`, `current\bin` on PATH |
| CLI config/credentials | `~/.config/ensemble-test` (or `$XDG_CONFIG_HOME/ensemble-test`); Windows `%APPDATA%\Ensemble Testing` |
| Runtime/data | macOS `~/Library/Application Support/com.ensemblework.cli.testing`; Windows `%APPDATA%\com.ensemblework.cli.testing`; Linux `$XDG_DATA_HOME/com.ensemblework.cli.testing` or `~/.local/share/com.ensemblework.cli.testing` |
| Workspace | `<testing-data>/workspace`; no shared production workspace |
| Login services | `com.ensemblework.cli.testing.runner`, `ensemble-test-runner.service`, Windows `Ensemble Testing Runner` |
| Editor MCP entry | `ensemble-test`, alongside production `ensemble` |
| Updates | `cli-testing-latest` GitHub prerelease, generated testing installers and `channel.json`; never stable package managers or native updates |

Build with `node apps/cli/scripts/build.mjs --testing`; package with `node scripts/package-cli.mjs --channel testing --target <target>`. `ENSEMBLE_TEST_CLI_VERSION` supplies `<release>-testing.<numeric-build>` without changing root `release.json`. The build-time channel (`apps/cli/src/channel.ts`) cannot be changed by a production API environment variable. `ENSEMBLE_TEST_TOKEN`, `ENSEMBLE_TEST_CONFIG_DIR` and `ENSEMBLE_TEST_DATA_HOME` are independent overrides; test launchers use `ENSEMBLE_TEST_LAUNCHER` and `ENSEMBLE_TEST_SIDECAR_DIR`. The testing runtime refuses production pairing, hosted calls and discovery belonging to the native/production runtime. Its included-model credits and account model keys come only from the test account.

Its Node tab reads the test API and links to the testing Node website, `https://node-test.ensemblework.com` (`TESTING_NODE`), never the production Node site.

## 2. Using it

### 2.1 The app

`ensemble` with no arguments in a terminal (or `ensemble app`) opens the app on the alternate screen with mouse reporting on and line wrapping off, and restores all three on exit (`apps/cli/src/tui/screen.ts`). An install that only connects editors (the npm package) says so and points to the full install. Layout, top to bottom: tabs (click, or Tab), the main area with a sidebar when the terminal is at least 90 columns wide (Ctrl+B or `/sidebar` hides it), the selected request's answers as numbered buttons, the composer, and a status line (folder, run profile, agent, sign-in).

**Tasks.** Runs are grouped Needs you, Running, Queued, Stopped and Done, refreshed every 1.5 s from the local runtime (`/api/workspace`, `/api/decisions`). A run waiting on a question sits under Needs you; so do requests from editors and agent apps not tied to a run here. Selecting one shows its progress and log. A question shows its options (recommended one starred) plus Skip; a permission offers Allow once, Allow for this task, Always and Deny (never Always for a path outside the folder). Click a button, press its number, or type an answer and press Enter. `/allow [once|task|always]`, `/deny [reason]` and `/answer <text>` do the same. Answers go to `POST /api/decisions/:id/decide`, so the card on the web and phone closes too. `/stop` and `/retry` act on the selected run.

**Chat with your agent.** With Claude Code, Codex, Cursor's agent or GitHub Copilot chosen (`/agent`), each message is one `chat: true` run (`POST /api/agent/assign`, `chatTurnRequest` in `apps/cli/src/tui/model.ts`) in the opened folder, on its own branch, under the run profile. The first message creates the chat's task ("Chat: …", kept In progress, no Agent report per turn); later ones resume the agent's session (`claude --resume`, Codex `thread/resume`, Cursor's and Copilot's ACP `session/load`; [30](30_ENGINES.md)). The reply streams from the run's log; permissions and questions appear as buttons. The agent's ensemble MCP server adds `ensemble_list_tasks`, `ensemble_create_task` and `ensemble_search`. `/model` sets the agent's model (Claude Code: default, sonnet, opus, haiku; Codex and Cursor: typed). With GitHub Copilot, `/model` lists the models Copilot reports on this computer (`GET /api/subscriptions`), each with its cost and context sizes ("low cost · 200K / 922K context"), plus *Auto (Copilot picks)* and *Another model…* (typed); then a thinking level from that model's levels (or Default), then Standard or Long context when the model has a long window. The choice is kept in `<config>/app.json` (`agentModel`, `agentEffort`, `agentContext`; switching agent clears them) and sent on Chat turns and `/run` as `model`, `reasoningEffort` and `contextTier`. Without a `/model` choice, `/run` uses a Copilot run profile's model, thinking level and context. Before a message or `/run`, a Copilot that was missing or signed out is checked again (`POST /api/subscriptions/check`); still so, nothing is created and the fix is shown ("run copilot login", "npm install -g @github/copilot"). Esc stops the turn; `/new` starts a new chat. With Ensemble's agent chosen and no model key here or on the account, the app switches to the first installed agent (Claude Code, Codex, Cursor, GitHub Copilot) and says so. A missing key names the provider and the fix ("No key for Google Gemini. Add one in Settings → Models (in the Ensemble CLI: /keys google), …").

**Ensemble Code.** With Ensemble's agent chosen, messages go to `POST /api/assistant/turn` with a `code` session: the folder (`/folder`), the agent (`/agent`), the run profile (`/profile`: up to three profiles saved in the Assign dialog, or Quick; [02](02_MODULE_INTERACTION_HUB_UI.md)) and the chat model (`/model`, sent with its provider, so a Copilot model is called on Copilot only; the first row, *Chat default*, is the account's default tier model). It has the assistant's tools plus code tools: list, read and search files in the folder; read PDF, Word, Excel and PowerPoint as text; start an agent on a new task (`ensemble_start_agent`, which can clone a repository by URL); check a run (`ensemble_job_status`). It never edits files or runs commands itself; the agent it starts does, in the sandbox, under the profile. Changes wait for Apply per the assistant's write policy (Settings → Assistant): 1 applies, 2 discards. Esc and `/new` work as above. It runs only against a runtime on this computer (`ENSEMBLE_DESKTOP=1`); the hosted API refuses it with 409.

**Node (read-only).** The third tab shows Ensemble Node at a glance: the account's nodes (working or idle), rooms with unread counts and their newest message, approvals waiting, requests to join someone's room, the computer runs nodes started, and the credits left (shared by Ensemble, the CLI and Node). It reads `GET /api/bridge/node` with the CLI's own sign-in key, every 10 s while open and every minute otherwise for the tab's badge. Approving and chatting happen on the Node website (`ENSEMBLE_NODE_URL`, else `node.` plus the account's Ensemble domain); typing a message here says so ([35](35_ENSEMBLE_NODE.md)).

**Slash commands.** `/` opens a menu under the composer, filtered as you type, with this tab's commands first; arrows choose, Tab completes, Enter runs. `/run <what to do>` creates a task and starts the chosen agent on it in this folder with the run profile (with Ensemble's agent: the profile's model, provider and thinking level). A profile that ends in a pull request runs in its own clone of this folder (which must be a git repository) and says so: "…in its own clone of this folder; it ends in a pull request into testing." Chat messages never end in a pull request. Others: `/tasks`, `/chat`, `/node`, `/trust` (Review only and Run unattended need a trusted folder), `/keys [provider]` (add a model key for this computer, typed masked), `/sandbox`, `/hooks` (connect Claude Code, Codex, Copilot and Cursor to Needs me), `/login`, `/logout`, `/runner install|uninstall` (start Ensemble at login), `/update`, `/status`, `/help`, `/exit`.

**Keys.** Tab cycles Tasks, Chat and Node (completes in the slash menu). With the composer empty, Up and Down select a run (or scroll the chat), Left and Right move between buttons, and 1–9 press one. While typing, Up and Down recall what you sent and Ctrl+A/E/U/W edit the line. PgUp/PgDn and the mouse wheel scroll, Esc closes a menu or clears the composer, Ctrl+C twice leaves. The chosen tab, agent, profile, chat model and sidebar are saved in `<config>/app.json`.

**Identity.** The status row shows `[e] Ensemble` with a four-cell braille infinity at 8 fps while a chat or task runs (`apps/cli/src/tui/brand.tsx`, `packages/brand/cli.js`); idle has no timer. Redirected output and `TERM=dumb` get a still ASCII marker, `NO_COLOR` drops colour, truecolor terminals use `#D7B56F` and others ANSI yellow. `ENSEMBLE_REDUCE_MOTION=1` keeps the marker still.

### 2.2 Commands for scripts

Every action is also a plain command; `ensemble help commands` lists them (`ensemble help` and `--help` show the short version).

| Command | What it does |
|---|---|
| `ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]` | Device login (§4). Saves a read-only key; when "Run tasks" is also approved, pairs this computer as a device |
| `ensemble logout` | Revokes the key on the server, unpairs the device, clears local credentials. If the server is unreachable it still clears this computer and names the key to revoke under Connect your apps |
| `ensemble status [--json]`, `ensemble doctor` | Account, API, sign-in, pairing, runner, folders (repositories marked), the pull request bases (`Pull requests  into testing`, or off), model keys, sandbox, configured editors. `doctor` exits 1 when a check fails and says how to fix it |
| `ensemble folders [list] \| add <path> [--label L] [--read-only] [--repo] \| remove <label>` | Folders the agent may work in. Only labels are sent to the server; the Assign dialog lists them. `--repo` shares a git repository as a repository: every run from the web works in its own clone of it and may end in a pull request ([24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)); without it the folder is worked in place. `--repo` with `--read-only`, or on a folder without `.git`, is refused. Listed as `label → path (repository)` |
| `ensemble keys [list] \| set <provider> \| remove <provider>` | Model keys for this computer. `list` shows where each key is (this computer or the account). `set` reads from a hidden prompt or stdin, never from arguments |
| `ensemble runner [start] [--foreground] \| stop \| restart \| status \| logs [-f] \| install \| uninstall` | The runner. `install` registers it at login: a LaunchAgent (`~/Library/LaunchAgents/com.ensemblework.cli.runner.plist`), a `systemd --user` unit (`ensemble-runner.service`) or a Task Scheduler task (`Ensemble Runner`), and stops a hand-started runner so the service takes over. Services run `runner start --foreground`, which exits 0 when stopped on purpose, so launchd (`KeepAlive` with `SuccessfulExit` false) and systemd (`Restart=on-failure`) restart it only after a crash; while another runner runs it waits for that one to stop. `uninstall` signs out, then removes the service. `stop` signals only the pid in `api.json`, after `/health` answers with that file's token |
| `ensemble needs [list] \| answer <n> <allow\|deny\|option number\|"answer">` | Questions and approvals waiting on this computer: questions with options (recommended one marked), pushes, folder trust, paths outside a folder, and the prompts Claude Code, Codex, Copilot and Cursor send through their hooks (several options as `1,3` when the tool allows it). Answering here closes the card on the web too (`apps/cli/src/approvals.ts`) |
| `ensemble sandbox [status] \| setup` | This computer's OS sandbox ([24](24_DESKTOP_SANDBOXING.md)): Seatbelt on macOS, bubblewrap or Landlock on Linux, the sandbox account on Windows; what it cannot enforce here; whether internet off is enforced. On Windows `setup` asks for admin permission once (also offered at `ensemble login`). Shared with the desktop app (`apps/cli/src/sandbox.ts`) |
| `ensemble trust [list] \| add [path] \| remove <path> \| share [on\|off]` | Trusted folders on this computer (default: the current folder). `share` shows or sets whether they are also trusted in Claude Code, Codex, GitHub Copilot CLI, Cursor and Gemini CLI (on by default; [24](24_DESKTOP_SANDBOXING.md)). Ensemble's own workspace is always trusted. System folders, the home folder and Ensemble's source are refused |
| `ensemble hooks [list] \| connect <claude\|codex\|copilot-cli\|cursor> \| disconnect <tool>` | Connects Claude Code (and the Claude app), Codex (CLI and the ChatGPT app), GitHub Copilot CLI or Cursor: prompts and questions from tasks Ensemble opens in them reach Needs me, while the tool's own prompt still works. The hook signs in with a `hooks` key that can ask but never answer ([30](30_ENGINES.md)) |
| `ensemble git bases [list] \| add <branch> \| remove <branch>` | The branches runs here may open pull requests into, and merge into when the task says so (default `testing`; at most 20). `main`, `master`, `production`, `testing-live` and names git refuses are refused before anything changes; removing the last one turns pull requests off. Only this computer changes the list; the web shows it ([24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)) |
| `ensemble approvals [status] \| on \| off` | Whether the web and phone may approve for this computer, and whether the mode, internet and limits chosen there apply here (on by default; [25 §5.1](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#51-phone-approvals)) |
| `ensemble browse [status] \| on \| off` | Whether Ensemble on the web shows files of tasks run here: the text of files a run changed, sent when it ends, and any file or folder in a task's folder, read on demand. Never git's own files or secrets files (on by default; [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)) |
| `ensemble web [status] \| files on\|off \| edit on\|off \| terminal on\|off` | What Ensemble on the web may do here, each on by default: `files` (same switch as `browse`, plus reading code in the web's Code tab), `edit` (accept or reject an agent's changes, edit files, commit, push, pull), `terminal` (open the terminal here after a passkey unlock on the web). The computer checks each on every request ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web)) |
| `ensemble mcp` | Read-only MCP server on stdio (editors run this) |
| `ensemble mcp setup [editor…] [--all] [--print] [--hosted]`, `mcp remove <editor>`, `mcp editors` | Write editor config (§6) |
| `ensemble update` | Installs the newest CLI release (§4, Updates) |
| `ensemble version`, `--version` | The release version |

`--api` or `ENSEMBLE_API_URL` changes the server (default `https://api.ensemblework.com`), for example `http://127.0.0.1:4000` for local development.

## 3. Where things live

| What | Location |
|---|---|
| Config | `ENSEMBLE_CONFIG_DIR`, else `%APPDATA%\Ensemble`, else `$XDG_CONFIG_HOME/ensemble` or `~/.config/ensemble`: `config.json` (API, account, device name), `credentials.json` (mode 0600, the `ens_` key), `app.json` (app preferences) |
| Data | `ENSEMBLE_DATA_HOME`, else the desktop app's folder, shared with it: macOS `~/Library/Application Support/com.ensemblework.desktop`, Windows `%APPDATA%\com.ensemblework.desktop`, Linux `$XDG_DATA_HOME/com.ensemblework.desktop` or `~/.local/share/com.ensemblework.desktop` |
| Inside data | `pglite/` (database), `secret.key` (encrypts model keys and the device token), `remote.json` (pairing, shared folders), `api.json` (running runtime: port, token, pid, which launcher started it), `runtime.lock`, `logs/runner.log` (rotated at 10 MB), `runner.pid`, `update-check.json`, `backups/` |
| Workspace | `~/ensemble-workspace` (`ENSEMBLE_WORKSPACE_ROOT` overrides), shared with the app |

A data folder from an early CLI (`~/Library/Application Support/Ensemble CLI`, `%LOCALAPPDATA%\Ensemble`, `~/.local/share/ensemble`) is moved to the shared folder once, before the first runner starts, unless the shared folder already has a database (`apps/cli/src/migrate.ts`).

## 4. How it works

**Login.** `ensemble login` calls `POST /api/cli/auth/start`, prints a code like `BCDF-GHJK` and opens `https://app.ensemblework.com/link?code=…` (only `https:` URLs, or `http:` on localhost, go to the system browser; `apps/cli/src/browser.ts`). The signed-in `/link` page shows "Ensemble CLI on ‹computer name›", the platform, CLI version, the network address that started the login (with a warning when it differs from the browser's) and the requested access. Approve stays disabled until you tick that you started this login and the code matches your terminal. The CLI polls `POST /api/cli/auth/token` every 5 seconds. On approval the server mints a bridge-scope `ens_` key and, when "Run tasks" was approved (verified email required on the hosted site), a one-time device pairing code. Device and user codes are stored as SHA-256 hashes and expire after 10 minutes. Routes: `apps/hub-api/src/routes/cli-auth.ts`. The CLI then pairs through the local sidecar (`POST /api/remote/pair` → `POST /api/devices/register`). The key belongs to the Ensemble space open at approval, so the CLI and editors read only that space ([28](28_ENSEMBLE_SPACES.md)).

**Runner.** The runner is the desktop sidecar (`apps/hub-api/src/desktop/main.ts`) without the Tauri window: one Node process with hub-api on a random loopback port, PGlite, the worker queue and the remote loop (`apps/hub-api/src/remote/loop.ts`). The loop holds an event stream to the hosted API, claims jobs for this device, runs them with the in-process model runtime and this computer's keys, and reports progress and results ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). Claimed jobs carry page and diagram source and the original attached files, downloaded under the job's lease and remapped to local file IDs, up to 100 MB per job. `ensemble` starts the runner when none is running (the desktop runtime counts) and leaves it running on exit. When the running runner's `api.json` `version` differs from the CLI, the app restarts it on open, unless tasks are running or waiting; then it asks the person to finish or stop them and reopen. Commands that need the local API while no runner runs (`folders`, `keys`, pairing at login) start an admin-only sidecar with `ENSEMBLE_REMOTE_LOOP=off`, `ENSEMBLE_AGENT_QUEUE=off` and `ENSEMBLE_SCHEDULER=off`, which never claims hosted work, and stop it afterwards.

**PATH.** At start the runtime asks the login shell for its PATH (`$SHELL -ilc`, at most four seconds) and adds the usual install folders (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`, npm, bun, Volta and nvm), never a folder inside the workspace (`apps/hub-api/src/desktop/user-path.ts`). Started from a terminal, that terminal's PATH stays first; started by the login service or the desktop app, the login shell's comes first.

**One runtime per computer.** The CLI and the desktop app run the same sidecar on the same data folder: one database, one pairing, one list of trusted folders, one sandbox. `runtime.lock` (`apps/hub-api/src/desktop/runtime-lock.ts`) stops a second sidecar from opening the database; it exits with code 75 and the launcher attaches to the running one. The desktop app attaches to a running CLI runner (and starts its own on the same port and token if that runner stops); a CLI command uses the app's runtime when the app is open. `ensemble runner stop` does not stop the app's runtime, and a runner service waits while the app runs. `ensemble login` keeps the app's pairing when it is for the same server.

**One set of keys.** Signed in and paired, the runtime uses the model keys saved on the account (Settings → Assistant → Models on the web) for providers with no key on this computer; Ensemble Code, `/model`, `/status`, `ensemble keys list` and tasks run here all see them. They come from `GET /api/devices/self/model-keys` with the device token, are held in memory only, refreshed after 10 minutes or on Refresh in Settings, and never written to this computer's database (`apps/hub-api/src/remote/account-keys.ts`). *Use these keys on my computers* in the web's API keys dialog turns this off. A key added here (`/keys`, `ensemble keys set`, stored through `PUT /api/model-keys/:provider` on the sidecar) stays on this computer and wins for its provider. The encryption key is `<data>/secret.key` (`ENSEMBLE_SECRET_KEY_FILE`), not the install folder, so upgrades and read-only installs keep it.

**Included models** ([33 §4](33_INCLUDED_AI.md#4-where-included-models-run)). Signed in and paired, `/model` also lists the account's included models (*Included with Ensemble · your credits*); each call runs on Ensemble's server on the account's monthly credits through `POST /api/devices/self/included/turn`. Signed out, or without *Run tasks*, the CLI is local only: `/model` shows *Included with Ensemble — connect this computer first: /login*, and a refusal (local only, credits used, paused for everyone) is a framed notice with the fixing command (`apps/cli/src/tui/included.ts`). The allowance is enforced on the account server (`included/accounting.ts`); deleting data or recreating the account with the same email does not replenish it. The CLI does not read external AI plan balances.

**Your AI subscriptions.** Signed in and paired, the runtime tells Ensemble on the web which AI subscriptions it can run (Claude Code from `claude` or the Claude app, Codex from `codex` or the ChatGPT app, Cursor's agent, Copilot CLI) and answers assistant turns for a tier set to one of them: the agent runs here on its own sign-in with only Ensemble's tools, which run on the web ([30](30_ENGINES.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). The computer must be awake with the runtime running. The Copilot adapter reads JSONL responses and per-call token events from the process Ensemble launched (`subscriptions/copilot-output.ts`); it does not query account quota, and counts stay unavailable when the process does not report them.

**Editor hooks on handoff.** When Ensemble hands a task to an installed editor, `workspace/editor-hooks.ts` creates a scoped hook token if needed and installs the hook before opening the task; VS Code gets its project hook automatically. Only the handoff's marker or an already linked session sends questions to Needs me; other sessions in the same editor or folder stay in that editor.

**Logout and removal.** `POST /api/cli/logout` revokes the presenting key. The local unpair calls `DELETE /api/devices/self` with the device token, so the computer leaves the account even if the CLI never runs again. A packaged CLI passes its launcher path as `ENSEMBLE_INSTALL_PATH`; if that file is removed, a surviving runtime notices on its next remote heartbeat and stops and forgets remote access.

**Updates.** Root `release.json` is the version; `scripts/release-version.mjs --sync` updates package manifests, native configs and `packages/shared-types/src/version.ts`, and build and typecheck reject drift. `ensemble --version` and the app's Status show it. Once a day (2-second timeout; a failed check also waits a day; cached in `update-check.json`) the CLI checks GitHub for the newest `cli-v*` release, independent of desktop tags, and prints a one-line notice; never for `mcp` or `runner`, when stderr is not a terminal, or with `ENSEMBLE_NO_UPDATE_CHECK=1` or `CI`. `ensemble update` and `/update` in the app install it: Homebrew runs `brew upgrade ensemble`, Scoop `scoop update ensemble`, script installs run the bundled installer (which verifies the checksum); npm, winget, Linux package and unknown installs open the download page. Active tasks block updating. A CLI-owned runner is stopped afterwards and the person reopens Ensemble; a desktop-owned runtime is left running, and installing the CLI does not replace the desktop app.

## 5. MCP: local CLI or hosted URL

Both expose the same 17 read-only tools from `apps/context-bridge` (`buildServer` in `src/server.ts`; [CONTEXT_BRIDGE](CONTEXT_BRIDGE.md)).

- **Local:** `ensemble mcp` runs on stdio and reads `https://api.ensemblework.com/api/bridge/*` with the saved key. It reads the git repository from the editor's working folder for `ensemble_brief`.
- **Hosted:** `POST https://api.ensemblework.com/mcp` with `Authorization: Bearer ens_…`. Streamable HTTP, stateless, JSON responses (`apps/hub-api/src/routes/mcp.ts`). Each tool call goes through the normal `/api/bridge` routes with the caller's key, so every bridge check applies. Requests without a bearer key (including cookie-only requests) get 401 with `WWW-Authenticate: Bearer realm="Ensemble"`. Device keys get 403. `GET` and `DELETE` return 405. The hosted server never runs git, so `ensemble_brief` needs the repository and branch passed in. Rate limit: `ENSEMBLE_RATE_MCP_LIMIT` per user per `ENSEMBLE_RATE_MCP_WINDOW_SEC` (240 per 60 s).

Keys for the hosted URL come from Connect your apps (`POST /api/connect/token`) or `ensemble login`. A bridge key can only read `/api/bridge`, call `/mcp`, and revoke itself at `/api/cli/logout`.

There is no OAuth authorization-server flow for external MCP clients; clients that require one must use local stdio or a bearer-header configuration. Claude Desktop uses the local CLI setup.

## 6. Editors

`ensemble mcp setup` edits each file with `jsonc-parser` (comments and other servers are kept) and saves a one-time `<file>.ensemble-backup`. Local mode writes the stable absolute launcher path (a Homebrew Cellar path maps to `<prefix>/bin/ensemble`, a Scoop version folder to `current`), because GUI apps on macOS do not inherit Homebrew's PATH. `--hosted` writes the URL form; it needs `ensemble login` or `ENSEMBLE_TOKEN`.

| Editor (`setup` id) | File or command |
|---|---|
| VS Code (`vscode`, `vscode-insiders`) | user `mcp.json`: macOS `~/Library/Application Support/Code/User/`, Windows `%APPDATA%\Code\User\`, Linux `~/.config/Code/User/`; key `servers`. Hosted mode puts the read-only key in this user profile file, because a `${input:…}` secret drops the server from VS Code's Agent Host |
| Cursor (`cursor`) | `~/.cursor/mcp.json`, `mcpServers` |
| Windsurf (`windsurf`) | `~/.codeium/windsurf/mcp_config.json`, `mcpServers` (hosted uses `serverUrl`) |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json` in `~/Library/Application Support/Claude/`, `%APPDATA%\Claude\`, `~/.config/Claude/`. Local only |
| Claude Code (`claude-code`) | `claude mcp add --scope user ensemble -- <ensemble> mcp` (hosted: `--transport http … --header "Authorization: Bearer …"`) |
| Codex CLI and IDE (`codex`) | `~/.codex/config.toml`, `[mcp_servers.ensemble]`; hosted uses `url` + `bearer_token_env_var = "ENSEMBLE_TOKEN"` |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json`, `mcpServers` (hosted uses `httpUrl`) |
| GitHub Copilot CLI (`copilot`) | `~/.copilot/mcp-config.json`, `"type": "local"` / `"http"` |
| Zed (`zed`) | `settings.json` (`~/.config/zed/`, Windows `%APPDATA%\Zed\`), `context_servers` |
| Visual Studio 2022 17.14+ (`visual-studio`) | `%USERPROFILE%\.mcp.json`, `servers` |
| Cline (`cline`) | `cline_mcp_settings.json` in VS Code's `globalStorage/saoudrizwan.claude-dev/settings/` |
| opencode (`opencode`) | `~/.config/opencode/opencode.json`, `mcp` |
| JetBrains IDEs (`jetbrains`), Continue (`continue`) | printed only: JetBrains AI Assistant settings → Model Context Protocol → Add → As JSON; Continue `~/.continue/config.yaml` |

The Hub's Connect your apps page (`apps/hub-web/lib/connect/configs.ts`) generates the same shapes for each editor, method (CLI, hosted URL, from source) and OS.

## 7. Releases

Push a tag `cli-v<version>` matching root `release.json`, or run the `cli-release` workflow by hand (dry run by default). Jobs:

1. **build** on `macos-14`, `macos-15-intel`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-2022`: `scripts/package-cli.mjs --target …`, then `scripts/smoke-cli-package.mjs` (version, an MCP handshake, an admin-only sidecar reaching `/health`; on Linux on the package's OpenSSL 3 query engine).
2. **release**: `.deb`/`.rpm` with nfpm, the npm tarball, `SHA256SUMS.txt`, metadata from `packaging/render.mjs` (Homebrew formula, Scoop manifest, winget manifests, nfpm configs, AUR `PKGBUILD` and `.SRCINFO`), and a GitHub release created with `--latest=false` so the desktop updater's `releases/latest` is never a CLI release. Installers find the newest `cli-v*` release through the GitHub API.
3. **homebrew**, **scoop**: push the formula to `ensemblework/homebrew-tap` and the manifest to `ensemblework/scoop-bucket` with the deploy keys `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY`. The formula sets `version` explicitly (Homebrew would otherwise read "64" from `darwin-arm64`) and `version_scheme 1`; `packaging/render.test.mjs` checks both and runs with the CLI tests.
4. **winget** (only with `WINGET_TOKEN`) and **npm** (only with `NPM_TOKEN`, with provenance).

Everything uses free services: Actions minutes on a public repository, GitHub Releases and the two public package repositories. Packages declare the repository license, `FSL-1.1-MIT` ([LICENSE.md](../LICENSE.md)), and every archive carries `LICENSE.md`.

Local packaging needs a host matching the target: `pnpm cli:package -- --target darwin-arm64 --out dist/cli` (or `--skip-sidecar` for a fast layout check).

## 8. Limits

- Builds are not code-signed or notarized. Homebrew, Scoop, the scripts and the Linux packages do not mark files as downloaded from the internet; a zip opened from a browser download can ask once.
- Windows needs one admin prompt to turn its sandbox on (`ensemble sandbox setup`); until then a sandboxed task there is refused with that instruction ([24](24_DESKTOP_SANDBOXING.md)). `ensemble doctor` checks the sandbox.
- The runner needs the full archive. The npm package carries only login, status and MCP.
- One runtime per computer, shared with the desktop app (§4).
- GitHub Copilot's command sandbox needs its own host tools (on Linux `slirp4netns` among them); without them a Copilot run with the sandbox on stops with what is missing ([30 §3](30_ENGINES.md)).
- Ensemble Code reads documents with the Files reader ([32](32_FILES.md)) in a worker with memory and time limits; it does not load other MCP servers.
- Mouse clicks need a terminal that reports SGR mouse events; the keyboard does everything without them. A terminal narrower than 90 columns hides the sidebar.

## 9. Tests

```bash
pnpm --filter ensemblework test           # builds dist/ensemble.mjs first
node --test packaging/render.test.mjs     # release metadata
```

Package smoke tests (`scripts/smoke-cli-package.mjs`) check the archive's version, MCP handshake and local sidecar health (on Linux with the OpenSSL 3 query engine that Ubuntu 22.04+, Debian 12+ and Fedora load); hub-api suites cover device login, MCP scope, assignment and the remote contract. They do not exercise real service managers, physical machines or provider sign-ins.
