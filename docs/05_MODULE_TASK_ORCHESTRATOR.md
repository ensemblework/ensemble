# 05 · Task orchestration and scheduled jobs

Assigned work runs through a **Postgres-backed workspace queue in hub-api**, on the server (operators only) or on the person's paired computer. The Python runtime supplies hosted model calls and plot work; it does not plan or run assignments. See [06](06_MODULE_WORKSPACE_AND_SURFACES.md) for execution, [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) for device leases and [30](30_ENGINES.md) for external engines.

## 1. Execution path

```text
Task / deliverable / assistant / CLI assignment
    → workspace/assign.ts persists a WorkspaceJob
    → workspace/queue-policy.ts claims an eligible job
    → workspace/worker.ts (server) or a paired computer runs it
    → workspace/agent.ts: Ensemble's model/tool loop or an external engine
    → RunSteps, decisions, changed-file evidence → output, review, completion
```

`WorkspaceJob` is durable execution state; `Run` is one attempt and its evidence. Hosted model, connector and agent features need a verified email. Host filesystem execution is limited to verified operators (`lib/hosted-access.ts`); open signup requires `ENSEMBLE_SERVER_RUNNER=off` (`lib/production.ts`). A device claim never grants permission to run on the host.

## 2. Scheduled work

`jobs/scheduler.ts` ticks once a minute in-process (`ENSEMBLE_SCHEDULER=off` disables it). Postgres claims in `jobs/claim.ts` make daily slots idempotent across API processes. Per-account jobs skip accounts without a verified email; an account with no settings row uses defaults.

| Job | Behaviour |
| --- | --- |
| Housekeeping | Expired account-deletion logs, credit months ended over two days ago, pending decisions past `expiresAt`; interaction-log purge once a day ([07 §1.3](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#13-the-operators-interaction-log-and-dashboards)) |
| Device leases | `devices/lease.ts` settles expired remote claims as interrupted |
| Blob sweep | At most hourly, only when the server's blob store is on (`jobs/blob-sweep.ts`): removes file originals and plot tables nothing uses once an hour old, and moves plot tables still on disk into the store ([32](32_FILES.md#2-where-files-live), [20](20_PLOTS_DESIGN.md#2-data-ingestion)) |
| Reminders | Dispatch due in-app reminders, including ones missed while down |
| Morning brief | Once per local day at/after its set time, from the day after account creation |
| Stale notices, watchers | Built-in conditions only, not user programs |
| Retention | Daily at/after 03:30 local time; a missed day catches up ([07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)) |
| Scheduled fetch | Due only with `ENSEMBLE_SCHEDULED_FETCH=on`; even then `fetchAll(..., "schedule")` in `connectors/sync.ts` reads no provider |

Sync people is a separate, explicit, metadata-only action. There is no BullMQ scheduler, mail-to-task pipeline or user-defined routine. Local schedules need the local runtime running; hosted schedules do not wake a sleeping computer.

## 3. Task state and model selection

`lib/state-machine.ts` allows: Proposed → Todo/Dropped/In progress; Todo → In progress/Dropped/Done/Proposed; In progress → Waiting for approval/Blocked/Done/Todo/Dropped; Waiting for approval → In progress/Done/Blocked/Dropped; Blocked → Todo/In progress/Dropped; Done → Todo; Dropped → Proposed/Todo. Other moves are a 409. Snooze is `snoozedUntil`, not a status. Owner (`me`, `agent`, `unassigned`), status, priority and complexity are separate.

Complexity picks the Low/Medium/High/Max model profile; a complexity the person set is never reclassified. A job on the profile's own model takes its thinking level and context window too (`createJob` in `workspace/assign.ts`); a job on another engine or provider takes neither. Assignment freezes model, effort and execution settings for that attempt, validated before spending; later Settings changes do not rewrite queued work or evidence. Included models and personal keys are separate sources ([01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy), [33](33_INCLUDED_AI.md)).

## 4. Queue slots and limits

`workspace/queue-policy.ts` serializes claims on the space's user row and takes eligible jobs in assignment order. Jobs sharing a project, repository, folder/device resource or unfinished continuation wait for each other; unrelated work can pass.

- `orchestration.maxConcurrentJobs`: 1–8, default **3**. Claimed, Running, Stopping and Waiting jobs use a slot.
- When a Needs me question or publishing approval has waited **60 minutes**, one extra job may start (**N+1** total). It is not refilled until fewer than N jobs remain.
- Answering continues the same job without taking another slot.

Minutes, model turns and tool calls are separate per-run budgets; waiting on a person does not use minutes. Provider request concurrency has its own limiter.

## 5. Decisions and publishing

Needs me combines saved approvals, structured questions, tool-permission decisions and interrupted attempts, with exact choice IDs and the pending operation. A checkpoint saves messages, tool arguments, counters, receipts and the working-tree identity. Answering requeues the same job and resumes without replaying completed writes; a changed tree or stale decision voids the permission. In a shared space only the person whose computer runs the job answers its execution decisions.

Publishing resumes from the reviewed payload and approval instead of replanning. An approval does not cover later, different writes.

## 6. Stop, interruption and retry

Pause stops new work and cancels active model and command activity. Stop on a task affects that task; Stop everything also cancels queued jobs. Partial files and evidence remain. An external request already accepted may still complete; stopping is not a remote rollback.

On restart, a server job left Running, Stopping or Waiting becomes interrupted and waits for an explicit retry. Remote jobs stay with their device until lease handling settles them; when the computer is back it reattaches a run that kept going or has one it lost to a restart carried on, at most twice ([25 §3](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#3-lease-heartbeat-and-interruption)). A coding engine that stalls or fails for a passing reason carries on in its own session ([30 §3.1](30_ENGINES.md#31-keeping-a-run-going)). Unknown mid-command outcomes are never replayed. A stopped checkout can stay reserved until cleanup is safe. Retry starts a new attempt; answering a saved decision resumes the old one, and the UI says which.

## 7. Evidence and feedback

`RunStep` stores the tool, message and reasoning events the engine reports. Job evidence holds the reported model, measured tokens, reported or estimated cost, changed-file metadata, result and run ID; unknown pricing stays unknown. Secrets-file contents are left out of previews.

Run feedback (`POST /api/runs/:id/feedback`) holds up to 100 entries of 4,000 characters and can start a linked follow-up job; it never edits the original. Completed-work learning is part of retention ([04](04_MODULE_SKILL_FORGE.md#4-completed-work-learning)).

## 8. Code not on this path

The Python `orchestrator/`, `workers/`, `tools/`, `policy.py` and `audit/ledger.py` in `apps/agent-runtime/ensemble_agent` are used only by their tests; assigning a task never runs them. `apps/hub-api/src/workspace/executor.ts` is not imported. Trace the HTTP or assignment entry point before documenting a capability.
