# 01 · Tech Stack & Environment

**Principle:** boring, well-documented open tooling so building is fast; **pluggable connectors and model providers** so anyone can run it. Microsoft Graph / Entra remain *one* optional mail/calendar/Teams path (Outlook), not the product. Every choice below states the *why* and the *fallback*.

> **Direction** ([00](00_PROJECT_OVERVIEW.md#direction)): localhost first; Gmail + Outlook + GitHub + Teams; no ADO, no M365 Copilot, no Dev Box; Copilot / Cursor / Gemini / Claude / OpenAI as model options; Notion-like UI.

---

## 1. Stack at a glance

| Layer | Choice | Why | Fallback |
|---|---|---|---|
| Hub UI | Next.js 15 (App Router) + React 19 + TypeScript | Fast to vibe-code, SSR for briefing page, streaming for agent timeline | Vite + React SPA |
| UI kit | Tailwind + own components (`apps/hub-web/components/ui.tsx`), `lucide-react` icons, TipTap for pages, CodeMirror for code, ECharts for plots, React Flow (`@xyflow/react`) for graphs | Pages, properties, board — refine as it matures | shadcn/ui |
| Board / DnD | `@dnd-kit/core` | Lightweight kanban drag-and-drop | react-beautiful-dnd |
| Realtime | Server-Sent Events from hub-api (agent progress, new todos) | Simplest: no socket infra | Socket.IO / Azure Web PubSub |
| API gateway | Node 22 + Fastify + TypeScript, Zod validation | Auth, DB, jobs, connector OAuth, model-provider proxy | NestJS |
| Auth | Custom hashed-cookie sessions; email/password and Google/GitHub/Microsoft identity login; **separate connector OAuth** | Public per-user accounts or local mode | Providers require configuration |
| Data | PostgreSQL 16 + pgvector via Prisma | Tasks, runs, audit ledger, Engineer Graph, embeddings in one DB | SQLite for pure-local; Dataverse (P2) |
| Cache / queue | Redis 7 via `ioredis` (SSE fan-out, activity flags, rate limits). The workspace job queue lives in Postgres (`apps/hub-api/src/workspace/worker.ts`); the scheduler is in-process (`src/jobs/scheduler.ts`). The desktop build swaps Redis for an in-memory stand-in and Postgres for PGlite | Scheduled + event-driven jobs, rate limiting | — |
| Agent runtime | Python 3.11+ FastAPI service (`apps/agent-runtime`) with its own provider adapters over `httpx`; pandas / matplotlib for Plots | Holds model keys, talks to every provider through one chat/tools contract | — |
| LLMs | **Pluggable providers:** GitHub Copilot, Cursor, OpenAI, Anthropic (Claude), Google (Gemini). Complexity maps to Low / Medium / High / Max `{provider, model, effort?}`. Embeddings: any OpenAI-compatible embedding model (`ENSEMBLE_EMBEDDING_MODEL`, default `text-embedding-3-large`); semantic retrieval is not wired yet ([18](18_WHAT_IS_REAL.md#still-a-placeholder)) | Engineer picks keys; no vendor lock-in. Copilot model discovery is one adapter among the others | Single-provider env (`ENSEMBLE_LLM_PROVIDER=…`) |
| Tools protocol | **MCP in two directions:** Ensemble *consumes* MCP servers (GitHub, workspace, later others) and *serves* one of its own — `apps/context-bridge`, a read-only stdio server so VS Code / Cursor / Copilot CLI can retrieve Ensemble context (M7, [docs/13](13_MODULE_CONTEXT_BRIDGE.md)) | Uniform tool interface; the server side is the only mechanism that can reach a private local database from an editor | Direct SDK calls |
| Skills format | `SKILL.md` (agent-skills convention: YAML front-matter + markdown body + optional `scripts/`) | Human-readable, versionable, same shape as Copilot skills | JSON |
| Observability | Structured console logs (`pino` in hub-api, `structlog` in agent-runtime, [§7a](#7a-logs)); the audit ledger for agent actions | Auditability & debugging of runs | OpenTelemetry later |
| Hosting | **Localhost first:** Docker Compose runs only Postgres + Redis; `pnpm dev` runs web, API and agent. A VM deploy is in `infra/deploy`, the hosted Hub and the landing page (`apps/landing`) go to Vercel, and [§8](#8-ci-and-deploys) ships them; the desktop app runs everything locally ([DESKTOP.md](DESKTOP.md)) | Ship something anyone can run | — |
| Coding workspace | The in-Hub Code tab ([16](16_CODE_TAB.md)): review, edit, commit, guarded terminal. No VS Code extension | "Invoke a space to code myself" | Deep link `vscode://` with context file |
| Editor integration (M7) | `.vscode/mcp.json` and `~/.copilot/mcp-config.json` (the two shapes are mutually unreadable), a custom agent in `.github/agents/ensemble.md`, and an agent skill in `.github/skills/ensemble-context/` | Registration is what makes the bridge get used; a tool nobody invokes is not a feature ([docs/13 §6](13_MODULE_CONTEXT_BRIDGE.md#6-making-copilot-actually-use-it)) | Pasting context by hand |

---

## 2. Environment & tenancy

### 2.1 Development is local

1. **Run on your machine.** Docker Compose for Postgres + Redis. No Dev Box, no corporate tenant requirement.
2. **Connect your own accounts, read-first.** A fresh Hub is empty until you connect a source: that is a better starting point than one that is plausibly wrong. Sample data is opt-in; see [docs/03 §11](03_MODULE_CONTEXT_ENGINE.md#11-seed-data-opt-in-only).
3. **Write scopes are opt-in per connector** and still gated by the action policy ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)).

### 2.2 Connector OAuth (not a single Entra app)

Each source has its own client-id/secret (or CLI borrow). Outlook / Teams still use a Microsoft app registration *if* the user enables that connector — the Graph scopes below are the P0 set for that adapter only:

> A Microsoft app registration is only for the Outlook/Teams adapter, not the product identity. That adapter is not built yet ([18](18_WHAT_IS_REAL.md#connectors-read-only)).

Delegated Graph permissions (least privilege, P0 set):

| Scope | Used by |
|---|---|
| `User.Read`, `People.Read`, `User.ReadBasic.All` | People resolution, org context |
| `Mail.Read`, `Mail.Send` (P0: `Mail.ReadWrite` for drafts) | Mail digest, agent replies (drafts first) |
| `Calendars.Read` | Day planning |
| `Chat.Read`, `ChannelMessage.Read.All`, `ChatMessage.Send` (P1) | Teams digest, compose assist |
| `OnlineMeetingTranscript.Read.All`, `OnlineMeetings.Read` | Meeting recap & action items |
| `Tasks.ReadWrite` (optional) | Mirror todos to Microsoft To Do / Planner |
| `Files.Read.All`, `Sites.Read.All` | Docs referenced in tasks |

- **Redirect URIs:** `http://localhost:3000/auth/callback`, `https://<aca-url>/auth/callback`.
- Enable **On-Behalf-Of** for hub-api.
- Secrets in Key Vault (prod) / `.env` (dev, git-ignored).

> `OnlineMeetingTranscript.Read.All` was admin-only in the hackathon tenant. **Do not build an M365 Copilot paste workaround.** Connect Teams (and later other meeting sources) directly — [03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context--from-connectors-not-a-copilot-paste).

### 2.3 First-wave accounts

- **Gmail / Google Calendar:** Google OAuth (Gmail API + Calendar API). Read first; send is a gated write.
- **Outlook / Microsoft Calendar / Teams:** Microsoft OAuth using the scopes above, as one adapter among others.
- **GitHub:** GitHub App or fine-grained PAT, or borrow `gh auth token`. `GITHUB_ORG` has **no default** — left blank, the connector reports `not_configured` rather than reading from somewhere you did not choose. Ingestion may use REST directly (as built) rather than standing up an MCP process for two endpoints.
- **Azure DevOps: out.** Do not build an ADO connector.

### 2.4 Model providers (dev)

Set whichever keys you have. A missing provider is skipped, not fatal.

- GitHub Copilot (`COPILOT_API_KEY` / `GITHUB_TOKEN` / `gh auth token`) — model discovery and effort controls live in that adapter.
- OpenAI, Anthropic, Google Gemini, Cursor — OpenAI-compatible or first-party SDKs behind the same complexity → profile mapping ([§6](#6-model-usage-policy)).
- Embeddings: configure one embedding model or leave retrieval on keyword/tsvector until you do.

---

## 3. Local development setup

**Run the app from the root [README](../README.md).** It has the prerequisites (Node 22, pnpm 12, Docker, Python 3.11+), the exact command order, and fixes for the common failures. In short:

```bash
cp .env.example .env
pnpm install
docker volume create ensemble_pg
pnpm infra:up           # postgres (pgvector) + redis, loopback only
pnpm db:migrate         # prisma migrate deploy; never resets data
pnpm dev                # web :3000, API :4000, agent :5055
```

`pnpm dev` (`scripts/dev.mjs`) starts all three processes with pnpm; it does not call a global `turbo`. The first run creates `apps/agent-runtime/.venv` with any Python 3.11+ it finds (`scripts/agent-dev.sh`). `pnpm dev:agent` is that same agent process on its own; starting both binds port 5055 twice. Port 5000 is macOS AirPlay Receiver, so the agent does not use it. If a packaged host UI is served later, use a hostname (`localhost`), not a raw IP — browsers refuse passkeys on IPs ([16 §5](16_CODE_TAB.md#passkeys-and-addresses)).

### `.env.example`

The authoritative copy is `.env.example` in the repo root; every variable there has a comment. The groups are:

| Group | Variables |
|---|---|
| Local identity / public signup | `ENSEMBLE_DEV_AUTH_BYPASS`, `ENSEMBLE_DEV_USER_ID`, `ENSEMBLE_DEV_TOOLS`, `ENSEMBLE_SIGNUP_MODE`, `ENSEMBLE_SIGNUP_ALLOWLIST`, `ENSEMBLE_OPERATOR_EMAILS`, `ENSEMBLE_TERMINAL`, `ENSEMBLE_TIMEZONE`, `ENSEMBLE_AUTONOMY_LEVEL` |
| Account login and recovery | `AUTH_GOOGLE_CLIENT_ID/SECRET`, `AUTH_GITHUB_CLIENT_ID/SECRET`, `AUTH_MICROSOFT_CLIENT_ID/SECRET`, `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| Infra and origins | `DATABASE_URL`, `REDIS_URL`, `HUB_API_HOST`, `HUB_API_PORT`, `HUB_WEB_ORIGIN`, `NEXT_PUBLIC_HUB_API`, `ENSEMBLE_COOKIE_DOMAIN`, `NEXT_PUBLIC_SITE_URL`, `HUB_API_PUBLIC_URL` |
| Service tokens and secrets | `ENSEMBLE_INTERNAL_TOKEN`, `ENSEMBLE_BRIDGE_TOKEN`, `ENSEMBLE_SECRET_KEY` |
| Workspace and logs | `ENSEMBLE_WORKSPACE_ROOT`, `ENSEMBLE_WORKSPACE_IMAGE`, `ENSEMBLE_LOG_LEVEL`, `ENSEMBLE_LOG_TO_FILE`, `ENSEMBLE_LOG_RETENTION_DAYS`, `ENSEMBLE_FEATURES` |
| Models | `ENSEMBLE_LLM_PROVIDER`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `COPILOT_API_KEY`, `GITHUB_TOKEN`, `ENSEMBLE_MODEL_*`, `ENSEMBLE_EMBEDDING_MODEL` |
| Connectors | OAuth apps: `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET` (+ optional `MICROSOFT_TENANT_ID`, default `common`), `GITHUB_CLIENT_ID/SECRET` (each falls back to the matching `AUTH_*` sign-in app), `LINEAR_CLIENT_ID/SECRET`, `NOTION_CLIENT_ID/SECRET`, `ATLASSIAN_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`, `ZOOM_CLIENT_ID/SECRET`, `DOCUSIGN_CLIENT_ID/SECRET` with `DOCUSIGN_ENV=demo\|production`; Google Picker `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`; `ENSEMBLE_SCHEDULED_FETCH` (`off` by default; `on` restores scheduled fetching); `GITHUB_ORG`, `GITHUB_APP_*`; operator/local-only fallbacks `SLACK_USER_TOKEN`, `LINEAR_API_KEY`. Redirect URI `HUB_API_PUBLIC_URL/api/connectors/<provider>/callback` ([03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens)) |
| Limits and health | `ENSEMBLE_PLOT_CONCURRENCY`, `ENSEMBLE_PLOT_MEMORY_MIB` (64-2048, default 2048; Linux address space / Mac sampled resident memory), `ENSEMBLE_RATE_*` (including `ENSEMBLE_RATE_CLI_START_*`, `ENSEMBLE_RATE_CLI_TOKEN_*`, `ENSEMBLE_RATE_CLI_APPROVE_*` and `ENSEMBLE_RATE_MCP_*`), `ENSEMBLE_HEALTH_*` |
| Sidecar (desktop app and CLI runner) | `ENSEMBLE_DATA_DIR`, `ENSEMBLE_SECRET_KEY_FILE` (defaults to `secret.key` beside the data folder), `ENSEMBLE_REMOTE_STATE_DIR`, `ENSEMBLE_DISCOVERY_FILE`, `ENSEMBLE_REMOTE_LOOP=off` and `ENSEMBLE_AGENT_QUEUE=off` (an admin-only sidecar that never claims hosted work), `ENSEMBLE_SCHEDULER=off` |
| Hosted account quotas | `ENSEMBLE_MAX_CONNECTORS` (25 connected accounts and 25 enabled sync sources), `ENSEMBLE_MAX_JOBS_PER_DAY` (50, UTC), `ENSEMBLE_MAX_DATASET_BYTES` / `ENSEMBLE_MAX_DOCUMENT_BYTES` (104857600 each); positive integers. Jobs, bytes and connected accounts are summed over all of an account's Ensemble spaces ([28](28_ENSEMBLE_SPACES.md)); enabled sync sources are per space |

A key pasted in Settings → Assistant → Models → Manage keys wins over the same key in `.env`. In hosted production, environment/host CLI credentials are available only to verified exact `ENSEMBLE_OPERATOR_EMAILS` accounts; public accounts must bring their own key. Local development and desktop keep their existing fallback behavior. Login scopes are identity-only and never implicitly authorize a connector; the Google, Microsoft and GitHub connectors may reuse the sign-in OAuth client, but each person still approves the connector's own scopes.

The hosted terminal needs both `ENSEMBLE_TERMINAL=on` and operator access; `off` overrides user settings. All hosted Ollama/custom provider proxies are operator-only in this first release, including public custom proxy URLs; nonoperators can use Ollama on their paired computer. Account-email requests use `ENSEMBLE_RATE_EMAIL_LIMIT=5` per hour per IP by default; the signup/login buckets cover social initiation and recovery too.

Other variables referenced elsewhere in these docs:

| Variable | Where it is described |
|---|---|
| `ENSEMBLE_FEATURES` | §7 — reserved; not read yet |
| `ENSEMBLE_LOG_TO_FILE`, `ENSEMBLE_LOG_RETENTION_DAYS`, `ENSEMBLE_LOG_LEVEL` | §7a (only the level is read today) |
| `ENSEMBLE_WORKSPACE_ROOT`, `ENSEMBLE_WORKSPACE_IMAGE` | [06 A3](06_MODULE_WORKSPACE_AND_SURFACES.md#a3-the-filesystem-boundary-and-vs-code) |
| `ENSEMBLE_INTERNAL_TOKEN` | [03 §13](03_MODULE_CONTEXT_ENGINE.md#13-independent-document-context-artifacts--sync) — service-to-service auth between hub-api and agent-runtime |
| `ENSEMBLE_DEV_AUTH_BYPASS`, `HUB_API_HOST` | [13 §7](13_MODULE_CONTEXT_BRIDGE.md#7-security-and-why-read-only-is-not-negotiable) — `HUB_API_HOST` defaults to `localhost` |
| `ENSEMBLE_PAGE_INTEGRATION`, `ENSEMBLE_DOCUMENT_INTEGRATION`, `ENSEMBLE_REMINDER_INTEGRATION` | Opt-in integration test suites (03, 07) |

### `infra/docker-compose.yml` (services)

`postgres` (`pgvector/pgvector:pg16`) and `redis`. Their host ports are loopback only: `127.0.0.1:5432` and `127.0.0.1:6379`. They are not published on `0.0.0.0` or `[::1]` — Colima and Docker Desktop on Mac reject an IPv6 publish and then drop the IPv4 mapping too. `DATABASE_URL` and `REDIS_URL` use `127.0.0.1`, because `localhost` often resolves to `::1` first.

---

## 4. Key libraries

From the `package.json` and `pyproject.toml` files; check those for exact versions.

### TypeScript

- **hub-web:** `next` 15, `react` 19, Tailwind, `@tanstack/react-query`, `@dnd-kit/*`, TipTap (`@tiptap/*`, document pages), CodeMirror (`@codemirror/*`, `@uiw/react-codemirror`, Code tab and plot code), `echarts` (Plots), `@xyflow/react` (graphs), `lucide-react`, `simple-icons` (CC0 connector logos, imported one icon at a time), `jspdf`, `@simplewebauthn/browser` (passkeys)
- **hub-api:** `fastify` (+ `@fastify/cors`, `@fastify/compress`), `@prisma/client`, `zod`, `ioredis`, `pino`, `@simplewebauthn/server`, `fflate` (zips, including import uploads), `papaparse` (CSV/TSV imports, MIT), `jose` (OIDC JWT/JWKS validation), `docx` + `exceljs` + `pptxgenjs` (Word, Excel and PowerPoint files the assistant writes, `src/lib/office/`); `@electric-sql/pglite` + `pglite-prisma-adapter` for the desktop build
- SSE is implemented directly on the Fastify reply (`apps/hub-api/src/lib/sse.ts`) — there is no official `@fastify/sse` package, and a small hub avoids a third-party dep for something this simple.
- **context-bridge:** `@modelcontextprotocol/sdk`
- **block-diagrams:** `elkjs` for layout

### Python (`apps/agent-runtime`)

- `fastapi`, `uvicorn`, `pydantic` v2, `pydantic-settings`, `httpx`, `structlog`
- `psycopg[binary]`, `redis`, `cryptography` (key vault)
- Plots: `pandas`, `numpy`, `matplotlib`, `seaborn`, `scipy`, `pyarrow`, and readers for spreadsheet formats (`openpyxl`, `xlrd`, `xlwt`, `odfpy`, `numbers-parser`)
- Tests: `pytest` (not listed in `pyproject.toml`; install it into `.venv` to run `tests/`)

---

## 5. Data storage design (Postgres)

**Logical groupings:** `core` (tasks, runs, approvals, plan_steps), `context` (people, projects, repos, artifacts, embeddings), `skills` (skills, skill_versions, evidence), `audit` (ledger — append-only, hash-chained), `metrics` (events, baselines).

**As built these are expressed as table-name prefixes in `public`, not as separate Postgres schemas.** Prisma manages one migration history, and the pgvector extension plus the audit triggers all have to live alongside the tables that use them; splitting across five schemas bought nothing and complicated `migrate dev`. Extensions are declared in `schema.prisma` (`postgresqlExtensions`) so migrations own them — creating them in an init script instead makes Prisma report permanent schema drift.

- **Embeddings:** `artifact_chunks.embedding vector(3072)`. Prisma has no native vector type, so the column is `Unsupported("vector(3072)")`. Nothing fills or queries it yet; the Context Bridge reports that gap (`apps/hub-api/src/bridge/gaps.ts`). *(3072-d exceeds pgvector's 2000-d index limit, so an HNSW index needs a smaller model — see [03 §10](03_MODULE_CONTEXT_ENGINE.md#notes-from-the-earlier-prototype).)*
- **Audit ledger:** `audit_ledger(id, ts, user_id, actor, action, task_id, run_id, input_hash, output_hash, approval_id, prev_hash, hash)`; row-level INSERT only (revoke UPDATE/DELETE from the app role). Each row hashes the previous row **for the same user**, so tampering breaks the chain and `verify-ledger` reports the first bad row.

---

## 6. Model usage policy

Ensemble uses the engineer's **GitHub Copilot subscription through HTTP APIs, not the Copilot SDK**. It supports Chat Completions and Responses; it cannot intercept or configure unrelated VS Code or CLI sessions.

### 6.1 Complexity picks the model

Every task carries a **complexity**. *Settings → Assistant → Models* ("Which model each tier uses") maps Low, Medium, High and Max to a `{model, reasoningEffort?}` profile. Only assignment offers custom overrides; other surfaces resolve a tier. The internal `easy` key remains compatible with older tasks and settings.

| Tier | Default model | Use for |
|---|---|---|
| `easy` (Low) | `gemini-3.8-flash` | Mechanical work with one obvious answer |
| `medium` | `claude-haiku-4.5` | Ordinary drafting from a clear brief |
| `high` | `gpt-5.4-mini` | Multi-step reasoning, trade-offs, work that will be reviewed |
| `max` | `gpt-5.4-mini` | Design decisions, research, anything load-bearing |

`max` still repeats `high` by default to preserve existing cost expectations; the engineer can select any discovered, policy-enabled model supported by Ensemble's transport.

**Model discovery**

- `GET /api/models` returns the complete normalized provider catalogue — including records not selectable for chat (embeddings, internal models, disabled policies, unsupported endpoints) — and the effective profiles. `POST /api/models/refresh` bypasses the cache. **Both are metadata-only: neither makes an inference call.**
- Metadata is stored in persistent Redis with a **seven-day freshness TTL, not a key expiry**: after seven days the next read refreshes it, and errors retain the last successful timestamp and catalogue with an explicit stale/error status. Runtime caches are keyed by a credential/endpoint **fingerprint**, never the credential itself.
- Manual refresh forces provider discovery even while fresh. **No catalogue is fabricated on a cold failure.**
- The authenticated read-only probe on 2026-09-20 returned 40 records / 22 selectable chat models. Counts are observations, not a hard-coded allow-list. Limits and effort lists come from `GET /models`, not model-family heuristics. The provider returned no billing multipliers and no selectable context tiers.

**Reasoning effort** is offered wherever the provider advertises levels, on both transports — `reasoning: {effort}` on `/responses`, and `reasoning_effort` on `/chat/completions`. It was previously gated on `/responses` alone, which silently withheld thinking level from every Claude and Gemini model. Measured before changing it on one prompt: `gemini-3.8-flash` spent 116 reasoning tokens at low and 774 at high; `claude-opus-5` returned 36 and 57 completion tokens; and an invented level is refused with `invalid reasoning_effort` naming the supported ones — so the provider validates it rather than ignoring it. Separate thinking toggles/budgets are still not exposed.

**Context window** is displayed read-only, and there is **no context-size control** — it was removed rather than shown permanently disabled, because a knob that can never move is worse than no knob. `GET /models` reports one max context window per model and no selectable tiers; probed `context_size` and `context_window` request fields return 200 and change nothing, and there are no `-1m` model variants. A client's "context size" picker is a decision about how much context it puts in the prompt, not a provider parameter — which is why it costs more credits (more input tokens through the same window). The equivalent control, if it is ever wanted, belongs to the context-pack builder. A legacy `contextSize` on stored or in-flight data is **stripped, not rejected**, so an open browser tab cannot start failing validation on a field that no longer exists.

**Validation rules**

- Unsupported options fail validation in settings, assignments and runtime HTTP/queue entry points. A configured effort cannot be silently dropped by API fallback or model substitution. Legacy option-free defaults retain their established routing/fallback behaviour.
- `modelProfiles` is optional for old settings; legacy `modelByComplexity` is kept synchronized.
- A settings write applies **only the keys the request contained** (`parseSettingsPatch`): Zod keeps `.default()` inside `.partial()`, so parsing a one-field patch used to return every other field at its default, and one unrelated save silently reset the saved profiles.
- Queued payloads, workspace context snapshots, run checkpoints and retries **retain the chosen profile** rather than re-reading a later setting. The runtime validates again before spending.

Official reference sources: Copilot model metadata contract, Responses request construction, and Messages thinking transport. Ensemble does not implement the latter transport.

### 6.2 Roles are the fallback

Roles still exist for work that is not a task, and for jobs enqueued before the mapping existed. They are mapped in env (`ENSEMBLE_MODEL_*`), never in code.

A role **is** a tier when the engineer's settings can be read. Ingestion — extraction, todo proposal and meeting recaps — has no task to carry a complexity, so `hub-api/src/models/role-profile.ts` resolves the role to one: **classifier → Low, drafter → Medium, planner and coder → High**. The env values above are what remains when there is no settings store at all (scripts, fixtures). A configured but no-longer-selectable model is **not** quietly replaced by one of them: the caller falls back to its non-model path instead, so credits are never spent on a model the engineer did not choose.

The tier chooses *which* model; the role still chooses *how it is sampled*, so a drafting step keeps its temperature whichever model runs it.

| Role | Job | Default model | Notes |
|---|---|---|---|
| `classifier` | Is this email a todo? priority? complexity? | `gemini-3.8-flash` | JSON output, temperature 0 |
| `planner` | Task → plan steps | `gpt-5.4-mini` | Structured output, tool list in prompt, temperature 0 |
| `drafter` | Email, PR body, ADR | `claude-haiku-4.5` + personal skill | Temperature 0.4 |
| `coder` | Code edits, PR diffs | `mai-code-1.1-flash` | Temperature 0.1 |
| `embedder` | Retrieval | `text-embedding-3-large` (Azure OpenAI) | 3072-d |

The historical four defaults remain valid for older jobs when discovery is unavailable. Other model choices require account discovery and selectable capabilities; **arbitrary env identifiers are not authority to run an undiscovered model.**

### 6.3 AI credits

Every run records **the model that produced each step and the credits it was billed at**, shown on the run page and in the run list.

Both are **per step, not per run**, because the model that answers is not always the one that was asked for: an unavailable model is substituted mid-run, and pricing the whole run at the requested rate would misreport the spend.

Credits remain **estimates**, separate from measured tokens. Existing four-model estimates and dated history are preserved. Discovery uses a provider billing multiplier only when actually returned, and `ENSEMBLE_MODEL_CREDITS=model=multiplier,...` can supply a deployment rate. **A missing rate is `null`/Unknown, never an invented one-credit (or free) request.** Unknown credits propagate through runtime responses and run totals; usage charts show known subtotals and report unpriced calls separately.

**Embeddings are the one exception to the Copilot-only rule.** None of the four approved chat models produce vectors, so pgvector retrieval requires Azure OpenAI `text-embedding-3-large`. Until `AZURE_OPENAI_*` is configured, `embeddings_configured` is false, `/readyz` reports `embeddings: skipped`, and retrieval features stay dark rather than failing at runtime.

**Credential resolution order:** `COPILOT_API_KEY` → `GITHUB_TOKEN` → `gh auth token`. The `gh` fallback means a developer already signed in with the GitHub CLI needs no extra secret in `.env`.

All prompts live in `packages/prompts/` with version headers; every run records `prompt_version` in the audit ledger.

---

## 7. Coding conventions

- **TS:** `strict` is on in `tsconfig.base.json`; `pnpm typecheck` runs `tsc --noEmit` in every package. There is no ESLint or Prettier config in the repo yet. Zod schemas in `packages/shared-types` are the source of truth for shapes that cross the wire.
- **Python:** no ruff/mypy config is checked in yet. Every external write goes through `ensemble_agent/tools/guarded.py`, which enforces policy and writes the ledger row; no worker calls a write tool without an approval unless the autonomy policy permits it.
- **Feature flags:** `ENSEMBLE_FEATURES` is listed in `.env.example` but nothing reads it yet. Per-account modules (`apps/hub-api/src/lib/module-gate.ts`) are what turn surfaces on and off today.
- **Agents and docs:** see [AGENTS.md](../AGENTS.md). A change that alters what a doc says updates that doc in the same change.

## 7a. Logs

hub-api logs JSON lines with `pino` to the console at `ENSEMBLE_LOG_LEVEL` (default `info`). agent-runtime logs with `structlog` to the console. Secrets are redacted before they are logged or stored (`apps/hub-api/src/lib/redact.ts`, `apps/agent-runtime/ensemble_agent/redact.py`).

`ENSEMBLE_LOG_TO_FILE` and `ENSEMBLE_LOG_RETENTION_DAYS` are in `.env.example` for a bounded, dated file trail, but that is not implemented: nothing reads them yet. On a VM deploy the systemd units (`infra/deploy/ensemble-*.service`) send console output to the journal.

## 8. CI and deploys

Checked 7 Oct 2026 against the workflow files, successful GitHub `ci`/`deploy` runs, and public API health/readiness. The pipeline is enabled and has deployed the API on the VM and the Hub/landing page on Vercel. Server addresses, access instructions, and release history remain in the git-ignored `private/` runbooks.

**`.github/workflows/ci.yml`** runs on every pull request and every push to `main`, as five parallel jobs:

| Job | What it runs |
|---|---|
| Typecheck and unit tests | `pnpm db:generate`, `pnpm typecheck`, the `shared-types`, `block-diagrams`, `ide-theme` and `hub-web` tests. The `hub-web` plot tests render with matplotlib, so the job installs `apps/agent-runtime` and sets `PLOTS_PYTHON` |
| hub-api tests (Postgres + Redis) | `pgvector/pgvector:pg16` and `redis:7-alpine` service containers, `infra/sql/init.sql`, `pnpm db:migrate`, the full `hub-api` suite (integration tests included, since a database is reachable), and `pnpm bridge:verify` |
| CLI tests and package smoke | `apps/cli` typecheck, tests (the test script builds `dist/ensemble.mjs` first) and build, then `scripts/package-cli.mjs --target linux-x64 --skip-sidecar` and `scripts/smoke-cli-package.mjs` on the archive |
| agent-runtime tests | Python 3.12, `pip install -e apps/agent-runtime pytest`, `pytest tests` |
| Production builds | `next build` for `apps/hub-web` (with placeholder `example.com` origins) and `apps/landing` |

Some `hub-web` tests can keep the process open after their assertions because of query-cache timers. Work-folder fixtures use canonical paths from `apps/hub-api/src/test/temporary.ts` (`/private/tmp` on Mac), so intended `/private/var` restrictions do not abort the scenarios. Device revocation's cross-process regression needs real Redis and reports an explicit skip for `memory://`. Plot-worker regressions run locally on Mac as well as in Linux CI.

Python-only Linux CI does not install Node workspace dependencies. The Mac launcher argv contract mocks executable/loader availability without launching anything; real Mac execution tests still use the installed Node/tsx sandbox choke point. Missing Mac launcher dependencies have a separate explicit failure regression.

**`.github/workflows/deploy.yml`** runs after `ci` succeeds on a push to `main`, or by hand (Actions → deploy → Run workflow, with `all`, `api`, `app` or `landing`). It does nothing until the repository variable `DEPLOY_ENABLED` is `true`.

1. **Promote.** If the commit is still the tip of `main` (CI runs can finish out of order), it fast-forwards the `production` branch to it. No force push: `production` only moves forward.
2. **API.** The VM follows `production` by itself. `infra/deploy/autodeploy.sh`, run every minute by `ensemble-autodeploy.timer`, fetches `origin/$ENSEMBLE_DEPLOY_BRANCH` and runs `update.sh` when it moved. Nothing connects in to the VM, so SSH can stay closed to everyone but the owner. `update.sh` writes the commit to `/etc/ensemble.commit`, and hub-api reports it as `commit` on `GET /health`. The workflow waits (up to 25 minutes) until `/health` reports the new commit and `/health/ready` is 200. A commit whose update fails is recorded in `/var/lib/ensemble/autodeploy.failed` and not retried until a newer commit arrives.
3. **Hub and landing page.** `.github/actions/vercel-deploy` runs `vercel pull`, `vercel build --prod` and `vercel deploy --prebuilt --prod` for each Vercel project. The Hub waits for the API step; the landing page does not. The upload carries no git metadata, because Vercel's Hobby plan refuses a deploy whose commit author is not the account owner.

Repository secrets: `ENSEMBLE_API_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_APP`, `VERCEL_PROJECT_ID_LANDING`. The Vercel projects hold the build settings (root directory `apps/hub-web` or `apps/landing`) and the Hub's `NEXT_PUBLIC_*` values. Server secrets stay in `/etc/ensemble.env` on the VM and never go to GitHub or Vercel.

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

`scripts/route-inventory.ts` builds actual hosted and desktop route matrices and records auth/module/parameter/explicit-test metadata in `scripts/route-inventory.json`. `src/test/route-coverage.ts` lists explicit request contracts, not filename guesses. Resource/auth suites fail on unexecuted coverage claims. `--check` fails for stale inventory; missing explicit resource happy-path contracts currently warn (optional `--strict` fails). Generic gate coverage is **not** a claim that every endpoint is fully exercised.

Checked 6 Oct 2026: public signup/isolation suites, hosted safety regressions and the complete tool-schema catalog passed; Google/Microsoft consent and Resend delivery still need operator credentials and manual post-deploy checks. The wider API run applied all migrations to a disposable local PostgreSQL database, leaving the development database unchanged. One plot queue-wait expectation still failed in the legacy suite. The broader local Python plotting suite could not start its plot worker on this Mac; the hosted denial/HTTP/provider suites passed. Do not count that as verified rendering or a fully green exhaustive suite.
