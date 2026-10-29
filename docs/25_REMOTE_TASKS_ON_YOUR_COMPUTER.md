# 25 · Remote tasks on your computer

Ensemble on the web can assign work to a person's paired computer, which runs it with the same local runtime as the desktop app and CLI. The host stores assignments, progress, decisions, results and bounded review metadata; the computer enforces its own execution rules. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) covers execution; [24](24_DESKTOP_SANDBOXING.md) covers confinement.

## 1. Execution and ownership

`WorkspaceJob.deviceId` targets a paired computer. The host worker and its recovery path skip those jobs. The computer claims the assignment, creates a local job (local `deviceId` null) and runs the normal queue, agent and engine path.

When `POST /api/devices/self/claim` claims queued work, `devices/routes.ts` moves the agent-owned task to In progress and publishes both `task` and `workspace` events on the task's space channel. The open board, task details and run queue refresh without a page reload or tab switch. Work waiting for an offline computer or a queue slot stays in To do.

The host's spec carries task context and execution choices (and `steer`, the change for a run that continues one a node interrupted: [30](30_ENGINES.md), Agent sessions), never shell argv or a raw path on the computer; folder labels resolve against folders the computer shares. Hosted email verification and account quotas apply. An offline computer leaves its job queued; work never falls back to the server or another device. `remote/client.ts`, `accept.ts`, `policy.ts`, `store.ts` and `devices/routes.ts` implement this boundary.

**Continue an earlier task.** Assign's "Continue an earlier task" on a computer lists, from `GET /api/agent/earlier-runs?deviceId=&taskId=` (`devices/earlier.ts`), the code runs that ran (or are queued to run) on that computer, under its current pairing or an earlier one of it (§8): each chain of continued runs once, by its newest step, the task's own first (and chosen by default). Assigning checks the earlier run was on that computer; the computer maps it to its own run by the web job id (`context.hostedJobId`, `remote/accept.ts`) and works in that run's folder, uncommitted work included, after it finishes (the chain's resource key). The same agent resumes its own session there ([30](30_ENGINES.md), Agent sessions). On a desktop with no computer chosen, `GET /api/workspace/checkouts` lists this server's own runs whose folder still exists.

## 2. Pairing and local state

The desktop app's This computer settings or `ensemble login` pairs through a browser approval code. Editor context access and permission to run tasks are separate. A web logout does not unpair a computer; CLI logout, unpair and revocation do.

The device token is an encrypted `model_credentials` row in the local database (`remote/store.ts`). `remote.json` holds switches, labels, folder mappings and the installation's id (§8); `api.json` lets the CLI and desktop app find the loopback API. Never commit either file or expose the token. The runtime connects outward to `ENSEMBLE_REMOTE_API`; `ENSEMBLE_SITE_URL` sets the UI origin, not the remote API. Desktop and CLI share one runtime lock and discovery path, not two databases. Pairing is not hosted/local workspace replication.

## 3. Lease, heartbeat and interruption

`devices/constants.ts` sets a **120-second lease** and a **90-second online window**; the computer heartbeats every 30 s (`remote/contract.ts`). Heartbeats and progress extend only a held lease, and the scheduler sweeps expiry, so the interruption shown can lag the expiry by up to a minute.

Claims and writes are fenced by device and lease token: another device or a stale token cannot complete the job. A missed lease marks the attempt Interrupted, settles open run and decision state and keeps partial work. Sleep, app exit and network loss are interruptions, not completion.

The server cannot tell a computer that was switched off from one that only lost its connection, so the computer settles each run it held when it is back (`reconcile` in `remote/loop.ts`, `devices/recover.ts`, protocol 5):

| On the computer | What happens |
| --- | --- |
| The run kept going, or finished while the computer was cut off | **Reattach** (`POST …/reattach`): the same run gets a new lease and goes on; its open questions are asked on the web again; a finished run then reports. Nothing runs twice. |
| The run was cut off because Ensemble quit (a restart, a power cut, a crash) | **Carry on** (`POST …/resume`): a new run continues it in the same folder and the agent's own session, told why it stopped (`resume` on the claim; tagged *resumed n/2* on the web). |

A run is reattached or carried on only when its lease ran out (or the computer restarted before it did), the person has not stopped it, run it again or paused the agent, and only for the computer that ran it (or the same computer paired again, §8). Carry-ons stop after `MAX_AUTO_RESUMES` (2) per task chain and are not made for a run interrupted more than 24 hours ago; the next interruption stays for Run again. Runs in a shared space and chat messages are never carried on by themselves. A run the web no longer wants stops on the computer.

After an outage of the server itself (no heartbeat from any computer for a lease period), leases that ran out meanwhile get one more lease period when it starts. The claim refuses past the person's concurrent-run limit, so a run that ends wakes their computers that have queued work, and each heartbeat also claims.

The event stream only wakes the computer; persisted job and lease state is authoritative. File and code relays use scoped Redis keys with short lifetimes; assistant turns on a subscription live in the API process's memory (`subscriptions/relay.ts`). Decision waits also poll the database, because a second API process does not share the in-memory bus.

## 4. Hosted interfaces

### 4.1 Account and device routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/devices/pair`, `/api/devices/register` | Issue / redeem a pairing code |
| GET | `/api/devices` | The person's computers and capabilities |
| PATCH / DELETE | `/api/devices/:id` | Rename / revoke an owned computer |
| POST, GET | `/api/devices/:id/code`, `/api/devices/:id/terminal`, `/api/devices/:id/terminal/output` | Browser Code and terminal relay (§4.7) |
| DELETE | `/api/devices/self` | Device-initiated removal |
| POST | `/api/devices/self/heartbeat`, `/api/devices/self/claim` | Refresh state and leases; claim eligible work |
| GET | `/api/devices/self/jobs/:id/attachments/:fileId` | Download an attached original (§4.5) |
| POST | `/api/devices/self/jobs/:id/progress`, `/ask`, `/files`, `/evidence`, `/complete` | Report, ask a saved question, send changed-file text (§4.6) and the files the worker attached (§4.11), settle with the worker's report. Progress may carry `observed` (what the agent says it runs with: `model`, `effort`, `context`, `contextTokens`, `fast`) when it changes, and complete `totals.observed` ([30 §3.4](30_ENGINES.md#34-what-the-agent-says-it-runs-with)) |
| POST | `/api/devices/self/jobs/:id/reattach`, `/resume` | After an outage: take back a run that kept going, or carry on one lost to a restart (§3) |
| GET / POST | `/api/devices/self/decisions/:id`, `/api/devices/self/decisions/:id/close` | Read an answer / close a decision answered locally, or withdraw it (`expired`) when the agent stopped waiting |
| POST | `/api/devices/self/file-requests/:id`, `/code-requests/:id`, `/terminal-runs/:runId/output`, `/tool-runs/:runId/output` | The computer's answers to relayed requests, and the longer output of a node's command (§4.10) |
| GET | `/api/devices/self/model-keys` | The account's model keys (§4.2) |
| GET / POST | `/api/devices/self/included`, `/api/devices/self/included/turn` | Included models (§4.9) |
| GET / POST | `/api/devices/self/assistant-turns/:id` and `/files/:fileId`, `/tool`, `/stream`, `/done` | Assistant turns on a subscription and the files on their message (§4.9) |
| GET | `/api/devices/self/events` | Wake-up stream |

`scope=device` is not an account token; device routes have their own allowlist and authentication. Pairing does not allow minting other tokens.

### 4.2 Stored model and job data

The host stores device identity and capabilities, the task and job spec, lease state, decisions, progress, logs, evidence, the settings the agent reported (`observed_settings`) and result, including the worker's own report (`workspace_jobs.report`, §4.11). Ensemble on the web stores no file contents from a computer, with one exception: the files a run's worker attaches for its owner (§4.11), unless that computer turned it off. The files a run changed are listed by name and line counts, and their text is read from the computer when opened (§4.6). A desktop app or local server does keep changed-file copies; relays are transient everywhere.

Local secrets stay local. The exception runs the other way: with *Settings → Models* `keysOnComputers` on (the default), `GET /api/devices/self/model-keys` gives the computer the account's model keys for its own model calls, except keys with a custom base URL; the ledger records once a day which providers' keys a computer read.

### 4.3 Local routes

`GET /api/remote`, `POST /api/remote/pair`, `/unpair`, `/folders`, and `DELETE /api/remote/folders/:label` manage the runtime locally. A hosted job cannot set Code folders, trust or web-control settings. [26](26_CLI.md) lists the CLI commands.

### 4.4 Web UI

Assign offers available computers with their shared labels and capabilities. The assistant can queue the same job from chat ("do this on my machine") with `hub_assign_to_agent` after the person presses Apply; it goes through `createJob` like the dialog, so the computer's checks are unchanged ([11 §8.3](11_HOW_THE_ASSISTANT_WORKS.md#83-running-work-code-and-settings)). Cards show last contact, queue/run/wait/interruption state, model and result. A run's review opens Code on the computer that ran it. Failure to load capabilities shows an error and grants nothing.

### 4.5 Attachments and task context

Claims carry bounded task, page, source and skill context; embedded owned diagrams come as source. `remote/accept.ts` downloads only the attached originals the current lease authorizes, at most **100 MB total**, then remaps hosted page references to the local copies.

### 4.6 A task's files on the web

`remote/files.ts` sends changed-file text before completion: at most **100 files**, **256 KB/file**, **3 MB/run**. The server rechecks paths and redaction and stores `JobFile` copies for at most **30 days**, except **Ensemble on the web, which keeps none** (`keepsRunFileText` in `lib/hosted-access.ts`): its claim carries `keepsFileText: false` so a computer sends no text, and `POST /api/devices/self/jobs/:id/files` drops any that an older computer still sends (answer `{ stored: 0 }`). There, `GET /api/agent/jobs/:id/file` always reads live. Metadata reports additions, deletions and line counts; renames can appear as delete + add. Unsafe cloned Git configuration is never run to inspect changes.

The changed files include those outside the run's folder: other folders the run was allowed to write, and repositories the folder's own snapshot does not cover (a nested repository, or any repository when the folder is not one). The first write in such a repository snapshots it, so only the run's changes are listed (`workspace/outside-changes.ts`); they are named `~/…`. When the run folder itself has no changes, the review covers the repository it changed most. Such a file is read only because the run's own evidence lists that exact path, under the same file rules and the outside floor ([24 §3](24_DESKTOP_SANDBOXING.md#3-work-folder-and-outside-access); `readChangedFile` in `workspace/folder-read.ts`).

Live `GET /api/agent/jobs/:id/tree` and `/file` ask the computer for its current authorized folder through `devices/file-relay.ts` and time out rather than act as remote shell access. Text views are bounded and redacted; secrets, Git internals, links leading outside, hard links and unsafe path races are refused by `workspace/folder-read.ts` on both ends.

Only the person whose computer ran the job reads its file text; other shared-space members see metadata. The computer must still offer the task folder. `browseFiles` (*Show task files on the web*, `ensemble browse on|off`) is checked again locally; turning it off hides stored copies and refuses live reads.

### 4.7 The Code tab and terminal on the web

`POST /api/devices/:id/code` accepts only the calls listed in `remote/contract.ts`; `remote/code.ts` runs them through the local API. It is a browser-session route for the computer's owner, never for the assistant, a bridge key or an API token. Relays hold transient request, answer and output state, never a second checkout.

The local switches `browseFiles`, `webEdit` and `webTerminal` are on by default and checked on every call. Secret paths are refused, and redacted views cannot be written back. Binary and oversized files follow the view and refusal limits in [16](16_CODE_TAB.md). Code's allowed folders are set on the computer.

The web terminal needs a **passkey unlock** with user verification for the web's origin, ending after **30 minutes idle** or **8 hours** (`devices/web-unlock.ts`). *Lock now* ends the session and stops its commands. Commands follow `workspace/terminal-exec.ts`: allowed programs, arguments and folders, hardened Git, confirmation for destructive actions, OS confinement, time and output limits. It is not a raw shell or an assistant tool. See [16](16_CODE_TAB.md#5-the-terminal--for-you-only).

### 4.8 Protocol and compatibility

`remote/contract.ts` and the computer's receiver define the supported operations; each job records its protocol (changed-file text needs protocol 3, Code and terminal relays protocol 4, secret scopes, the worker's report, evidence and node tools protocol 6). An optional field an older server does not know is left out by it, so it needs no new protocol: `observed` on progress and complete is one (2 November 2026), and a claim's `mission` another (§4.12). Until a computer runs a release that sends it, its runs show their observed settings as "not reported", except the agent's model from its `engine` event. The server and UI check advertised capabilities and name the update an outdated computer needs: the coding agents a runtime can run are in `capabilities.engines` (`deviceEngines` in `devices/labels.ts`; a runtime without the list has Claude Code, Codex and Cursor's agent), so GitHub Copilot is refused for an older one. Existing jobs keep their own protocol and evidence.

### 4.9 Subscriptions and included models

Agent sessions: a computer with `capabilities.sessions` 1 runs a job that continues another in the agent's own session (Claude `--resume`, Codex thread resume, ACP `session/load`) and takes the claim's `steer`. Ensemble Node continues sessions only on such a computer, or one reporting 0.4.18 or later ([35 §8.2](35_ENSEMBLE_NODE.md#82-which-session)).

Secrets for runs: a computer with `capabilities.secrets` 1 or more (`SECRETS_API`) takes a `secret.save` frame `{id, name, value}` on its event stream, keeps the value encrypted in its own `run_secrets`, and answers on `/api/devices/self/code-requests/:id` with only whether it saved it. A code run there gets the saved secrets as environment variables and their names in its brief; whatever the computer sends back has the values hidden (`hideSecretsDeep`). Ensemble Node's secure box sends them ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)); `ensemble secrets` manages them on the computer.

**Which secrets a run gets.** A claim may carry `secrets` (protocol 6): the names the run may have, possibly none. The computer keeps the list on the local job (`context.secrets`) and gives the run only those (`secretScopeOf` and `runSecretEnv` in `lib/run-secrets.ts`). Without the list, a run gets every saved secret, as before: runs from the Hub and the CLI. Ensemble Node's runs always carry it ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)). A computer that reports `capabilities.secretScope` 1 applies it; an older one ignores it and has neither evidence upload nor node tools.

The assistant can run turns on AI subscriptions signed in on a paired computer through `subscriptions/` and the assistant-turn routes; this needs CLI 0.3.10+ or desktop app 0.3.7+ there (`capabilities.assistantTurns` 1 or more, `ASSISTANT_TURNS_MIN`). Offline sign-ins are not offered. This is separate from engine assignment and personal API keys ([30](30_ENGINES.md)).

A computer that reports `assistantTurns: 2` (`ASSISTANT_TURN_FILES`) takes the files attached to the message: the turn's spec lists them (`files`), and the computer downloads each with `GET /api/devices/self/assistant-turns/:id/files/:fileId` (`assistantFile` in `remote/client.ts`, at most the listed size plus 64 KB, stopped with the turn). The route answers only the device the turn went to, only for a file on that turn's list (404 otherwise, or when the file is gone), and 410 once the turn ended; it sends the bytes with the file's media type, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A computer that reports 1 gets no file list; a note after the message names the files and says Ensemble on that computer must be updated to receive them. How each agent is given the files: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

A computer that reports `assistantTurns: 3` (`ASSISTANT_TURN_SESSIONS`) keeps one agent session per chat: the spec carries `session: { key, history }` (the conversation id and the chat so far), and the computer resumes that chat's session or starts one with the history ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). An older computer gets the history in front of the message instead.

A paired desktop app or CLI calls included models through `/api/devices/self/included` and `/api/devices/self/included/turn`. The device token identifies the account; Azure credentials stay on the host, and usage counts against that account's credits and the global ceiling ([33](33_INCLUDED_AI.md)).

### 4.10 A node's own tools on the computer

A node can run a command, read git, call a development server on the computer and change a file without starting an agent session ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)). Each call goes to the computer as a `node.tool.request` frame on its event stream, like `code.request` (`askDeviceFor` in `devices/file-relay.ts`). The computer judges it and answers once on `/api/devices/self/code-requests/:id` (`device-tools/answer.ts`). Only a computer that reports `capabilities.nodeTools` 1 (`NODE_TOOLS_API`) gets these frames; for an older one the node is told "Update Ensemble on <computer>".

| Tool (`NodeToolRequest`) | What the computer does |
| --- | --- |
| `run {folder, command, cwd?, timeoutSec ≤ 900, background?, secrets?}` | Checks the command like an agent's (`workspace/guard.ts`: allowed programs, arguments, folders; git against the run profile's git ceiling; no `git push` or `fetch`) and runs it under the OS sandbox with the folder writable and the profile's network choice. Named saved secrets go into that command's environment only |
| `git {folder, op, args?}` | `status`, `diff`, `log`, `show` or `branch` (list only), read-only and sandboxed; options that write, run programs or leave the folder are refused (`device-tools/git.ts`) |
| `http {url, method?, body?}` | `http` or `https` only, no user name or password, and every address the name resolves to must be loopback; the connection uses the checked address, and each of at most 5 redirects is checked again. Ensemble's own local port is refused (`device-tools/http.ts`) |
| `files {action: write\|move\|delete, folder, path, to?, content?}` | Inside the folder only: no link, no hard link, no key, credential or `.env` file, no `.git`; a write is at most 1 MB, a move never overwrites, delete removes files only (`device-tools/files.ts`) |

**Folders.** A folder is one this computer shares (by its label) or a full path Ensemble may hand to an agent (`resolveWorkFolder`). A link, the home folder itself, a system folder, Ensemble's data folder and folders that hold keys, sign-ins, Ensemble's git helper or its code are refused (`device-tools/folders.ts`). The sandbox also denies the secret folders and files in the home folder (`SECRET_PATHS` in `workspace/guard.ts`, which includes `SECRET_HOME_PATHS`), Ensemble's data folder (with the run secrets, the key that encrypts them and the browser profile folder) and its git helper, inside any folder (`nodeToolDenies`).

**Who decides** (`device-tools/policy.ts`, on the computer). In order:

1. The hard floor above: 403, and no answer opens it.
2. The owner's answers for this computer: rules in `decision_rules` with `source` `node-tools`, one per folder or web address (`toolName` `folder` or `origin`), for the mission (`sessionId`) or always.
3. Unattended (the node's run profile runs unattended, and the node does not ask first): allowed inside the sandbox.
4. Attended: 428 with `body.ask` (`NodeToolAsk`). The server opens one Needs me card with *Once*, *This mission* and *Always for this folder* (or *for this address*). The answer goes back with the node's next call (`grants`), and the computer keeps *This mission* and *Always* as its own rules.

The answers count only while the computer accepts approvals from the web (`acceptWebApprovals`); with it off, a call without a rule here is refused (409). Where the sandbox is weak (no OS sandbox, or `capabilities.sandbox` `advisory` or `ask`), the floor is best effort: *Always* does not cover commands, which ask once per mission instead.

**Answers.** 200 with the result; 202 for a command still going; 403 for the hard floor; 404 for a missing path; 409 when switched off or not possible here. What a command prints is redacted for saved secret values and key shapes. An answer carries at most 64 KB (`NODE_TOOL_INLINE_BYTES`, the start and the end). Longer output goes in order, in chunks at line ends, to `/api/devices/self/tool-runs/:runId/output`, at most 1 MB per command. The server keeps it in Redis for 6 hours under the run's id, never in the database (`devices/tool-runs.ts`). A command still going after 60 seconds (`NODE_TOOL_FOREGROUND_MS`), or started with `background`, runs on. Its last chunk says how it ended, and the server wakes the node once (`enqueueTurn`, reason `tool`). Stopping remote work stops these commands too.

**Ledger.** Each call writes one entry on the computer (`node.tool.run`, `node.tool.git`, `node.tool.http`, `node.tool.files.*`, and `node.tool.ask`) and one on the server (`node.device_tool.<tool>`). They keep the program or operation and the folder or origin, never the output.

### 4.11 The worker's report and evidence

**Report.** A run's worker reports its own result with `report_result`, or `.ensemble/result.json` when its agent has no MCP ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)). The computer validates it as a `StepReport` (`node/report.ts`) and keeps it on its local job. `complete` sends it as `report` (protocol 6). The server checks the shape again, redacts it and keeps it on the job (`workspace_jobs.report`); an invalid report is dropped with a warning.

**Evidence.** Each file the worker attaches is uploaded before `complete`, while the run holds its lease (`evidence/upload.ts`, also during the run):

- `POST /api/devices/self/jobs/:id/evidence`, authenticated like progress: the device token and the job's lease in `x-ensemble-job-lease`. The body is the file's bytes (`application/octet-stream`). `x-ensemble-evidence` carries `EvidenceMeta` as base64url JSON: `{id, kind, name, size, sha256, mime?, caption?, requirementId?, local}`.
- The computer reads the file again from the run's evidence folder, under the same checks as when it was attached, and sends it only if it is unchanged. Text is redacted before it goes.
- The server checks it again: the size for its kind, the digest, credential names, and the type sniffed from the bytes (it never trusts the name or the computer). Text is redacted again. Then it stores the bytes where Files keeps uploads ([32 §7](32_FILES.md#evidence-from-agent-runs)), lists the file on the run's card in Ensemble Node and writes `evidence.upload` to the ledger. The same `id` again answers with the stored file.
- Answers: 201 (stored), 200 (already stored), 400 (bad description, size or digest), 413 (too large for its kind), 415 (type does not match the kind), 422 (credential file), 409 (lease, another run's id, or 100 files already), 404 (no such job).

| Kind | Largest file |
| --- | --- |
| `screenshot`, `image`, `report`, `log`, `file` | 20 MB |
| `video`, `trace` | 100 MB |

**Off on this computer.** `ensemble evidence off` (`evidenceUpload` in `remote.json`, reported as `capabilities.evidenceUpload`) keeps the files here. Only their description goes up, with `local: true` and no bytes. The card shows them as "on this computer, not uploaded", and reading one answers 409. A server without the route (404) gets nothing more for that run.

### 4.12 Worktrees for parallel work

An Ensemble Node mission may build in parallel in one repository ([35 §8.14](35_ENSEMBLE_NODE.md#814-parallel-work-in-one-repository)). Its runs' claims carry `mission` (optional; older servers leave it out):

| Field | Meaning |
| --- | --- |
| `id`, `step` | The mission and its step. Kept on the local job (`context.mission`) with the shared folder's path, which never leaves the computer. |
| `worktree` | `{name, branch?, detached?, reuse?}`: work in the git worktree `<workspace>/worktrees/<name>` of the shared folder, on `branch` (made from the folder's last commit, or taken as it is when it exists), or detached for a snapshot. `reuse`: a check of a build, in that build's worktree. |
| `port` | The development-server port the step holds; its packet names it. |
| `integrates` | An integration step's worktrees, removed after its run succeeds. |

- **Making one** (`prepareWorktree` in `workspace/worktrees.ts`, from `remote/accept.ts`). With Ensemble's own git (hooks off), like a run's separate copy ([24 §3](24_DESKTOP_SANDBOXING.md)). Only of a shared folder that is a git repository's own top folder, with a commit and a config that starts nothing. A folder shared as a repository gets a worktree instead of a fresh clone. The local job then works in place in the worktree, on its branch as it is (the web's branch, pull request and Git choice for this run do not move it), and may write the repository's own git folder, which every worktree shares, so its commits land. A check reuses the build's worktree as it is; a snapshot that is gone cannot be checked again. A continued run (a repair, a retest) stays in its run's folder.
- **When it cannot be made** (not a repository, no commit, a folder in the way), the run works in the folder itself. The ledger's `remote.claim` entry says why, and this computer's queue makes runs in one folder take turns.
- **Removing.** After an integration run succeeds, each worktree it brought in goes, only when clean and when nothing would be lost: a branch keeps its commits; a detached one must already be in the folder's history. Never forced. The rest stay for the person (`git worktree list` shows them).
- **Capability.** A computer that does this reports `capabilities.worktrees` 1. The web gives a parallel build on an older computer the folder itself, one step at a time, and its packet says to update Ensemble there. The new field and capability need no new protocol: an older computer ignores `mission`.
- **Folder claims.** Runs of one mission that meet in a folder outside their own take turns there without asking (`context.mission.id`; [24 §3](24_DESKTOP_SANDBOXING.md)).

## 5. Local execution and permissions

`planLocalJob` validates the hosted spec against shared folders, local settings, available engines and models, and code, sandbox and Git rules. Local conflict locks and budgets apply. A "trusted" flag from the server is not local trust.

### 5.1 Phone approvals

`acceptWebApprovals` (*Accept approvals from the web and phone*, `ensemble approvals`) is **on by default**. When on, the web's run settings apply and supported risky decisions can be confirmed remotely. When off, risky answers stay on the computer and web settings can only narrow local permissions. The computer checks its own pending decision and action hash; the first valid answer wins, and a timeout never allows.

A task from the web is limited in git only by the person's own choices: its Git choice (No limits by default), its branch (current, a new one by name, or an existing one), *Use my git sign-in* for private and SSH repositories (applied when the computer accepts web settings), and a pull request into any branch ([24 §5](24_DESKTOP_SANDBOXING.md#5-git-and-credentials)). Pushes and `gh` use the computer's own sign-in; Ensemble puts no branch, push or merge rule of its own on it. Merging a pull request Ensemble opened waits for the person's Allow on Needs me unless the task said to merge when checks pass ([24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)).

A web confirmation is an authenticated session action, not a device-verified WebAuthn signature over each decision; the terminal passkey protects only the terminal.

### 5.2 Rate limits

Pairing, heartbeat and progress, file browsing, code, subscriptions and model calls have their own buckets in `lib/rate-limit.ts` and the relays. Account quotas and device/lease checks still apply.

## 6. Shared spaces

A run can belong to a shared space while running on a member's own computer. Members see permitted progress and results; execution decisions and file text belong to the person running it. Revocation, sharing access and the computer's switches are each checked ([29](29_SHARING.md#4-agent-runs-in-a-shared-space)).

## 7. What synchronizes

Assignments, bounded context and attachments, progress, decisions, results, usage and review metadata cross the protocol, plus model keys as described in §4.2. So do the worker's report and the files it attaches, unless the computer keeps them (§4.11), and the bounded answers of a node's tool calls (§4.10). The local database, arbitrary folder contents, the local ledger and other credentials do not.

## 8. Device lifetime and removal

Rename is owner-only and heartbeats keep the saved name. Revoke or unpair stops remote-originated work and turns and forgets the device token; local work follows its own lifecycle. An unreachable network is different from a 401/revocation.

A computer paired again is the same computer to the web when it is the same installation (`capabilities.installId`, kept in `remote.json` through unpairing); for pairings made before that, the newest computer with the same name and platform, or the only one on that platform (`devices/successor.ts`). Its earlier runs then show on it, open in Code and the file view, and run again there.

Packaged launchers set `ENSEMBLE_INSTALL_PATH`; on each heartbeat the runtime checks it, and once the executable has been missing on every check for 10 minutes it stops remote work, tries to revoke itself and drops the pairing even when the host is unreachable (`remote/installed.ts`, `remote/loop.ts`). The wait is for package upgrades, which remove the launcher for a moment (Homebrew relinks `bin/ensemble`, Scoop swaps `current`); before it, an upgrade with the runner running unpaired the computer. The web's online dot can stay until the heartbeat window passes.

## 9. Tests and limits

API, device and remote tests cover lease fencing, ownership, local-policy narrowing, decisions, attachments, file and code relays and revocation. Sleep/wake, physical passkeys, provider subscriptions and installed releases need their own environment.

Evidence and node tools: `src/evidence/files.test.ts` (a link to a key, a hard link, `.env`, a file swapped after the check, a file outside the evidence folder, a saved secret value, sizes and kinds), `src/evidence/evidence.integration.test.ts` (the upload route's lease, sizes, sniffed types, active formats, redaction, the run card, owner-only reads, a computer that keeps its files, the blob store and its sweep), `src/evidence/report.integration.test.ts` (the MCP tools into `job.report` and the evidence folder; the `.ensemble/result.json` fallback), `src/device-tools/device-tools.test.ts` (the policy, the hard floor, loopback-only HTTP with redirects, read-only git, file changes, long output and background commands, and the OS sandbox denying keys, Ensemble's data and the browser profile) and `src/node/device-tools.integration.test.ts` (the relay round trip with a fake computer, one Needs me card per folder, an older computer, owner-only tools, a long command waking its node once, and a node run getting only the secrets it names). macOS and Windows sandboxes are not exercised there.

Worktrees for parallel work: `src/workspace/worktrees.test.ts` (a build's worktree on its branch, its check in the same one, a snapshot, what is refused, and removing only what loses nothing, in a real repository) and `src/node/parallel.integration.test.ts` (the claim's `mission`, and two builds claimed at once).

There is no automatic move to another computer, full database sync, mid-command replay or inbound remote shell or tunnel. A compromised browser session can use whatever the computer's switches allow; local switches and OS rules are the boundary. Redaction is bounded and does not prove content has no sensitive data.
