# 06 · Workspace and assigned agents

Workspace is where work assigned from a task, deliverable, Today, the assistant or the CLI runs and is reviewed. The runner is `workspace/agent.ts` behind the durable queue in [05](05_MODULE_TASK_ORCHESTRATOR.md). [24](24_DESKTOP_SANDBOXING.md) owns sandboxing and permissions; [30](30_ENGINES.md) owns external engines and handoff.

Hosted accounts see their own job board. Running in host folders or checkouts is operator-only; other verified users target their own paired computer ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). `GET /api/workspace` can return a null host root or unavailable host sandbox without hiding device jobs. A failed query shows Retry and device guidance.

## 1. Assigning

The Assign dialog (`components/agent/assign-dialog.tsx`) and `workspace/assign.ts` persist a `WorkspaceJob`. Setting the owner to Agent does not start anything by itself.

| Choice | Behaviour |
| --- | --- |
| Run profile | Up to three saved profiles plus built-in Quick. The default is the starred profile, else the first saved, else Quick; Quick assign, the CLI and the assistant (`hub_assign_to_agent`) use it unless another is named. Settings → Assistant → Run profiles also sets the default, renames and deletes. Opening the name editor selects the name, so typing replaces it |
| Kind | Research & writing (web/paper tools, writes the task page) or Code (works in a folder) |
| Run on | Permitted server execution or a paired computer; an offline computer keeps the job queued |
| Engine | Ensemble, Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI or Antigravity ([30](30_ENGINES.md)). Opening the work in the tool's own app or a terminal is a separate option that uses that tool's controls |
| Model / thinking | Task tier or an available override; engine-specific models where applicable. GitHub Copilot lists the plan's models from the computer with each model's thinking levels and, where it has two, its context window (standard or long; `contextTier`) |
| Place | Fresh run folder or clone, continuation of earlier work, or an explicitly granted folder |
| Branch | As is, existing or new, by exact name, also in a folder worked in place and from the web ([16 §4](16_CODE_TAB.md#4-which-branch-the-agent-works-on)) |
| Git | No limits (default: commit, push any branch, open and merge pull requests with the computer's sign-in), Commit (no push), Local only (no commits), or Pull request (Ensemble opens it into any branch, then asks before merging, merges when checks pass, or leaves it open; [24 §5](24_DESKTOP_SANDBOXING.md#5-git-and-credentials)); optional Ask before each commit |
| Mode | Ask, Review only or Run unattended; trusted-folder rules apply |
| Sandbox / network / outside access | The OS capability actually present, internet on/off, and read / read-write / none outside the work folder |
| Completion | Move the task to Done or leave it for the person |
| Budgets | Minutes, tool calls, model turns; time waiting on a person is excluded |

Some per-run controls, such as outside access, are not stored in the profile. The dialog and API validate the combination rather than invent a missing folder, engine or model. Code work without a repository can use a fresh empty folder.

## 2. Context and preparation

`brief()` in `workspace/agent.ts` assembles the title, description, instructions, task page, linked project/repo, source link, selected skills and the relevant earlier attempt. `pages/agent-context.ts` adds owned embedded diagram source under its own bound. Source IDs distinguish a saved task from a live connected-app item.

Connected-app items attached to the task or project are included as reference text, up to 12,000 characters (a device claim has its own bound). File attachments are listed with excerpts; `read_attachment` reads them in parts and `save_attachment` copies an original into the folder under the folder rules. When the run's model reads images, attached pictures follow the brief and `view_attachment` opens more. Plots and datasets mentioned on the page come with their settings and a data preview. External engines get authorized temporary copies ([38](38_AGENT_READABLE_FILES.md)). Device transfer is lease-scoped and capped ([32](32_FILES.md), [25 §4.5](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#45-attachments-and-task-context)).

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

Workspace queues stack vertically below 1024 CSS pixels; recent completed and stopped work uses one column below 768. On phones, Runs keeps titles and metadata above the status and actions. Its sheet fills the available width, with scrolling content and fixed header controls. Needs me buttons wrap the full answer, including unbroken words, without overlapping the recommendation.

## 5. Related interfaces

The Hub assistant has its own typed app-action loop ([11](11_HOW_THE_ASSISTANT_WORKS.md)). The Context Bridge is read-only ([CONTEXT_BRIDGE](CONTEXT_BRIDGE.md)). Engine MCP/chat tools use a run-scoped credential ([30](30_ENGINES.md)). Assigning a task does not send mail, Teams or Slack messages, run arbitrary routines or replay crashed commands.

Queue, assignment, tool, decision, engine and device tests sit beside their modules; OS escape tests use the platform backend. Real models, browsers and installed engines need their own environment.
