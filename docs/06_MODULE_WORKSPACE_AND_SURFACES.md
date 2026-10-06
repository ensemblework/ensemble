# 06 · Module M5 — Coding Workspace (VS Code / container)

**Purpose:** Execute delegated repository work using Ensemble's connected context. Workspace is the **agent's workboard**, not a second chat. The engineer's board and task/deliverable pages are the assignment and review surfaces. Surface-assist cards inside Teams and Outlook were removed; [section B](#b-surface-assist--designed-built-then-deleted) records why.

Hosted production permits public accounts, but host checkout/filesystem/tool execution is restricted to verified operators (`lib/hosted-access.ts`). Open signup requires `ENSEMBLE_SERVER_RUNNER=off`; ordinary verified users can assign to their own paired device without acquiring server execution privileges. Local and desktop execution keep the existing controls below.

| Choice | Meaning |
|---|---|
| **Docker sandbox (default)** | Commands see only the assigned checkout mounted from the Windows workspace. |
| **Native Windows** | Commands use PowerShell noninteractively, with scoped file tools and workspace-local caches. **Not an OS sandbox:** scripts can technically reach other host paths. The form warns before assignment. |
| **Repository** | An explicit repository, resolution from the task/project/notes, or **no repository at all** — an empty private folder in the workspace. |
| **Completion outcome** | Local files only (default), local commit, commit/push to the selected working branch, or a new branch plus PR. Work without a repository is always local-only. |
| **Review first (default)** | Save an approval before any selected commit/push/PR action. Local-only tasks need no publishing approval. |
| **Unattended** | Authorizes only the selected outcome, not additional Git actions. No interactive questions or approval prompts. |
| **Model** | Optional override from the existing approved model set; otherwise the task's complexity mapping. |
| **Handoff / branches** | Optional checkout path inside the workspace, starting branch, and PR target branch. |
| **Limits** | Default 40 model turns / 60 active minutes, bounded per assignment. |

---

## A. Coding Workspace

### A1. Assign once, then leave it working

*Hand to agent* on a task, *Assign to agent* on a deliverable, Today triage (including the `a` key), and Workspace's *Assign task* use the **same assignment form**. Coding delegations from the Hub assistant also enter the same durable queue. The form deliberately replaces the old one-click/popover delegation: execution mode, publishing authorization and an existing-checkout handoff need an explicit, inspectable choice.

A genuine blocker **stops the run** and saves the reason and partial work. Review, blocked and stopped states make **no further model calls**. Approval queues a **publish-only continuation** using the exact reviewed tree and payload, without re-planning. There is **no automatic retry** of a failed or interrupted write.

**Local reports** are a complete outcome, not a failed PR workflow. They stay on the selected branch, leave new files untracked and unstaged, verify their contents/checksums, and close the task without committing or pushing. **Push-only** tasks commit and push only to the selected feature branch and do not call PR creation. `main`, `master`, the repository default branch and protected push targets are refused. Comparing with the default branch is read-only.

The working branch is selected in the form or resolved from an explicit *"switch to branch …"* instruction. Ambiguous names are refused. Additional instructions are saved and shown directly on task and run pages. Clear *"do not commit / push / create a PR"* constraints veto conflicting selections before execution.

**Take over is optional, not a workflow gate.** Use it when you want to edit an active checkout yourself. It stops execution before transferring ownership and reserves the checkout for manual work. Handing it back reuses that task's saved checkout. The browser can be closed; the Ensemble host must remain running and awake.

### A2. Context is consumed, not merely collected

Context is rebuilt when a queued job starts, using the shared context-pack builder and skill router. The saved snapshot contains task and deliverable notes, project notes/people/repos, source artifacts, related tasks, relevant preferences, identity, and the actual enabled skill bodies and versions. Explicit skills rank first; automatic routing excludes mismatched repository/task scopes and includes the coding, commit and PR-authoring stages.

The agent can use the assistant's existing **read-only Hub Action Layer** for further lookup, and a paginated context reader for long notes or skills. It **cannot issue SQL or modify Ensemble's application code** to close a task. The executor closes the assigned task through the shared state machine and note-mirroring functions.

Repository selection is: explicit task choice, the linked repository, a unique project repository, or an unambiguous GitHub link in the task/project/source. **Ambiguity is reported, never silently resolved** to an arbitrary repository. Retrieval remains graph plus Postgres full-text search; this does not claim embedding retrieval where no embedding service is configured.

**Branches are chosen, not spelled.** Once a repository is known, the working and comparison branch fields are lists populated from `GET /api/repos/:id/branches`, which reads the remote over the same credential the job's fetch will use. A mistyped branch used to cost an entire assignment and surfaced only when the job reached its fetch, several steps later. A name that cannot be typed cannot be mistyped. If the remote cannot be read the field degrades to free text and says why, rather than blocking the dialog; the fetch then reports the mistake with the branch list and the closest match.

Both branch fields, the advanced checkout path and the run limits sit behind a single **Optional information** disclosure. They are rarely touched, and three separate sections pushed the controls that *are* touched — repository, sandbox, outcome, model — off a laptop screen.

**Work that needs a machine but no repository** selects *no repository* instead. That job gets a fresh empty folder in the workspace, initialised as a local-only Git working tree with no remote, so the same snapshot, secret scan, result-file states and *"nothing was committed"* verification apply to it. It reserves only that folder — not the project's repositories — resolves context without repo scoping, and **rejects commit, push and PR outcomes**, because it has nothing to publish to. A task's linked repository is ignored for that run and is never unlinked.

The exact context and instructions are saved in the job record and in `.ensemble-agent/context.json` / `AGENTS.md` inside the checkout. The control/cache directory is excluded from Git. The earlier editor helper's `ensemble/context.json` remains a compatibility surface, not the new executor.

#### A folder you choose, outside the workspace

The containment rule does not weaken — it **moves**. An ordinary job may not leave `ENSEMBLE_WORKSPACE_ROOT`; a job given an external folder may not leave that folder. Both are the same `workspacePath()` call with a different root argument, so the symlink, alternate-stream and Windows device-name hardening is **one implementation** rather than a second, weaker copy. `WorkspaceExecutor` now carries that root, and every boundary check inside it — file tools, command `cd`, Git storage, control files — is measured against it.

Three properties make the grant meaningful:

1. **Resolved once, pinned per job.** The chosen path is resolved through symlinks at assignment and stored on `workspace_jobs.external_root`. A junction swapped in afterwards cannot redirect a run the engineer already approved. The grant itself may not be a link — the real directory has to be named.
2. **Refused where "confined to that folder" stops meaning anything:** a drive or filesystem root, Windows system directories, the home directory itself (a project *inside* it is fine), the Ensemble workspace root, and **Ensemble's own source tree** — an agent that can edit the guard rails has none. The last one is the easiest to forget and the most important.
3. **Sandbox is the safer choice here, not the weaker one.** The container bind-mounts only that folder, so it cannot see the rest of the disk at all. Native execution on an external folder runs as the engineer's Windows user and can reach everything; that combination is available, and is the one the information icon warns about.

The folder is **worked in place**. Nothing is cloned, fetched, reset or branch-switched: the uncommitted work sitting there is usually the whole reason it was chosen (*"review what I have, then commit it"*). Preparation only confirms it is a checkout, records where it started, and excludes the control directory from Git. **It must be a Git checkout** — Ensemble's evidence of what changed is derived from Git, and running `git init` inside someone's folder uninvited is exactly the surprise this must not spring.

Publishing still obeys the completion outcome, identically to an internal checkout. `local` writes files and stages nothing. `commit`, `push` and `pull request` are recorded against a repository Ensemble tracks, matched from the folder's own origin; an **untracked remote is refused with the fix** rather than papered over with a synthetic record that would corrupt the task's repository link and the audit trail. There is no path by which an outcome publishes more than the engineer selected.

Choosing the folder is a **native dialog**, opened by hub-api on the engineer's own desktop and validated before it is returned. A browser cannot supply an absolute path — `showDirectoryPicker` and `<input webkitdirectory>` withhold it by design — so the alternative is typing one, and a mistyped path costs an assignment.

The endpoint applies the same locality rules as the reminder setup: same shape of risk, same answer. **Localhost first** — a native folder picker on this machine is enough. A typed-path field can exist for when the picker cannot run; check it with `POST /api/workspace/resolve-folder` on blur (same `resolveExternalRoot` as the picker).

It is `IFileOpenDialog` with `FOS_PICKFOLDERS` — the Explorer window every other application opens, address bar and Quick Access included — declared through COM interop, **not** `FolderBrowserDialog`. The latter is the cramped tree-view box from Windows 2000, and on Windows PowerShell 5.1 its WinForms build is old enough that `UseDescriptionForTitle` does not exist at all, which made the first attempt fail with nothing but *"could not be opened"*. The COM interface is declared in **full vtable order** because COM dispatches by slot: omitting an unused method silently calls the wrong one. Failures now carry PowerShell's own message rather than a generic sentence.

### A3. The filesystem boundary and VS Code

`ENSEMBLE_WORKSPACE_ROOT` defaults to `<home>/ensemble-workspace` (or `<home>\ensemble-workspace` on Windows). A fresh job uses `runs/<job-id>/repo`. Existing checkouts must be descendants of this root. Traversal, prefix lookalikes, symlinks/junctions, external worktrees and alternate Git object stores are refused by the scoped tools.

**Stacked work continues in the same checkout.** Task 1 writes a report and is told not to commit it; task 2 acts on that report. A fresh assignment allocates a new `runs\<job-id>\repo`, which is a clean clone — so task 2 would not have the report at all, because a file that was deliberately never committed exists only in task 1's working tree.

The assignment has always accepted an explicit checkout path, and the reservation rules already let an explicit path move a checkout between tasks. What was missing was any way to *find* it: the path contains a run UUID, and nobody remembers `runs\f3b19370-fed4-4002-b2bf-65eea051b5e1\repo`.

`GET /api/workspace/checkouts` therefore lists reusable checkouts by the thing the engineer **does** remember — the task they belong to — with the branch and the number of uncommitted files in them right now, read from the working tree rather than from the job row, because the checkout may have been opened in VS Code since. The dialog offers them as *Continue from*, defaulting to a fresh checkout. Three rules keep the list honest:

- A path that no longer exists, or that never became a real checkout (an unborn HEAD from a failed clone), is dropped. An option that fails the moment it is chosen is worse than no option.
- A deleted task does not consume its path. Deleting the later task of a stack must not hide the folder holding the earlier task's work, so the next-newest job for that path labels it instead.
- Continuing does not change what the agent may do. Delivery, branch rules and the publish gates are unchanged; only the directory is shared.

Root `AGENTS.md` is created if missing, **never overwritten**, read before execution, and injected as system instructions. It explains Ensemble, noninteractive work, the directory restriction, forbidden operations, cancellation, and completion. It is not presented as a substitute for OS isolation. In the assignment dialog that caveat is an **information icon**, not a standing warning banner: it is read once and understood, and repeating it on every assignment trained the eye to skip the one place warnings should be read.

Sandbox commands run in disposable, **read-only-root** containers with only the checkout writable, git read-only to model commands, no Docker socket, dropped capabilities and resource limits. Fixed dependency-install tools get network access with lifecycle scripts/source builds disabled. Git networking and GitHub publishing are separate controlled operations; **credentials are not passed to the model or its command environment**. Native execution cannot offer those same isolation guarantees.

**This sandbox is Ensemble's own.** It is a Docker container configured by this project — `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--pids-limit`, memory/CPU caps, one bind mount, no credentials. It shares **no code** with GitHub Copilot's sandboxing in VS Code or Copilot CLI, and does not delegate to it. Trust placed in it is trust in *this* project, not in GitHub's. Worth saying out loud, because "sandboxed" sounds like a borrowed guarantee and here it is a built one.

**Egress for model-issued commands is a setting, not a constant.** *Settings → Network for sandboxed commands* decides, and each job pins the answer at assignment time alongside its mode and model, so a run never changes what it may reach because a setting moved after it was queued. The default is **on**, for a reason worth stating: the sandbox was the only mode *without* egress, while native execution is host PowerShell and has always had the host's network — so an offline sandbox did not prevent a task from reaching the internet, it pushed that task onto the less contained mode. Reading a pull request or calling an API is ordinary work, and it should not cost the container.

What egress does **not** change: the container is still read-only, still drops every capability, still sees no host filesystem beyond the checkout, and still holds no credential. What it **does** change is that a prompt-injected agent could send the checkout and its context somewhere. Turn it off for a task whose inputs are untrusted.

Because no credential is passed, a sandboxed command reaches **public endpoints only** — a private repository still answers 404, and the context pipeline, not the network, is how private data is meant to arrive.

Files are ordinary Windows files. *Open checkout in VS Code* works with the engineer's own Copilot extension and sign-in. For the matching Linux toolchain, open the generated `runs\<job-id>` handoff folder and use *Dev Containers: Reopen in Container*. This needs the VS Code Dev Containers extension. **Do not edit a checkout while another task is using it.**

Build the default Node/Python toolchain with `pnpm workspace:image`. Windows-only tools require native mode; other language toolchains can use a deliberately prepared `ENSEMBLE_WORKSPACE_IMAGE`. A missing image, command, credential or dependency is a **visible blocker**, not a silent fallback to unsandboxed execution.

### A4. Execution and completion

The existing Copilot API is a **model API, not a computer-use sandbox**. Ensemble supplies its own typed tool loop using the existing runtime's `/api/chat/tools`; it does not launch an unrestricted CLI with `--allow-all`. Native shells use `-NoProfile -NonInteractive`; stdin, Git prompting, caches and process lifetime are controlled. Human interaction uses the typed `workspace_ask_user` tool, not terminal prompts. Its exact options and custom-answer flag appear in Needs Me.

Review-mode commands and dependency installs also request one-call permission there; unattended assignments retain their explicitly authorized execution mode. Reads through typed file/retrieval tools do **not** manufacture permission dialogs.

PR outcomes prepare a unique `ensemble/<task>-<job-id>` branch. Local, commit and push-only outcomes use the selected working branch. **No branch is reset.** The agent is told that checkout/branch preparation has already happened. Typed `workspace_git` and `workspace_compare` tools read state, branches, logs and bounded per-file diffs. Safe reads such as `git remote -v` are not writes; file tools accept paths inside the assigned checkout, whether relative or absolute.

Verification uses a **temporary Git index**, not the engineer's real staging area. File-change counts describe this task's delta from its initial HEAD; source-versus-base comparison is a separate record. Fresh Windows/shared checkouts pin local line-ending/file-mode interpretation so opening the same files with Windows Git does not manufacture changes.

**Done** means the selected outcome was verified, not that a PR was merged or remote CI passed. Publishing verifies a commit, then the exact remote branch SHA when pushing, and PR head/base only if a PR was requested. Changed reviewed files, failed checks, sensitive files or altered Git configuration **stop publishing**. Reports do not need code tests; actual code changes still do. Branch deletion, force-push, merging and unrelated outbound actions are not offered.

The task receives useful execution notes and links. If selected, its linked deliverable is completed only when no linked tasks remain unfinished. Agent-generated result notes are **not** treated as examples of the engineer's writing style. Checkouts are retained for review; deleting Hub data does **not** silently delete source trees on disk.

### A5. Durable queue and global stop

Postgres `workspace_jobs` is the durable queue. A transaction-level advisory lock coordinates competing schedulers. **At most three jobs execute**, with shared project/repository resources and equal or nested directories serialized. Unrelated jobs may pass a blocked head; conflicting jobs retain FIFO order. The existing Python workers participate in the same execution-capacity gate.

Queued, running and stopping jobs appear in the app bar and Workspace. Jobs waiting for review **do not consume an execution slot**; their checkout remains reserved. Stopped partial checkouts and manual handoffs are held until explicitly reassigned. Heartbeats/leases detect a crashed host; its processes are cleaned up and the attempt is marked **interrupted/blocked**, not silently replayed. If cleanup cannot be confirmed, the directory stays reserved.

The pause button prevents new work, aborts provider requests, and terminates workspace command trees/containers. Queued jobs remain saved until Resume. Individual stop removes a queued job or stops an active one. *Stop everything* also cancels queued work. Resume does **not** clear an older call's cancellation flag. A provider or GitHub may still finish an already-received request: stop does not undo remote writes or guarantee a provider billing refund.

All runtime model entry points share a separate **three-request Redis limit** and cancellation registry, covering assistant turns, planning, extraction and workspace calls. Waiting for a model slot makes no provider request.

Structured questions and tool-permission requests save a **workspace-decision checkpoint** on the existing run: model messages, the exact pending tool and arguments, remaining calls, tool receipts, turn index, active-time usage and a verified working-tree identity. The job parks without a worker/model slot. Answering **requeues the same job**; it does not create a new attempt, regenerate the command, clone again or replay completed writes. *Allow once* permits only the displayed call. *Deny* or a custom instruction skips that call and returns the engineer's answer to the model. Stale, duplicate and taken-over decisions fail explicitly. A modified working tree invalidates the saved permission.

This applies to tasks executed **inside Ensemble** using the Copilot model API. It does **not** intercept permissions or prompts from unrelated VS Code / Copilot CLI sessions. The API returns model tool calls, not the CLI's approval UI; the actual Ensemble execution controller supplies these permission gates.

### A6. UI and retained evidence

Workspace has repository *Upcoming*, *Working now*, and the five most recently completed tasks, plus a review/stopped section. *Research & other agent work* has corresponding columns, including completed legacy runs. A task does **not** need a checkout to appear here. Cards and task pages are shared with Board. Queues paginate; connector sync and switches remain in Settings. Conversational help remains on task pages and in the Hub assistant.

Task, deliverable and run pages expose the final response, PR/commit links, actual per-file additions/deletions, diff, commands and exit codes, context/skill snapshot, model signatures, tokens and estimated credits. Full redacted execution records can be exported. Large bodies load only in the details view. `workspace_events` retains provider response objects, native reasoning when actually returned, usage details and tool events. **No prompt requests thinking logs or a cosmetic rationale.** Missing reasoning/tokens stay unreported. Historical stated-rationale records remain clearly labelled as legacy, not converted into native traces. Credits remain estimates where the provider does not report billing.

The activity panel nests a current model request under the task that owns it. These are **not two agents or two charges**. Each model request may ask for several tools, whose inputs/results/errors are retained. The per-request estimate is charged once: six requests at 0.25 total 1.5, not 3. Raw `copilot_usage.total_nano_aiu`, when returned, is displayed separately as provider-reported nano-AIU, not confused with the request-rate estimate.

Research workers expose **read-only** tools. Their final Markdown is saved by Ensemble, not by an invented cloud-file *"save to Workspace"* step. Topical search queries and publication-year ranges are explicit. Failed tools and empty model answers remain failures with usage retained; a raw paper list cannot replace a missing final synthesis.

**Implementation:** `hub-api/src/workspace/{policy,executor,repository,context,service,worker}.ts`, `routes/workspace-execution.ts`, and `agent-runtime/ensemble_agent/model_control.py`. `pnpm --filter @ensemble/hub-api verify:workspace-execution` exercises real native and Docker processes and real local Git in a disposable `ensemble_workspace_test_*` database with fixture model/GitHub network endpoints; it makes **no real model calls or external PRs**. The wrapper deploys migrations only to that test database and drops it afterward. The database role needs create/drop permission. Database isolation prevents a running normal scheduler from claiming the test jobs; no application workers need to be stopped. **GitHub publishing is supported.** Do not add ADO as a publish target.

---

## B. Surface assist — designed, built, then deleted

The plan was cards inside Teams and Outlook that anticipated a reply: a compose sidecar, a reading-pane summary, meeting prep and recap cards. **It was built and then removed.**

Two reasons, and the second is the one that decided it:

- **It was in the wrong place.** Composing a Teams reply belongs in Teams. A card in the Hub that mirrors a chat you are already looking at somewhere else adds a window, not an answer.
- **The Hub assistant covers the same ground from any page**, and does it without a second surface to keep in sync. Ask it to draft the reply, make the todo or read the thread and it has the same context the card would have had ([docs/11](11_HOW_THE_ASSISTANT_WORKS.md)).

Nothing links to it and no route serves it. Do not rebuild the sidecar.

Meeting prep belongs to real connectors ([03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context--from-connectors-not-a-copilot-paste)), not a card inside another app.

---

## C. Card UX — kept, because the assistant inherited it

The assist cards are gone; the rules they were written for are not, and the Hub assistant follows them:

- **One headline**, at most three actions, and a *"Why?"* expander holding the evidence quotes and links.
- Actions phrased as **outcomes** (*"Send Rahul the date"*), never as tool names.
- Anything written in the engineer's voice carries its **skill chip**, so it is clear why it sounds like them.
- A dismissed suggestion is recorded as a **negative signal** for the proposer.

---

## D. Dev checklist

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

- [ ] Durable conflict-aware workspace queue and global stop controls
- [ ] Shared agent workboard, assignment form and execution records
- [ ] Per-task sandbox/native and unattended/review modes
- [ ] Verified GitHub publishing and task/deliverable completion
- [ ] Hand to agent / Take over round-trip
- [ ] VS Code extension stub: *Help me here*, status-bar, `@ensemble` chat participant (P1)
- [ ] Legacy editor context writer and root-scoped Workspace MCP compatibility

---

## E. As built

**`GET /api/tasks/:id/workspace` answers "no" with 200.** A task that has no workspace yet is the normal starting state. Returning 404 conflated *"this task does not exist"* with *"you have not opened a workspace"*, and made the Hub log a console error on every load. The route now 404s only for an unknown task and otherwise returns `{ session: null }`.

**Task help does not carry context into the wrong task.** Board and the assignment picker share a paginated task cache. The agent workboard has its own queue query, so filtering/pagination on the engineer's board cannot hide queued agent work. The former embedded-editor/help layout is gone.

*Review attached context* expands the source list on demand. Sources are real keyboard-operable toggle buttons with a selected count; excluded sources remain readable in both themes. The help session is **keyed by task**, clearing stale instructions, exclusions and answers and aborting the previous client request when the task changes. Stop/error states are labelled as *interrupted*, not *complete*.

Suggested follow-ups in task Help still **fill the instruction** rather than executing commands. Real execution is explicit assignment through section A.

### Task and deliverable pages

`PagePanel` is the shared resizable side peek for task and deliverable pages. Its left separator supports pointer dragging and keyboard resizing, and its toolbar offers full-width/restore controls. Task pages also open independently at `/tasks/<id>`, with a full-width preference. Changing width does not remount the editor or discard the draft. Unsaved changes are explicitly guarded.

Task pages edit the task's own notes and its project/people/repo/deliverable/skill links. *Save page* / Ctrl+S persists these and their retrievable note artifacts transactionally; Help and delegated work use the same context builder. This is **distinct from workspace handoff notes** and does not write files into a checkout.

Deliverable titles in Today and project pages open the same editable deliverable peek, rather than a non-interactive label.

| Area | Where | Notes |
|---|---|---|
| Execution API | `apps/hub-api/src/routes/workspace-execution.ts` | Persistent queue, assignment, records, exports and stop |
| Workspace core | `apps/hub-api/src/workspace/` | Context, conflicts, bounded tools, publishing verification and completion |
| Model control | `apps/agent-runtime/ensemble_agent/model_control.py` | Shared three-request limit, queued activity and cancellation |
| Legacy editor API | `apps/hub-api/src/routes/workspace.ts` | Compatibility context writer; outside-root paths and branch resets are refused. Coding handoffs use the new queue |
| Legacy Workspace MCP | `apps/agent-runtime/ensemble_agent/tools/workspace_mcp.py` | Compatibility tools, now also restricted to the configured root. An argv allowlist alone is **not** a sandbox |
| Surface assist | *removed* | Deleted. Composing a Teams reply belongs in Teams; the Hub assistant covers the same ground from any page |
| VS Code stub | `apps/vscode-ext/` | *Help me here*, status bar, `@ensemble` participant |
| Teams manifest | `apps/teams-app/manifest.json` | Message-extension entry for the compose sidecar (the surface itself is gone) |
