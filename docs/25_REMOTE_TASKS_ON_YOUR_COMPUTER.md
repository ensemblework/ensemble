# 25 · Remote tasks on your computer

The hosted app can assign work to a person's paired computer, using the same local runtime as desktop and CLI. The host stores assignments, progress, decisions, results and supported bounded review data; the computer enforces local execution rules. **Implemented source inspected 18 Oct 2026**, replacing the old pre-shipping draft.

## 1. Execution and ownership

`WorkspaceJob.deviceId` targets a paired computer. The host worker/recovery path filters those jobs out; it must not execute or fail a device's work as if it were a host job. The computer claims a hosted assignment, creates a local job and runs the normal queue/agent/engine path. Its local `deviceId` is null because the local process owns execution.

The host's spec contains task/context and supported execution choices, not arbitrary shell argv or a raw path into another computer. Published folder labels resolve against locally shared folders. Hosted email verification and account quotas apply. An offline device leaves its job queued; there is no fallback onto the server or another device.

`remote/client.ts`, `accept.ts`, `policy.ts`, `store.ts` and `devices/routes.ts` implement this boundary. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) owns normal execution; [24](24_DESKTOP_SANDBOXING.md) owns confinement.

## 2. Pairing and local state

The desktop's This computer settings or `ensemble login` pairs through an explicit browser approval/code flow. Editor context access and permission to run tasks are separate. A hosted browser logout does not uninstall/unpair a separate runtime; CLI logout, unpair and revocation do.

The device token is stored encrypted in local credential storage. `remote.json` holds switches, labels and local mappings; `api.json` discovers the loopback API. Never commit either file or expose the token. The local runtime connects outward to the configured `ENSEMBLE_REMOTE_API`; `ENSEMBLE_SITE_URL` selects the UI origin and is not the remote-task API setting.

The desktop and CLI share a runtime lock/discovery path, not two competing local databases. Pairing is not complete hosted/local workspace replication.

## 3. Lease, heartbeat and interruption

`devices/constants.ts` defines a **120-second lease** and **90-second recent-contact window**. Heartbeats/progress extend only the held lease. The scheduler sweeps expiry; the displayed interruption can lag expiry until that sweep.

Claims and writes are fenced by device and lease token. Another device or stale token cannot report completion for the job. A missed lease marks the attempt Interrupted, settles open run/decision state and preserves partial work. It is not automatically replayed. Sleep/wake, application exit and network loss must be treated as interruptions, not proof of completion.

The event stream wakes the device; persisted job/lease state is authoritative. File/code/subscription relays have their own scoped channels and bounded transient storage. Do not assume an in-memory stream alone coordinates multiple servers. Deployment topology/credentials live in private runbooks.

## 4. Hosted interfaces

### 4.1 Account and device routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/devices/pair`, `/api/devices/register` | Issue/redeem pairing code |
| GET | `/api/devices` | List the person's computers and capabilities |
| PATCH / DELETE | `/api/devices/:id` | Rename or revoke owned computer |
| DELETE | `/api/devices/self` | Device-initiated removal |
| POST | `/api/devices/self/heartbeat`, `/api/devices/self/claim` | Refresh state/leases and claim eligible work |
| POST | `/api/devices/self/jobs/:id/progress`, `/ask`, `/complete` | Report held work, ask a saved question, settle result |
| GET / POST | `/api/devices/self/decisions/:id`, `/api/devices/self/decisions/:id/close` | Read answer / close a mirrored decision |
| GET | `/api/devices/self/events` | Device wake-up stream |

`scope=device` is not a full account token. Its own route allowlist/authentication applies. Browser-created token APIs require their human/session authorization; pairing does not permit arbitrary token minting.

### 4.2 Stored model and job data

The host stores device identity/capabilities, task and job spec, lease state, decisions, progress/log/evidence and result. Local secrets stay local, except the explicit supported user-key transfer protocol when enabled. The old blanket claim “the host never stores any file contents” is false: changed-file review copies and transient relays are implemented below.

### 4.3 Local routes

`GET /api/remote`, `POST /api/remote/pair`, `/unpair`, `/folders`, and `DELETE /api/remote/folders/:label` manage the runtime locally. Code allowed folders, trust, web control and run-branch push settings cannot be invented by a hosted job. [26](26_CLI.md) lists CLI front ends.

### 4.4 Web UI

Assignment offers available computers and their shared labels/capabilities. Cards report last contact, queue/run/wait/interruption, model and result evidence. A run's review ID can open Code on its executing computer. Failure to load capabilities is an explicit error; it is not a permission grant.

### 4.5 Attachments and task context

Claims carry bounded task/page/source/skill context. Embedded owned diagrams provide source, not a screenshot. `remote/accept.ts` downloads only attached originals authorized by the current lease, at most **100 MB total**, then remaps supported hosted page references to local context. Older clients without this receiver need an update; they can still have a readable brief but cannot claim all originals were copied.

### 4.6 A task's files on the web

`remote/files.ts` sends supported changed-file text before completion: at most **100 files**, **256 KB/file**, **3 MB/run**. The server rechecks paths/redaction and stores `JobFile` copies for at most **30 days**. Metadata reports additions/deletions/line counts; renames can appear as delete+add. Unsafe cloned Git configuration is not executed just to inspect changes.

Live `GET /api/agent/jobs/:id/tree` and `/file` relays request the computer's current authorized folder through `devices/file-relay.ts`. They time out rather than becoming remote shell access. Text views are bounded and redacted; secrets, Git internals, outside links, hard links and unsafe path races are refused by `workspace/folder-read.ts` on both ends.

Only the person whose computer ran the job can read its file text; other shared-space members see metadata. The computer must still offer the task folder and the request must satisfy its age/access checks. `browseFiles` (Show task files on the web, `ensemble browse on|off`) is checked again locally; disabling it hides existing copies and refuses live reads.

### 4.7 The Code tab and terminal on the web

`POST /api/devices/:id/code` accepts only the calls enumerated in `remote/contract.ts`. `remote/code.ts` executes supported review, file, source-control and terminal calls through the local API. It is a browser-session/origin route for the computer's owner, not a tool endpoint for an assistant, bridge key or arbitrary API token. Relays hold bounded transient request/answer/output state, not a second checkout.

The local switches are `browseFiles`, `webEdit` and `webTerminal`, on by default and rechecked for each applicable call. Secret paths are refused; redacted file views cannot be written back as if their masks were original code. Binary/oversized data follows explicit view/refusal limits. Code's allowed folders are set on the computer.

The web terminal requires a **passkey unlock** with user verification for the hosted origin. Unlock expires after **30 minutes idle** and **8 hours maximum**. Lock now ends that session and stops its commands. Commands follow `workspace/terminal-exec.ts`: allowed program/arguments/folders, hardened Git, destructive-action confirmation, OS confinement and time/output bounds. It is not a raw interactive shell or an assistant command tool. See [16](16_CODE_TAB.md#5-the-terminal--for-you-only).

### 4.8 Protocol and compatibility

`remote/contract.ts` and current receiver code determine supported operations. Do not use a version table from an old PR as permission to send a new operation. UI checks advertised capabilities and reports an unavailable/outdated device. Existing jobs retain their own protocol/evidence; updating a client does not rewrite old execution.

### 4.9 Subscriptions and included models

The assistant can use supported subscriptions signed in on a paired computer through `subscriptions/` and the remote bridge. Offline sign-ins are not advertised as usable. These are distinct from external engine assignment and personal API keys ([30](30_ENGINES.md)).

A paired desktop/CLI can call included models via `/api/devices/self/included` and `/api/devices/self/included/turn`. The token determines the account; Azure credentials stay on the host and usage shares that account's credits/global ceiling. Local-only use is refused with connection guidance ([33](33_INCLUDED_AI.md)).

## 5. Local execution and permissions

`planLocalJob` validates the hosted spec against published folders, local settings, available engine/model and code/sandbox/git rules. The same conflict locks and budgets apply as local assignments. A server-provided “trusted” word is not a new local trust grant.

### 5.1 Phone approvals

`acceptWebApprovals` (Accept approvals from the web and phone) is **on by default**. When on, the selected web run settings apply and the person can confirm supported risky decisions remotely. When off, risky answers stay on the computer and web settings can only narrow local permissions. The device checks its own pending decision and action hash; first valid answer wins. Timeouts do not silently allow.

`runBranchPush` is separately **off by default**, controlled on the computer. It authorizes the bounded trusted run-branch push path, not arbitrary branch/force pushes. Application helpers use Git credentials outside the agent child environment. The existing git gate remains authoritative.

An authenticated web confirmation is not a separately implemented device-verified WebAuthn signature over every job/decision. The terminal's passkey protects its own terminal session, not all ordinary remote approvals.

### 5.2 Rate limits

Pairing, heartbeat/progress, file browsing, code, subscriptions and model calls have route-specific buckets in `lib/rate-limit.ts` and their relay implementations. Read defaults/environment overrides there rather than treating old draft values as a protocol. Per-account quotas and device/lease checks still apply after rate limiting.

## 6. Shared spaces

A run can belong to a shared space while executing on a member's own computer. Space members see permitted progress/results, but execution decisions and private file reads belong to the executing person. Revocation, sharing access and the computer's local switches are independently checked. [29](29_SHARING.md#4-agent-runs-in-a-shared-space).

## 7. What synchronizes

Assignments, bounded context/attachments, progress, decisions, result, usage and supported review data cross the device protocol. The complete local database, arbitrary folder contents, full local ledger and every private credential do not. Where user-key transfer is enabled, its explicit account/device route is a separate exception; do not describe it as general secret replication.

## 8. Device lifetime and removal

Rename is owner-only and heartbeats preserve the saved display name. Revoke/unpair stops remote-originated work/turns and forgets the device token; local-origin work is handled by its own lifecycle. Network unreachability is distinct from a 401/revocation.

Packaged launchers set `ENSEMBLE_INSTALL_PATH`; the runtime checks it on heartbeat. Removing the installed executable stops remote activity, attempts revocation and drops pairing even if the host is unreachable. Older clients need an update for that check. A hosted recent-contact indicator can remain until its heartbeat window expires; browser logout does not identify a surviving local installation.

## 9. Verification and residual limits

API/device/remote tests cover lease fencing, ownership, local-policy narrowing, decisions, attachments, file/code relays and revocation. Native sleep/wake, physical passkeys, provider subscriptions and installed release behavior still require their specific environment. A mocked round trip is not evidence of all of them.

No automatic migration to another computer, full database sync, universal mid-command replay or inbound remote-shell/tunnel service is implemented. A compromised browser session can exercise permissions that computer deliberately accepts; local approval switches and OS rules matter. Logs/redaction are bounded protections, not proof that arbitrary user content contains no sensitive data.
