# 17 · Repository structure

What lives where in this repo. For *what* to build, start with [`00_PROJECT_OVERVIEW.md`](00_PROJECT_OVERVIEW.md). For what runs today, see [`18_WHAT_IS_REAL.md`](18_WHAT_IS_REAL.md). Checked against `main` on 5 Oct 2026; the CLI entries on 6 Oct 2026.

---

## 1. Top level

```text
ensemble/
├── apps/                  Runnable applications
│   ├── hub-web/           Next.js 15 (App Router) — the Hub UI
│   ├── landing/           Static landing page for ensemblework.com (Next.js export, no API calls)
│   ├── hub-api/           Fastify + Prisma API, scheduler, workspace queue, assistant
│   ├── agent-runtime/     Python FastAPI service that holds model keys (port 5055)
│   ├── context-bridge/    Read-only MCP server for editors (stdio + loopback HTTP); hub-api serves it at /mcp
│   ├── cli/               The `ensemble` CLI (npm name ensemblework): runner + MCP, docs/26
│   ├── desktop/           Tauri 2 desktop app (static export + local hub-api sidecar)
│   ├── quick-capture/     Tauri tray app with a global capture shortcut
│   └── skill-forge/       Skill Forge Python package (stub, docs/04)
├── packages/              Code shared by applications
│   ├── shared-types/      Zod domain types, settings, plots, modules, shortcuts
│   ├── block-diagrams/    Diagram DSL: parse, layout, SVG, Mermaid (docs/21)
│   ├── ide-theme/         VS Code theme conversion and built-in themes for the Code tab
│   └── prompts/           Placeholder package (README only)
├── infra/
│   ├── docker-compose.yml Local Postgres 16 + pgvector and Redis 7, loopback only
│   ├── sql/init.sql       Extensions (vector, pg_trgm, uuid-ossp)
│   └── deploy/            Ubuntu VM setup: Caddy, systemd units, backups, pull-based autodeploy
├── scripts/               Dev, desktop build, CLI packaging, measurement and hook scripts (§3)
├── packaging/             CLI release metadata renderer: Homebrew, Scoop, winget, nfpm, AUR (docs/26 §7)
├── docs/                  Design and operating docs (start at docs/README.md)
├── design/                Icon and motion design sources (not shipped code)
├── .github/               CI and deploy workflows, Copilot agent, agent skills, desktop build workflow
├── data/import/           Local, git-ignored import drop zone
├── eval/, skills/         Placeholders (.gitkeep)
├── AGENTS.md              Instructions for coding agents (CLAUDE.md and .github/copilot-instructions.md point here)
└── README.md              How to run it
```

Root coordination files:

- `package.json` — repository-wide commands (`pnpm dev`, `pnpm db:migrate`, `pnpm desktop:*`, `pnpm bridge:*`)
- `pnpm-workspace.yaml` — workspace packages
- `turbo.json` — TypeScript task graph (not used by `pnpm dev`)
- `tsconfig.base.json` — shared TypeScript settings
- `.env.example` — runtime configuration (authoritative; highlights in [01 §3](01_TECH_STACK_AND_ENVIRONMENT.md#3-local-development-setup))

---

## 2. Applications

```text
apps/hub-web/
├── app/login, app/signup     Sign-in pages
├── app/(hub)/                One folder per page: today, board, needs-me, runs, tasks/[id],
│                             projects, context, skills, workspace, code, plots, diagrams,
│                             marketplace, meetings, recap, metrics, settings, trash,
│                             completed, connect, welcome, start, …
├── components/               Grouped by surface: assistant, board, code, comments, connect,
│                             context, desk, diagrams, editor (TipTap), imports, motion, needs-me,
│                             plots, settings, shell, today, widgets; ui.tsx is the kit
├── lib/                      API client, SSE, auth helpers, plots, connect configs
└── e2e/                      Playwright scripts (run by hand)

apps/hub-api/src/
├── routes/                   REST + SSE gateway, one module per area
├── assistant/                Hub Action Layer: tool loop, registry, tools/ (docs/11)
├── bridge/                   Context Bridge resolution and briefs (docs/13)
├── connectors/               Gmail/Calendar, GitHub, Slack, Linear; ingest, triage, sync
├── imports/                  Importers from other apps, CSV/zip readers, writer, jobs (docs/27)
├── context/                  Context board order and people views
├── cowork/                   Morning brief, quick capture, nudges, weekly recap
├── jobs/                     In-process scheduler, retention, claim locks
├── workspace/                Agent execution: queue worker, sandbox, trust, runner (docs/06)
├── repo/                     Local repo reads for the Code tab and diagrams
├── remote/, devices/         Remote tasks on a paired computer (docs/25)
├── desktop/                  Desktop sidecar entry and helpers
├── plots/                    Plot store, service, cache (docs/20)
├── diagrams/                 Block-diagram revisions
├── marketplace/, layouts/, desk/   Templates, Today layouts, desk entries
├── pages/                    Task page document store and Markdown
├── runtime/                  In-process model adapters (desktop) and plot worker
├── themes/                   Open VSX theme fetch for the Code tab
├── ensemble/                   @ensemble surfaces, citations, watchers
├── services/                 Shared task/record writes
└── lib/                      auth, undo, ledger, redis, sse, prisma, secrets, …
apps/hub-api/prisma/          schema.prisma, migrations/, seed.ts, demo-branch.ts

apps/agent-runtime/ensemble_agent/
├── main.py                   FastAPI app: /health, /api/chat/tools, model and key routes
├── models.py                 Provider adapters (Gemini, OpenAI, Anthropic, Copilot, …)
├── credentials.py, vault.py  Per-user encrypted keys
├── orchestrator/             Planner and executor (docs/05)
├── workers/planned.py        Built-in plans by task type
├── tools/                    Tool catalog, guarded writes
├── plots/                    Matplotlib export worker
└── audit/                    Ledger writer
apps/agent-runtime/tests/     pytest suite

apps/landing/                 app/ (home, /download, /privacy, /terms, Open Graph image, robots, sitemap),
                              components/ (live board, wave motif, icons, install tabs), lib/ (site URLs,
                              download.ts install and editor data), public/ (install.sh, install.ps1),
                              vercel.json (text/plain headers for the install scripts)
apps/context-bridge/          src/ (MCP server; exports ./server, ./hub, ./config), clients/ (editor config samples), test/, scripts/
apps/cli/                     src/ (commands, device login, sidecar control, editor writers, services), scripts/build.mjs
                              (esbuild bundle → dist/ensemble.mjs), bin/ensemble (POSIX launcher), launcher/ (Go, Windows)
apps/desktop/                 src-tauri/ (Rust shell: sidecar, site, menu, diagnostics), ui/ (offline page)
apps/quick-capture/           src-tauri/ + ui/ (not a pnpm workspace package; built with cargo)
apps/skill-forge/             pyproject.toml + ensemble_forge/__init__.py; miners are not built
```

---

## 3. Scripts

| Script | What it does |
|---|---|
| `dev.mjs` | `pnpm dev`: starts hub-api, hub-web and agent-runtime together |
| `agent-dev.sh` | `pnpm dev:agent`: creates `apps/agent-runtime/.venv` and starts the agent on 5055 |
| `doctor.sh` | `pnpm run doctor`: checks Node, pnpm, Python, Docker and `.env` |
| `ensemble-hook.mjs` | Routes Cursor / Claude Code / Copilot permission prompts to Needs me |
| `export-desktop-web.mjs` | `pnpm desktop:export`: static export of hub-web for the desktop app |
| `assemble-desktop-sidecar.mjs` | `pnpm desktop:sidecar`: packs Node and hub-api into the Tauri resources (`--dest` packs elsewhere, used by the CLI) |
| `package-cli.mjs` | `pnpm cli:package --target <t>`: builds the CLI archive for this host (docs/26) |
| `smoke-cli-package.mjs` | Smoke test of an extracted CLI archive: version, MCP handshake, sidecar `/health` |
| `build-mac-dmg.sh` | `pnpm desktop:dmg`: unsigned macOS disk image |
| `desktop-discovery.mjs`, `desktop-spawn.mjs` | Shared helpers for finding the desktop API and spawning processes on every OS |
| `check-icons.mjs` | Validates the `.ico` / `.icns` app icons |
| `measure-*.mjs`, `ui-walk.mjs`, `verify-followup.mjs` | Playwright perf and UI probes (docs/UI_PERF_DESIGN.md) |

---

## 4. Where a change usually belongs

| Change | Start here |
|---|---|
| Page, component, styling, or browser behaviour | `apps/hub-web/` |
| The public landing page | `apps/landing/` |
| REST/SSE endpoint, persistence, connector, scheduled job, or assistant tool | `apps/hub-api/` |
| Model provider, planner, plot export | `apps/agent-runtime/` (and `apps/hub-api/src/runtime/` for the desktop in-process path) |
| Shared API / domain shape | `packages/shared-types/` |
| Editor access to Ensemble context | `apps/context-bridge/`, `apps/hub-api/src/bridge/`, `apps/hub-api/src/routes/mcp.ts` (hosted `/mcp`) |
| The `ensemble` CLI, its installers and releases | `apps/cli/`, `scripts/package-cli.mjs`, `packaging/`, `apps/landing/public/`, `.github/workflows/cli-release.yml` |
| Ensemble spaces (separate workspaces per account) | `apps/hub-api/src/spaces/`, the space cookie in `apps/hub-api/src/lib/auth.ts`, `apps/hub-web/components/shell/space-switcher.tsx`, `apps/hub-web/app/(hub)/spaces/` ([28](28_ENSEMBLE_SPACES.md)) |
| Database schema change | a new migration in `apps/hub-api/prisma/` |
| Desktop shell | `apps/desktop/` |
| Local infrastructure or VM deploy | `infra/` |
| CI checks, production deploys, CLI releases | `.github/workflows/` (`ci.yml`, `deploy.yml`, `desktop.yml`, `cli-release.yml`) |
| Product behaviour documentation | `docs/` — in the same change, see [AGENTS.md](../AGENTS.md) |

Folders such as `node_modules/`, `.next/`, `dist/`, `.venv/`, `__pycache__/`, `*.egg-info/`, `.turbo/`, `target/`, test caches, `docs/screenshots/` and `.ensemble/` are outputs or local state. They are git-ignored and should not become homes for source code.
