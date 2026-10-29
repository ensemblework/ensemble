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

Agent sessions: a computer with `capabilities.sessions` 1 runs a job that continues another in the agent's own session (Claude `--resume`, Codex thread resume, ACP `session/load`) and takes the claim's `steer`. Ensemble Node continues sessions only on such a computer, or one reporting 0.4.18 or later ([35 §8.2](35_ENSEMBLE_NODE.md#82-which-session)).

Secrets for runs: a computer with `capabilities.secrets` 1 or more (`SECRETS_API`) takes a `secret.save` frame `{id, name, value}` on its event stream, keeps the value encrypted in its own `run_secrets`, and answers on `/api/devices/self/code-requests/:id` with only whether it saved it. Every code run there gets the saved secrets as environment variables and their names in its brief; whatever the computer sends back has the values hidden (`hideSecretsDeep`). Ensemble Node's secure box sends them ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets)); `ensemble secrets` manages them on the computer.

The assistant can run turns on AI subscriptions signed in on a paired computer through `subscriptions/` and the assistant-turn routes; this needs CLI 0.3.10+ or desktop app 0.3.7+ there (`capabilities.assistantTurns` 1 or more, `ASSISTANT_TURNS_MIN`). Offline sign-ins are not offered. This is separate from engine assignment and personal API keys ([30](30_ENGINES.md)).

A computer that reports `assistantTurns: 2` (`ASSISTANT_TURN_FILES`) takes the files attached to the message: the turn's spec lists them (`files`), and the computer downloads each with `GET /api/devices/self/assistant-turns/:id/files/:fileId` (`assistantFile` in `remote/client.ts`, at most the listed size plus 64 KB, stopped with the turn). The route answers only the device the turn went to, only for a file on that turn's list (404 otherwise, or when the file is gone), and 410 once the turn ended; it sends the bytes with the file's media type, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A computer that reports 1 gets no file list; a note after the message names the files and says Ensemble on that computer must be updated to receive them. How each agent is given the files: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

A computer that reports `assistantTurns: 3` (`ASSISTANT_TURN_SESSIONS`) keeps one agent session per chat: the spec carries `session: { key, history }` (the conversation id and the chat so far), and the computer resumes that chat's session or starts one with the history ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). An older computer gets the history in front of the message instead.

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

## 10. Browser and capture on the computer

The local runtime has a browser broker (`apps/hub-api/src/browser/`) and a capture service (`apps/hub-api/src/capture/`). Ensemble Node's device tools and a coding agent's run MCP server both call them ([35 §8.8](35_ENSEMBLE_NODE.md#88-browsing-and-capture)), through one tool layer: `runBrowserTool` and `runCaptureTool` validate a call and run it for one **operation** (a job attempt, or a node's tool operation), and `browserToolDefinitions()` and `captureToolDefinitions()` give each tool's JSON Schema. The server never runs a browser.

### 10.1 Browser broker

| Setting | Value |
| --- | --- |
| Browser | Playwright's Chromium (`playwright-core`, pinned in hub-api). `ENSEMBLE_CHROMIUM` names one; else the revision Playwright expects in `<data>/playwright` or Playwright's own cache, else the newest other revision, else an installed Chrome (`browser/chromium.ts`) |
| Profiles | One persistent profile per name in `<data>/browser/<profile>` (default `default`): sign-ins stay between tasks. `private: true` opens a separate context for one operation, which can emulate a Playwright device |
| Window | Headless, unless a tab asks for one (`headed`) and the computer has a display (`DISPLAY` or `WAYLAND_DISPLAY` on Linux; always on macOS and Windows) |
| Leases | A tab belongs to the operation that opened it; any other gets `not_yours`. Each use renews its lease (10 minutes). The janitor (every 15 s) closes expired tabs, a profile's browser 5 minutes after its last tab, and a private context 30 s after |

Tools: `browser_open` (http and https only), `browser_tabs`, `browser_close`, `browser_snapshot` (the accessibility tree with `[ref=…]` references, cut at 24,000 characters by default), `browser_click`, `browser_type`, `browser_press`, `browser_wait` (a selector, a text, a URL glob or a time), `browser_screenshot` (viewport, full page, one element, another viewport size), `browser_console`, `browser_network_errors`, `browser_record` (a video, or a Playwright trace), `browser_upload` and `browser_download`. There is no script evaluation and no raw CDP, so no tool reads cookies or storage.

What a capture never shows:

- Password, one-time-code and card fields, and elements marked `data-ensemble-sensitive`, are masked in screenshots (`SENSITIVE_SELECTOR`) and their values are hidden in snapshots.
- The owner's saved secret values and key-shaped strings are hidden in snapshots, titles and console text. A screenshot, video or trace of a page that shows one comes back `held: true` with the reason: the owner previews it before it is sent.
- Sites the owner marks never captured are refused for screenshots, video, snapshots and the live view; sites marked preview-first are held.
- `browser_type` refuses a saved secret value. Uploads take only regular files with one name from the operation's evidence folder or folders the caller allows, never credential files (`.env*`, keys, certificates) or files containing a saved secret, up to 50 MB; the file is read by descriptor and checked again after opening. Downloads go into the evidence folder, up to 100 MB.
- A trace of the shared profile has screenshots only, no page source or network data, and needs the profile to itself; a private tab's trace has both.

**Sensitive tabs.** `markSensitive(tab, on)` is for a sign-in or a takeover, not for agents. While on, the tab refuses snapshots, screenshots, recordings, console and network reads and every action; `browser_wait` for a URL still works. A video drops its frames, a trace is stopped and deleted, and console and network entries are not kept.

**Live view.** An operation's `onLiveFrame` receives a small JPEG of its most recently used tab about every 3 s (masked, quality lowered to keep it near 60 KB). It pauses, saying why, for a sensitive tab, a site the owner marked and a page that shows a secret. The broker keeps no frame.

**Denied to runs.** `browserDeniedPaths()` returns `<data>/browser` and `<data>/capture`: the profiles' cookies and the virtual displays' cookies. They sit in the data folder, which the OS sandbox denies ([24](24_DESKTOP_SANDBOXING.md)); a runtime whose data folder is elsewhere (`ENSEMBLE_DATA_HOME`, the testing CLI) adds these paths to the sandbox's deny list.

### 10.2 Capture service

| Target | Screenshot | Video |
| --- | --- | --- |
| `web` | A URL opened in a private tab (viewport, device, full page, element), or one of the operation's tabs | Real time or frame-stepped |
| `electron` | The app's window, from Playwright's Electron launch with the app's own `node_modules/electron` | Real time or frame-stepped |
| `gui` | Any program started by `capture_app_start` on a private virtual display, grabbed with `ffmpeg -f x11grab` | Real time |
| `terminal` | A transcript (with its colours) as HTML, or rendered to PNG by Chromium | — |
| `desktop` | The real screen is refused: not supported | — |

**Virtual displays** (Linux). Each app gets an Xvfb server that picks a free display (`-displayfd`), takes no TCP connections and accepts only its own cookie (`<data>/capture/displays`), plus the first window manager installed (openbox, matchbox, fluxbox, icewm, jwm, xfwm4, metacity, twm). The app's environment has that display and no Wayland socket or session bus, so it never opens on the owner's screen. Its window is found by process id (its own or a child's) through xdotool, wmctrl or xwininfo with xprop; else by title; else as the only window; else the whole display is used.

**Frame-stepped video** freezes the page's time and moves it one frame at a time: Playwright's clock for timers, animation frames, `Date` and `performance.now()`; the Web Animations API for CSS animations and transitions (those running when recording starts are seeked from their beginning); and `window.__ensembleSeek(ms)` for code with its own clock. Each frame is a masked screenshot, so frame n is at exactly n/fps seconds however busy the computer is. Real-time video takes the page's screencast and resamples it to a constant rate.

**Media.** MP4 (H.264) when a system ffmpeg has `libx264` or `libopenh264`; otherwise WebM (VP9 or VP8) with Playwright's own ffmpeg. `ENSEMBLE_FFMPEG` names an ffmpeg to try first; each one found is asked what it can encode (`capture/ffmpeg.ts`). Each video has a poster (`<name>.poster.jpg`, or `.png` for a desktop app) and a preview no wider than 320 pixels (`<name>.preview.jpg` or `.png`). Videos stop at two minutes unless the caller raises the limit (`maxVideoMs`, the owner's setting). Size, length, frames and dimensions are read from the written file (`capture/probe.ts`). Files never overwrite each other.

**Privacy.** Web and Electron captures are masked and scanned as in §10.1. A desktop app's window cannot be checked for secrets here, so its captures are always held. Transcripts are redacted before they are written, so they are not held.

**Leases.** Displays, window managers, apps and recordings are process groups under leases (`capture/leases.ts`, recorded in `<data>/capture/leases.json`). An app's lease runs 30 minutes from its last use. The janitor (every 10 s) ends leases that expired and leases whose process ended; an app's display goes with it. When the runtime exits it kills them all. At start-up (`startCapture`, or the first capture) it stops what a runtime that is no longer running left behind, and leaves alone a process whose id was reused since.

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

`ensemble capture status` prints this. `ensemble capture setup` installs Playwright's Chromium and ffmpeg into `<data>/playwright` with Playwright's own installer and prints the one command for system packages, for example `sudo apt install xvfb ffmpeg openbox xdotool`; it never runs sudo ([26](26_CLI.md)).

### 10.4 Tests and limits

`src/browser/broker.integration.test.ts` and `src/capture/capture.integration.test.ts` drive a headless Chromium against a local server, including a one-second CSS animation recorded at 30 fps and checked frame by frame in the encoded video; `src/browser/browser.test.ts`, `src/capture/capture.test.ts` and `src/capture/leases.test.ts` cover the rest without a browser. Parts that need Xvfb, Electron or an H.264 encoder skip, saying so, where those are missing.

There is no text recognition in images, so a desktop app's captures are always held. Other desktop apps on macOS, anything on Windows beyond web pages, and the real screen are not captured.
