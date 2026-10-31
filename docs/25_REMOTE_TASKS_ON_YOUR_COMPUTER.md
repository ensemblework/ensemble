# 25 · Remote tasks on your computer

Ensemble on the web can assign work to a person's paired computer, which runs it with the same local runtime as the desktop app and CLI. The host stores assignments, progress, decisions, results and bounded review metadata; the computer enforces its own execution rules. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) covers execution; [24](24_DESKTOP_SANDBOXING.md) covers confinement.

## 1. Execution and ownership

`WorkspaceJob.deviceId` targets a paired computer. The host worker and its recovery path skip those jobs. The computer claims the assignment, creates a local job (local `deviceId` null) and runs the normal queue, agent and engine path.

When `POST /api/devices/self/claim` claims queued work, `devices/routes.ts` moves the agent-owned task to In progress and publishes both `task` and `workspace` events on the task's space channel. The open board, task details and run queue refresh without a page reload or tab switch. Work waiting for an offline computer or a queue slot stays in To do.

The host's spec carries task context and execution choices (and `steer`, the change for a run that continues one a node interrupted: [30](30_ENGINES.md), Agent sessions), never shell argv or a raw path on the computer; folder labels resolve against folders the computer shares. Hosted email verification and account quotas apply. An offline computer leaves its job queued; work never falls back to the server or another device. `remote/client.ts`, `accept.ts`, `policy.ts`, `store.ts` and `devices/routes.ts` implement this boundary.

**Continue an earlier task.** Assign's "Continue an earlier task" on a computer lists, from `GET /api/agent/earlier-runs?deviceId=&taskId=` (`devices/earlier.ts`), the code runs that ran (or are queued to run) on that computer, under its current pairing or an earlier one of it (§8): each chain of continued runs once, by its newest step, the task's own first (and chosen by default). Assigning checks the earlier run was on that computer; the computer maps it to its own run by the web job id (`context.hostedJobId`, `remote/accept.ts`) and works in that run's folder, uncommitted work included, after it finishes (the chain's resource key). The same agent resumes its own session there ([30](30_ENGINES.md), Agent sessions). On a desktop with no computer chosen, `GET /api/workspace/checkouts` lists this server's own runs whose folder still exists.

## 2. Pairing and local state

The desktop app's This computer settings or `ensemble login` pairs through a browser approval code. Editor context access and permission to run tasks are separate. A web logout does not unpair a computer; CLI logout, unpair and revocation do.

The device token is an encrypted `model_credentials` row in the local database (`remote/store.ts`). Each pairing also makes the computer's sealing key pair, which the web encrypts secrets for: the private key in `seal-key.json` (0600, encrypted with the runtime's local key), the public key reported as `capabilities.sealKey` and pinned on the device row (§4.9, [35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)). Unpairing deletes it. `remote.json` holds switches, labels, folder mappings and the installation's id (§8); `api.json` lets the CLI and desktop app find the loopback API. Never commit either file or expose the token. The runtime connects outward to `ENSEMBLE_REMOTE_API`; `ENSEMBLE_SITE_URL` sets the UI origin, not the remote API. Desktop and CLI share one runtime lock and discovery path, not two databases. Pairing is not hosted/local workspace replication.

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
| POST | `/api/devices/self/evidence-uploads/:uploadId` | A file the web asked for by an upload id: a node's capture, or a held file released or previewed (§4.11) |
| POST | `/api/devices/self/jobs/:id/live` | The latest small picture of a run's browser tab, under its lease (§10.1) |
| POST | `/api/devices/self/takeovers/:id/frames`, `/api/devices/self/takeovers/:id/state` | A takeover's encrypted frames (the server keeps only the latest, for 30 s; 410: nobody controls it any more), and that this computer ended it itself (protocol 8, §10.1) |
| POST | `/api/devices/self/jobs/:id/logins` | A run's agent waits for its owner to sign in, under its lease: the server raises the card where the run is followed and answers its id, or `null` (protocol 8, §10.1) |
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

`remote/contract.ts` and the computer's receiver define the supported operations; each job records its protocol (changed-file text needs protocol 3, Code and terminal relays protocol 4, secret scopes, the worker's report, evidence and node tools protocol 6, held captures, a video's poster and preview, a node's browser and capture tools, `evidence.request` and the live view protocol 7, sign-ins (`login` in a browser answer, `login.resolve`, `ROUTES.runLogin`) and takeovers (`takeover.*`, `ROUTES.takeoverFrame`, `ROUTES.takeoverState`) protocol 8). An optional field an older server does not know is left out by it, so it needs no new protocol: `observed` on progress and complete is one (2 November 2026), and a claim's `mission` another (§4.12). Until a computer runs a release that sends it, its runs show their observed settings as "not reported", except the agent's model from its `engine` event. The server and UI check advertised capabilities and name the update an outdated computer needs: the coding agents a runtime can run are in `capabilities.engines` (`deviceEngines` in `devices/labels.ts`; a runtime without the list has Claude Code, Codex and Cursor's agent), so GitHub Copilot is refused for an older one. Existing jobs keep their own protocol and evidence.

### 4.9 Subscriptions and included models

Agent sessions: a computer with `capabilities.sessions` 1 runs a job that continues another in the agent's own session (Claude `--resume`, Codex thread resume, ACP `session/load`) and takes the claim's `steer`. Ensemble Node continues sessions only on such a computer, or one reporting 0.4.18 or later ([35 §8.2](35_ENSEMBLE_NODE.md#82-which-session)).

Answers for the run: a computer with `capabilities.runAnswers` 1 takes a permission answered on the web or in the Node chat *for this run* (`scope: "session"`): it keeps the answer as a rule of its run, which covers the same command with other arguments, edits in the run's folder and the same site ([30 §5](30_ENGINES.md#5-prompts-from-the-tools-and-answering-in-either-place)). The web refuses that answer for an older computer with "Update Ensemble on <computer> …"; a question or a push is always answered once.

Secrets for runs ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)): a computer takes `secret.save` frames on its event stream, keeps the value encrypted in its own `run_secrets` with where it may be sent (`allow`), and answers on `/api/devices/self/code-requests/:id` with only whether it saved it (`{saved, name, sealed, allow}`). Whatever the computer sends back has every saved value hidden (`hideSecretsDeep`). Ensemble Node's secure box sends them; `ensemble secrets` manages them on the computer.

| Capability | Frame | Meaning |
| --- | --- | --- |
| `secrets: 1` | `secret.save {id, name, value}` | The value over TLS through the server (compatibility) |
| `secrets: 2` and `sealKey {kid, alg, spki, fingerprint}` | `secret.save {id, name, decisionId, sealed: {v, kid, epk, iv, ct, aad}}` | A box sealed in the browser for this computer's key: opened, checked (its device id and key, the card, the name, a site it trusts, the expiry) and taken once here (`remote/secrets.ts`, `credentials/`). A plain `value` still works. |
| `secretsMode: all \| named` | — | How runs that name no secrets get them here (`ensemble secrets mode`) |
| `secretHttp: 1` | `node.tool.request {tool: "secret_http", …}` | A node's request by reference (§4.10) |
| `takeover: 1` | `takeover.start {id, takeoverId, tab, loginId? \| jobId?, sealed, endsAt}`, `takeover.input {takeoverId, seq, iv, ct}`, `takeover.end {id?, takeoverId, done, reason?}` | The owner controls a tab from the web, end to end (§10.1): the channel's secret sealed for this computer (purpose `takeover`), encrypted input in order, I'm done or Stop |
| `logins: 1` | `login.resolve {id, loginId, decisionId, action, sealed?}` | The owner's answer to a sign-in card (§10.1): a saved login, the tab shown on the screen, a check, a login sealed for this computer (purpose `login`), or not now. The answer is a status and a sentence, never a value |

The web pins the first `sealKey` a computer reports (at pairing, or on its first report after updating) on its `devices` row and encrypts only for that key; a later different key changes nothing until the computer is paired again (`credentials/device-key.ts`). `GET /api/devices` returns each computer's pinned `sealKey` and `sealKeyMismatch`.

**Which secrets a run gets.** A claim may carry `secrets` (protocol 6): the names the run may have, possibly none. The computer keeps the list on the local job (`context.secrets`) and gives the run only those (`secretScopeOf` and `runSecretEnv` in `lib/run-secrets.ts`). Ensemble Node's runs always carry it, and so does a run whose run profile names secrets ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)). Without the list, the computer's mode decides (`credentials/mode.ts`): every environment secret in `all`, the compatibility mode and the default; none in `named`. A secret with allowed destinations is never put in an environment: a run uses it by reference, with `secret_http` or git (`credentials/run-env.ts`). A computer that reports `capabilities.secretScope` 1 applies the list; an older one ignores it and has neither evidence upload nor node tools.

The assistant can run turns on AI subscriptions signed in on a paired computer through `subscriptions/` and the assistant-turn routes; this needs CLI 0.3.10+ or desktop app 0.3.7+ there (`capabilities.assistantTurns` 1 or more, `ASSISTANT_TURNS_MIN`). Offline sign-ins are not offered. This is separate from engine assignment and personal API keys ([30](30_ENGINES.md)).

A computer that reports `assistantTurns: 2` (`ASSISTANT_TURN_FILES`) takes the files attached to the message: the turn's spec lists them (`files`), and the computer downloads each with `GET /api/devices/self/assistant-turns/:id/files/:fileId` (`assistantFile` in `remote/client.ts`, at most the listed size plus 64 KB, stopped with the turn). The route answers only the device the turn went to, only for a file on that turn's list (404 otherwise, or when the file is gone), and 410 once the turn ended; it sends the bytes with the file's media type, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A computer that reports 1 gets no file list; a note after the message names the files and says Ensemble on that computer must be updated to receive them. How each agent is given the files: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

A computer that reports `assistantTurns: 3` (`ASSISTANT_TURN_SESSIONS`) keeps one agent session per chat: the spec carries `session: { key, history }` (the conversation id and the chat so far), and the computer resumes that chat's session or starts one with the history ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). An older computer gets the history in front of the message instead.

A paired desktop app or CLI calls included models through `/api/devices/self/included` and `/api/devices/self/included/turn`. The device token identifies the account; Azure credentials stay on the host, and usage counts against that account's credits and the global ceiling ([33](33_INCLUDED_AI.md)).

### 4.10 A node's own tools on the computer

A node can run a command, take a screenshot of a terminal, run one approved command as the administrator, read git, call a development server on the computer, change or share a file, and browse and capture (§10) without starting an agent session ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)). Each call goes to the computer as a `node.tool.request` frame on its event stream, like `code.request` (`askDeviceFor` in `devices/file-relay.ts`). The computer judges it and answers once on `/api/devices/self/code-requests/:id` (`device-tools/answer.ts`). Only a computer that reports `capabilities.nodeTools` (`NODE_TOOLS_API`) gets these frames; for an older one the node is told "Update Ensemble on <computer>". Version 2 adds `terminal`, `sudo`, files `share` and calls without a folder.

| Tool (`NodeToolRequest`) | What the computer does |
| --- | --- |
| `run {folder?, command, cwd?, timeoutSec ≤ 900, background?, secrets?}` | Checks the command like an agent's (`workspace/guard.ts`: allowed programs, arguments, folders; git against the run profile's git ceiling; no `git push` or `fetch`) and runs it under the OS sandbox with the folder writable and the profile's network choice. Named saved secrets go into that command's environment only |
| `terminal {folder?, command, seconds ≤ 60, columns, rows, keys?, title?, operation, uploadId, network}` | Runs the command in a pseudo-terminal of `columns` × `rows` (util-linux `script` on Linux, the BSD one on macOS), checked and sandboxed like `run`, but able to list the computer's processes where that is safe (`hostPids`, [24 §2](24_DESKTOP_SANDBOXING.md#2-os-sandbox-backends)), so htop and top show the real system. `keys` are typed once it started: text, or a key name in braces (`{Enter}`, `{Escape}`, `{Tab}`, arrows, `{PageUp}`, `{Home}`, `{F1}`…`{F12}`, `{Ctrl+C}`, `{Alt+x}`), arrows as the program asked for them (application cursor keys). After `seconds`, or when it ends if sooner, its screen is replayed in a headless terminal (`@xterm/headless`, `capture/screen.ts`) and rendered by Chromium to a PNG in the operation's evidence folder, with its colours, saved secret values and key shapes hidden; then it is stopped (SIGTERM, SIGKILL a second later). Without a pseudo-terminal (Windows, or no `script`) the command runs as `run` does and its output becomes a transcript image (`device-tools/terminal.ts`) |
| `sudo {folder?, command, commandHash, cardId, sealed?, timeoutSec ≤ 1800}` | One command as the administrator, which the owner approved on a card in the chat. Never in the OS sandbox. The command must be the card's (`commandHash` is its SHA-256). The owner's password, when given, is a box sealed in their browser for this computer (purpose `sudo`, the card as the decision, the hash as the name), opened and checked like any sealed box ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets), `credentials/seal.ts`) and taken once (`claimOnce` in `credentials/replay.ts`; a password sudo did not accept frees the card for a new box). It is typed into `sudo -S -k -p ""` on its input, never in an argument, the environment, a log or the output; where sudo needs no password it is not typed at all. Without one: `sudo -n -k`. The system's own sudo only (`/usr/bin/sudo`), with a clean environment. Output, time limit and running on as for `run`; the answer's `error` says when the password was not accepted or is needed. Not on Windows (409) (`device-tools/sudo.ts`) |
| `git {folder?, op, args?}` | `status`, `diff`, `log`, `show` or `branch` (list only), read-only and sandboxed; options that write, run programs or leave the folder are refused (`device-tools/git.ts`) |
| `http {url, method?, body?}` | `http` or `https` only, no user name or password, and every address the name resolves to must be loopback; the connection uses the checked address, and each of at most 5 redirects is checked again. Ensemble's own local port is refused (`device-tools/http.ts`) |
| `files {action: write\|move\|delete, folder?, path, to?, content?}` | Inside the folder only: no link, no hard link, no key, credential or `.env` file, no `.git`; a write is at most 1 MB, a move never overwrites, delete removes files only (`device-tools/files.ts`) |
| `files {action: share, folder?, path, caption?, operation, uploadId}` | A file becomes the node's evidence, to show its owner in the chat: checked like an attached file (no link or second name, no key, credential, `.env` or history file, nothing in a key folder or git's, not Ensemble's data, no saved secret value, at most 20 MB or a video 100 MB, its bytes what its kind says), copied into the operation's evidence folder and kept and sent like a capture (§4.11), with its caption. Its kind comes from its name: `.md`, `.markdown`, `.txt`, `.log`, `.csv`, `.json` and `.pdf` are reports, pictures images, `.mp4`, `.webm`, `.mov` videos, anything else a file (`device-tools/share.ts`) |
| `secret_http {ref, url, method?, headers?, body?}` | A request with a saved secret put in where `{{NAME}}` appears in a header or the body, only to the secret's allowed origins, never in the address, no redirects followed; the answer has the value hidden (`credentials/secret-http.ts`, `capabilities.secretHttp`). The allowed destinations are the owner's answer, so no Needs me card is asked for |
| `browser {name, input, operation, uploadId, network}`, `capture {…}` (protocol 7, `capabilities.browser` 1) | One browser or capture tool of §10 (`device-tools/capture.ts`) for the node's tool operation (`node:<nodeId>:<mission>`), writing into its evidence folder `<data>/evidence/node/<digest>`. Opening or capturing a page is judged per address (capability `browse`), starting an app per folder (`run`, `resolveToolFolder`); calls on the operation's own tabs, apps and files are not asked about. With `network` false, only this computer's own addresses. Each file it writes is recorded as the node's evidence and sent under `uploadId` (§4.11); the answer (`NodeCaptureAnswer`) carries the tool's summary and result, each file's id and whether it is held or kept here, and what was not kept |

**Folders.** A folder is one this computer shares (by its label) or a full path Ensemble may hand to an agent (`resolveWorkFolder`). A call that names none works in the node's own folder, `<workspace>/nodes/<handle>` (the node's `nodeSlug`, else the start of its id), made with mode 0700 on first use and refused when a link or a file is in its place (`ownToolFolder`). Ensemble's run folders (`<workspace>/runs/<job>`) and every node's folder (`<workspace>/nodes/<handle>`), and folders inside them, count as the node's own too (`isEnsembleWorkFolder`): the floor still applies there. A link, the home folder itself, a system folder, Ensemble's data folder and folders that hold keys, sign-ins, Ensemble's git helper or its code are refused (`device-tools/folders.ts`). The sandbox also denies the secret folders and files in the home folder (`SECRET_PATHS` in `workspace/guard.ts`, which includes `SECRET_HOME_PATHS`), Ensemble's data folder (with the run secrets, the key that encrypts them and the browser profile folder) and its git helper, inside any folder (`nodeToolDenies`).

**Who decides** (`device-tools/policy.ts`, on the computer). In order:

1. The hard floor: the folders above, and the list of dangerous commands (`device-tools/dangerous.ts`; disks, the system, the home folder and keys, power, accounts, the network, packages the system needs, fork bombs, and as the administrator open shells, piped downloads and keys) for `run`, `terminal`, `sudo` and the command of `capture_app_start`. 403, and no answer opens it; the computer's ledger keeps `node.tool.refused` with the rule.
2. The node's own folder (and Ensemble's run and node folders), and public web pages (a name that is not local and resolves only to public addresses, `publicWebAddress` in `device-tools/http.ts`): allowed without asking. On this computer `ensemble approvals websites ask` (`askBeforeBrowsing` in `remote.json`) makes public pages ask too. Where the sandbox is weak, commands in the node's own folder still ask once per mission.
3. The owner's answers for this computer: rules in `decision_rules` with `source` `node-tools`, one per folder or web address (`toolName` `folder` or `origin`), for the mission (`sessionId`) or always.
4. Unattended (the node's run profile runs unattended, and the node does not ask first): allowed inside the sandbox.
5. Attended: 428 with `body.ask` (`NodeToolAsk`; capability `run`, `git`, `files`, `read` for sharing a file, `http` or `browse`). The server raises one card with *Once*, *This mission* and *Always for this folder* (or *for this address*). The answer goes back with the node's next call (`grants`), and the computer keeps *This mission* and *Always* as its own rules.

A `sudo` call is not judged per folder: its card is the owner's answer for that exact command.

The answers count only while the computer accepts approvals from the web (`acceptWebApprovals`); with it off, a call without a rule here is refused (409). Where the sandbox is weak (no OS sandbox, or `capabilities.sandbox` `advisory` or `ask`), the floor is best effort: *Always* does not cover commands, which ask once per mission instead.

**Answers.** 200 with the result (a `NodeCaptureAnswer` for `terminal`, whose result is `{screen, exitCode, ended}`, and for files `share`); 202 for a command still going; 403 for the hard floor; 404 for a missing path; 409 when switched off or not possible here. What a command prints is redacted for saved secret values and key shapes. An answer carries at most 64 KB (`NODE_TOOL_INLINE_BYTES`, the start and the end). Longer output goes in order, in chunks at line ends, to `/api/devices/self/tool-runs/:runId/output`, at most 1 MB per command. The server keeps it in Redis for 6 hours under the run's id, never in the database (`devices/tool-runs.ts`). A command still going after 60 seconds (`NODE_TOOL_FOREGROUND_MS`), or started with `background`, runs on. Its last chunk says how it ended, and the server wakes the node once (`enqueueTurn`, reason `tool`). Stopping remote work stops these commands too.

**Ledger.** Each call writes one entry on the computer (`node.tool.run`, `node.tool.terminal`, `node.tool.sudo`, `node.tool.git`, `node.tool.http`, `node.tool.files.*`, `node.tool.browser`, `node.tool.capture`, `node.tool.ask` and `node.tool.refused`) and one on the server (`node.device_tool.<tool>`). They keep the program or operation and the folder or origin, never the output; `node.tool.sudo` keeps only the command's SHA-256, the folder and the exit code.

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

**Captures** (protocol 7). What a run's browser and capture tools write is recorded as its evidence where it lies, with no attach step (`evidence/captures.ts`), and goes the same way. `EvidenceMeta` may also say:

| Field | Meaning |
| --- | --- |
| `held`, `holdReason` | Held for the owner's preview: like `local`, no bytes come with it; the server lists it held and shows its preview card ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)) |
| `variantOf`, `variant` | A video's `poster` or small `preview` image, sent after the video |
| `details` | What capture measured: `width`, `height`, `durationMs`, `fps`, `frames`, `codec` |

A server before protocol 7 gets no held file and none of these fields.

**Upload ids.** A file the web asks for outside a run's lease goes to `POST /api/devices/self/evidence-uploads/:uploadId`, with the same headers and checks but no lease: the web makes the id (`evidence/grants.ts`, in Redis) for one device and account, and for one purpose: `new` (a node's tool call: files of that node operation, rows with no job, at most 100 per operation), `release` or `preview` (one file this computer keeps). 410 when nobody waits for it any more.

**Files kept here** (held, or upload off) are asked for with `evidence.request {id, evidenceId, action, uploadId?}` on the event stream, answered like a Code answer (`evidence/requests.ts`): `preview` sends the file under the upload id for its owner's eyes (the server keeps it five minutes in Redis, at most 32 MB); `release` sends it the same way and marks it released here (409 with evidence upload off); `discard` deletes it, its poster and preview, here. The file is read again by the same rules as any upload: unchanged since it was recorded, no saved secret value in it, text redacted.

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

Captures: `src/evidence/captures.test.ts` (tool results as evidence: kept, held, variants, a file with a saved secret deleted, one outside the work's folder refused), `src/evidence/capture-run.integration.test.ts` (a run's browser and capture tools through its MCP server) and `src/node/capture.integration.test.ts` (a node's, through `node.tool.request` against a simulated computer running the real tool layer; upload ids; held captures previewed, released and discarded through `evidence.request`; the live view).

Evidence and node tools: `src/evidence/files.test.ts` (a link to a key, a hard link, `.env`, a file swapped after the check, a file outside the evidence folder, a saved secret value, sizes and kinds), `src/evidence/evidence.integration.test.ts` (the upload route's lease, sizes, sniffed types, active formats, redaction, the run card, owner-only reads, a computer that keeps its files, the blob store and its sweep), `src/evidence/report.integration.test.ts` (the MCP tools into `job.report` and the evidence folder; the `.ensemble/result.json` fallback), `src/device-tools/device-tools.test.ts` (the policy, the node's own folder, public web pages, the hard floor and its dangerous commands, loopback-only HTTP with redirects, read-only git, file changes and sharing, long output and background commands, and the OS sandbox denying keys, Ensemble's data and the browser profile), `src/device-tools/dangerous.test.ts` (the list of dangerous commands), `src/device-tools/terminal.test.ts` (keys, a screen's colours and hidden secrets, and programs in a pseudo-terminal in the sandbox kept as PNG evidence; skipped without an OS sandbox, `script` or Chromium), `src/device-tools/sudo.test.ts` (sudo replaced: its arguments and input, the password hidden and wiped, refusals, sealed boxes and their reuse), `src/workspace/sandbox/os-escape.test.ts` (a process monitor lists the computer's processes but reads and signals none) and `src/node/device-tools.integration.test.ts` (the relay round trip with a fake computer, one Needs me card per folder, an older computer, owner-only tools, a long command waking its node once, and a node run getting only the secrets it names). macOS and Windows sandboxes are not exercised there.

Worktrees for parallel work: `src/workspace/worktrees.test.ts` (a build's worktree on its branch, its check in the same one, a snapshot, what is refused, and removing only what loses nothing, in a real repository) and `src/node/parallel.integration.test.ts` (the claim's `mission`, and two builds claimed at once).

There is no automatic move to another computer, full database sync, mid-command replay or inbound remote shell or tunnel. A compromised browser session can use whatever the computer's switches allow; local switches and OS rules are the boundary. Redaction is bounded and does not prove content has no sensitive data.

## 10. Browser and capture on the computer

The local runtime has a browser broker (`apps/hub-api/src/browser/`) and a capture service (`apps/hub-api/src/capture/`). Ensemble Node's device tools and a coding agent's run MCP server both call them ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)), through one tool layer: `runBrowserTool` and `runCaptureTool` validate a call and run it for one **operation** (a job attempt, or a node's tool operation), and `browserToolDefinitions()` and `captureToolDefinitions()` give each tool's JSON Schema. The server never runs a browser.

The desktop app's sidecar and the CLI's runner configure both when the hub starts (`startCaptureRuntime` in `capture/runtime.ts`, from `index.ts` on the computer only): the owner's privacy rules (the values of their saved secrets, read again at most every 5 seconds, and this computer's site lists, below), the OS sandbox for apps (§10.2) and logging. A runner (not a short-lived admin runtime for a CLI command) also cleans up after a crashed runtime and starts the janitors. When the runtime stops, every tab, app, display and recording ends.

### 10.1 Browser broker

| Setting | Value |
| --- | --- |
| Browser | Playwright's Chromium (`playwright-core`, pinned in hub-api). `ENSEMBLE_CHROMIUM` names one; else full Chromium before the headless shell (headless runs it as the real browser, which sites block far less), the revision Playwright expects in `<data>/playwright` or Playwright's own cache, else the newest other revision, else an installed Chrome (`browser/chromium.ts`) |
| How sites see it | As this computer's Chrome: no `--enable-automation`, Blink's `AutomationControlled` off, `navigator.webdriver` false, the user agent of its version without `HeadlessChrome`, and the computer's language (`Accept-Language`) and time zone (`browser/launch.ts`). An emulated device keeps its own user agent |
| Profiles | One persistent profile per name in `<data>/browser/<profile>` (default `default`): sign-ins stay between tasks. `private: true` opens a separate context for one operation, which can emulate a Playwright device |
| Window | Headless, unless a tab asks for one (`headed`) and the computer has a display (`DISPLAY` or `WAYLAND_DISPLAY` on Linux; always on macOS and Windows) |
| Leases | A tab belongs to the operation that opened it; any other gets `not_yours`. Each use renews its lease (10 minutes). The janitor (every 15 s) closes expired tabs, a profile's browser 5 minutes after its last tab, and a private context 30 s after |

Tools: `browser_open` (http and https only), `browser_tabs`, `browser_close`, `browser_login_needed` (hand the tab to the owner to sign in or to pass a human check, below), `browser_snapshot` (the accessibility tree with `[ref=…]` references, cut at 24,000 characters by default), `browser_click`, `browser_type`, `browser_press`, `browser_wait` (a selector, a text, a URL glob or a time), `browser_screenshot` (the viewport by default, one element, the full page when asked, another viewport size), `browser_console`, `browser_network_errors`, `browser_record` (a video, or a Playwright trace), `browser_upload` and `browser_download`. `browser_open` and `browser_snapshot` say when the page is a human check or blocks automated browsing (a visible captcha frame of reCAPTCHA, hCaptcha, Cloudflare, DataDome, PerimeterX or Arkose; "Robot or human?", Cloudflare's "Just a moment…", Google's unusual traffic, Amazon's robot check and its 503, Akamai's Access Denied; `browser/human-check.ts`), with `humanCheck` in the result, so the work hands the tab to its owner or uses another source. There is no script evaluation and no raw CDP, so no tool reads cookies or storage. An operation of work with the internet off (`loopbackOnly`) opens and loads only this computer's own addresses (localhost, 127.0.0.0/8, ::1); every other request of its tabs, and of capture's private tabs for it, is aborted. Recordings a closing tab finishes (a close, the work's end, an expired lease) are kept, held as they were watched, for the work to take (`takeFinished`).

**Web tools** (`browser/web.ts`, `browser/shop/`): one call each for what a small model would otherwise do in several. `browser_view`, `browser_fetch` and `browser_extract` with a `url` are judged like `browser_open` (public pages open without asking); `browser_shop` asks only for a shop named by an address on this computer's network.

| Tool | What it does |
| --- | --- |
| `browser_view {url, focus?, fullPage?, location?, name?}` | Opens the page in a tab, closes banners, sets the place when given (Amazon's ZIP; the browser's geolocation), takes a screenshot (of what `focus` names, else the top of the page) and returns its text as Markdown (6,000 characters). A site that refuses the browser (an HTTP/2 or connection error, a short 403 or 429, "Access Denied", a page that stays empty) is read once more in a clean browser: `mode: "clean"`, read-only, no tab. A human check keeps its tab (`humanCheck: true`) for `browser_login_needed` |
| `browser_screenshot {focus?}` | Closes consent banners first. `focus` ("the stock chart", "price table", "search results") is found, scrolled into view below a fixed header and captured with a 16-pixel margin (`focusFound`, `focusOn`) |
| `browser_fetch {url, name?, tab?}` | Downloads a file with the browser's cookies (`context.request`, at most 10 redirects): up to 20 MB, a video 100 MB, its type sniffed from its bytes. PDF, Markdown, text, CSV and JSON are kept as a report, images as images, videos as videos, anything else as a file. A web page is refused with a hint |
| `browser_download` | As before; when the tab shows a PDF (Chromium's viewer) or another file instead of downloading it, that file is fetched |
| `browser_extract {tab? \| url?, focus?, maxChars? = 12,000}` | The page's main content as Markdown (headings, lists, tables as Markdown tables, links without tracking parameters), its JSON-LD and microdata products (`Product`, `Offer`, `AggregateOffer`, `ItemList`) and the prices it shows (`browser/extract.ts` on `browser/html.ts`, a small HTML reader with CSS selectors) |
| `browser_set_location {location, site?, tab?}` | Resolves "Wisconsin", "Madison, WI", "53703", "US", "India" (`browser/location.ts`: a state is its capital's ZIP, about 45 cities their own, a ZIP its state, two letters a US state first, countries by name), sets the browser's geolocation, and on Amazon its "Deliver to" ZIP (its dialog, else the endpoint the dialog calls; read back from the header), on Best Buy its US site |
| `browser_shop {query, stores?, location?, max? = 3}` | Searches each store (default Amazon, Walmart, Target, Best Buy, Costco; recipes also for Newegg, eBay, GameStop, B&H; any other shop by its domain or an address with `{query}`), three at once, each in its own tab: cleaned, Amazon's ZIP set (a US place is always set: New York 10001 when none is given), offers read (the recipe's cards, else JSON-LD, else prices beside product links), ranked by the words searched (accessories, refurbished and sponsored results after), one screenshot of the results each. Status per store: `ok`, `human_check` (its tab kept), `blocked` (the page, or its search service, refused the browser and a clean browser got no further), `no_results` (with 3,000 characters of its text) or `error`. At most 150 seconds |
| `browser_snapshot {mode: "interactive"}` | Only controls with their refs (links with where they go), headings, landmarks and short texts, at most 8,000 characters |

Page hygiene (`browser/hygiene.ts`) runs after `browser_open` (unless `clean: false`), in every web tool, and before a screenshot (consent only, so a dialog the work opened stays): the buttons of OneTrust, Cookiebot, TrustArc (also in its frame), Quantcast, Didomi, Usercentrics (its shadow DOM), Sourcepoint (its frame), Google's Funding Choices and a dozen more; Google's and Yahoo's consent pages; Amazon's "Deliver to …" toaster; then, in dialogs and fixed overlays, a button whose whole text is an accept word inside a consent banner or a close word ("No thanks", "×"). Never a button that buys, subscribes, signs up or in, downloads or asks for notifications or a location. At most 2.5 seconds; the answer says what it closed. Pages at this computer's own addresses are apps under test and are left as they are.

The clean browser for read-only views (`browser/clean-view.ts`) is a `CleanBrowser` with its own profile beside each work profile, `<data>/browser/<profile>-clean` (agents cannot open profiles ending in `-clean` or `-signin`), kept warm three minutes after its last read. It only navigates, takes a screenshot and reads the HTML through the DOM domain; its screenshot is evidence like any capture, held when its text shows a saved secret or the site is preview-first. Work with the internet off never uses it.

A computer reports `capabilities.browser: 2` for these tools; the server tells a node to update Ensemble on an older one.

What a capture never shows:

- Password, one-time-code and card fields, and elements marked `data-ensemble-sensitive`, are masked in screenshots, in every frame of the page (`SENSITIVE_SELECTOR`), and their values are hidden in snapshots, also when a placeholder puts the value on a line of its own.
- The owner's saved secret values (as written, and as escaped inside a quoted snapshot value) and key-shaped strings are hidden in snapshots, titles and console text. A screenshot, video or trace of a page that shows one comes back `held: true` with the reason: the owner previews it before it is sent.
- Page addresses and titles in tool results and the live view have secret query values (`?token=`, `code=` and the like), saved secrets and key shapes hidden.
- Sites the owner marks never captured are refused for screenshots, snapshots and the live view; a video that reaches one records none of its frames and is held. Sites marked preview-first are held. The two lists are this computer's own (`captureSites` in `remote.json`: `ensemble capture sites`, [26](26_CLI.md)); a site is a host, covering its subdomains, or an exact origin.
- `browser_type` refuses a saved secret value. Uploads take only regular files with one name from the operation's evidence folder or folders the caller allows, never credential files (`.env*`, keys, certificates) or files containing a saved secret, up to 50 MB; the file is read by descriptor and checked again after opening. Downloads go into the evidence folder, up to 100 MB.
- A trace records every page of its browser, so it starts only when every page there is this work's and none is in a sign-in. A trace of the shared profile has screenshots only, no page source or network data; a private tab's trace has both, and is held when a page shows a filled password, code or card field.

**Sensitive tabs.** `markSensitive(tab, on)` is for a sign-in or a takeover, not for agents. While on, the tab refuses snapshots, screenshots, recordings, console and network reads and every action; `browser_wait` for a URL still works. A video drops its frames, a trace of its browser (whichever tab started it) is stopped and deleted, and console and network entries are not kept.

**Live view.** An operation's `onLiveFrame` receives a small JPEG of its most recently used tab about every 3 s (masked, quality lowered to keep it near 60 KB). It pauses, saying why, for a sensitive tab, a site the owner marked and a page that shows a secret. The broker keeps no frame. For a run from the web, the remote loop sends each frame to `ROUTES.liveFrame` under the hosted job and its lease (`remote/live.ts`; protocol 7, at most about 220 KB); a run started here, and a node's own browsing, have no live view ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)).

**Sign-ins** (design B11, [35 §8.16.1](35_ENSEMBLE_NODE.md#8161-signing-in); `logins/`). After `browser_open`, a click, a key press or a submitted `browser_type`, the tool layer asks `checkForLogin` whether the page wants the owner's account (`logins/detect.ts`: one password field that is not a new-password form, a sign-in address with a user name or code field, a 401, or a known identity provider). On another site in the shared profile it raises a sign-in at once; on this computer's own addresses, in a private tab, or for a site already answered for this work it only adds a hint. `browser_login_needed` raises one on purpose. A raised sign-in (`logins/requests.ts`) marks the tab sensitive, keeps its lease (two hours at most), brings a window already on the screen to the front, and puts `login` in the tool's result: a node's answer carries it (`NodeCaptureAnswer.login`) and the server raises the card; a run's call waits in `awaitRunLogin` (`logins/run.ts`) after telling the server (`ROUTES.runLogin`, protocol 8), or asking on Needs me when no card is raised. The owner's answer comes as `login.resolve` (`logins/answer.ts`):

| Action | On this computer |
| --- | --- |
| `saved` | Fills the login saved for the site (`logins/store.ts`): user name, password, then a code from a saved seed (RFC 6238), one step at a time, pressing Enter (`logins/fill.ts`) |
| `local` | `showTab`: brings the tab to the front; a profile running without a window restarts with one (`restartProfile` reopens its tabs at their addresses under the same ids, still sensitive), only when no other work uses it. Without a screen, `no_window` |
| `done` | Checks the signed-in condition |
| `typed` | Opens the box sealed for this computer (purpose `login`, the card as decision, the sign-in's id as name, a trusted site, unexpired, taken once), checks the site inside is the sign-in's, fills it; with `save`, keeps it as a saved login once signed in |
| `decline`, `expire` | Ends it |

The signed-in check is the work's condition (`urlPattern`, a glob matched without the query, or `selector`), else: on the site, with no password or code field, and no user name field on a sign-in address. Signed in, the tab is unmarked and given back; ended any other way, it is first navigated to `about:blank`. The answer (`LoginResolution`) is only a status and a sentence. The work's end (`releaseOperation`) and a stopped remote connection end its sign-ins.

**Taking over** (design B21, [35 §8.16.2](35_ENSEMBLE_NODE.md#8162-taking-over-the-browser); `takeover/`). `takeover.start` brings the channel's secret sealed for this computer: opened and checked like a secret box (this computer and key, the takeover as decision, the tab as name, a trusted site, unexpired) and taken once. The tab must be the waiting sign-in's, or the run's (its hosted job mapped to the local job that owns the tab). The computer derives one AES-256-GCM key per direction (HKDF-SHA-256; `takeover/channel.ts`, the same messages and fixed vectors as the browser's `@ensemble/shared-types` takeover.ts), marks the tab sensitive, and starts Chromium's screencast (`Page.startScreencast` on a CDP session of the tab, JPEG at up to 1280 pixels). Each frame goes, encrypted with the next number, to `ROUTES.takeoverFrame`, one at a time, a newer one replacing any that waits. `takeover.input` is applied in order through Playwright's mouse and keyboard (clicks at a fraction of the page, the wheel, keys; a printable character, or text from the page's box or Paste, typed as text); a message numbered at or below the last, or one that does not open, is refused and counted. It ends on `takeover.end` (I'm done runs the sign-in's check), its time (`endsAt`, at most `ENSEMBLE_TAKEOVER_SECONDS`, 15 minutes), a minute without input or ping, the tab closing, or `stopRemoteWork`; ending it itself, the computer says so at `ROUTES.takeoverState`. A tab it marked sensitive is given back; a sign-in's stays paused for its card. The computer reports `capabilities.takeover: 1`.

**Saved logins.** `<data>/logins.json`, mode 0600: per site (an https origin, or this computer's own http address) the user name, password and an optional one-time-code seed, each encrypted with the runtime's local key (`lib/secrets.ts`), with when it was saved and last used. Kept apart from run secrets and never sent anywhere: the server hears only whether one is saved for the site of a card. `ensemble browser logins`, `save-login`, `forget-login` ([26](26_CLI.md)) use the local `GET`, `PUT` and `DELETE /api/browser/logins` (refused on the web). The computer reports `capabilities.logins: 1`.

**Denied to runs.** `browserDeniedPaths()` returns `<data>/browser` and `<data>/capture`: the profiles' cookies and capture's lease file. They are in Ensemble's own data, which the guard refuses and every OS sandbox backend denies wherever this runtime keeps it, the testing CLI's folder and `ENSEMBLE_DATA_HOME`'s included (`ensembleDataDenies`, [24 §3](24_DESKTOP_SANDBOXING.md#3-work-folder-and-outside-access)).

### 10.2 Capture service

| Target | Screenshot | Video |
| --- | --- | --- |
| `web` | A URL opened in a private tab (viewport, device, full page, element), or one of the operation's tabs | Real time or frame-stepped |
| `electron` | The app's window, from Playwright's Electron launch with the app's own `node_modules/electron` | Real time or frame-stepped |
| `gui` | Any program started by `capture_app_start` on a private virtual display, grabbed with `ffmpeg -f x11grab` | Real time |
| `terminal` | A transcript (with its colours) as HTML, or rendered to PNG by Chromium; a node's terminal screen (§4.10) the same way (`htmlScreenshot`) | — |
| `desktop` | The real screen is refused: not supported | — |

**Virtual displays** (Linux). Each app gets an Xvfb server that picks a free display (`-displayfd`), takes no TCP connections and accepts only its own cookie, kept in a private folder in `$XDG_RUNTIME_DIR` (else the temporary folder) so that an app in the OS sandbox can still read it; plus the first window manager installed (openbox, matchbox, fluxbox, icewm, jwm, xfwm4, metacity, twm). The app's environment has that display and no Wayland socket or session bus, so it never opens on the owner's screen.

**Apps run in the OS sandbox.** An app started for capture runs its own code, so it starts through the runtime's `wrapCommand` (`configureCapture`; `captureAppWrapper` in `capture/sandbox.ts`), which confines it as `prepareSpawn` does for agent commands ([24](24_DESKTOP_SANDBOXING.md)): its folder and the cache writable, the agent environment (no credential variables, the cache's home) plus the variables the call gave it, Ensemble's data, keys and the browser profiles denied. On Linux the sandbox gives the app back what its private display needs and nothing more: that display's X socket, bound read-only at `/tmp/.X11-unix/X<n>` under the sandbox's own `/tmp` (`sockets` in `SandboxPolicy`, bubblewrap; Landlock shares `/tmp`), and its cookie's folder; another display, the owner's included, is out of reach. The app's internet follows the work's setting; an Electron app keeps the computer's network, because Playwright drives it over a local debugging port, and runs without Chromium's own sandbox, which cannot nest inside the OS sandbox. Electron goes through a small launcher script that does the same. The folder may not be the home folder, a system folder, or one that holds keys or Ensemble's data. Without a wrapper, `capture_app_start` is refused unless the call says the owner allowed this work to run apps unsandboxed (`unsandboxedApps`). Its window is found by process id (its own or a child's) through xdotool, wmctrl or xwininfo with xprop; else by title; else as the only window; else the whole display is used.

**Frame-stepped video** freezes the page's time and moves it one frame at a time: Playwright's clock for timers, animation frames, `Date` and `performance.now()`; the Web Animations API for CSS animations and transitions (those running when recording starts are seeked from their beginning); and `window.__ensembleSeek(ms)` for code with its own clock. Each frame is a masked screenshot, so frame n is at exactly n/fps seconds however busy the computer is. Real-time video takes the page's screencast and resamples it to a constant rate.

**Media.** MP4 (H.264) when a system ffmpeg has `libx264` or `libopenh264`; otherwise WebM (VP9 or VP8) with Playwright's own ffmpeg. `ENSEMBLE_FFMPEG` names an ffmpeg to try first; each one found is asked what it can encode (`capture/ffmpeg.ts`). Each video has a poster (`<name>.poster.jpg`, or `.png` for a desktop app) and a preview no wider than 320 pixels (`<name>.preview.jpg` or `.png`). Videos stop at two minutes unless the caller raises the limit (`maxVideoMs`, the owner's setting). Size, length, frames and dimensions are read from the written file (`capture/probe.ts`). Files never overwrite each other.

**Privacy.** Web and Electron captures are masked and scanned as in §10.1; a real-time video of an Electron window records no frames of a site the owner never wants captured. A desktop app's window cannot be checked for secrets here, so its captures are always held. Transcripts and terminal screens are redacted before they are written (a line of a screen that shows a secret is drawn as plain text, the secret replaced), so they are not held.

**Leases.** Displays, window managers, apps and recordings are process groups under leases (`capture/leases.ts`, recorded in `<data>/capture/leases.json`), and each process carries its lease's id in `ENSEMBLE_CAPTURE_LEASE`. An app's lease runs 30 minutes from its last use. The janitor (every 10 s) ends leases that expired and leases whose process ended; an app's display goes with it. When the runtime exits it kills them all. At start-up (`startCapture`, or the first capture) it stops what a runtime that is no longer running left behind. A group is signalled only while its leader is the process recorded (by start time), or, once the leader is gone, while a member still carries the lease's id (read from `/proc` on Linux), so a reused process id is never hit.

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
| Linux (X11, Wayland or no screen) | Yes | With Xvfb | With Xvfb and the system's ffmpeg | No |
| macOS | Yes | Yes; the window shows on the screen | No | No |
| Windows | Yes | No | No | No |

`ensemble capture status` prints this. A paired computer reports a summary on every heartbeat (`capabilities.capture`: `browser` (a Chromium for Ensemble is installed), `video` (`mp4`, `webm` or null), `targets` (each with `screenshot`, `video` and `reason`; `terminal` also `tui`: full-screen programs are captured as their screen, which needs Chromium and a pseudo-terminal, so not on Windows) and `setup` (whether `ensemble capture setup` or one system command would add something)), with `capabilities.browser` 1: the web offers a node's browser and capture calls only to such a computer, and says to update Ensemble, or to run `ensemble capture setup`, otherwise. `ensemble capture setup` installs Playwright's Chromium and ffmpeg into `<data>/playwright` with Playwright's own installer and prints the one command for system packages, for example `sudo apt install xvfb ffmpeg openbox xdotool`; it never runs sudo ([26](26_CLI.md)).

### 10.4 Tests and limits

`src/logins/logins.test.ts` and `src/node/logins.integration.test.ts` cover sign-ins and saved logins, `src/takeover/takeover.test.ts` and `src/node/takeover.integration.test.ts` taking over ([35 §11](35_ENSEMBLE_NODE.md#11-verification)). `src/browser/broker.integration.test.ts` and `src/capture/capture.integration.test.ts` drive a headless Chromium against a local server, including a one-second CSS animation recorded at 30 fps and checked frame by frame in the encoded video; `src/browser/browser.test.ts`, `src/capture/capture.test.ts` and `src/capture/leases.test.ts` cover the rest without a browser; `src/capture/runtime.test.ts` the owner's privacy rules as the runtime gives them, and `src/capture/sandbox.test.ts` an app in bubblewrap reaching its own display's socket and cookie and not another display, Ensemble's data or a credential variable. The web tools: `src/browser/web-tools.test.ts` without a browser (the HTML reader, Markdown, products and prices, links, places, focus scoring, the interactive snapshot, every store recipe on its markup, ranking) and `src/browser/web-tools.integration.test.ts` with one (hygiene, focused screenshots, `browser_view` with a place, a clean-browser read and a human check, `browser_fetch` and `browser_download` of a PDF, `browser_extract`, and `browser_shop` over fixture stores). `apps/hub-api/scripts/browser-live-check.mjs` runs them against the real sites (not in CI). Parts that need Xvfb, Electron or an H.264 encoder skip, saying so, where those are missing.

There is no text recognition in images, so a desktop app's captures are always held. Other desktop apps on macOS, anything on Windows beyond web pages, and the real screen are not captured.
