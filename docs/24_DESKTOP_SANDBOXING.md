# 24 · Workspace sandboxing and execution permissions

These controls live in `apps/hub-api/src/workspace` and are shared by the desktop app, the CLI and permitted server execution. [06](06_MODULE_WORKSPACE_AND_SURFACES.md) covers execution and results.

## 1. Layers

| Layer | Source | Responsibility |
| --- | --- | --- |
| Assignment | `assign.ts`, route/dialog validation | Persist mode, folder, model, network/Git/sandbox choices and budgets |
| Folder and argument checks | `guard.ts`, `folder-read.ts` | Canonical paths, blocked roots and secret areas, program/argv rules |
| Trust and prompts | `trust.ts`, `trust-share.ts`, `tools.ts` | Trusted paths, pending decisions, outside-folder grants |
| Git | `git-gate.ts`, trusted clone/publish helpers | Allowed operations and branches, credentials kept out of the agent |
| Child processes | `runner.ts`, `sandbox/spawn.ts`, `sandbox/scrub.ts` | Scrubbed environment, OS confinement, timeouts, process-tree cleanup |
| Backend | `sandbox/seatbelt.ts`, `linux.ts`, `windows.ts` | The per-OS filesystem and network boundary |
| Review | `changed-files.ts`, `planted.ts` | Changed-file evidence and flags for files that can run later |

A prompt or argv allowlist alone is not a sandbox. The API and runtime are trusted application code with access to data and credentials; agent commands and repository/dependency code must stay inside the granted boundary.

## 2. OS sandbox backends

`prepareSandbox()` finds the working backend once at startup (`refresh` re-checks after setup). `capabilities()` then reports the mechanism, strength (`strong`, `reduced` or `advisory`), whether internet-off is enforced, limits, reason and setup steps. `ensemble sandbox [status] | setup` and Settings → This computer show the same.

| OS | Backend | Boundary | Limits and setup |
| --- | --- | --- | --- |
| macOS | Seatbelt (`sandbox-exec` profile) | Writes only in the work folder; home, keys, Unix sockets, LaunchServices and Ensemble's data denied; internet off enforced | Not an App Store app sandbox. Named grants get metadata-only traversal of their ancestors (no sibling reads); internet on allows the `mDNSResponder` socket for name lookups |
| Linux, first choice | bubblewrap (`bwrap` from the distribution) | Read-only system, home hidden except the work folder and toolchains, private `/tmp`, internet off enforced | Needs unprivileged user namespaces (distribution, kernel and AppArmor must allow) |
| Linux, fallback | Landlock through the bundled `landrun` (`<sidecar>/bin/landrun`, or `ENSEMBLE_LANDRUN`) | Writes only in the work folder; home, keys and Ensemble's data unreadable | Strength `reduced`: Unix sockets (ssh-agent, say) are not hidden. Internet off needs Linux 6.7+; on older kernels a run with internet off is refused |
| Windows | Anthropic's `sandbox-runtime` | Commands run as the hidden local account `srt-sandbox` with a restricted token in a job object; it cannot read the person's profile, writes only the work folder and cache, reads toolchain folders on PATH. Internet on goes through a loopback proxy; internet off has no proxy and the firewall rule blocks everything | One admin prompt per computer (`ensemble sandbox setup`, Set up in Settings, or offered at `ensemble login`); shared by CLI and desktop app. No Docker, VM or Hyper-V. Tools installed only for the user must be on PATH; the work folder must be on a local drive |
| Anything else, or no working backend | none | `advisory` | Reported with the reason |

Nothing falls back silently: `startSandboxed` refuses a confined spawn when no backend works. Callers that pass `advisoryOk` (plots) run unsandboxed and say so. The Assign dialog can run with sandbox off when none is available. The web terminal refuses to run without its OS boundary.

## 3. Work folder and outside access

The work folder is canonicalized (symlinks resolved), checked against blocked roots and held by resource and checkout locks. Fresh checkouts, continuation folders and user-picked folders are prepared differently but share enforcement. Broad home, system and app-data folders cannot be trusted by path string.

With the sandbox on, `outsideAccess` is:

| Value | Behaviour |
| --- | --- |
| `read` (default) | Outside reads allowed within guard rules; a new outside write asks in Ask mode and is refused when nobody may answer |
| `read-write` | Outside reads and writes allowed, except hard-denied secret, app and system areas |
| `none` | Only the granted folder and toolchains |

None of these grants keys, browser data, app database or discovery files, or control of another process. Whatever the setting and mode, `outsideRefusal` (`workspace/guard.ts`) refuses keys, sign-ins and browser data (`SECRET_PATHS`), another account's files and Ensemble's own data, and refuses writes to start-up files (shell profiles, `.gitconfig`, launch agents), system folders, Ensemble's own code and the home folder itself. Device files such as `/dev/null`, temporary folders, tool caches and other projects are ordinary outside paths. With the sandbox off there is no OS boundary; only the application and tool checks remain.

## 4. Trust and run modes

Trust is per computer and path. Ensemble's workspace is always trusted; other folders need a local trust decision. System folders, the home folder and Ensemble's source are refused. `ensemble trust` manages the list.

Trust sharing (`trust-share.ts`, `ensemble trust share on|off`, on by default per computer) also marks trusted folders as trusted in Claude Code, Codex, GitHub Copilot CLI, Cursor and Gemini CLI, so a handed-off task does not stop at their own trust prompt. Only installed tools are touched; Ensemble removes only marks it added, and turning sharing off removes them all. The mark list and backups of each edited file sit beside `remote.json`.

A run Ensemble starts carries the same trust: in a folder the person trusted by name (for good or for this task), Claude Code loads the folder's own `.claude/` settings and Codex treats it as trusted, as in their own terminal; in folders inside it, the workspace and fresh clones neither does ([30 §1–§2](30_ENGINES.md)). In every mode, a command that only reads files inside the folder (`ls`, `cat`, `grep`, `git status`…; links and globs followed) runs without asking, for Ensemble's agent and the engines alike (`quietArgs`, [30 §1](30_ENGINES.md#1-claude-code-as-the-engine)).

| Mode | Behaviour |
| --- | --- |
| Ask | Commands and edits can pause for exact permission, per trust and settings; commands that only read inside the folder do not; real questions go to Needs me |
| Review only | Trusted folder, fewer permission prompts, still asks real decisions. **Can edit files** |
| Run unattended | Trusted folder; takes configured or recommended answers and lists them in the result; never waits for a person |
| Read-only access | A separate lower-level grant; tools and OS deny writes and network accordingly |

No mode bypasses outside-access or Git rules. Tool-call gates apply to Ensemble and in-process external engines; a handoff into a tool's own app or terminal uses that tool's controls ([30](30_ENGINES.md)). Grok Build, OpenCode and Antigravity, and Gemini CLI outside macOS, have no OS sandbox Ensemble can turn on: their runs need Sandbox off, which the Assign dialog says, and the judge still answers every call they ask about ([30 §3.3](30_ENGINES.md#33-grok-build-opencode-gemini-cli-and-antigravity)).

## 5. Git and credentials

Ensemble puts no limit of its own on git or GitHub work: any branch, commit, push (force and deletes included), rebase, pull request or merge is the person's and their agent's call, approved like any other command by the run's mode. The run's **Git** choice is the person's own limit: **No limits** (`delivery: "push"`, the default), **Commit** (no push), **Local only** (no commits), or **Pull request** (§5.1). Local only also refuses commit-producing `merge`, `rebase`, `cherry-pick`, `revert`, `tag`, `am`, `notes` and a non-fast-forward `pull`; a commit made another way (a script, say) is undone at the end while file changes stay. Ask before each commit parks the exact operation; Unattended cannot combine with it.

Ensemble's agent never holds a credential: its `git push`, its fetch and pull with *Use my git sign-in*, and its `gh` commands are run by Ensemble outside the sandbox with the computer's sign-in, exactly as asked (`pushWithSignIn` in `workspace/publish.ts`, `runTrustedGh` in `workspace/git-gate.ts`; the GitHub token from `githubApiToken`: the token saved in Settings, the GitHub connection, or `gh auth token`). It never receives `ENSEMBLE_GIT_TOKEN`, an askpass that prints it, or an SSH agent socket. Git runs hardened against hooks and fsmonitor (also for the git `gh` runs). Only what would start a program on the computer is refused there: `git push --receive-pack|--exec`, `git fetch --upload-pack`, git options before the subcommand, and, in a sandboxed run, `gh extension|alias|codespace` and a push into a folder outside the run other than the one it was cloned from. Claude Code, Codex, Cursor and GitHub Copilot run `git` and `gh` themselves with the computer's sign-in ([30 §1](30_ENGINES.md)); with the sandbox on, the sandbox hides sign-in files (`~/.config/gh`, `~/.ssh`, `~/.git-credentials`), so turn it off for runs that push or open pull requests themselves. In a sandboxed run `checkGit` (`workspace/guard.ts`) also refuses `git config` (or `git -c`) keys outside a safe list (identity, branch and remote settings, push and pull defaults), because hooks, filters, editors, helpers and aliases would run outside the sandbox later.

The run's branch is the one asked for (`prepareBranch`, `workspace/agent.ts`): the current one, a new branch with exactly the given name (else `ensemble/<job-id>/<slug>`), or an existing branch, in a fresh clone, a continued run or a folder worked in place alike. A clone of a folder shared as a repository gets that folder's own `origin` (any user or token removed from the URL) as `origin`, so pushes, pulls and `gh` reach the real repository; the folder itself is the remote `local`.

Credential redaction recognizes known patterns only; command output can still contain sensitive data.

### 5.1 Pull requests

With **No limits** an agent opens and merges pull requests itself when the task asks (`gh pr create`, `gh pr merge`). A code run can also end in a pull request Ensemble opens (`pullRequest: { base, merge }` on `POST /api/agent/assign`, the Assign dialog's **Pull request** git choice, a run profile, or `hub_assign_to_agent`; `workspace/pull-request.ts`, `lib/github-pulls.ts`):

1. **Where.** In the run's own clone (of a repository URL, or of a folder the computer shares as a repository) or in a folder worked in place; the repository's GitHub `origin` (https or SSH) is read before the agent runs. A chat message, a research task and a read-only run cannot end in one. The run needs the internet.
2. **Which base.** Any branch the person names (`base`); empty means the repository's default branch, asked from GitHub. A computer opens them when it publishes `capabilities.pullRequests` 2 or more; 0.4.10 and 0.4.11 publish 1 and are asked to update.
3. **Which branch.** The branch named at assignment (`branch`; not the base itself), else the run's own `ensemble/<job-id>/<slug>`, made from the base as GitHub has it now (`git fetch <origin> +refs/heads/<base>:refs/ensemble/pr-base/<job>`, then `checkout -B`). Run again continues the earlier run's branch. The agent commits there and may push or open the pull request itself (delivery is No limits).
4. **After a successful run with commits**, with the computer's GitHub sign-in (`githubCloneAuth`, `githubApiToken`): the branch is pushed without force (`git push --porcelain <origin> HEAD:refs/heads/<branch>`; a branch someone else moved on GitHub is not overwritten), the pull request is opened (or the open one for that branch reused; nothing is opened when the work is already in the base or the run ended on another branch) with the run's summary, and then, by `merge`: **ask** (default) puts *Merge pull request #N into <base>?* on Needs me, and on Allow merges; **auto** merges; **never** leaves it open. Before a merge Ensemble waits up to 30 minutes for every check run and commit status on the head commit; a failure leaves it open, and the merge (`merge_method: merge`) names that head commit. The run's summary says what happened, with the link; `pull_request` events record it, and the ledger gets `workspace.pull_request` and `workspace.pull_request_merged`.
5. A step that cannot complete (GitHub refused the push, no GitHub sign-in on the computer) ends the run as blocked with the reason; the commits stay on the branch in the clone.

## 6. Commands and processes

`run_command` takes a program and arguments, not a shell string: no pipes, redirects, `&&` or `sh -c`. Allowed interpreters still run code, so the OS sandbox must contain their subprocesses. Never-listed programs, sensitive paths and environment variables have extra guards.

A command is over when its own process exits: output still in the pipes is read for 2 seconds (`DRAIN_MS`), so a process it left running (a server, a stuck test worker) cannot hold the result open; the result notes what is still running, and the run's end stops it. A timeout or Stop kills the command's whole session, including a process that moved to a process group of its own (`timeout`, a shell with job control).

Child environments are scrubbed of provider, session and device credentials. `runner.ts` enforces timeouts and kills the process tree on stop, keeping partial work; it cannot undo a completed remote write. Internet on/off is a per-run choice; there is no per-domain approval proxy for all traffic.

## 7. Files that run later

Editor tasks, shell startup files, hooks, lifecycle scripts, `.envrc` and build files can run later outside the sandbox. `planted.ts` flags changed ones for review, including inside repositories cloned during the run. A flag does not prove other code safe. `changed-files.ts` reports bounded status and line counts without running unsafe cloned-repository configuration.

## 8. Queue and remote use

`queue-policy.ts` locks conflicting folders, projects, repositories and continuations ([05 §4](05_MODULE_TASK_ORCHESTRATOR.md#4-queue-slots-and-limits)). Permission checkpoints keep exact arguments and tree identity; a stale tree or decision is refused.

A paired computer enforces its own capability, trust and Git settings; a web reply cannot create local trust. The hosted worker never runs device jobs, and an expired lease marks the job interrupted instead of moving it to another computer ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

## 9. Tests and limits

`workspace/sandbox/os-escape.test.ts` runs live escape tests; backend, argv, path, trust and Git tests sit beside their code. `full-checks.yml` runs them by hand on macOS (Seatbelt), Linux with bubblewrap, Linux with Landlock, and Windows ([37](37_PAUSED_CHECKS.md)); `ENSEMBLE_REQUIRE_OS_SANDBOX=1` makes a missing sandbox fail instead of skip ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)).

Tests cover the configurations they ran on. Landlock's sockets, toolchain grants, running with the sandbox off, code the person runs later, provider side effects and application compromise remain real boundaries.
