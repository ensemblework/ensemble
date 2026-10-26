# 25 · Remote tasks on your computer

Ensemble on the web can assign work to a person's paired computer, which runs it with the same local runtime as the desktop app and CLI. The host stores assignments, progress, decisions, results and bounded review metadata; the computer enforces its own execution rules. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) covers execution; [24](24_DESKTOP_SANDBOXING.md) covers confinement.

## 1. Execution and ownership

`WorkspaceJob.deviceId` targets a paired computer. The host worker and its recovery path skip those jobs. The computer claims the assignment, creates a local job (local `deviceId` null) and runs the normal queue, agent and engine path.

The host's spec carries task context and execution choices, never shell argv or a raw path on the computer; folder labels resolve against folders the computer shares. Hosted email verification and account quotas apply. An offline computer leaves its job queued; work never falls back to the server or another device. `remote/client.ts`, `accept.ts`, `policy.ts`, `store.ts` and `devices/routes.ts` implement this boundary.

**Continue an earlier task.** Assign's "Continue an earlier task" on a computer lists, from `GET /api/agent/earlier-runs?deviceId=&taskId=` (`devices/earlier.ts`), the code runs that ran (or are queued to run) on that computer, under its current pairing or an earlier one of it (§8): each chain of continued runs once, by its newest step, the task's own first (and chosen by default). Assigning checks the earlier run was on that computer; the computer maps it to its own run by the web job id (`context.hostedJobId`, `remote/accept.ts`) and works in that run's folder, uncommitted work included, after it finishes (the chain's resource key). On a desktop with no computer chosen, `GET /api/workspace/checkouts` lists this server's own runs whose folder still exists.

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
| POST | `/api/devices/self/jobs/:id/progress`, `/ask`, `/files`, `/complete` | Report, ask a saved question, send changed-file text (§4.6), settle |
| POST | `/api/devices/self/jobs/:id/reattach`, `/resume` | After an outage: take back a run that kept going, or carry on one lost to a restart (§3) |
| GET / POST | `/api/devices/self/decisions/:id`, `/api/devices/self/decisions/:id/close` | Read an answer / close a decision answered locally, or withdraw it (`expired`) when the agent stopped waiting |
| POST | `/api/devices/self/file-requests/:id`, `/code-requests/:id`, `/terminal-runs/:runId/output` | The computer's answers to relayed requests |
| GET | `/api/devices/self/model-keys` | The account's model keys (§4.2) |
| GET / POST | `/api/devices/self/included`, `/api/devices/self/included/turn` | Included models (§4.9) |
| GET / POST | `/api/devices/self/assistant-turns/:id` and `/files/:fileId`, `/tool`, `/stream`, `/done` | Assistant turns on a subscription and the files on their message (§4.9) |
| GET | `/api/devices/self/events` | Wake-up stream |

`scope=device` is not an account token; device routes have their own allowlist and authentication. Pairing does not allow minting other tokens.

### 4.2 Stored model and job data

The host stores device identity and capabilities, the task and job spec, lease state, decisions, progress, logs, evidence and result. Ensemble on the web stores no file contents from a computer: the files a run changed are listed by name and line counts, and their text is read from the computer when opened (§4.6). A desktop app or local server does keep changed-file copies; relays are transient everywhere.

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

`remote/contract.ts` and the computer's receiver define the supported operations; each job records its protocol (changed-file text needs protocol 3, Code and terminal relays protocol 4). The server and UI check advertised capabilities and name the update an outdated computer needs: the coding agents a runtime can run are in `capabilities.engines` (`deviceEngines` in `devices/labels.ts`; a runtime without the list has Claude Code, Codex and Cursor's agent), so GitHub Copilot is refused for an older one. Existing jobs keep their own protocol and evidence.

### 4.9 Subscriptions and included models

The assistant can run turns on AI subscriptions signed in on a paired computer through `subscriptions/` and the assistant-turn routes; this needs CLI 0.3.10+ or desktop app 0.3.7+ there (`capabilities.assistantTurns` 1 or more, `ASSISTANT_TURNS_MIN`). Offline sign-ins are not offered. This is separate from engine assignment and personal API keys ([30](30_ENGINES.md)).

A computer that reports `assistantTurns: 2` (`ASSISTANT_TURN_FILES`) takes the files attached to the message: the turn's spec lists them (`files`), and the computer downloads each with `GET /api/devices/self/assistant-turns/:id/files/:fileId` (`assistantFile` in `remote/client.ts`, at most the listed size plus 64 KB, stopped with the turn). The route answers only the device the turn went to, only for a file on that turn's list (404 otherwise, or when the file is gone), and 410 once the turn ended; it sends the bytes with the file's media type, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A computer that reports 1 gets no file list; Ensemble's text of the files follows the message instead. How each agent is given the files: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

A paired desktop app or CLI calls included models through `/api/devices/self/included` and `/api/devices/self/included/turn`. The device token identifies the account; Azure credentials stay on the host, and usage counts against that account's credits and the global ceiling ([33](33_INCLUDED_AI.md)).

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

Assignments, bounded context and attachments, progress, decisions, results, usage and review metadata cross the protocol, plus model keys as described in §4.2. The local database, arbitrary folder contents, the local ledger and other credentials do not.

## 8. Device lifetime and removal

Rename is owner-only and heartbeats keep the saved name. Revoke or unpair stops remote-originated work and turns and forgets the device token; local work follows its own lifecycle. An unreachable network is different from a 401/revocation.

A computer paired again is the same computer to the web when it is the same installation (`capabilities.installId`, kept in `remote.json` through unpairing); for pairings made before that, the newest computer with the same name and platform, or the only one on that platform (`devices/successor.ts`). Its earlier runs then show on it, open in Code and the file view, and run again there.

Packaged launchers set `ENSEMBLE_INSTALL_PATH`; on each heartbeat the runtime checks it, and once the executable has been missing on every check for 10 minutes it stops remote work, tries to revoke itself and drops the pairing even when the host is unreachable (`remote/installed.ts`, `remote/loop.ts`). The wait is for package upgrades, which remove the launcher for a moment (Homebrew relinks `bin/ensemble`, Scoop swaps `current`); before it, an upgrade with the runner running unpaired the computer. The web's online dot can stay until the heartbeat window passes.

## 9. Tests and limits

API, device and remote tests cover lease fencing, ownership, local-policy narrowing, decisions, attachments, file and code relays and revocation. Sleep/wake, physical passkeys, provider subscriptions and installed releases need their own environment.

There is no automatic move to another computer, full database sync, mid-command replay or inbound remote shell or tunnel. A compromised browser session can use whatever the computer's switches allow; local switches and OS rules are the boundary. Redaction is bounded and does not prove content has no sensitive data.
