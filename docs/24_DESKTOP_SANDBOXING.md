# 24 · Workspace sandboxing and execution permissions

This guide describes implemented controls in `apps/hub-api/src/workspace`, shared by desktop, CLI and permitted server execution. **Code inspected 18 Oct 2026.** It replaces the original multi-revision design: there is no required Rust spawn broker or `ensemble-sbx` executable in the current path.

## 1. Layers and source ownership

| Layer | Source | Responsibility |
| --- | --- | --- |
| Assignment | `assign.ts`, route/dialog validation | Persist mode, folder, model, network/git/sandbox choices and budgets |
| Folder and argument checks | `guard.ts`, `folder-read.ts` | Canonical paths, blocked roots/secret areas, program/argv restrictions |
| Trust and prompts | `trust.ts`, `tools.ts` | Local trusted paths, pending decisions and outside-folder grants |
| Git | `git-gate.ts`, trusted clone/publish helpers | Allowed operations/branches, separate credential use and hardened Git |
| Child processes | `runner.ts`, `sandbox/spawn.ts` | Prepared environment, OS confinement, timeouts and process-tree cleanup |
| Backend | `sandbox/seatbelt.ts`, `linux.ts`, `windows.ts` | Actual per-OS filesystem/network boundary |
| Review | `changed-files.ts`, `planted.ts` | Changed-file evidence and flags for files that can execute later |

A prompt or an argv allowlist alone is not an OS sandbox. The API/runtime is trusted application code with access to data/credentials; agent commands and repository/dependency code must operate within the granted boundary. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) describes execution and retained results.

## 2. Backend capability matrix

`prepareSandbox()` probes the machine; `capabilities()` reports the selected backend, strength, network-off support, reason, limitations and setup instructions.

| OS/backend | Implemented boundary | Limits/setup |
| --- | --- | --- |
| macOS Seatbelt | `sandbox-exec` profile; filesystem grants, secret/app-data denial, restricted process/IPC paths and network mode | System/toolchain reads and specific grants are needed; profile is not an Apple App Store application sandbox |
| Linux bubblewrap | Namespace/mount isolation, read-only system, scoped home/toolchains, private temp and optional network isolation | Distribution/kernel/user-namespace/AppArmor support must permit it |
| Linux Landlock via `landrun` | Kernel filesystem restrictions with read/write grants; optional TCP denial | Reduced strength: Unix sockets are not hidden; network-off requires kernel support (6.7+ in the probe) |
| Windows sandbox runtime | Separate sandbox account, local-drive filesystem grants and controlled network via runtime proxy | One-time elevated setup; user-only tools must be discoverable on PATH; local-drive restriction |
| No usable backend | Capability says advisory/none and explains why | A requested confined spawn is refused unless the caller explicitly permits an advisory path |

No silent fallback is promised by `startSandboxed`. The assignment UI can explicitly run with sandbox off when it reports no available sandbox. Some plot paths permit advisory execution and must disclose that. A web-controlled terminal requires its supported OS boundary and refuses when unavailable.

## 3. Work-folder and outside access

The work folder is canonicalized, checked against blocked roots and held by resource/checkout locks. Fresh run checkouts, continuation folders and user-picked folders have different preparation but share permission enforcement. Broad home/system/app-data folders cannot be trusted through a casual path string. Symlink aliases are resolved before decisions.

With sandbox on, `outsideAccess` is:

| Value | Behavior |
| --- | --- |
| `read` (default) | Permitted outside reads within the guard rules; a new outside write asks in Ask mode and is refused when nobody may answer |
| `read-write` | Explicitly allowed outside reads/writes, still subject to hard-denied secret/app/system areas |
| `none` | Work inside the granted folder/toolchain scope |

These are not blanket permissions to read keys, browser data, app database/discovery files or control another process. With sandbox off, the OS boundary is absent and outside access follows the remaining application/tool checks; do not describe that as equally confined.

Seatbelt grants metadata-only traversal for named grant ancestors so interpreters can resolve paths; this does not grant sibling-file reads. Network-on macOS permits its required resolver socket; network-off does not. Landlock's socket limitation remains explicit rather than being hidden behind a “strong” badge.

## 4. Trust and run modes

Trust is per device and path. The Ensemble workspace is trusted; other folders need the local trust decision. Optional trust sharing can write supported entries into other locally installed AI tools and removes only entries Ensemble added when disabled/untrusted.

| Mode | Current behavior |
| --- | --- |
| Ask | Commands/edits can pause for exact permission according to trust/settings; genuine questions use Needs me |
| Review only | Runs inside a trusted folder with fewer permission prompts; asks real decisions. **Can edit files** |
| Run unattended | Requires a trusted folder; takes configured/recommended answers and lists decisions in the result; cannot wait for a human |
| Read-only access | Separate lower-level grant; tools/OS deny writes and network according to that access |

Review only and Run unattended do not bypass outside-access or git rules. Tool-call gates are checked for Ensemble and supported in-process external engines. A handoff into an agent's own app/terminal uses that tool's own runtime controls instead ([30](30_ENGINES.md)).

## 5. Git and credentials

Local only, Commit, and Commit + push are distinct. Local only also refuses commit-producing merge/rebase/cherry-pick/revert/tag actions. Ask before each commit parks the exact operation when enabled; unattended cannot combine with that interactive requirement. An unauthorized commit made through a script can be undone while preserving file changes.

Trusted application helpers clone/fetch/push with the configured user sign-in; agent child environments do not receive that token. Git runs with hardening against hooks/helpers/config execution on the applicable read/run path. Publishing is bounded to allowed run branches and fast-forward behavior; protected/default branches and moved branch state are checked by the owning gate. A model cannot authorize a force push by changing prose.

This is not a promise that arbitrary native commands or a user's own external shell share the same enforcement. Credential redaction recognizes supported patterns; command output can still contain sensitive user data and should not be published blindly.

## 6. Command and process boundary

`run_command` accepts a program and arguments, not an arbitrary shell string with pipes/redirects/`&&`/`shell -c`. Allowed interpreters and scripts still execute code; the OS sandbox, not just the first program name, must contain subprocesses. Never-listed programs, sensitive paths and environment variables have additional guards.

Scrubbed child environments remove provider/session/device credentials. `runner.ts` manages timeout and process-tree cleanup. Stop/cancel kills the owned process group/tree where supported and preserves partial work; it cannot undo a completed remote write.

Network on/off is an execution choice. The current product does not implement the old proposed universal per-domain approval proxy for all application/model traffic. Network-capable untrusted commands must be assessed with their actual backend and grants.

## 7. Persistence and changed-file review

Files such as editor tasks, shell startup/configuration, hooks, lifecycle scripts, `.envrc` and build files can run later when the person uses the repository outside the sandbox. `planted.ts` flags relevant changed files for review. A flag is not a proof that other code is safe; application review and the person's later execution are separate boundaries.

`changed-files.ts` reports bounded status/addition/deletion metadata. It avoids invoking unsafe cloned-repository configuration just to inspect a diff. Agent credentials are separate from the person's later Git/editor environment.

## 8. Queue, decisions and remote use

`queue-policy.ts` locks conflicting folders/projects/repos/continuations. Waiting jobs retain their slot/resource reservation; after an hour one extra job may start under the documented N+1 rule. Exact permission checkpoints retain arguments and tree identity; a stale tree/decision is refused rather than broadly approving future commands.

Paired devices enforce their own capability/trust/git settings; a web reply cannot fabricate new local trust. The hosted worker filters device jobs out of its own execution/recovery path. Lease expiry marks interruption instead of running the task on another computer. [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).

## 9. Tests and residual limits

Live backend escape tests are `workspace/sandbox/os-escape.test.ts`; backend/argv/path/trust/git tests sit beside their implementations. CI covers macOS Seatbelt, Linux bubblewrap and Landlock, and Windows setup/runtime paths. `ENSEMBLE_REQUIRE_OS_SANDBOX=1` makes missing confinement fail the required sandbox job.

Tests establish the exercised OS/kernel configuration, not a universal sandbox guarantee. Landlock sockets, toolchain grants, native execution with sandbox off, code the person runs later, unknown provider side effects and application compromise remain material boundaries. Do not restore the old claims that Windows is Ask-only/WSL-only, Linux has no OS sandbox, or all outside access is always forbidden: all three are inconsistent with current code.
