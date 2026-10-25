# Ensemble

A workspace for your tasks, pages, files and connected context, with an assistant and agents that work alongside you. Use the hosted web app, run it locally, or use the desktop app and CLI.

**Website: [ensemblework.com](https://ensemblework.com)** · **App: [app.ensemblework.com](https://app.ensemblework.com)**

Guides live in [`docs/`](docs/README.md); [`docs/00_PROJECT_OVERVIEW.md`](docs/00_PROJECT_OVERVIEW.md) maps what works today and its limits. Coding agents (and people) changing the code should read [`AGENTS.md`](AGENTS.md) first.

## Run locally

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 | `node -v` |
| pnpm | 12 (repo pins `pnpm@12.6.0`) | `pnpm -v` |
| Docker with Compose | running | `docker info` |
| Python | 3.11 or newer | `python3 --version` |

On macOS: `brew install node@22 pnpm python@3.12` (add `/opt/homebrew/opt/node@22/bin` to `PATH`) and open Docker Desktop. On Linux: Node 22 (for example through nvm), pnpm, Docker Engine and a system or `uv` Python 3.11+. `pnpm run doctor` checks all of them and `.env`.

```bash
cp .env.example .env
pnpm install
docker volume create ensemble_pg
pnpm infra:up      # Postgres 16 + pgvector and Redis 7, loopback only
pnpm db:migrate    # prisma migrate deploy; never resets data
pnpm dev           # Hub :3000, API :4000, agent :5055
```

| Process | Address | Healthy |
|---|---|---|
| Hub | http://localhost:3000 | Next.js "Ready" |
| API | http://127.0.0.1:4000/health | `{"ok":true,"service":"hub-api"}` |
| Agent runtime | http://127.0.0.1:5055/health | `{"ok":true,"service":"agent-runtime"}` |

The first `pnpm dev` creates `apps/agent-runtime/.venv` and installs the Python packages. `pnpm db:migrate` and `pnpm db:seed` start the Docker database themselves when `DATABASE_URL` points at `127.0.0.1:5432` and nothing listens there. Never run `prisma migrate reset`. Port 5055 avoids macOS AirPlay on 5000.

Open http://localhost:3000 and sign up; locally the first account claims the placeholder data and lands on **/start**. For model features, add a key in Settings → Assistant → Models (or `GOOGLE_API_KEY` in `.env`; a key saved in Settings wins). Sign-in providers, hosted limits and included models: [docs/02 §1.6](docs/02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup) and [docs/33](docs/33_INCLUDED_AI.md).

`pnpm dev:web`, `pnpm dev:api` and `pnpm dev:agent` start one piece each; use them instead of `pnpm dev`, not beside it, or the ports collide (`Address already in use`). If port 5055 is still taken after stopping `pnpm dev`, find the leftover with `lsof -nP -iTCP:5055 -sTCP:LISTEN` and stop it.

| Symptom | Fix |
|---|---|
| `volume ensemble_pg not found` | `docker volume create ensemble_pg`, then `pnpm infra:up` |
| `P1001: Can't reach database server at 127.0.0.1:5432` | Start Docker, then rerun the command |
| `Failed to proxy http://127.0.0.1:4000/... ECONNREFUSED` | The API did not start: read the `apps/hub-api` lines; Postgres and Redis must answer on `127.0.0.1` |
| `agent-runtime needs Python 3.11 or newer` | Install Python 3.12; the script tries `python3.13`, `python3.12`, `python3.11`, Miniconda, then `python3` |
| Chat does nothing | Agent down (check :5055) or no model key |

Checks for the area you change are listed in [AGENTS.md](AGENTS.md#commands); the API baseline is `pnpm --filter @ensemble/hub-api test:public` (in-memory PGlite, mocked providers, no model quota).

## Other apps

```bash
pnpm desktop:export && pnpm desktop:dev    # desktop app: static Hub + local API on PGlite (docs/DESKTOP.md)
pnpm desktop:dmg                           # unsigned macOS disk image (docs/desktop/MAC_CHECKLIST.md)
cargo run --manifest-path apps/quick-capture/src-tauri/Cargo.toml -- --check   # quick capture (docs/20_QUICK_CAPTURE.md)
pnpm bridge:build && pnpm bridge:verify    # Context Bridge, read-only MCP (docs/CONTEXT_BRIDGE.md)
pnpm cli:build                             # apps/cli/dist/ensemble.mjs (docs/26_CLI.md)
```

## Ensemble CLI

`ensemble` opens Ensemble in the terminal: a **Tasks** tab with agent runs and everything waiting on you, and a **Chat** tab with Claude Code, Codex or Cursor on your own sign-in (or Ensemble Code with a model key). It runs this computer's runtime in the background, so tasks assigned from the web run here, and `ensemble mcp` connects editors. Install from [ensemblework.com/download](https://ensemblework.com/download):

```bash
brew install ensemblework/tap/ensemble                 # macOS, Linux
curl -fsSL https://ensemblework.com/install.sh | sh    # macOS, Linux
irm https://ensemblework.com/install.ps1 | iex         # Windows PowerShell
```

Editors that take a URL can use `https://api.ensemblework.com/mcp` with an `ens_` key from Connect your apps. Details: [docs/26_CLI.md](docs/26_CLI.md).

## Layout

```
apps/hub-web            Next.js 15 Hub (Today, Board, pages, Files, Code, Plots, Diagrams…)
apps/landing            static site for ensemblework.com (port 3100)
apps/hub-api            Fastify + Prisma API: data, assistant, scheduler, workspace queue, SSE
apps/agent-runtime      Python FastAPI: model adapters and plot export (port 5055)
apps/skill-forge        Python package (stub)
apps/context-bridge     read-only MCP server; hub-api also serves it at /mcp
apps/cli                the `ensemble` CLI, runner and `ensemble mcp` (npm name ensemblework)
apps/quick-capture      Tauri tray app with a global shortcut
apps/desktop            Tauri desktop app with a local API sidecar
packages/               brand, shared-types, block-diagrams, ide-theme, prompts
packaging/              CLI release metadata: Homebrew, Scoop, winget, nfpm, AUR
infra/                  local docker-compose; deploy/ (VM), deploy/home/ (production), deploy/testing/ (isolated web testing)
design/                 generated brand assets (pnpm brand:build)
docs/                   current guides
```

More: [docs/17_REPOSITORY_STRUCTURE.md](docs/17_REPOSITORY_STRUCTURE.md).

## CI, deploys and releases

Iteration uses `testing`, `test.ensemblework.com` and the separate `ensemble-test` CLI, with a separate API, accounts, database, sessions and file storage. `test-web.yml` runs focused checks and publishes the testing web app; `test-cli.yml` then publishes matching test-only CLI packages without changing production CLI/native release channels. PRs targeting `testing` skip production CI. Installation, isolation and promotion guidance: [docs/36](docs/36_WEB_TESTING.md).

Other pull requests, including promotion from `testing` to `main`, run `.github/workflows/ci.yml`: the same fast checks as testing (about two minutes). The slower suites are paused and run by hand (`full-checks.yml`, [docs/37](docs/37_PAUSED_CHECKS.md)); `desktop.yml` builds only on release tags. After CI passes on `main`, `deploy.yml` moves the `production` branch; the API server (`infra/deploy/home`) pulls it, then the Hub and landing page are published on Vercel. Details: [docs/01 §8](docs/01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys).

`release.json` is the version for web, API, desktop, quick capture and CLI: change it, run `pnpm version:sync`, commit the derived files together (`pnpm version:check` runs before typecheck and builds). A `cli-v<version>` tag runs `cli-release.yml` ([docs/26 §7](docs/26_CLI.md#7-releases)); a `desktop-v<version>` tag publishes the desktop installers ([docs/DESKTOP.md](docs/DESKTOP.md)). Brand assets come from `packages/brand` through `pnpm brand:build` / `pnpm brand:check` ([docs/BRAND.md](docs/BRAND.md)).

## License

[FSL-1.1-MIT](LICENSE.md) (Functional Source License, MIT future license). You may use, change and redistribute Ensemble for any purpose, including at work, except to offer a product or service that competes with it. Each release becomes available under the MIT license two years after it is published.
