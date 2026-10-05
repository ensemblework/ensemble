# 07 · Module M6 — Governance, Audit & Metrics (enterprise readiness + before/after)

**Purpose:** Make the digital coworker trustworthy: it acts under a known identity with least privilege, every action is policy-checked and recorded in a tamper-evident ledger, humans have clear control points, and the impact is **measured — not asserted**.

---

## 1. Identity & access

| Concern | Design |
|---|---|
| **Who is the agent?** | The agent acts on behalf of the signed-in local user, through **per-connector OAuth**. No Agent 365 / Entra Agent ID for now. |
| **Least privilege** | Each connector requests only what its feature needs. GitHub tokens are fine-grained and repo-scoped. Outlook/Teams scopes (if enabled) are in [01 §2.2](01_TECH_STACK_AND_ENVIRONMENT.md#22-connector-oauth-not-a-single-entra-app). |
| **Secrets** | Key Vault (prod) / `.env` (dev). Never in prompts, logs, skills, or ledger (redaction layer). |
| **Data boundary** | Model calls follow the configured provider policy. Context bodies stay in the user's Postgres partition; deleted/completed retention is 15/30/45/60 days, default 30 (§1.1); delete-all is separate. |
| **Multi-user (future)** | Row-level security by user id; skills and graph are per user; no cross-user retrieval. |

### 1.1 Completed and deleted data retention

- **Enabled immediately**, including existing history. Settings accepts exactly **15 / 30 / 45 / 60 days**. Default 30 intentionally replaces the fixed 60-day trash policy and the unused 90-day setting. Legacy unsupported values normalize to 30 without changing other settings.
- Done/dropped tasks, done projects and completed deliverables use **`completed_at`**, not an edit-sensitive `updated_at`. Reopening clears it; a later completion starts a new clock. A database lifecycle trigger covers direct writes and undo as well as normal transitions.
- The additive migration backfills existing terminal tasks from their last matching transition, or `updated_at` when no transition exists. Projects and missing deliverable clocks use their current `updated_at` once as a documented approximation; subsequent note/comment edits never reset completion.
- **Other entities expire only when deleted:** people, repositories, preferences, skills, saved meeting answers, artifacts and uploaded documents are not removed merely because they have not been seen recently. A recent deletion gets its own full window even if the item completed earlier.
- Reminders use `dismissed_at` or, when deleted, `deleted_at` for the same per-user window. Active/overdue reminders **never age-expire or stop repeating because they are old**. Terminal content cleanup waits for delivery claims and pending/executing reminder tool calls. Expired dismissed reminders become hidden, content-free tombstones; expired deleted reminders are reduced to the same form. Title/mentions, original due date/time/zone, delivery errors and notification/action/claim state are erased. **Idempotency exception:** the private ID/user/revision/lifecycle timestamps remain, with inert required-field defaults. Create accepts caller IDs without a retry expiry; physically deleting these keys could resurrect a reminder from an old retry. Tombstones are not readable through normal reminder endpoints, never notify, and are never context/graph nodes. Preview/cleanup counts report *reminder content erased*, not physical tombstone deletion.
- A Redis-persisted BullMQ **daily schedule** runs without a browser or fetch job. It discovers user partitions, reads each user's saved cutoff and **fails closed** if the settings store is unavailable. Failed passes retry; the service must be running to execute queued work. Cleanup never starts a model or connector.
- Preview and execution use the **same eligibility/protection logic**. Live runs, undecided approvals (including ended waiting runs), blocked/active workspace jobs, open workspace sessions, document leases and unfinished children protect their associated work and resources. Serializable transactions reject races with reopening or newly linked work. Child rows and mirrors are removed before parents; shared live resources defer the parent rather than cascade away.
- Running page discussions also protect completed task/project/deliverable pages. Pending approvals and executing tools in their dedicated inline conversation protect the page until the authoritative assistant-message state is decided; stale copied discussion tool states do not keep completed work forever. Page purge removes its discussions and, once no discussion references remain, their user-owned inline conversation and messages. Unrelated floating-assistant history is never selected by age, title or page route; **cross-user links defer conversation cleanup** rather than cascade into another account.
- `/api/retention` and `/api/trash` expose the saved cutoff, eligible/protected counts and last successful cleanup. Shortening the window affects existing history on the next pass; it is not a preview-only policy.
- Purge removes source copies, stale context packs, mentions, array/tag links and undo snapshots that could resurrect a deleted entity. Uploaded originals are **database bytes, not arbitrary file paths**. Workspace files are untouched. The **append-only audit ledger is never purged or rewritten**; a count-only `retention.purged` entry is committed with the deletion. Context suppressions remain so a connector does not recreate intentionally removed people/repos.
- Skill bodies have a separate **latest-three limit** (current plus two archives). New model/MCP retrieval uses current only; frozen run version/hash signatures remain auditable even after old bodies are discarded ([04 §3–4](04_MODULE_SKILL_FORGE.md#3-learning-from-feedback-the-loop-that-makes-it-personal)).

### 1.2 Private Today reminders and the Windows desktop

Reminders live below Today's deliverables, not on a separate page. Title text and stable-ID mentions belong only to private reminders; reminders are **not** artifacts, fetched context, context-pack inputs, or graph nodes. Delete clears the title and mentions, retaining a tombstone so delayed create retries cannot resurrect them.

Dismissal stops notices and leaves the reminder readable through the explicit reminder API/tools until its configured retention window expires. The daily retention pass then erases its content and retains only the private idempotency tombstone described in §1.1. Mentioned entities are never changed.

The seven typed `hub_*_reminder(s)` tools use the existing tasks write-area gate and assistant preview policy. Reads do not write; create/update/dismiss/snooze are **low-risk writes**, delete is a **medium-risk non-undoable write**. No tool accepts a shell command or enables desktop notification setup on the user's behalf.

*Settings → Windows reminders → Set up → Enable* is an **explicit per-user opt-in**. It creates one Start Menu shortcut carrying Ensemble's `AppUserModelID` and a protocol-only stub activation CLSID, using Windows built-in APIs. **No COM server is registered.** It installs no executable, registry entry, service or scheduled task, and requires no manual command. The setup endpoint is **local-only** and binds this host to exactly one authenticated Hub user. Other users' reminders cannot be sent to that desktop. Ensemble must run in the signed-in Windows desktop session; the browser may be closed. Windows notification settings and Focus Assist remain authoritative; Ensemble uses normal notifications and the default sound rather than alarm/priority bypasses.

The host scheduler uses durable claims and a stable Windows toast tag, including after a restart. Interrupted claims expire; repeated delivery replaces the same notification instead of adding duplicate history entries. A crash between Windows delivery and the database commit can still repeat an alert: **this is not a claim of exactly-once delivery across the OS and database**. Delete/dismiss serialize with a bounded in-flight send, cancel future delivery and remove its toast.

Dates and times use the reminder's saved IANA time zone: date-only starts at 09:00, an explicit time starts 30 minutes before, and subsequent notices or snoozes wait 15 minutes. **22:00–09:00 is always quiet, with no urgency exception.** Deferral resolves the next local 09:00 across DST; nonexistent times shift forward by the DST gap and repeated times use the earlier instant. The native sender rechecks the delivery window after initialization and expires the toast at local 22:00. The receiving Windows desktop's own 22:00–09:00 window is also enforced: a reminder saved in a different zone cannot bypass it. Delivery waits for a permitted window in **both** zones.

Toast *Snooze 15 min* and *Dismiss reminder* use Windows protocol activation to open Today and apply a current, one-use, authenticated action. They are **not** background COM callbacks; closing/swiping a toast only hides that notice. The action token stays in the URL fragment, not HTTP request logs, and is removed from browser history after consumption.

**Validation:** `src/reminders/*.test.ts` with a fake clock/Windows adapter; `ENSEMBLE_REMINDER_INTEGRATION=1` creates and drops an isolated test database. `apps/hub-web/scripts/verify-reminders-ui.py` uses a fully intercepted browser fixture without a running server. Neither sends a real toast, runs a model, syncs connectors, or migrates personal data. A visible native-toast smoke test requires a separately coordinated opt-in.

UI behaviour, quiet hours and the PowerShell WinRT-null bug: [02 §14](02_MODULE_INTERACTION_HUB_UI.md#14-private-reminders).

---

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
