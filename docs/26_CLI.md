# 26 · Ensemble CLI: the `ensemble` app in your terminal, a runner, and MCP for editors

CLI 0.3.6 carries Woven Chorus branding and the Satin Gold terminal indicator. CLI 0.3.7 resolves host names inside the macOS sandbox (so a task can `git clone` from GitHub) and shows the files of tasks run here on the web (`ensemble browse`). CLI 0.3.8 lets the web's Code tab work on this computer: review and edit code, Source control, and the terminal after a passkey unlock on the web (`ensemble web`). CLI 0.3.9 answers the full editor's calls from the web (file versions, the folder tree, find in files, commits of exactly the ticked files, pull requests) and Plots no longer needs this computer on the web.

Type `ensemble` in a project folder and Ensemble opens full-screen in the terminal:

1. **Tasks** (the default tab): agent runs on this computer (needs you, running, queued, stopped, done) and every question or permission waiting on you, answered right there.
2. **Chat**: your agent. Claude Code, Codex or Cursor's agent on your own sign-in, working in the folder under your run profile, with your Ensemble board loaded; or Ensemble Code (Ensemble's agent, which needs a model key).

`ensemble` starts this computer's runtime in the background if it is not running, so tasks you assign from [app.ensemblework.com](https://app.ensemblework.com) or your phone run here, in folders you share, with the model keys saved on your account (or ones you add here). It keeps running after you leave the app. `ensemble mcp` is a read-only MCP server that reads your hosted Ensemble context; editors start it themselves. People who only want editor context can skip installing anything and use the **hosted MCP URL** instead (§5).

Code: `apps/cli` (npm name `ensemblework`, command `ensemble`); the app is `apps/cli/src/tui` (Ink and React, bundled into the same single file). Packaging: `scripts/package-cli.mjs`, `packaging/`, `.github/workflows/cli-release.yml`. Install scripts: `apps/landing/public/install.sh` and `install.ps1`, served at `https://ensemblework.com/install.sh` and `/install.ps1`. User guide: [ensemblework.com/download](https://ensemblework.com/download), and in the Hub under Connect your apps and Settings → Devices.

CLI 0.3.11 carries the page/diagram source and original attached-file handoff to paired runs. The runner downloads the originals with its active job lease and remaps page references to local file IDs before starting; the transfer is capped at 100 MB. Update older runners for original-file transfer ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

## 1. Install

| OS | Command |
|---|---|
| macOS, Linux (Homebrew) | `brew install ensemblework/tap/ensemble` |
| macOS, Linux (script) | `curl -fsSL https://ensemblework.com/install.sh \| sh` |
| Windows (PowerShell) | `irm https://ensemblework.com/install.ps1 \| iex` |
| Windows (Scoop) | `scoop bucket add ensemblework https://github.com/ensemblework/scoop-bucket` then `scoop install ensemblework/ensemble` |
| Debian, Ubuntu | download `ensemble-cli_<version>_amd64.deb` (or `arm64`) from the newest `cli-v*` release, then `sudo apt install ./ensemble-cli_*_amd64.deb` |
| Fedora, RHEL, openSUSE | `sudo dnf install ./ensemble-cli-<version>-1.x86_64.rpm` (or `zypper install`) |

Not yet available: winget (`EnsembleWork.EnsembleCLI`, needs a first submission to `microsoft/winget-pkgs`), npm (`ensemblework`, needs an npm account token), and the AUR package `ensemble-cli-bin`. The release workflow already produces their files (§7).

All channels install the same archive per target (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`):

```
ensemble/bin/ensemble        POSIX launcher (resolves symlinks)
ensemble/bin/ensemble.exe    Windows launcher (apps/cli/launcher, Go); ensemble.cmd fallback
ensemble/lib/ensemble.mjs    the CLI, bundled with esbuild (apps/cli/scripts/build.mjs)
ensemble/sidecar/node        Node runtime
ensemble/sidecar/app/        hub-api, as the desktop sidecar uses it
```

An archive is about 120 MB (darwin-arm64 measured 116 MB on 6 Oct 2026) because it carries Node, Prisma and PGlite. The launchers set `ENSEMBLE_LAUNCHER` (the path as invoked) and `ENSEMBLE_SIDECAR_DIR`. The script installs are per user: `~/.local/share/ensemble-cli/<version>` with a link at `~/.local/bin/ensemble`, and `%LOCALAPPDATA%\Programs\Ensemble\<version>` plus a `current` folder on the user PATH. `ENSEMBLE_VERSION` pins a version, `ENSEMBLE_INSTALL_DIR` moves the install, and `ENSEMBLE_DOWNLOAD_BASE` points the scripts at another download location (used for testing). Both scripts verify the archive against `SHA256SUMS.txt`.

## 2. Using it

### 2.1 The app

`ensemble` with no arguments in a terminal (or `ensemble app`) opens the app on the terminal's alternate screen with mouse reporting on and line wrapping off, and restores all three on exit (`apps/cli/src/tui/screen.ts`). When the install only connects editors (the npm package), it says so and points to the full install. Layout, top to bottom: the tabs (click one, or press Tab), the main area with a sidebar on the left when the terminal is at least 90 columns wide (Ctrl+B or `/sidebar` hides it), the answers for the selected request as numbered buttons, the composer, and a status line (folder, run profile, agent, sign-in).

**Tasks.** Runs are grouped Needs you, Running, Queued, Stopped and Done, refreshed every 1.5 s from the local runtime (`/api/workspace`, `/api/decisions`). A run that is waiting on a question sits under Needs you with it; so do requests from editors and agent apps that are not tied to a run here. Select one (arrows, or click) to see its progress and log. A waiting request shows its answers as buttons: a question's own options with the recommended one starred, plus Skip; a permission offers Allow once, Allow for this task, Always and Deny (never Always for a path outside the folder). Click a button, press its number, or type your own answer and press Enter. `/allow [once|task|always]`, `/deny [reason]` and `/answer <text>` do the same from the keyboard. The answer goes to `POST /api/decisions/:id/decide`, so the card on the web and the phone closes too. `/stop` and `/retry` act on the selected run.

**Chat with your agent.** With Claude Code, Codex or Cursor's agent chosen (`/agent`), Chat is that agent on the person's own sign-in. Each message is one turn of it: a `chat: true` run (`POST /api/agent/assign`, `chatTurnRequest` in `apps/cli/src/tui/model.ts`) in the folder `ensemble` was opened in, under the run profile's mode, git delivery, sandbox and internet settings, on the folder's own branch. The first message creates the chat's task ("Chat: …", kept In progress, no Agent report per turn); each later one continues the earlier run and resumes the agent's own session (`claude --resume`, Codex `thread/resume`, Cursor's ACP `session/load`), so it remembers the conversation ([30](30_ENGINES.md)). The reply streams in from the run's log, with a line for each thing the agent does; what it asks (a permission, a question) shows in Chat as buttons, answered with a click, a number, a typed answer or `/allow` and `/deny`. Its ensemble MCP server adds the person's board: `ensemble_list_tasks`, `ensemble_create_task`, `ensemble_search`. `/model` sets the agent's own model (Claude Code: default, sonnet, opus, haiku; Codex and Cursor: typed). Esc stops the turn; `/new` starts a new chat. With no model key (neither on this computer nor on the account) and Ensemble's agent chosen, the app switches to the first agent installed (Claude Code, then Codex, then Cursor) and says so. Before 13 Oct 2026 it counted the runtime's "no key" rows as keys, so it never switched. A failed turn shows its error once (it used to appear again as the reply), and a missing key names the provider of the model in use and how to add it ("No key for Google Gemini. Add one in Settings → Models (in the Ensemble CLI: /keys google), …").

**Ensemble Code.** With Ensemble's agent chosen, messages go to `POST /api/assistant/turn` with a `code` session: the folder `ensemble` was opened in (`/folder` changes it), the agent (`/agent`: Ensemble's agent, Claude Code, Codex or Cursor), the run profile (`/profile`: the up to three profiles saved in the Assign dialog, or Quick; [02](02_MODULE_INTERACTION_HUB_UI.md), Assign to agent) and the chat model (`/model`; it is sent with its provider, so a Copilot model is called on Copilot and nowhere else, and the picker's first row is *Chat default*, the model of the account's default tier). Ensemble Code has the assistant's tools plus code tools: list, read and search files in the folder; read PDF, Word, Excel and PowerPoint files as text; start an agent on a new task (`ensemble_start_agent`, which can also clone a repository by URL); and check a run (`ensemble_job_status`). It never edits files or runs commands itself: the agent it starts does, in the sandbox, under the profile's mode, git delivery, sandbox and internet settings. Changes wait for Apply as the assistant's write policy says (Settings → Assistant); press 1 to apply or 2 to discard. Esc stops a reply being written. `/new` starts a new chat. Ensemble Code runs only against a runtime on this computer (`ENSEMBLE_DESKTOP=1`); the hosted API refuses it with 409.

**Slash commands.** Typing `/` opens a menu under the composer, filtered as you type, with this tab's commands first; arrows choose, Tab completes, Enter runs. `/run <what to do>` creates a task and starts the chosen agent on it in this folder with the run profile (with Ensemble's agent, the profile's model, provider and thinking level), without going through chat. Others: `/tasks`, `/chat`, `/trust` (trust this folder; Review only and Run unattended need it), `/keys [provider]` (add a model key for this computer, typed masked; keys on your account already work here), `/sandbox`, `/hooks` (connect Claude Code, Codex, Copilot and Cursor to Needs me), `/login` and `/logout`, `/runner install|uninstall` (start Ensemble at login), `/status`, `/help`, `/exit`.

**Keys.** Tab switches tabs (completes in the slash menu). With the composer empty, Up and Down select a run (or scroll the chat), Left and Right move between the buttons, and 1–9 press one. While typing, Up and Down step through what you sent before and Ctrl+A/E/U/W edit the line. PgUp/PgDn and the mouse wheel scroll, Esc closes a menu or clears the composer, Ctrl+C twice leaves. The chosen tab, agent, profile, chat model and sidebar are saved in `<config>/app.json`.

### 2.2 Commands for scripts

Every action is also a plain command for scripts and automation; `ensemble help commands` lists them (`ensemble help` and `--help` show the short version).

| Command | What it does |
|---|---|
| `ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]` | Device login (§4). Saves a read-only key. When you also approve "Run tasks", pairs this computer as a device |
| `ensemble logout` | Revokes the key on the server, unpairs the device (it disappears from Settings → Devices), clears local credentials. When the server cannot be reached it still clears this computer and names the key to revoke under Connect your apps |
| `ensemble status [--json]`, `ensemble doctor` | Account, API, sign-in, pairing, runner, folders, model keys, configured editors. `doctor` exits 1 when a check fails and says how to fix it |
| `ensemble folders [list] \| add <path> [--label L] [--read-only] \| remove <label>` | Folders the agent may work in. Only their labels are sent to the server; the assign dialog lists them |
| `ensemble keys [list] \| set <provider> \| remove <provider>` | Model keys for this computer. `list` shows each provider with a key and where it is (this computer, or your account). `set` reads from a hidden prompt or stdin, never from arguments |
| `ensemble runner [start] [--foreground] \| stop \| restart \| status \| logs [-f] \| install \| uninstall` | Run the runner. `install` registers it to start at login: a LaunchAgent (`~/Library/LaunchAgents/com.ensemblework.cli.runner.plist`), a `systemd --user` unit (`ensemble-runner.service`), or a Task Scheduler task (`Ensemble Runner`). Services run `runner start --foreground`, which exits 0 when stopped on purpose, so launchd (`KeepAlive` with `SuccessfulExit` false) and systemd (`Restart=on-failure`) restart it only after a crash; if a runner is already running it waits for that one to stop instead of exiting. `install` stops a runner started by hand so the service takes over. `stop` signals only the process named in the runner's discovery file (`api.json`, which holds port, token and pid) after `/health` answers with that token, never a pid from a stale `runner.pid` |
| `ensemble needs [list] \| answer <n> <allow\|deny\|option number\|"answer">` | Questions and approvals waiting on this computer: a question with its options (the agent's recommended one marked), a push, trusting a folder, a path outside a folder, and the prompts and questions Claude Code, Codex, Copilot and Cursor send through their hooks (with each option's description; several options at once as `1,3` when the tool allows it). Any of them can be answered here; the card on the web closes too (`apps/cli/src/approvals.ts`) |
| `ensemble sandbox [status] \| setup` | This computer's OS sandbox ([24](24_DESKTOP_SANDBOXING.md) v4): Seatbelt on macOS, bubblewrap or Landlock on Linux, the sandbox account on Windows; what it cannot enforce here; and whether internet off is enforced. `setup` turns it on where one step is needed: on Windows it asks for admin permission once (also offered at `ensemble login` on Windows). The desktop app shares it (`apps/cli/src/sandbox.ts`) |
| `ensemble trust [list] \| add [path] \| remove <path> \| share [on\|off]` | Trusted folders on this computer (default: the current folder). `share` shows or sets whether they are also trusted in Claude Code, Codex, GitHub Copilot CLI, Cursor and Gemini CLI (on by default; [doc 24 §5.8](24_DESKTOP_SANDBOXING.md)). Review only and Run unattended need one; Ensemble's own workspace is always trusted. System folders, the home folder and Ensemble's source are refused |
| `ensemble hooks [list] \| connect <tool> \| disconnect <tool>` | Connects Claude Code (and the Claude app), Codex (CLI and the ChatGPT app), GitHub Copilot CLI or Cursor: permission prompts and questions from tasks Ensemble opens in them reach Needs me, while the tool's own prompt still works. The hook signs in with a `hooks` key that can ask but never answer ([30](30_ENGINES.md) §5). |
| `ensemble approvals [status] \| on \| off` | Whether the web and phone may approve for this computer (on by default) and whether the mode, internet and limits chosen there apply here ([25 §5.1](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#51-phone-approvals)) |
| `ensemble browse [status] \| on \| off` | Whether Ensemble on the web shows the files of tasks run here (on by default, 0.3.7): the text of the files a run changed, sent when it ends, and any file or folder in a task's folder, read from here when you open it in the web's Code tab. Never git's own files or secrets files ([25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web-protocol-3-14-oct-2026)) |
| `ensemble web [status] \| files on\|off \| edit on\|off \| terminal on\|off` | What Ensemble on the web may do on this computer (0.3.8, each on by default): `files` is the same switch as `ensemble browse`, and also lets the web's Code tab read code here; `edit` lets it change code (accept or reject an agent's changes, edit files, commit, push, pull); `terminal` lets it open the terminal here after a passkey unlock on the web. The computer checks each on every request ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web-protocol-4-14-oct-2026)) |
| `ensemble mcp` | Read-only MCP server on stdio (editors run this) |
| `ensemble mcp setup [editor…] [--all] [--print] [--hosted]`, `mcp remove <editor>`, `mcp editors` | Write editor config (§6) |
| `ensemble update` | Detects how it was installed (Homebrew, Scoop, winget, deb/rpm, script, npm) and prints the upgrade command. A daily check (2-second timeout; a failed check also waits a day) prints a one-line notice for a newer `cli-v*` release; never for `mcp` or `runner`, or when stderr is not a terminal. `ENSEMBLE_NO_UPDATE_CHECK=1` or `CI` turns it off |

`--api` or `ENSEMBLE_API_URL` changes the server (default `https://api.ensemblework.com`), for example `http://127.0.0.1:4000` against local development.

## 3. Where things live

| What | Location |
|---|---|
| Config | `ENSEMBLE_CONFIG_DIR`, else `%APPDATA%\Ensemble`, else `$XDG_CONFIG_HOME/ensemble` or `~/.config/ensemble`. `config.json` (API, account, device name) and `credentials.json` (mode 0600, the `ens_` key) |
| Data | `ENSEMBLE_DATA_HOME`, else the desktop app's folder, shared with it: macOS `~/Library/Application Support/com.ensemblework.desktop`, Windows `%APPDATA%\com.ensemblework.desktop`, Linux `$XDG_DATA_HOME/com.ensemblework.desktop` or `~/.local/share/com.ensemblework.desktop`. CLI 0.1 used its own folder (`~/Library/Application Support/Ensemble CLI`, `%LOCALAPPDATA%\Ensemble`, `~/.local/share/ensemble`); its database, key and pairing move to the shared folder once, before the first runner starts, unless the app already has a database there (`apps/cli/src/migrate.ts`) |
| Inside data | `pglite/` (local database), `secret.key` (encrypts model keys and the device token), `remote.json` (pairing, shared folders), `api.json` (discovery for the running runtime: port, token, pid, and whether the app or the CLI started it), `runtime.lock`, `logs/runner.log` (rotated at 10 MB), `runner.pid`, `backups/` |
| Workspace | `~/ensemble-workspace` (`ENSEMBLE_WORKSPACE_ROOT` overrides), shared with the app |

## 4. How it works

**Login.** `ensemble login` calls `POST /api/cli/auth/start`, prints a code like `BCDF-GHJK` and opens `https://app.ensemblework.com/link?code=…` (only `https:` URLs, or `http:` on localhost, are passed to the system browser; `apps/cli/src/browser.ts`). The `/link` page (signed in) shows "Ensemble CLI on ‹computer name›", the platform, CLI version, the network address that started the login (with a warning when it differs from the browser's) and the requested access. Approve stays disabled until you tick that you started this login and the code matches your terminal, because someone could send you a link carrying their own code. The CLI polls `POST /api/cli/auth/token` every 5 seconds. On approval the server mints a bridge-scope `ens_` key and, when "Run tasks" was approved (verified email required on the hosted site), a one-time device pairing code. Both are created at that one exchange and never stored raw; device and user codes are stored as SHA-256 hashes and expire after 10 minutes. Routes: `apps/hub-api/src/routes/cli-auth.ts`. The CLI then pairs through the local sidecar (`POST /api/remote/pair`), which registers the device with `POST /api/devices/register`. The key belongs to the Ensemble space that was open when the request was approved, so the CLI and editors read only that space ([28](28_ENSEMBLE_SPACES.md) §2).

**Runner.** `ensemble` starts the runner in the background when none is running (the desktop app's runtime counts), and leaves it running on exit. After an upgrade, a runner an older CLI started (its `api.json` `version` differs) is restarted when the app opens, unless tasks are running or waiting; then it asks the person to finish or stop them and reopen Ensemble. The runtime's PATH is the person's own, however it was started: at start it asks their login shell for its PATH (`$SHELL -ilc`, four seconds at most) and adds the usual install folders (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`, npm, bun, Volta and nvm folders), never a folder inside the workspace (`apps/hub-api/src/desktop/user-path.ts`). Started from a terminal, that terminal's PATH stays first; started by the login service or the desktop app (the system's bare PATH), the login shell's comes first. Before 0.3.4 a runtime started by the login service saw only `/usr/bin:/bin:/usr/sbin:/sbin` and reported Claude Code and Cursor as not installed. The runner is the desktop sidecar (`apps/hub-api/src/desktop/main.ts`) started without the Tauri window: one Node process with hub-api on a random loopback port, PGlite, the worker queue and the remote loop (`apps/hub-api/src/remote/loop.ts`). The loop holds an event stream to the hosted API, claims jobs for this device, runs them with the in-process model runtime and this computer's keys, and reports progress and results ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). When a command needs the local API and the runner is not running (`folders`, `keys`, pairing at login), the CLI starts an admin-only sidecar with `ENSEMBLE_REMOTE_LOOP=off`, `ENSEMBLE_AGENT_QUEUE=off` and `ENSEMBLE_SCHEDULER=off`, so it never claims hosted work, and stops it afterwards.

**One runtime per computer.** The CLI and the desktop app run the same sidecar on the same data folder, so a computer has one database, one pairing, one list of trusted folders and one sandbox, whichever was installed first. A lock file (`runtime.lock`, `apps/hub-api/src/desktop/runtime-lock.ts`) stops a second sidecar from opening the database; it exits with code 75 and the launcher attaches to the one already running. The desktop app attaches to a running CLI runner (and starts its own on the same port and token if that runner stops); a CLI command uses the app's runtime when the app is open. `ensemble runner stop` does not stop the app's runtime, and a runner service waits while the app runs. `ensemble login` keeps the app's pairing when it is for the same server.

**One set of keys.** Signed in and paired, the runtime uses the model keys saved on the Ensemble account (Settings → Models on the web) for providers that have no key on this computer: Ensemble Code, `/model`, `/status`, `ensemble keys list` and tasks run here all see them (13 Oct 2026; before that the CLI asked for every key again). They are read from `GET /api/devices/self/model-keys` with the device token, held in memory only, read again after 10 minutes or on Refresh in Settings, and never written to this computer's database (`apps/hub-api/src/remote/account-keys.ts`). Turning off Settings → Models → *Use these keys on my computers* on the web stops it. A key added here with `/keys` or `ensemble keys set` stays on this computer and wins for its provider. The sidecar keeps its encryption key at `<data>/secret.key` (`ENSEMBLE_SECRET_KEY_FILE`), not in the install folder, so upgrades and read-only system installs keep working. Keys added here go into the local database through `PUT /api/model-keys/:provider` on the sidecar.

**Your AI subscriptions** (CLI 0.3.10, desktop app 0.3.7; 15 Oct 2026). Signed in and paired, the runtime tells Ensemble on the web which of the person's AI subscriptions it can run (Claude Code from the `claude` command or the Claude app, Codex from the `codex` command or the ChatGPT app, Cursor's agent, Copilot CLI), and answers the assistant's turns for a tier set to one of them: the agent runs here with its own sign-in and only Ensemble's tools, which run on the web ([30](30_ENGINES.md) §8, [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) §4.9). The computer must be awake with the runtime running (`ensemble`, the desktop app, or the login service).

**Logout.** `POST /api/cli/logout` revokes the presenting key. The local unpair calls `DELETE /api/devices/self` with the device token, so the computer leaves the account even if the CLI never runs again.

## 5. MCP: local CLI or hosted URL

Both expose the same 17 read-only tools from `apps/context-bridge` (`buildServer` in `src/server.ts`).

- **Local:** `ensemble mcp` runs on stdio and reads `https://api.ensemblework.com/api/bridge/*` with the saved key. It reads the git repository from the editor's working folder for `ensemble_brief`.
- **Hosted:** `POST https://api.ensemblework.com/mcp` with `Authorization: Bearer ens_…`. Streamable HTTP, stateless, JSON responses (`apps/hub-api/src/routes/mcp.ts`). Each tool call goes back through the normal `/api/bridge` routes with the caller's key, so every bridge check applies. Requests without a bearer key (including cookie-only requests) get 401 with `WWW-Authenticate: Bearer realm="Ensemble"`. Device keys get 403. `GET` and `DELETE` return 405. The hosted server never runs git, so `ensemble_brief` needs the repository and branch passed in. Rate limit: `ENSEMBLE_RATE_MCP_LIMIT` per user per `ENSEMBLE_RATE_MCP_WINDOW_SEC` (240 per 60 s).

Keys for the hosted URL come from Connect your apps (`POST /api/connect/token`) or from `ensemble login`. A bridge key can only read `/api/bridge`, call `/mcp`, and revoke itself at `/api/cli/logout`.

Claude Desktop, ChatGPT and claude.ai custom connectors expect OAuth for remote servers; that is not built. Claude Desktop works through the local CLI.

## 6. Editors

`ensemble mcp setup` edits each file with `jsonc-parser` (comments and other servers are kept) and saves a one-time `<file>.ensemble-backup`. Local mode writes the stable absolute launcher path (a Homebrew Cellar path is mapped to `<prefix>/bin/ensemble`, a Scoop version folder to `current`), because GUI apps on macOS do not inherit Homebrew's PATH. `--hosted` writes the URL form instead.

| Editor (`setup` id) | File or command |
|---|---|
| VS Code (`vscode`, `vscode-insiders`) | user `mcp.json`: macOS `~/Library/Application Support/Code/User/`, Windows `%APPDATA%\Code\User\`, Linux `~/.config/Code/User/`; key `servers`. Hosted mode puts the read-only key in this user profile file: a `${input:…}` secret would drop the server from VS Code's Agent Host |
| Cursor (`cursor`) | `~/.cursor/mcp.json`, `mcpServers` |
| Windsurf (`windsurf`) | `~/.codeium/windsurf/mcp_config.json`, `mcpServers` (hosted uses `serverUrl`) |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json` in `~/Library/Application Support/Claude/`, `%APPDATA%\Claude\`, `~/.config/Claude/`. Local only |
| Claude Code (`claude-code`) | `claude mcp add --scope user ensemble -- <ensemble> mcp` (hosted: `--transport http … --header "Authorization: Bearer …"`) |
| Codex CLI and IDE (`codex`) | `~/.codex/config.toml`, `[mcp_servers.ensemble]`; hosted uses `url` + `bearer_token_env_var = "ENSEMBLE_TOKEN"` |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json`, `mcpServers` (hosted uses `httpUrl`) |
| GitHub Copilot CLI (`copilot-cli`) | `~/.copilot/mcp-config.json`, `"type": "local"` / `"http"` |
| Zed (`zed`) | `settings.json` (`~/.config/zed/`, Windows `%APPDATA%\Zed\`), `context_servers` |
| Visual Studio 2022 17.14+ (`visual-studio`) | `%USERPROFILE%\.mcp.json`, `servers` |
| Cline (`cline`) | `cline_mcp_settings.json` in VS Code's `globalStorage/saoudrizwan.claude-dev/settings/` |
| opencode (`opencode`) | `~/.config/opencode/opencode.json`, `mcp` |
| JetBrains IDEs (`jetbrains`), Continue (`continue`) | printed only: JetBrains AI Assistant settings → Model Context Protocol → Add → As JSON; Continue `~/.continue/config.yaml` |

The Hub's Connect your apps page (`apps/hub-web/lib/connect/configs.ts`) generates the same shapes for each editor, method (CLI, hosted URL, from source) and OS.

## 7. Releases

Push a tag `cli-v<version>` matching root `release.json`, or run the `cli-release` workflow by hand (dry run by default). Jobs:

1. **build** on `macos-14`, `macos-15-intel`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-2022`: `scripts/package-cli.mjs --target …`, then `scripts/smoke-cli-package.mjs` (version, an MCP handshake, an admin-only sidecar reaching `/health`).
2. **release**: `.deb`/`.rpm` with nfpm, the npm tarball, `SHA256SUMS.txt`, metadata from `packaging/render.mjs` (Homebrew formula, Scoop manifest, winget manifests, nfpm configs, AUR `PKGBUILD` and `.SRCINFO`), and a GitHub release created with `--latest=false` so the desktop updater's `releases/latest` is never a CLI release. Installers find the newest `cli-v*` release through the GitHub API.
3. **homebrew**, **scoop**: push the formula to `ensemblework/homebrew-tap` and the manifest to `ensemblework/scoop-bucket` with the deploy keys `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY`. The formula states `version` explicitly (from the archive names Homebrew would read "64", from `darwin-arm64`, so before 0.3.3 `brew upgrade` never saw a new release) and `version_scheme 1`, so installs recorded as "64" upgrade; `packaging/render.test.mjs` checks both and runs with the CLI tests.
4. **winget** (only with `WINGET_TOKEN`) and **npm** (only with `NPM_TOKEN`, with provenance).

Everything uses free services: Actions minutes on a public repository, GitHub Releases, and the two public package repositories. Packages declare the repository license, `FSL-1.1-MIT` ([LICENSE.md](../LICENSE.md)), and every archive carries `LICENSE.md`.

Local packaging needs a host matching the target: `pnpm cli:package -- --target darwin-arm64 --out dist/cli` (or `--skip-sidecar` for a fast layout check).

## 8. Limits

- Builds are not code-signed or notarized. Homebrew, Scoop, the scripts and the Linux packages do not mark files as downloaded from the internet; a zip opened from a browser download can ask once.
- Windows needs one admin prompt to turn its sandbox on (`ensemble sandbox setup`); until then a sandboxed task there is refused with that instruction ([24](24_DESKTOP_SANDBOXING.md) v4). `ensemble doctor` checks the sandbox.
- The runner needs the full archive. The npm package (once published) carries only login, status and MCP.
- One runtime per computer, shared with the desktop app (§4).
- Copilot CLI is listed in `/agent` when found but cannot be chosen: it has no per-run permission hook ([30](30_ENGINES.md) §7).
- Ensemble Code reads documents with the Files reader ([32](32_FILES.md)), in a worker with memory and time limits; it does not load other MCP servers. Mouse clicks need a terminal that reports SGR mouse events; the keyboard does everything without them. A terminal narrower than 90 columns hides the sidebar.

## 9. Verified

Checked 6 Oct 2026 on macOS (Apple Silicon) against a local hub-api and Hub with an isolated database: `ensemble login` through the `/link` page (including a brand-new account), pairing, `folders add`, `runner start`, a code task assigned from the hosted API to this computer finishing with the `mock` model, local `ensemble mcp` and hosted `/mcp` with the MCP SDK client (17 tools, the account's own task returned), a 401 without a key, `mcp setup --all` in a sandbox home (comments and other servers kept, Homebrew path mapped), `runner stop`, `logout` (key rejected afterwards, device removed). The darwin-arm64 archive was built and smoke-tested, and `install.sh` was run in a sandbox. Automated: `apps/hub-api` `src/routes/cli-auth.integration.test.ts` and `src/routes/mcp.integration.test.ts`, `apps/cli` tests, `packaging/render.test.mjs`.

Released and checked 6 Oct 2026: `cli-v0.1.0` was built by `cli-release.yml` for all five targets (each archive smoke-tested on its own runner, Windows included), and the workflow pushed the formula to `ensemblework/homebrew-tap` and the manifest to `ensemblework/scoop-bucket`. On this Mac, `brew install ensemblework/tap/ensemble` and `curl -fsSL https://ensemblework.com/install.sh | sh` both installed 0.1.0. Against production, `ensemble login` through `app.ensemblework.com/link` paired the Mac, hosted `/mcp` and local `ensemble mcp` both returned the account's Today data (17 tools), and the runner reported online with a fresh heartbeat. The arm64 `.deb` and `.rpm` were installed on Ubuntu 22.04 and Fedora 41 in containers, where `runner start`, `status` and `stop` worked and removal was clean.

Not run yet: `install.ps1` and Scoop on a real Windows machine (Windows PowerShell 5.1 included), the x64 Linux packages on real hardware, `runner install` against the real service managers (the generated plist passed `plutil -lint`), a task executed end to end on a production-paired computer with a real model key, and real editors other than the MCP SDK client.

## Shared identity and motion

The terminal identity is `[e] Ensemble` with Satin Gold accents. The status row uses a four-cell braille infinity while a chat or task is running (`apps/cli/src/tui/brand.tsx`, `packages/brand/cli.js`), at 8 fps without rerendering the whole React app. Idle has no timer. Redirected output and `TERM=dumb` use a still ASCII marker; `NO_COLOR` suppresses brand color; truecolor terminals use `#D7B56F`, others ANSI yellow. Set `ENSEMBLE_REDUCE_MOTION=1` to keep the marker still. Errors, queued work and human decisions retain explicit text.

## Connection lifetime and automatic editor setup (16 Oct 2026)

Code inspection: `ensemble logout` revokes the CLI key and unpairs the local runtime. `ensemble runner uninstall` also signs out before removing the service. A packaged CLI passes its launcher path as `ENSEMBLE_INSTALL_PATH`; a surviving runtime detects removal on its next remote heartbeat and stops/forgets remote access.

When Ensemble hands a task to an installed editor, `workspace/editor-hooks.ts` creates a scoped hook token if needed and installs the hook before opening that task. VS Code receives its project hook automatically. Settings does not ask people to run hook setup commands. Only the handoff’s marker or already linked session sends questions to Needs me; other editor sessions, including those in the same folder, stay in that editor.

## Release version and updates

Root `release.json` is the canonical version. `scripts/release-version.mjs --sync` updates package manifests, native configs/locks and `shared-types/src/version.ts`; build/typecheck checks reject drift. The CLI build defines its version from that file, and the unbundled fallback imports the shared constant. `ensemble --version` and the app’s Status show it.

The app checks published CLI releases daily, independently of desktop tags, and offers **Update Ensemble** in its command picker. `ensemble update` runs the same installer action. Homebrew and Scoop installs use their own managers; script installs run the bundled installer, which downloads and verifies the release checksum. npm-only, unknown, winget or Linux system-package installs open Downloads for the appropriate installer rather than showing terminal instructions. Homebrew failures may show `brew upgrade ensemble`. Active jobs prevent updating; installation keeps data and asks the person to reopen the CLI. A desktop-owned runtime is not stopped by a CLI update.

The 0.4.0 release is published through the existing five-platform CLI workflow, Homebrew tap and Scoop bucket. npm and winget publication remain conditional on their configured release credentials/acceptance; the download guide does not advertise unavailable channels. No claim is made that installing a new CLI replaces an already-installed native app.
