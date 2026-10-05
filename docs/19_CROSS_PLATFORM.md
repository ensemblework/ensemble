# 19 · Cross-platform readiness

Checked 2026-09-29 against `main` (`8e8a89c`) and `mcp` (`cc16434`).

`main` is the Hub: the website, the API, and the Python model helper. `mcp` is that, plus the read-only Context Bridge and the Connect your apps page. Findings below say which branch they come from. The evidence is the code, not the older design docs in this folder. Both branches have since been merged into `main`.

## In plain language

Ensemble is built as a program that runs on your own computer. Almost all of the day-to-day work has been on a Mac. The website and the API are ordinary Node programs and can run on other systems. The parts that start the Python helper, pick a folder, lock the terminal, and keep an agent inside one folder were written for macOS.

On a Linux machine we installed dependencies, compiled the site and the API, started the Python helper, and ran the Context Bridge live test. Those succeeded. A few Mac-only features stay off, and the one-line “start everything” command fails on a clean checkout because a tool named Turbo is used and not installed with the project.

Windows was not booted here. From the scripts and path checks in the source, a Windows checkout will not get through the documented start steps. The website is likely to compile. The Python helper’s start script, the folder safety checks, and the command runner will not behave as they do on a Mac.

There is no automated build that runs the project on Ubuntu, Windows, and macOS. Nothing in the repo proves a pull request still works off a Mac.

## Status by operating system

| | macOS | Linux | Windows |
|---|---|---|---|
| Verdict | Likely works | Likely works | Broken for a normal setup |
| How sure | Inferred. Not run in this session. This is the system the code targets. | Verified on one x86_64 Ubuntu VM for install, compile, Python tests, and the Context Bridge live test. | Inferred from code. Not executed. |
| Everyday Hub (site, API, Postgres, Redis) | Expected to run with Node 22, pnpm 12, and Docker Desktop. | Ran, after extra packages. See the log below. | Likely to compile. Docker Desktop and a manual database start are assumed, not proven. |
| Python model helper | Expected to run. The start script is bash and looks for Homebrew Python. | Ran. Creating the virtualenv failed until the Ubuntu `python3.12-venv` package was installed. | The start script always calls `bash` and `.venv/bin/python`. Windows puts that interpreter in `.venv\Scripts\python.exe`. |
| Agent working in a folder, terminal, sandbox | The sandbox, the folder dialog, and Touch ID are implemented. | Sandbox and folder dialog are refused. The terminal asks for a platform passkey and then runs commands with no sandbox. | Same refusals as Linux, and the path checks do not understand drive letters, `~\`, or Windows system folders. |
| Connect your apps (`mcp` only) | Paths and shell snippets exist. Not clicked through in a real editor here. | Config tests passed. Live bridge test: 146 checks, 0 failures. | The page has Windows paths and PowerShell snippets. Editor launch still uses the command name `node`, which GUI apps often cannot find. |

“Likely works” on Linux means the product code we executed did run. It does not mean a new Linux machine can follow the README and be done. `pnpm dev`, `pnpm build`, and `pnpm typecheck` failed immediately because `turbo` is not on the path.

## What was actually run (Linux)

Host: Linux 6.12, x86_64, Node v22.14.0, pnpm 12.6.0 (Corepack; the image’s preinstalled pnpm was 10.33.3), Python 3.12.3. Docker was not installed at the start. `systemd` is not running in this VM, so the Docker daemon was started by hand.

### `main`

| Command | Result |
|---|---|
| `pnpm install` | Succeeded. 425 packages. Prisma, esbuild, sharp, and Next’s Linux binary downloaded. Prisma’s postinstall warned that the schema is not in the default folder; `pnpm db:generate` fixed that. |
| `pnpm typecheck` and `pnpm build` | Failed, exit 127: `sh: 1: turbo: not found`. Turbo is not a dependency in `package.json` or `pnpm-lock.yaml`. |
| `pnpm db:generate` | Succeeded. Prisma Client 6.19.3. Engines on disk: `libquery_engine-debian-openssl-3.0.x.so.node` and `schema-engine-debian-openssl-3.0.x`. |
| `pnpm --filter @ensemble/shared-types typecheck` | Passed. |
| `pnpm --filter @ensemble/hub-api typecheck` and `build` | Passed. |
| `pnpm --filter @ensemble/hub-web typecheck` | Passed. |
| `pnpm --filter @ensemble/hub-web build` | Passed. Next.js 15.5.26, 20 routes generated. |
| `bash scripts/doctor.sh` | Node 22 and pnpm passed. Docker daemon failed (`docker info` as this user cannot open the socket). Docker Compose failed before the Compose plugin was installed, then passed. `.env` failed because it had not been copied. Final score after the plugin install: 3 passed, 2 failed, exit 2. |
| `python3 -m venv apps/agent-runtime/.venv` | Failed: `ensurepip is not available` until `python3.12-venv` was installed. After that, `pip install -e .` succeeded. |
| Imports and `pytest` | `fastapi` 0.141.1 and `psycopg` 3.3.6 imported. `pytest` on `apps/agent-runtime/tests`: 10 passed. |
| `python -m ensemble_agent.main` | `GET http://127.0.0.1:5055/health` returned `{"ok":true,"service":"agent-runtime"}`. |

`main` has no unit-test script for the TypeScript apps. The Context Bridge on `main` is a stub that prints a message (`apps/context-bridge/src/index.ts`).

### `mcp` (detached worktree of `origin/mcp` at `cc16434`, not the `mcp` branch itself)

| Command | Result |
|---|---|
| `pnpm install` and `pnpm db:generate` | Succeeded. |
| `pnpm --filter @ensemble/hub-api typecheck` | Passed (`tsc --noEmit -p tsconfig.test.json`). |
| `pnpm --filter @ensemble/hub-api test:bridge` | 13 passed. The script passes the glob `src/bridge/**/*.test.ts` through the shell; Node expanded it. |
| `pnpm --filter @ensemble/context-bridge verify` | Typecheck passed, 9 tests passed, build passed. Smoke: “MCP smoke OK: 13 tools over stdio, streamable HTTP, 10 resources.” |
| `pnpm --filter @ensemble/hub-web typecheck` | Passed. |
| `pnpm --filter @ensemble/hub-web test` | 7 passed (Connect config and guide tests). |
| `pnpm bridge:e2e`, first attempt | Failed. `docker.io` on Ubuntu does not include the Compose plugin. `docker compose` was an unknown command, and the script’s `sudo docker compose -f …` failed with “unknown shorthand flag: 'f'”. |
| `pnpm bridge:e2e`, after `docker-compose-v2` | Report `bridge-e2e-report.json`: `"pass": true`, 146 passed, 0 failed. Postgres listened on `127.0.0.1:5432` and `[::1]:5432`. Redis the same on 6379. hub-api on `127.0.0.1:4000` only. HTTP bridge on `127.0.0.1:4010` only. `localhost` reached Postgres. Non-loopback addresses were refused. One friction note: this user is not in the `docker` group, so the script used `sudo`. |
| Process after the pass line | Still running more than 7 minutes later. `main()` writes the report and does not call `process.exit`. The hub-api and HTTP bridge children are left up, and their pipes keep the script alive. A CI job would hit its timeout on a green run. |

`iproute2` (`ss`, `ip`) was also missing until installed. The live test’s bind checks call `ss` and, on Linux, `ip`. macOS and Windows do not ship `ss`.

Not done: a browser pass of the Hub, a real editor connecting over MCP, any Windows machine, any Mac.

## Issues, in the order to fix them

Both branches, unless a row says `mcp` only. Suggested fixes are not implemented.

### 1. The Python helper’s start script is bash and a Unix virtualenv

`package.json` (`dev:agent`), `apps/agent-runtime/package.json` (`dev`), `scripts/agent-dev.sh`.

The script requires bash, looks for Homebrew and Miniconda, creates `.venv`, and always runs `.venv/bin/pip` and `.venv/bin/python`. On Windows, `python -m venv` creates `.venv\Scripts\python.exe`. There is no `.ps1` or `.cmd` equivalent.

On this Ubuntu image, bash was fine and `.venv/bin/python` worked, but only after `python3.12-venv` was installed. A stock `python3` without the `venv` package fails exactly where the script calls `python3 -m venv`.

Suggested fix: one small Node script, used by both package.json scripts, that finds Python 3.11+, runs `python -m venv`, and executes `path.join(venv, process.platform === "win32" ? "Scripts" : "bin", "python")`. On Debian/Ubuntu, tell the person to install `python3-venv` when `ensurepip` is missing.

### 2. Code tasks default to a sandbox that exists only on macOS

`apps/hub-api/src/workspace/guard.ts` (`sandboxAvailable`), `apps/hub-api/src/workspace/runner.ts`, `apps/hub-api/src/routes/agents.ts`, `apps/hub-web/components/agent/assign-dialog.tsx`.

`sandboxAvailable` is `process.platform === "darwin"`. Assigning a code task with the sandbox on (the dialog’s initial state is on) throws “The sandbox needs macOS.” Seatbelt profiles and `/usr/bin/sandbox-exec` are Mac-only. Off macOS the only supported mode is “this machine,” which runs the command with no extra jail.

The UI still says commands run in the macOS sandbox (`apps/hub-web/components/code/terminal.tsx`, `components/settings/sections.tsx`). On Linux and Windows the terminal sets `sandboxed: process.platform === "darwin"`, so the profile is skipped, while `checkProgram` is still called as if the sandbox were on.

Suggested fix: when the platform is not `darwin`, start the assign dialog with the sandbox off, and say that commands run directly on this computer. Keep the allow-list. A later Linux jail would be bubblewrap or a container, not Seatbelt.

### 3. Commands the agent runs get a Unix PATH, including on Windows

`apps/hub-api/src/workspace/guard.ts` (`childEnv`), `apps/hub-api/src/workspace/runner.ts` (`findProgram`).

`childEnv` builds `PATH` with `:` and a fixed list: the Node directory, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `~/.local/bin`, Miniconda, Anaconda. `findProgram` splits that string on `:`. The miss error says “not installed on this Mac.”

On Linux and macOS those directories are real, so lookup works. On Windows the delimiter is `;`, program names need `PATHEXT` (`.exe`, `.cmd`), and `C:\…` split on `:` breaks the drive letter. `hostExecutable` in `apps/hub-api/src/workspace/policy.ts` does use `path.delimiter` and appends `.exe`. The runner does not use that for the first lookup, and the child still inherits the colon `PATH`.

`gitHardening` points hooks at `/dev/null` and, for agents, sets `GIT_ASKPASS` to `/usr/bin/false`. Git for Windows often accepts `/dev/null`. `/usr/bin/false` will not be there.

Suggested fix: build the child `PATH` with `path.delimiter`, keep only absolute entries that exist and sit outside the work folder, and look up `name` plus `PATHEXT` on Windows. Point askpass at a tiny local script, or omit it when the file does not exist.

### 4. The folder jail knows about `/Users` and `~/Library`, not `C:\` or `/home`

`apps/hub-api/src/workspace/guard.ts` (`blockedReason`, `resolveWorkFolder`), `apps/hub-api/src/routes/agents.ts` (`/api/workspace/pick-folder`).

The picker runs `/usr/bin/osascript` and returns 400 on anything else (“Type the folder path instead.”). Typed paths must be absolute. `~` is expanded only when the next character is `/` or the end of the string, so `~\Projects` on Windows stays unexpanded. The error text says the path must start with `/` or `~`, which is wrong for `D:\work`.

Blocked locations are `/System`, `/usr`, `/Users`, `~/Library`, `~/Desktop`, and similar. On Linux, `/usr` and `/etc` are covered. `/home/someone-else` is not, because the “another account” check compares `dirname` to `/Users`. On Windows, `C:\Windows`, `C:\Program Files`, and `AppData` are not in the list. `policy.ts` normalizes `\` to `/` for one helper; `blockedReason` does not.

Suggested fix: branch the blocked list on `process.platform`. On Windows, refuse `process.env.SystemRoot`, Program Files, and the user’s AppData. On Linux, refuse `/home` itself and other users’ homes. Expand both `~/` and `~\`. Accept `path.win32.isAbsolute` paths in the error message.

### 5. `mcp`: editor configs say `node`, and the key is a shell variable GUI apps never see

`apps/hub-api/src/routes/connect.ts`, `apps/hub-web/lib/connect/configs.ts`, `apps/hub-web/components/connect/guide.tsx`, `apps/context-bridge/clients/*.json`, `.vscode/mcp.json`, `.mcp.json`.

The API already returns `node: process.execPath` and a `platform` of `darwin` | `win32` | `linux`. The page uses the platform for tabs (Mac / Windows / Linux) and fills absolute paths with `path.join`, which is correct per OS. Generated configs still set `"command": "node"`. `facts.node` is stored and never read.

That avoids the usual `npx` problem (`npx.cmd` on Windows has to be launched as `cmd /c npx`). It does not fix GUI apps. Claude Desktop, Cursor, and VS Code started from the dock or the Start menu do not inherit a terminal `PATH` or a one-shot `export` / `$env:`. The Connect page tells people to paste `export ENSEMBLE_BRIDGE_TOKEN=…` (PowerShell `$env:…`, plus a Command Prompt `set` line) and leave that window open. VS Code’s config then references `${env:ENSEMBLE_BRIDGE_TOKEN}`, so the key has to be in VS Code’s own environment.

Paths the page does get right (`configs.ts`):

| App | macOS and Linux | Windows |
|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac), `~/.config/Claude/claude_desktop_config.json` (Linux) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Codex | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| Copilot CLI | `~/.copilot/mcp-config.json` | `%USERPROFILE%\.copilot\mcp-config.json` |
| Cline CLI | `~/.cline/mcp.json` | `%USERPROFILE%\.cline\mcp.json` |
| Cursor | `~/.cursor/mcp.json` and the repo `.cursor/mcp.json` | The guide text also names `%USERPROFILE%\.cursor\mcp.json` |
| VS Code | Repo `.vscode/mcp.json` (`${workspaceFolder}/…`). User file via the command palette, which is the right cross-platform step. | Same |
| Claude Code | Repo `.mcp.json` (`${CLAUDE_PROJECT_DIR}/…`) or `claude mcp add` | The Windows command is one line, without `\` continuations |
| Zed, JetBrains, Continue | In-app settings or `.continue/mcpServers/ensemble.yaml` | No separate path function; the in-app steps are OS-neutral |

`docs/CONTEXT_BRIDGE.md` on `mcp` lists the three Claude Desktop paths. Its sample shell blocks are bash (`export`, `"$PWD"`). The Connect page is ahead of that doc for Windows.

Hook install on both branches (`scripts/ensemble-hook.mjs`, Settings → Editors & agents) writes `~/.cursor/hooks.json`, `~/.claude/settings.json`, or `<project>/.github/hooks/ensemble.json` via `homedir()`, which is correct. The command it asks you to paste quotes `process.execPath`. In PowerShell, a quoted exe path does not run unless it is prefixed with `&`.

Suggested fix: set `command` to `facts.node` (the absolute `node.exe` on Windows). For apps that only read `${env:…}`, say how to set a user environment variable, and warn that a terminal `export` does not reach an app opened from the desktop. For the hook line, emit a PowerShell call operator when `platform` is `win32`.

### 6. `pnpm dev` / `build` / `typecheck` call Turbo, and Turbo is not installed

Root `package.json`, `turbo.json`. Confirmed on this machine: exit 127. `docs/UI_PERF_DESIGN.md` already says to use `pnpm dev:api`, `dev:web`, and `dev:agent` instead. `docs/18_WHAT_IS_REAL.md` still says `pnpm dev` starts the API, the site, and the model helper.

Suggested fix: add `turbo` to the root devDependencies and invoke it with `pnpm exec turbo`, so a clean clone does not depend on a global binary.

### 7. There is no CI on either branch

`git ls-files` shows no `.github/workflows` on `main` or `mcp`. `mcp` only adds `.github/agents/ensemble.md` and `.github/skills/ensemble-context/SKILL.md`. No `.gitattributes` either. Tracked filenames do not collide under case-folding (checked with a lowercased `git ls-files` pass). Shell scripts in the tree are LF today (`file` reports ASCII text, not CRLF).

A Windows Git install with `core.autocrlf=true` can rewrite `scripts/*.sh` to CRLF. Bash then fails on `set -euo pipefail\r`. The Code tab’s git wrapper (`apps/hub-api/src/lib/git.ts`) does not set `core.autocrlf`; it uses whatever git it finds.

Suggested fix: a `.gitattributes` with `* text=auto eol=lf` for `*.sh`, `*.mjs`, `*.yml`, and `*.json`. And the matrix in the next section.

### 8. `mcp` live test and Compose are Linux-shaped; loopback binds did work here

`apps/context-bridge/scripts/live-e2e.ts`, `infra/docker-compose.yml`.

On `main`, Postgres and Redis publish `5432:5432` and `6379:6379` (every interface), and hub-api listens on `0.0.0.0` (`apps/hub-api/src/index.ts`). `HUB_API_HOST` in config is unused by that listen call.

On `mcp`, hub-api defaults to `127.0.0.1`, and Compose publishes `127.0.0.1` and `[::1]` for 5432 and 6379. That combination worked on Docker 29 in this VM: Prisma’s `localhost:5432` connected, and `ss` showed both addresses. The named volume `ensemble_pg` is `external: true`. The live test creates it. A person who only runs `pnpm infra:up` gets a Compose error until `docker volume create ensemble_pg`.

The live test also assumes `sudo`, `ss`, and `ip`, writes logs to `/tmp/ensemble-bridge-e2e`, and does not exit after success (verified). Ubuntu’s `docker.io` package did not provide `docker compose` until `docker-compose-v2` was installed. Docker Desktop on a Mac includes the plugin. A minimal Linux server often does not.

`[::1]` port publishing is a known sore point on Docker Desktop and Colima (Mac and Windows). If that mapping fails, the whole `up` fails, including the IPv4 mapping. Compose now publishes `127.0.0.1` only, and `DATABASE_URL` / `REDIS_URL` use that address so a `localhost` → `::1` lookup cannot miss the database.

Still open from this note: make `bridge:e2e` call `process.exit` after the report, and read listeners with Node’s `net` or a Windows-friendly command when `ss` is absent. Install the Compose v2 plugin, and create `ensemble_pg` before `pnpm infra:up`.

### 9. Terminal unlock is written as Touch ID

`apps/hub-api/src/routes/terminal.ts`, `apps/hub-web/components/code/terminal.tsx`.

Registration uses a platform passkey (WebAuthn). That can be Touch ID, Windows Hello, or nothing. The buttons and errors say “Touch ID” even when `navigator.platform` is not Mac (one label uses “This device”). The route also refuses any origin whose host is not `localhost`, which is correct for passkeys and is the same on every OS. Many Linux desktops have no platform authenticator, so the Code tab terminal cannot be unlocked there. That was not exercised in a browser.

Suggested fix: say “this device” (Windows Hello, Touch ID, or a passkey) in the buttons. If the browser reports no platform authenticator, say so instead of offering a button that cannot succeed.

### 10. `doctor.sh` only makes sense on a Mac with Homebrew

`scripts/doctor.sh`, root script `doctor`.

It is bash, forces `/opt/homebrew/opt/node@22/bin` onto `PATH`, and checks `docker info` with no `sudo` fallback. On this machine, with Docker running and the Compose plugin installed, the daemon check still failed on socket permissions and the Compose check passed.

Suggested fix: a Node doctor that checks `node`, `pnpm`, `python3` ≥ 3.11, `docker info` (and says “add your user to the docker group” on EACCES), and `docker compose version`.

### Smaller notes

- Shortcut labels already use Ctrl off Apple platforms (`apps/hub-web/lib/platform.ts`). That part is fine.
- `gh auth token` (`apps/hub-api/src/connectors/accounts.ts`) is a cross-platform CLI call. It fails closed when `gh` is missing. Fine.
- Prisma has no `binaryTargets`. Generate downloads the engine for the machine you are on. Copying `node_modules` from a Mac to Windows will not work. Run `pnpm db:generate` on each OS. Verified here: Debian OpenSSL 3 engines.
- `psycopg[binary]` and `cryptography` installed from wheels on this Linux and imported. Wheels for Windows and macOS were not installed here.
- `pnpm-lock.yaml` already lists optional win32, darwin, and linux builds for pnpm, esbuild, sharp, and Next’s SWC. `pnpm install` on this machine selected the linux-x64 ones.
- Stopping a command uses `process.kill(-pid)` (`runner.ts`). That is a process group. On Windows the negative pid fails and the code falls back to killing only the parent, so grandchild test runners can survive. Inferred.
- `chmod 0o600` on `.ensemble/secret.key` and the hook config works on Linux and macOS. On Windows, Node’s chmod does not apply an ACL. The file is still created.
- `apps/hub-api/package.json` on `mcp` has two `"typecheck"` keys. JSON keeps the second (`tsconfig.test.json`). That second command passed. Worth cleaning up so a Windows JSON tool and a Mac one cannot disagree, but it is not an OS bug by itself.

## A testing plan

Add one GitHub Actions workflow. Three jobs, `ubuntu-latest`, `windows-latest`, `macos-latest`, Node 22, Corepack pnpm 12.6.0.

On every OS:

1. `pnpm install`
2. `pnpm db:generate` (proves the Prisma engine for that OS)
3. `pnpm exec turbo typecheck` once Turbo is a dependency; until then, `tsc` in `@ensemble/shared-types`, `@ensemble/hub-api`, and `@ensemble/hub-web`
4. `pnpm --filter @ensemble/hub-web build`
5. On `mcp`: `pnpm --filter @ensemble/hub-api test:bridge`, `pnpm --filter @ensemble/context-bridge verify`, `pnpm --filter @ensemble/hub-web test`
6. Python: create the venv the way the start script should, `pip install -e .` and `pytest` in `apps/agent-runtime`. On Windows the interpreter path under test is `.venv\Scripts\python.exe`.

Ubuntu only, after the live script exits on its own:

7. Install the Compose plugin if the runner image does not have it.
8. `pnpm bridge:e2e`
9. Fail the job if the process is still alive a minute after the report is written.

Do not run `osascript` or Touch ID in CI. On macOS, a follow-up job can assert `sandboxAvailable === true` with a one-line Node process. On Windows, a unit test can point `resolveWorkFolder` at a temp directory on the runner and assert a `C:\Windows` path is refused once that check exists.

A weekly scheduled run of the same matrix catches engine and wheel breakage that a pull-request run on Ubuntu alone will miss.

## Quick wins

1. Add `turbo` to the root devDependencies so `pnpm dev`, `pnpm build`, and `pnpm typecheck` work on a clean machine. This failed on Linux in this session and will fail the same way on Windows and on a Mac that does not have a global Turbo.
2. Add `.gitattributes` forcing LF on `*.sh` before anyone clones on Windows.
3. Replace `scripts/agent-dev.sh` with a Node launcher that picks `bin` or `Scripts`.
4. Default the assign-dialog sandbox to off when `sandboxAvailable` is false, and change the error string that says “this Mac.”
5. On the Connect page, put the absolute Node path the API already returns into `command`.
6. Call `process.exit` at the end of `apps/context-bridge/scripts/live-e2e.ts` so a green run can finish.
7. In `doctor.sh`, stop prepending Homebrew and print a clear line when the Docker socket is permission-denied.
