# 01 · Stack, configuration and development

Code inspected **18 Oct 2026**. The root [README](../README.md) owns the first-run sequence; `.env.example`, package manifests and workflow files own exact configuration and commands. Deployment credentials and operator-specific instructions stay in `private/`.

## 1. Stack at a glance

| Layer | Current implementation |
| --- | --- |
| Hub | Next.js 15 App Router, React 19, TypeScript, Tailwind and React Query |
| Documents / code / graphs / plots | TipTap/ProseMirror, CodeMirror, React Flow, ECharts; domain-specific editors around shared types |
| API | Node 22+, Fastify, Zod and Prisma |
| Hosted/local development data | PostgreSQL 16 with configured extensions; Redis 7 for shared transient state, rate limits and activity |
| Durable jobs | PostgreSQL `WorkspaceJob`; in-process claim/worker and scheduler in hub-api |
| Native/CLI data | Local Node API with PGlite and an in-memory Redis-compatible path; no Docker requirement for packaged local use |
| Model transport | Python 3.11+ FastAPI runtime for the hosted path; TypeScript adapters inside the local sidecar |
| Original files | Private database-backed file store, format-aware extraction and bounded workers |
| Plot computation | Browser runtime for hosted plotting plus the separate Python/server/native worker paths |
| Desktop / quick capture | Tauri 2 Rust shells |
| Editor context | MCP SDK server over stdio/HTTP; hosted `/mcp` is read-only |
| Realtime | Scoped SSE; page collaboration has a separate document authority/version protocol |
| Logging | Pino in API, structlog in Python; application audit history |

The model layer is multi-provider. A runtime/catalog entry is distinct from an external coding engine and from a subscription bridge. See [30](30_ENGINES.md).

## 2. Environment & tenancy

### 2.1 Accounts and spaces

Local development, packaged local use and hosted public use share the domain model but have different credential/execution boundaries. Content is space-scoped. Login sessions, connector grants, personal model keys, paired devices and sharing permissions are separate concerns ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)).

Public hosted model/connector/agent calls require verified email. Only verified exact `ENSEMBLE_OPERATOR_EMAILS` accounts can use restricted host credentials/execution; open hosted deployments keep `ENSEMBLE_SERVER_RUNNER=off`. Ordinary accounts execute code on paired computers. Never enable development auth bypass on public hosting.

### 2.2 Connector OAuth

Login `AUTH_*` apps identify a person; connector apps authorize product access. Providers can use explicit `<PROVIDER>_CLIENT_ID/SECRET`, saved encrypted operator apps, or the supported sign-in-app fallback. Native connector callbacks use `HUB_API_PUBLIC_URL/api/connectors/<provider>/callback`; vendor MCP has its own callback. Register exact callbacks for the actual environment.

`connectors/products.ts` owns Google/Microsoft suite scopes and product defaults. It currently uses read-only mail, opt-in calendar write/availability and supported Drive/Office access; the old Mail.Send/Teams-send/OBO scope list is not an installation requirement. [03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens) documents the actual product/scopes and token paths. Secrets never belong in public docs.

### 2.3 Content acquisition

Connect saves a grant, not content. Manual Sync people reads bounded contact metadata with no model call. Requested search/attach/import/file upload acquires content through its own path. Scheduled generic fetch currently reads nothing even if the old environment switch is enabled. [03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md).

## 3. Local development setup

Prerequisites: Node 22+, pinned pnpm (`package.json`), Docker with Compose, Python 3.11+. Follow the root README for OS-specific installation and troubleshooting.

```bash
cp .env.example .env
pnpm install
docker volume create ensemble_pg
pnpm infra:up
pnpm db:migrate
pnpm dev
```

The database volume is persistent. `db:migrate` deploys pending migrations and repairs supported pre-migration databases without resetting rows. **Never run `prisma migrate reset`.** `db:push` is not the normal setup/deployment path.

`scripts/dev.mjs` starts web :3000, API :4000 and agent :5055. `scripts/agent-dev.sh` creates the Python virtual environment on first use. Run **one** agent-runtime process: `dev:agent` is for starting only that component, not an addition to `pnpm dev`. The default is 5055 because macOS commonly reserves 5000. `pnpm run doctor` checks this repo's environment; `pnpm doctor` is a different pnpm command.

### Configuration groups

`.env.example` is authoritative and includes comments/defaults. These are navigation aids, not another env template:

| Group | Key examples |
| --- | --- |
| Database/origins | `DATABASE_URL`, `REDIS_URL`, `HUB_API_HOST`, `HUB_API_PORT`, `HUB_WEB_ORIGIN`, `HUB_API_PUBLIC_URL`, `NEXT_PUBLIC_HUB_API`, `ENSEMBLE_COOKIE_DOMAIN` |
| Signup/identity | `ENSEMBLE_SIGNUP_MODE`, `ENSEMBLE_SIGNUP_ALLOWLIST`, `AUTH_GOOGLE_*`, `AUTH_GITHUB_*`, `AUTH_MICROSOFT_*`, Resend and Turnstile keys |
| Host restrictions | `ENSEMBLE_OPERATOR_EMAILS`, `ENSEMBLE_SERVER_RUNNER`, `ENSEMBLE_TERMINAL`; development bypass/tool flags only for isolated local work |
| Internal/secret storage | `ENSEMBLE_INTERNAL_TOKEN`, `ENSEMBLE_BRIDGE_TOKEN`, `ENSEMBLE_SECRET_KEY`, local secret-key file |
| Personal provider fallbacks | Provider API variables, endpoint variables and role/model settings; hosted ordinary users cannot borrow operator keys |
| Connector apps | Provider client variables, Google Picker settings, optional vendor MCP clients; [03](03_MODULE_CONTEXT_ENGINE.md) |
| Included AI | `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_API_KEY`, `ENSEMBLE_INCLUDED_MODELS`, monthly account/global limits and output cap; [33](33_INCLUDED_AI.md) |
| Workspace/local runtime | `ENSEMBLE_WORKSPACE_ROOT`, `ENSEMBLE_DATA_DIR`, discovery/state directories, queue/remote-loop/scheduler switches |
| Hosted quotas | Connector, job, dataset and file limits; account-wide across owned spaces where specified |
| Extraction/plots | Document enrichment switch, file-store ceiling, plot worker concurrency/memory; [32](32_FILES.md), [20](20_PLOTS_DESIGN.md) |
| Diagnostics | Log level, health and route/model/request limits; read each variable's implementation before relying on it |

Legacy variables can remain for compatibility without activating a feature. In particular, `ENSEMBLE_FEATURES` is not today's module registry, and `ENSEMBLE_LOG_TO_FILE`/`ENSEMBLE_LOG_RETENTION_DAYS` do not implement a file-log sink.

## 4. Libraries and runtime ownership

Package manifests and lockfiles contain exact versions. Important dependencies include Fastify/Prisma/Zod, React Query, TipTap, CodeMirror, ECharts/React Flow, the MCP SDK, WebAuthn, `fflate`, CSV/Office readers and writers, PGlite and the brand tooling. `jspdf` supports server PDF export as well as the separate browser path.

Python includes FastAPI/httpx/provider adapters and the scientific/export stack. Provider API keys can be encrypted/resolved by either runtime according to deployment; the obsolete claim that only Python holds keys is false for native/CLI use. `packages/prompts` and `apps/skill-forge` are stubs; active prompts and personal learning live in their owning API/runtime modules.

## 5. Data storage design (Postgres)

One Prisma migration history manages ordinary tables in `public`; logical context/audit/skills areas are not separate database schemas. The schema includes vector/tsvector fields, but shared retrieval does not currently fill/query them as a semantic ranker. Configuring an embedding key does not enable a missing retrieval pipeline.

`lib/ledger.ts` serializes a per-space hash-linked history. It is not protected by a shipped INSERT-only database role and configured retention/deletion can remove rows. The verification endpoint checks link continuity, not full content-hash recomputation. [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md).

SQL account-lifetime constraints intentionally differ from Prisma relation metadata. New migrations must retain them; use the existing schema-drift tests rather than accepting generated DROP statements. [00 §7](00_PROJECT_OVERVIEW.md#7-core-domain-model-shared-across-modules).

## 6. Model usage policy

### 6.1 Profiles and discovery

Low (`easy`), Medium, High and Max profiles hold `{provider, model, effort}`. The shared defaults are in `packages/shared-types/src/assistant.ts`; effective hosted defaults can select included models when the configured provider has no usable key. Avoid copying a model-name/default table into docs: availability depends on the person's catalog and enabled operator deployments.

`GET /api/models` reads cached provider discovery (`lib/model-catalog.ts`); `POST /api/models/refresh` refreshes configured providers without inference. Keys/catalog fingerprints, weekly freshness and error retry paths control refresh. Saving/removing a key invalidates its provider catalog. A cold discovery failure is not a fabricated available model list.

Provider and model are explicit; ambiguous model-only selection is refused. Supported thinking comes from discovery/capability helpers in `model-efforts.ts` and `lib/model-meta.ts`. `default` sends no level. Unsupported effort is rejected before a call rather than silently substituted. Context window metadata is informational; no user control selects a different provider context-window tier.

### 6.2 Callers and credentials

Tasks pin their profile on assignment. Assistant/inline/brief/enrichment callers resolve the appropriate saved profile/role. Compatibility role/env defaults remain for older jobs and isolated callers; they are not permission to run arbitrary undiscovered models. A partial settings patch changes only submitted fields.

Personal API keys, supported local subscriptions and included models are distinct credential/funding paths. Subscription calls execute on the selected paired computer. External engines use their own local sign-in. Hosted ordinary users cannot fall back to the operator's environment, CLI login or host Ollama. Copilot's HTTP adapter and a Copilot CLI handoff are different integrations.

### 6.3 Usage and estimates

Run steps and model metrics retain actual reported model and token counts where available. Provider dollar/credit estimates remain estimates; unknown rates are not invented as free or one credit. Historical requested models are not rewritten after Settings changes. Included credits use actual reservation/settlement, not the legacy estimate multiplier.

### 6.4 Included AI

The configured `ensemble` catalog can offer the supported Azure deployments. Default account allowance is **20,000 credits per UTC month**, constrained also by the operator's global monthly ceiling and worst-case per-call reservation. Enabled deployment IDs determine what is offered; a deployment must exist and have quota. Included models also work through an authenticated paired desktop/CLI, without copying Azure credentials. Local-only computers must connect first. [33](33_INCLUDED_AI.md) owns catalog and accounting details.

## 7. Coding conventions

TypeScript is strict; wire shapes use shared Zod schemas. `pnpm typecheck` includes release-version consistency. There is no repository-wide ESLint/Prettier or Python ruff/mypy configuration to claim as a required gate. Feature/module availability is enforced by shared modules and `lib/module-gate.ts`, not the unused env feature placeholder.

Writes use the owning service's transaction, authorization, ledger and Undo paths. The Python guarded-tool policy is specific to its callers; it is not the implementation of every TypeScript assistant or workspace write. Follow [AGENTS](../AGENTS.md) and update docs with behavior.

## 7a. Logs

API Pino and Python structlog write console logs; server services use the journal (`journalctl --user -u ensemble-api` on the home server, `journalctl -u ensemble-api` on a VM). Redaction helpers cover known patterns on their implemented paths, not a promise that arbitrary user content is anonymized. File logging/rotation is not implemented by the legacy `ENSEMBLE_LOG_*` placeholders. Keep credentials, original request headers and tokens out of prompts/logs.

## 8. CI and deploys

Workflow files are authoritative for pinned action/runtime versions. Required checks include the API, web/shared packages, Python, CLI, production builds and OS sandbox matrix.

Code inspected 18 Oct 2026. Operational access, host identities and recovery procedures belong in the ignored `private/` runbooks.

**`.github/workflows/ci.yml`** runs on every pull request and every push to `main`, with parallel jobs, including a four-runner sandbox matrix:

| Job | What it runs |
|---|---|
| Typecheck and unit tests | `pnpm db:generate`, `pnpm typecheck`, `node scripts/build-brand-logos.mjs --check` (the connector logo modules match `components/connectors/brands`), `pnpm brand:check`, icon-container checks, and the `brand`, `shared-types`, `block-diagrams`, `ide-theme` and `hub-web` tests. The `hub-web` plot tests render with matplotlib, so the job installs `apps/agent-runtime` and sets `PLOTS_PYTHON` |
| hub-api tests (Postgres + Redis) | `pgvector/pgvector:pg16` and `redis:7-alpine` service containers, `infra/sql/init.sql`, `pnpm db:migrate`, the Landlock helper (`scripts/build-landrun.mjs`, so the agent and remote end-to-end runs are sandboxed for real), the full `hub-api` suite (integration tests included, since a database is reachable), and `pnpm bridge:verify` |
| Sandbox escapes | Live escape tests (`src/workspace/sandbox/os-escape.test.ts`, plus the argument, trust and git-ceiling tests) on four runners, each with its own OS sandbox and no Docker: macOS (Seatbelt), Ubuntu 24.04 (Landlock through `landrun`, bubblewrap off), Ubuntu 22.04 (bubblewrap from the distribution) and Windows (the sandbox-runtime account, set up during the test; the runner is an administrator). `ENSEMBLE_REQUIRE_OS_SANDBOX=1` makes a missing sandbox a failure, not a skip |
| CLI tests and package smoke | `apps/cli` typecheck, tests (the test script builds `dist/ensemble.mjs` first) and build, then `scripts/package-cli.mjs --target linux-x64 --skip-sidecar` and `scripts/smoke-cli-package.mjs` on the archive |
| agent-runtime tests | Python 3.12, `pip install -e apps/agent-runtime pytest`, `pytest tests` |
| Production builds | `next build` for `apps/hub-web` (with placeholder `example.com` origins) and `apps/landing` |

Some `hub-web` tests can keep the process open after their assertions because of query-cache timers. Work-folder fixtures use canonical paths from `apps/hub-api/src/test/temporary.ts` (`/private/tmp` on Mac), so intended `/private/var` restrictions do not abort the scenarios. Device revocation's cross-process regression needs real Redis and reports an explicit skip for `memory://`. Plot-worker regressions run locally on Mac as well as in Linux CI.

Python-only Linux CI does not install Node workspace dependencies. The Mac launcher argv contract mocks executable/loader availability without launching anything; real Mac execution tests still use the installed Node/tsx sandbox choke point. Missing Mac launcher dependencies have a separate explicit failure regression.

**`.github/workflows/deploy.yml`** runs after `ci` succeeds on a push to `main`, or by hand (Actions → deploy → Run workflow, with `all`, `api`, `app` or `landing`). It does nothing until the repository variable `DEPLOY_ENABLED` is `true`.

1. **Promote.** If the commit is still the tip of `main` (CI runs can finish out of order), it fast-forwards the `production` branch to it. No force push: `production` only moves forward.
2. **API.** The API server follows `production` by itself: its `autodeploy.sh`, run every minute by `ensemble-autodeploy.timer`, fetches `origin/$ENSEMBLE_DEPLOY_BRANCH` and runs `update.sh` when it moved. Nothing connects in to the server. `update.sh` writes the commit to the commit file, and hub-api reports it as `commit` on `GET /health`. The workflow waits (up to 25 minutes) until `/health` reports the new commit and `/health/ready` is 200. A commit whose update fails is recorded in `autodeploy.failed` and not retried until a newer commit arrives. There are two installs of that loop:
   - **Home server** (`infra/deploy/home`, what serves `api.ensemblework.com`). One machine, run as its own user with no root: Postgres, Redis and a Cloudflare Tunnel are Docker containers from `compose.yml` (loopback ports apart from the `pnpm dev` ones, `restart: unless-stopped`); the API, agent, `ensemble-autodeploy.timer` and `ensemble-pg-backup.timer` are systemd user units, which start at boot because lingering is on. The tunnel dials out to Cloudflare, so the machine needs no open port, router rule or fixed IP. `setup.sh` installs it; everything lives in `~/ensemble-host` (`app/` checkout, `ensemble.env`, `ensemble.commit`, `state/autodeploy.failed`). Cron runs `watchdog.sh` every 15 minutes and once after boot: it starts stopped containers and units, restarts the agent and API when loopback `/health/ready` is not 200 for a minute, and restarts the tunnel when the public `/health` fails while loopback is ready. The nightly `pg-backup.sh` keeps seven dumps (and a tarball of the small state on disk) and copies each to the `ensemble-backups` blob container; what is already in the blob store is not copied again. `update.sh` takes the same dump, kept on the machine only (`--local`), before every migration, and stops the deploy if it fails.
   - **Monitoring on the home server** (`infra/deploy/home/observability`, optional, `observability/setup.sh`): Prometheus, Grafana, node-exporter and postgres-exporter in Docker on loopback, an Azure cost and storage timer, and Grafana on Tailscale devices through `tailscale serve`. Once installed (`~/ensemble-host/observability.env` exists), `update.sh` drops and recreates the analytics views around migrations and rebuilds the dashboards, and the watchdog keeps the containers and timer running. See [07 §1.3](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#13-the-operators-interaction-log-and-dashboards).
   - **VM** (`infra/deploy`, Ubuntu with root): Caddy on 443, system units, `/etc/ensemble.env`, `/etc/ensemble.commit` and `/var/lib/ensemble/autodeploy.failed`.
3. **Hub and landing page.** `.github/actions/vercel-deploy` runs `vercel pull`, `vercel build --prod` and `vercel deploy --prebuilt --prod` for each Vercel project. The Hub waits for the API step; the landing page does not. The upload carries no git metadata, because Vercel's Hobby plan refuses a deploy whose commit author is not the account owner.
4. **Search engines.** After the landing page is published, `apps/landing/scripts/indexnow.mjs` reads the live `sitemap.xml` and submits its addresses to IndexNow (Bing, and through it DuckDuckGo, Yahoo and Ecosia; also Yandex, Seznam and Naver). The key is public by design: it is the file `apps/landing/public/<key>.txt` and the `KEY` constant in the script, which must match. The step is `continue-on-error`, so a failed ping never fails a deploy. Google does not read IndexNow; it reads the sitemap through Search Console.

Repository secrets: `ENSEMBLE_API_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_APP`, `VERCEL_PROJECT_ID_LANDING`. The Vercel projects hold the build settings (root directory `apps/hub-web` or `apps/landing`) and the Hub's `NEXT_PUBLIC_*` values. Server secrets stay in the server's env file (`~/ensemble-host/ensemble.env` on the home server, `/etc/ensemble.env` on a VM) and never go to GitHub or Vercel.

`.github/workflows/desktop.yml` (desktop installers and macOS sandbox tests) also runs on every pull request; it is described in [DESKTOP.md](DESKTOP.md). Its *Export the desktop UI* step retries once, because the build's Google Fonts download sometimes fails on hosted runners.

**`.github/workflows/cli-release.yml`** runs on a tag `cli-v<version>` (it must match `apps/cli/package.json`) or by hand as a dry run. It builds and smoke-tests the CLI on macOS (arm64, Intel), Linux (x64, arm64) and Windows, builds `.deb`/`.rpm`, publishes a GitHub release with `--latest=false`, and pushes the Homebrew formula and Scoop manifest with deploy keys. Secrets: `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY` (write deploy keys on `ensemblework/homebrew-tap` and `ensemblework/scoop-bucket`), and optionally `WINGET_TOKEN` and `NPM_TOKEN`; a job whose secret is missing is skipped with a notice. Details: [26 §7](26_CLI.md#7-releases).

The as-built layout and commands are in the root [README](../README.md) and [`17_REPOSITORY_STRUCTURE.md`](17_REPOSITORY_STRUCTURE.md).

## 9. API regression tests

```bash
pnpm --filter @ensemble/hub-api test:public
pnpm --filter @ensemble/hub-api route:inventory
pnpm --filter @ensemble/hub-api route:inventory:check
```

`src/app.ts` exposes the production HTTP factory without listeners, schedulers, queues, or process signal handlers. `src/test/http.ts` creates real browser sessions and scoped API tokens against migrated **in-memory PGlite**; no Docker or model key is needed. It refuses to silently skip missing critical infrastructure. Optional `ENSEMBLE_TEST_DATABASE_URL` must identify a migrated dedicated PostgreSQL database whose name includes `test`, never an ordinary development or production database.

The PostgreSQL cleanup path checks whether an account-erasure test has already removed its fixture before deleting it again. This is fixture cleanup, not a change to real account-deletion error handling. Diagram parsing retains a 250 ms CPU-time budget rather than measuring preemption by unrelated parallel processes.

The public suite is included in the normal hub-api `test`: route-driven anonymous/bridge/device/module gates, account signup/recovery/OAuth, resource ownership/relationship isolation, hosted execution and concurrent quotas, uploaded-file erasure, and provider-compatible tool schemas. OAuth/JWKS/email/Turnstile/model interactions are mocked or locally signed fixtures; they spend no live model quota. The web `test` includes signup/recovery DOM tests; Python `test_http_routes.py` uses FastAPI TestClient for token, payload and provider-response contracts.

`apps/hub-api/scripts/route-inventory.ts` builds actual hosted and desktop route matrices and records auth/module/parameter/explicit-test metadata in `apps/hub-api/scripts/route-inventory.json`. `src/test/route-coverage.ts` lists explicit request contracts, not filename guesses. Resource/auth suites fail on unexecuted coverage claims. `--check` fails for stale inventory; missing explicit resource happy-path contracts currently warn (optional `--strict` fails). Generic gate coverage is **not** a claim that every endpoint is fully exercised.

The suites use isolated/mocked providers unless explicitly configured otherwise. A historical local failure or test count is not current verification; inspect the commit’s CI and relevant live checks.

## Brand asset commands

`pnpm brand:build` generates Woven Chorus icons, standalone native motion bundles and fallback pages from `packages/brand`, using Sharp and esbuild. `pnpm brand:check` verifies the generated manifest against the current sources and assets. `node scripts/check-icons.mjs` checks ICO/ICNS containers. The CLI's `ENSEMBLE_REDUCE_MOTION=1` disables its brand animation; `NO_COLOR` controls terminal color independently.


Packaged CLI/desktop launchers set `ENSEMBLE_INSTALL_PATH` internally . The remote loop checks it on a heartbeat to stop and unpair a surviving runtime after its installed launcher is removed. It is not a user setup variable. Native desktop reminders use the installed `tauri-plugin-notification`; the browser uses browser notifications.

## Canonical release and updater

`release.json` owns the version. `pnpm version:sync` writes package manifests, Tauri/Cargo configs/locks, Python metadata/runtime constant and the shared TypeScript constant; `pnpm version:check` rejects differences. Web/API/landing prebuilds, CLI/sidecar packaging and native Rust builds check it. `/health` and public `/api/version` report it. About shows the installed version, and `GET /api/version?updates=1` checks published CLI/desktop channels with a five-minute cache (30 seconds on failure).

Desktop publication requires signed updater packages for macOS arm64/x64, Windows x64 and Linux x64. `TAURI_SIGNING_PRIVATE_KEY` is a GitHub Actions secret; only its public key is in Tauri config. `scripts/desktop-release.mjs` validates the packages and manifest before a draft becomes public. OS code signing is separate and remains unconfigured. CLI publication still updates the Homebrew tap and Scoop bucket through their existing deploy keys.

The Context Bridge MCP server-info and the Python runtime’s health/OpenAPI version also report the canonical release; `version:sync` generates `ensemble_agent/version.py`.

Desktop target selection is in `scripts/desktop-targets.mjs`; manual dispatch accepts one supported target or `all`. Tag releases always select all targets and cannot publish without every signed updater package. Intel Mac builds create the app/updater with Tauri, then use `scripts/package-mac-dmg.mjs` to create and verify an APFS disk image without mounting it or asking Finder to arrange icons. Recovery builds on a branch only upload artifacts; publication remains gated separately. The packager has a native macOS fixture test.

Desktop recovery publication accepts original tagged-build and successful Intel-recovery run IDs on manual dispatch from `main`. `scripts/publish-desktop-recovery.mjs` requires both runs from this repository, the original run to match the immutable release tag, and identical app/package/version/lockfile trees. It downloads only the expected platform artifacts, validates the complete manifest and verifies each updater with the same `minisign-verify` library used by Tauri before publishing. No private signing key is needed to publish existing signed packages.

### Assistant action checks

The Hub API uses `jspdf` for the assistant's server PDF export; the browser's existing export remains separate. The web test command also runs `e2e/assistant-tile-catalog.ts --check` to keep the assistant's generated tile metadata aligned with the actual UI. The optional `apps/hub-api/scripts/assistant-eval.ts` runs real-model checks over synthetic in-memory workspaces and reports token/cache usage; it is not part of ordinary CI and requires an explicitly configured model transport. [34](34_ASSISTANT_ACTIONS.md) describes the action surface and limitations.
