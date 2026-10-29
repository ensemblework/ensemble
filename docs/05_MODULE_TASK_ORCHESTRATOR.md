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

`workspace/queue-policy.ts` serializes claims on the space's user row and takes eligible jobs in assignment order. Jobs sharing a project, repository, folder/device resource (a folder, or one inside or around it, including folders a running job started changing and the folder a continued run works in: [24](24_DESKTOP_SANDBOXING.md)) or unfinished continuation wait for each other, whatever their engine or model; unrelated work can pass (`queueConflict`). Each queued card in Up next and the activity panel says why it waits (`waitingFor` from `queueWaitReason`): the pause, "Same folder as “…”, which is running" (or repository, project, continues), or every slot in use. A run in its own git worktree of a shared folder (an Ensemble Node build in parallel) holds `worktree:<name>` instead of the folder's `label:` key, so it waits only for runs in that worktree (`worktreeKeys` in `workspace/assign.ts`). Ensemble Node's plan steps also take turns before their runs are made, through resource claims ([35 §8.14](35_ENSEMBLE_NODE.md#814-parallel-work-in-one-repository)).

- `orchestration.maxConcurrentJobs`: 1–8, default **3**. Claimed, Running, Stopping and Waiting jobs use a slot.
- When a Needs me question or publishing approval has waited **60 minutes**, one extra job may start (**N+1** total). It is not refilled until fewer than N jobs remain.
- Answering continues the same job without taking another slot.

Runs of one agent session ([30](30_ENGINES.md), Agent sessions) run one at a time, in the order of the session's queue (`queue_position`: a queued message last, a steer first, as the owner reorders it), not of `continueFromJobId`. A claim of a session's run and every change to its queue hold the session's lock (an advisory transaction lock), and the claim sets the run's `continueFromJobId` to the session's run that actually ran last (`sessionTurn` in `workspace/sessions.ts`), so resume ancestry is always one true line ([35 §8.9](35_ENSEMBLE_NODE.md#89-session-control-from-the-card)).

Minutes, model turns and tool calls are separate per-run budgets; waiting on a person does not use minutes. Provider request concurrency has its own limiter.

## 5. Decisions and publishing

Needs me combines saved approvals, structured questions, tool-permission decisions and interrupted attempts, with exact choice IDs and the pending operation. A checkpoint saves messages, tool arguments, counters, receipts and the working-tree identity. Answering requeues the same job and resumes without replaying completed writes; a changed tree or stale decision voids the permission. In a shared space only the person whose computer runs the job answers its execution decisions.

**Requests close with their work.** When a run ends (succeeded, failed, cancelled, interrupted or blocked), its pending questions and permissions close as `expired` with the reason "Its work ended.", in the same transaction, whichever path ended it: the computer's complete, the lease sweep, a stop, a restart, a revoked computer. A database trigger does it (`workspace_jobs_close_decisions`, migration `20261102120000_node_session_control`; `WORK_ENDED` in `lib/decisions.ts`), so no path can leave one open. An editor's own prompts are not a run's and stay. A late answer is refused with "This request ended with its work." and changes nothing (`applyAnswer` in `routes/decisions.ts`); a request found pending after its run ended is closed then.

**The first answer wins.** Every answer, from the web, a phone, the CLI or a node (`node_answer_question`, [35 §8.11](35_ENSEMBLE_NODE.md#811-the-watchdog-and-the-agents-questions)), takes the request with a compare-and-set on `pending` (`decideOnce`); the rule it saves is written only by the answer that won. A second answer is told "Already answered." and changes nothing.

Publishing resumes from the reviewed payload and approval instead of replanning. An approval does not cover later, different writes.

## 6. Stop, interruption and retry

Pause stops new work and cancels active model and command activity. Stop on a task affects that task; Stop everything also cancels queued jobs. Partial files and evidence remain. Stop always ends the run: a command is killed with everything in its session, including processes that moved to a process group of their own (`killGroup`, `sessionMembers` in `workspace/runner.ts`); a tool call still going 30 s after Stop is left behind (`untilStopped`, `STOP_GRACE_MS`); and a paired computer that keeps checking in without ending a stopped run for 3 minutes has the run ended on the web (`endUnconfirmedStops` in `devices/settle.ts`), its slot freed and its task back in To do, while the computer keeps being told to stop it. An external request already accepted may still complete; stopping is not a remote rollback.

On restart, a server job left Running, Stopping or Waiting becomes interrupted and waits for an explicit retry. Remote jobs stay with their device until lease handling settles them; when the computer is back it reattaches a run that kept going or has one it lost to a restart carried on, at most twice ([25 §3](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#3-lease-heartbeat-and-interruption)). A coding engine that stalls or fails for a passing reason carries on in its own session ([30 §3.1](30_ENGINES.md#31-keeping-a-run-going)). Unknown mid-command outcomes are never replayed. A stopped checkout can stay reserved until cleanup is safe. Retry starts a new attempt; answering a saved decision resumes the old one, and the UI says which.

## 7. Evidence and feedback

`RunStep` stores the tool, message and reasoning events the engine reports. Job evidence holds the reported model, measured tokens, reported or estimated cost, changed-file metadata, result and run ID; unknown pricing stays unknown. Secrets-file contents are left out of previews.

Run feedback (`POST /api/runs/:id/feedback`) holds up to 100 entries of 4,000 characters and can start a linked follow-up job; it never edits the original. Completed-work learning is part of retention ([04](04_MODULE_SKILL_FORGE.md#4-completed-work-learning)).

## 8. Code not on this path

The Python `orchestrator/`, `workers/`, `tools/`, `policy.py` and `audit/ledger.py` in `apps/agent-runtime/ensemble_agent` are used only by their tests; assigning a task never runs them. `apps/hub-api/src/workspace/executor.ts` is not imported. Trace the HTTP or assignment entry point before documenting a capability.
