# 05 · Module M4 — Task Orchestrator (scheduled jobs, planner, workers, HITL)

**Purpose:** The engine that turns **signals into proposed todos**, **delegated todos into plans**, **plans into tool actions** — with explicit human control points, retries, and a full trace. The planner, executor and workers live in `apps/agent-runtime/ensemble_agent/{orchestrator,workers,tools}`. hub-api drives them: the in-process scheduler (`apps/hub-api/src/jobs/scheduler.ts`) runs fetches, and the Postgres-backed workspace queue (`apps/hub-api/src/workspace/worker.ts`) runs delegated jobs.

**Run only one agent-runtime instance**; two consumers on the same queue leave jobs stuck.

For hosted public accounts, email verification is required before scheduled model/connector/agent work. Public users do not receive the operator's environment or CLI credentials. Host filesystem execution is operator-only; verified users can still queue work to their own paired device. Keep `ENSEMBLE_SERVER_RUNNER=off` for open hosted signup; production startup refuses an unrestricted runner.

---

## 1. Architecture

```text
 Scheduled fetch (BullMQ)                     context.deltas (Redis stream)
 ├─ morning_fetch 09:00                                  │
 ├─ evening_fetch 16:00                                  │
 └─ Fetch now (button)                                   │
            │                                            │
            └──────────────┬─────────────────────────────┘
                           ▼
                    Todo Proposer ──► Task (status = proposed)
                           │
                           ▼   (engineer triages; owner = agent)
        proposed → todo → in_progress → waiting_approval → done
                           │
                           ▼
 Planner:  task + context pack + skills → PlanStep[] (structured),
           on the model the task's complexity picked
                           │
                           ▼
 Executor: step loop, retries, HITL gates, ledger
                           │
                           ▼
 Workers (Agent Framework agents + tools):
   email_reply · pr_author · meeting_actions · day_planner ·
   workitem_sync · doc_author · teams_reply · research
                           │
                           ▼
 Guarded tools (MCP): graph · github · ado · workspace
```

---

## 2. Scheduled work

`jobs/scheduler.ts` still dispatches reminders, the morning brief, stale notices, watchers, device lease sweeps and retention. Generic connector fetching is manual. `fetchAll(..., "schedule")` returns without reading a provider; old fetch times and `ENSEMBLE_SCHEDULED_FETCH` do not enable content ingestion.

**Sync people** runs `connectors/people-sync.ts` through `POST /api/fetch` or `POST /api/connections/:id/sync`. It reads bounded contact metadata, filters services/newsletters/bots with fixed rules and upserts real people. It saves no artifacts and makes no model call. Files, messages and transcripts are read/saved through explicit requests ([03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors)).

## 3. Todo Proposer

Input: `TodoCandidates` (from extractions, deltas). Steps:

1. **Dedupe:** embedding similarity ≥ 0.88 with existing open tasks, or same source artifact → merge (append evidence).
2. **Classify** (classifier model, JSON):
   - `taskType ∈ {reply_email, reply_teams, open_pr, review_pr, write_doc, update_workitem, schedule, research, code_change, other}`
   - `priority` (deadline, asker seniority/relationship, explicit words)
   - `estimate` (S/M/L)
   - `complexity ∈ {easy, medium, high, max}`
   - `agentSuitability` 0–1 with reason (*"routine data reply → high"*; *"design judgement → low"*)
3. **Suggest owner:** default *unassigned*; pre-highlight *Agent* when suitability ≥ 0.7 and risk is low.
4. **Create** `Task(status='proposed', createdBy='agent')` with provenance, confidence and complexity; emit SSE `task.created`.

**Quality guard:** cap proposals to 12/day; below confidence 0.5 → shown muted, auto-dropped after 3 days.

### Complexity, and why it is not priority

`complexity` is **how much reasoning the work needs**; `priority` is **how soon it matters**. They are deliberately orthogonal: an urgent easy task is still easy, and spending a bigger model on it buys nothing.

Every task gets one on creation — from the classifier when a model is available, otherwise from the rules in `lib/complexity.ts` — and carries `complexitySource` so the board can say who decided. Setting it yourself pins it to `me`, and **nothing re-infers a tier the engineer has chosen**.

The tier resolves to a model through the mapping in Settings. hub-api resolves it and puts the answer on the job; agent-runtime **re-checks it against the approved set** rather than trusting a payload that arrived over a queue.

---

## 4. Task state machine

```text
                   ┌──(Me)─────► todo (owner = me)
                   │
 proposed ─────────┼──(Agent)──► todo (owner = agent) → in_progress → waiting_approval → done
                   │
                   ├──(Later)──► snoozed
                   └──(Drop)───► dropped

 in_progress ──► blocked(needs_info) ──(me answers)──► in_progress
 in_progress(agent) ──(me: Take over)──► in_progress(me)   [agent draft attached]
```

> The "Me" branch follows 02 §3.

Transitions are logged with **actor + reason**. `blocked(needs_info)` produces a **question card** in Needs Me (structured: options + free text), never an open-ended chat.

---

## 5. Planner

**Prompt inputs:** identity block, task, context pack summary + item list, suggested skills, available tools with risk levels, autonomy setting for this task.

**Output (structured):**

```json
{
  "goal": "…",
  "successCriteria": ["…"],
  "steps": [
    { "id": "s1", "title": "Gather latency numbers from dashboard link in thread",
      "tool": "graph.mail.read|web.fetch", "risk": "low" },
    { "id": "s2", "title": "Draft reply in Akash's tone",
      "tool": "llm.draft", "skill": "email-reply.default", "risk": "low" },
    { "id": "s3", "title": "Send reply to Priya",
      "tool": "graph.mail.send", "risk": "high", "gate": "approval" },
    { "id": "s4", "title": "Add comment to WI 8812 with numbers",
      "tool": "ado.workitem.comment", "risk": "medium", "gate": "policy" }
  ],
  "questionsForUser": []
}
```

**Rules:** ≤ 8 steps; every write step names its gate; if a required fact is missing and not in context → add a `questionsForUser` entry instead of guessing (becomes `blocked(needs_info)`).

---

## 6. Executor

```python
for step in plan.steps:
    ledger.step_started(run, step)
    if step.gate == 'approval' or policy.requires_approval(step, autonomy):
        preview = worker.preview(step)                       # exact payload as it will be executed
        approval = await hitl.request(run, step, preview)    # SSE Needs Me card; awaits decision
                                                             # (with timeout → stays waiting)
        if approval.decision == 'rejected':
            ledger.rejected(...); mark_task_blocked(); break
        payload = approval.editedPayload or preview
        skills.feedback(step, preview, payload, approval)    # learning signal
    result = await guarded_tools.call(step.tool, payload, run=run, approval=approval)  # writes ledger row
    if result.failed:
        retry(step, max=2, backoff=True)
    else:
        mark_done(step)
        sse.emit('run.step', ...)
```

- **Run is resumable:** state persisted after each step; process restart continues.
- **Pause agent** (global) or per task → executor checkpoints and stops before the next tool call.
- **Concurrency:** max 3 agent tasks in progress; queue the rest (visible on board as "queued").

**Repository execution** now uses the durable **Workspace queue** in hub-api, rather than the Python planner's fixed PR-author template. Per-assignment sandbox/native and unattended/review choices, conflict locks, process cleanup, publish-only approval continuation and verified task/deliverable completion are documented in [docs/06 A1–A6](06_MODULE_WORKSPACE_AND_SURFACES.md#a-coding-workspace). Postgres coordinates execution slots with legacy workers; busy legacy jobs return to the queue without making model calls. All model entry points additionally share a three-request Redis limiter and the global stop controls.

---

## 7. Workers (v1)

| Worker | Plan template | Tools | Skills | Gate |
|---|---|---|---|---|
| `email_reply` | read thread → gather facts (context/dashboards/docs) → draft → send | `graph.mail.*`, `web.fetch`, `graph.files.read` | `email-reply.*` | send = approval (default) |
| `teams_reply` | read chat → draft → post | `graph.chat.*` | `teams-reply.*` | post = approval |
| `pr_author` | clone/branch → apply change (scripted or LLM patch) → run tests → commit (style skill) → open PR (description skill) → notify reviewer | `workspace.*`, `github.*` | `commit-message.*`, `pr-description.<repo>`, `coding-prefs.*` | PR open = approval; push to branch = policy (low) |
| `meeting_actions` | transcript → recap → action items → create todos → (optional) send notes to attendees | `graph.transcripts`, `graph.mail.send` | `meeting-notes.default` | send notes = approval |
| `day_planner` | calendar + tasks + prefs → plan → (optional) create focus blocks | `graph.calendar.*` | `day-planning.default` | create events = approval |
| `workitem_sync` | task done → propose WI state/comments | `ado.*` | — | update = policy (medium → approval unless autonomous) |
| `doc_author` (P1) | ADR/status update from context → draft in OneDrive | `graph.files.write` | `docs.*` | share = approval |
| `research` | gather + summarize (read-only) | `web.search` *(plus other read tools — partly illegible)* | none | none |

Each worker = a Microsoft Agent Framework `Agent` with a **bounded toolset**: workers are single-purpose so traces stay readable. Multi-agent split (Researcher → Drafter → Reviewer) is an optional P2 upgrade for `email_reply` and `pr_author`.

---

## 8. Autonomy levels & gates (see [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#2-action-policy-the-gates) for policy detail)

| Level (per task, default from settings) | Read tools | Drafts | Low-risk writes (branch push, WI comment) | High-risk writes (send mail, post Teams, open PR, WI state) |
|---|---|---|---|---|
| `assist` | auto | auto | approval | approval |
| `supervised` (default) | auto | auto | auto + ledger | approval |
| `autonomous` (per-task opt-in) | auto | auto | auto | auto, with 5-min undo window where possible + digest notification |

---

## 9. Failure handling

- **Needs me** combines persisted publishing/external-write approvals, structured planner questions, workspace tool-permission/question checkpoints and genuinely interrupted older attempts. Workspace decisions retain exact choice IDs/labels and optional custom text; resuming uses the saved continuation, not a newly planned command. See [docs/06 A5](06_MODULE_WORKSPACE_AND_SURFACES.md#a5-durable-queue-and-global-stop). In a shared space, everyone there sees a run's questions, but only the person whose computer runs it may answer (`canAnswer` from `lib/decisions.ts`, checked in `applyAnswer`); hosted-run approvals and the owner's own editor prompts stay the owner's ([29 §4](29_SHARING.md#4-agent-runs-in-a-shared-space)).
- **Tool errors:** retry ×2 with backoff; Graph 429 honours `Retry-After`.
- **LLM structured-output validation failure:** re-ask once with error, then mark step failed with readable message.
- **Missing info** → `blocked(needs_info)` question card (options grounded in context).
- **Stale context** (thread updated during run) → re-build pack, re-plan from current step; note in trace.
- **Everything failed** → task returns to *todo (agent)* with "needs attention" badge; **never silently dropped**.
- An ordinary prose response implying *"tell me X/Y/Z before I can continue"* is **not** automatically turned into a decision. Leave that for a later conversation — do not invent an implicit-question parser now.

---

## 10. Observability

OpenTelemetry spans: `job.*`, `proposer`, `plan`, `run.step`, `tool.call`, `llm.call` (model, prompt version, tokens). Trace id stored on `Run` → "Open trace" link in the Runs page (Foundry tracing / App Insights).

---

## 11. Dev checklist

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

- [ ] BullMQ job definitions + cron; `agent.status` SSE
- [ ] Redis stream consumer → Todo Proposer (dedupe, classify prompt + schema)
- [ ] Task state machine (transitions table + guards)
- [ ] Planner prompt/schema; tool catalog with risk levels
- [ ] Executor with HITL await (Postgres approvals + SSE) and resumability
- [ ] Workers: `email_reply`, `pr_author`, `meeting_actions`, `day_planner` (P0); `teams_reply`, `workitem_sync` (P1)
- [ ] Guarded tool layer → ledger
- [ ] Golden scenario test: ingested mail → proposals → delegate → approvals → mail sent

---

## 12. As built

| Area | Where | Notes |
|---|---|---|
| Fetch cycle | `apps/hub-api/src/jobs/fetch.ts` | One function behind both scheduled fetches and the button. `nextFetchAt` takes the timezone as a parameter rather than reading the environment, so the rollover logic is pure and pinned by tests in both directions. |
| Schedule | `apps/hub-api/src/jobs/scheduler.ts`, `jobs/claim.ts` | In-process scheduler. Legacy fetch slots perform no provider read. Contact metadata sync is manual. `claim.ts` takes a Postgres claim so two API processes do not run the same slot twice. |
| Complexity | `apps/hub-api/src/lib/complexity.ts` | Rules used when no classifier model answers. Deliberately shallow: a wrong tier costs a slightly better or worse model on one task, and pretending to more precision than that would cost more. |
| Tool catalog | `apps/agent-runtime/ensemble_agent/tools/catalog.py` | Single source of truth for risk, gate, reversibility and undo window. The planner's gate output is **recomputed from here and never trusted from the model**, so a hallucinated `"gate": "none"` on a send cannot slip past. |
| State | `apps/hub-api/src/lib/state-machine.ts` | `ALLOWED` transition table plus guards. `/triage`, `/delegate`, `/takeover` and `/answer` all route through `transitionTask`, so every move is logged with actor and reason. |
| Planner | `apps/agent-runtime/ensemble_agent/orchestrator/planner.py` | Structured JSON plan with a template fallback per task type, on the task's own model. |
| Executor | `apps/agent-runtime/ensemble_agent/orchestrator/executor.py` | Gated step loop with retries, `Retry-After` backoff, pause and resume-at-step. |
| Workers | `apps/agent-runtime/ensemble_agent/workers/planned.py` | Seven workers routed by `taskType`. |

### Every run names its model, and what it cost

A finished run records **the model that produced each step and the credits it was billed at**. Both are per step rather than per run, because the model that answers is not always the one that was asked for: an unavailable model is substituted mid-run, and pricing the whole run at the requested rate would quietly misreport the spend. `runs.complexity` and `runs.requested_model` are **pinned when the run starts**, so a finished piece of work still names the tier and the model it was produced under after the Settings mapping is changed.

Credits are an **estimate** and are labelled as one in the UI. The Copilot API reports tokens and never credits, so the number comes from a per-model multiplier — overridable with `ENSEMBLE_MODEL_CREDITS` — rather than from the provider.

### Run outcomes are five, not three

`success | failed | cancelled` could not express what the agent actually does. A run that stopped to ask a question was recorded as *failed*, and a run parked at an approval gate as *cancelled* — so the Runs page painted correct, careful behaviour as breakage. `RunOutcome` now also has:

- **`needs_info`** — the planner refused to guess a missing fact (§5). The question is persisted on `tasks.blocked_question` and rendered **amber, not red**.
- **`waiting_approval`** — the executor stopped at a gate and will resume when the engineer decides.

### The planner cannot silently do nothing

Two guards sit between the model and the executor:

- **Answered questions are dropped.** A resumed run passes the engineer's answer back into the prompt. Models re-ask anyway, so once an answer exists the questions are cleared — otherwise answering loops forever.
- **Reply-shaped tasks must contain a write step.** If a plan for `reply_email` / `reply_teams` / `open_pr` / `update_workitem` / `schedule` contains no write tool, it is discarded for the template. Without this a `reply_teams` task could be marked done having sent nothing at all. A *blocked* plan is exempt: it omits steps on purpose, and falling back would make the agent act on the guess it just refused to make.

### Known gaps

`research` and `write_doc` tasks block on `needs_info` readily. That is correct behaviour, but a demo wants well-specified tasks or pre-answered questions.

---

## 13. Decisions are actionable, not just run statuses

**Questions:** *Needs me* reads actual `blockedQuestion` data as well as approval rows. The question is also saved on the run. Answering verifies that the question is still current and queues grounded work using the answer and saved task context. If enqueueing fails, the question is **restored for retry** rather than disappearing into an apparently running task.

**Approvals:** the worker now calls `POST /api/internal/runs/:runId/approval` before reporting a parked run. The approval and exact continuation (plan, step index, payload, gathered context, autonomy) are **persisted together**. A `(runId, stepIndex)` key prevents duplicate cards. The queue-completion bridge remains compatible with older workers but cannot create a second card for the same saved step.

Approving or editing queues a **durable, approval-ID-keyed continuation** instead of publishing a notification with no subscriber. The worker reuses the same run, validates the saved plan against the tool catalog, skips completed steps, and uses the exact reviewed payload **without re-planning** or spending planner credits again.

A Graph draft-save step is preceded by real drafting when the plan omitted it; the approval must not preview placeholder text.

**Older interrupted attempts:** some runs predate saved continuations. Their approval may already be decided, or a card was never persisted. The UI labels these **Interrupted**, explains the missing continuation, and offers explicit retry/takeover. It **never guesses a missing approved payload** or automatically replays an old action.

This is approval-checkpoint recovery, not a claim of arbitrary mid-step crash recovery.

The Runs overview is limited to eight recent attempts and a disclosure for the previous ten *(02 §3.4 says 10; check `apps/hub-web/app/(hub)/runs`)*. The database history and per-task run-history pagination remain intact.

## Queue and completed-work learning (16 Oct 2026)

Code inspection: `workspace/queue-policy.ts` serializes claims on the user row for both server and device claims. Eligible jobs are visited by assignment sequence. Claimed, running, stopping and waiting jobs count toward `orchestration.maxConcurrentJobs` (1–8, default 3). A pending Needs me question or publishing approval at least 60 minutes old permits one extra task, at most N+1 total. Answering does not take a second slot. After the extra task starts, nothing new starts until fewer than N jobs remain; one unanswered request cannot repeatedly refill that extra slot. The same project or repository, the same computer’s resource keys, and unfinished continuation chains remain mutually exclusive.

`jobs/skill-mining.ts` warns in the bell at least 24 hours before learning from expired completed work. The daily retention pass uses the **High** model, validates structured skills, versions updates, then writes completion records and moves the batch to Trash atomically. A failed/offline model, pin, reopen, active job or conflicting skill edit preserves the work for a later pass. Batches contain at most 50 tasks and 50 deliverables; the notice state is a per-space `hub.retention-mining` preference. Trash is purged using the existing trash retention setting, including the completion records made when it entered Trash.

The scheduler visits all accounts, including those with no saved settings row. Morning briefs begin on the local day after account creation, use the profession default/personal skill, and are idempotent per local day. The native app/local runtime must be running for local schedules.

### First-brief introduction lifecycle

Delivery starts on the local day after signup. The introduction belongs to the account, and `cowork/brief-prompt.ts` records its first offer before the Hub opens it. Dismissal, saving and later deliveries do not reset it. A data-only migration retires introductions for existing accounts that already received a brief. Scheduling and the permanent `/morning-brief` editor are unchanged. Code inspection and focused regressions, 17 Oct 2026.
