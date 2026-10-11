# 30 · Engines: who does the work, and how their questions reach you

Updated 12 Oct 2026. Read from the code and checked as listed in [doc 18](18_WHAT_IS_REAL.md).

A code task is done by **Ensemble's agent** (Ensemble's own tool loop calling a model with your key, `apps/hub-api/src/workspace/agent.ts`), by **Claude Code**, **Codex** or **Cursor's agent** on your computer, signed in with your own account, or it is **opened in an agent's own app or a terminal** (the Claude app, Codex in the ChatGPT app, Cursor, VS Code; or Claude Code, Codex, Cursor's agent or Copilot CLI in a terminal window). The Assign dialog's "Who does the work" picks one; run profiles remember the engine. When Ensemble runs the task (its agent, Claude Code, Codex or Cursor's agent), the same run settings apply: mode (Ask, Review only, Run unattended), folder trust, the sandbox, the outside-folder setting, the git permission, internet access and the limits ([doc 24](24_DESKTOP_SANDBOXING.md), [doc 06](06_MODULE_WORKSPACE_AND_SURFACES.md)). In an agent's own app, that app's own settings apply.

## 1. Claude Code as the engine

**Legitimate use.** Ensemble starts the person's own, unmodified `claude` (found on the trusted PATH, never inside the work folder) on their own computer, and that program uses its own sign-in. Ensemble never offers a Claude login, never reads or stores the person's Claude credentials, and never runs Claude Code on Ensemble's servers. Keys that would bill an API account instead (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are removed from its environment. A hosted Ensemble refuses a Claude Code task without a paired computer.

**How a run goes** (`workspace/engines/claude-code.ts`):

1. Ensemble prepares the folder, branch and trust exactly as for its own agent.
2. It starts `claude -p <task> --output-format stream-json --verbose --permission-mode default --setting-sources user --settings <per-run JSON> --mcp-config <per-run JSON> --max-turns <limit> [--model <alias>]` in the work folder. `--setting-sources user` keeps a repository's own `.claude/` hooks and servers from running.
3. The per-run settings add a **PreToolUse hook on every tool** (`scripts/ensemble-hook.mjs --engine`). The hook sends the call to `POST /api/engine/ask` on this computer with the run's own secret, and Claude Code waits for the answer. The judge (`workspace/engines/judge.ts`) applies the run's rules:
   - Edits inside the folder, and commands, follow the mode: allowed in Review only and Run unattended in a trusted folder, asked on Needs me in Ask unless the folder is trusted.
   - A path outside the folder follows the sandbox rule. With the sandbox on, the run's **Outside the work folder** setting decides: Read only (default) lets reads through and asks for a write in Ask or refuses it in Review only and Run unattended; Read and write lets both through; No access refuses both in Review only and Run unattended and asks in Ask. A shell command counts as a write unless every program in it only reads (`readsOnly`). Without the sandbox, Review only and Run unattended allow outside paths. Claude Code's own sandbox gets matching paths (`claudeFilesystem`). Keys, dotfiles in the home folder, Ensemble's data and code are always refused.
   - Git follows the run's git permission (`checkGit`): Local only refuses commits, merges, rebases and the rest; "Ask me before each commit" asks for each. Claude Code never pushes: with Commit + push, Ensemble pushes the run's own branch after it finishes, fast-forward only, with your sign-in and through the same push gate. With Local only, a commit made some other way (a script) is undone at the end; the files stay.
   - Privilege, persistence and remote-access programs (`sudo`, `osascript`, `ssh`, `docker`, `crontab`, …) are refused.
   - With the internet off, web tools are refused.
   - A refusal goes back to Claude Code with the reason, and it carries on.
4. **Questions.** Headless Claude Code has no question tool of its own, so the run adds Ensemble's **`ask_person`** tool (a small MCP server, `scripts/ensemble-ask-mcp.mjs`). It shows the question on Needs me with the options, the recommended one, and a box for your own answer; the call waits until you answer (from the app, the web, your phone or `ensemble needs`) and returns your answer to Claude. In Run unattended it returns the recommended option at once, and every such decision is listed on the task.
5. **Sandbox.** With the sandbox on, Claude Code's own sandbox (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap on Linux) confines its shell commands to the work folder and the cache, in strict mode: no unsandboxed retry, and Claude Code does not start where its sandbox cannot run (native Windows; Linux without bubblewrap and socat). Ensemble then says so and you can turn the sandbox off for the run. Internet off is enforced there with an empty domain list.
6. The stream (`system/init`, `assistant`, `result`) feeds the run's progress, live log, tool count, tokens and Claude Code's reported cost. Claude Code's final reply is the task summary.

**On a paired computer.** A task assigned on the web with Claude Code runs on that computer the same way; its Needs me cards reach the web and phone through the computer (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

**Models.** "Claude Code default" (follows your Claude plan), or the aliases `sonnet`, `opus`, `haiku`.

## 2. Codex as the engine

**Legitimate use.** Ensemble starts the person's own Codex on their own computer through `codex app-server` (JSON lines over stdio, `workspace/engines/codex.ts`). It is the standalone `codex` when one is on the trusted PATH, else the copy the ChatGPT app ships (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` on macOS, the copy under `%LOCALAPPDATA%\OpenAI\Codex\bin\` on Windows, `/usr/lib/chatgpt/resources/codex` on Linux), which uses the same `~/.codex` sign-in. So a computer with only the ChatGPT app can run Codex tasks. Ensemble never signs in for the person, never reads `auth.json` or the keychain, and refuses to start when `account/read` says Codex is not signed in ("Open the ChatGPT app (or run `codex login`) and sign in"). `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are removed from its environment. The client name it reports is `ensemble`. A hosted Ensemble refuses a Codex task without a paired computer.

**How a run goes:**

1. `initialize` (`clientInfo.name: "ensemble"`), `account/read`, then `thread/start` in the work folder with:
   - `approvalPolicy`: `untrusted` (Codex asks before each command it does not consider safe) with the sandbox off, so the run's rules see every command (most are answered without the person), and in Ask mode in a folder that is not trusted; otherwise `on-request` (Codex asks only to leave its sandbox).
   - `sandbox`: `workspace-write` with the sandbox on, `danger-full-access` with it off. `turn/start` passes `sandboxPolicy.workspaceWrite` with the work folder and cache as writable roots (plus the person's own home folders with **Read and write** outside access) and the run's internet setting. Codex's own sandbox (Seatbelt, bubblewrap, its Windows sandbox) does the confining; Ensemble does not nest its own around it (that fails on macOS).
   - `config.projects[<folder>].trust_level = "untrusted"` for this thread only, so the folder's own `.codex/` (hooks, rules, MCP servers) does not run, as with Claude Code's `--setting-sources user`.
   - `config.mcp_servers.ensemble`: the same `ask_person` server, with the run's secret.
2. Codex's requests are answered by the run's rules (`answerCodex`, through the same judge as Claude Code):
   - `item/commandExecution/requestApproval` → the command (or the network host) is judged; `accept` or `decline`.
   - `item/fileChange/requestApproval` → the files the change touches (from its `item/started`) are judged as writes; a change whose files Ensemble did not see is declined.
   - `item/permissions/requestApproval` → internet and folders are granted only as far as the run allows, for that turn.
   - `item/tool/requestUserInput` → each question on Needs me (the recommended option in Run unattended).
   - Sign-in token refreshes, attestation and unknown requests are never handled.
3. `item/*` notifications feed the live log and tool count, `thread/tokenUsage/updated` the tokens, and the final agent message is the task summary. Stop sends `turn/interrupt`, then ends the process.

Checked against Codex 0.162 (the ChatGPT app's copy) for the handshake and the thread settings, and end to end with a stand-in `codex` (`engines/codex.e2e.test.ts`).

## 3. Cursor's agent as the engine

**Legitimate use.** Ensemble starts the person's own `cursor-agent` (Cursor's CLI, on the trusted PATH) through ACP, the Agent Client Protocol (`cursor-agent --sandbox enabled|disabled --workspace <folder> acp`, JSON-RPC over stdio, `workspace/engines/cursor.ts`). It asks the agent to use the login it already has (`authenticate` with `cursor_login`); without one it stops with "Run `agent login` there". `CURSOR_API_KEY` is removed from its environment.

**How a run goes:** `initialize`, `authenticate`, `session/new` in the work folder with Ensemble's `ask_person` MCP server, then `session/prompt` with the task. Cursor keeps its own sandbox (on with the run's sandbox on). Every `session/request_permission` is read as the run's own tool (`cursorCall`: a command is a `` `command` `` titled `execute` call, an edit carries its path) and judged by the same rules; the answer is **allow-once or reject-once, never allow-always**, which would change the person's own Cursor allowlist. `cursor/ask_question` goes to Needs me (the recommended option in Run unattended; a typed answer goes back in the person's words). `session/update` feeds the live log, tool count and the reply, which is the task summary. Stop sends `session/cancel`. Checked against `cursor-agent` 2026.09.26 for the handshake and its sign-in refusal, and end to end with a stand-in (`engines/cursor.e2e.test.ts`).

## 4. In the agent's own app, or a terminal

"Who does the work" → **In its own app** opens the task in an app found on this computer (`GET /api/agent/apps`), on a folder: one of yours, an earlier task's, or a new empty one in the workspace (Ensemble does not clone for an app). `POST /api/agent/handoff`, `workspace/handoff.ts`:

| App | How it opens | What you do |
|---|---|---|
| Claude app (Code tab) | `claude://code/new?folder=…&q=…` | Confirm the folder, press Send |
| Codex in the ChatGPT app | `codex://new?path=…&prompt=…` | Press Send |
| Cursor | the folder in Cursor, then `cursor://anysphere.cursor-deeplink/prompt?text=…` | Press Send |
| VS Code (Copilot agent) | `code -n <folder>`, then `code chat -r -m agent "<prompt>"` | Press Send |

**In a terminal** (for a computer with only the command-line tools, or by choice): Claude Code, Codex (its CLI, or the ChatGPT app's copy), Cursor's agent or Copilot CLI starts in a terminal window on the folder with the task as its first prompt (`claude "…"`, `codex "…"`, `cursor-agent "…"`, `copilot -i "…"`) and begins at once. The window is Terminal on macOS (a `.command` file), the first terminal found on Linux, PowerShell on Windows (an encoded command); the script quotes the prompt so nothing in it runs as a command (`terminalScript`).

Each vendor lets another app fill in a prompt and never send it, so in an app the person presses Send. The prompt ends with a marker (`Ensemble task ens-…`); the agent's `UserPromptSubmit` hook (or a hook from inside the hand-off's folder, for tools that never see the prompt) links that session to the hand-off. From then on its permission prompts and questions reach Needs me, and the task page shows "In Claude", then the agent's last words when a turn ends (`Stop`), until you press "Done with it". The app works with its own settings and sign-in: Ensemble's mode, sandbox and git choices do not apply there. Only the runtime on your own computer opens apps; the hosted site refuses with 409.

## 5. Prompts from the tools, and answering in either place

The same hook, installed into each tool's own settings, sends prompts to Needs me (Settings → Editors & agents → **Connect**, on the desktop app or the CLI's runtime; `ensemble hooks connect <tool>`; or `node scripts/ensemble-hook.mjs install --target …` with a token). Connect signs the hook in with a **`hooks` key**: it can open a card, wait on it, withdraw it and report what happened in its session, and nothing else; it can never answer a card (`hooksTokenRejected` in `bridge/auth.ts`).

**Which sessions.** By default only tasks Ensemble opened in the tool (§4): a request from any other session gets `skipped` at once and the tool asks you itself, without delay. Settings → Editors & agents → "Which sessions come to Needs me" can route every session instead (`orchestration.editorRequests`). A run Ensemble started (Claude Code, Codex or Cursor's agent as the engine) answers through its own engine channel, so the person's own hook steps aside there (`ENSEMBLE_RUN`).

| Tool | Asks | Reports | Answer in either place |
|---|---|---|---|
| Claude Code and the Claude app | `PermissionRequest`, including `AskUserQuestion` (answered with the questions' `answers`) | `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop` (in the background) | **Yes.** Claude's own dialog stays open beside the card; the first answer counts. Answered in Claude, the card closes ("Answered in Claude Code") when the tool runs, the turn ends or the next prompt is sent |
| Codex (CLI and the ChatGPT app) | `PermissionRequest` | `PostToolUse`, `UserPromptSubmit`, `Stop` | Ensemble first; if nobody answers there in time, Codex asks you itself. The app's prompt cannot race the hook (Codex issue #39835). Approve the hooks once in Codex (Settings → Hooks, or `/hooks`) |
| GitHub Copilot CLI | `preToolUse` | `postToolUse`, `userPromptSubmitted`, `sessionEnd` | Ensemble first, then Copilot |
| Cursor | `beforeShellExecution`, `beforeMCPExecution` | `afterShellExecution`, `afterMCPExecution`, `beforeSubmitPrompt`, `stop` | Ensemble first, then Cursor |
| VS Code (Copilot agent) | `PreToolUse` | `PostToolUse`, `UserPromptSubmit`, `Stop` | Ensemble first, then VS Code |

Reporting hooks never wait on Ensemble (5 s at most) and never block the tool. `POST /api/decisions/activity` links the session, closes cards answered in the tool (status `settled`; the waiting hook lets go), and records a hand-off's progress. Answer once, for the session, or always. If Ensemble is unreachable or nobody answers in time, the tool shows its own prompt; the hook never allows by itself. `ensemble needs` lists these too.

## 6. What each vendor allows (checked 11–12 Oct 2026)

| | CLI only | App only | Both |
|---|---|---|---|
| **Claude** | Engine (`claude -p`), or a terminal (§4) | Open in the Claude app (§4). The app's private copy of Claude Code has no sign-in of its own and an undocumented path, so it is not used as an engine; install the official CLI for engine runs | Engine for runs nobody watches; the app or a terminal for working alongside |
| **Codex** | Engine (`codex app-server`), or a terminal | **Engine** with the app's own `codex` and sign-in; open in the app; or a terminal with the app's `codex` | Engine (standalone CLI first), the app, or a terminal |
| **Cursor** | Engine (`cursor-agent acp`), or a terminal | Open in Cursor (§4) | Engine, Cursor, or a terminal |
| **Copilot** | A terminal (`copilot -i`) with its prompts through the hook | Open in VS Code (§4) | Same |

Anthropic's terms allow a person's own, unmodified Claude Code with their own sign-in (`claude -p` included, per Anthropic's help centre on 7 Oct 2026); Ensemble never offers a Claude login or handles its credentials. OpenAI permits local apps that start the person's own Codex with the sign-in made in OpenAI's own client; app-server authentication was never permitted for hosted services, which is why a hosted Ensemble refuses Codex tasks. Google's Antigravity terms forbid third-party tools using its sign-in, so it is not integrated; Gemini CLI for individuals now needs an API key.

## 7. Not yet

- **Copilot as an engine.** Copilot CLI has no sandbox of its own and no way to add a permission hook for one run, so a sandboxed Copilot run could not be kept to the run's rules. Its ACP mode runs tools without asking since 1.0.81 (github/copilot-cli#4537), and the Copilot SDK (`@github/copilot-sdk`, `onPermissionRequest`, `onUserInputRequest`, MIT) brings a native module (`koffi`) into the app. Until one of those changes, Copilot tasks open in VS Code or a terminal (§4).
- Watching or continuing an engine run in the agent's app (Claude's `--desktop` hand-over, `codex resume --remote`), and hand-offs on a paired computer from the web.
- The VS Code and Cursor editors' own folder-trust prompts (kept in each editor's state while it runs).
