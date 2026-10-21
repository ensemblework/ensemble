# 01 · Stack, configuration and development

The root [README](../README.md) owns the first-run steps. `.env.example`, `infra/deploy/ensemble.env.example`, package manifests and workflow files own exact configuration, versions and commands. Deployment credentials and operator runbooks stay in the git-ignored `private/` folder.

## 1. Stack at a glance

| Layer | Implementation |
| --- | --- |
| Hub | Next.js 15 App Router, React 19, TypeScript, Tailwind, React Query |
| Editors and views | TipTap/ProseMirror, CodeMirror, React Flow (`@xyflow/react`), ECharts |
| API | Node 22+, Fastify, Zod, Prisma |
| Data (dev and hosted) | PostgreSQL 16 with `vector`, `pg_trgm`, `uuid-ossp`; Redis 7 for transient state, rate limits, pub/sub |
| Durable jobs | `WorkspaceJob` rows; in-process claim, worker and scheduler in hub-api |
| Data (desktop and CLI) | Local Node API with PGlite and an in-memory Redis stand-in (`lib/memory-redis.ts`); no Docker |
| Model transport | Python 3.11+ FastAPI runtime for dev and hosted; TypeScript adapters in the local sidecar (`apps/hub-api/src/runtime`) |
| File originals | Postgres rows, or a private Azure Blob container with `ENSEMBLE_FILE_STORAGE=azure-blob` (`lib/blob-store.ts`) |
| Plot computation | Browser runtime on the web; Python/server and native workers elsewhere |
| Desktop and quick capture | Tauri 2 (Rust) |
| Editor context | MCP SDK server over stdio/HTTP; hosted `/mcp` is read-only |
| Realtime | Scoped SSE; page co-editing has its own version protocol |
| Logging | Pino (API), structlog (Python), plus the app's audit ledger |

## 2. Environment and tenancy

**Accounts and spaces.** Content is space-scoped. Login sessions, connector grants, model keys, paired devices and sharing permissions are separate concerns ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)). Hosted model, connector and agent calls need a verified email. Only verified accounts listed exactly in `ENSEMBLE_OPERATOR_EMAILS` may use host credentials or host execution; public deployments keep `ENSEMBLE_SERVER_RUNNER=off`, so ordinary accounts run code on paired computers. Production refuses to start with `ENSEMBLE_DEV_AUTH_BYPASS` on.

**Connector OAuth.** Login apps (`AUTH_*`) identify a person; connector apps authorize product access. A provider uses `<PROVIDER>_CLIENT_ID`/`_SECRET`, a saved encrypted operator app, or the matching sign-in app. Native callbacks are `HUB_API_PUBLIC_URL/api/connectors/<provider>/callback` (`connectors/oauth.ts`); vendor MCP has its own callback. `connectors/products.ts` owns the Google and Microsoft scopes: read-only mail, opt-in calendar write and availability, supported Drive and Office access ([03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens)).

**Content.** Connecting saves a grant, not content. Sync people reads bounded contact metadata with no model call; search, attach, import and upload bring content in; scheduled fetching reads nothing ([31](31_CONNECTORS_IN_USE.md)).

## 3. Local development setup

Prerequisites: Node 22+, the pnpm version pinned in `package.json`, Docker with Compose, Python 3.11+.

```bash
cp .env.example .env
pnpm install
docker volume create ensemble_pg
pnpm infra:up
pnpm db:migrate
pnpm dev
```

- The `ensemble_pg` volume persists data. `pnpm db:migrate` (`apps/hub-api/scripts/migrate-deploy.mjs`) runs `prisma migrate deploy`; a database made with `pnpm db:push` is aligned in place and its migrations recorded, without deleting rows. **Never run `prisma migrate reset`.**
- `scripts/dev.mjs` starts web :3000, API :4000 and agent :5055. `scripts/agent-dev.sh` creates `apps/agent-runtime/.venv` on first use. Run **one** agent runtime; `pnpm dev:agent` starts only that component. Port 5055 avoids macOS's use of 5000.
- `pnpm run doctor` checks this repo's environment (`pnpm doctor` is pnpm's own command).

### Configuration groups

`.env.example` (development) and `infra/deploy/ensemble.env.example` (servers) are authoritative and commented.

| Group | Examples |
| --- | --- |
| Database and origins | `DATABASE_URL`, `REDIS_URL`, `HUB_API_HOST`, `HUB_API_PORT`, `HUB_WEB_ORIGIN`, `HUB_API_PUBLIC_URL`, `NEXT_PUBLIC_HUB_API`, `ENSEMBLE_COOKIE_DOMAIN` |
| Signup and identity | `ENSEMBLE_SIGNUP_MODE`, `ENSEMBLE_SIGNUP_ALLOWLIST`, `AUTH_GOOGLE_*`, `AUTH_GITHUB_*`, `AUTH_MICROSOFT_*`, `EMAIL_PROVIDER` (Resend), Turnstile keys |
| Host restrictions | `ENSEMBLE_OPERATOR_EMAILS`, `ENSEMBLE_SERVER_RUNNER`, `ENSEMBLE_TERMINAL`; dev bypass and `ENSEMBLE_DEV_TOOLS` for isolated local work only |
| Secrets | `ENSEMBLE_INTERNAL_TOKEN`, `ENSEMBLE_BRIDGE_TOKEN`, `ENSEMBLE_SECRET_KEY` (or the local secret-key file) |
| Model providers | Provider keys, endpoints and role/model settings; hosted ordinary users never use operator keys |
| Connector apps | Provider client variables, Google Picker settings, vendor MCP clients ([03](03_MODULE_CONTEXT_ENGINE.md)) |
| Included AI | `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_API_KEY`, `ENSEMBLE_INCLUDED_MODELS`, `ENSEMBLE_INCLUDED_MONTHLY_CREDITS`, `ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD`, `ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS` ([33](33_INCLUDED_AI.md)) |
| Workspace and local runtime | `ENSEMBLE_WORKSPACE_ROOT`, `ENSEMBLE_DATA_DIR`, state directories, queue/remote-loop/scheduler switches |
| Hosted quotas | `ENSEMBLE_MAX_CONNECTORS`, `ENSEMBLE_MAX_JOBS_PER_DAY`, `ENSEMBLE_MAX_DATASET_BYTES`, `ENSEMBLE_MAX_DOCUMENTS`, `ENSEMBLE_MAX_DOCUMENT_BYTES`, `ENSEMBLE_FILES_TOTAL_MAX_BYTES` |
| Server storage and monitoring | `ENSEMBLE_FILE_STORAGE`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, `ENSEMBLE_BACKUP_CONTAINER`, `ENSEMBLE_METRICS_PORT`, `ENSEMBLE_INTERACTION_RETENTION_DAYS` |
| Extraction and plots | Enrichment switch, file-store ceiling, plot worker concurrency and memory ([32](32_FILES.md), [20](20_PLOTS_DESIGN.md)) |
| Diagnostics | `ENSEMBLE_LOG_LEVEL`, readiness and rate-limit settings |

`.env.example` also lists `ENSEMBLE_LOG_TO_FILE`, `ENSEMBLE_LOG_RETENTION_DAYS` and `ENSEMBLE_FEATURES`; no code reads them. Modules are gated by `packages/shared-types/src/modules.ts` and `lib/module-gate.ts`.

## 4. Libraries and runtime ownership

Manifests and lockfiles hold exact versions. Beyond §1: the MCP SDK, SimpleWebAuthn, `fflate`, Office/CSV readers and writers, `pdfjs-dist`, `@azure/storage-blob`, `prom-client`, PGlite; `jspdf` serves both the browser and the assistant's server PDF export. Python holds FastAPI, httpx, provider adapters and the plotting stack. Either runtime can resolve encrypted provider keys. `packages/prompts` and `apps/skill-forge` are stubs.

## 5. Data storage (Postgres)

One Prisma migration history manages all tables in the `public` schema. Vector and tsvector columns exist but nothing fills or queries them; an embedding key enables nothing.

`lib/ledger.ts` writes a per-space hash-linked history. No INSERT-only database role protects it, and retention and deletion can remove rows. Its verification checks link continuity, not full content hashes ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)).

SQL account-lifetime constraints differ from Prisma's relation model on purpose. New migrations must keep them; rely on the schema-drift tests rather than generated DROP statements ([00 §7](00_PROJECT_OVERVIEW.md#7-core-domain-model-shared-across-modules)).

## 6. Model usage policy

### 6.1 Profiles and discovery

Low (`easy`), Medium, High and Max profiles each hold `{provider, model, effort}`; defaults are in `packages/shared-types/src/assistant.ts`. Hosted defaults can pick included models when the configured provider has no usable key.

- `GET /api/models` reads cached discovery (`lib/model-catalog.ts`); `POST /api/models/refresh` refreshes without inference. A catalog refreshes after a week, sooner after an error, and when its key changes.
- A model chosen without its provider must match a tier's model or carry an unmistakable vendor prefix; otherwise it is refused (`lib/model-choice.ts`).
- Thinking levels come from `packages/shared-types/src/model-efforts.ts` and `lib/model-meta.ts`. `default` sends no level; an unsupported effort is rejected before the call. Context-window metadata is informational.

### 6.2 Callers and credentials

Tasks pin their profile when assigned. The assistant, inline asks, briefs and enrichment resolve their saved profile or role. A partial settings patch changes only the submitted fields.

Personal API keys, local subscriptions and included models are separate paths. Subscription calls run on the selected paired computer; external engines use their own sign-in. Hosted ordinary users never fall back to the operator's environment, CLI login or host Ollama. Copilot's HTTP adapter and a Copilot CLI handoff are different integrations.

### 6.3 Usage and estimates

Run steps and model metrics keep the reported model and token counts. Dollar and credit estimates stay estimates; unknown rates are not treated as free. Recorded models are not rewritten when Settings change. Included credits use real reservation and settlement.

### 6.4 Included AI

The `ensemble` catalog offers the enabled Azure deployments; each must exist and have quota. Each account gets **20,000 credits per UTC month**, bounded by the operator's global monthly ceiling and a worst-case per-call reservation. A paired desktop or CLI uses them without receiving Azure credentials ([33](33_INCLUDED_AI.md)).

## 7. Conventions and logs

- TypeScript is strict; wire shapes use shared Zod schemas. `pnpm typecheck` also runs `pnpm version:check`. There is no repository-wide ESLint, Prettier, ruff or mypy gate.
- Writes go through the owning service's transaction, authorization, ledger and Undo paths. The Python `tools/guarded.py` policy covers only its own callers. Follow [AGENTS](../AGENTS.md).
- Logs go to the console; servers use the journal (`journalctl --user -u ensemble-api` on the home server, `journalctl -u ensemble-api` on a VM). Redaction helpers (`lib/redact.ts`, `ensemble_agent/redact.py`) cover known secret patterns only. Keep credentials and tokens out of prompts and logs.

## 8. CI and deploys

Workflow files are authoritative for pinned action and runtime versions.

**`.github/workflows/ci.yml`** runs on every pull request and every push to `main`:

| Job | What it runs |
|---|---|
| Typecheck and unit tests | `pnpm db:generate`, `pnpm typecheck`, `node scripts/build-brand-logos.mjs --check` (connector logo modules match `components/connectors/brands`), `pnpm brand:check`, `scripts/check-icons.mjs`, the `brand`, `shared-types`, `block-diagrams` and `ide-theme` tests, the release/target script tests, and `hub-web` tests (with `PLOTS_PYTHON` set, because plot tests render with matplotlib) |
| hub-api tests (Postgres + Redis) | `pgvector/pgvector:pg16` and `redis:7-alpine` services, `infra/sql/init.sql`, `pnpm db:migrate`, the Landlock helper (`scripts/build-landrun.mjs`, so agent and remote end-to-end runs are really sandboxed), the full `hub-api` suite, `pnpm bridge:verify` |
| Sandbox escapes | `backends`, `os-escape`, `trust` and `guard-git` tests on four runners with no Docker: macOS (Seatbelt), Ubuntu 24.04 (Landlock via `landrun`, bubblewrap off), Ubuntu 22.04 (distribution bubblewrap), Windows (sandbox-runtime account, set up during the test). `ENSEMBLE_REQUIRE_OS_SANDBOX=1` turns a missing sandbox into a failure |
| CLI tests and package smoke | `apps/cli` typecheck, tests (which build `dist/ensemble.mjs` first) and build; `scripts/package-cli.mjs --target linux-x64 --skip-sidecar`, then `scripts/smoke-cli-package.mjs` on the archive |
| agent-runtime tests | Python 3.12, `pip install -e apps/agent-runtime pytest`, `pytest tests` |
| Production builds | `next build` for `apps/hub-web` (placeholder `example.com` origins) and `apps/landing` |

**`.github/workflows/deploy.yml`** runs after `ci` succeeds on a push to `main`, or by hand (Actions → deploy → Run workflow: `all`, `api`, `app` or `landing`). It does nothing unless the repository variable `DEPLOY_ENABLED` is `true`. One deploy runs at a time.

1. **Promote.** If the commit is still the tip of `main`, the workflow fast-forwards the `production` branch to it (never a force push).
2. **API.** The API server pulls; nothing connects in. `autodeploy.sh`, run every minute by `ensemble-autodeploy.timer`, fetches `origin/$ENSEMBLE_DEPLOY_BRANCH` and runs `update.sh` when it moved. `update.sh` writes `ENSEMBLE_COMMIT=<sha>` to the commit file, which hub-api reports as `commit` on `GET /health`. The workflow waits up to 25 minutes for `/health` to report the commit and `/health/ready` to return 200. A commit whose update fails is recorded in `autodeploy.failed` and not retried until a newer commit arrives.
3. **Hub and landing page.** `.github/actions/vercel-deploy` runs `vercel pull`, `vercel build --prod` and `vercel deploy --prebuilt --prod` for each Vercel project, after deleting `.git` (Vercel's Hobby plan refuses a deploy whose commit author is not the account owner). The Hub waits for the API step; the landing page does not.
4. **Search engines.** After the landing page publishes, `apps/landing/scripts/indexnow.mjs` submits the live `sitemap.xml` to IndexNow (Bing, and through it DuckDuckGo, Yahoo and Ecosia; also Yandex, Seznam and Naver). The key is public: `apps/landing/public/<key>.txt` and the script's `KEY` constant must match. The step is `continue-on-error`. Google reads the sitemap through Search Console instead.

Repository secrets: `ENSEMBLE_API_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_APP`, `VERCEL_PROJECT_ID_LANDING`. The Vercel projects hold build settings (root `apps/hub-web` or `apps/landing`) and the Hub's `NEXT_PUBLIC_*` values. Server secrets stay in the server's env file and never go to GitHub or Vercel.

### Home server (`infra/deploy/home`) — serves `api.ensemblework.com`

- One machine, run as its own user without root. `setup.sh` installs it (safe to rerun); everything lives in `~/ensemble-host`: `app/` checkout, `ensemble.env` (mode 0600, from the "Home server" block of `infra/deploy/ensemble.env.example`), `ensemble.commit`, `node/`, `cloudflared/`, `state/` (including `autodeploy.failed`), `backups/`, `logs/`, `bin/`.
- Postgres (`pgvector/pgvector:pg16`), Redis and the Cloudflare Tunnel are Docker containers from `compose.yml` with `restart: unless-stopped`; Postgres and Redis listen on loopback ports 15432 and 16379, and the API and agent on 14000 and 15055, so `pnpm dev` can run on the same machine. The tunnel dials out, so the machine needs no open port, router rule or fixed IP.
- The API, agent, `ensemble-autodeploy.timer` and `ensemble-pg-backup.timer` are systemd user units; lingering starts them at boot.
- Cron runs `watchdog.sh` every 15 minutes and once after boot. It starts stopped containers and units, restarts the agent and API when loopback `/health/ready` fails for a minute, and restarts the tunnel when the public `/health` fails while loopback is ready.
- `pg-backup.sh` runs nightly: a `pg_dump` plus a tarball of on-disk state, seven kept locally, each copied to the `ensemble-backups` blob container (`ENSEMBLE_BACKUP_CONTAINER`). File originals and plot tables already in blob storage are not copied again. `update.sh` takes a local-only dump (`--local`) before every migration and stops the deploy if it fails. `ENSEMBLE_SECRET_KEY` is not in backups.
- File originals and plot tables are stored in a private Azure Blob container (`ENSEMBLE_FILE_STORAGE=azure-blob`, [32 §2](32_FILES.md#2-where-files-live)).
- **Monitoring** (`infra/deploy/home/observability`, optional, `observability/setup.sh`): Prometheus, Grafana, node-exporter and postgres-exporter in Docker on loopback, hub-api metrics on `ENSEMBLE_METRICS_PORT`, an Azure cost and storage timer, and Grafana on Tailscale devices through `tailscale serve`. Once installed (`~/ensemble-host/observability.env` exists), `update.sh` drops and recreates the analytics views around migrations and rebuilds the dashboards, and the watchdog keeps the containers and timer running ([07 §1.3](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#13-the-operators-interaction-log-and-dashboards)).

### VM install (`infra/deploy`)

An alternative install of the same pull loop on Ubuntu 24.04 with root: `setup.sh /etc/ensemble.env`, Caddy on 443, system units, `/etc/ensemble.env`, `/etc/ensemble.commit` and `/var/lib/ensemble/autodeploy.failed`. Its logs are under `sudo journalctl -u ensemble-autodeploy`.

### Other workflows

- **`.github/workflows/desktop.yml`** builds desktop installers and runs macOS sandbox tests on every pull request ([DESKTOP](DESKTOP.md)). Its *Export the desktop UI* step retries once, because the Google Fonts download sometimes fails on hosted runners.
- **`.github/workflows/cli-release.yml`** runs on a `cli-v<version>` tag (matching `apps/cli/package.json`) or by hand as a dry run. It builds and smoke-tests the CLI on macOS (arm64, Intel), Linux (x64, arm64) and Windows, builds `.deb`/`.rpm`, publishes a GitHub release with `--latest=false`, and pushes the Homebrew formula and Scoop manifest. Secrets: `HOMEBREW_TAP_DEPLOY_KEY`, `SCOOP_BUCKET_DEPLOY_KEY` (write deploy keys on `ensemblework/homebrew-tap` and `ensemblework/scoop-bucket`), optional `WINGET_TOKEN` and `NPM_TOKEN`; a job whose secret is missing is skipped with a notice ([26 §7](26_CLI.md#7-releases)).

## 9. API regression tests

```bash
pnpm --filter @ensemble/hub-api test:public
pnpm --filter @ensemble/hub-api route:inventory
pnpm --filter @ensemble/hub-api route:inventory:check
```

- `src/app.ts` builds the production HTTP app without listeners, schedulers, queues or signal handlers. `src/test/http.ts` creates real browser sessions and scoped API tokens against migrated **in-memory PGlite**; no Docker or model key is needed, and missing critical infrastructure fails instead of skipping. `ENSEMBLE_TEST_DATABASE_URL` may name a migrated, dedicated PostgreSQL database whose name contains `test`.
- `test:public` runs inside the normal hub-api `test` and ends with `route:inventory:check`. It covers route gates; signup, recovery and OAuth; resource isolation; hosted execution and quotas; file erasure; provider-compatible tool schemas. OAuth, JWKS, email, Turnstile and model calls are mocked or locally signed.
- `apps/hub-api/scripts/route-inventory.ts` writes the hosted and desktop route matrices to `scripts/route-inventory.json`; `src/test/route-coverage.ts` lists explicit request contracts. `--check` fails on a stale inventory; missing happy-path contracts only warn unless `--strict`.
- Work-folder fixtures use `src/test/temporary.ts` (`/private/tmp` on macOS). The device-revocation cross-process test needs a real Redis and skips on `memory://`. Some `hub-web` tests hold the process open after their assertions because of query-cache timers.
- `pnpm --filter @ensemble/hub-web test` first runs `e2e/assistant-tile-catalog.ts --check`, which keeps the assistant's generated tile metadata in line with the UI. `apps/hub-api/scripts/assistant-eval.ts` runs opt-in real-model checks over synthetic in-memory workspaces and reports token and cache usage; it is not in CI and needs a configured model transport ([34](34_ASSISTANT_ACTIONS.md)).

## 10. Brand, versions and releases

- `pnpm brand:build` (`scripts/build-ensemble-brand.mjs`, Sharp and esbuild) generates icons, native motion bundles and fallback pages from `packages/brand` into the apps and `design/`. `pnpm brand:check` verifies the generated manifest; `node scripts/check-icons.mjs` checks ICO/ICNS containers. In the CLI, `ENSEMBLE_REDUCE_MOTION=1` turns off the brand animation and `NO_COLOR` controls color ([BRAND](BRAND.md)).
- Root `release.json` owns the version. `pnpm version:sync` (`scripts/release-version.mjs --sync`) writes package manifests, Tauri/Cargo configs and locks, Python metadata (`ensemble_agent/version.py`) and the shared TypeScript constant; `pnpm version:check` rejects differences. Web, API and landing prebuilds, CLI/sidecar packaging and native builds check it. `/health`, public `/api/version`, the Context Bridge server info and the Python runtime report it. `GET /api/version?updates=1` checks published CLI and desktop channels, cached five minutes (30 seconds after a failure).
- Desktop releases need signed updater packages for every platform (`TAURI_SIGNING_PRIVATE_KEY` is a GitHub Actions secret); OS code signing is not configured. Build matrix, packaging and recovery publishing are in [DESKTOP](DESKTOP.md).
- Packaged launchers set `ENSEMBLE_INSTALL_PATH` internally; the remote loop stops and unpairs a runtime whose launcher was removed. It is not a setup variable.
