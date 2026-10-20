# 07 · Access, approvals, audit, retention and metrics

This guide describes the current enforcement paths, not the original autonomy design. Code inspected **18 Oct 2026**. The Hub assistant, assigned agent, external engine and read-only Context Bridge have different permissions; one policy table does not govern all four.

## 1. Identity & access

Browser authentication uses hashed session cookies, password or configured Google/GitHub/Microsoft login, and separate verification/recovery tokens. Identity login does not grant connector access. Hosted model, connector and agent operations require verified email. Host credentials/filesystem execution are operator-restricted (`lib/hosted-access.ts`); ordinary users pair their own computer.

An open space scopes content by `userId`; the actor is `accountId`. Sharing adds route/resource checks in `sharing/policy.ts`, `gate.ts` and `context.ts`. Unclassified routes remain owner-only. Viewer/editor role is not permission to use the owner's private credentials, reminders or account settings. See [28](28_ENSEMBLE_SPACES.md) and [29](29_SHARING.md).

Account export/deletion uses `lib/account-data.ts`. Deletion includes owned spaces and checks active work, including a run on the person's computer in a shared space. SQL account-lifetime foreign keys prevent late writes from recreating erased rows. Third-party copies and infrastructure backups have separate lifetimes.

### 1.1 Completed and deleted data retention

`jobs/retention.ts` and `jobs/skill-mining.ts` implement independent windows:

| Setting/data | Default and behavior |
| --- | --- |
| `completedRetentionDays` | 60 days, configurable 1–365; eligible unpinned completed work gets at least 24 hours' notice and successful skill learning before moving to Trash |
| `retentionDays` | 30 days, configurable 1–365; soft-deleted content is permanently purged after this Trash window |
| `historyRetentionDays` | 90 days; audit/status history cleanup |
| Remote log chunks and changed job files | Fixed 30 days |
| Code reviews | Expire after 14 days; associated snapshots unpinned |

Pinning, reopening, active jobs, mining failure or conflicting skill changes keep completed items intact. Batches contain at most 50 tasks and 50 deliverables. Completion summaries created at retirement expire with the Trash window. Board completed count and Context review window are display choices, not retention settings.

`/api/deleted` lists/restores/empties Trash in the current space. Standalone notes retain document and discussions until purge; task pages follow their task. Routine retention does not remove workspace checkouts. Live people, skills, files and projects do not expire merely from inactivity.

### 1.2 Private reminders and platform notifications

Due reminders create in-app notifications through `dispatchDueReminders`. Browser notifications require an open tab and granted permission; native notifications require the desktop app running and system permission. Quiet hours defer ordinary popups; Needs me can notify urgently. This is not an operating-system alarm service while Ensemble is closed. Private reminders are excluded from shared context and the editor bridge.

## 2. Action policy (the gates)

| Path | Current control |
| --- | --- |
| Hub assistant local writes | Per-tool classification, allowed write areas, module and sharing checks; preview/Apply according to tool and configured write policy (default "Just do it": Hub writes run at once and are undoable; connected-app writes, settings and agent assignments always wait for Apply) |
| Sensitive assistant actions | Calendar/app writes, dependent workflows, skills and supported settings changes require their tool's explicit Apply path |
| Connected MCP writes | Server/tool enablement, schema validation and confirmation; read-only annotations influence classification but do not grant access |
| Assigned research/code jobs | Saved run profile, tool availability, folder trust, Ask/Review only/Unattended mode, sandbox, network/git permissions and limits |
| Publishing | Exact saved approval/payload and dedicated continuation checks |
| Human terminal | Passkey unlock and separate terminal rules; not an assistant tool |
| Context Bridge | Read-only tools, scoped bearer key/session and bounded retrieval |

`assistant/apply.ts` validates approved proposals. An edited proposal is revalidated, not treated as arbitrary executable input. Tools routed through `assistant/request.ts` reuse existing API authentication, quotas and resource checks. A guest never acquires owner connection access through a workflow.

`workspace/policy.ts`, `guard.ts`, `trust.ts`, `git-gate.ts`, engine adapters and OS sandbox backends enforce assigned-run rules. Review only is a run mode for fewer permission prompts, **not the read-only file-access mode**. Unattended chooses configured/recommended decisions and reports them; it does not grant new filesystem rights.

The retained Python `policy.py` and guarded-tool catalog govern their own legacy calls. Their risk/autonomy matrix is not a universal guarantee that every product action can run autonomously. There is no general promise of an undo window for sends or other external writes.

## 3. Audit ledger

`lib/ledger.ts` writes `audit_ledger` through one serialized per-user transaction. It stores actor, action, task/run/approval links, payload, previous hash and SHA-256 hash. The next timestamp is monotonic within that chain. Shared-space actions add `payload.byAccountId`; metrics are recorded on the actor's own account.

`POST /api/ledger/verify` checks predecessor links in timestamp order; it does not recompute each row’s payload hash. A successful response therefore verifies link continuity only.

Python's `audit/ledger.py` posts to the internal API rather than independently hashing rows. The row shape is the Prisma model, not the old planned schema with input/output hashes, blob refs and trace IDs.

**Limits:** this is application-written hash-linked history. The repository does not ship a `verify-ledger` or `db:harden` command, a permanent INSERT-only database role, OpenTelemetry export, or an immutable audit storage service. Routine configured retention and account deletion can delete history. Do not call this compliance-grade immutable storage.

## 4. Reliability and dependent actions

Safety is specific to the operation. Revision/hash/version preconditions protect page, file and skill edits. Scoped task/source IDs support import deduplication. Saved run checkpoints avoid repeating completed work when resuming a decision. These are not a blanket exactly-once guarantee for every network call.

`assistant_workflows` stores ordered action receipts scoped by space, actor, conversation and call ID. `hub_run_workflow` validates the approved saved plan, resolves only backward references and rechecks permissions/settings at each step. Successful steps are not replayed after later failure. An interrupted Running step has an uncertain outcome and requires inspection instead of automatic replay. Export/deletion discovers the user-scoped table through Prisma metadata. See [34](34_ASSISTANT_ACTIONS.md).

Health/readiness expose API and dependency state. The scheduler records its tick state. There is no documented hourly production canary, universal dead-letter screen or automatic mid-command crash recovery.

## 5. Metrics and included AI

`lib/metrics.ts` records `MetricEvent`; `routes/runs.ts` serves aggregates. Metrics belong to the person, including work performed in a shared space. The UI focuses on AI calls: 14/30/90-day windows, provider filters applied before every aggregate, reported input/output tokens, interactive daily activity, models, purposes and expandable recent calls. It does not show baseline experiments or ledger verification controls. Calls without token reports still count; missing counts/prices are explicit. Local models and subscription calls use only response data from work routed through Ensemble, without reading external plan balances or personal usage. Copilot assistant turns capture per-call `assistant.usage` JSON events from the Ensemble-started CLI process; context-window snapshots and vendor billing units do not become token/cost estimates. Historical prototype targets are not live productivity measurements; no measured minutes-saved or acceptance-rate claim should be inferred from seeded counts.

Run evidence distinguishes measured tokens, provider-reported cost, estimates and unknown rates. Included AI is different: `included/budget.ts` reserves and settles account usage and the operator's global ceiling. `included_usage` retains call metadata/token counts, not prompts or replies, until workspace erasure or account deletion. Workspace erasure scrubs call details and keeps minimal settlement records; `included_credit_balances` independently enforces the allowance using an email-derived HMAC key, month and charged amount. It survives account deletion/recreation with the same email until the scheduler removes ended months after a two-day settlement grace period. `included_periods` retains aggregate operator spend. [33](33_INCLUDED_AI.md) documents credit calculation and limits.

## 6. Data erasure

Settings data-erasure scopes use `lib/workspace-data.ts` and current Prisma metadata. Everything removes workspace content, metrics, baselines, old audit history and plot dataset files while preserving authentication, devices, connector/model configuration, settings and monthly credit consumption. Only a content-free deletion receipt remains in the ledger. The deletion and receipt commit together, using the shared `FOR NO KEY UPDATE` user lock to avoid conflicts with concurrent foreign-key inserts. The web client sends this potentially long request directly to the API, avoiding the web rewrite proxy. Active jobs block erasure with 409. Account deletion is a separate broader action. Settings → Data presents a Danger zone: choose a scope, type `delete everything` or `delete people and app information` (paste/drop disabled), then explicitly confirm the permanent deletion in an accessible modal. The server validates the exact scope-specific phrase.

A separate `account_deletion_logs` row retains only an HMAC-derived email key, deletion time and expiry time. It has no readable email, profile snapshot, feedback or account foreign key. The same email overwrites the prior entry; signup again is permitted. The existing stable secret-key mechanism derives the purpose-separated HMAC.

Expiry is **90 days**, purged by the scheduler even when no accounts remain. Restoring a backup or disabling the scheduler requires an operator cleanup check. The private runbook documents the deletion-log erasure command (`pnpm --filter @ensemble/hub-api deletion-log:erase`), which reads an address from stdin without printing it. The public privacy policy discloses the log. This guide describes code behavior, not a legal-compliance certification.

Checked **20 Oct 2026** with isolated HTTP regression tests for repeated erasure, retained credit consumption, account recreation, legacy-charge adoption/recovery and provider/date isolation. Legacy charges can be recovered from surviving included-call metrics before an older erasure; charges whose evidence was already destroyed cannot be reconstructed.

## 7. Verification

API auth/isolation/public-signup suites use real Fastify requests with an isolated migrated database and mocked providers. Postgres/Redis CI covers integration and constraints. OS tests exercise sandbox boundaries. These checks do not prove live external notifications, calendar writes or provider billing. There is no populated `eval/` corpus or recorded productivity baseline in this tree.
