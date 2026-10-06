# 26 · Ensemble CLI: run tasks on your computer, connect editors over MCP

The `ensemble` command gives a computer two things without the desktop app:

1. **A runner.** Tasks you assign to this computer from [app.ensemblework.com](https://app.ensemblework.com) run here, in folders you share, with model keys that stay here.
2. **MCP for editors.** `ensemble mcp` is a read-only MCP server that reads your hosted Ensemble context. Editors start it themselves.

People who only want editor context can skip installing anything and use the **hosted MCP URL** instead (§5).

Code: `apps/cli` (npm name `ensemblework`, command `ensemble`). Packaging: `scripts/package-cli.mjs`, `packaging/`, `.github/workflows/cli-release.yml`. Install scripts: `apps/landing/public/install.sh` and `install.ps1`, served at `https://ensemblework.com/install.sh` and `/install.ps1`. User guide: [ensemblework.com/download](https://ensemblework.com/download), and in the Hub under Connect your apps and Settings → Devices.

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

## 2. Commands

| Command | What it does |
|---|---|
| `ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]` | Device login (§4). Saves a read-only key. When you also approve "Run tasks", pairs this computer as a device |
| `ensemble logout` | Revokes the key on the server, unpairs the device (it disappears from Settings → Devices), clears local credentials. When the server cannot be reached it still clears this computer and names the key to revoke under Connect your apps |
| `ensemble status [--json]`, `ensemble doctor` | Account, API, sign-in, pairing, runner, folders, model keys, configured editors. `doctor` exits 1 when a check fails and says how to fix it |
| `ensemble folders [list] \| add <path> [--label L] [--read-only] \| remove <label>` | Folders the agent may work in. Only their labels are sent to the server; the assign dialog lists them |
| `ensemble keys [list] \| set <provider> \| remove <provider>` | Model keys for tasks on this computer. Read from a hidden prompt or stdin, never from arguments |
| `ensemble runner [start] [--foreground] \| stop \| restart \| status \| logs [-f] \| install \| uninstall` | Run the runner. `install` registers it to start at login: a LaunchAgent (`~/Library/LaunchAgents/com.ensemblework.cli.runner.plist`), a `systemd --user` unit (`ensemble-runner.service`), or a Task Scheduler task (`Ensemble Runner`). Services run `runner start --foreground`, which exits 0 when stopped on purpose, so launchd (`KeepAlive` with `SuccessfulExit` false) and systemd (`Restart=on-failure`) restart it only after a crash; if a runner is already running it waits for that one to stop instead of exiting. `install` stops a runner started by hand so the service takes over. `stop` signals only the process named in the runner's discovery file (`api.json`, which holds port, token and pid) after `/health` answers with that token, never a pid from a stale `runner.pid` |
| `ensemble mcp` | Read-only MCP server on stdio (editors run this) |
| `ensemble mcp setup [editor…] [--all] [--print] [--hosted]`, `mcp remove <editor>`, `mcp editors` | Write editor config (§6) |
| `ensemble update` | Detects how it was installed (Homebrew, Scoop, winget, deb/rpm, script, npm) and runs or prints the upgrade. A daily check (2-second timeout; a failed check also waits a day) prints a one-line notice for a newer `cli-v*` release; never for `mcp` or `runner`, or when stderr is not a terminal. `ENSEMBLE_NO_UPDATE_CHECK=1` or `CI` turns it off |

`--api` or `ENSEMBLE_API_URL` changes the server (default `https://api.ensemblework.com`), for example `http://127.0.0.1:4000` against local development.

## 3. Where things live

| What | Location |
|---|---|
| Config | `ENSEMBLE_CONFIG_DIR`, else `%APPDATA%\Ensemble`, else `$XDG_CONFIG_HOME/ensemble` or `~/.config/ensemble`. `config.json` (API, account, device name) and `credentials.json` (mode 0600, the `ens_` key) |
| Data | `ENSEMBLE_DATA_HOME`, else `%LOCALAPPDATA%\Ensemble`, macOS `~/Library/Application Support/Ensemble CLI`, else `$XDG_DATA_HOME/ensemble` or `~/.local/share/ensemble` |
| Inside data | `pglite/` (local database), `secret.key` (encrypts model keys and the device token), `remote.json` (pairing, shared folders), `api.json` (discovery for the running runner), `logs/runner.log` (rotated at 10 MB), `runner.pid`, `backups/` |

## 4. How it works

**Login.** `ensemble login` calls `POST /api/cli/auth/start`, prints a code like `BCDF-GHJK` and opens `https://app.ensemblework.com/link?code=…` (only `https:` URLs, or `http:` on localhost, are passed to the system browser; `apps/cli/src/browser.ts`). The `/link` page (signed in) shows "Ensemble CLI on ‹computer name›", the platform, CLI version, the network address that started the login (with a warning when it differs from the browser's) and the requested access. Approve stays disabled until you tick that you started this login and the code matches your terminal, because someone could send you a link carrying their own code. The CLI polls `POST /api/cli/auth/token` every 5 seconds. On approval the server mints a bridge-scope `ens_` key and, when "Run tasks" was approved (verified email required on the hosted site), a one-time device pairing code. Both are created at that one exchange and never stored raw; device and user codes are stored as SHA-256 hashes and expire after 10 minutes. Routes: `apps/hub-api/src/routes/cli-auth.ts`. The CLI then pairs through the local sidecar (`POST /api/remote/pair`), which registers the device with `POST /api/devices/register`.

**Runner.** The runner is the desktop sidecar (`apps/hub-api/src/desktop/main.ts`) started without the Tauri window: one Node process with hub-api on a random loopback port, PGlite, the worker queue and the remote loop (`apps/hub-api/src/remote/loop.ts`). The loop holds an event stream to the hosted API, claims jobs for this device, runs them with the in-process model runtime and this computer's keys, and reports progress and results ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). When a command needs the local API and the runner is not running (`folders`, `keys`, pairing at login), the CLI starts an admin-only sidecar with `ENSEMBLE_REMOTE_LOOP=off`, `ENSEMBLE_AGENT_QUEUE=off` and `ENSEMBLE_SCHEDULER=off`, so it never claims hosted work, and stops it afterwards.

**Keys stay local.** The sidecar keeps its encryption key at `<data>/secret.key` (`ENSEMBLE_SECRET_KEY_FILE`), not in the install folder, so upgrades and read-only system installs keep working. Model keys go into the local database through `PUT /api/model-keys/:provider` on the sidecar.

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

Push a tag `cli-v<version>` matching `apps/cli/package.json`, or run the `cli-release` workflow by hand (dry run by default). Jobs:

1. **build** on `macos-14`, `macos-15-intel`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-2022`: `scripts/package-cli.mjs --target …`, then `scripts/smoke-cli-package.mjs` (version, an MCP handshake, an admin-only sidecar reaching `/health`).
2. **release**: `.deb`/`.rpm` with nfpm, the npm tarball, `SHA256SUMS.txt`, metadata from `packaging/render.mjs` (Homebrew formula, Scoop manifest, winget manifests, nfpm configs, AUR `PKGBUILD` and `.SRCINFO`), and a GitHub release created with `--latest=false` so the desktop updater's `releases/latest` is never a CLI release. Installers find the newest `cli-v*` release through the GitHub API.
3. **homebrew**, **scoop**: push the formula to `ensemblework/homebrew-tap` and the manifest to `ensemblework/scoop-bucket` with the deploy keys `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY`.
4. **winget** (only with `WINGET_TOKEN`) and **npm** (only with `NPM_TOKEN`, with provenance).

Everything uses free services: Actions minutes on a public repository, GitHub Releases, and the two public package repositories. Packages declare the repository license, `FSL-1.1-MIT` ([LICENSE.md](../LICENSE.md)), and every archive carries `LICENSE.md`.

Local packaging needs a host matching the target: `pnpm cli:package -- --target darwin-arm64 --out dist/cli` (or `--skip-sidecar` for a fast layout check).

## 8. Limits

- Builds are not code-signed or notarized. Homebrew, Scoop, the scripts and the Linux packages do not mark files as downloaded from the internet; a zip opened from a browser download can ask once.
- Windows has no OS sandbox for agent commands ([24](24_DESKTOP_SANDBOXING.md)); `ensemble doctor` reports the sandbox strength the runner advertises.
- The runner needs the full archive. The npm package (once published) carries only login, status and MCP.
- One runner per data folder. A desktop app on the same computer is a separate device.

## 9. Verified

Checked 6 Oct 2026 on macOS (Apple Silicon) against a local hub-api and Hub with an isolated database: `ensemble login` through the `/link` page (including a brand-new account), pairing, `folders add`, `runner start`, a code task assigned from the hosted API to this computer finishing with the `mock` model, local `ensemble mcp` and hosted `/mcp` with the MCP SDK client (17 tools, the account's own task returned), a 401 without a key, `mcp setup --all` in a sandbox home (comments and other servers kept, Homebrew path mapped), `runner stop`, `logout` (key rejected afterwards, device removed). The darwin-arm64 archive was built and smoke-tested, and `install.sh` was run in a sandbox. Automated: `apps/hub-api` `src/routes/cli-auth.integration.test.ts` and `src/routes/mcp.integration.test.ts`, `apps/cli` tests, `packaging/render.test.mjs`.

Released and checked 6 Oct 2026: `cli-v0.1.0` was built by `cli-release.yml` for all five targets (each archive smoke-tested on its own runner, Windows included), and the workflow pushed the formula to `ensemblework/homebrew-tap` and the manifest to `ensemblework/scoop-bucket`. On this Mac, `brew install ensemblework/tap/ensemble` and `curl -fsSL https://ensemblework.com/install.sh | sh` both installed 0.1.0. Against production, `ensemble login` through `app.ensemblework.com/link` paired the Mac, hosted `/mcp` and local `ensemble mcp` both returned the account's Today data (17 tools), and the runner reported online with a fresh heartbeat. The arm64 `.deb` and `.rpm` were installed on Ubuntu 22.04 and Fedora 41 in containers, where `runner start`, `status` and `stop` worked and removal was clean.

Not run yet: `install.ps1` and Scoop on a real Windows machine (Windows PowerShell 5.1 included), the x64 Linux packages on real hardware, `runner install` against the real service managers (the generated plist passed `plutil -lint`), a task executed end to end on a production-paired computer with a real model key, and real editors other than the MCP SDK client.
