# 06 · Workspace and assigned agents

Runs is where work assigned from a task, deliverable, Today, the assistant or the CLI is tracked and reviewed. Up next, Working now and Needs you sit above recent run history; `/workspace` opens `/runs`. The runner is `workspace/agent.ts` behind the durable queue in [05](05_MODULE_TASK_ORCHESTRATOR.md). [24](24_DESKTOP_SANDBOXING.md) owns sandboxing and permissions; [30](30_ENGINES.md) owns external engines and handoff.

Hosted accounts see their own job board. Running in host folders or checkouts is operator-only; other verified users target their own paired computer ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). `GET /api/workspace` can return a null host root or unavailable host sandbox without hiding device jobs. A failed query shows Retry and device guidance.

`components/runs/run-queue.tsx` keeps the `workspace` query and live invalidations, Assign task, Pause all/Resume, sharing and limits. Queue and history retain separate feature/API permissions. The slot count includes waiting jobs; its information popover explains the one-hour, one-extra-slot rule in [05 §4](05_MODULE_TASK_ORCHESTRATOR.md#4-queue-slots-and-limits).

## 1. Assigning

The Assign dialog (`components/agent/assign-dialog.tsx`) and `workspace/assign.ts` persist a `WorkspaceJob`. Setting the owner to Agent does not start anything by itself.

| Choice | Behaviour |
| --- | --- |
| Run profile | Up to three saved profiles plus built-in Quick (Review only, Git No limits, the task's tier). The default is the starred profile, else the first saved, else Quick; Quick assign, the CLI and the assistant (`hub_assign_to_agent`) use it unless another is named. **+ New profile** in the dialog saves the current choices as a profile; Settings → Assistant → Run profiles creates one too, edits its agent, computer, mode, Git, sandbox and internet, sets the default, renames and deletes. Opening the name editor selects the name, so typing replaces it |
| Agent | One picker (`components/agent/agent-picker.tsx`): **Auto** (Settings → Models for the task's complexity), Ensemble's included models, the person's own AI plans signed in on the run's computer (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity; [30](30_ENGINES.md)) with their usage, or a model on an API key. Only what can run is listed (signed in, key working), plus the current choice with how to fix it; a source tab shows only when there are two or more. Each model lists its cost and context sizes; the closed picker shows the agent, model and cost, and the button beside it sets the thinking level, context window (standard or long; `contextTier`) and fast mode that model takes |
| Runs on | Permitted server execution or a paired computer (an offline computer keeps the job queued); a coding agent goes to a computer that has it signed in. Without either, Ensemble's agent researches and writes on the server |
| Kind | Not chosen: work by a coding agent, on a computer or on a server that runs code happens in a folder (`code`, which can also research); otherwise Ensemble's agent researches and writes the task page (`research`; `autoKind` in `workspace/assign.ts`) |
| Where it works | Its own checkout (a new folder in the workspace; the agent clones or creates what the task needs), an earlier task's folder (the same agent resumes its own session there; [30](30_ENGINES.md), Agent sessions), or a folder of the person's |
| Mode | Ask, Review only or Run unattended; none needs a trusted folder ([24 §4](24_DESKTOP_SANDBOXING.md#4-trust-and-run-modes)) |
| More options | Instructions for this attempt; Git: No limits (default: commit, push any branch, open and merge pull requests with the computer's sign-in), Commit (no push), Local only (no commits), or Pull request (Ensemble opens it into any branch, from a repository named there for its own checkout, then asks before merging, merges when checks pass, or leaves it open; [24 §5](24_DESKTOP_SANDBOXING.md#5-git-and-credentials)); Ask before each commit (off by default); Branch: the agent decides, or an existing or new one by exact name ([16 §4](16_CODE_TAB.md#4-which-branch-the-agent-works-on)); sandbox (the OS capability actually present), internet, outside the workspace (read / read-write / none) and *Use my git sign-in*; opening in the tool's own app or a terminal; budgets (minutes, tool calls, model turns; time waiting on a person is excluded); Move the task to Done |

Outside access is per run, not stored in a profile. The dialog and API validate the combination rather than invent a missing folder, engine or model; an agent or computer with no OS sandbox runs with it off, and the dialog says so. Settings → Assistant → Models uses the same picker for each complexity tier (Low, Medium, High, Max), so a tier can name a coding agent on the person's plan; Auto then runs that agent (`withTierAgent` in `workspace/assign.ts`).

## 2. Context and preparation

`brief()` in `workspace/agent.ts` assembles the title, description, instructions, task page, linked project/repo, source link, selected skills and the relevant earlier attempt. `pages/agent-context.ts` adds owned embedded diagram source under its own bound. Source IDs distinguish a saved task from a live connected-app item.

Connected-app items attached to the task or project are included as reference text, up to 12,000 characters (a device claim has its own bound). File attachments are listed by name and follow the brief as the files themselves (a provider that refuses one gets the request again without it); `view_attachment` opens one again, and `save_attachment` copies an original into the folder under the folder rules. Plots and datasets mentioned on the page come with their settings and a data preview. External engines get authorized temporary copies ([38](38_AGENT_READABLE_FILES.md)). Device transfer is lease-scoped and capped ([32](32_FILES.md), [25 §4.5](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#45-attachments-and-task-context)).

Fresh code work gets a new folder under the workspace; a requested repository is cloned by the trusted helper with the person's configured Git credential, never handed to the agent. An existing user folder is never initialized or reset to run a task. Continuations reuse the earlier folder, branch and context; they do not recover uncommitted work from a fresh clone. Paths and permissions are rechecked, and a missing, moved or refused folder blocks the job.

## 3. Execution

`executeJob` creates a Run and calls the selected engine or Ensemble's model/tool loop with the tools in `workspace/tools.ts`: file operations, commands, context and attachments, questions, page output and finish. `guard.ts`, `trust.ts`, `git-gate.ts` and the OS backend enforce folder, command and Git rules ([24](24_DESKTOP_SANDBOXING.md)). An external folder can be worked in place and need not be a Git repository.

Mode and trust decide which operations wait. A denied call returns a readable result, not a hint to try another path. Budgets stop work and keep partial progress. Unattended picks recommended answers and reports them; it gains no filesystem or Git authority. Engines launched by Ensemble keep its tool-call enforcement; a tool opened in its own app or terminal uses its own settings. Another editor writing the same folder can change it, so do not edit a folder an active task holds.

Queue slots, checkpoints, Stop and interruption are in [05 §4–§6](05_MODULE_TASK_ORCHESTRATOR.md#4-queue-slots-and-limits).

Success and output are saved before the UI reports them. Research saves the deliverable on the page. Task completion follows the saved assignment; source checkouts stay for review. Deleting Hub records never deletes a person's source folder. A pushed branch is not a merged PR or proof that remote CI passed.

## 4. Evidence and review

Job cards and the task's Agent output link to the Run. `RunStep` stores the engine's tool, thinking and message events; secrets-file read previews are omitted. Evidence keeps the reported model, tokens, reported or estimated cost, bounded changed-file status and line counts, result and run ID; unknown prices stay unknown.

`changed-files.ts` compares start and end snapshots without rename detection and never runs unsafe Git configuration to inspect a cloned repository. `planted.ts` flags changed files that may run later; a flag does not certify the rest as safe.

`routes/job-files.ts` serves authorized job files. For a paired job only the person who ran it reads file text; other shared-space members see metadata. Code opens the run's review on that computer ([16](16_CODE_TAB.md), [25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web)).

Run feedback is a tag or a linked follow-up attempt; it never edits recorded output. Run sheets show Results, Files and Traces with resizing, fullscreen and bounded history.

Runs queues stack vertically below 1024 CSS pixels; recent history stays below them. On phones, Runs keeps titles and metadata above the status and actions. Its sheet fills the available width, with scrolling content and fixed header controls. Needs me buttons wrap the full answer, including unbroken words, without overlapping the recommendation.

## 5. Related interfaces

The Hub assistant has its own typed app-action loop ([11](11_HOW_THE_ASSISTANT_WORKS.md)). The Context Bridge is read-only ([CONTEXT_BRIDGE](CONTEXT_BRIDGE.md)). Engine MCP/chat tools use a run-scoped credential ([30](30_ENGINES.md)). Assigning a task does not send mail, Teams or Slack messages, run arbitrary routines or replay crashed commands.

Queue, assignment, tool, decision, engine and device tests sit beside their modules; OS escape tests use the platform backend. Real models, browsers and installed engines need their own environment.
