# 07 · Access, approvals, audit, retention and metrics

The Hub assistant, assigned agents, external engines and the read-only Context Bridge have different permissions; no single policy table governs all four.

## 1. Identity & access

Browser sign-in uses hashed session cookies, a password or configured Google/GitHub/Microsoft login, and separate verification and recovery tokens. Signing in with a provider does not grant connector access. Hosted model, connector and agent operations require a verified email. Host credentials and filesystem execution are operator-only (`lib/hosted-access.ts`); everyone else pairs their own computer.

A space scopes content by `userId`; the actor is `accountId`. Sharing adds route and resource checks in `sharing/policy.ts`, `gate.ts` and `context.ts`; unclassified routes stay owner-only. A viewer or editor never uses the owner's private credentials, reminders or account settings ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)).

Account export and deletion use `lib/account-data.ts`. Deletion includes owned spaces and checks for active work, including a run on the person's computer in a shared space. Account-lifetime foreign keys stop late writes from recreating erased rows. Third-party copies and infrastructure backups have their own lifetimes.

### 1.1 Completed and deleted data retention

`jobs/retention.ts` and `jobs/skill-mining.ts` apply these windows:

| Setting / data | Default and behaviour |
| --- | --- |
| `completedRetentionDays` | 60 days (1–365). Unpinned completed work gets at least 24 hours' notice and a successful skill-learning pass, then moves to Trash |
| `retentionDays` | 30 days (1–365). Trash is purged permanently after this |
| `historyRetentionDays` | 90 days (30–365). Audit ledger and task status history |
| Remote log chunks and changed job files | Fixed 30 days (Ensemble on the web keeps no changed-file text, [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)) |
| Blobs nothing uses (file originals, plot tables) | Removed hourly once an hour old (`jobs/blob-sweep.ts`); the storage account's own soft delete keeps them 7 more days |
| Code reviews | Expire after 14 days; their snapshots are unpinned |

Pinning, reopening, active jobs, a failed mining pass or a conflicting skill change keep completed items. A batch holds at most 50 tasks and 50 deliverables. Completion summaries created at retirement expire with the Trash window. The board's completed count and Context's review window are display choices, not retention.

`/api/deleted` lists, restores and empties Trash in the current space. Standalone notes keep their document and discussions until purge; task pages follow their task. Retention never removes workspace checkouts. People, skills, files and projects do not expire from inactivity.

### 1.2 Private reminders and platform notifications

`dispatchDueReminders` turns due reminders into in-app notifications. In-app notifications are unread items, not a log: the bell lists only unread ones ([02 §14](02_MODULE_INTERACTION_HUB_UI.md#14-notifications-and-private-reminders)) and retention removes old rows. Browser notifications need an open tab and permission; native ones need the desktop app running and system permission. Quiet hours defer ordinary popups; Needs me can notify urgently. Nothing alarms while Ensemble is closed. Private reminders are excluded from shared context and the editor bridge.

### 1.3 The operator's interaction log and dashboards

Ensemble on the web logs how signed-in people use the Hub, for the operator's own analysis (disclosed in the landing page's privacy policy, `apps/landing/app/privacy/page.tsx`). Never content.

- **Browser** (`apps/hub-web/lib/telemetry.ts`, mounted in `app/(hub)/layout.tsx`): one random key per tab; a `session` event when the Hub opens; a `view` for each screen with its **active** time (counted in 5 s ticks only while the tab is visible and there was input in the last 60 s, `IDLE_MS`; under 1 s is dropped); named `action`s through `track()` / `useTrackOpen()` (`palette.open`, `shortcuts.open`, `capture.open`, `nav.drawer.open`, `pages.panel.open`, `assistant.open`, `peek.open`). Sent every 30 s and with `sendBeacon` when the tab hides or closes; a failed send is kept (200 events at most).
- **Server** (`apps/hub-api/src/analytics/telemetry.ts`, `POST /api/telemetry`, class `personal`): only a signed-in browser session (no API tokens, no visitors on a shared item or link). At most 50 events, 64 KB; events older than a day or more than 5 minutes ahead are dropped. A path keeps its known shape only (`/pages/:id`; an unknown first segment becomes `/:other`), its area comes from the first segment, a view counts at most 30 minutes, and props keep only short identifier-like words, numbers and booleans. Stored in `interaction_events` (migration `20261021120000_interaction_events`), deleted with the account or "Delete everything", included in the export, and purged daily after `ENSEMBLE_INTERACTION_RETENTION_DAYS` (default 730).
- **What the server already recorded** joins it: the audit ledger's actions by `me`, `metric_events` model calls and assistant turns, and `included_usage`.
- **The person's own weekly recap** (`GET /api/recap/week`, `weeklyRecap` in `apps/hub-api/src/cowork/service.ts`) reads the signed-in account's own `view` rows, never the space owner's or another member's, for "Active in Ensemble": total active minutes, minutes per weekday and hour in the person's time zone (a view counts from its start, split at hour boundaries), and the top five areas. Rows carry no space, so the figure covers every space the person opened. It is screen time, not hours worked.
- **Metrics** (`apps/hub-api/src/analytics/prometheus.ts`): with `ENSEMBLE_METRICS_PORT` set, a separate listener on `127.0.0.1` serves `/metrics`: `ensemble_http_requests_total{route,method,status,via}` (`via="vercel"` when Vercel's rewrite forwarded it, from its `x-vercel-*` headers), `ensemble_http_request_duration_seconds`, `ensemble_live_streams`, `ensemble_live_channels`, and Node's process metrics (`ensemble_api_*`). The public API never serves it.
- **Dashboards** (`infra/deploy/home/observability`, home server only): Prometheus (kept 730 days), Grafana, node-exporter (CPU, memory, disk, network, temperatures, RAPL power including `psys`) and postgres-exporter, all on loopback, plus `azure-metrics.py` every 6 hours (Azure Cost Management month to date, last month and a linear month-end estimate for every enabled subscription; blob counts and bytes by container and prefix). Grafana reads the database as `ensemble_grafana`, which may read only the `analytics` views (`analytics.sql`): activity, usage, sizes and kinds, never content, password hashes or tokens. **Active** there means any action, opening the Hub, or a screen used for at least 10 s (`analytics.engagement`). Dashboards are generated by `build-dashboards.mjs`: Overview, Users, Activity, LLMs, Cost & storage, Traffic, Server. `telemetry.integration.test.ts` applies the views to the test database so a migration that breaks them fails CI; on the server, `update.sh` drops them before migrating and recreates them after.

## 2. Action policy (the gates)

| Path | Control |
| --- | --- |
| Hub assistant local writes | Per-tool classification, allowed write areas, module and sharing checks. Default write policy "Just do it": Hub writes run at once and are undoable; connected-app writes, settings and agent assignments always wait for Apply |
| Sensitive assistant actions | Calendar/app writes, dependent workflows, skills and settings changes go through their tool's Apply path |
| Connected MCP writes | Server/tool enablement, schema validation and confirmation; read-only annotations affect classification but grant nothing |
| Assigned research/code jobs | Saved run profile, tools, folder trust, Ask / Review only / Unattended mode, sandbox, network and Git permissions, budgets |
| Publishing | The exact saved approval and payload, with continuation checks |
| Human terminal | Passkey unlock and its own rules; not an assistant tool ([16 §5](16_CODE_TAB.md#5-the-terminal--for-you-only)) |
| Context Bridge | Read-only tools, scoped bearer key or session, bounded retrieval |

`assistant/apply.ts` validates approved proposals; an edited proposal is revalidated. Tools routed through `assistant/request.ts` reuse API authentication, quotas and resource checks. A guest never gains the owner's connections through a workflow.

`workspace/policy.ts`, `guard.ts`, `trust.ts`, `git-gate.ts`, engine adapters and the OS sandbox enforce assigned-run rules ([24](24_DESKTOP_SANDBOXING.md)). Review only means fewer prompts, **not read-only file access**. Unattended picks recommended answers and reports them; it grants no new filesystem rights. There is no undo window for sends or other external writes.

## 3. Audit ledger

`lib/ledger.ts` appends to `audit_ledger` in one serialized per-user transaction: actor, action, task/run/approval links, payload, previous hash and SHA-256 hash, with a monotonic timestamp. Shared-space actions add `payload.byAccountId`; metrics go to the actor's own account.

`POST /api/ledger/verify` checks only that each row's `prevHash` matches the previous row's `hash` in timestamp order; it does not recompute payload hashes.

**Limits:** this is application-written, hash-linked history. There is no `verify-ledger` or `db:harden` command, INSERT-only database role, OpenTelemetry export or immutable audit store. Configured retention and account deletion delete history. It is not compliance-grade immutable storage.

## 4. Reliability and dependent actions

Revision/hash/version preconditions protect page, file and skill edits. Scoped task/source IDs deduplicate imports. Run checkpoints avoid repeating completed work when a decision resumes. None of this is exactly-once delivery for every network call.

`assistant_workflows` stores ordered action receipts scoped by space, actor, conversation and call ID. `hub_run_workflow` validates the approved plan, resolves only backward references and rechecks permissions and settings at each step. Successful steps are not replayed after a later failure; an interrupted Running step needs inspection, not automatic replay ([34](34_ASSISTANT_ACTIONS.md)).

Health and readiness report API and dependency state; the scheduler records its tick. There is no production canary, dead-letter screen or automatic mid-command crash recovery.

## 5. Metrics and included AI

`lib/metrics.ts` records `MetricEvent`; `GET /api/metrics/summary` (`routes/runs.ts`) serves aggregates. Metrics belong to the person, including work in a shared space. The UI shows AI calls over 14/30/90 days with provider filters applied before every aggregate: reported tokens, daily activity, models, purposes and recent calls. Calls without token reports still count, and missing counts or prices show as missing. Local models and subscriptions report only what responses to Ensemble-routed work contained; Copilot assistant turns read per-call `assistant.usage` events from the CLI process Ensemble started, and context-window snapshots or vendor billing units never become token or cost estimates.

Included AI is separate: `included/budget.ts` reserves and settles each account's usage and the operator's global ceiling. `included_usage` keeps call metadata and token counts, not prompts or replies, until workspace erasure or account deletion; erasure scrubs call details and keeps minimal settlement records. `included_credit_balances` enforces the allowance by an email-derived HMAC key, month and charged amount, survives account deletion and re-signup with the same email, and is removed by the scheduler two days after its month ends. `included_periods` keeps aggregate operator spend ([33](33_INCLUDED_AI.md)).

## 6. Data erasure

Hosted account deletion is in Settings → Data → Danger zone, not Account. Its button opens a confirmation with the exact `DELETE` phrase and password, or the recent-sign-in requirement for social accounts. It retains the API's active-run checks. Metrics' general reporting explanation is available from About usage rather than a persistent paragraph.

Settings → Data offers erasure scopes through `lib/workspace-data.ts`, driven by current Prisma metadata. **Everything** removes workspace content, metrics, baselines, audit history and plot dataset files, and keeps authentication, devices, connector and model configuration, settings and monthly credit consumption; the ledger keeps only a content-free deletion receipt. Deletion and receipt commit together under the shared `FOR NO KEY UPDATE` user lock. The web client sends the request straight to the API, not through the web rewrite proxy. Active jobs block erasure with a 409. The Danger zone asks for a scope, the typed phrase `delete everything` or `delete people and app information` (paste and drop disabled), then a confirmation dialog; the server checks the exact phrase. Account deletion is a separate, broader action.

`GET /api/metrics/summary` first runs `repairErasedUsage`: once per Everything receipt (tracked in the `hub.usage-erasure-repair` preference) it preserves monthly credit charges, then removes metric events and baselines at or before that receipt. Later usage stays.

`account_deletion_logs` keeps only an HMAC-derived email key, deletion time and expiry, with no readable email, profile, feedback or account link. The same email overwrites the earlier entry and may sign up again. Entries expire after **90 days**; the scheduler purges them even when no accounts remain. After restoring a backup or with the scheduler off, the operator must check this cleanup. `pnpm --filter @ensemble/hub-api deletion-log:erase` removes one entry, reading the address from stdin without printing it. The public privacy policy discloses the log. This guide describes code behaviour, not legal compliance.

## 7. Tests

API auth, isolation and public-signup suites send real Fastify requests to an isolated migrated database with mocked providers; Postgres/Redis CI covers integration and constraints; OS tests exercise sandbox boundaries. They do not prove live notifications, calendar writes or provider billing. There is no `eval/` corpus or productivity baseline in the repo.
