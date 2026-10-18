# 06 · Workspace and assigned agents

Workspace is the execution/review view for work assigned from a task, deliverable, Today, assistant or CLI. **Code inspected 18 Oct 2026.** The normal runner is `workspace/agent.ts` behind the durable queue, not a fixed Python PR-author template or the older executor's tool names.

Hosted accounts can see their own job board. Host folder/checkout execution is operator-only; ordinary verified users target their own paired computer. `GET /api/workspace` can return a null host root/unavailable host sandbox without hiding their device jobs. Failed queries show Retry and device guidance.

## A. Coding Workspace

### A1. Assign once, then leave it working

The assignment dialog and `workspace/assign.ts` persist a `WorkspaceJob`. Changing owner to Agent alone is not execution authorization. The dialog explains the actual saved choices:

| Choice | Current behavior |
| --- | --- |
| Run profile | Up to three saved profiles plus a built-in Quick profile; update/save/rename/delete controls, and a star on each saved profile to make it the default. The default is the starred one, else the first saved, else Quick; Quick assign, the CLI and the assistant (`hub_assign_to_agent`) all use it unless another is named. Settings → Assistant → Run profiles also sets the default, renames and deletes |
| Kind | Research & writing (web/paper tools, writes the task page) or Code (works in a folder) |
| Run on | Permitted local/server execution or a paired computer; offline devices keep queued work |
| Engine | Ensemble, Claude Code, Codex or Cursor; own-app/terminal handoff is a separate option with the other tool's controls |
| Model/thinking | Task tier or explicit available override; engine-specific model selection when applicable |
| Place | Fresh run folder/clone, continuation of earlier work or an explicitly granted folder |
| Branch | Existing/as-is/new where supported; paired execution follows its advertised contract |
| Git | Local only, Commit or Commit + push; optional Ask before each commit |
| Mode | Ask, Review only or Run unattended; trusted-folder requirements apply |
| Sandbox/network/outside access | Actual OS capability and internet choice; read/read-write/none outside the work folder |
| Completion | Move task to Done or leave it for the person, according to the saved assignment |
| Budgets | Minutes, tool calls and model turns; waiting on a human is excluded from active time |

Some per-run controls (such as outside access) are not stored in the reusable profile. The dialog/API validate the chosen combination rather than invent a missing folder/engine/model. No-repository code work can use a fresh empty run folder. Profile/module restrictions still apply. [30](30_ENGINES.md) owns engine/handoff details.

### A2. Context and preparation

`brief()` in `workspace/agent.ts` assembles the title, description, instructions, actual task page, linked project/repo, source link, selected skills and relevant earlier attempt. `pages/agent-context.ts` adds owned embedded diagram source under a separate bound. Source IDs distinguish a saved task from a live connected-app item.

Attached app items from the task/project are included as bounded reference text (up to 12,000 characters locally; the device claim has its own bound). Supported file attachments are listed with excerpts; `read_attachment` reads in parts and `save_attachment` copies an original through the folder rules. External engines receive authorized temporary file copies. Device attachment transfer is lease-scoped and capped ([32](32_FILES.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#45-attachments-and-task-context)).

Fresh code work uses a new folder under the configured workspace; a requested repository is cloned through the trusted helper. A private clone resolves the person's configured Git credential/connection, not a token handed to the agent command. A fresh empty folder can be initialized; an existing user folder is not silently initialized/reset just to run a task.

Continuations reuse the earlier retained folder/branch and context. They do not recover uncommitted work by cloning a new copy. Folder resolution rechecks current paths/permissions; an absent, moved or refused directory is a blocker.

### A3. Filesystem boundary and external editors

`guard.ts` canonicalizes the work folder and refuses broad/system/secret/application-control locations. `tools.ts`, `trust.ts` and the OS backend enforce typed reads/edits/commands and outside-folder grants. An external folder can be worked in place and need not be a Git repository for non-Git work. Git evidence/actions are available only when applicable.

Sandbox on/off, outside read/read-write/none, local trust and mode are independent choices. Review only is a mode that can edit, not the read-only access grant. Network on is not a universal domain allowlist. [24](24_DESKTOP_SANDBOXING.md) is the authoritative backend/capability reference.

External engines launched inside Ensemble retain supported tool-call/permission enforcement. Opening work in the agent's own app or terminal uses that tool's own runtime settings. A separate editor reading the checkout can change it, so do not concurrently edit a folder reserved by another active task. The removed Teams/Outlook side-card prototype is not a supported surface.

### A4. Execution and completion

`executeJob` creates a Run and calls the selected engine or Ensemble's bounded model/tool loop. The agent uses the actual tools from `workspace/tools.ts`: file operations, command execution, context/attachments, questions, page output and finish. The old `workspace_*` catalog examples are not a contract for the current runner.

Mode/trust determines which operations wait. A denied tool call returns a readable result; it is not a license to try a different path around the rule. Budgets stop work while retaining partial progress. Unattended selects recommended structured decisions and reports them; it does not get additional filesystem/git authority.

Git permissions are enforced independently: local-only work cannot produce commits through another Git operation; unapproved script-made commits can be undone while keeping file changes. Trusted helpers prepare/publish permitted branches without exposing the credential to child commands. Exact saved publishing decisions can continue without replanning unrelated work. A pushed branch is not a merged PR or proof remote CI passed.

Success and final output are persisted before the UI reports the result. Research saves the actual deliverable on the page. Task/deliverable completion follows the saved assignment and owning completion logic; source checkouts remain available for review. Deleting Hub records does not silently delete a person's source folder.

### A5. Durable queue and global stop

`workspace/worker.ts` executes what `queue-policy.ts` claims. Claims serialize on the space user row; jobs sharing a project/repo, device resource/folder or unfinished continuation wait. The configured limit is 1–8, default 3. Claimed/Running/Stopping/Waiting jobs count. After a request waits 60 minutes, one extra task can start (N+1); nothing refills it until below N. [05](05_MODULE_TASK_ORCHESTRATOR.md#4-queue-slots-and-limits).

Pause prevents new work and cancels owned active model/command activity; Stop everything also cancels queued jobs. Partial files/evidence remain. A provider may finish a request already accepted; cancellation is not external rollback.

Exact tool/question checkpoints save messages, arguments, counters, receipts and tree identity. Answer requeues the same job/continuation; stale tree/decision state is refused. Server restart and device lease expiry mark unknown interrupted work for explicit retry, not silent mid-command replay. A resource can remain reserved until cleanup/reassignment is safe.

### A6. UI and retained evidence

Workspace/job cards and task Agent output link to Run evidence. `RunStep` stores the engine's supported tool, thinking and message events; it is not a fabricated inner monologue. Secrets-file read previews are omitted. Job evidence retains actual reported model, tokens/reported or estimated cost when available, bounded changed-file status/line counts, results and run ID. Unknown price remains unknown.

`changed-files.ts` compares start/end snapshots without rename detection and handles edits inside cloned repositories conservatively. Unsafe Git configuration is not executed merely to inspect it. `planted.ts` flags files that may run later. These flags do not certify the rest of a repository as safe.

`routes/job-files.ts` serves authorized stored/live job files. For paired jobs, text belongs to the executing person while other shared members can see permitted metadata. Code opens the device review ID and relays supported review/edit/source-control/terminal calls. [16](16_CODE_TAB.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web).

Run feedback is either a tag or a separately linked follow-up attempt. It does not edit recorded output. Run sheets keep Results, Files and Traces visible with resizing/fullscreen and bounded history.

## B. Related interfaces and limits

The Hub assistant uses a separate typed app-action loop ([11](11_HOW_THE_ASSISTANT_WORKS.md)). Ensemble Code can read a local folder and start an assigned agent; it does not directly execute every filesystem operation. The external Context Bridge is read-only ([13](13_MODULE_CONTEXT_BRIDGE.md)). Task-specific engine MCP/chat tools have a distinct run-scoped credential ([30](30_ENGINES.md)).

The source still contains legacy `workspace/executor.ts` and Python planner/worker code. Read the actual route/assignment path before treating a legacy tool name or endpoint as a current product capability. The normal queue is implemented; general mail/Teams/Slack sending, arbitrary routines and universal crash-replay are not promised by assigning a task.

## C. Verification

Use queue/assignment/tool/decision/engine and device tests for the affected path. API integration runs against isolated fixtures or dedicated Postgres/Redis; OS escape tests use the platform backend. Real-model/browser/installed-engine checks need their own environment. This documentation-only audit did not start agents, publish code, call external calendar accounts or change real task data.
