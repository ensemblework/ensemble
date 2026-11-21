# 25 · Remote tasks on your computer

Pair a computer to run work there from Ensemble on the web. In Assign, choose that computer and the folder it offers. It uses the same local runtime as the desktop app and CLI, and enforces its own execution rules.

The web keeps assignments, progress, decisions, results and bounded review metadata. Read [Workspace and assigned agents](06_MODULE_WORKSPACE_AND_SURFACES.md) for execution and [Sandboxing](24_DESKTOP_SANDBOXING.md) for access limits.

## 2. Pairing and local state

Sign the [desktop app](DESKTOP.md) into your account, or run `ensemble login`. Open the browser approval page at `/link`, check the code and approve the computer.

Both use the same runtime and data folder, so a computer is one device whichever paired it: the second one keeps the existing pairing when it is with the same server. A desktop app kept local only never pairs, and `ensemble login` there refuses to (`--mcp-only` still works).

Editor context access and permission to run tasks are separate. A web logout does not unpair a computer; CLI logout, unpair and revocation do.

The device token is an encrypted `model_credentials` row in the local database (`remote/store.ts`).

Each pairing also makes the computer's sealing key pair, which the web encrypts secrets for: the private key in `seal-key.json` (0600, encrypted with the runtime's local key), the public key reported as `capabilities.sealKey` and pinned on the device row (§4.9, [35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)). Unpairing deletes it.

`remote.json` holds switches, labels, folder mappings and the installation's id (§8); `api.json` lets the CLI and desktop app find the loopback API. Never commit either file or expose the token. The runtime connects outward to `ENSEMBLE_REMOTE_API`; `ENSEMBLE_SITE_URL` sets the UI origin, not the remote API. Desktop and CLI share one runtime lock and discovery path, not two databases ([26 §4](26_CLI.md#use-the-cli-alongside-the-desktop-app)).

**One runtime per pairing on the web's side.** Each runtime process names itself with a random id on its event stream and its calls (the `x-ensemble-instance` header, `INSTANCE_HEADER` in `remote/contract.ts`), so the web tells two runtimes of one computer apart. It keeps only the newer one's stream: when a runtime opens its stream, the streams other runtimes of that device opened before end with the frame `device.replaced` (`publishRuntimeStream` in `devices/revoke-notify.ts`, on the Redis bus that carries revocations, so every API process closes its own), and the owner's AI activity log gets a `server.log` warning. A runtime replaced this way stops its remote loop and connects again after 30 seconds (`timing().replacedMs` in `remote/contract.ts`, `remote/loop.ts`); by then one that does not hold the computer's runtime lock has stopped by itself. A stream that sends no id (an older runtime) is never closed this way.

An assistant turn goes to the first runtime that reads it (§4.9). A request that changes something on the computer (`session.delete`, `assistant.session.delete`, `project.delete`, a Code write through `code.request`) goes to the first runtime that claims it: `POST /api/devices/self/code-requests/:id/claim` (`claimRequest` in `devices/file-relay.ts`) answers that runtime 200 (and again later), any other 409 "This request was picked up by another Ensemble on this computer." (it then leaves the request: `claimedHere` in `remote/client.ts`), and 410 when nobody waits; an answer posted by another runtime than the one that claimed it is refused with 409. A server without the route answers 404, and the runtime then acts on the request without a claim.

Pairing does not copy local data to the account; a local-only app's one-time move does ([DESKTOP](DESKTOP.md) §1.3).

## 1. Execution and ownership

`WorkspaceJob.deviceId` targets a paired computer. The host worker and its recovery path skip those jobs. The computer claims the assignment, creates a local job (local `deviceId` null) and runs the normal queue, agent and engine path.

When `POST /api/devices/self/claim` claims queued work, `devices/routes.ts` moves the agent-owned task to In progress and publishes both `task` and `workspace` events on the task's space channel. The open board, task details and run queue refresh without a page reload or tab switch. Work waiting for an offline computer or a queue slot stays in To do.

The host's spec carries task context and execution choices (and `steer`, the change for a run that continues one a node interrupted: [41 §1](41_AGENT_SESSIONS.md#1-coding-sessions)), never shell argv. A folder is a label the computer shares, resolved there; the one exception is a turn of the Code tab's agent, which names the folder Code has open by its path (`codeFolder`), and the computer runs it only in a repository its own Code API may open (§4.7). Hosted email verification and account quotas apply.

An offline computer leaves its job queued; work never falls back to the server or another device. `remote/client.ts`, `accept.ts`, `policy.ts`, `store.ts` and `devices/routes.ts` implement this boundary.

**Continue an earlier task.** Assign's "Continue an earlier task" on a computer lists, from `GET /api/agent/earlier-runs?deviceId=&taskId=` (`devices/earlier.ts`), the code runs that ran (or are queued to run) on that computer, under its current pairing or an earlier one of it (§8): each chain of continued runs once, by its newest step, the task's own first (and chosen by default).

Assigning checks the earlier run was on that computer; the computer maps it to its own run by the web job id (`context.hostedJobId`, `remote/accept.ts`) and works in that run's folder, uncommitted work included, after it finishes (the chain's resource key). The same agent resumes its own session there ([41 §1](41_AGENT_SESSIONS.md#1-coding-sessions)).

On a desktop with no computer chosen, `GET /api/workspace/checkouts` lists this server's own runs whose folder still exists.

## 4. Hosted interfaces

### 4.2 Stored model and job data

The host stores device identity and capabilities, the task and job spec, lease state, decisions, progress, logs, evidence, the settings the agent reported (`observed_settings`) and result, including the worker's own report (`workspace_jobs.report`, §4.11).

Ensemble on the web stores no file contents from a computer, with one exception: the files a run's worker attaches for its owner (§4.11), unless that computer turned it off. The files a run changed are listed by name and line counts, and their text is read from the computer when opened (§4.6). A desktop app or local server does keep changed-file copies; relays are transient everywhere.

Local secrets stay local. The exception runs the other way: with *Settings → Models* `keysOnComputers` on (the default), `GET /api/devices/self/model-keys` gives the computer the account's model keys for its own model calls, except keys with a custom base URL; the ledger records once a day which providers' keys a computer read.

### 4.4 Web UI

Open **Assign** and choose an available computer. The picker shows its shared folder labels and capabilities.

The assistant can queue the same job from chat ("do this on my machine") with `hub_assign_to_agent` after the person presses Apply; it goes through `createJob` like the dialog, so the computer's checks are unchanged ([11 §8.3](11_HOW_THE_ASSISTANT_WORKS.md#83-running-work-code-and-settings)).

Cards show last contact, queue/run/wait/interruption state, model and result. A run's review opens Code on the computer that ran it. Failure to load capabilities shows an error and grants nothing.

### 4.5 Attachments and task context

Claims carry bounded task, page, source and skill context; embedded owned diagrams come as source.

The description also has a **Context from Ensemble** section (`workContext` in `context/graph/packet.ts`, at most 5,000 characters, inside the description's 20,000): the meeting the task came from with the words asked, the project, people and their roles, dependencies, related open work and how similar work went.

While the job holds its lease, the run's `ensemble_context` and `ensemble_search` ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)) ask the web for more with `POST /api/devices/self/jobs/:id/context` (`{name, args}` → `{text}`; the device token and `x-ensemble-job-lease`), answered for the job's space only; a wrong or expired lease is a 409.

`remote/accept.ts` downloads only the attached originals the current lease authorizes, at most **100 MB total**, then remaps hosted page references to the local copies.

### 4.6 A task's files on the web

`remote/files.ts` sends changed-file text before completion: at most **100 files**, **256 KB/file**, **3 MB/run**.

The server rechecks paths and redaction and stores `JobFile` copies for at most **30 days**, except **Ensemble on the web, which keeps none** (`keepsRunFileText` in `lib/hosted-access.ts`): its claim carries `keepsFileText: false` so a computer sends no text, and `POST /api/devices/self/jobs/:id/files` drops any that an older computer still sends (answer `{ stored: 0 }`).

There, `GET /api/agent/jobs/:id/file` always reads live. Metadata reports additions, deletions and line counts; renames can appear as delete + add. Unsafe cloned Git configuration is never run to inspect changes.

The changed files include those outside the run's folder: other folders the run was allowed to write, and repositories the folder's own snapshot does not cover (a nested repository, or any repository when the folder is not one). The first write in such a repository snapshots it, so only the run's changes are listed (`workspace/outside-changes.ts`); they are named `~/…`.

When the run folder itself has no changes, the review covers the repository it changed most. Such a file is read only because the run's own evidence lists that exact path, under the same file rules and the outside floor ([24 §3](24_DESKTOP_SANDBOXING.md#3-work-folder-and-outside-access); `readChangedFile` in `workspace/folder-read.ts`).

Live `GET /api/agent/jobs/:id/tree` and `/file` ask the computer for its current authorized folder through `devices/file-relay.ts` and time out rather than act as remote shell access. Text views are bounded and redacted; secrets, Git internals, links leading outside, hard links and unsafe path races are refused by `workspace/folder-read.ts` on both ends.

Only the person whose computer ran the job reads its file text; other shared-space members see metadata. The computer must still offer the task folder. `browseFiles` (*Show task files on the web*, `ensemble browse on|off`) is checked again locally; turning it off hides stored copies and refuses live reads.

### 4.7 The Code tab and terminal on the web

`POST /api/devices/:id/code` accepts only the calls listed in `remote/contract.ts`; `remote/code.ts` runs them through the local API. It is a browser-session route for the computer's owner, never for the assistant, a bridge key or an API token. Relays hold transient request, answer and output state, never a second checkout.

The local switches `browseFiles`, `webEdit` and `webTerminal` are on by default and checked on every call. Secret paths are refused, and redacted views cannot be written back. Binary and oversized files follow the view and refusal limits in [16](16_CODE_TAB.md). Code's allowed folders are set on the computer, or from the web when the folder picker trusts one ([16 §1](16_CODE_TAB.md#open-a-folder)): Code API 6 (`CODE_API`, CLI 0.8.3+) adds the picker (`GET /api/code/browse`, `POST /api/code/browse/folder`, `POST /api/code/folders/trust`) and branches (`GET`/`POST /api/code/branches`, `POST /api/code/branches/switch`). Browsing needs *Show task files on the web*; a new folder, trusting one (added to the folders Code can use) and a branch need *Change code from the web*. The picker lists only the home folder's working places and the folders Code can use, never system folders or the root. A computer on an older Code API gets "Update Ensemble on … to 0.8.3 or later" for these calls only: the picker lists the repositories it knows and the branch menu shows the branch without changing it.

Ensemble Node's file workspace uses the same Code relay with `codeApi: 3` (CLI/desktop 0.6.4+), through its own browser-only `/api/node/files/open` route. The inner `GET/PUT /api/code/node-file` resolves an original from a local opaque source ID or a held run's exact changed path, including non-Git folders.

Saves require the current byte hash and preserve encoding and permissions; stale versions conflict rather than overwrite. Safe downloads use bounded chunks from a short-lived computer-side snapshot. `node-file-sources.json` stores paths and pending metadata only. The Node origin does not unlock the Hub's terminal or passkey endpoints.

Full contract: [35 §8.18](35_ENSEMBLE_NODE.md#818-original-files-in-the-node-workspace).

Runtime 0.6.5 reports canonical `fileId` and `modifiedAt` with each changed run file, and `updatedAt` per direct-file reference. These are metadata only. Node can resolve a quoted file to its last recorded editor across turns and sessions without confusing separate checkouts, and queue a question directly into the editing agent session.

File reads also report modification time so an open binary preview refreshes after a change. Older runtimes remain compatible, but cannot supply provenance they did not record.

Runtime 0.6.6 applies file-scoped protection to provenance-backed original reads and saves. A parent folder too broad or sensitive to grant as a whole execution root does not block a safe generated file in it. The exact file's secret, runtime, symlink/hardlink and write-floor checks still apply; node tools retain their existing folder execution guards.

The web terminal needs a **passkey unlock** with user verification for the web's origin, ending after **30 minutes idle** or **8 hours** (`devices/web-unlock.ts`). *Lock now* ends the session and stops its commands. Commands follow `workspace/terminal-exec.ts`: allowed programs, arguments and folders, hardened Git, confirmation for destructive actions, OS confinement, time and output limits.

It is not a raw shell or an assistant tool. See [16](16_CODE_TAB.md#5-the-terminal-for-you-only).

**The agent's turns.** Code's Agent view ([16 §9](16_CODE_TAB.md#9-the-agent)) queues chat runs for the computer like Assign, with `surface: "code"`. A thread in a folder: the web keeps the folder's path as `context.codeFolder` and offers the turn only to a computer reporting `capabilities.codeAgent` 1 (the refusal names the computer's version); the claim carries `chat`, `surface` and `codeFolder`; `planLocalJob` makes it a chat turn (no pull request, the branch as it is) and refuses it while *Change code from the web* (`webEdit`) is off, and `codeFolderHere` (`remote/accept.ts`) keeps it only in a repository the local Code API may open (`codeRepoRoots`: the workspace, the folders Code can use, run checkouts and reviewed repositories). A thread with no folder works in a new folder of the computer's workspace and needs neither the capability nor the switch; a computer without the capability runs it as a task run that continues its session. Later turns continue the run this computer made and keep one local task for the thread, off its board. With `capabilities.codeAgent` 2 the claim also carries the turn packet's facts (`packet`, the web's Context DB slice, project, linked skills, acceptance criteria and time zone, in place of the task brief's context), the run profile's `profileInstructions` and `fork` (offered only to such a computer); the computer builds the packet, writes the skills and the handoff record, runs the reported checks again, and its `complete` carries `codeTurn` (the completion record, the packet without its hashes, the skills and the handoff record), which the web keeps on its run with its own ids ([16 §9](16_CODE_TAB.md#9-the-agent-implementation-reference)). Accepting or discarding a turn's changes through the web's relay records it on the web's run too.

### 4.9 Subscriptions and included models

#### Continue an agent session

Agent sessions: a computer with `capabilities.sessions` 1 runs a job that continues another in the agent's own session (Claude `--resume`, Codex thread resume, ACP `session/load`) and takes the claim's `steer`. A run that would start a new session may continue one of the computer's own: the computer decides when it takes the job, from the claim's `related`, `sessionChoice` and `newSession`, and reports the decision (`POST /api/devices/self/jobs/:id/session-choice`, under the job's lease), which links the run on the web too ([41 §4](41_AGENT_SESSIONS.md#4-choosing-a-session)).

An older computer ignores those fields and starts a new session. With `capabilities.sessionDelete` 1 it deletes sessions on `session.delete`, which the web also sends on its own for sessions of retired work ([41 §6](41_AGENT_SESSIONS.md#6-deleting-and-cleaning-up)).

Ensemble Node continues sessions only on such a computer, or one reporting 0.4.18 or later ([35 §8.2](35_ENSEMBLE_NODE.md#82-which-session)).

#### Delete a saved agent session

Session deletion: `capabilities.sessionDelete` 1 handles owner-confirmed `session.delete {id,jobIds}` after the jobs stop. The runtime resolves its own job records and native session IDs, deletes the agent's saved history, and acknowledges only success. Project files and sign-ins stay; absent local records or native failures are explicit, not treated as a completed cloud-only delete.

Native methods and retries: [35 §8.9](35_ENSEMBLE_NODE.md#89-session-control-from-the-card).

#### Reuse an answer for a run

Answers for the run: a computer with `capabilities.runAnswers` 1 takes a permission answered on the web or in the Node chat *for this run* (`scope: "session"`): it keeps the answer as a rule of its run, which covers the same command with other arguments, edits in the run's folder and the same site ([30 §5](30_ENGINES.md#5-prompts-from-the-tools-and-answering-in-either-place)).

The web refuses that answer for an older computer with "Update Ensemble on <computer> …"; a question or a push is always answered once.

#### Save a secret on the computer

Secrets for runs ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)): a computer takes `secret.save` frames on its event stream, keeps the value encrypted in its own `run_secrets` with where it may be sent (`allow`), and answers on `/api/devices/self/code-requests/:id` with only whether it saved it (`{saved, name, sealed, allow}`).

Whatever the computer sends back has every saved value hidden (`hideSecretsDeep`). Ensemble Node's secure box sends them; `ensemble secrets` manages them on the computer.

#### Secret and sign-in compatibility

| Capability | Frame | Meaning |
| --- | --- | --- |
| `secrets: 1` | `secret.save {id, name, value}` | The value over TLS through the server (compatibility) |
| `secrets: 2` and `sealKey {kid, alg, spki, fingerprint}` | `secret.save {id, name, decisionId, sealed: {v, kid, epk, iv, ct, aad}}` | A box sealed in the browser for this computer's key: opened, checked (its device id and key, the card, the name, a site it trusts, the expiry) and taken once here (`remote/secrets.ts`, `credentials/`). A plain `value` still works. |
| `secretsMode: all \| named` | None | How runs that name no secrets get them here (`ensemble secrets mode`) |
| `secretHttp: 1` | `node.tool.request {tool: "secret_http", …}` | A node's request by reference (§4.10) |
| `takeover: 2` | `takeover.start {id, takeoverId, tab, loginId? \| jobId?, sealed, endsAt}`, `takeover.input {takeoverId, seq, iv, ct}`, `takeover.end {id?, takeoverId, done, reason?}` | The owner controls a tab from the web, end to end (§10.1): the channel's secret sealed for this computer (purpose `takeover`), encrypted input in order (the server relays it in sequence order), I'm done or Stop. A sign-in's takeover shows a clean browser (the start's answer says `mode: "clean"`, or `"tab"` with a `note` when it could not start), each frame's header says which page it shows (`url`, `site`, `title`, `popup`, `mode`), and the computer ends it itself when the sign-in is seen done (reason `signed_in` or `passed`). A server takes any version from 1 (`TAKEOVER_MIN_API`) |
| `takeover: 3`, `live: 1` | `takeover.start {…, kind?, operation?, view?}`, `takeover.control {id, takeoverId, on}` | Live views of a node's own tab or terminal session (§10.4): `kind` `browser` or `terminal` (its session id as `tab`), the node's `operation` that must own it, `view` `watch` or `control`; `takeover.control` switches and is answered `{view}`; `takeover.extend {takeoverId, endsAt}` moves any takeover's end later, never past an hour after it started |
| `cliLogins: 1` | None | A node's command that needs a sign-in (§4.10): its codes go to `/api/devices/self/nodes/device-codes`, a page it opens through `BROWSER` to this computer's sign-in browser and `/api/devices/self/nodes/logins` |
| `logins: 2` | `login.resolve {id, loginId, decisionId, action, sealed?, v?}` | The owner's answer to a sign-in card (§10.1): a saved login, a window on the computer's screen, a check (`done`, or `check` from the chat), a login sealed for this computer (purpose `login`), the one-time code the site then asks for (`code`, sealed the same way), or not now. A sign-in carries its `purpose` (`sign_in` or `human_check`), and the computer says at `/logins/:loginId/state` when one ended by itself. The answer is a status (`signed_in`, `passed`, `needs_code` with what the site asks, `waiting`, …) and a sentence, never a value; to a server that does not send `v: 2` it says `signed_in` for `passed` and `failed` for `needs_code` |

The web pins the first `sealKey` a computer reports (at pairing, or on its first report after updating) on its `devices` row and encrypts only for that key; a later different key changes nothing until the computer is paired again (`credentials/device-key.ts`). `GET /api/devices` returns each computer's pinned `sealKey` and `sealKeyMismatch`.

#### Choose which secrets a run receives

**Which secrets a run gets.** A claim may carry `secrets` (protocol 6): the names the run may have, possibly none. The computer keeps the list on the local job (`context.secrets`) and gives the run only those (`secretScopeOf` and `runSecretEnv` in `lib/run-secrets.ts`).

Ensemble Node's runs always carry it, and so does a run whose run profile names secrets ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)).

Without the list, the computer's mode decides (`credentials/mode.ts`): every environment secret in `all`, the compatibility mode and the default; none in `named`. A secret with allowed destinations is never put in an environment: a run uses it by reference, with `secret_http` or git (`credentials/run-env.ts`). A computer that reports `capabilities.secretScope` 1 applies the list; an older one ignores it and has neither evidence upload nor node tools.

#### Use an AI subscription in chat

The assistant can run turns on AI subscriptions signed in on a paired computer through `subscriptions/` and the assistant-turn routes; this needs CLI 0.3.10+ or desktop app 0.3.7+ there (`capabilities.assistantTurns` 1 or more, `ASSISTANT_TURNS_MIN`). Offline sign-ins are not offered. This is separate from engine assignment and personal API keys ([30](30_ENGINES.md)).

One runtime runs a turn. The first `GET /api/devices/self/assistant-turns/:id` takes it for the runtime that asked (`pickTurn` in `subscriptions/relay.ts`, by its `x-ensemble-instance`, §2), which may read it again; any other runtime of that computer gets 409 "This turn was picked up by another Ensemble on this computer." and leaves the turn (`answerAssistantTurn` in `remote/assistant.ts`), and its file reads, tool calls, reply text and `done` are refused with 409 too. A turn taken by a runtime that sends no id (an older one) takes posts from any runtime of that computer; a second read is still refused.

The computer also reports the agents' apps it has that come without the agent (`capabilities.agentApps`: `cursor-app`, `vscode-copilot`). `agents.setup {agent}` asks it to install that agent with the vendor's installer in a terminal window and sign in; the web sends it only to a computer that reports the app, and asks an older one to update ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)).

#### Send chat attachments to the agent

A computer that reports `assistantTurns: 2` (`ASSISTANT_TURN_FILES`) takes the files attached to the message: the turn's spec lists them (`files`), and the computer downloads each with `GET /api/devices/self/assistant-turns/:id/files/:fileId` (`assistantFile` in `remote/client.ts`, at most the listed size plus 64 KB, stopped with the turn).

The route answers only the device the turn went to, only for a file on that turn's list (404 otherwise, or when the file is gone), and 410 once the turn ended; it sends the bytes with the file's media type, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A computer that reports 1 gets no file list; a note after the message names the files and says Ensemble on that computer must be updated to receive them.

How each agent is given the files: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

#### Keep one agent session per chat

A computer that reports `assistantTurns: 3` (`ASSISTANT_TURN_SESSIONS`) keeps one agent session per chat: the spec carries `session: { key, history }` (the conversation id and the chat so far), and the computer resumes that chat's session or starts one with the history ([41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan)).

Its `done` says whether the turn went on in the earlier session (`result.resumed`), which the web records with the turn's `model.call` metric (`session: { key, resumed }`). An older computer gets the history in front of the message instead.

From 0.8.0, a turn that started a new session in place of the chat's earlier one also says why (`result.restart: { reason, error }`, [41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan-implementation-reference)), and the web records it in the same metric. A turn whose session the person used in the agent's own app since Ensemble's last turn carries those exchanges (`result.outside: { app, turns, earlier }`), which the web saves into the chat before the turn's message. A batch on `/stream` may carry a `status` line for the chat while the computer waits ("Waiting for the ChatGPT app…"). An older server ignores both, and a reason it does not know is dropped without failing the turn.

#### Use the agent’s own tools

A computer that reports `assistantTurns: 4` (`ASSISTANT_TURN_OWN_TOOLS`, CLI and desktop 0.7.15) runs a chat, Ask Ensemble or a routine with the agent's own tools too (`ownTools` on the spec), each call judged by the hard floor in the turn's folder through `POST /api/engine/assistant/ask` on its own runtime ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)).

An older one runs them with Ensemble's tools only.

#### A node's turn with the agent's own tools

A computer that reports `assistantTurns: 5` (`ASSISTANT_TURN_NODE_TOOLS`) runs an Ensemble Node's turn with the agent's own tools too: the spec carries `ownTools` and the node's policy (`node`), and no `maxTurns` (no limit). Each own call is judged there by the node's folder policy (`nodeOwnJudge` in `subscriptions/node-own-tools.ts`), and one its owner must answer goes to `POST /api/devices/self/assistant-turns/:id/ask {capability, target, label, scope, operation, what}` (`assistantAsk` in `remote/client.ts`), which the web holds while it waits for the owner's card, at most 90 seconds. The answer is `{decision: "allow", grant?}` (the computer keeps the grant as its own rule) or `{decision: "deny", message, waiting?}`; `waiting` means the turn parks, so the computer refuses the turn's later calls with the same message, and two seconds after that answer the web stops the run with `assistant.stop {id, park: true}`: the computer stops the agent and keeps the chat's agent session as after a turn that ended, so the turn the owner's answer wakes goes on in it ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)). `capability` is `run`, `files`, `read` (a read that names no path) or `http`; `target` is a folder, an address's origin, `program:<name>` (a program that changes the system, answered for the run at most) or `unnamed:<hash>` (a call that names no path, answered once). The computer keeps a grant as its rule of that kind (`own:write`, `own:origin`, `own:program`), apart from the node's computer tools' rules, and calls asking about the same thing at once share one ask. The route answers only the device the turn went to and the runtime that read it (410 once the turn ended, 409 for another runtime or a turn that does not ask).

The agent's own calls go to the web with the reply's batches on `/stream` (`tools`: id, name, summary, start or end, ok, whether it can change something; at most 50 a batch), and while one runs the computer posts a batch at least every 60 seconds, so a long build is not taken for silence. A computer before 5 gets a node's turn with Ensemble's tools only and `maxTurns` 64, the most it takes.

A relayed turn ends when its computer sends nothing for 10 minutes (no reply text, status line, tool call or own call; `QUIET_MS` in `subscriptions/relay.ts`). One of Ensemble's tools running, or an owner's answer awaited, is working, not silence; a turn that keeps working has no time limit.

#### Remove a chat’s agent history

A computer that reports `assistantSessionDelete: 1` (`ASSISTANT_SESSION_DELETE_API`) takes the frame `assistant.session.delete {id, key}` when the person deletes a chat (and 30 minutes after an inline Ask Ensemble's last answer, for that page's session: [41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan)), drops that chat's agent session (`remote/assistant-session-delete.ts`) and answers through `POST /api/devices/self/code-requests/:id` with `{ deleted: true, found }`.

Requests it missed while away are sent when its event stream (`GET /api/devices/self/events`) next opens ([41 §6](41_AGENT_SESSIONS.md#6-deleting-and-cleaning-up)).

#### Remove a deleted project from Codex

A computer that reports `projectDelete: 1` (`PROJECT_DELETE_API` in `remote/contract.ts`) takes the frame `project.delete {id, projectId}` once an Ensemble project has been in Trash 10 minutes (`workspace/project-delete.ts`), removes the Codex projects Ensemble made for it there from the ChatGPT app's sidebar and from Codex (`remote/project-delete.ts`; [41 §3](41_AGENT_SESSIONS.md#3-in-the-agents-own-apps)) and answers through `POST /api/devices/self/code-requests/:id` with `{ deleted: true, found, owed }`.

`owed`: the ChatGPT app is open, or Codex has not deleted one yet, so the computer keeps the removal and finishes it itself (every 2 minutes, and when its runtime starts).

The web asks every computer paired to the project's account and every one that ran a Codex task of the project: an online one from the scheduler's minute tick, again at most every 5 minutes until it confirms, and one that was away when its event stream next opens.

The requests wait per computer in the `projects.codex-project-deletes` preference for up to 90 days; those of a project back from Trash, or of a computer no longer paired, are dropped. The desktop app and the CLI runtime remove the Codex projects of their own deleted projects themselves, from the same minute tick.

#### Use included models on a paired computer

A paired desktop app or CLI calls included models through `/api/devices/self/included` and `/api/devices/self/included/turn`. The device token identifies the account; Azure credentials stay on the host, and usage counts against that account's credits and the global ceiling ([33](33_INCLUDED_AI.md)).

### 4.10 A node's own tools on the computer

A node can run a command, take a screenshot of a terminal, run one approved command as the administrator, read git, call a development server on the computer, change or share a file, and browse and capture (§10) without starting an agent session ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)).

Each call goes to the computer as a `node.tool.request` frame on its event stream, like `code.request` (`askDeviceFor` in `devices/file-relay.ts`). The computer judges it and answers once on `/api/devices/self/code-requests/:id` (`device-tools/answer.ts`).

Only a computer that reports `capabilities.nodeTools` (`NODE_TOOLS_API`) gets these frames; for an older one the node is told "Update Ensemble on <computer>". Version 2 adds `terminal`, `sudo`, files `share` and calls without a folder; version 3 (`NODE_TOOLS_RUN_STOP`) adds `run_stop`.

`capabilities.nodeFiles` 1 (`NODE_FILES_API`) adds a folder to files `share` (zipped here), any file up to 100 MB (`NODE_FILE_MAX_BYTES`), and files `save`. A computer that reports `capabilities.live` (`LIVE_API`) also takes `live` calls: terminals kept open between calls (§10.4). One that reports `capabilities.desktop` (`DESKTOP_API`) takes `desktop` calls: its agent screen and its owner's real screen (§11), `desktop {name, input, operation, uploadId?, inlineImage}`, answered as a `NodeDesktopAnswer`.

##### Run a command

Checks the command like an agent's (`workspace/guard.ts`: allowed programs, arguments, folders; git against the run profile's git ceiling; no `git push` or `fetch`) and runs it under the OS sandbox with the folder writable and the profile's network choice. Named saved secrets go into that command's environment only.

Sign-ins it needs go to the owner (`capabilities.cliLogins`, `device-tools/cli-logins.ts`, below)

Request: `run {folder?, command, cwd?, timeoutSec ≤ 900, background?, secrets?}`.

##### Capture a terminal screen

Runs the command in a pseudo-terminal of `columns` × `rows` (util-linux `script` on Linux, the BSD one on macOS), checked and sandboxed like `run`, but able to list the computer's processes where that is safe (`hostPids`, [24 §2](24_DESKTOP_SANDBOXING.md#2-os-sandbox-backends)), so htop and top show the real system.

`keys` are typed once it started: text, or a key name in braces (`{Enter}`, `{Escape}`, `{Tab}`, arrows, `{PageUp}`, `{Home}`, `{F1}`…`{F12}`, `{Ctrl+C}`, `{Alt+x}`), arrows as the program asked for them (application cursor keys).

After `seconds`, or when it ends if sooner, its screen is replayed in a headless terminal (`@xterm/headless`, `capture/screen.ts`) and rendered by Chromium to a PNG in the operation's evidence folder, with its colours, saved secret values and key shapes hidden; then it is stopped (SIGTERM, SIGKILL a second later).

Without a pseudo-terminal (Windows, or no `script`) the command runs as `run` does and its output becomes a transcript image (`device-tools/terminal.ts`)

Request: `terminal {folder?, command, seconds ≤ 60, columns, rows, keys?, title?, operation, uploadId, network}`.

##### Run an approved administrator command

One command as the administrator, which the owner approved on a card in the chat. Never in the OS sandbox. The command must be the card's (`commandHash` is its SHA-256).

The owner's password, when given, is a box sealed in their browser for this computer (purpose `sudo`, the card as the decision, the hash as the name), opened and checked like any sealed box ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets), `credentials/seal.ts`) and taken once (`claimOnce` in `credentials/replay.ts`; a password sudo did not accept frees the card for a new box).

It is typed into `sudo -S -k -p ""` on its input, never in an argument, the environment, a log or the output; where sudo needs no password it is not typed at all. Without one: `sudo -n -k`. The system's own sudo only (`/usr/bin/sudo`), with a clean environment. Output, time limit and running on as for `run`; the answer's `error` says when the password was not accepted or is needed.

Not on Windows (409) (`device-tools/sudo.ts`)

Request: `sudo {folder?, command, commandHash, cardId, sealed?, timeoutSec ≤ 1800}`.

##### Stop a node command

Stops that node's `run` or `sudo` still running here, and the processes it started (`stopNodeCommand` in `device-tools/run.ts`); not judged, since it only ends the node's own work. Answered 200 `{stopped}`, false when it is not running here (it ended, or this computer restarted). The server asks only a computer that reports version 3; on an older one the command ends at its time limit

Request: `run_stop {runId}` (`nodeTools` 3).

##### Read Git state

`status`, `diff`, `log`, `show` or `branch` (list only), read-only and sandboxed; options that write, run programs or leave the folder are refused (`device-tools/git.ts`)

Request: `git {folder?, op, args?}`.

##### Call a local development server

`http` or `https` only, no user name or password, and every address the name resolves to must be loopback; the connection uses the checked address, and each of at most 5 redirects is checked again. Ensemble's own local port is refused (`device-tools/http.ts`)

Request: `http {url, method?, body?}`.

##### Write, move or delete files

Inside the folder only: no link, no hard link, no key, credential or `.env` file, no `.git`; a write is at most 1 MB, a move never overwrites, delete removes files only (`device-tools/files.ts`)

Request: `files {action: write\|move\|delete, folder?, path, to?, content?}`.

##### Share a file or folder

A file becomes the node's evidence, to show its owner in the chat: checked like an attached file (no link or second name, no key, credential, `.env` or history file, nothing in a key folder or git's, not Ensemble's data or another account's, no saved secret value, at most 100 MB, its bytes what its kind says), copied into the operation's evidence folder and kept and sent like a capture (§4.11), with its caption.

Its kind comes from its name: `.md`, `.markdown`, `.txt`, `.log`, `.csv`, `.json` and `.pdf` are reports, pictures images, `.mp4`, `.webm`, `.mov` videos, anything else a file (`device-tools/share.ts`).

An archive (a `.zip`, an Office file, a `.tar`, a `.tar.gz`) is also read for its entries: one the name rules refuse (`.env`, a key, `.git/…`), or a saved secret value in its first 256 MB, refuses it (`archiveProblem` in `device-tools/zip.ts`).

With `nodeFiles` 1, `path` may be a folder (`.` for the whole one): it is zipped here into `<folder>.zip` (kind `file`), each file read and checked as above and its text redacted as a shared text file's is; links, special files, what the floor refuses and dependency and cache folders (`node_modules`, `.venv`, `__pycache__`, `.next`, `.cache`, …) are left out and named in the answer; at most 10,000 files, 1 GB read and a 100 MB zip (`zipFolder`, written with `node:zlib`, no ZIP64)

Request: `files {action: share, folder?, path, caption?, operation, uploadId}`.

##### Save a chat attachment to the computer

A file of the owner's Ensemble Files (a chat attachment) is written at `path` in the folder: fetched once from `GET /api/devices/self/node-files/:downloadId`, refused unless it is `size` bytes with that SHA-256, at most 100 MB.

The same path rules as `write` (no link or second name, no key, credential or `.env` file, no `.git`); a file already there is replaced only with `overwrite` (409 otherwise, before anything is fetched), and a folder at `path` is 409 too. Judged like a write (capability `files`: the first use of a folder asks) (`runNodeSave` in `device-tools/files.ts`)

Request: `files {action: save, folder?, path, downloadId, size, sha256, overwrite?}` (`nodeFiles` 1).

##### Call a service with a saved secret

A request with a saved secret put in where `{{NAME}}` appears in a header or the body, only to the secret's allowed origins, never in the address, no redirects followed; the answer has the value hidden (`credentials/secret-http.ts`, `capabilities.secretHttp`). The allowed destinations are the owner's answer, so no Needs me card is asked for

Request: `secret_http {ref, url, method?, headers?, body?}`.

##### Keep a terminal open or watch a browser tab

A terminal kept open for the node (§10.4, `device-tools/terminal-sessions.ts`): `terminal_open` is judged like `run` in its folder (the policy below, capability `run`) and starts the shell; the other actions are on the node's own session, each line it submits judged as it is typed. `browser_tab` checks the node's tab is its own and watches it for a live card.

Answered with a `LiveAnswer` (`session`, `screen` as text with secrets hidden, `cursor`, `atPrompt`, `ended`, `exitCode`, `controlled`)

Request: `live {action: terminal_open\|terminal_send\|terminal_read\|terminal_close\|browser_tab, folder?, session?, title?, text?, keys?, waitMs?, lines?, columns, rows, tab?, liveId?, operation, network}` (`capabilities.live` 1).

##### Browse and capture for a node

One browser or capture tool of §10 (`device-tools/capture.ts`) for the node's tool operation (`node:<nodeId>:<mission>`), writing into its evidence folder `<data>/evidence/node/<digest>`. Opening or capturing a page is judged per address (capability `browse`), starting an app per folder (`run`, `resolveToolFolder`); calls on the operation's own tabs, apps and files are not asked about.

With `network` false, only this computer's own addresses. Each file it writes is recorded as the node's evidence and sent under `uploadId` (§4.11); the answer (`NodeCaptureAnswer`) carries the tool's summary and result, each file's id and whether it is held or kept here, and what was not kept

Request: `browser {name, input, operation, uploadId, network}`, `capture {…}` (protocol 7, `capabilities.browser` 1).

#### Choose a folder for node tools

**Folders.** A folder is one this computer shares (by its label) or a full path Ensemble may hand to an agent (`resolveWorkFolder`). A call that names none works in the node's own folder, `<workspace>/nodes/<handle>` (the node's `nodeSlug`, else the start of its id), made with mode 0700 on first use and refused when a link or a file is in its place (`ownToolFolder`).

Ensemble's run folders (`<workspace>/runs/<name>`) and every node's folder (`<workspace>/nodes/<handle>`), and folders inside them, count as the node's own too (`isEnsembleWorkFolder`): the floor still applies there. A link, the home folder itself, a system folder, Ensemble's data folder and folders that hold keys, sign-ins, Ensemble's git helper or its code are refused (`device-tools/folders.ts`).

The sandbox also denies the secret folders and files in the home folder (`SECRET_PATHS` in `workspace/guard.ts`, which includes `SECRET_HOME_PATHS`), Ensemble's data folder (with the run secrets, the key that encrypts them and the browser profile folder) and its git helper, inside any folder (`nodeToolDenies`).

#### Approve a node’s operation

**Who decides** (`device-tools/policy.ts`, on the computer). In order:

1. The hard floor: the folders above, and the list of dangerous commands (`device-tools/dangerous.ts`; disks, the system, the home folder and keys, power, accounts, the network, packages the system needs, fork bombs, and as the administrator open shells, piped downloads and keys) for `run`, `terminal`, `sudo`, the command of `capture_app_start` and each line a node submits in a live terminal. 403, and no answer opens it; the computer's ledger keeps `node.tool.refused` with the rule.
2. The node's own folder (and Ensemble's run and node folders), and public web pages (a name that is not local and resolves only to public addresses, `publicWebAddress` in `device-tools/http.ts`): allowed without asking. On this computer `ensemble approvals websites ask` (`askBeforeBrowsing` in `remote.json`) makes public pages ask too. Where the sandbox is weak, commands in the node's own folder still ask once per mission.
3. The owner's answers for this computer: rules in `decision_rules` with `source` `node-tools`, one per folder or web address (`toolName` `folder` or `origin`), for the mission (`sessionId`) or always.
4. Unattended (the node's run profile runs unattended, and the node does not ask first): allowed inside the sandbox.
5. Attended: 428 with `body.ask` (`NodeToolAsk`; capability `run`, `git`, `files`, `read` for sharing a file, `http` or `browse`). The server raises one card with *Once*, *This mission* and *Always for this folder* (or *for this address*). The answer goes back with the node's next call (`grants`), and the computer keeps *This mission* and *Always* as its own rules.

A `sudo` call is not judged per folder: its card is the owner's answer for that exact command.

The answers count only while the computer accepts approvals from the web (`acceptWebApprovals`); with it off, a call without a rule here is refused (409). Where the sandbox is weak (no OS sandbox, or `capabilities.sandbox` `advisory` or `ask`), the floor is best effort: *Always* does not cover commands, which ask once per mission instead.

#### Read command results and long output

**Answers.** 200 with the result (a `NodeCaptureAnswer` for `terminal`, whose result is `{screen, exitCode, ended}`, and for files `share`); 202 for a command still going; 403 for the hard floor; 404 for a missing path; 409 when switched off or not possible here. What a command prints is redacted for saved secret values and key shapes.

An answer carries at most 64 KB (`NODE_TOOL_INLINE_BYTES`, the start and the end). Longer output goes in order, in chunks at line ends, to `/api/devices/self/tool-runs/:runId/output`, at most 1 MB per command.

The server keeps it in Redis for 6 hours under the run's id, never in the database (`devices/tool-runs.ts`). A command still going after 60 seconds (`NODE_TOOL_FOREGROUND_MS`), or started with `background`, runs on.

Its last chunk says how it ended (`exitCode`, and `timedOut` when it was killed at its limit), and the server wakes the node once (`enqueueTurn`, reason `tool`), except for a run the node stopped, a sign-in a newer attempt replaced, or a sign-in that ran out of time ([35 §8.16.4](35_ENSEMBLE_NODE.md#8164-sign-ins-a-command-needs)). Stopping remote work stops these commands too.

#### Complete a command’s sign-in

**Sign-ins a command needs** ([35 §8.16.4](35_ENSEMBLE_NODE.md#8164-sign-ins-a-command-needs)).

While a `run` command runs, foreground or background, its output is watched for a sign-in code (`device-tools/device-codes.ts`: Microsoft's device login, GitHub's one-time code, AWS SSO, Google's device page, any "open ‹page› and enter the code ‹code›"); each code goes to `POST /api/devices/self/nodes/device-codes` as it appears, and again with `status` `done` (exit code 0) or `expired` when the command ends.

On Linux and macOS the command runs with `BROWSER`, and `xdg-open`, `sensible-browser`, `x-www-browser`, `www-browser` and `gio` (Linux) or `open` (macOS) first on its `PATH`, set to helpers in `<workspace>/.cache/tmp/ensemble-signin-<run>/bin`: a helper writes an http(s) address to a file there and exits, and passes anything else to the real program. The folder is removed when the command ends, whether or not its answer went through.

The runtime reads that file every 300 ms, opens each page (public https pages and this computer's own addresses only, five per command) in the node's own tab, raises a sign-in for it (`source: "cli"`, done when a page reaches the command's own `redirect_uri` on this computer or the command ends well) and posts it at `POST /api/devices/self/nodes/logins`; declined or expired, the command is stopped. A command with a sign-in answers as soon as the owner is asked (`deviceCodes`, `signInPages` in the answer): in the foreground it goes on in the background then; a background one with a `login` word in it waits up to 8 seconds for its prompt first.

#### What node operations record

**Ledger.** Each call writes one entry on the computer (`node.tool.run`, `node.tool.terminal`, `node.tool.terminal_session` (open and close) and `node.tool.terminal_line` (each line's program, never its text), `node.tool.sudo`, `node.tool.git`, `node.tool.http`, `node.tool.files.*`, `node.tool.browser`, `node.tool.capture`, `node.tool.ask` and `node.tool.refused`) and one on the server (`node.device_tool.<tool>`). A command's sign-ins add `node.cli_login` (and `node.cli_login.refused`) on the computer and `node.device_code` on the server, with the site and status, never the code.

They keep the program or operation and the folder or origin, never the output; `node.tool.sudo` keeps only the command's SHA-256, the folder and the exit code.

### 4.11 The worker's report and evidence

#### Read the worker’s report

**Report.** A run's worker reports its own result with `report_result`, or `.ensemble/result.json` when its agent has no MCP ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)). The computer validates it as a `StepReport` (`node/report.ts`) and keeps it on its local job. `complete` sends it as `report` (protocol 6).

The server checks the shape again, redacts it and keeps it on the job (`workspace_jobs.report`); an invalid report is dropped with a warning.

#### Receive files from a run

**Evidence.** Each file the worker attaches is uploaded before `complete`, while the run holds its lease (`evidence/upload.ts`, also during the run):

- `POST /api/devices/self/jobs/:id/evidence`, authenticated like progress: the device token and the job's lease in `x-ensemble-job-lease`. The body is the file's bytes (`application/octet-stream`). `x-ensemble-evidence` carries `EvidenceMeta` as base64url JSON: `{id, kind, name, size, sha256, mime?, caption?, requirementId?, local}`.
- The computer reads the file again from the run's evidence folder, under the same checks as when it was attached, and sends it only if it is unchanged. Text is redacted before it goes.
- The server checks it again: the size, the digest, credential names, and the type sniffed from the bytes (it never trusts the name or the computer). Text is redacted again. Then it stores the bytes where Files keeps uploads ([32 §7](32_FILES.md#evidence-from-agent-runs)), lists the file on the run's card in Ensemble Node and writes `evidence.upload` to the ledger. The same `id` again answers with the stored file.
- Answers: 201 (stored), 200 (already stored), 400 (bad description, size or digest), 413 (over 100 MB), 415 (type does not match the kind), 422 (credential file), 409 (lease, another run's id, or 100 files already), 404 (no such job).
- Every kind (`screenshot`, `image`, `video`, `trace`, `report`, `log`, `file`) is at most 100 MB (`evidenceLimit` in `evidence/limits.ts`).

#### Keep run evidence on the computer

**Off on this computer.** `ensemble evidence off` (`evidenceUpload` in `remote.json`, reported as `capabilities.evidenceUpload`) keeps the files here. Only their description goes up, with `local: true` and no bytes. The card shows them as "on this computer, not uploaded", and reading one answers 409. A server without the route (404) gets nothing more for that run.

#### Handle screenshots and recordings

**Captures** (protocol 7). What a run's browser and capture tools write is recorded as its evidence where it lies, with no attach step (`evidence/captures.ts`), and goes the same way. `EvidenceMeta` may also say:

| Field | Meaning |
| --- | --- |
| `held`, `holdReason` | Held for the owner's preview: like `local`, no bytes come with it; the server lists it held and shows its preview card ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)) |
| `variantOf`, `variant` | A video's `poster` or small `preview` image, sent after the video |
| `details` | What capture measured: `width`, `height`, `durationMs`, `fps`, `frames`, `codec` |

A server before protocol 7 gets no held file and none of these fields.

#### Files requested outside a run

**Upload ids.** A file the web asks for outside a run's lease goes to `POST /api/devices/self/evidence-uploads/:uploadId`, with the same headers and checks but no lease: the web makes the id (`evidence/grants.ts`, in Redis) for one device and account, and for one purpose: `new` (a node's tool call: files of that node operation, rows with no job, at most 100 per operation), `release` or `preview` (one file this computer keeps). 410 when nobody waits for it any more.

#### Preview, release or discard a held file

**Files kept here** (held, or upload off) are asked for with `evidence.request {id, evidenceId, action, uploadId?}` on the event stream, answered like a Code answer (`evidence/requests.ts`): `preview` sends the file under the upload id for its owner's eyes (the server keeps it five minutes in Redis, at most 32 MB); `release` sends it the same way and marks it released here (409 with evidence upload off); `discard` deletes it, its poster and preview, here.

The file is read again by the same rules as any upload: unchanged since it was recorded, no saved secret value in it, text redacted.

### 4.12 Worktrees for parallel work

An Ensemble Node mission may build in parallel in one repository ([35 §8.15](35_ENSEMBLE_NODE.md#815-parallel-work-in-one-repository)). Its runs' claims carry `mission` (optional; older servers leave it out):

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

`acceptWebApprovals` (*Accept approvals from the web and phone*, `ensemble approvals`) is **on by default**. When on, the web's run settings apply and supported risky decisions can be confirmed remotely. When off, risky answers stay on the computer and web settings can only narrow local permissions.

The sandbox (a beta, off by default; [24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)) follows the same rule: the web's choice while the computer accepts web settings; otherwise the web can only turn it on, and the computer's own Settings → Agents → Sandbox by default decides (`planLocalJob`, then `sandboxFor`).

The computer checks its own pending decision and action hash; the first valid answer wins, and a timeout never allows.

A task from the web is limited in git only by the person's own choices: its Git choice (No limits by default), its branch (current, a new one by name, or an existing one), *Use my git sign-in* for private and SSH repositories (applied when the computer accepts web settings), and a pull request into any branch ([24 §5](24_DESKTOP_SANDBOXING.md#5-git-and-credentials)).

Pushes and `gh` use the computer's own sign-in; Ensemble puts no branch, push or merge rule of its own on it. Merging a pull request Ensemble opened waits for the person's Allow on Needs me unless the task said to merge when checks pass ([24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)).

A web confirmation is an authenticated session action, not a device-verified WebAuthn signature over each decision; the terminal passkey protects only the terminal.

### 5.2 Rate limits

Pairing, heartbeat and progress, file browsing, code, subscriptions and model calls have their own buckets in `lib/rate-limit.ts` and the relays. Account quotas and device/lease checks still apply.

## 6. Shared spaces

A run can belong to a shared space while running on a member's own computer. Members see permitted progress and results; execution decisions and file text belong to the person running it. Revocation, sharing access and the computer's switches are each checked ([29](29_SHARING.md#4-agent-runs-in-a-shared-space)).

## 7. What synchronizes

Assignments, bounded context and attachments, progress, decisions, results, usage and review metadata cross the protocol, plus model keys as described in §4.2. So do the worker's report and the files it attaches, unless the computer keeps them (§4.11), and the bounded answers of a node's tool calls (§4.10).

The local database, arbitrary folder contents, the local ledger and other credentials do not.

## 8. Device lifetime and removal

Rename a computer from your account; its next heartbeat keeps the saved name. To end its remote access, revoke it on the web or unpair it locally. This stops remote work and turns, and removes the device token. Local work follows its own lifecycle. Losing the network alone does not revoke the computer.

A computer paired again is the same computer to the web when it is the same installation (`capabilities.installId`, kept in `remote.json` through unpairing); for pairings made before that, the newest computer with the same name and platform, or the only one on that platform (`devices/successor.ts`). Its earlier runs then show on it, open in Code and the file view, and run again there.

Packaged launchers set `ENSEMBLE_INSTALL_PATH`; on each heartbeat the runtime checks it, and once the executable has been missing on every check for 10 minutes it stops remote work, tries to revoke itself and drops the pairing even when the host is unreachable (`remote/installed.ts`, `remote/loop.ts`).

The wait is for package upgrades, which remove the launcher for a moment (Homebrew relinks `bin/ensemble`, Scoop swaps `current`); before it, an upgrade with the runner running unpaired the computer. The web's online dot can stay until the heartbeat window passes.

## 3. Lease, heartbeat and interruption

`devices/constants.ts` sets a **120-second lease** and a **90-second online window**; the computer heartbeats every 30 s (`remote/contract.ts`). Heartbeats and progress extend only a held lease, and the scheduler sweeps expiry, so the interruption shown can lag the expiry by up to a minute.

Claims and writes are fenced by device and lease token: another device or a stale token cannot complete the job. A missed lease marks the attempt Interrupted, settles open run and decision state and keeps partial work. Sleep, app exit and network loss are interruptions, not completion.

The server cannot tell a computer that was switched off from one that only lost its connection, so the computer settles each run it held when it is back (`reconcile` in `remote/loop.ts`, `devices/recover.ts`, protocol 5):

| On the computer | What happens |
| --- | --- |
| The run kept going, or finished while the computer was cut off | **Reattach** (`POST …/reattach`): the same run gets a new lease and goes on; its open questions are asked on the web again; a finished run then reports. Nothing runs twice. |
| The run was cut off because Ensemble quit (a restart, a power cut, a crash) | **Carry on** (`POST …/resume`): a new run continues it in the same folder and the agent's own session, told why it stopped (`resume` on the claim; tagged *resumed n/2* on the web). |

A run is reattached or carried on only when its lease ran out (or the computer restarted before it did), the person has not stopped it, run it again or paused the agent, and only for the computer that ran it (or the same computer paired again, §8).

Carry-ons stop after `MAX_AUTO_RESUMES` (2) per task chain and are not made for a run interrupted more than 24 hours ago; the next interruption stays for Run again. Runs in a shared space and chat messages are never carried on by themselves. A run the web no longer wants stops on the computer.

After an outage of the server itself (no heartbeat from any computer for a lease period), leases that ran out meanwhile get one more lease period when it starts. The claim refuses past the person's concurrent-run limit, so a run that ends wakes their computers that have queued work, and each heartbeat also claims.

The event stream only wakes the computer; persisted job and lease state is authoritative. File and code relays use scoped Redis keys with short lifetimes; assistant turns on a subscription live in the API process's memory (`subscriptions/relay.ts`). Decision waits also poll the database, because a second API process does not share the in-memory bus.

## 10. Browser and capture on the computer

The local runtime has a browser broker (`apps/hub-api/src/browser/`) and a capture service (`apps/hub-api/src/capture/`).

Ensemble Node's device tools and a coding agent's run MCP server both call them ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)), through one tool layer: `runBrowserTool` and `runCaptureTool` validate a call and run it for one **operation** (a job attempt, or a node's tool operation), and `browserToolDefinitions()` and `captureToolDefinitions()` give each tool's JSON Schema.

The server never runs a browser.

The desktop app's sidecar and the CLI's runner configure both when the hub starts (`startCaptureRuntime` in `capture/runtime.ts`, from `index.ts` on the computer only): the owner's privacy rules (the values of their saved secrets, read again at most every 5 seconds, and this computer's site lists, below), the OS sandbox for apps (§10.2) and logging. A runner (not a short-lived admin runtime for a CLI command) also cleans up after a crashed runtime and starts the janitors.

When the runtime stops, every tab, app, display and recording ends.

### 10.1 Browser broker

| Setting | Value |
| --- | --- |
| Browser | Playwright's Chromium (`playwright-core`, pinned in hub-api). `ENSEMBLE_CHROMIUM` names one; else full Chromium before the headless shell (headless runs it as the real browser, which sites block far less), the revision Playwright expects in `<data>/playwright` or Playwright's own cache, else the newest other revision, else an installed Chrome (`browser/chromium.ts`) |
| How sites see it | As this computer's Chrome: no `--enable-automation`, Blink's `AutomationControlled` off, `navigator.webdriver` false, the user agent of its version without `HeadlessChrome`, and the computer's language (`Accept-Language`) and time zone (`browser/launch.ts`). An emulated device keeps its own user agent |
| Profiles | One persistent profile per name in `<data>/browser/<profile>` (default `default`): sign-ins stay between tasks. `private: true` opens a separate context for one operation, which can emulate a Playwright device. Names ending in `-signin` or `-clean` are the clean browsers' own folders (`browser/clean.ts`), never a profile |
| Session cookies | Chromium keeps only cookies with an expiry, and drops the rest when a profile's last page closes. The broker writes a profile's session cookies to `<data>/browser/<profile>/ensemble-session-cookies.json` (mode 0600) every 30 s, before its browser closes or restarts and before its last page closes, never from a browser with no page, and puts them back when the browser starts or opens a page again (`browser/session-cookies.ts`) |
| Window | Headless, unless a tab asks for one (`headed`) and the computer has a display (`DISPLAY` or `WAYLAND_DISPLAY` on Linux; always on macOS and Windows) |
| Leases | A tab belongs to the operation that opened it; any other gets `not_yours`. Each use renews its lease (10 minutes). The janitor (every 15 s) closes expired tabs, a profile's browser 5 minutes after its last tab, and a private context 30 s after. A held tab (`holdTab`: a sign-in waits on it) never expires, and when its page or browser closes without Ensemble closing it, it opens again under the same id at the page it showed, without a window (at most three times in ten minutes; `tabState` says `moving` meanwhile, and `whenTab` waits for it). A window a page opens (a payment or sign-in popup) is a tab of the same operation with `openedBy` its opener: the tool whose action opened it says so (`opened` in its result, with its tab, title and site; a click, a key or typing waits 300 ms for one), and it shares its opener's lease: using either renews both, and neither expires while one of them is held. The broker's `tabClosed` event says why each tab closed (`agent`, `lease`, `release`, `shutdown`, `page`) |

#### Open and interact with a browser tab

Tools: `browser_open` (http and https only), `browser_tabs` (with the windows its pages opened: `popup`, `openedBy`), `browser_close`, `browser_login_needed` (hand the tab to the owner to sign in or to pass a human check, `purpose`, below), `browser_login_check` (check a waiting sign-in now, as when the owner says they did it), `browser_snapshot` (the accessibility tree with `[ref=…]` references, cut at 24,000 characters by default), `browser_click`, `browser_type`, `browser_press`, `browser_wait` (a selector, a text, a URL glob or a time), `browser_screenshot` (the viewport by default, one element, the full page when asked, another viewport size), `browser_console`, `browser_network_errors`, `browser_record` (a video, or a Playwright trace), `browser_upload` and `browser_download`.

`browser_open` and `browser_snapshot` say when the page is a human check or blocks automated browsing (a visible captcha frame of reCAPTCHA, hCaptcha, Cloudflare, DataDome, PerimeterX or Arkose; "Robot or human?", Cloudflare's "Just a moment…", Google's unusual traffic, Amazon's robot check and its 503, Akamai's Access Denied; `browser/human-check.ts`), with `humanCheck` in the result, so the work hands the tab to its owner or uses another source.

There is no script evaluation and no raw CDP, so no tool reads cookies or storage. An operation of work with the internet off (`loopbackOnly`) opens and loads only this computer's own addresses (localhost, 127.0.0.0/8, ::1); every other request of its tabs, and of capture's private tabs for it, is aborted.

Recordings a closing tab finishes (a close, the work's end, an expired lease) are kept, held as they were watched, for the work to take (`takeFinished`).

#### Read websites and shop with browser tools

**Web tools** (`browser/web.ts`, `browser/shop/`): one call each for what a small model would otherwise do in several. `browser_view`, `browser_fetch` and `browser_extract` with a `url` are judged like `browser_open` (public pages open without asking); `browser_shop` asks only for a shop named by an address on this computer's network.

##### View a website

Opens the page in a tab, closes banners, sets the place when given (Amazon's ZIP; the browser's geolocation), takes a screenshot (of what `focus` names, else the top of the page) and returns its text as Markdown (6,000 characters). A site that refuses the browser (an HTTP/2 or connection error, a short 403 or 429, "Access Denied", a page that stays empty) is read once more in a clean browser: `mode: "clean"`, read-only, no tab. A human check keeps its tab (`humanCheck: true`) for `browser_login_needed`

Request: `browser_view {url, focus?, fullPage?, location?, name?}`.

##### Capture a focused screenshot

Closes consent banners first. `focus` ("the stock chart", "price table", "search results") is found, scrolled into view below a fixed header and captured with a 16-pixel margin (`focusFound`, `focusOn`)

Request: `browser_screenshot {focus?}`.

##### Fetch a file

Downloads a file with the browser's cookies (`context.request`, at most 10 redirects): up to 100 MB, its type sniffed from its bytes. PDF, Markdown, text, CSV and JSON are kept as a report, images as images, videos as videos, anything else as a file. A web page is refused with a hint

Request: `browser_fetch {url, name?, tab?}`.

##### Save a browser download

Saves a download into the evidence folder: the one clicking `ref` starts, else the latest the tab started (waiting for one if needed). When the tab shows a PDF (Chromium's viewer) or another file instead of downloading it, that file is fetched as `browser_fetch` does

Request: `browser_download {tab, ref?, timeoutMs?}`.

##### Extract page text

The page's main content as Markdown (headings, lists, tables as Markdown tables, links without tracking parameters), its JSON-LD and microdata products (`Product`, `Offer`, `AggregateOffer`, `ItemList`) and the prices it shows (`browser/extract.ts` on `browser/html.ts`, a small HTML reader with CSS selectors)

Request: `browser_extract {tab? \| url?, focus?, maxChars? = 12,000}`.

##### Set the browser location

Resolves "Wisconsin", "Madison, WI", "53703", "US", "India" (`browser/location.ts`: a state is its capital's ZIP, about 45 cities their own, a ZIP its state, two letters a US state first, countries by name), sets the browser's geolocation, and on Amazon its "Deliver to" ZIP (its dialog, else the endpoint the dialog calls; read back from the header), on Best Buy its US site

Request: `browser_set_location {location, site?, tab?}`.

##### Compare products across stores

Searches each store (default Amazon, Walmart, Target, Best Buy, Costco; recipes also for Newegg, eBay, GameStop, B&H; any other shop by its domain or an address with `{query}`), three at once, each in its own tab: cleaned, the place set where the store takes one (Amazon's "Deliver to" ZIP; Target's `GuestLocation` cookie, so it ships to the ZIP asked; a US place is always set: New York 10001 when none is given), offers read (the recipe's cards, else JSON-LD, else prices beside product links), ranked by the words searched (accessories, refurbished and sponsored results after), and the place each store's page shows ("Deliver to Madison 53703", "Ship to 53703"), with a note where it could not be set (Walmart keeps its own).

One screenshot each, from the first product down once the grid's pictures have loaded; none of a human check, and none of a grid that never filled in.

Status per store: `ok`, `human_check` (its tab kept for the owner's card; a check that appears after the page, such as a press-and-hold once the search is refused, counts too), `blocked` (the page, or its search service, refused the browser and a clean browser got no further), `no_results` (with 3,000 characters of its text) or `error`. At most 150 seconds

Request: `browser_shop {query, stores?, location?, max? = 3}`.

##### Read interactive controls

Only controls with their refs (links with where they go), headings, landmarks and short texts, at most 8,000 characters

Request: `browser_snapshot {mode: "interactive"}`.

#### Consent banners and page overlays

Page hygiene (`browser/hygiene.ts`) runs after `browser_open` (unless `clean: false`), in every web tool, and before a screenshot (consent only, so a dialog the work opened stays): the buttons of OneTrust, Cookiebot, TrustArc (also in its frame), Quantcast, Didomi, Usercentrics (its shadow DOM), Sourcepoint (its frame), Google's Funding Choices and a dozen more; Google's and Yahoo's consent pages; Amazon's "Deliver to …" toaster; then, in dialogs and fixed overlays, a button whose whole text is an accept word inside a consent banner or a close word ("No thanks", "×").

Never a button that buys, subscribes, signs up or in, downloads or asks for notifications or a location. At most 2.5 seconds; the answer says what it closed. Pages at this computer's own addresses are apps under test and are left as they are.

#### Read a page in a clean browser

The clean browser for read-only views (`browser/clean-view.ts`) is a `CleanBrowser` with its own profile beside each work profile, `<data>/browser/<profile>-clean` (agents cannot open profiles ending in `-clean` or `-signin`), kept warm three minutes after its last read.

It only navigates, takes a screenshot and reads the HTML through the DOM domain; its screenshot is evidence like any capture, held when its text shows a saved secret or the site is preview-first. Work with the internet off never uses it.

A computer reports `capabilities.browser: 2` for these tools; the server tells a node to update Ensemble on an older one.

#### Control what captures may show

What a capture never shows:

- Password, one-time-code and card fields, and elements marked `data-ensemble-sensitive`, are masked in screenshots, in every frame of the page (`SENSITIVE_SELECTOR`), and their values are hidden in snapshots, also when a placeholder puts the value on a line of its own.
- The owner's saved secret values (as written, and as escaped inside a quoted snapshot value) and key-shaped strings are hidden in snapshots, titles and console text. A screenshot, video or trace of a page that shows one comes back `held: true` with the reason: the owner previews it before it is sent.
- Page addresses and titles in tool results and the live view have secret query values (`?token=`, `code=` and the like), saved secrets and key shapes hidden.
- Sites the owner marks never captured are refused for screenshots, snapshots and the live view; a video that reaches one records none of its frames and is held. Sites marked preview-first are held. The two lists are this computer's own (`captureSites` in `remote.json`: `ensemble capture sites`, [26](26_CLI.md)); a site is a host, covering its subdomains, or an exact origin.
- `browser_type` refuses a saved secret value. Uploads take only regular files with one name from the operation's evidence folder or folders the caller allows, never credential files (`.env*`, keys, certificates) or files containing a saved secret, up to 50 MB; the file is read by descriptor and checked again after opening. Downloads go into the evidence folder, up to 100 MB.
- A trace records every page of its browser, so it starts only when every page there is this work's and none is in a sign-in. A trace of the shared profile has screenshots only, no page source or network data; a private tab's trace has both, and is held when a page shows a filled password, code or card field.

#### Privacy while signing in or taking control

**Sensitive tabs.** `markSensitive(tab, on)` is for a sign-in or a takeover, not for agents. While on, the tab refuses snapshots, screenshots, recordings, console and network reads and every action; `browser_wait` for a URL still works. A video drops its frames, a trace of its browser (whichever tab started it) is stopped and deleted, and console and network entries are not kept.

#### Watch a run’s browser activity

**Live view.** An operation's `onLiveFrame` receives a small JPEG of its most recently used tab about every 3 s (masked, quality lowered to keep it near 60 KB). It pauses, saying why, for a sensitive tab, a site the owner marked and a page that shows a secret. The broker keeps no frame.

For a run from the web, the remote loop sends each frame to `ROUTES.liveFrame` under the hosted job and its lease (`remote/live.ts`; protocol 7, at most about 220 KB); a run started here, and a node's own browsing, have no live view ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)).

#### Sign in or pass a human check

**Sign-ins** (design B11, [35 §8.16.1](35_ENSEMBLE_NODE.md#8161-signing-in); `logins/`).

After `browser_open`, a click, a key press or a submitted `browser_type`, the tool layer asks `checkForLogin` whether the page wants the owner's account (`logins/detect.ts`: one password field that is not a new-password form, a sign-in address with a user name or code field, a 401, or a known identity provider).

On another site in the shared profile it raises a sign-in at once; on this computer's own addresses, in a private tab, or for a site already answered for this work it only adds a hint.

`browser_login_needed {tab, origin?, purpose?, signedIn?, reason?}` raises one on purpose: `purpose` is `sign_in` (default) or `human_check`, and a page that shows a human check (`browser/human-check.ts`) with no sign-in form on it is raised as `human_check` whatever was asked. A raised sign-in (`logins/requests.ts`) marks the tab sensitive, holds it (two hours at most; above: a crash or a closed window opens it again rather than ending the sign-in, and only a tab that is gone ends it), brings a window already on the screen to the front, and puts `login` (with its `purpose`) in the tool's result: a node's answer carries it (`NodeCaptureAnswer.login`) and the server raises the card; a run's call waits in `awaitRunLogin` (`logins/run.ts`) after telling the server (`ROUTES.runLogin`, protocol 8), or asking on Needs me when no card is raised (withdrawn when the sign-in is seen done).

#### How a sign-in is checked

**Seen done.** While a sign-in waits, its page is looked at every 2 s and after each load (`logins/watch.ts`): the node's tab, or the clean browser while the owner uses one. A sign-in counts as done only by a change: the page asked first (a sign-in form, a code, an identity provider, another site, a challenge), and now it is the site (its origin or another address of the same site) with no password or code field, not a step of signing in (`/forgot`, `/verify`, consent, account choice, sign-out) and not a human check, loaded, with the site's sign-in state changed meanwhile (a cookie that is not analytics, consent or bot management, or a sign-in key in its local storage). A declared `signedIn` condition replaces the page rules and needs no storage change. A human check counts as passed when its challenge is gone and the page has loaded, seen twice in a row (in the node's tab, after the challenge was seen there).

Done, the sign-in ends `signed_in` or `passed`, the tab is given back, and the computer tells the server at `ROUTES.loginState` (`via`: `computer`, `window`, `takeover` or `check`). `browser_login_check {tab}` and `login.resolve` `check` run the same check at once without the history (a human-check page is never signed in): `{status: "signed_in" | "passed" | "waiting", message}`.

#### Sign in in a clean browser

**The clean browser** (`logins/clean-signin.ts`, `browser/clean.ts`).

Signing in from the web (a takeover) and in a window on this computer happen in a Chromium Ensemble drives only with real input and the screen (`Input.*`, `Page.startScreencast`) and reads only through the browser's protocol (a DOM snapshot, `Storage.getCookies`, `DOMStorage`), never a page script, so Google lets the owner sign in and Cloudflare's checkbox works there.

It is the full Chromium the broker uses (never the headless shell), with the profile's user agent, language and time zone and the broker's extra switches, in the profile's own folder `<data>/browser/<profile>-signin` (kept, so the owner stays signed in to identity providers there; a private tab gets a folder for the session only).

It opens at the node tab's page, with the tab's cookies for the site (not an identity provider's), follows the windows a page opens (the newest is shown and takes input; when it closes, its opener again), and is watched as above.

Done: its cookies for the site and for every host its pages went to (the identity providers), session ones too, move into the tab's browser (`context.addCookies`), with the site's local storage (a command's sign-in, `source: "cli"`, ends there: the command got its answer on this computer); the tab opens where the clean browser ended (or reloads) and must then pass the check itself, else the sign-in keeps waiting with why (a human check ends `passed`, saying when the site still shows its check to the tab). A clean browser without a window waits 10 minutes for the next sign-in, then closes; a window closes when its sign-in is over. A warm one does not keep the runtime's process alive.

#### Ways to answer a sign-in card

The owner's answer comes as `login.resolve` (`logins/answer.ts`):

| Action | On this computer |
| --- | --- |
| `saved` | Fills the login saved for the site (`logins/store.ts`): user name, password, then a code from a saved seed (RFC 6238), one step at a time, pressing Enter (`logins/fill.ts`). Refused for a human check |
| `local` | Opens the clean browser in a window on this computer's screen at the tab's page (`shown`); a clean browser without a window for the profile restarts with one, carrying its session cookies, unless a sign-in from the web uses it (`busy`). Where it cannot start, the profile's own browser comes to the screen (`showTab`, which restarts it with a window, reopening its tabs). Without a screen, `no_window` |
| `done`, `check` | Checks now: the clean browser's page when one is open (done, its session moves into the tab), else the tab |
| `typed` | Opens the box sealed for this computer (purpose `login`, the card as decision, the sign-in's id as name, a trusted site, unexpired, taken once), checks the site inside is the sign-in's, fills it; signed in only when the page moved on (another address, or fewer sign-in fields) and passes the check. When the site then asks for a one-time code, `needs_code` with what it asks ("Enter the 6-digit code from your authenticator app."); when it waits for an approval on the owner's phone, `waiting` with the number to tap when the page shows one. With `save`, keeps it as a saved login once signed in. Refused for a human check |
| `code` | The code the site asks for, in a box sealed the same way (`{origin, code}`): filled into the code field, then checked; a code the site does not take is `needs_code` again |
| `decline`, `expire` | Ends it |

The signed-in check is the work's condition (`urlPattern`, a glob matched without the query, or `selector`), else: on the site, with no password or code field, and no user name field on a sign-in address, and not a human check. Signed in or passed, the tab is unmarked and given back; ended any other way, it is first navigated to `about:blank`.

The answer (`LoginResolution`) is only a status and a sentence; a server that does not send `v: 2` hears `signed_in` for `passed` and `failed` for `needs_code`. The work's end (`releaseOperation`) and a stopped remote connection end its sign-ins (the second closes the clean browsers too).

#### Take control of the browser

**Taking over** (design B21, [35 §8.16.2](35_ENSEMBLE_NODE.md#8162-taking-over-the-browser); `takeover/`). `takeover.start` brings the channel's secret sealed for this computer: opened and checked like a secret box (this computer and key, the takeover as decision, the tab as name, a trusted site, unexpired) and taken once.

The tab must be the waiting sign-in's, or the run's (its hosted job mapped to the local job that owns the tab); one that is opening again is waited for up to 20 s.

The computer derives one AES-256-GCM key per direction (HKDF-SHA-256; `takeover/channel.ts`, the same messages and fixed vectors as the browser's `@ensemble/shared-types` takeover.ts) and marks the tab sensitive. A sign-in's takeover opens the clean browser (above) and streams its page shown (`mode: "clean"`); a run's, or a sign-in's when the clean browser cannot start (no Chromium with a window, a launch failure, or `ENSEMBLE_CLEAN_SIGNIN=off`), streams the tab itself (`mode: "tab"`, with a `note` saying why).

Both use Chromium's screencast (`Page.startScreencast`, JPEG at up to 1280 pixels). Each frame goes, encrypted with the next number, to `ROUTES.takeoverFrame`, one at a time, a newer one replacing any that waits; its header is `{t: "frame", w, h, url, site, title, popup, mode}` (`url` without its query; `popup`: a window the page opened).

`takeover.input` is applied in order: in the clean browser at once, a message's commands sent together and then waited for (`CleanSignIn.inputs`), through `Input.dispatchMouseEvent` (with the buttons held and a click count), the wheel, keys as a keyboard sends them (`takeover/keys.ts`: a printable key or Enter is a `keyDown` with its text, Enter's being `\r`; Tab, Backspace, Delete, Escape, the arrows, Home, End, Page Up and Down without; Shift, Control, Alt and Meta held as modifiers; a character no US key makes, and text from the page's box or Paste, inserted with `Input.insertText`); in the tab through Playwright's mouse and keyboard. A message numbered at or below the last, or one that does not open, is refused and counted.

It ends on `takeover.end` (I'm done runs the sign-in's check), the sign-in seen done (reason `signed_in` or `passed`, after its session moved into the tab), its time (`endsAt`, at most `ENSEMBLE_TAKEOVER_SECONDS`, 15 minutes; `takeover.extend` moves it later, never past an hour after the start), a minute without input or ping, the tab closing, the clean browser closing (`closed`, or `not_carried` when the site did not take the session in the tab), or `stopRemoteWork`; ending it itself, the computer says so at `ROUTES.takeoverState`. A tab it marked sensitive is given back; a sign-in's stays paused for its card, and its clean browser stays warm.

The computer reports `capabilities.takeover: 3`.

#### Save or forget a site login

**Saved logins.** `<data>/logins.json`, mode 0600: per site (an https origin, or this computer's own http address) the user name, password and an optional one-time-code seed, each encrypted with the runtime's local key (`lib/secrets.ts`), with when it was saved and last used. Kept apart from run secrets and never sent anywhere: the server hears only whether one is saved for the site of a card.

`ensemble browser logins`, `save-login`, `forget-login` ([26](26_CLI.md)) use the local `GET`, `PUT` and `DELETE /api/browser/logins` (refused on the web). The computer reports `capabilities.logins: 2`.

#### Keep browser profiles private

**Denied to runs.** `browserDeniedPaths()` returns `<data>/browser` and `<data>/capture`: the profiles' cookies (with their session cookies' file and the clean browsers' folders) and capture's lease file.

They are in Ensemble's own data, which the guard refuses and every OS sandbox backend denies wherever this runtime keeps it, the testing CLI's folder and `ENSEMBLE_DATA_HOME`'s included (`ensembleDataDenies`, [24 §3](24_DESKTOP_SANDBOXING.md#3-work-folder-and-outside-access)).

### 10.2 Capture service

| Target | Screenshot | Video |
| --- | --- | --- |
| `web` | A URL opened in a private tab (viewport, device, full page, element), or one of the operation's tabs | Real time or frame-stepped |
| `electron` | The app's window, from Playwright's Electron launch with the app's own `node_modules/electron` | Real time or frame-stepped |
| `gui` | Any program started by `capture_app_start` on a private virtual display, grabbed with `ffmpeg -f x11grab` | Real time |
| `terminal` | A transcript (with its colours) as HTML, or rendered to PNG by Chromium; a node's terminal screen (§4.10) the same way (`htmlScreenshot`) | None |
| `desktop` | On Linux, the owner's real screen at full size through desktop control (§11, `desktop/control/capture.ts`), held for their preview | On Linux, the same, in real time |

#### Capture an app on a private display

**Virtual displays** (Linux). Each app gets an Xvfb server that picks a free display (`-displayfd`), takes no TCP connections and accepts only its own cookie, kept in a private folder in `$XDG_RUNTIME_DIR` (else the temporary folder) so that an app in the OS sandbox can still read it; plus the first window manager installed (openbox, matchbox, fluxbox, icewm, jwm, xfwm4, metacity, twm).

The app's environment has that display and no Wayland socket or session bus, so it never opens on the owner's screen.

#### Access limits for captured apps

**Apps run in the OS sandbox.** An app started for capture runs its own code, so it starts through the runtime's `wrapCommand` (`configureCapture`; `captureAppWrapper` in `capture/sandbox.ts`), which confines it as `prepareSpawn` does for agent commands ([24](24_DESKTOP_SANDBOXING.md)): its folder and the cache writable, the agent environment (no credential variables, the cache's home) plus the variables the call gave it, Ensemble's data, keys and the browser profiles denied.

On Linux the sandbox gives the app back what its private display needs and nothing more: that display's X socket, bound read-only at `/tmp/.X11-unix/X<n>` under the sandbox's own `/tmp` (`sockets` in `SandboxPolicy`, bubblewrap; Landlock shares `/tmp`), and its cookie's folder; another display, the owner's included, is out of reach.

The app's internet follows the work's setting; an Electron app keeps the computer's network, because Playwright drives it over a local debugging port, and runs without Chromium's own sandbox, which cannot nest inside the OS sandbox. Electron goes through a small launcher script that does the same. The folder may not be the home folder, a system folder, or one that holds keys or Ensemble's data.

Without a wrapper, `capture_app_start` is refused unless the call says the owner allowed this work to run apps unsandboxed (`unsandboxedApps`). Its window is found by process id (its own or a child's) through xdotool, wmctrl or xwininfo with xprop; else by title; else as the only window; else the whole display is used.

#### Choose how to record video

**Frame-stepped video** freezes the page's time and moves it one frame at a time: Playwright's clock for timers, animation frames, `Date` and `performance.now()`; the Web Animations API for CSS animations and transitions (those running when recording starts are seeked from their beginning); and `window.__ensembleSeek(ms)` for code with its own clock.

Each frame is a masked screenshot, so frame n is at exactly n/fps seconds however busy the computer is. Real-time video takes the page's screencast and resamples it to a constant rate.

#### Video formats and duration

**Media.** MP4 (H.264) when a system ffmpeg has `libx264` or `libopenh264`; otherwise WebM (VP9 or VP8) with Playwright's own ffmpeg. `ENSEMBLE_FFMPEG` names an ffmpeg to try first; each one found is asked what it can encode (`capture/ffmpeg.ts`). Each video has a poster (`<name>.poster.jpg`, or `.png` for a desktop app) and a preview no wider than 320 pixels (`<name>.preview.jpg` or `.png`).

Videos stop at two minutes unless the caller raises the limit (`maxVideoMs`, the owner's setting). Size, length, frames and dimensions are read from the written file (`capture/probe.ts`). Files never overwrite each other.

#### Review captured app content

**Privacy.** Web and Electron captures are masked and scanned as in §10.1; a real-time video of an Electron window records no frames of a site the owner never wants captured. A desktop app's window cannot be checked for secrets here, so its captures are always held.

Transcripts and terminal screens are redacted before they are written (a line of a screen that shows a secret is drawn as plain text, the secret replaced), so they are not held.

#### When captured apps stop

**Leases.** Displays, window managers, apps and recordings are process groups under leases (`capture/leases.ts`, recorded in `<data>/capture/leases.json`), and each process carries its lease's id in `ENSEMBLE_CAPTURE_LEASE`. An app's lease runs 30 minutes from its last use. The janitor (every 10 s) ends leases that expired and leases whose process ended; an app's display goes with it.

When the runtime exits it kills them all. At start-up (`startCapture`, or the first capture) it stops what a runtime that is no longer running left behind. A group is signalled only while its leader is the process recorded (by start time), or, once the leader is gone, while a member still carries the lease's id (read from `/proc` on Linux), so a reused process id is never hit.

#### Check captured output

**Checks before sending** (`capture_check`, in the `Check` shape of `node/report.ts`):

| Kind | Passes when |
| --- | --- |
| `app` | The app still runs after `aliveSec` (3 s by default); a window is open, with the expected title; its output shows no crash |
| `image` | The image is not blank: no colour covers 99.5% of it, and its contrast is above 1.5 |
| `text` | The page or window shows every expected string, in its text or accessible names |

### 10.3 What a computer can capture

`captureCapabilities()` reports the browser and its revision, each ffmpeg and its encoders, the video format, the virtual display pieces, and for each target whether screenshots and video work, with the reason when not. On macOS it also reports the Screen Recording permission, which web pages and Electron apps do not need.

| | Web | Electron | Other apps | Real desktop |
| --- | --- | --- | --- | --- |
| Linux (X11, Wayland or no screen) | Yes | With Xvfb | With Xvfb and the system's ffmpeg | Through desktop control (§11), once the owner allowed it at the computer |
| macOS | Yes | Yes; the window shows on the screen | No | No |
| Windows | Yes | No | No | No |

`ensemble capture status` prints this. A paired computer reports a summary on every heartbeat (`capabilities.capture`: `browser` (a Chromium for Ensemble is installed), `video` (`mp4`, `webm` or null), `targets` (each with `screenshot`, `video` and `reason`; `terminal` also `tui`: full-screen programs are captured as their screen, which needs Chromium and a pseudo-terminal, so not on Windows) and `setup` (whether `ensemble capture setup` or one system command would add something)), with `capabilities.browser` 1: the web offers a node's browser and capture calls only to such a computer, and says to update Ensemble, or to run `ensemble capture setup`, otherwise.

`ensemble capture setup` installs Playwright's Chromium and ffmpeg into `<data>/playwright` with Playwright's own installer and prints the one command for system packages, for example `sudo apt install xvfb ffmpeg openbox xdotool`; it never runs sudo ([26](26_CLI.md)).

### 10.4 Live terminals and live views

A node keeps terminals open on this computer between its calls, and its owner watches them, and the node's own browser tabs, live from Node ([35 §8.17](35_ENSEMBLE_NODE.md#817-live-terminal-and-browser)). The computer reports `capabilities.live: 1` (`LIVE_API`) and `takeover: 3`.

#### Open a live terminal session

**Terminal sessions** (`device-tools/terminal-sessions.ts`).

`live {action: "terminal_open"}` is judged like `run` in its folder (§4.10; the node's own folder by default) and starts a shell, bash (`--noprofile --norc -i`, no history file, no history expansion, `EDITOR`, `VISUAL` and `FCEDIT` set to `false` and its prompt variables read-only, all before its first prompt) or else `sh -i`, in a pseudo-terminal (`script`, as `terminal` starts one) under the OS sandbox: its folder writable, the denials of §4.10, the internet as the node's run profile says, no credentials.

Without the OS sandbox or `script` (Windows) it is refused (409). Its output is replayed in a headless xterm with 1,000 lines of scrollback; output waiting to be drawn past 2 MB pauses the shell until the screen catches up.

The prompt carries OSC 133 marks (`133;B` where typing starts, and from bash's `PS0` `133;C` when a command starts), so the computer knows when the shell waits at its prompt and what the line typed there says.

| Action | What the computer does |
| --- | --- |
| `terminal_open {folder?, title?, columns, rows}` | A session `ts` + 12 hex digits, at most 3 open per node; answers once the first prompt shows |
| `terminal_send {session, text?, keys?, waitMs?}` | Types `text` (a new line is Enter; no other control character, 400) then each named key (`namedKey` in `device-tools/terminal.ts`: Enter, Tab, Escape, Backspace, arrows, Home, End, PageUp, PageDown, Delete, F1–F12, Ctrl+A…Ctrl+Z; arrows as the program asked for them). Ctrl+O, Ctrl+X, Ctrl+V and Alt keys are refused (400): they run or insert a line unjudged. Before each Enter (or Ctrl+J, Ctrl+M) the input is judged: the node's own record of what it typed since the prompt (a line continued with `\` or an open quote is one command) and, at the prompt, the input as the screen shows it (so a command recalled with Up, or typed by the owner, counts). Whether the cursor is at the prompt is read from the screen (the prompt's row), not from a mark a program could print. The hard floor's dangerous commands always; at the prompt also the programs no agent runs (`checkProgram`, `sudo` among them), those that need the internet where it is off, by name (a script run by its path is allowed, as `bash -c` would run it), `fc` and history expansion (`!!`, `^old^new`), which run earlier lines unjudged. A refused input is dropped (Ctrl+C at the prompt, Ctrl+E Ctrl+U in a program) and the answer is 403. After an Enter it answers when the prompt is back or after `waitMs` (3 s), else once the screen is quiet or after `waitMs` (1 s). While the owner controls the session from the web, 409 |
| `terminal_read {session, lines?}` | The screen, or its last `lines` with the scrollback |
| `terminal_close {session}` | Stops the shell and everything it started |
| `browser_tab {tab, liveId}` | Checks the tab is the node's operation's, and watches it: once it is gone (checked every 5 seconds, and at once when the broker closes it), its live card ends, with `closed_by_node` when the node closed it (`browser_close`) |

A session ends on `terminal_close`, its shell exiting (`exited`, with its exit code), 30 minutes with nobody typing or watching (`idle`, `LIVE_IDLE_MS`), 4 hours (`max`, `LIVE_MAX_MS`), or `stopRemoteWork` (`stopped`); the computer then posts `ROUTES.liveEnded`. Another node's session is not found (404); one that has ended answers `{ended: true}`.

The screen the node reads and the owner sees has saved secret values and key shapes hidden, line by line as `capture/screen.ts` hides them (`screenRows`, `bufferLines`). The computer's ledger keeps `node.tool.terminal_session` (open and close, with the folder and shell) and `node.tool.terminal_line` (each submitted line's program), never what was typed or shown.

#### Resize a live terminal

**Size.** The terminal starts at `columns` × `rows` (120 × 32 from the node). A small helper started with the shell reads a new size from a pipe in the cache (`<workspace>/.cache/live/<session>/size`) and sets it on the terminal (`stty … < /dev/tty`), which tells the program in front; the owner's screen size (`tty-size`) goes there, and the node's size comes back when nobody watches.

#### Watch or control a node’s terminal and browser

**Live views** (`takeover/terminal-view.ts`, `takeover/session.ts`). `takeover.start` with `kind: "terminal"` names the session as `tab` and the node's `operation`; the start box is checked and taken once as for any takeover (§10.1), with the session's id as its name.

Each frame is the whole screen, sent when it changed, at most 10 a second (`TERMINAL_FPS`; changes in between go in the next), up to two on their way at once: `packMessage({t: "frame", kind: "terminal", cols, rows, cursor: {x, y}, title}, utf8 JSON {rows})`, each row as runs `{t, fg?, bg?, b?, i?, u?, dim?}` (colours as `#rrggbb`; a row with a secret drawn plain). A frame refused while the web is still starting the takeover is sent again.

Input is `{t: "tty", text}`, `{t: "tty-key", key}`, `{t: "tty-size", cols, rows}` and `{t: "ping"}` (a browser's `text` and `key` events are taken too), applied whether the owner watches or controls: it is their shell, and it is not judged. Control (`takeover.control {on}`) makes the node's `terminal_send` wait (409).

With `kind: "browser"` and `operation` the tab must be the node's; `view: "watch"` streams it as a takeover does while the node keeps it (not sensitive, input ignored but pings), and control marks it controlled and sensitive (the node is refused on it, as in a sign-in) and applies input; handing it back gives the tab back. A window the shown page opens (`page.on("popup")`, a tab of the same work in the broker) is shown instead, its frames saying `popup: true` with its title and site, and its opener again when it closes; under control it is paused for the node too. A tab's frames come from Chromium's screencast at a level `takeover/quality.ts` sets (watching 1024 pixels wide at JPEG quality 45, control 1280 at 55; a step smaller while frames take over 250 ms to send, a step better after five seconds of quick ones), at most two on their way at once, none like the last. A view ends as a takeover does (Stop, its time, a minute without input or ping, `stopRemoteWork`) or when its session or tab ends (`ended`, `tab_closed`, `closed_by_node` when the node closed the tab); the session or tab goes on after a view ends.

## 11. Desktop control on the computer

On Linux the local runtime works on two screens for Ensemble Node and coding runs (`apps/hub-api/src/desktop/control/`), each through its own helper process (`apps/hub-api/desktop-helper/linux/ensemble_desktop.py`): the **agent screen**, a private headless GNOME Shell of the agent's own that nobody sees unless they watch it, and the **owner's screen**, their real screen, keyboard and pointer. A node reaches them with `node.tool.request` and `tool: "desktop"` (`capabilities.desktop: 1`, `DESKTOP_API`; `device.ts`); a coding run through its MCP server (`run-tools.ts`, listed and answered by `evidence/capture-tools.ts`). [35 §8.16.5](35_ENSEMBLE_NODE.md#8165-your-screen) says what the owner sees.

Tools (`tool-specs.ts`): `desktop_status`, `desktop_apps`, `desktop_open`, `desktop_observe`, `desktop_act` (up to 20 steps: `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`, `press`, `set_text`, `select`, `toggle`, `focus`, `wait`, `open`), `desktop_zoom`, `desktop_record` (`start`, `save`, `discard`) and `desktop_handoff` (`ask`, `release`, `status`). `desktop_apps`, `desktop_open`, `desktop_observe`, `desktop_act` and `desktop_record` take `screen` (`agent` or `owner`); `desktop_act` takes `foreground`, `desktop_observe` takes `screenshot`.

### 11.1 Two screens and background mode

| Screen | What it is | For |
| --- | --- | --- |
| `agent` | A headless GNOME Shell started on the first call that needs it, private to the agent (§11.3). It ends `ENSEMBLE_AGENT_SCREEN_IDLE_MINUTES` (default 10) after its last call, with remote work (`stopRemoteWork`) and with the runtime; `ENSEMBLE_AGENT_SCREEN_SIZE` sets its size (default `1600x1000`) | Apps the agent opens itself: the default |
| `owner` | The owner's real screen through the desktop portal (§11.2), once they allowed it at the computer | An app or session already open there, or when the owner asks to watch |

`Desktops` (`screens.ts`) gives each screen its own `DesktopService` and helper. A call works on the screen it names, else the one its capture id or its recording belongs to, else where its controller last worked, else the agent screen. It never moves to the other screen by itself: an agent screen that cannot start answers why, with the fix (`unavailable`), and is tried again after 3 minutes. Every result names its screen; `desktop_act` also names its mode (`agent_screen`, `background`, `foreground`). `desktop_status` reports both screens without starting the agent screen; `desktop_handoff` is for the owner's screen only.

On the owner's screen `desktop_act` runs in the **background** unless `foreground` is true: only steps on an element id run, through AT-SPI, without moving the pointer, typing on the keyboard or changing the focus: `press`, a left `click`, `type` (inserted at the element's caret), `set_text`, `select` (in its container's selection, else its own action), `toggle`, and `scroll`, which brings the element into view. Any other step is `refused` with `needs_screen` ("Needs the screen: ask to use the owner's screen (foreground: true asks them once) or use the agent screen."), and nothing reaches the pointer or keyboard. A `press` on an element without an action is refused the same way: only moving the focus to it would do something. `foreground: true` asks the owner once per mission for their pointer and keyboard (`NodeToolAsk` target `screen:owner`, label "the pointer and keyboard"; a coding run asks its person); `desktop_open` on the owner's screen asks the same, since the app takes the front. Unattended work goes ahead.

`desktop_observe` with `screenshot: false` reads one app's elements without a picture: it needs no screen control and goes on while the owner has the computer. Its element ids may be aimed at; coordinates need a look with a screenshot (`observation_required`). After a batch, the fresh look is of the same kind as the one the batch aimed at, and of elements only while the owner has the computer.

### 11.2 The helper

| Part | What it does |
| --- | --- |
| Process | `python3 ensemble_desktop.py --state-dir <data>/desktop` for the owner's screen, and `--state-dir <data>/desktop/agent-screen --agent-screen 1600x1000` for the agent screen, started on first use by `HelperProcess` (`helper-process.ts`) with the desktop session's variables only (bus, display, language: `helperEnv`); it fills a missing one from the systemd user manager. The owner's helper ends 10 minutes after the last call. The agent screen's helper answers `hello` once its screen is up (at most 40 s) and has 15 s to end the screen when it stops. Both start again after a crash, at most 5 times in 10 minutes |
| Protocol | JSON-RPC 2.0, one JSON object per line on stdin and stdout, one request at a time (`desktop_helper/rpc.py`, `protocol.ts`, `HELPER_PROTOCOL` 1); `hello` answers the version and methods. Every request carries `deadline_ms`, 1.5 s less than the runtime waits; a request the runtime stops waiting for is ended with the helper (`SIGKILL`), never done later. Errors carry `data.kind` (`consent_needed`, `no_session`, `element_gone`, `unsupported_here` and others) and `data.ran` (`no`, `maybe`, `yes`). `cancel` notifications stop a request between its steps: the runtime sends one when the work the request is for ends (`DesktopService.release`, the service stopping); `event` notifications say the session started or closed, or a recording stopped |
| Screen and input | On the owner's screen, the desktop portal: `RemoteDesktop` with keyboard and pointer, `ScreenCast` of every monitor with the cursor in the picture, `persist_mode` 2. The app id `com.ensemblework.Ensemble` is registered through the `Registry` portal where there is one, with a `.desktop` file of that name written to `~/.local/share/applications` if missing (its program is `sh -c ensemble`: the portal takes an app id only when it finds the entry's program on its own PATH). The restore token is kept in `<data>/desktop/portal-restore-token` (mode 0600) and replaced at every start, so after the owner allowed it once, screen control starts without asking. Stopping it from the desktop's own screen-sharing indicator deletes the token: the next start asks again. Mutter's private remote desktop interfaces of the owner's session are not used. On the agent screen, Mutter's `ScreenCast` and `RemoteDesktop` of that screen's own compositor, on its private bus (`desktop_helper/mutter.py`): it is the agent's own, so nobody is asked. Pointer positions go to Mutter in the stream's frame pixels: logical pixels times the monitor's scale (`mapping.logical_to_stream`), kept inside the frame |
| Frames | Each monitor's PipeWire stream through GStreamer (`pipewiresrc` into an `appsink` that keeps the latest frame). A look waits until two frames match or 1.5 s pass and is a JPEG at most 1568 pixels on its long side |
| Accessibility | AT-SPI: applications and windows, one window's elements with ids (`e1`, `e2`: role, name, states, actions, box inside the window; a password field's text is never read), an element's action, focus, selection (`Selection`), scrolling into view (`Component.scroll_to`) and text (`EditableText`: set whole, or inserted at the caret). The address of the page each browser window shows: `DocURL` (Firefox) or `URI` (Chromium browsers, GNOME Web); a browser window whose page or address cannot be read is reported without one (§11.6) |
| Apps | Installed apps from their `.desktop` files. An app opens with `gio launch` in a systemd scope of its own (`systemd-run --user --scope`), so it outlives the owner's helper; the answer says how far it got (`accepted`, `process`, `window`, `inspectable`, `focused`) |
| Typing | Key symbols through the portal (Mutter's `RemoteDesktop` on the agent screen), 8 characters at a time; characters the keyboard layout cannot type go in through AT-SPI at the caret, else, on the owner's screen, the portal's clipboard and Ctrl+V, after which the clipboard's earlier text is offered again (other content, such as an image, is not). Between chunks the helper checks the window in front, and on the owner's screen pauses 120 ms and reads the idle time: input since its last key, or another window in front, stops the typing (`stopped`: `owner_input`, `focus_moved`), and the step is `partial`; owner input also gives them the takeover lease. A saved secret (`secret`) never goes through the clipboard or insertion at the caret: typed by keys, or set whole into the focused password field through AT-SPI when the layout cannot type it, or not at all (`secret_untypeable`) |
| Recording | The same frames into a second GStreamer pipeline: H.264 in MP4 where an encoder works (`vah264lpenc`, `vah264enc`, `openh264enc`, `x264enc`), else VP8 in WebM; finished with an end of stream, then decoded whole for its real duration, a poster frame and a 320-pixel preview |
| Readiness | `status` proves each fact with a probe: the session type, portal versions, consent, capture, input, accessibility, the encoder, the screen lock and idle time (GNOME's `ScreenSaver` and `IdleMonitor`, read only); on the agent screen it says no consent is needed. `--check` prints the libraries' state and whether the agent screen can start (`agent_screen`) as one line of JSON without a session |

### 11.3 The agent screen

`desktop_helper/agent_screen.py` starts it and keeps it apart from the owner's session; each point is what keeps the owner's session untouched:

| Part | How |
| --- | --- |
| Compositor | `gnome-shell --headless --wayland --no-x11 --wayland-display ensemble-agent-<8 hex> --virtual-monitor 1600x1000 --mode=ensemble-agent`: no display (KMS) and no input device, only a render node. Its runtime folder is `$XDG_RUNTIME_DIR/ensemble-agent-<8 hex>` (mode 0700), holding its Wayland socket, session bus and AT-SPI bus, so none of the owner's sockets of those names is ever replaced. Its log is `<data>/desktop/agent-screen/shell.log` |
| Session bus | A `dbus-daemon` of its own whose only services are settings (dconf), the permission store, and apps that start by D-Bus: never the owner's keyring, file systems, document portal, indexer or calendar. Its own AT-SPI bus (`at-spi-bus-launcher`). Settings, data, cache and state live in `<data>/desktop/agent-screen/`, with no lock, no blanking, no welcome tour and no animations |
| Shell mode | The session mode `ensemble-agent` (`<data>/desktop/agent-screen/shell/gnome-shell/modes/ensemble-agent.json`, read through `XDG_DATA_DIRS`): no system menu (power, network, Bluetooth, location), overview, search, run dialog or settings, and none of the shell's polkit, network, keyring or mount agents, which act for the owner's session on the system bus (GeoClue keeps one location agent per user, which a second shell would take). `org.gnome.desktop.lockdown disable-lock-screen` keeps the screen from locking when the owner's session does. The panel shows the clock, the screen's own screencast indicator and input sources |
| Apps | Started in `app-ensemble-agent-<app id>-<8 hex>` scopes with the screen's runtime folder, bus and display, and private settings folders; the owner's installed apps and home folder are the same. They get a system bus of their own with no service on it (a second `dbus-daemon`, `DBUS_SYSTEM_BUS_ADDRESS`) and, first on their `PATH`, a `pkexec` that refuses: polkit counts every process of this user outside a login session as the owner's session, so a request to mount, install, locate or power off would otherwise ask the owner on their own screen, or be allowed without asking. When the screen stops, those scopes are stopped and the apps its bus started are ended first, so they exit on a signal rather than by losing their display. No sound (`PULSE_SERVER` leads nowhere) and no X11 apps (no Xwayland) |
| Shared | The user's PipeWire (`PIPEWIRE_RUNTIME_DIR`), which carries the frames, and the computer's system bus for the compositor itself |
| Leftovers | A helper that died leaves its folder and processes: the next start ends the processes it recorded (checked by their start time, so a reused process id is left alone) and removes the folder |

`DesktopService.liveFrame` and `liveFrames` give a live view small JPEG frames of either screen (at most 1024 pixels on the long side by default, quality 60, at most 10 a second), kept nowhere and with no capture id.

### 11.4 One controller, and the owner first

`DesktopService` (`service.ts`, one per screen: `index.ts`) runs one call at a time. One controller drives a screen: a node's mission (`node:<nodeId>:<mission>`) or a run (`run:<jobId>`); another gets `busy` with its place in line. A claim lapses 90 s after its last call, not while its recording runs or, once the recording has stopped unsaved, for 10 minutes (`RECORDING_SAVE_MS`): then the recording is dropped and the claim lapses. Releasing a controller (a run ending) cancels its call that is going on. `desktop_status` and `desktop_apps` need no claim. Screen control of the owner's screen ends 5 minutes after the last call (not while recording), with remote work (`stopRemoteWork`) and with the runtime.

Everything else in this section is about the owner's screen: on the agent screen there is no lease, idle time, lock or consent.

The owner takes the computer over by using it: input at the computer while the agent drives it (Mutter's idle time shorter than the time since the agent's own last input) gives them the **takeover lease** (`lease.ts`). The agent's input and screenshots are then refused (`owner_has_control`) until two minutes pass without input there, or `desktop_handoff release` after 15 quiet seconds. Each change of the lease bumps its counter: a look or a batch of steps it overlapped is discarded, and earlier looks are stale. `desktop_handoff ask` gives the lease to the owner itself, with a notice on the screen, and waits for them; with reason `consent` it starts screen control, so the portal's dialog shows meanwhile, and answers at once when screen control is on already. A locked screen refuses everything (`screen_locked`).

Background steps and looks at elements only go on while the owner holds the lease or types in another app: they never touch the owner's input. In the app whose window is in front while the owner used the computer in the last two minutes, they wait for the owner to switch away or stop, at most 15 s (`ownerWaitMs`), and otherwise do not run (`owner_using_app`). Foreground input also waits while the owner used the keyboard or pointer in the last 5 s (`owner_has_control`).

### 11.5 Looking and acting

Every screenshot gets a capture id (`cap_` and 12 hex digits) bound to its controller, its screen's logical geometry, the portal session and its time (`ledger.ts`). Coordinates are taken only on the controller's latest look or a zoom of it, on a screen that is still the same; others are refused (`stale_capture`). A failed look leaves an observation debt: only `wait` and `open` run until a look works. Input that ran makes the look before it stale. A point maps from the image to the centre of the screen pixel it shows, in the screen's logical pixels, clamped inside that screen (`mapping.ts`). An element id aims at the element itself through AT-SPI.

| Verdict | Meaning |
| --- | --- |
| `confirmed` | Its effect was seen: AT-SPI says so (the field holds the text, the element has the focus, its states changed), or the screen changed and settled |
| `partial` | Part of it happened: characters the layout could not type, typing stopped by the owner's input or another window in front, a field holding other text, an app started without a window |
| `no_effect` | It ran, and the screen, settled before and after, did not change |
| `refused` | The floor, a stale look, the owner's lease, the screen lock or the background (`needs_screen`) stopped it; it did not run |
| `not_run` | An earlier step stopped the batch, or the owner must answer first |
| `unknown` | It was sent and its effect was not seen (the screen kept changing, or there was no screenshot to compare), or the helper did not answer in time (`ran: maybe`) |

Each step also says whether it ran (`no`, `maybe`, `yes`). A batch stops at the first step that is not `confirmed`, or `unknown` after it ran, and answers with a fresh look.

The model's screenshots are kept in `<data>/desktop/captures` (the latest 40, mode 0600) and are not evidence. A node on Ensemble's API gets each one in the call's answer (`inlineImage`, `NodeDesktopAnswer.image`) as a picture with the tool's result. An agent on its owner's subscription, and a coding run, get a `[desktop screenshot cap_…]` line, which the computer that took it turns into an `ensemble-image:` line (`images.ts`, on `/api/engine/assistant/tool` and `/api/engine/tool`) that `scripts/ensemble-ask-mcp.mjs` gives the agent as an image.

### 11.6 The hard floor and sensitive apps

Refused whatever the mode or any answer (`floor.ts`):

- Clicking, typing or pressing in Ensemble's own windows (`com.ensemblework.*`, its app names and window titles), on an Ensemble page in a browser (`ensembleAppOrigin`), and typing in a terminal that shows the `ensemble` command line. Wayland tells no app where other windows are, so a click or drag by position is refused while an Ensemble window or page shows on the screen at all; element actions stay exact.
- The same for a browser window whose page or address cannot be read (`unknown_page`): it may be showing Ensemble. Clicks by position are refused while one shows, and typing and element actions in it.
- Typing into the desktop's own password prompts (polkit, keyrings).
- Typing text that holds a saved secret's value or a key's shape, and typing text into a password field. A saved secret goes by reference, `$NAME`, only into a password field: one saved without destinations into any, one limited to websites only on their pages (`secrets.ts`). Its value never comes back.

A refusal is in the computer's ledger (`node.tool.refused` with its rule). Password managers, system settings, terminals, and banking or wallet apps (`sensitive.ts`) are asked about, never refused, on either screen: apps on the agent screen run as the owner, with their files. A click, drag or scroll by position asks about every sensitive app with a window showing, not only the one in front, since the desktop does not say which window the point is in. For a node the call answers 428 with `NodeToolAsk` `{capability: "desktop", scope: "app", target: <app id>}`; the owner's card offers **This mission**, one answer per app and mission, kept as an `app` rule (`device-tools/policy.ts`). Unattended, they are allowed. A coding run asks its person once per app (`allowOrRefuse`, `desktop_app`); a read-only run only looks.

### 11.7 Recordings and evidence

`desktop_record start` records one monitor of a screen into the work's evidence folder under a hidden name; `save` stops it, decodes it, writes its poster and preview, links it to a new name (never over another file) and hashes it. One recording runs at a time on each screen, for 120 s unless `maxSec` says otherwise (at most 600). A recording that stopped by itself and is not saved within 10 minutes is dropped, and one the helper lost (it stopped) is deleted at once: no hidden `.desktop-recording-*.part` file stays in an evidence folder, and the first use of desktop control in a runtime removes ones a stopped runtime left. A saved recording, and `capture_screenshot` and `capture_video` with `target: "desktop"` (`capture.ts`), become evidence held for the owner's preview (§4.11).

### 11.8 Readiness and requirements

A Linux computer reports `capabilities.desktop: 1` and `capabilities.desktopReadiness` (`ready`, `session`, `consent` `remembered` or `ask`, `recorder`, `reason` for the owner's screen, and `agentScreen` with `ready`, `version` and `reason`) on its heartbeat (`readiness.ts`); the capture summary's `desktop` target says the same for the owner's screen. The server offers desktop calls only to such a computer and, except `desktop_status`, only when one of its screens is ready.

Both screens need Python 3 with GObject bindings, AT-SPI and GStreamer's PipeWire source: on Ubuntu or Debian `python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good` ([26](26_CLI.md)). The owner's screen needs a desktop session with `xdg-desktop-portal` (RemoteDesktop and ScreenCast). The agent screen needs the user's PipeWire running, `dbus-daemon`, `at-spi-bus-launcher` and a GNOME Shell whose help lists `--headless`, `--virtual-monitor` and `--wayland-display`.

## In the code

### 4.1 Account and device routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/devices/pair`, `/api/devices/register` | Issue / redeem a pairing code |
| GET | `/api/devices/self` | The paired computer's own id and the account it belongs to (device token) |
| GET | `/api/devices` | The person's computers and capabilities |
| PATCH / DELETE | `/api/devices/:id` | Rename / revoke an owned computer |
| POST, GET | `/api/devices/:id/code`, `/api/devices/:id/terminal`, `/api/devices/:id/terminal/output` | Browser Code and terminal relay (§4.7) |
| DELETE | `/api/devices/self` | Device-initiated removal |
| POST | `/api/devices/self/heartbeat`, `/api/devices/self/claim` | Refresh state and leases; claim eligible work |
| GET | `/api/devices/self/jobs/:id/attachments/:fileId` | Download an attached original (§4.5) |
| POST | `/api/devices/self/jobs/:id/progress`, `/ask`, `/files`, `/evidence`, `/complete` | Report, ask a saved question, send changed-file text (§4.6) and the files the worker attached (§4.11), settle with the worker's report. Progress may carry `observed` (what the agent says it runs with: `model`, `effort`, `context`, `contextTokens`, `fast`) when it changes, and complete `totals.observed` ([30 §3.4](30_ENGINES.md#34-what-the-agent-says-it-runs-with)) |
| POST | `/api/devices/self/jobs/:id/reattach`, `/resume` | After an outage: take back a run that kept going, or carry on one lost to a restart (§3) |
| GET / POST | `/api/devices/self/decisions/:id`, `/api/devices/self/decisions/:id/close` | Read an answer / close a decision answered locally, or withdraw it (`expired`) when the agent stopped waiting |
| POST | `/api/devices/self/file-requests/:id`, `/code-requests/:id`, `/terminal-runs/:runId/output`, `/tool-runs/:runId/output` | The computer's answers to relayed requests, and the longer output of a node's command (§4.10); 409 for an answer from another runtime than the one that claimed the request (§2) |
| POST | `/api/devices/self/code-requests/:id/claim` | A runtime takes a relayed request that changes something on the computer before it acts on it; 409 when another runtime of that computer took it, 410 when nobody waits (§2) |
| POST | `/api/devices/self/evidence-uploads/:uploadId` | A file the web asked for by an upload id: a node's capture, or a held file released or previewed (§4.11) |
| GET | `/api/devices/self/node-files/:downloadId` | A file of the owner's Ensemble Files a node puts on this computer (files `save`, §4.10), once, by the download id the web gave that call (410 for another computer or a second fetch) |
| POST | `/api/devices/self/node-file-changes` | Original-file references collected by a node's tools and commands; authenticated device and owned turn, one private card updated per turn/computer ([35 §8.18](35_ENSEMBLE_NODE.md#818-original-files-in-the-node-workspace)) |
| POST | `/api/devices/self/jobs/:id/live` | The latest small picture of a run's browser tab, under its lease (§10.1) |
| POST | `/api/devices/self/nodes/device-codes`, `/api/devices/self/nodes/logins` | A sign-in code a node's command printed (`NodeDeviceCodePost`, again with `status` when it ended), or a sign-in page it opened (`NodeCliLoginPost`): the server finds the command's conversation by its run id (`operation`) and posts the owner's card; 404 when no such command of that node runs on this computer (`capabilities.cliLogins`, §4.10) |
| POST | `/api/devices/self/takeovers/:id/frames`, `/api/devices/self/takeovers/:id/state` | A takeover's encrypted frames (the server keeps only the latest, for 30 s; 410: nobody controls it any more), and that this computer ended it itself, with why (`signed_in` and `passed` when the sign-in in it was seen done; protocol 8, §10.1) |
| POST | `/api/devices/self/live/:liveId/ended` | A node's terminal session or watched tab ended on this computer (`LiveEndedPost {reason, exitCode?}`): its live card ends (`capabilities.live`, §10.4) |
| POST | `/api/devices/self/jobs/:id/logins` | A run's agent waits for its owner to sign in, under its lease: the server raises the card where the run is followed and answers its id, or `null` (protocol 8, §10.1) |
| POST | `/api/devices/self/logins/:loginId/state` | A sign-in the computer saw end by itself (`logins` 2: signed in, a human check passed, its work gone, its time out, or a problem while it waits): that computer's card follows, and its node is woken unless its own `browser_login_check` already told it ([35 §8.16.1](35_ENSEMBLE_NODE.md#8161-signing-in)) |
| POST | `/api/devices/self/logins/:loginId/state` | A sign-in changed on this computer by itself (`LoginStatePost {status, message?, via?}`: seen done, its tab or work gone, its time run out, or a problem the card should show): the server updates its card (`logins: 2`, §10.1; a 404 is ignored) |
| GET | `/api/devices/self/model-keys` | The account's model keys (§4.2) |
| GET / POST | `/api/devices/self/included`, `/api/devices/self/included/turn` | Included models (§4.9) |
| GET / POST | `/api/devices/self/assistant-turns/:id` and `/files/:fileId`, `/tool`, `/ask`, `/stream`, `/done` | Assistant turns on a subscription and the files on their message (§4.9); `/ask` asks a node's owner about one of the agent's own calls; 409 for a runtime other than the one that read the turn first |
| POST | `/api/devices/self/activity` | This computer's part of its owner's AI activity log (`ActivityPost`, at most 200 entries: its agents' tool calls, agent tasks' prompts and answers, errors and warning or error log lines), stored on the account it is paired with; a run named by its web id is kept only when it is that account's ([07 §1.4](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#14-the-ai-activity-log)) |
| GET | `/api/devices/self/events` | Wake-up stream; a newer runtime's stream ends an older one's with `device.replaced` (§2) |

`scope=device` is not an account token; device routes have their own allowlist and authentication. Pairing does not allow minting other tokens.



### 4.3 Local routes

`GET /api/remote`, `POST /api/remote/pair`, `/unpair`, `/folders`, and `DELETE /api/remote/folders/:label` manage the runtime locally. A hosted job cannot set Code folders, trust or web-control settings. [26](26_CLI.md) lists the CLI commands.



### 4.8 Protocol and compatibility

`remote/contract.ts` and the computer's receiver define the supported operations; each job records its protocol (changed-file text needs protocol 3, Code and terminal relays protocol 4, secret scopes, the worker's report, evidence and node tools protocol 6, held captures, a video's poster and preview, a node's browser and capture tools, `evidence.request` and the live view protocol 7, sign-ins (`login` in a browser answer, `login.resolve`, `ROUTES.runLogin`, and with `logins: 2` `ROUTES.loginState`) and takeovers (`takeover.*`, `ROUTES.takeoverFrame`, `ROUTES.takeoverState`) protocol 8).

An optional field an older server does not know is left out by it, so it needs no new protocol: `observed` on progress and complete is one (2 November 2026), a claim's `mission` another (§4.12), a claim's `project` (the brief of the task's Ensemble project for a run by the person's own agent, which the computer keeps in the project's folder: [41 §2](41_AGENT_SESSIONS.md#2-one-folder-per-project)) a third, and `related`, `sessionChoice` and `newSession` (what the computer chooses the run's agent session with: [41 §4](41_AGENT_SESSIONS.md#4-choosing-a-session)) more.

Until a computer runs a release that sends it, its runs show their observed settings as "not reported", except the agent's model from its `engine` event.

The server and UI check advertised capabilities and name the update an outdated computer needs: the coding agents a runtime can run are in `capabilities.engines` (`deviceEngines` in `devices/labels.ts`; a runtime without the list has Claude Code, Codex and Cursor's agent), so GitHub Copilot is refused for an older one. Existing jobs keep their own protocol and evidence.



### 10.5 Tests and limits

`src/logins/logins.test.ts` and `src/node/logins.integration.test.ts` cover sign-ins and saved logins, `src/logins/signin.integration.test.ts` sign-ins seen done, human checks, the clean browser (a popup followed, its session moved into the node's tab, a window on the computer) and one-time codes, `src/takeover/takeover.test.ts` and `src/node/takeover.integration.test.ts` taking over, `src/device-tools/terminal-sessions.test.ts` and `src/node/live.integration.test.ts` live terminals and live views, `src/browser/clean.test.ts` the clean browser ([35 §11](35_ENSEMBLE_NODE.md#11-verification)).

`src/browser/broker.integration.test.ts` and `src/capture/capture.integration.test.ts` drive a headless Chromium against a local server, including a one-second CSS animation recorded at 30 fps and checked frame by frame in the encoded video; `src/browser/browser.test.ts`, `src/capture/capture.test.ts` and `src/capture/leases.test.ts` cover the rest without a browser; `src/capture/runtime.test.ts` the owner's privacy rules as the runtime gives them, and `src/capture/sandbox.test.ts` an app in bubblewrap reaching its own display's socket and cookie and not another display, Ensemble's data or a credential variable.

The web tools: `src/browser/web-tools.test.ts` without a browser (the HTML reader, Markdown, products and prices, links, places, focus scoring, the interactive snapshot, every store recipe on its markup, ranking) and `src/browser/web-tools.integration.test.ts` with one (hygiene, focused screenshots, `browser_view` with a place, a clean-browser read and a human check, `browser_fetch` and `browser_download` of a PDF, `browser_extract`, and `browser_shop` over fixture stores).

`apps/hub-api/scripts/browser-live-check.mjs` runs them against the real sites (not in CI). Parts that need Xvfb, Electron or an H.264 encoder skip, saying so, where those are missing.

There is no text recognition in images, so a desktop app's captures and pictures of the real screen are always held. Other desktop apps on macOS, anything on Windows beyond web pages, and the real screen outside Linux are not captured.

### 11.9 Tests and limits

`apps/hub-api/desktop-helper/linux/tests` (`python3 -m unittest` in `desktop-helper/linux`) cover the helper's message framing and error codes, coordinate mapping (pointer positions on monitors scaled 1, 1.25 and 2), key names and app ids; with stand-ins for AT-SPI and the portal (`tests/fakes.py`), page addresses in Chromium, GNOME Web and Firefox shaped trees and unreadable pages, typing that stops on owner input or another window in front, secrets kept off the clipboard, the clipboard's text given back, and a background press refused; and the agent screen's commands, environment, its apps' system bus and `pkexec`, bus configuration, shell mode, scopes and leftovers. `src/desktop/control/desktop.test.ts` drives `DesktopService` against a stand-in helper process speaking the protocol (`fake-helper.mjs`, which also plays the agent screen): one call at a time, `busy` with places, stale and other-screen captures, the observation debt, the takeover lease and its counter, `ran: maybe` and a restart after a request is not answered in time, recordings (a new name, never over a file, hashed, held), the hard floor, the owner's pointer and keyboard and a sensitive app each asked once per mission through `runNodeDesktop`, background steps and their `needs_screen` refusals, the wait in the app the owner uses, looks at elements only, the agent screen without owner checks, an agent screen that cannot start, how a call picks its screen, unreadable pages, typing stopped part way, a release cancelling the request going on, clicks asking about every sensitive app that shows, secrets typed whole or not at all, and unsaved, lost and leftover recordings.

Clicks by position cannot tell windows apart on Wayland, so the floor refuses them on the owner's screen while Ensemble shows. A verdict from the screen sees a change, not that it was the right one: the fresh look is for the model to check. Apps that keep one instance per home folder rather than per session (Firefox's profile in `~/.mozilla`) open on the agent screen only when they do not run on the owner's. Apps on the agent screen reach no service on the computer's system bus, but a setuid program started by its full path (`/usr/bin/pkexec`) ignores the private bus, so polkit still asks the owner on their screen without an Ensemble card first. Owner input is noticed in the pause after each 8 typed characters, not during them. The agent screen's GNOME Shell registers with GDM and follows logind for the owner's session as any GNOME Shell does; if it crashes, the system's crash reporter may tell the owner on their screen. Desktop control works on Linux only.

### 9. Tests and limits

API, device and remote tests cover lease fencing, ownership, local-policy narrowing, decisions, attachments, file and code relays and revocation; `src/devices/runtime-instances.integration.test.ts` and `src/remote/runtime-claims.test.ts` cover two runtimes with one pairing (turns, claims, streams). Sleep/wake, physical passkeys, provider subscriptions and installed releases need their own environment.

Captures: `src/evidence/captures.test.ts` (tool results as evidence: kept, held, variants, a file with a saved secret deleted, one outside the work's folder refused), `src/evidence/capture-run.integration.test.ts` (a run's browser and capture tools through its MCP server) and `src/node/capture.integration.test.ts` (a node's, through `node.tool.request` against a simulated computer running the real tool layer; upload ids; held captures previewed, released and discarded through `evidence.request`; the live view).

Evidence and node tools: `src/evidence/files.test.ts` (a link to a key, a hard link, `.env`, a file swapped after the check, a file outside the evidence folder, a saved secret value, sizes and kinds), `src/evidence/evidence.integration.test.ts` (the upload route's lease, sizes, sniffed types, active formats only as downloads, each kind's type and disposition, redaction, the run card, owner-only reads, a computer that keeps its files, the blob store and its sweep), `src/evidence/report.integration.test.ts` (the MCP tools into `job.report` and the evidence folder; the `.ensemble/result.json` fallback), `src/device-tools/device-tools.test.ts` (the policy, the node's own folder, public web pages, the hard floor and its dangerous commands, loopback-only HTTP with redirects, read-only git, file changes and sharing, a folder shared as a zip with what it leaves out, archives refused by what they hold, the 100 MB cap, an attachment saved by its download id, long output and background commands, sign-in codes and pages a command opens, and the OS sandbox denying keys, Ensemble's data and the browser profile), `src/device-tools/dangerous.test.ts` (the list of dangerous commands), `src/device-tools/terminal.test.ts` (keys, the pseudo-terminal taking keys from a socket as Node passes them and giving back the program's exit code, a screen's colours and hidden secrets, and programs in a pseudo-terminal in the sandbox kept as PNG evidence; skipped without an OS sandbox, `script` or Chromium), `src/device-tools/sudo.test.ts` (sudo replaced: its arguments and input, the password hidden and wiped, refusals, sealed boxes and their reuse), `src/workspace/sandbox/os-escape.test.ts` (a process monitor lists the computer's processes but reads and signals none) and `src/node/device-tools.integration.test.ts` (the relay round trip with a fake computer, one Needs me card per folder, an older computer, owner-only tools, an attachment fetched once by that computer only and saved, `hub_save_file {attachment}`, a zipped folder in the reply's media, a long command waking its node once, a sign-in command's code on one owner-only card, and a node run getting only the secrets it names). macOS and Windows sandboxes are not exercised there.

Worktrees for parallel work: `src/workspace/worktrees.test.ts` (a build's worktree on its branch, its check in the same one, a snapshot, what is refused, and removing only what loses nothing, in a real repository) and `src/node/parallel.integration.test.ts` (the claim's `mission`, and two builds claimed at once).

There is no automatic move to another computer, full database sync, mid-command replay or inbound remote shell or tunnel. A compromised browser session can use whatever the computer's switches allow; local switches and OS rules are the boundary. Redaction is bounded and does not prove content has no sensitive data.
