# Ensemble

A localhost-first digital coworker: a shared board, Notion-like task pages, and an agent that works the same context you do.

**Website: [ensemblework.com](https://ensemblework.com)** · **App: [app.ensemblework.com](https://app.ensemblework.com)** · an AI notes app and workspace where you [plan your day with AI](https://ensemblework.com/plan-your-day-with-ai), keep [AI context](https://ensemblework.com/ai-context-management) in one place, and [work with AI agents](https://ensemblework.com/work-with-ai-agents).

Design and operating docs live in [`docs/`](docs/README.md). [`docs/18_WHAT_IS_REAL.md`](docs/18_WHAT_IS_REAL.md) says what works today. Coding agents (and people) changing the code should read [`AGENTS.md`](AGENTS.md) first.

## Run locally (Mac)

You need four things installed before the app will start:

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 | `node -v` |
| pnpm | 12 (repo pins `pnpm@12.6.0`) | `pnpm -v` |
| Docker Desktop | running, with Compose | `docker info` |
| Python | 3.11 or newer | `python3 --version` |

macOS does not ship a new enough Python. Homebrew’s formula is the usual fix:

```bash
brew install node@22 pnpm python@3.12
# Homebrew’s node@22 is often not on PATH until you add it:
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

A Conda `(base)` environment is fine when `python3 --version` is 3.11 or newer. The agent script ignores the old system Python at `/usr/bin/python3`.

Docker Desktop has to be open (the whale icon) before the database commands. Postgres uses a named volume that Compose will not create for you:

```bash
cp .env.example .env
pnpm install
docker volume create ensemble_pg
pnpm infra:up
pnpm db:migrate
pnpm dev
```

Put each command on its own line, with nothing after it. Interactive zsh (the shell macOS Terminal opens) and Windows `cmd` do not treat `#` as a comment. Pasting `pnpm dev # site :3000, API :4000, agent :5055` forwards `'#'` into Next.js, which stops with `Invalid project directory ... apps/hub-web/#`. Bash and PowerShell already drop that comment. `scripts/dev.mjs` also ignores a stray `#`, so the same line still starts.

`pnpm infra:up` starts Postgres 16 with pgvector and Redis 7, on loopback only. `pnpm db:migrate` and `pnpm db:seed` start that database themselves when `DATABASE_URL` is `127.0.0.1:5432` and nothing is listening there. Docker Desktop still has to be open. `pnpm db:migrate` is `prisma migrate deploy`. It applies pending migrations, including the workspace indexes and foreign keys, and it does not ask to reset or delete rows. A database created earlier with `pnpm db:push` already has tables and no migration history, so Prisma stops with P3005 (`The database schema is not empty`). `pnpm db:migrate` records that history and aligns the schema in place. It does not wipe the database. Do not run `prisma migrate reset`. `pnpm dev` is the whole app in one terminal: the site on port 3000, the API on port 4000, and the agent on port 5055. Leave that terminal open. It starts the three processes with pnpm itself (no global Turbo).

If Prisma already printed `We need to reset the public schema` and `All data will be lost`, do not run `prisma migrate reset`. From the repo root, run `pnpm db:migrate` again. That repairs an existing database in place.

| Process | Address | What you should see |
|---|---|---|
| Hub (website) | http://localhost:3000 | Next.js “Ready” |
| API | http://127.0.0.1:4000/health | `{"ok":true}` from `curl -s http://127.0.0.1:4000/health` |
| Agent runtime | http://127.0.0.1:5055/health | `Uvicorn running on http://127.0.0.1:5055` |

The first `pnpm dev` also creates `apps/agent-runtime/.venv` and installs the Python packages. That pause is the agent being set up, not a hang. When the agent is up:

```bash
curl -s http://127.0.0.1:5055/health
```

The healthy body is `{"ok":true,"service":"agent-runtime"}`.

Open http://localhost:3000. The first screen is **login**. In local development, the first account claims placeholder data and lands on **/start**. Hosted signup is open by default and never gives the first registrant existing localhost data. Email/password, Google, GitHub and Microsoft login are supported; OAuth buttons appear when their separate `AUTH_*` clients are configured. Hosted email signup requires Resend and Turnstile; see [Accounts and public signup](docs/02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup). **Connect** creates the read-only `ens_…` key (`ENSEMBLE_BRIDGE_TOKEN`) for editors.

Public hosted accounts use their own model keys, or the **included models** when the operator offers them: four Azure-hosted models paid for by the operator, metered in 20,000 Ensemble credits per account per month with a monthly ceiling for everyone ([docs/33](docs/33_INCLUDED_AI.md); `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_API_KEY`, `ENSEMBLE_INCLUDED_*`). Only exact verified `ENSEMBLE_OPERATOR_EMAILS` accounts can use other host credentials or host filesystem execution; the hosted server's own terminal defaults to off. Everyone's Code tab works on their own paired computer instead: review and edit code, Source control, and a terminal unlocked with a passkey ([docs/16](docs/16_CODE_TAB.md)). Notes and context do not require a local app. Verify email before using hosted model, connector, or agent features.

The API baseline check is `pnpm --filter @ensemble/hub-api test:public`: real Fastify HTTP/auth with an isolated migrated in-memory PGlite database and mocked providers (no model quota). The normal API `test` includes it. `route:inventory:check` checks every registered hosted/desktop route against the checked-in inventory; explicit happy-path/resource coverage gaps remain warning-only, not a claim of a complete API audit. See [API regression tests](docs/01_TECH_STACK_AND_ENVIRONMENT.md#9-api-regression-tests).

Port 5055 is intentional. macOS AirPlay Receiver already listens on port 5000, so the agent does not use 5000.

### Do not start the agent a second time

`pnpm dev:agent` is the same agent process, for when you want **only** the agent (the website and API started some other way, or you are debugging Python). Run it in place of the agent half of `pnpm dev`, with `pnpm dev` stopped.

Running both at once produces exactly this:

```text
INFO:     Will watch for changes in these directories: ['.../apps/agent-runtime']
ERROR:    [Errno 48] Address already in use
[ELIFECYCLE] Command failed with exit code 3.
```

Errno 48 means something is already listening on `127.0.0.1:5055`. That is the agent from the `pnpm dev` terminal you still have open, or a leftover from one you thought had quit. Ctrl+C in the `pnpm dev` terminal does not always take the Python reloader with it.

If `curl -s http://127.0.0.1:5055/health` already prints `{"ok":true,"service":"agent-runtime"}`, the agent is running. Stop there.

If you really want a fresh agent process:

1. Ctrl+C the `pnpm dev` terminal (and any `pnpm dev:agent` terminal).
2. See who still owns the port: `lsof -nP -iTCP:5055 -sTCP:LISTEN`
3. Stop that process (the PID is the second column): `kill <PID>`
4. Start again, one way only: `pnpm dev`, or the agent alone with `pnpm dev:agent`.

`pnpm dev:api` and `pnpm dev:web` are the same idea: one piece at a time, with `pnpm dev` stopped, so the ports do not collide.

### If setup fails before the app is up

Run `pnpm run doctor`. It checks Node 22, pnpm, Python 3.11+, Docker, and `.env`. (`pnpm doctor` without `run` is pnpm’s own installer check and does not look at this repo.)

- **`sh: turbo: command not found` (exit 127).** That `pnpm dev` quit immediately, so `curl http://127.0.0.1:5055/health` prints nothing and `lsof` shows nobody on 5055. Update to this README’s scripts and run `pnpm install`, then `pnpm dev` again. The dev script no longer calls Turbo.
- **`node: command not found` after `brew install node@22`.** Add the Homebrew path above to `~/.zshrc`, then open a new terminal.
- **`agent-runtime needs Python 3.11 or newer`.** `brew install python@3.12`, then run `pnpm dev` again. The script looks for `python3.13`, `python3.12`, `python3.11`, Miniconda, then `python3`.
- **`pnpm infra:up` says volume `ensemble_pg` is not found.** Run `docker volume create ensemble_pg` and retry.
- **`P1001: Can't reach database server at 127.0.0.1:5432`.** Postgres is not running. `pnpm db:migrate` and `pnpm db:seed` start the Docker database when Docker is running. Open Docker Desktop, then run the command again. If it still cannot start the container: `docker volume create ensemble_pg`, then `pnpm infra:up`.
- **`Failed to proxy http://127.0.0.1:4000/... ECONNREFUSED`.** The website is up and the API is not. Scroll up for lines prefixed `apps/hub-api`. Postgres and Redis have to be reachable at `127.0.0.1` (not `localhost`, which is often `::1` on a Mac) before `pnpm dev`. `curl -s http://127.0.0.1:4000/health` should print `{"ok":true,"service":"hub-api"}`.
- **The website loads and chat does nothing.** The agent is down, or no model key is set. Confirm port 5055 with the health curl above. Put a Gemini key in `.env` as `GOOGLE_API_KEY` (or paste it under Settings → Assistant → Models → Manage API keys, or use your Claude or ChatGPT plan from Your AI subscriptions on the same page). A key in Settings wins over `.env`.
- **Plot resource budgets.** `ENSEMBLE_PLOT_CONCURRENCY` limits simultaneous exports. `ENSEMBLE_PLOT_MEMORY_MIB` is a per-child budget from 64 to 2048 MiB (default 2048): Linux uses an address-space rlimit; macOS uses parent-sampled resident memory, not an instantaneous hard ceiling. Low budgets must leave room for the scientific stack. See [Plots](docs/20_PLOTS_DESIGN.md).

Context Bridge (read-only MCP) is separate from the agent and is not started by `pnpm dev`. See [docs/CONTEXT_BRIDGE.md](docs/CONTEXT_BRIDGE.md).

The desktop app is a Tauri window that runs Ensemble on this computer: a static export of the site plus a local API on an embedded database, with no Docker. See [docs/DESKTOP.md](docs/DESKTOP.md).

```bash
pnpm desktop:export
pnpm desktop:dev
pnpm desktop:dmg      # unsigned macOS disk image; hand test in docs/desktop/MAC_CHECKLIST.md
```

Quick capture outside the browser is a Tauri tray app. See [docs/20_QUICK_CAPTURE.md](docs/20_QUICK_CAPTURE.md). A check without opening the window:

```bash
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml -- --check
```

```bash
pnpm bridge:build     # apps/context-bridge/dist
pnpm bridge:verify    # typecheck, MCP client tests, smoke
```

## Ensemble CLI

`ensemble` opens Ensemble in your terminal: a **Tasks** tab with your agent runs and everything waiting on you (answer with a click, a number or `/allow`), and a **Chat** tab with your agent: Claude Code, Codex or Cursor on your own sign-in, working in the folder under a run profile with your Ensemble board loaded (or Ensemble Code, with a model key). It starts this computer's runtime in the background, so tasks you assign from the web run here, and `ensemble mcp` connects editors over MCP. The desktop app and installers for each system are on the same page. Install it from [ensemblework.com/download](https://ensemblework.com/download):

```bash
brew install ensemblework/tap/ensemble                 # macOS, Linux
curl -fsSL https://ensemblework.com/install.sh | sh    # macOS, Linux
irm https://ensemblework.com/install.ps1 | iex         # Windows PowerShell
```

Then run `ensemble` in a project and type `/` for commands (`/login`, `/run`, `/profile`, `/agent`, `/keys`, `/runner install`); `ensemble help commands` lists the same actions for scripts, and `ensemble mcp setup` connects editors. Editors that take a URL can use the hosted MCP endpoint `https://api.ensemblework.com/mcp` with an `ens_` key from Connect your apps, with nothing installed. Commands, install channels, editor files and the release process: [docs/26_CLI.md](docs/26_CLI.md).

```bash
pnpm cli:build                                   # apps/cli/dist/ensemble.mjs
pnpm --filter ensemblework test
pnpm cli:package --target darwin-arm64 --out dist/cli   # full archive for this host's target
```

## Layout

```
apps/hub-web            Next.js 15 — Notion-like shell (Today, Board, Needs me, pages, Code, Plots, Diagrams)
apps/landing            static site for ensemblework.com: home, topic pages, /download (pnpm --filter @ensemble/landing dev, port 3100)
apps/hub-api            Fastify + Prisma — tasks, pages, undo, SSE, scheduler, workspace queue, assistant
apps/agent-runtime      Python — model adapters, planner, plot export
apps/skill-forge        Python miners (stub)
apps/context-bridge     read-only MCP server (stdio + loopback Streamable HTTP); hub-api serves it at /mcp
apps/cli                the `ensemble` terminal app, runner and `ensemble mcp` (npm name ensemblework)
apps/quick-capture      Tauri tray + global shortcut (macOS, Windows, Linux)
apps/desktop            Tauri desktop app with a local API sidecar (macOS, Windows, Linux)
packages/brand          Woven Chorus artwork, motion and terminal identity
packages/shared-types   Zod domain types
packages/block-diagrams diagram DSL: parse, layout, SVG
packages/ide-theme      VS Code color themes for the code space
packages/prompts        placeholder
packaging/              Homebrew, Scoop, winget, nfpm and AUR templates for CLI releases
infra/                  docker-compose (postgres + redis, loopback only) and deploy/ for a VM
docs/                   design and operating docs
```

More detail: [docs/17_REPOSITORY_STRUCTURE.md](docs/17_REPOSITORY_STRUCTURE.md).

## CI and deploys

Go setup is pinned to `actions/setup-go@v6.4.0` (Go `1.24.x`) in CI and client packaging. Every pull request runs `.github/workflows/ci.yml`: typecheck, the TypeScript and Python test suites (hub-api against a real Postgres and Redis), and production builds of the Hub and the landing page. After CI passes on `main`, `.github/workflows/deploy.yml` ships it: the VM pulls the new commit, the Hub and landing page are published on Vercel, and the landing pages are submitted to IndexNow search engines. How it works and which secrets it needs: [docs/01 §8](docs/01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys). A tag `cli-v<version>` runs `.github/workflows/cli-release.yml`, which builds the CLI for macOS, Windows and Linux, publishes a GitHub release, and updates the Homebrew tap and Scoop bucket ([docs/26 §7](docs/26_CLI.md#7-releases)).

## License

[FSL-1.1-MIT](LICENSE.md) (Functional Source License, MIT future license). You may use, change and redistribute Ensemble for any purpose, including at work, except to offer a product or service that competes with it. Each release becomes available under the MIT license two years after it is published.

### Shared brand assets

`packages/brand` owns Woven Chorus artwork, Satin Gold, the Expressive SVG motion controller and terminal frames. Web, landing, native startup, Quick capture and CLI consume this source. `scripts/build-ensemble-brand.mjs` exports packaged icons, social previews and standalone fallback pages. Run `pnpm brand:build` after changing a master; `pnpm brand:check` checks source/output hashes. Details: [Brand and motion](docs/BRAND.md).

## Release version

`release.json` is the version source for the web, API, desktop, quick capture and CLI. Change it, run `pnpm version:sync`, and commit the derived manifests/configs together. `pnpm version:check` runs before typecheck and application builds. Native builds also validate the version from Rust. Desktop and CLI tags must match it; publish both from the tested main commit. Desktop releases build Apple silicon and Intel separately so their sidecars match. See [Desktop](docs/DESKTOP.md) and [CLI releases](docs/26_CLI.md#7-releases).

The desktop workflow can build a selected target on manual dispatch for recovery. Intel Mac disk images use the verified APFS packager (`scripts/package-mac-dmg.mjs`) after the app and signed updater archive are built, avoiding the interactive disk-image staging path.

A desktop packaging recovery can assemble successful tagged artifacts with a corrected Intel-only build on a GitHub runner; it verifies runtime source parity and every updater signature before publishing.
