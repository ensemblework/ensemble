# Instructions for coding agents

This file is for every agent that works in this repo: Cursor, GitHub Copilot, Claude Code, Codex, and anything else. `CLAUDE.md` and `.github/copilot-instructions.md` point here. Read this file before you change anything.

## The rule that matters most: docs move with the code

The docs in `docs/` and the root `README.md` describe what the code does. They are only useful while they are true.

**If your change affects behaviour, a command, a file path, an API, an env variable, a setting, or a limitation that a doc describes, update that doc in the same change.** Not in a follow-up PR, and not "later". A PR that changes behaviour and leaves a doc saying the old thing is not finished.

Before you finish:

1. Search the docs for the names you touched: `rg -n "<route|script|env var|file name>" README.md docs/ AGENTS.md`.
2. Fix every statement that is now wrong. Delete statements about things that no longer exist rather than leaving them with a caveat.
3. If you added something a reader would look for (a page, a route, a script, an env variable, a package), add it where the table below says.
4. If the change alters what works today, update [`docs/18_WHAT_IS_REAL.md`](docs/18_WHAT_IS_REAL.md).
5. Mention the doc changes in your PR description. If you checked and no doc needed to change, say so.

Where a change usually needs a doc update:

| You changed | Update |
|---|---|
| Root `package.json` scripts, `scripts/dev.mjs`, `scripts/doctor.sh`, `scripts/agent-dev.sh`, ports, `.env.example` | `README.md`, [`docs/01`](docs/01_TECH_STACK_AND_ENVIRONMENT.md) |
| A new app, package, or top-level folder | `README.md` (Layout), [`docs/17`](docs/17_REPOSITORY_STRUCTURE.md), [`docs/README.md`](docs/README.md) if it has a doc |
| Hub pages and components (`apps/hub-web/app`, `components`) | [`docs/02`](docs/02_MODULE_INTERACTION_HUB_UI.md), `docs/18` |
| Landing page (`apps/landing`) | `README.md` (Layout), [`docs/17`](docs/17_REPOSITORY_STRUCTURE.md), `docs/18` |
| CI and deploy workflows (`.github/workflows`, `.github/actions`, `infra/deploy/autodeploy.sh`) | [`docs/01` §8](docs/01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys), `README.md` (CI and deploys) |
| API routes (`apps/hub-api/src/routes`) | The API tables in [`docs/02`](docs/02_MODULE_INTERACTION_HUB_UI.md), plus the module doc for that area |
| The Hub assistant (`apps/hub-api/src/assistant`, `components/assistant`) | [`docs/11`](docs/11_HOW_THE_ASSISTANT_WORKS.md) |
| Connectors, triage, sync, remote MCP connections (`apps/hub-api/src/connectors`, `routes/connectors.ts`, `routes/mcp-connections.ts`, `packages/shared-types/src/connectors.ts`) | [`docs/03`](docs/03_MODULE_CONTEXT_ENGINE.md), the connector table in `docs/18`, the connector store in [`docs/02` §3.9](docs/02_MODULE_INTERACTION_HUB_UI.md) |
| Imports from other apps (`apps/hub-api/src/imports`, `routes/imports.ts`, `components/imports`) | [`docs/27`](docs/27_IMPORTS.md) |
| Assistant tools for connected apps (`apps/hub-api/src/assistant/tools/google*`, `microsoft*`, `mcp-tools.ts`, `apps.ts`, `apply.ts`, `src/lib/office`) | [`docs/11`](docs/11_HOW_THE_ASSISTANT_WORKS.md) |
| Scheduler, planner, workers (`src/jobs`, `apps/agent-runtime/ensemble_agent/orchestrator`, `workers`) | [`docs/05`](docs/05_MODULE_TASK_ORCHESTRATOR.md) |
| Workspace jobs, sandbox, Code tab, terminal (`src/workspace`, `src/repo`, `routes/code*`, `routes/terminal*`) | [`docs/06`](docs/06_MODULE_WORKSPACE_AND_SURFACES.md), [`docs/16`](docs/16_CODE_TAB.md), [`docs/24`](docs/24_DESKTOP_SANDBOXING.md) |
| Policy, ledger, metrics, retention | [`docs/07`](docs/07_MODULE_GOVERNANCE_AUDIT_METRICS.md) |
| Skills, Skill Forge (`apps/skill-forge`, `routes/skills.ts`) | [`docs/04`](docs/04_MODULE_SKILL_FORGE.md) |
| Context Bridge (`apps/context-bridge`, `apps/hub-api/src/bridge`) | [`docs/CONTEXT_BRIDGE.md`](docs/CONTEXT_BRIDGE.md), [`docs/13`](docs/13_MODULE_CONTEXT_BRIDGE.md) |
| Plots (`app/(hub)/plots`, `src/plots`, `ensemble_agent/plots`) | [`docs/20_PLOTS_DESIGN.md`](docs/20_PLOTS_DESIGN.md) |
| Block diagrams (`packages/block-diagrams`) | [`docs/21`](docs/21_BLOCK_DIAGRAMS_DSL.md), [`docs/21` cheat sheet](docs/21_BLOCK_DIAGRAMS_CHEATSHEET.md), [`docs/22`](docs/22_BLOCK_DIAGRAMS_FOR_AGENTS.md) and `.github/skills/block-diagrams/SKILL.md` (22 and the skill are the same text) |
| Quick capture (`apps/quick-capture`) | [`docs/20_QUICK_CAPTURE.md`](docs/20_QUICK_CAPTURE.md) |
| Desktop app (`apps/desktop`, `src/desktop`, `scripts/*desktop*`, `scripts/build-mac-dmg.sh`) | [`docs/DESKTOP.md`](docs/DESKTOP.md), [`docs/desktop/MAC_CHECKLIST.md`](docs/desktop/MAC_CHECKLIST.md), [`docs/23`](docs/23_LOCAL_DESKTOP_DESIGN.md) |
| Remote tasks and devices (`src/remote`, `src/devices`) | [`docs/25`](docs/25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) |
| The CLI, its installers and releases (`apps/cli`, `scripts/package-cli.mjs`, `packaging/`, `apps/landing/public/install.*`, `.github/workflows/cli-release.yml`, `routes/cli-auth.ts`, `routes/mcp.ts`) | [`docs/26`](docs/26_CLI.md), the download guide in `apps/landing/lib/download.ts`, and the Connect guides in `apps/hub-web/lib/connect/` |
| Hosting, production config (`infra/deploy`, `lib/production.ts`) | The comments in `infra/deploy/` and `ensemble.env.example`. Deployment runbooks live in the git-ignored `private/` folder, never in `docs/` |
| Caches, perf budgets | [`docs/CACHING.md`](docs/CACHING.md), [`docs/UI_PERF_DESIGN.md`](docs/UI_PERF_DESIGN.md) |
| Seeds and demo data (`prisma/seed.ts`, `prisma/demo-branch.ts`) | [`docs/DEMO_DATA.md`](docs/DEMO_DATA.md), [`docs/03` §11](docs/03_MODULE_CONTEXT_ENGINE.md#11-seed-data-opt-in-only) |
| Prisma schema shape | [`docs/00` §7](docs/00_PROJECT_OVERVIEW.md#7-core-domain-model-shared-across-modules) when a core type changes, and the module doc that owns the table |

New docs go in `docs/` and get a row in [`docs/README.md`](docs/README.md). Design notes for a feature that is not built yet go in `docs/design/` and say so in their first paragraph.

## How to write docs here

- Describe what the code does now, with the file path that does it. Quote real route names, scripts, and env variables.
- When you verified something by running it, say so and give the date ("Checked 5 Oct 2026"). When you only read the code, say that.
- Do not document future ideas until they are planned ([`docs/00`](docs/00_PROJECT_OVERVIEW.md#direction), rule 7).
- No personal information: no personal email addresses, private machine paths, or details about individuals beyond a name where it is needed. Example people and companies should be fictional (the demo uses Mira Chen at Fieldnote).
- Keep PR evidence (screenshots, recordings) in the PR, not in the repo. `docs/screenshots/` is git-ignored for that reason.

## Repo map

| Path | What |
|---|---|
| `apps/hub-web` | Next.js 15 Hub UI |
| `apps/landing` | Static landing page for ensemblework.com |
| `apps/hub-api` | Fastify + Prisma API, scheduler, workspace queue, assistant |
| `apps/agent-runtime` | Python FastAPI service that holds model keys and calls providers (port 5055) |
| `apps/context-bridge` | Read-only MCP server for editors (hub-api also serves it at `/mcp`) |
| `apps/cli` | The `ensemble` CLI (npm name `ensemblework`): runner + `ensemble mcp` |
| `apps/desktop` | Tauri desktop app (local sidecar + PGlite) |
| `apps/quick-capture` | Tauri tray app with a global shortcut |
| `apps/skill-forge` | Skill Forge package (stub) |
| `packages/*` | `shared-types` (Zod), `block-diagrams`, `ide-theme`, `prompts` |
| `packaging/` | CLI release metadata: Homebrew, Scoop, winget, nfpm, AUR |
| `infra/` | Local docker-compose (Postgres + Redis) and `deploy/` for a VM |
| `docs/` | Design and operating docs; start at `docs/README.md` |

Details: [`docs/17_REPOSITORY_STRUCTURE.md`](docs/17_REPOSITORY_STRUCTURE.md).

## Commands

```bash
pnpm install
pnpm infra:up          # Postgres 16 + pgvector, Redis 7 (Docker)
pnpm db:migrate        # prisma migrate deploy; never resets data
pnpm dev               # web :3000, API :4000, agent :5055
pnpm run doctor        # checks Node, pnpm, Python, Docker, .env
```

Checks to run for the area you changed:

```bash
pnpm typecheck                                  # every TS package
pnpm --filter @ensemble/hub-api test
pnpm --filter @ensemble/hub-api test:public        # in-memory API auth/isolation/signup/safety suites
pnpm --filter @ensemble/hub-api route:inventory:check
pnpm --filter @ensemble/hub-web test
pnpm --filter @ensemble/landing build             # landing page (static export to apps/landing/out)
pnpm --filter @ensemble/shared-types test
pnpm --filter @ensemble/block-diagrams test
pnpm --filter @ensemble/ide-theme test
pnpm bridge:verify                              # context bridge
pnpm --filter ensemblework test                 # CLI (builds dist/ensemble.mjs first)
node --test packaging/render.test.mjs           # CLI release metadata
cd apps/agent-runtime && .venv/bin/python -m pytest tests   # install pytest into .venv first
```

## Guardrails

- Never run `prisma migrate reset` or anything else that drops data. Schema changes are new migrations under `apps/hub-api/prisma/migrations`.
- Do not commit secrets, `.env`, `.ensemble/`, build output, `*.egg-info/`, or screenshots. Check `git status` before committing.
- Run only one agent-runtime process; `pnpm dev` already starts it.
- Keep code comments about constraints the code cannot show. Do not put change history or "where this came from" in comments.
