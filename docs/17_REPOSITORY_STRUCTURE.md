# 17 · Repository structure

What lives where. For the product, what works today and the domain model, see [00](00_PROJECT_OVERVIEW.md). Operator runbooks are in the git-ignored `private/` folder, not here.

## 1. Top level

```text
ensemble/
├── apps/                  Runnable applications (§2)
│   ├── hub-web/           Next.js 15 App Router: the Hub UI
│   ├── landing/           Static landing page for ensemblework.com (Next.js export, no API calls)
│   ├── hub-api/           Fastify + Prisma API, scheduler, workspace queue, assistant
│   ├── agent-runtime/     Python model adapters and plot service (port 5055)
│   ├── context-bridge/    Read-only MCP server for editors (stdio + loopback HTTP); hub-api also serves it at /mcp
│   ├── cli/               The `ensemble` CLI (npm name ensemblework): runner + MCP
│   ├── desktop/           Tauri 2 desktop app (static Hub export + local hub-api sidecar)
│   ├── quick-capture/     Tauri tray app with a global capture shortcut (built with cargo, not a pnpm package)
│   └── skill-forge/       Python package stub (pyproject.toml + empty ensemble_forge/)
├── packages/
│   ├── brand/             Woven Chorus artwork, motion controller, CLI identity (docs/BRAND.md)
│   ├── shared-types/      Zod domain types, settings, modules, plots, connectors, files, shortcuts
│   ├── block-diagrams/    Diagram DSL: parse, layout, SVG, Mermaid (docs/21)
│   ├── ide-theme/         VS Code theme conversion and built-in Code-tab themes
│   └── prompts/           Placeholder (README and package.json only)
├── infra/
│   ├── docker-compose.yml Local Postgres 16 + pgvector and Redis 7, loopback only
│   ├── sql/init.sql       Extensions: vector, pg_trgm, uuid-ossp
│   └── deploy/            Server installs (docs/01 §8): home/ is the home-server install (Docker,
│                          Cloudflare Tunnel, user units, cron watchdog, observability/); the files
│                          beside it are the alternative Ubuntu VM install (Caddy, system units)
├── scripts/               Dev, build, packaging, release and measurement scripts (§3)
├── packaging/             CLI release metadata renderer: Homebrew, Scoop, winget, nfpm, AUR (docs/26 §7)
├── design/                Generated brand outputs: brand/ (mark, icon, loader, gallery) and icons/
│                          (app and UI icons), written by scripts/build-ensemble-brand.mjs
├── docs/                  Current guides; index in docs/README.md
├── .github/               workflows/ (ci, deploy, desktop, cli-release), actions/vercel-deploy,
│                          agents/, skills/ (block-diagrams, ensemble-context), copilot-instructions.md
├── data/import/           Git-ignored local import drop zone
├── eval/, skills/         Empty placeholders (.gitkeep)
├── private/               Git-ignored operator runbooks; never publish secrets
├── release.json           Canonical version for every surface
├── AGENTS.md              Instructions for coding agents (CLAUDE.md and .github/copilot-instructions.md point here)
└── README.md              How to run it
```

Root files: `package.json` (repo commands: `pnpm dev`, `db:*`, `desktop:*`, `bridge:*`, `brand:*`, `version:*`), `pnpm-workspace.yaml`, `turbo.json` (TypeScript task graph; `pnpm dev` does not use it), `tsconfig.base.json`, `.env.example` (development configuration, [01 §3](01_TECH_STACK_AND_ENVIRONMENT.md#3-local-development-setup)), `LICENSE.md`.

## 2. Applications

```text
apps/hub-web/
├── app/                      login, signup, forgot, reset, verify, link, p/[token] (public links), shared/[id]
├── app/(hub)/                One folder per page: today, board, needs-me, runs, tasks, pages, projects,
│                             context, meetings, files, skills, workspace, code, plots, diagrams, metrics,
│                             recap, morning-brief, marketplace, connect, settings, spaces, shared,
│                             shared-by-me, completed, trash, welcome, start, …
├── components/<surface>/      One folder per surface (board, editor = TipTap, files = viewers per format,
│                             connectors/brands = logos, …); ui.tsx is the kit
├── lib/                      API clients, SSE, auth, access/presence, connect configs, export, files
│                             (PDF/Word conversion, slide reader, export back), plots
└── e2e/                      Playwright scripts run by hand; assistant-tile-catalog.ts runs in `test`

apps/hub-api/src/
├── app.ts, index.ts          HTTP app factory (used by tests) and server entry
├── routes/                   REST + SSE, one module per area
├── assistant/                Hub action layer: loop, registry, tools/, playbooks in skills/*.md (docs/11)
├── bridge/                   Context Bridge resolution and briefs (docs/CONTEXT_BRIDGE.md)
├── connectors/               Google, Microsoft, GitHub, Slack, Linear; OAuth, tokens, ingest, triage, sync,
│                             people sync; mcp/ (remote MCP client); items/ (connected items, docs/31);
│                             meetings/ (meeting-note vendors)
├── imports/                  Importers from other apps, CSV/zip readers, mapping, jobs (docs/27)
├── files/                    File store and caps, extraction worker, pages from files, imports, attachments (docs/32)
├── context/, people/, projects/   Context board order, people views, identities, project links
├── cowork/                   Morning brief, quick capture, nudges, weekly recap, meetings
├── jobs/                     In-process scheduler, retention, claim locks, skill mining, blob sweep
├── workspace/                Agent execution: queue worker, engines/, sandbox/, trust, runner (docs/06)
├── repo/                     Repository reads and mirrors for the Code tab and diagrams
├── remote/, devices/         Remote tasks on a paired computer (docs/25)
├── subscriptions/            Subscription sign-in, detection and assistant turns on paired computers (docs/30)
├── included/                 Included-model catalog, budget and accounting (docs/33)
├── spaces/, sharing/         Spaces (docs/28); sharing policy, gate, links, presence (docs/29)
├── analytics/                Interaction log and Prometheus metrics (docs/07 §1.3)
├── desktop/                  Desktop sidecar entry and helpers
├── runtime/                  In-process model adapters (desktop/CLI) and plot worker
├── plots/, diagrams/         Plot store, service, cache (docs/20); block-diagram revisions
├── pages/                    Page store, history, Markdown, live co-editing
├── marketplace/, layouts/, desk/   Templates, Today layouts, desk entries
├── ensemble/                 @ensemble surfaces, citations, watchers
├── themes/                   Open VSX theme fetch for the Code tab
├── node/                     Ensemble Node: rooms, routing, node turns, approvals, run reports (docs/35)
├── services/                 Shared task and record writes
├── test/                     HTTP harness, route coverage, temporary folders
└── lib/                      auth, undo, ledger, redis, sse, prisma, secrets, blob store, office, …
apps/hub-api/prisma/          schema.prisma, migrations/, seed.ts, demo-branch.ts, demo/
apps/hub-api/scripts/         migrate-deploy.mjs, route-inventory.ts, assistant-eval.ts, secret and deletion-log tools

apps/agent-runtime/ensemble_agent/
├── main.py                   FastAPI app: health, chat/tools (+ stream), search, complete, models, credentials, plots
├── models.py                 Provider adapters (Gemini, OpenAI, Anthropic, Copilot, Mistral, OpenRouter, Ollama)
├── credentials.py, vault.py  Per-user encrypted keys; included.py, hosted_access.py, redact.py beside them
├── orchestrator/, workers/   Planner, executor and task-type plans; not used by workspace assignment
├── tools/, audit/            Tool catalog and guarded writes; ledger writer
└── plots/                    Matplotlib parse/run worker
apps/agent-runtime/tests/     pytest suite

apps/landing/                 app/ (home, four topic pages, /download, /privacy, /terms, robots, sitemap), lib/
                              (site, topics, download.ts install data), public/ (install.sh, install.ps1, llms.txt,
                              IndexNow key), scripts/indexnow.mjs, vercel.json (script headers, ensemblework.app redirects)
apps/context-bridge/          src/ (MCP server; exports ./server, ./hub, ./config), clients/ (editor configs), test/, scripts/
apps/cli/                     src/ (commands, tui/, login, sidecar, editors, services), scripts/build.mjs
                              (esbuild → dist/ensemble.mjs), bin/ensemble (POSIX launcher), launcher/ (Go, Windows)
apps/desktop/                 src-tauri/ (Rust shell: sidecar, site, assets, diagnostics), ui/ (offline page)
apps/quick-capture/           src-tauri/ + ui/
```

## 3. Scripts

| Script | What it does |
|---|---|
| `dev.mjs` | `pnpm dev`: hub-api, hub-web and agent-runtime together |
| `agent-dev.sh` | `pnpm dev:agent`: creates `apps/agent-runtime/.venv`, starts the agent on 5055 |
| `doctor.sh` | `pnpm run doctor`: checks Node, pnpm, Python, Docker and `.env` |
| `ensemble-hook.mjs` | Sends Claude Code, Codex, Copilot and Cursor permission prompts and questions to Needs me |
| `ensemble-ask-mcp.mjs` | Stdio MCP server for agents Ensemble starts: `ask_person` and assistant-turn tools |
| `build-ensemble-brand.mjs`, `check-icons.mjs` | `pnpm brand:build` / `brand:check` (icons, motion bundles, fallback pages, `design/`); ICO/ICNS validation |
| `build-brand-logos.mjs` | Connector logo modules from `components/connectors/brands` (`--check` in `full-checks.yml`) |
| `build-landrun.mjs` | Builds the pinned Landlock helper for the Linux sandbox |
| `release-version.mjs` | `pnpm version:sync` / `version:check` from `release.json` |
| `export-desktop-web.mjs`, `assemble-desktop-sidecar.mjs` | `pnpm desktop:export` (static Hub export); `pnpm desktop:sidecar` (Node + hub-api into Tauri resources, `--dest` for the CLI) |
| `desktop-*.mjs`, `build-mac-dmg.sh`, `package-mac-dmg.mjs`, `publish-desktop-recovery.mjs`, `verify-desktop-signatures.*` | Desktop API discovery and process spawning, build matrix, signed update manifest, Mac disk images (`pnpm desktop:dmg`), recovery publishing, signature checks ([DESKTOP](DESKTOP.md)) |
| `package-cli.mjs`, `smoke-cli-package.mjs` | `pnpm cli:package --target <t>`; smoke test of an extracted archive |
| `measure-*.mjs`, `ui-walk.mjs`, `verify-followup.mjs` | Playwright performance and UI probes ([CACHING](CACHING.md)) |

## 4. Where a change usually belongs

| Change | Start here |
|---|---|
| Page, component, styling, browser behaviour | `apps/hub-web/` |
| Landing page | `apps/landing/` |
| Endpoint, persistence, connector, scheduled job, assistant tool | `apps/hub-api/` |
| Model provider, plot export | `apps/agent-runtime/`, and `apps/hub-api/src/runtime/` for the in-process path |
| Shared API or domain shape | `packages/shared-types/` |
| Editor access to context | `apps/context-bridge/`, `apps/hub-api/src/bridge/`, `apps/hub-api/src/routes/mcp.ts` (hosted `/mcp`) |
| Ensemble Node (nodes, rooms, node turns) | `apps/hub-api/src/node/`, the CLI's Node tab in `apps/cli/src/tui/node.ts`; the website is the separate `ensemblework/ensemble-node` repository ([35](35_ENSEMBLE_NODE.md)) |
| CLI, installers, releases | `apps/cli/`, `scripts/package-cli.mjs`, `packaging/`, `apps/landing/public/`, `.github/workflows/cli-release.yml` |
| Spaces | `apps/hub-api/src/spaces/`, the space cookie in `apps/hub-api/src/lib/auth.ts`, `apps/hub-web/components/shell/space-switcher.tsx`, `apps/hub-web/app/(hub)/spaces/` ([28](28_ENSEMBLE_SPACES.md)) |
| Sharing, contacts, presence | `apps/hub-api/src/sharing/` (`policy.ts` classes every route), `apps/hub-web/components/sharing/`, `app/(hub)/shared/`, `app/shared/[id]/`, `app/p/[token]/`, `apps/hub-web/lib/{access,presence}.ts` ([29](29_SHARING.md)) |
| Live co-editing | `apps/hub-api/src/pages/collab*.ts`, `live.ts`, `routes/collab.ts`; `apps/hub-web/components/editor/collab.ts`, `components/pages/use-collab.ts`; schema as data in `packages/shared-types/src/page-schema.json` (`pnpm --filter @ensemble/hub-web page-schema`) ([29 §5](29_SHARING.md#5-live-presence)) |
| Database schema | A new migration in `apps/hub-api/prisma/migrations/` |
| Desktop shell | `apps/desktop/` |
| Brand assets | `packages/brand`, then `pnpm brand:build` ([BRAND](BRAND.md)) |
| Local infrastructure, home-server or VM deploy; isolated web testing | `infra/`, `infra/deploy/testing/` ([36](36_WEB_TESTING.md)) |
| CI, deploys, CLI releases | `.github/workflows/` |
| Documentation | `docs/`, in the same change ([AGENTS.md](../AGENTS.md)) |

`node_modules/`, `.next/`, `out/`, `dist/`, `.venv/`, `__pycache__/`, `*.egg-info/`, `.turbo/`, `target/`, test caches, `docs/screenshots/` and `.ensemble/` are outputs or local state. They are git-ignored; do not put source code there.
