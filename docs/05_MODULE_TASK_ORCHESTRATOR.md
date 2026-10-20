# 05 · Task orchestration and scheduled product jobs

The normal assignment path is a **Postgres-backed workspace queue in hub-api**, executed locally or claimed by a paired computer. Research and code agents use model tools or supported external engines. Python supplies hosted model calls and plot work; its retained planner/worker modules are not the architecture of the current assignment UI.

Code inspected **18 Oct 2026**. See [06](06_MODULE_WORKSPACE_AND_SURFACES.md) for assignment/execution details, [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) for device leases and [30](30_ENGINES.md) for external engines.

## 1. Current execution path

```text
Task / deliverable / assistant assignment
    → workspace/assign.ts persists WorkspaceJob
    → workspace/queue-policy.ts claims an eligible job
    → local workspace/worker.ts OR paired device claims it
    → workspace/agent.ts executes research/code or an engine
    → tools, decisions, RunSteps and changed-file evidence
    → saved output / review / publishing continuation / completion
```

`Run` is an attempt and its evidence; `WorkspaceJob` is durable execution state. A pending proposal or a queued job is not completed work. Jobs sharing a project, repository, folder/resource or unfinished continuation are serialized.

Hosted public users need verified email for model/connector/agent features. Host filesystem execution is restricted to verified operators; ordinary accounts run on their own paired computers. Open hosting uses `ENSEMBLE_SERVER_RUNNER=off`. A device claim does not grant permission to run on the host.

## 2. Scheduled work

`jobs/scheduler.ts` runs an in-process minute tick. Postgres claims in `jobs/claim.ts` make daily slots idempotent across API processes. When file originals are in blob storage, the tick also runs `sweepOrphanOriginals` at most hourly ([32](32_FILES.md#2-where-files-live)). It visits accounts even when no settings row has yet been saved.

| Job | Current behavior |
| --- | --- |
| Private reminders | Dispatch due in-app reminders; platform notifications depend on a running app and permission |
| Morning brief | Deliver from the local day after account creation, once per local day, using current brief instructions/context |
| Stale notices and watchers | Evaluate the implemented product conditions, not arbitrary user programs |
| Device lease sweep | Detect expired remote claims and settle interrupted work |
| Retention | Catch up daily cleanup at/after 03:30 local time; notice and skill learning precede completed-work retirement |
| Account-deletion logs | Remove expired minimal logs |
| Legacy connector fetch slots | `fetchAll(..., "schedule")` returns without reading any provider |

`ENSEMBLE_SCHEDULER=off` stops the scheduler. `ENSEMBLE_SCHEDULED_FETCH=on` can make the legacy fetch slot due, but does **not** bypass the no-content-read branch in `connectors/sync.ts`. Sync people is a separate explicit metadata-only action. There is no BullMQ scheduler, `context.deltas` consumer or automatic mail-to-task pipeline in the normal product path.

Local schedules need the local runtime running. Hosted schedules do not wake a sleeping paired computer. Arbitrary recurring workflows/routines are not implemented.

## 3. Task state and model selection

The real transition table is `lib/state-machine.ts`:

- `proposed` can become Todo, Dropped or In progress.
- Todo can start, complete, drop or return to Proposed.
- In progress can wait for approval, block, complete, return to Todo or drop.
- Waiting for approval and Blocked have explicit recovery transitions.
- Done reopens to Todo; Dropped can return to Proposed or Todo.

Snooze is `snoozedUntil`, not a separate persisted task status. Owner (`me`, `agent`, `unassigned`), status, priority and complexity are separate properties.

Complexity selects Low/Medium/High/Max model profiles. A person-chosen complexity is not silently reclassified. Assignment freezes the requested model/effort and execution settings for that attempt. Discovered capabilities and effort are validated before spending; changing Settings later does not rewrite queued work or old evidence. Included-model funding and personal keys are separate sources ([01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy), [33](33_INCLUDED_AI.md)).

## 4. Queue slots and limits

`workspace/queue-policy.ts` serializes claims on the space's user row. Eligible work is considered in assignment sequence; unrelated work can pass a conflicting job.

- `orchestration.maxConcurrentJobs`: 1–8, default **3**.
- Claimed, Running, Stopping and Waiting jobs consume slots.
- A Needs me request/publishing approval unanswered for at least **60 minutes** permits one extra task, at most **N+1** total. It does not continually refill the extra slot.
- Answering continues the same work; it does not consume another slot.
- Once the extra task starts, new work waits until fewer than N jobs remain.

Per-run minutes, model turns and tool calls are independent budgets. Waiting on a human does not consume the active-time budget. Runtime model requests additionally share a separate limiter/cancellation path; queue capacity is not the same as provider request concurrency.

## 5. Decisions and publishing

Needs me combines saved approvals, structured missing-information questions, workspace tool-permission decisions and interrupted older attempts. Exact choice IDs and the pending operation are retained. A vague prose question is not automatically converted into a decision.

Workspace checkpoints save messages, exact tool arguments, counters, receipts and working-tree identity. Answering requeues the same job, returns the answer to the saved continuation and does not replay completed writes. A changed tree or stale decision invalidates the permission. In a shared space, only the person whose computer runs the job may answer its execution decisions.

Publishing resumes from the saved reviewed payload/approval, rather than replanning a new publish operation. Missing historical continuations require an explicit new attempt. An approval is not permission for arbitrary later writes.

## 6. Stop, interruption and retry

Pause prevents new work and cancels active model/command activity through the relevant controllers. Stop one task affects that task; Stop everything also cancels queued work. Saved partial files and evidence remain. A request already accepted by an external service may still finish; stopping is not a remote rollback.

On restart, a server job left Running/Stopping/Waiting becomes interrupted and waits for an explicit retry. Remote jobs retain device ownership until lease handling settles them. Unknown mid-command outcomes are not silently replayed. A stopped checkout can remain reserved until cleanup/reassignment is safe.

Retrying after failure is different from resuming an exact saved decision. The UI must report which applies.

## 7. Evidence and feedback

`RunStep` stores tool/message/reasoning events appropriate to the engine. Job evidence includes model used, measured tokens or reported/estimated cost where available, changed-file metadata, result and run ID. Secrets-file contents are excluded from previews. Requested model and actual reported model are distinct; unknown pricing stays unknown.

Run feedback is bounded (up to 100 entries of 4,000 characters) and can create a linked follow-up job. It does not overwrite the original attempt. Completed-work learning is the bounded retention pass in [04](04_MODULE_SKILL_FORGE.md#4-completed-work-learning), not a nightly general worker.

## 8. Legacy Python modules and verification

`apps/agent-runtime/ensemble_agent/orchestrator`, `workers` and `tools` retain planner/executor/policy code and tests. Do not infer from those files that assigning a task launches an email sender, Teams sender, day planner or work-item sync worker. Trace the actual HTTP/assignment entry point before documenting a capability.

Queue, state-machine, checkpoint, retention and device tests live beside the owning modules. CI exercises API integration with Postgres/Redis and sandbox paths on multiple systems. Test fixtures do not prove a live provider accepted an external write. Full implementation and residual execution boundaries are in [06](06_MODULE_WORKSPACE_AND_SURFACES.md) and [24](24_DESKTOP_SANDBOXING.md).
