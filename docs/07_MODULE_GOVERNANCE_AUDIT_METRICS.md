# 07 · Module M6 — Governance, Audit & Metrics (enterprise readiness + before/after)

**Purpose:** Make the digital coworker trustworthy: it acts under a known identity with least privilege, every action is policy-checked and recorded in a tamper-evident ledger, humans have clear control points, and the impact is **measured — not asserted**.

---

## 1. Identity & access

| Concern | Design |
|---|---|
| **Who is the agent?** | The agent acts on behalf of the signed-in local user, through **per-connector OAuth**. No Agent 365 / Entra Agent ID for now. |
| **Least privilege** | Each connector requests only what its feature needs. GitHub tokens are fine-grained and repo-scoped. Outlook/Teams scopes (if enabled) are in [01 §2.2](01_TECH_STACK_AND_ENVIRONMENT.md#22-connector-oauth-not-a-single-entra-app). |
| **Secrets** | Key Vault (prod) / `.env` (dev). Never in prompts, logs, skills, or ledger (redaction layer). |
| **Data boundary** | Model calls follow the configured provider policy. Context bodies stay in the user's Postgres partition; Trash retention defaults to 30 days and completed history to 60 days, each configurable from 1–365 days (§1.1); delete-all is separate. |
| **Multi-user** | Public per-user accounts with application-level `userId` scoping and HTTP isolation tests, not database RLS. Hosted shared credentials/execution require an exact verified operator email; public accounts use BYOK. Sharing a space or an item ([29](29_SHARING.md)) goes through a deny-by-default route policy (`src/sharing/policy.ts`): members never reach the owner's connectors, keys, settings, tokens, terminal or Today. |

Account export and deletion are separate from routine retention. `lib/account-data.ts` exports user-scoped records while omitting credential tables/fields; deletion explicitly removes legacy `userId`-only tables and cascading children, including the user's ledger, then erases the user's uploaded dataset files/cache. File cleanup failures are explicit, not reported as complete deletion. Normal ledger operations remain append-only; account erasure is the intentional privacy exception. `routes/auth.ts` requires browser authentication plus recent sign-in/password confirmation. The deletion transaction locks the account/job rows and rejects active agent jobs. SQL account-lifetime foreign keys stop late model/ledger writes from recreating erased records. Infrastructure backup expiry and third-party copies are not controlled by the account deletion API. Deleting an account deletes each of its Ensemble spaces the same way first, and the export carries every space under `spaces` ([28](28_ENSEMBLE_SPACES.md) §5). The export also lists your contacts, space memberships and shares. Deletion is refused while a run is active on your computer in a space shared with you, too.

### 1.1 Completed and deleted data retention

Code inspection, 16 Oct 2026: `jobs/retention.ts`, `jobs/skill-mining.ts` and `jobs/scheduler.ts` implement the current retention pass. `completedRetentionDays` defaults to 60 and `retentionDays` (Trash) to 30; each accepts 1–365 days. The board count (`completedVisible`) and graph window (`contextReviewDays`) are separate display choices.

Unpinned done/dropped tasks and completed deliverables become eligible by `completedAt`. The daily pass warns at least 24 hours ahead, uses the High model to learn versioned skills, writes completion summaries, and moves successful batches to Trash. Failed mining, an active task job, a pin/reopen or a conflicting skill edit keeps the original work. Existing skill instructions are preserved when new guidance is appended. One batch contains at most 50 tasks and 50 deliverables.

Deleted records use `deletedAt` for the Trash window. Source files stored with uploaded documents are database bytes; plot dataset files have their own file cleanup on full workspace/account erasure. Standalone notes preserve their content, mentions and discussions until purge; `pages/store.ts` also removes generic discussions and diagram links during final purge. `/api/deleted` lists, restores and empties Trash. These operations are scoped to the open space. Workspace checkouts are not removed by routine retention.

Audit/status history has its own `historyRetentionDays` window, default 90 days; old audit rows and task transitions are removed by retention. Remote log chunks and changed job files have a fixed 30-day window. Code reviews expire after 14 days and their snapshots are unpinned. Completion records made when work enters Trash are removed after the Trash window. Account erasure is a separate operation that also removes authentication/configuration and the account's ledger.

### 1.2 Private reminders and platform notifications

Code inspection: reminder records and firing times live in `services/records.ts` and `jobs/retention.ts` (`dispatchDueReminders`). Due reminders create in-app notifications. Deleted or dismissed reminders are purged after the Trash window; active reminders are not aged out simply for being old.

`components/shell/notifier.tsx` and `lib/notify.ts` deliver browser notifications while an Ensemble tab is open, or native Tauri notifications while the desktop app is running. Settings requests permission on the current platform before enabling delivery. Quiet hours hold ordinary reminder popups; a waiting Needs me request can notify urgently. System Focus/notification settings still apply. This is not an operating-system alarm service when Ensemble is closed. Source links and the native permission workflow are in [DESKTOP](DESKTOP.md).

## 2. Action policy (the gates)

Tool catalog with risk levels (`packages/shared-types/src/tools.ts` was the plan; as-built the catalog lives in Python — see §9):

| Risk | Examples | `assist` | `supervised` (default) | `autonomous` |
|---|---|---|---|---|
| **read** | any connector read (mail, GitHub, Teams, …), web fetch | auto | auto | auto |
| **low write** | push to agent branch, comment on own WI, create draft email, write file in OneDrive draft folder | approval | auto + ledger | auto |
| **medium write** | WI state change, create focus-block events, PR comment | approval | approval | auto + undo window |
| **high write** | send email, post Teams, open PR, cancel/modify others' meetings, share doc externally | approval | approval | auto + 5-min undo window + immediate notification |
| **forbidden** | delete mail, delete branches, change permissions, anything outside tenant | — | — | — |

Policy engine (`ensemble_agent/policy.py`): `decide(step, task, autonomy, user_settings) → allow | require_approval | deny`. Extra rules: recipients **outside the tenant** → always approval; messages mentioning money/legal/HR keywords → always approval; rate limit: **≤ 20 high-risk writes/day**.

**Human control points** (explicit list for judges):

1. Todo triage (Me / Agent / Later / Drop) — nothing runs without assignment.
2. Autonomy per task at delegation time.
3. Context pack editing before "Help me" / run.
4. Approval card with exact preview, Edit & approve, Reject with reason.
5. Question cards when the agent lacks info (no guessing).
6. Global *Pause agent* + per-task *Take over*.
7. Skill version acceptance (skills never change silently).
8. Undo window for autonomous medium/high writes where reversible.

**Decision-inbox implementation:** missing-information questions and interrupted attempts now appear alongside approvals in Needs Me. New approval checkpoints save the plan and exact payload, with one approval per run/step; approving queues a durable continuation rather than a transient pub/sub notification. A queue failure leaves a recoverable, visible decision state. Older runs without saved continuations require an explicit new attempt and never reuse a guessed approval. The internal tool endpoint refuses calls attributed to cancelled/taken-over runs.

### Rules the policy engine adds beyond the autonomy matrix

Evaluated **strongest-first**, so a deny can never be downgraded:

1. **Forbidden tools** — deleting mail, deleting branches, changing permissions, sharing externally. Denied at every level including autonomous. There is **no approval button**, because offering one would imply the action is available.
2. **Unknown tools** — denied. A plan naming something the catalog has never heard of is a bug or a hallucination; neither should reach a live mailbox.
3. **External recipients** — any address outside the tenant forces approval, whatever the autonomy level. Checks `to`, `cc`, `bcc`, `recipients` and `attendees`, and understands Graph's nested `{ emailAddress: { address } }` shape. Teams thread ids (`19:…@thread.v2`) look like email addresses and are **excluded explicitly**, or every meeting-chat post would prompt.
4. **Money / legal / HR content** — forces approval. Deliberately broad: a false prompt costs seconds, a wrongly-sent salary figure does not.
5. **Daily high-risk cap** — see the table above. As built this **downgrades to `require_approval`**, not a hard stop (see §9).

---

## 3. Audit ledger

Append-only table `audit_ledger` (app DB role has **INSERT only**):

```text
id, ts, user_id, actor ('agent' | 'user' | 'job'),
action (tool name or transition), task_id, run_id, step_id,
input_hash, output_hash, input_ref (blob id, redacted),
approval_id, skill_ids[], prompt_version, model,
policy_decision, prev_hash,
hash = sha256(prev_hash || canonical(row))
```

- `verify-ledger` script recomputes the chain — tamper-evident.
- In a shared space ([29](29_SHARING.md)), entries a member causes are written to the space's ledger with `payload.byAccountId` set to that member (`appendLedger` in `lib/ledger.ts`). Metrics are personal: `recordMetric` writes them to the person's own account, whichever space they worked in.
- Every `Approval` stores `preview`, `decision`, `editedPayload`, `decidedBy`, `decidedAt`.
- Runs page = human view of the ledger. Export = JSONL for compliance.
- OpenTelemetry trace ids on each row link to Foundry/App Insights traces (LLM inputs/outputs retained per tenant policy).

### Idempotency

Every write carries `task_id:step_id:attempt:tool`. Before executing, `guarded_write` checks the ledger for a completed write with the same key and records `write.*_deduplicated` instead of sending twice.

The two failure directions are deliberately opposite:

- the **idempotency check fails open** — a ledger read outage must not block a legitimate first send;
- the **rate-limit check fails closed** — if we cannot count today's writes, the next high-risk one asks a human, so an outage cannot silently disable the cap.

### The cross-writer hash bug

The ledger has one writer: hub-api (`apps/hub-api/src/lib/ledger.ts`). agent-runtime does not hash or insert rows itself; `ensemble_agent/audit/ledger.py` posts each entry to `POST /api/internal/ledger`, so the chain is computed in one place and timestamp formats cannot drift between two languages.

An append now locks the account row inside its transaction before selecting the predecessor and inserting the next hash. Timestamps advance monotonically by at least one millisecond, including same-clock-tick appends, so timestamp ordering follows the chain. This prevents new concurrent forks; it does not rewrite existing historical rows.

The undo stack uses the same per-account transaction lock before allocating `(user_id, seq)` and trimming the bounded stack (`lib/undo.ts`, `lib/user-lock.ts`). `FOR NO KEY UPDATE` serializes these writes without deadlocking foreign-key inserts that already hold `KEY SHARE`. Separate accounts do not share a global lock.

### Tracing

Not implemented yet. The plan: one span per job, with its W3C trace id recorded on every ledger row the job writes, exported only when a collector is configured. Outside a span the trace id stays empty rather than invented — a fabricated id in the ledger would look like a link to a trace that does not exist.

---

## 4. Reliability

- **Idempotency keys** on every write tool (`task_id:step_id:attempt`) so retries never double-send.
- **Resumable runs** (state after each step), job retries with backoff, dead-letter list visible in Settings.
- Health endpoints; synthetic "canary" task every hour in dev (research worker, read-only).
- **Graceful degradation:** connector down → Today page shows *"Teams sync stale since 08:10"*; proposals continue from other sources.

---

## 5. Evaluation harness (`eval/`)

- **Extraction:** 20 emails + 3 transcripts with hand-labelled asks/action items → precision/recall.
- **Proposer:** labelled *"should be a todo?"* set → precision/recall, and priority agreement.
- **Skills:** rule adherence + judge similarity + live acceptance (see [04 §6](04_MODULE_SKILL_FORGE.md#6-evaluation)).
- **Planner:** golden tasks → plan validity (all writes gated, ≤ 8 steps, tools exist).
- **End-to-end:** replay a day of ingested mail; assert proposals appear, approvals gate the writes, ledger chain valid, mail draft matches expected recipients. Run in CI with recorded fixtures (no live Graph), plus a nightly live run against the sandbox.

---

## 6. Before / after measurement (the headline for judges)

### 6.1 Baseline (capture during Week 0 / first 2 Hackweek days, manually or via a simple time-log)

| Metric | How measured (before) |
|---|---|
| Morning triage time | stopwatch: opening mail/chat/GitHub → having a day list |
| Context re-typing | words typed into a chat assistant to set context per help request (count over 10 requests) |
| Meeting action-item capture | items I wrote down vs items in transcript (3 meetings) |
| Draft rework | edits needed on generic assistant drafts (10 emails / 5 PR descriptions), acceptance rate |
| Manual steps per routine workflow | e.g. *"bump dependency & PR"*; count of manual steps (branch, edit, test, commit, PR, link WI, notify) |

### 6.2 After (instrumented automatically, `metrics.events`)

| Metric | Event source |
|---|---|
| Triage time | `today-opened` → last `task.assigned` in the session |
| Context words typed | length of `help.delta` vs. tokens in attached context pack (shown as *"you typed 9 words; agent used 4,200 words of context"*) |
| Action items captured | `meeting.recap` items vs. user-added items afterwards |
| Draft acceptance | approvals: approved / edited (with edit distance) / rejected |
| Steps eliminated | plan steps executed by agent vs. baseline manual count |
| Agent throughput | tasks completed by agent/day, median time to completion, approvals waiting time |
| Trust | % tasks delegated at supervised vs autonomous over time; rejection rate trend |

### 6.3 Metrics page tiles (Hub)

> Target demo numbers from the Hackweek write-up (targets, not measurements of this tree):

**Triage:** 21 min → 2.5 min · **Context typed per help:** 148 words → 9 · **Drafts accepted as-is:** 31% → 74% · **Meeting action items captured:** 6/11 → 11/11 · **Manual steps (dep-bump PR):** 9 → 2 (review + approve) · **Agent actions this week:** 37 · **100% audited · 0 unapproved high-risk.**

Charts: acceptance rate by skill version (shows learning), tasks by owner per day, approval turnaround.

---

## 7. Responsible AI notes

- Agent output is always attributed (violet accent, skill chips); sent messages carry no hidden AI disclaimer beyond tenant policy — configurable.
- **No evaluation/ranking of colleagues;** relationship weights are used only for prioritisation of *my* work and are visible/editable.
- Transcript use limited to meetings I attended; recaps shared only on explicit approval.
- Clear *"delete my data"* and *"disable connector"* controls.

---

## 8. Dev checklist

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

- [ ] Tool catalog with risk levels; policy `decide()` + unit tests
- [ ] `audit_ledger` table, hash chain, INSERT-only role, `verify-ledger` script
- [ ] Guarded tool wrapper writing ledger + idempotency keys
- [ ] Approvals persistence + Runs page export
- [ ] `metrics.events` + aggregation queries + Metrics page tiles
- [ ] Baseline capture sheet (`eval/baseline.md`) filled before the build sprint
- [ ] OTel wiring to App Insights / Foundry tracing
- [ ] Per-connector OAuth + revoke/disable controls in Settings

---

## 9. As built

| Area | Where | How to check |
|---|---|---|
| Policy engine | `apps/agent-runtime/ensemble_agent/policy.py` | `.venv/bin/python -m pytest tests/test_policy.py` (from `apps/agent-runtime`) |
| Tool catalog | `apps/agent-runtime/ensemble_agent/tools/catalog.py` | — |
| Guarded writes | `apps/agent-runtime/ensemble_agent/tools/guarded.py` | — |
| Ledger (TS / Python) | `apps/hub-api/src/lib/ledger.ts`, `apps/agent-runtime/ensemble_agent/audit/ledger.py` | — |
| Metrics | `apps/hub-api/src/lib/metrics.ts`, `/api/metrics/summary` in `routes/runs.ts` | — |
| Settings / controls | `apps/hub-api/src/routes/settings.ts`, Hub `/settings` | — |

Not in this tree yet: the INSERT-only database role script, the evaluation harness and baseline files under `eval/`, OpenTelemetry tracing, and the Entra walkthrough. The rows below that mention them describe the plan.

### Where the build differs from the plan

| Planned | Built | Why |
|---|---|---|
| Tool catalog in `packages/shared-types/src/tools.ts` | `apps/agent-runtime/ensemble_agent/tools/catalog.py` | The planner and executor read the catalog on every step. Keeping it in TypeScript meant either a network hop per decision or a second copy — and a **duplicated catalog is exactly the drift the catalog exists to prevent**. The TS side never needs the risk levels; it renders the gate the Python side already decided. |
| Rate limit as a hard cap | Rate limit **downgrades to `require_approval`** | A hard stop strands a legitimate task at 21 writes. Requiring a human still ends a runaway loop, which is what the limit is for, without the agent going silent mid-day. |
| `audit.ledger` as a separate Postgres schema | `audit_ledger` table in `public` | Prisma "schemas" here are table-name prefixes, not real Postgres schemas — one migration history. |
| INSERT-only role always on | `pnpm db:harden`, **off by default in dev** | Local development must be able to clear the ledger between runs. You cannot have both a one-command reset and an immutable table under the same credentials; dev connects as owner, deployments point `DATABASE_URL` at `ensemble_app`. |
| Metrics tiles always populated | Tiles report **"not enough data"** below 3 observations | An earlier version multiplied task counts by a guessed "minutes saved". A fabricated number on the slide that matters most is worse than an empty tile. |
| Baseline captured over a working week | Two mornings, self-measured, marked **provisional** | Honest about its own weakness: `baseline.json` carries samples and a status, and the Metrics page shows the provisional badge. |

## Workspace data erasure and retention (16 Oct 2026)

Code inspection: `lib/workspace-data.ts` implements the Settings data erasure scopes through the actual Prisma schema, removing cascading child records rather than leaving newer feature tables behind. Everything preserves authentication, devices, connector/model configuration, settings and audit history; account deletion remains a separate action. Active jobs block erasure with a 409. Plot dataset files are erased for Everything.

Completed work stays in history for `completedRetentionDays` (default 60), independently of the board count and Context graph window. Daily retention gives at least a day’s notice, mines skills with the High model, then moves successful batches to Trash. Failed mining does not discard the original tasks. Trash and its completion records are then permanently removed after `retentionDays`. Pinned items and active work are excluded. Sources: `jobs/retention.ts`, `jobs/skill-mining.ts`.
