# 30 · Engines: who does the work, and how their questions reach you

Updated 11 Oct 2026. Read from the code and checked as listed in [doc 18](18_WHAT_IS_REAL.md).

A code task is done either by **Ensemble's agent** (Ensemble's own tool loop calling a model with your key, `apps/hub-api/src/workspace/agent.ts`) or by **Claude Code on your computer**, signed in with your own Claude account. The Assign dialog's "Who does the work" picks one; run profiles remember it. Whichever does the work, the same run settings apply: mode (Ask, Review only, Run unattended), folder trust, the sandbox, the git permission, internet access and the limits ([doc 24](24_DESKTOP_SANDBOXING.md), [doc 06](06_MODULE_WORKSPACE_AND_SURFACES.md)).

## 1. Claude Code as the engine

**Legitimate use.** Ensemble starts the person's own, unmodified `claude` (found on the trusted PATH, never inside the work folder) on their own computer, and that program uses its own sign-in. Ensemble never offers a Claude login, never reads or stores the person's Claude credentials, and never runs Claude Code on Ensemble's servers. Keys that would bill an API account instead (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are removed from its environment. A hosted Ensemble refuses a Claude Code task without a paired computer.

**How a run goes** (`workspace/engines/claude-code.ts`):

1. Ensemble prepares the folder, branch and trust exactly as for its own agent.
2. It starts `claude -p <task> --output-format stream-json --verbose --permission-mode default --setting-sources user --settings <per-run JSON> --mcp-config <per-run JSON> --max-turns <limit> [--model <alias>]` in the work folder. `--setting-sources user` keeps a repository's own `.claude/` hooks and servers from running.
3. The per-run settings add a **PreToolUse hook on every tool** (`scripts/ensemble-hook.mjs --engine`). The hook sends the call to `POST /api/engine/ask` on this computer with the run's own secret, and Claude Code waits for the answer. The judge (`workspace/engines/judge.ts`) applies the run's rules:
   - Edits inside the folder, and commands, follow the mode: allowed in Review only and Run unattended in a trusted folder, asked on Needs me in Ask unless the folder is trusted.
   - A path outside the folder follows the sandbox rule (refused with the sandbox on in Review only and Run unattended; asked in Ask; allowed without the sandbox in Review only and Run unattended). Keys, dotfiles in the home folder, Ensemble's data and code are always refused.
   - Git follows the run's git permission (`checkGit`): Local only refuses commits, merges, rebases and the rest; "Ask me before each commit" asks for each. Claude Code never pushes: with Commit + push, Ensemble pushes the run's own branch after it finishes, fast-forward only, with your sign-in and through the same push gate. With Local only, a commit made some other way (a script) is undone at the end; the files stay.
   - Privilege, persistence and remote-access programs (`sudo`, `osascript`, `ssh`, `docker`, `crontab`, …) are refused.
   - With the internet off, web tools are refused.
   - A refusal goes back to Claude Code with the reason, and it carries on.
4. **Questions.** Headless Claude Code has no question tool of its own, so the run adds Ensemble's **`ask_person`** tool (a small MCP server, `scripts/ensemble-ask-mcp.mjs`). It shows the question on Needs me with the options, the recommended one, and a box for your own answer; the call waits until you answer (from the app, the web, your phone or `ensemble needs`) and returns your answer to Claude. In Run unattended it returns the recommended option at once, and every such decision is listed on the task.
5. **Sandbox.** With the sandbox on, Claude Code's own sandbox (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap on Linux) confines its shell commands to the work folder and the cache, in strict mode: no unsandboxed retry, and Claude Code does not start where its sandbox cannot run (native Windows; Linux without bubblewrap and socat). Ensemble then says so and you can turn the sandbox off for the run. Internet off is enforced there with an empty domain list.
6. The stream (`system/init`, `assistant`, `result`) feeds the run's progress, live log, tool count, tokens and Claude Code's reported cost. Claude Code's final reply is the task summary.

**On a paired computer.** A task assigned on the web with Claude Code runs on that computer the same way; its Needs me cards reach the web and phone through the computer (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

**Models.** "Claude Code default" (follows your Claude plan), or the aliases `sonnet`, `opus`, `haiku`.

## 2. When you run the tools yourself

The same hook, installed into each tool's own settings, sends its prompts to Needs me while you use it directly (Settings → Editors & agents, or `node scripts/ensemble-hook.mjs install --target …`):

| Tool | What reaches Needs me | Installs into |
|---|---|---|
| Claude Code | Every permission prompt, and its multiple-choice questions (each option with its description, multi-select, a typed answer); answers go back as if picked in Claude Code | `~/.claude/settings.json` (`PermissionRequest`, `PreToolUse` for `AskUserQuestion`) |
| Codex | Every approval request | `~/.codex/hooks.json` (`PermissionRequest`); approve the hook once in Codex's `/hooks` |
| GitHub Copilot CLI | Tool calls before they run | `~/.copilot/hooks/ensemble.json` (`preToolUse`) |
| Cursor | Shell commands and MCP tool calls | `~/.cursor/hooks.json` |
| VS Code (Copilot agent) | Tool calls that change things | `<project>/.github/hooks/ensemble.json` |

Answer once, for the session, or always. If Ensemble is unreachable or nobody answers in time, the tool shows its own prompt; the hook never allows by itself. `ensemble needs` lists these too.

## 3. Not yet

- Codex, Copilot CLI and Cursor as engines (planned: Codex through `codex app-server`, Copilot and Cursor through ACP). Their prompts reach Needs me through the hooks above when you run them.
- Gemini CLI and Antigravity: Google's terms forbid driving Antigravity from third-party tools with a personal sign-in; not integrated without Google's confirmation.
