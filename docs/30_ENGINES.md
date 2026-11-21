# 30 · Engines: who does the work, and how their questions reach you

Assign a task to Ensemble's agent or to a coding agent on your computer. You can use Claude Code, Codex, Cursor's agent, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code or Kimi Code.

Open **Assign**, choose the agent and computer, then review the folder, permissions, model and limits. On the hosted app, pair your own computer for coding-agent execution. An agent opened in its own app uses that app's settings.

## Start a task or terminal chat

1. Install and sign in to the agent on the computer that will run it.
2. Pair that computer with your Ensemble account if you are assigning from the web.
3. In **Assign**, choose the agent, computer and folder or repository.
4. Select a model and any available thinking, context or fast-mode options.
5. Review the run mode, sandbox, outside-folder access, internet, Git permissions and limits. Start the run and follow its progress in Runs.

**Auto** uses the agent configured for the task's complexity. A run profile remembers your choices. See [Execution permissions](24_DESKTOP_SANDBOXING.md) for the boundaries each mode applies.

In the terminal app, use `/agent` and `/profile`, then `/run <what to do>`. The run starts in the folder where you opened the app. With a coding agent selected, each Chat message continues that agent's session under the same run rules. With Ensemble's agent selected, Ensemble Code reads the folder and can propose a task for an agent; it does not edit files or run commands itself.

## 1. Claude Code as the engine

Sign in to Claude Code on your computer. Ensemble uses your installed command or the copy supplied by the Claude app. It does not handle your Claude credentials or run Claude Code on its servers.

Choose Claude Code in Assign, then select an available model. Thinking levels, long context and fast mode appear only when that model supports them. The run reports a requested option it cannot apply.

Commands and edits follow the run's permissions. Questions and approvals appear in **Needs me**, including on the web or phone. In **Run unattended**, a question uses its recommended answer and records that decision on the task.

With Sandbox on (a beta, off by default; [24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)), Claude Code needs a supported sandbox on macOS or Linux. It cannot start sandboxed on native Windows or Linux without the required sandbox tools. The run explains what is missing. Its live log shows progress, tools, tokens and the final summary.

## 2. Codex as the engine

Sign in through the ChatGPT app or run `codex login` on the chosen computer. Ensemble uses the installed Codex or the app's copy with that existing account.

Choose Codex in Assign and review the available model, thinking and fast-mode options. Codex runs in the selected folder with the run's sandbox and internet choices.

Commands, file changes, requests for more access and questions go through the applicable run permissions. Questions appear in **Needs me**. Stop interrupts the current turn. The run keeps its progress, tool trace and final reply.

## 3. Cursor's agent and GitHub Copilot as the engine

Sign in on the computer before starting a run:

| Agent | Sign-in command |
| --- | --- |
| Cursor's agent | `cursor-agent login` |
| GitHub Copilot | `copilot login` |

You can also use **Sign in** in Settings → Models. Ensemble uses the agent's existing account and reports when it needs an update or sign-in.

The Cursor app and VS Code's Copilot do not include the agent Ensemble runs. With only the Cursor app, or VS Code with Copilot, Settings → Models shows **Set up**: it installs Cursor's agent or Copilot CLI on that computer with the vendor's own installer, then opens the sign-in.

Both agents send requested permissions to Ensemble. A permission granted for this call does not change the agent's permanent allowlist. Existing permissions you already saved in the agent can still let it act without asking Ensemble.

Copilot starts with the chosen model, thinking level and context window. An unavailable model stops the run; an unsupported level is skipped with a note. If Copilot reports a smaller context window than requested, the run says so. A locked keychain can temporarily prevent access to an existing Copilot sign-in.

### 3.1 Keeping a run going

A run can recover from a temporary network failure, provider error, stopped agent process or locked keychain. It retries after 15 seconds, one minute and two minutes, then reports the error if recovery fails. Missing agents, signed-out accounts, unknown models and exhausted limits are not retried.

Ten minutes without process output, a running tool or an open question counts as stuck. A single tool can run quietly for up to 60 minutes. Ensemble stops the agent and tries to continue the session. The run's own minutes limit still applies, excluding time waiting for you.

### 3.2 Choosing the model, thinking level, context window and fast mode

Choose the computer first so Assign can show the models that its agent reports. **Agent default** uses the agent's own choice. When no model list is available, the field can accept a typed model name.

Thinking, context window and fast mode appear only when supported. Thinking is a slider from the model's lowest level to its highest, its track warming as it goes up; **Auto** beside it leaves the level to the model and shows only where the model has a default level. Each level under the track can also be picked directly. Changing the agent or model resets incompatible options. Fast mode uses more of the plan in exchange for faster output. Run profiles, Quick assign, Run again and the CLI's `/model` preserve these choices.

### 3.3 Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code and Kimi Code

| Agent | Sign in on the chosen computer |
| --- | --- |
| Grok Build | `grok login` |
| OpenCode | `opencode auth login` |
| Gemini CLI | Start `gemini` and follow its sign-in prompts |
| Antigravity | Choose **Install and sign in** or **Sign in** in Settings → Models |
| Mistral Vibe | `vibe-acp --setup` or `vibe --setup` |
| Qwen Code | Start `qwen` and use its sign-in prompt or `/auth` |
| Kimi Code | `kimi login` |

Each uses its own account and available models. Ensemble checks tool requests and routes questions to Needs me. With the OpenCode app and no `opencode` command, Ensemble runs the copy the app runs itself.

The sandbox is a beta and off by default ([24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)), so these agents run as the others do. Grok Build, OpenCode, Antigravity, Mistral Vibe and Kimi Code have no OS sandbox Ensemble can enable; Gemini CLI and Qwen Code support it on macOS only. With the beta on, a run with Sandbox on stops when its agent cannot provide one: select a supported agent or turn the sandbox off for that run.

### 3.4 What the agent says it runs with

A run distinguishes the settings you requested, the settings sent to the agent and what the agent reported. Unsupported choices are explained in the run notes. A value the agent does not report is shown as **Not reported**; it is not guessed from your request.

## 4. In the agent's own app, or a terminal

On the computer's local runtime, open **Assign → More options → Open in the agent's own app**. Choose an existing folder, an earlier task's folder or a new empty workspace folder. Ensemble does not clone a repository for this handoff.

| Destination | What you do next |
| --- | --- |
| Claude app, Code tab | Confirm the folder and press Send |
| Codex in the ChatGPT app | Press Send |
| Cursor | Press Send |
| VS Code with Copilot agent | Press Send |
| Claude Code, Codex, Cursor's agent or Copilot CLI in a terminal | The task starts immediately |

The app uses its own settings and sign-in. Ensemble's run mode, sandbox and Git choices do not govern that app session. Connected hooks can relay its prompts to Needs me. Use **Done with it** on the task when the handoff is complete.

A hosted page cannot start this handoff on a paired computer. The other supported coding agents have no app handoff.

## 5. Prompts from the tools, and answering in either place

Connect an editor or agent through **Settings → Editors & agents → Connect**, or run `ensemble hooks connect <tool>` on the local runtime. Only sessions Ensemble opened are linked to Needs me.

Open **Needs me** in Ensemble or use `ensemble needs` to answer a question or permission request. Claude can show its own dialog alongside the card; the first answer counts. Other connected tools ask through Ensemble first, then fall back to their own prompt if Ensemble is unavailable or nobody answers in time. A hook never approves by itself.

For an Ensemble-run task, **Allow for this run** or **Deny for this run** applies to matching actions during that run. It does not change the agent's permanent permissions. Older paired computers may need an update to receive a whole-run answer; **Allow once** remains available.

Editor folder-trust prompts stay in the editor. They do not appear in Needs me.

## 6. Vendor and account boundaries

Ensemble starts the agent installed on your computer with its existing sign-in. It does not copy that sign-in into a hosted model API. Your provider's plan, entitlement and quota determine what the agent can use.

An agent you configured with its own model provider keeps that setup. Detecting an installed program does not prove that its account has access to every model. Read the agent's own message when sign-in, entitlement or quota prevents a run.

## 7. Limits

An agent's own plugins, skills, MCP servers and instructions can add substantial context to every message. Permissions you permanently allowed in that agent can run without another Ensemble prompt.

An engine-run session cannot be watched or continued live in the agent's app. Use the separate app handoff when that is the workflow you want. Supported session titles and project grouping are described in [Agent sessions](41_AGENT_SESSIONS.md).

An unanswered question lasts only as long as the agent continues waiting. If it stops waiting, Ensemble withdraws the card because an answer would have no recipient.

An agent can start sub-agents while it works. Their tool calls show in the run's trace marked "Sub-agent:", and their words are not the run's reply. Sessions an agent starts beside its own, such as a side session in the Claude app, a Codex sub-agent thread or a Cursor sub-agent chat, are not yet listed, named or deleted with the session that started them.

## 8. Your AI subscriptions for the assistant

Use an AI plan for the assistant, Ask Ensemble or routines without adding an API key. The plan's agent does the model work on your computer. Those calls do not spend Ensemble's included credits.

1. Open **Settings → Assistant → Models → Your AI subscriptions**.
2. Select the computer that has the agent installed and signed in.
3. Open **Manage subscriptions** if the plan is missing. Use its installation or sign-in action, then **Check again**. A computer with the Cursor app but not Cursor's agent, or VS Code with Copilot but not Copilot CLI, shows the plan as found with **Set up**, which installs the agent there and opens its sign-in.
4. Choose the plan for a tier, or choose **Use for everything**.
5. Select a supported model, thinking level and context window.

Claude and Codex tiles show usage windows when the agent reports them. Copilot shows the signed-in account and model cost/context information. If no computer is selected, Ensemble uses the most recently seen online computer with that agent signed in. In a shared space, it uses your computers, not the owner's.

### Working with tools and files on an AI plan

On a current runtime, an ordinary assistant chat, Ask or routine keeps the agent's own shell, file, web and built-in tools. Hard restrictions still block credentials, other accounts, Ensemble's data and code, system files and dangerous machine-control operations. Node turns use Ensemble's computer tools with owner approvals instead. One-off summaries and similar background completions do not receive unrestricted local tools.

Attach up to eight files to a message. Ensemble sends the originals to the computer; a file too large or unsupported for the agent's message is named with the reason. File delivery and format limits are in [Agents and attachments](38_AGENT_READABLE_FILES.md).

Each chat normally continues one agent session. A new chat starts fresh. Deleted or unavailable sessions restart with Ensemble's conversation context. See [Agent sessions](41_AGENT_SESSIONS.md) for continuation and cleanup.

### When an AI plan cannot answer

The message explains whether no computer is paired, the computer is offline, Ensemble needs updating, the agent is missing or signed out, or the plan has reached its limit. Follow that action on the selected computer, then retry. Switching to an available included model or your own API key is a separate choice.

## 9. The worker's report and evidence

Open a completed run to read its result, checks and attached evidence. The agent reports whether it is done, passed, failed or blocked, separately from its closing message. Evidence can include screenshots, video, traces, reports, logs and other files.

A run can attach up to **100 files**, each at most **100 MB**. Evidence is separate from ordinary Files. Credential files and files containing saved secret values are refused. Captures that need your preview stay on the computer until you release or discard them.

Use `ensemble evidence off` to keep evidence on the computer. The run then says it was not uploaded. Run evidence is removed from the computer 30 days after the run ends. See [Files](32_FILES.md#evidence-from-agent-runs) for reading and sharing evidence.

## 10. Support matrix

Choose the agent for the work and the computer's available permissions. All supported coding agents can receive tasks, report progress and results, continue sessions and route questions through Ensemble. Their model menus, sandbox support and app handoffs differ.

### 10.1 Coding agents

| Feature | Availability |
| --- | --- |
| Model selection | Models reported by the installed agent and its account |
| Thinking level | When the agent and selected model expose a level |
| Long context | Claude Code and supported Copilot models |
| Fast mode | Supported Claude Code and Codex models |
| Browser and capture | Through the computer's Ensemble tools, subject to the run mode |
| OS sandbox | A beta, off by default ([24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)); when on, agent- and platform-dependent: see each agent's section |
| Personal skills | The agent's own supported skill locations and trusted project configuration |

### 10.2 A node's brain

A node can use an included model, a supported API key or an AI plan on a paired computer. Local model servers must be reachable from the runtime using them. On a hosted account, use an AI-plan agent configured for your local model to run it on your computer.

The node's model is checked against everything its owner can use, including models beyond the first entries shown in the picker. Included calls use account credits; an AI-plan turn uses the plan and keeps a conversation session on the computer.

## In the code

A code task is done by one of:

- **Ensemble's agent**: Ensemble's own tool loop calling a model with the selected credential or funding source (`apps/hub-api/src/workspace/agent.ts`).
- **Claude Code**, **Codex**, **Cursor's agent**, **GitHub Copilot**, **Grok Build**, **OpenCode**, **Gemini CLI**, **Google Antigravity**, **Mistral Vibe**, **Qwen Code** or **Kimi Code** on the person's computer, signed in with their own account (§1–§3).
- **The agent's own app or a terminal**: the Claude app, Codex in the ChatGPT app, Cursor or VS Code; or Claude Code, Codex, Cursor's agent or Copilot CLI in a terminal window (§4).

The Assign dialog's agent picker picks one (or Auto: the agent Settings → Models names for the task's complexity); run profiles remember it. When Ensemble runs the task, the same run settings apply: mode (Ask, Review only, Run unattended), folder trust, sandbox, outside-folder access, git permission, internet and limits ([24](24_DESKTOP_SANDBOXING.md), [06](06_MODULE_WORKSPACE_AND_SURFACES.md)). In an agent's own app, that app's settings apply. A hosted Ensemble runs Claude Code, Codex, Cursor and GitHub Copilot tasks only on a paired computer.

Paths below are under `apps/hub-api/src/` unless qualified.

**From the terminal.** The `ensemble` app ([26](26_CLI.md)) starts the same runs: `/run <what to do>` creates a task and assigns it to the agent chosen with `/agent`, in the folder the app was opened in, under the profile chosen with `/profile` (`runRequest` in `apps/cli/src/tui/model.ts`).

**Chat with your own agent.** With Claude Code, Codex, Cursor's agent, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code or Kimi Code chosen, the app's Chat tab is that agent. Each message is a run with `chat: true` (`Assign.chat`, kept on the job's context; refused for Ensemble's agent), so every run rule applies.

- The first message says where the agent is (the terminal chat, the folder), the ensemble MCP tools and how the run works (`engineRules`). Later messages continue the run (`continueFromJobId`) and resume the agent's session from its `engine` event (`claude -p … --resume <session>`, Codex `thread/resume`, Cursor's and Copilot's `session/load`, whose replayed history is not part of the reply), and are sent as typed; the rules go again only when the person changed the run's settings since the last message (`chat_rules` event, `rulesHash`; `chatPrompt` in `workspace/agent.ts`).
- If the session cannot be reopened (`SessionGoneError`: deleted, or made on another computer) or the agent changes mid-chat, the message runs in a new session with the previous turn's summary. A Codex thread the ChatGPT app has open is waited for first, up to 10 minutes (`SessionBusyError` after that; [41 §1](41_AGENT_SESSIONS.md#1-coding-sessions-implementation-reference)).
- An assistant or node conversation on an AI plan (§8) whose session was deleted in the agent goes on in a new session that gets the instructions and the conversation so far. Copilot's `--session-id` would quietly start an empty session under the deleted one's id, so its session is looked up in Copilot's own `session-state` first (`copilotHasSession`); the other agents refuse to reopen one they no longer have.
- The chat's task stays In progress and gets no Agent report per turn.
- The run's MCP server (`scripts/ensemble-ask-mcp.mjs`, `ENSEMBLE_CHAT=1`) adds `ensemble_list_tasks`, `ensemble_create_task` (owner "me"; text goes on the task's page) and `ensemble_search` (notes, pages, tasks, meetings) to `ask_person`, answered by `POST /api/engine/tool` on loopback with the run's secret, chat runs only (`workspace/engines/chat-tools.ts`). The judge passes them without a prompt, as they touch only the person's own board.
- **The Code tab's agent** ([16 §9](16_CODE_TAB.md#9-the-agent)) sends the same chat turns with `surface: "code"`, from the browser, for this computer or a paired one, in a folder (its path goes as `codeFolder`, needs the `codeAgent` capability and is checked there against the folders Code may use) or in no folder (a new workspace folder). Its MCP server also runs with `ENSEMBLE_CODE_AGENT=1`: in place of the board's search it has the ranked `ensemble_search` and `ensemble_context`, and it has `ensemble_actions` and `ensemble_act` (pages, boards, diagrams, plots, tasks; the run allowlist) as a task run does. Its first message is `codeAgentIntro` (`workspace/agent.ts`).

**Agent sessions.** Runs that continue each other (`continueFromJobId`) with the same agent are one session of that agent: Continue an earlier task resumes it, a fitting session may be chosen for a new run, a project's tasks share one folder, the agents' own apps list Ensemble's sessions with titles and projects, and sessions of retired work are cleaned up. All of it is in [41 · Agent sessions](41_AGENT_SESSIONS.md).

**Ensemble Code.** With Ensemble's agent chosen, the Chat tab is Ensemble Code: the assistant with a code session (`assistant/tools/code.ts`). It reads, lists and searches the folder and reads PDF and Office files as text. Its one write, `ensemble_start_agent`, creates a task and starts the chosen engine on it with the profile's settings (or in a fresh clone when given a repository URL) through `createJob`, so every run rule applies.

It follows the assistant's write policy ([11 §6](11_HOW_THE_ASSISTANT_WORKS.md#6-apply-undo-and-dependent-actions)); applied from a proposal it is ledgered as `assistant.ensemble_start_agent`. Ensemble Code never edits files or runs commands itself, and the hosted API refuses it (409): it needs the runtime on the person's computer.

### 1. Claude Code as the engine: implementation reference

**Account boundary.** Ensemble starts the person's own unmodified `claude` with its own sign-in: the `claude` command on the trusted PATH (never inside the work folder; the PATH comes from the login shell and usual install folders such as `~/.local/bin`), else the Claude app's copy (§8; `claudeBinary` in `subscriptions/detect.ts`). Ensemble never offers a Claude login, reads Claude credentials or runs Claude Code on its servers; API-key variables are removed (§6).

**A run** (`workspace/engines/claude-code.ts`):

1. Ensemble prepares the folder, branch and trust as for its own agent.
2. It starts `claude -p <task> --output-format stream-json --verbose --permission-mode default --setting-sources <sources> --settings <per-run JSON> --mcp-config <per-run JSON> --max-turns <limit> [--model <model>] [--effort <level>]` in the work folder. Model, thinking level and context window go through `claudeLaunch` (`packages/shared-types/src/claude-models.ts`): the long window is the model id with `[1m]` (`claude-sonnet-4-6[1m]`), and each level is sent under the name that model takes (Opus 4.7's Extra high is `max`). A level or window the model does not take is left out with an `engine_note` on the run. `<sources>` is `user,project,local` in a folder the person trusted themselves, by name (a saved trust rule for that very folder, for good or for this task; `exactTrust`, `engineTrust` in `engines/registry.ts`), so the repository's own `.claude/` settings and hooks load as in their own Claude Code. Anywhere else, including folders inside a trusted one, the workspace and fresh clones, it is `user`, and they do not run.
3. The per-run settings add a **PreToolUse hook on every tool** (`scripts/ensemble-hook.mjs --engine`). It sends the call to `POST /api/engine/ask` on this computer with the run's secret, and Claude Code waits for the answer from the judge (`workspace/engines/judge.ts`):
   - **Inside the folder.** Edits and commands follow the mode: allowed in Review only and Run unattended; asked on Needs me in Ask unless the folder is trusted. A Bash command that only reads files in the folder runs without asking in every mode, as the person's own Claude Code, Codex and Copilot run it (`quietCommand` in `engines/judge.ts`; `quietRead` and `quietArgs` in `workspace/tools.ts`, also used by Ensemble's agent). Every program in it reads only (`ls`, `cat`, `grep`, `rg`, `find` without `-exec`/`-delete`/`-fprint`, `wc`, read-only `git status|log|diff|show`…); every name it reads, followed through links, and every match of its globs is in the folder; it runs in the folder, redirects only to device files, and has no `VAR=value` or `env` in front. Still following the mode: variables, `$(…)`, backticks and brace lists; pagers and tools that read a project config that can set one (`less`, `bat`, `ack`); `sed` and `curl`; options that start a program, write a file or follow links (`rg --pre`, `fd -x`, `sort -o`, `git diff --output`, `grep -R`, `diff -r`); git options before the subcommand; PowerShell and Windows. Read-only git also needs the sandbox and a repository config without a pager, diff or filter driver, fsmonitor or include.
   - **Outside the folder.** The zones and `outsideAccess` rules of [24 §3](24_DESKTOP_SANDBOXING.md#3-work-folder-and-outside-access) decide, for Ensemble's agent and every engine (`outsidePath` in `workspace/tools.ts`): reading goes ahead; Run unattended changes other folders in the workspace and the person's own folders; Review only and Ask ask once per folder before changing it, then work there freely for the run. A shell command is read the way a shell reads it (`workspace/shell-parse.ts`): quotes first, `cd` sets the folder later relative paths resolve in, redirects (`>`, `>>`) are writes, and code passed with `-e`, `-c` or `--eval`, a search pattern, a URL or `/dev/null` is not a path; a program writes unless it only reads (`readsOnly`). Claude Code's sandbox gets matching paths (`claudeFilesystem`, `engineSandboxPaths`). Keys, sign-ins and browser data (`SECRET_PATHS` in `workspace/guard.ts`), another account's files, Ensemble's own data and its git helper are always refused; start-up files (`.bashrc`, `.zshrc`, `.gitconfig`, launch agents), system folders and Ensemble's own code are refused for writes (`outsideRefusal`). The agents' own skill folders (§10) are read in every mode, and a skill's script run there is a read of that folder, not a change (`skillScript` in `engines/skills.ts`); a write there is judged like any outside folder. With No access, Claude Code's sandbox opens them for reading too.
   - **Git and GitHub** have no limits of Ensemble's own (`checkGit`): with No limits the engine commits, makes and switches branches, pushes any branch (force and deletes included) and opens, comments on or merges pull requests with `gh`, using the computer's own sign-in, approved like any command by the run's mode. Only the person's choices stop it: Local only refuses commits, merges, rebases and the like; Commit refuses pushes; "Ask me before each commit" asks each time; internet off refuses network git and `gh`. With a pull request plan, Ensemble also pushes, opens and merges it as the task says, for every engine ([24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)). With Local only, a commit made some other way (a script) is undone at the end; the files stay.
   - **`git clone` with the sandbox on is done by Ensemble.** Claude Code's sandbox blocks writes to `.git/config` and `.git/hooks` under the run folder (so a clone there fails), and loosening that would let a script plant a hook that runs unsandboxed later. For `git clone <https URL> [folder]` alone or first in a chain, the judge clones itself (`cloneForAgent` in `workspace/tools.ts`, rules in `workspace/clone.ts`) and tells Claude Code where the repository is. Only a public `https` URL without user name, query or port; no credentials or hooks (`--template=`; `file://` refused); into a new folder in the run folder, under Ensemble's sandbox with internet on. Kept flags: `--depth`, `--branch`, `--single-branch`, `--filter`, `--no-tags`, `--quiet`. The clone's `.git/config` and hooks stay read-only. A clone after other commands (`cd x && git clone …`) is refused with the reason. Files that can run code later (`folderOpen` task, `.envrc`, husky hooks, install scripts, Makefile) are flagged in the answer and run summary. With the sandbox off, Claude Code's git runs as usual. Ensemble's agent uses the same function; Codex and Cursor keep their own handling (their approval answers carry no message). A task can also name a repository at assignment (`repoUrl`), cloned as the run folder.
   - Privilege, persistence, keychain and machine-control programs (`sudo`, `crontab`, `launchctl`, `security`, `osascript`, `pkill`, `shutdown`, …; `isNeverProgram`) are refused. Programs that reach another computer (`ssh`, `scp`, `sftp`, `nc`; `isRemoteProgram`) need the internet and ask in Ask and Review only. Developer tools such as `docker`, `nohup`, `tmux` and `kill <pid>` follow the mode. With internet off, web tools are refused.
   - A refusal goes back to Claude Code with the reason, and it carries on.
4. **Questions.** Headless Claude Code has no question tool, so the run adds Ensemble's **`ask_person`** (MCP server `scripts/ensemble-ask-mcp.mjs`). It shows the question on Needs me with options, the recommended one and a free-text box; the call waits for the answer (app, web, phone or `ensemble needs`). Each engine gives this server a day-long tool timeout, as long as the card lasts (Claude Code `MCP_TOOL_TIMEOUT`, Codex `tool_timeout_sec`, Copilot the server's `timeout`: its default is 180 s, after which the agent got "Request timed out" and gave up). While it waits the server sends MCP progress notifications when the call carries a progress token. If the agent still stops waiting (`notifications/cancelled`), the server hangs up and the card is withdrawn (expired), here and on the web (`/api/devices/self/decisions/:id/close` with `expired`), since an answer would reach nobody. In Run unattended it returns the recommended option at once, and every such decision is listed on the task. A task run's server also has `report_result` and `attach_evidence` (§9). Agents that ask their own questions are asked the same way: Claude Code's `AskUserQuestion`, Codex's `item/tool/requestUserInput`, Cursor's `cursor/ask_question`, and a form an agent or an MCP server inside it sends (ACP's `elicitation/create`, OpenCode's question tool; an MCP server's form through Codex): each field is one question with its choices (`answerForm` in `engines/elicitation.ts`), unattended runs take the field's default or first choice, and a form asking for a password, key or token is declined.
5. **Sandbox.** With the sandbox on, Claude Code's own sandbox (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap on Linux) confines shell commands to the work folder, the cache and the folders the run was let into (Run unattended: also the workspace's folders and the person's own folders). A command it stops may be retried outside the sandbox (`dangerouslyDisableSandbox`); the hook judges that retry: allowed in Run unattended, in Review only when its outside paths are all in allowed folders, otherwise asked. Where it cannot run (native Windows; Linux without bubblewrap and socat) Claude Code does not start; Ensemble says so and the sandbox can be turned off for the run. Internet off is an empty domain list.
6. **Progress and trace.** The stream (`system/init`, `assistant`, `user`, `result`) feeds progress, live log, tool count, tokens and reported cost, and the run's trace (`EngineTrace`, `workspace/engines/trace.ts`): thinking, messages, and each tool call as one step (name, summary, input, then output and duration from its `tool_result`; failed if marked an error), in the engine's order. A sub-agent's messages (the Agent tool; they carry `parent_tool_use_id`) are not the run's (`workspace/engines/sub-agents.ts`): its tool calls are steps whose summary starts "Sub-agent:", and its words, thinking and context size are left out. A run whose background sub-agents finish after its answer answers again (Claude Code 2.1.3xx sends another `system/init`, then another `result`): the last result is the summary, `num_turns` adds up, and tokens and cost are the sum of each result's `model_usage_since_last_result`, which covers that stretch only, sub-agents included. `total_cost_usd` counts the whole session instead, the earlier runs of a resumed one too, so it is used only by a Claude Code without that field, with each result's own `usage` for the tokens. Previews only (`TRACE_PREVIEW`): input 600 characters, output 1,200, thinking and messages 2,000, final answer 20,000; at most 600 steps. Secrets are redacted by shape (`lib/redact.ts`), and a call reading a secrets file (`.env*`, private keys, `.npmrc`, `.netrc`, credentials files) gets no output. Open calls end when the run stops or fails. The Runs page shows the trace ([02](02_MODULE_INTERACTION_HUB_UI.md)); a paired computer sends the same previews to the web ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). The final reply is the task summary; model, cost estimate and changed files (names, line counts) are kept on the job (`evidence`).

A task assigned on the web with Claude Code runs the same way on the paired computer; its Needs me cards reach the web and phone through it ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

**Models:** the ones Claude Code itself lists for the plan (§8: its `initialize` reply, each with its thinking levels and whether it has fast mode), with each model's context window and default level from `CLAUDE_MODELS` (`claude-models.ts`: a fixed 1M or 200K, or 200K with a 1M choice; aliases `opus`, `sonnet`, `haiku` and `fable` follow the newest of each), then the earlier models that version still runs (`minVersion`). Before the computer reports, the table stands in. The table follows T3 Code's model manifest (MIT).

**Fast mode:** the per-run settings carry `fastMode: true` for a model that has it; one without it runs at its usual speed with an `engine_note`.

### 2. Codex as the engine: implementation reference

**Account boundary.** Ensemble starts the person's own Codex through `codex app-server` (JSON lines over stdio, `workspace/engines/codex.ts`): `codex` on the trusted PATH, else the ChatGPT app's copy (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` on macOS, under `%LOCALAPPDATA%\OpenAI\Codex\bin\` on Windows, `/usr/lib/chatgpt/resources/codex` on Linux), which shares the `~/.codex` sign-in. Ensemble never signs in for the person or reads `auth.json` or the keychain, and refuses to start when `account/read` says Codex is not signed in ("Open the ChatGPT app (or run `codex login`) and sign in").

**A run:**

1. `initialize` (`clientInfo.name: "ensemble"`), `account/read`, then `thread/start` in the work folder with:
   - `approvalPolicy` (`codexApprovalPolicy`): `untrusted` (Codex asks before each command it does not consider safe) with the sandbox off, or in Ask mode in an untrusted folder; otherwise `on-request` (asks only to leave its sandbox).
   - `sandbox`: `workspace-write` with the sandbox on, `danger-full-access` with it off. `turn/start` passes `sandboxPolicy.workspaceWrite` with the work folder and cache as writable roots (plus home folders with **Read and write** outside access; never a folder another run is changing, [24](24_DESKTOP_SANDBOXING.md) "Two runs, one folder") and the run's internet setting. Codex's own sandbox (Seatbelt, bubblewrap, its Windows sandbox) confines it; Ensemble does not nest its own.
   - `config.projects[<folder>].trust_level` for this thread: `"trusted"` in a folder the person trusted by name (`engineTrust`, as for Claude Code), so the folder's `.codex/` hooks, rules and MCP servers run as in their own Codex; `"untrusted"` anywhere else, so they do not.
   - `config.mcp_servers.ensemble`: the same `ask_person` server with the run's secret.
   - `turn/start` carries the run's thinking level as `effort`, checked as for Claude Code, and with fast mode the model's fast service tier as `serviceTier` (from `model/list`: the tier named Fast, `priority`, else the `fast` speed tier; `codexFastTier`).
2. Codex's requests are answered by the same judge (`answerCodex`):
   - `item/commandExecution/requestApproval`: the command (or network host) is judged, in the folder Codex says it runs it in (`cwd`); `accept` or `decline`.
   - `item/fileChange/requestApproval`: the files from its `item/started` are judged as writes; a change whose files Ensemble did not see is declined.
   - `item/permissions/requestApproval`: internet and folders are granted only as far as the run allows, for that turn.
   - `item/tool/requestUserInput`: each question goes to Needs me (the recommended option in Run unattended).
   - `mcpServer/elicitation/request`: Ensemble's own server never asks; another MCP server's form with fields is the person's question (§1 step 4), and one without fields (approving one of its tools) is judged as that server's tool.
   - Sign-in token refreshes, attestation and unknown requests are never handled.
3. `item/*` notifications feed the live log and tool count, `thread/tokenUsage/updated` the tokens; the final agent message is the summary. Notifications are handled concurrently; `turn/completed` ends the turn after every earlier one is handled (at most 10 s more), so the final message and the last tool calls are in. The trace (§1 step 6): each command, file change and MCP call is a step from `item/started` to `item/completed` (output, exit code, time), reasoning items are thinking, earlier agent messages are messages. A sub-agent (`spawn_agent`) is a thread of its own whose notifications arrive on the same connection, often before the run's: only the run's own thread (`threadId`) gives the summary, the tokens and the turn's end. A sub-agent's commands, file changes and MCP calls are steps whose summary starts "Sub-agent:"; its messages and reasoning are left out. Stop sends `turn/interrupt`, then ends the process.

Tests: `engines/codex.test.ts`, `engines/codex.e2e.test.ts` (with a stand-in `codex`).

### 3. Cursor's agent and GitHub Copilot as the engine: implementation reference

Both are driven through ACP, the Agent Client Protocol (JSON-RPC lines over stdio). Every `session/request_permission` is read as a tool call and judged by the same rules as §1; the answer is **allow-once or reject-once, never allow-always**, which would change the person's own allowlist in that tool. `session/update` feeds the live log, tool count, the reply (the task summary) and the trace: `tool_call` to its last `tool_call_update` is one step; `agent_thought_chunk` is thinking. Stop sends `session/cancel`. A chat message continues the agent's session with `session/load`.

**Cursor's agent.** Ensemble starts the person's own `cursor-agent` (on the trusted PATH, or where Cursor's installer put it: §8 *Detection*): `cursor-agent --sandbox enabled|disabled --workspace <folder> acp` (`workspace/engines/cursor.ts`). It uses the existing login (`authenticate` with `cursor_login`); without one it stops with "Run `agent login` there". A run: `initialize`, `authenticate`, `session/new` in the work folder with the `ask_person` MCP server, then `session/prompt` with the task, a new session's with the task's title alone on its first line, since Cursor takes no name for a session and names it from that message ([41 §3](41_AGENT_SESSIONS.md#3-in-the-agents-own-apps-implementation-reference)). Cursor's own sandbox is on when the run's is.

`cursorCall` reads a command as an `execute` call titled with the command, an edit by its path, and an MCP tool by its `server: tool` title (Ensemble's own tools pass; its browser and capture tools follow the mode). `cursor/ask_question` and form questions (`elicitation/create`) go to Needs me (recommended option in Run unattended; a typed answer goes back verbatim). Tests: `engines/cursor.test.ts`, `engines/cursor.e2e.test.ts`.

**GitHub Copilot.** Ensemble starts the person's own `copilot` (on the trusted PATH, or where its installers put it: §8 *Detection*) with the sign-in it already has (`workspace/engines/copilot.ts`, `subscriptions/copilot.ts`): `copilot --acp --no-auto-update --no-ask-user --additional-mcp-config @<file> --allow-tool 'ensemble(ask_person)' … --disallow-temp-dir [--sandbox] [--context long_context]`.

Copilot's ACP accepts only http MCP servers from the client, so the run's `ask_person` server (and Chat's board tools) comes in through a per-run config file (mode 0600, removed at the end, `timeout` one day so `ask_person` waits for the person); `--allow-tool 'ensemble(<tool>)'` lets Ensemble's own tools run without asking (`ENSEMBLE_OWN_TOOLS` in `engines/judge.ts`: `ask_person`, `report_result`, `attach_evidence`, `ensemble_context`, `secret_http` and Chat's board tools), while its browser and capture tools are asked about and judged by the run's mode like any MCP tool, and `--no-ask-user` sends every question through `ask_person` to Needs me.

A session that starts with the person's own `/allow-all` on, or in autopilot or plan mode, is set back to `allow_all: off` and the agent mode before the task goes (`askingCopilot`): left on, Copilot would ask nothing and the judge would see no call. One that cannot be set back is not run. A new task's session is then named after the task with Copilot's own `/rename <title>` when the session lists that command, else its first message leads with the title ([41 §3](41_AGENT_SESSIONS.md#3-in-the-agents-own-apps-implementation-reference)).

- **Model, thinking and context.** The task's model, thinking level and context window are given as Copilot starts (`--model`, `--reasoning-effort`, and `--context long_context` for the long window: `contextTier` on the assignment, kept on the job's context and sent to a paired computer as `contextTier`). Switching the model over ACP afterwards puts the session on that model's standard window, so `session/set_config_option` (`model`, `reasoning_effort`) is used only when Copilot did not start on them, and the run then notes that the window may be the standard one. A model the plan does not offer stops the run with that sentence; a level the model does not take is skipped with a note. A run whose reported window is smaller than the long window chosen gets a note saying so. Copilot's `usage_update` (tokens in use, window size) is recorded on the run as `engine_context`; tokens come from each `session/prompt` result.
- **Sub-agents.** A sub-agent Copilot starts with its task tool reports on the run's session, each update marked with `_meta["github.com/copilot"].agentId`: its message and thought chunks are not the reply or the run's thinking, and its tool calls are steps whose summary starts "Sub-agent:".
- **Permissions.** `copilotCalls` reads an `execute` request by its `command`, an `edit` by `rawInput.fileName` and every `locations` path (a patch over several files is judged for each), `read` and `search` by path, `fetch` by URL, and anything else as an MCP tool named by the `<server>-<tool>` title of its `tool_call` update. Reads inside the work folder do not ask; reads outside it, edits, commands, fetches and MCP tools do.
- **Refusals.** Copilot ends its turn when a call is refused. The reasons go back as the next message ("Ensemble refused these tool calls … Continue the task another way within the rules, or finish and say what is left"), at most `REFUSAL_FOLLOW_UPS` (6) times; Copilot's "Operation cancelled by user" note is left out of the reply.
- **Attachments.** The task's originals are copied as for the other engines ([32](32_FILES.md)) and also sent with the first message: images inline (up to 3 MB, when the model takes images), other files as `resource_link`s.
- **Sandbox.** With the run's sandbox on, Copilot's own command sandbox (`--sandbox`: Seatbelt on macOS; bubblewrap with a private network on Linux, which needs `bwrap`, `slirp4netns`, `unshare`, `nsenter`, `iptables` and `/dev/net/tun`) confines its shell commands. Where it cannot run, the run stops with what is missing; with the sandbox off, Ensemble still judges every call Copilot asks about.
- **Sign-in.** Without one, the run stops with "Run `copilot login` there (or press Sign in under Settings → Models)". Copilot answers "Authentication required" both when signed out and when the system keychain holding its sign-in cannot be read (locked, or not ready right after a restart). When its `config.json` lists a signed-in account (`copilotSavedSignIn`, account names only), the run treats it as the keychain and tries again (§3.1); the computer's agent check reports the sign-in as unknown rather than signed out.

A paired computer advertises the engines its runtime has (`capabilities.engines`; runtimes without the list have Claude Code, Codex and Cursor's agent). Assigning GitHub Copilot to a computer whose Ensemble is older is refused with "update it on that computer".

### 3.1 Keeping a run going

Every engine runs under a watch (`workspace/engine-watch.ts`, used by `executeJob` in `workspace/agent.ts`):

- **Stuck.** Quiet for 10 minutes (no output from the engine's process, no tool call running, no question open on Needs me) counts as stuck; one tool call may run quietly for 60 minutes. The engine is stopped and its session carried on.
- **Failures that pass.** The network or the provider's servers, the engine's process dying, or a locked keychain after a restart: the run waits 15 s, 1 min, then 2 min and carries the same session on (`session/load`, `--resume`, the Codex thread) with a message saying why it stopped and to check the files before going on. After 3 tries it ends with the engine's own error. Signed out, not installed, an unknown model and limits are not retried.
- **Minutes.** The run's minutes limit (time on Needs me excluded) ends it as a limit, work kept.

Each carry-on is an `engine_retry` event on the run; its open tool calls end as skipped and the trace goes on.

### 3.2 Choosing the model, thinking level, context window and fast mode

The Assign dialog (`components/agent/assign-dialog.tsx`) offers the same menus for every coding agent, from the models the chosen computer reports (`computerAgent` and `engineModel` in `apps/hub-web/lib/engine-models.ts`): Claude Code from `CLAUDE_MODELS` for its installed version (Ensemble's own table before the computer reports), Codex from `model/list` (each model's levels, default level and whether it takes images), GitHub Copilot from `models.list` (cost, levels, two windows), Cursor's agent from `cursor-agent models` (names only), the ACP agents as §3.3 says. *<Agent> default* comes first; a typed model when the computer listed none.

Under it are the model's facts (vendor, cost, context sizes); *Thinking* appears when the model has levels (its own default named, "Default (Medium)"), *Context window* when it has two, and *Fast mode* when the model has one (faster output that uses more of the plan: Claude Code's `fastMode`, Codex's fast service tier). A model without the chosen level or long window resets that choice, and so does changing agent.

The dialog says when the agent is not signed in on that computer (with its login command), when Ensemble there is too old to run it, or what its check reported. For an agent with no OS sandbox there (`engineSandboxes`) and the sandbox beta on, it says the agent runs without it and sends the run that way (§3.3).

`engineAssign` sends `model`, `reasoningEffort`, `contextTier` and `fast` for every agent; the runner on the computer checks them again against that model, and one the model does not take is left out with an `engine_note`. Fast mode is kept on the job's context (`fastOf`) and sent to a paired computer as `fast`. Run profiles, Quick assign, Run again and the assistant's `hub_assign_agent` keep all four; the CLI's `/model` offers the same choices ([26](26_CLI.md)). Tests: `engines/copilot.test.ts`, `engines/copilot.e2e.test.ts` (with a stand-in `copilot`).

### 3.3 Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code and Kimi Code

These seven run through one ACP runner (`workspace/engines/acp.ts`, `ACP_AGENTS`), each the person's own agent with its own sign-in. On Windows an agent installed with npm is a `.cmd` shim, which Windows cannot start without a shell: Ensemble starts Node with the script the shim names instead (`hostLaunch` in `workspace/policy.ts`, Node beside the shim when there is one), for the run, the check, the sign-in window and session deletion (`AcpLaunch.base`).

| Agent | Started as | Sign-in | Ensemble keeps from it |
|---|---|---|---|
| Grok Build | `grok --permission-mode default agent stdio` (on the command line, so a saved always-approve does not apply); `authenticate` with `cached_token`; `initialize` `_meta.clientType: "extension"` | `grok login` | `XAI_API_KEY` |
| OpenCode | `opencode acp` (or the copy the OpenCode app runs: §8 *Detection*) with `OPENCODE_PERMISSION` (and the same rules in `OPENCODE_CONFIG_CONTENT`, for an OpenCode that predates it) asking before every edit, command, fetch, subagent and outside path (`OPENCODE_PERMISSIONS`; reads, searches and its own bookkeeping go ahead) and `OPENCODE_DISABLE_AUTOUPDATE`; in a folder the person did not trust by name, `OPENCODE_DISABLE_PROJECT_CONFIG`, so the repository's own `opencode.json`, agents and plugins do not load | `opencode auth login` (any provider OpenCode signs in to: Zen, Claude, ChatGPT, Copilot…) | the API-key variables of §6 |
| Gemini CLI | `gemini --acp --approval-mode default` (`--experimental-acp` on a Gemini CLI from before the rename, read from its help) and `--model` | `gemini`, whose first start asks how to sign in (Sign in with Google) | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI` |
| Antigravity | Google's ACP agent server, which Ensemble installs (below), `--uid=` on Linux; `authenticate` with `oauth-personal`; a session that starts in another mode is set to `default`, the one that asks (or not started); reopens a session with `session/resume` | Sign in under Settings → Models | Google API-key and cloud variables; its own `GEMINI_HOME` |
| Mistral Vibe | `vibe-acp`; a session is set to Vibe's `ask` agent (its default `accept-edits` writes without asking); a folder's own `.vibe/` settings, agents and skills load only where the person trusted it in Vibe (shared trust, [24](24_DESKTOP_SANDBOXING.md)) | `vibe-acp --setup` (`vibe --setup`): the Mistral account in the browser, or an API key | `MISTRAL_API_KEY` |
| Qwen Code | `qwen --acp --approval-mode default` (`--experimental-acp` on an older one) and `--model`; built from Gemini CLI | `qwen`, whose first start asks how to sign in (`/auth`: the Qwen account with a Plus or Pro plan, or a provider key) | the API-key variables of §6 |
| Kimi Code | `kimi acp` (Kimi Code CLI, which replaced the archived Python Kimi CLI); `authenticate` with `login`; every session starts in `default`, which asks before edits and commands, and is set back to it if not; `KIMI_CODE_TRUST_WORKSPACE=1` only in a folder the person trusted by name in Ensemble, removed otherwise | `kimi login` (device code: a link and a code) | `MOONSHOT_API_KEY` |

A run is the Copilot run of §3 with the agent's own names: `initialize`, `authenticate` where the agent has a stored sign-in, `session/new` in the work folder with the `ask_person` MCP server (stdio), then the model and thinking level from the session's own options (`configOptions` with category `model` and `thought_level`, set with `session/set_config_option`; an older agent's `models` and `session/set_model`). None of them takes a name for a session, so a new session's first message has the task's title alone on its first line ([41 §3](41_AGENT_SESSIONS.md#3-in-the-agents-own-apps-implementation-reference)). A model the account does not offer stops the run with that sentence; a level the model does not take is left out with an `engine_note`.

Every `session/request_permission` is read by `acpCalls` (a command from `rawInput.command` as a string or argv, or a backticked title; paths from `locations`, a diff's `path` and `rawInput`; an MCP tool as `server: tool`, `server-tool` or `mcp__server__tool`) and judged as in §1, answered allow-once or reject-once, never "always" (for Grok and OpenCode "always" is project-wide).

Ensemble offers form questions (`clientCapabilities.elicitation.form`), so an agent's `elicitation/create` (OpenCode's question tool) reaches the person as `ask_person` does (§1 step 4); without it OpenCode tells its model the question could not be shown. Refusals go back as the next message, at most `REFUSAL_FOLLOW_UPS` times. `usage_update` is recorded as `engine_context`. A chat message continues the session.

**Sandbox.** Grok Build, OpenCode, Antigravity, Mistral Vibe and Kimi Code have no OS sandbox Ensemble can turn on, and Gemini CLI and Qwen Code have one only on macOS (`--sandbox`, Seatbelt). The sandbox is a beta and off by default ([24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)); with it on, a run with Sandbox on stops with "<agent> has no OS sandbox Ensemble can turn on here. Turn the sandbox off for this run: Ensemble still judges every command, edit, outside read and fetch <agent> asks to make."

**Antigravity's install** (`subscriptions/antigravity.ts`). Google publishes the agent as a zip per platform on `dl.google.com` (`agy-acp-server-1.3.0-<os>-<arch>.zip`, a few hundred MB). Sign in (or *Install and sign in* on its tile) downloads it once, checks it against the pinned SHA-256 and unpacks it (`ditto`, `unzip`, Python's `zipfile` or `tar`) into `<state>/agents/antigravity/versions/1.3.0/`.

It then starts the server with `GEMINI_HOME=<state>/agents/antigravity/home` and `AGY_ACP_FORCE_FILE_STORAGE=1`, calls `authenticate`, and opens the Google sign-in link the server prints (`Open the following link to authenticate the ACP server: …`) in the browser; Google answers on the server's own 127.0.0.1 address, and the sign-in stays in Antigravity's file in that home. A run that meets the link instead says it is not signed in. Release table and environment follow T3 Code (MIT).

### 3.4 What the agent says it runs with

A run's settings are recorded three ways ([35 §8.10](35_ENSEMBLE_NODE.md#810-run-settings)): as asked, as sent, and as the agent itself reported them. Each adapter reports only what its agent says, never what was asked (`workspace/engines/observed.ts`): `observed` on its `engine` event, and the window it used on `engine_context` (`size` in tokens, `context` when the model's windows are known; within 5% of the long window is the long one).

| Agent | Model | Thinking level | Context window | Fast mode |
| --- | --- | --- | --- | --- |
| Claude Code | `model` in its `init` message | not reported | the main model's `contextWindow` in the result's `modelUsage` (a fixed 1M window counts as long) | not reported |
| Codex | `model` in the `thread/start` or `thread/resume` reply | the thread's `reasoningEffort`, only when the turn sets none (Codex does not echo a turn's own) | `modelContextWindow` in `thread/tokenUsage/updated` (one window: `default`) | not reported |
| GitHub Copilot | the session's `model` option after it starts | the session's `reasoning_effort` option | the window in `usage_update`, against the model's long window as the computer listed it | None |
| Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code | the session's model option (an older agent: the model it accepted) | the session's thought-level option | the window in `usage_update`, in tokens | None |
| Cursor's agent | the session's `currentModelId`, when it reports one | None | the window in `usage_update`, when it sends one | None |

The computer sends the result with its progress when it changes and with complete (`observed`, and `totals.observed`; [25 §4.1](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#41-account-and-device-routes)), and the server keeps it on the job (`workspace_jobs.observed_settings`). A run on this server is read from its own events. Anything not reported shows as "not reported": a runtime before this release reports only the model, from its `engine` event.

### 4. In the agent's own app, or a terminal: implementation reference

Assign → More options → **Open in the agent's own app** opens the task in an app found on this computer (`GET /api/agent/apps`) on a folder: one of the person's, an earlier task's, or a new empty one in the workspace (Ensemble does not clone for an app). `POST /api/agent/handoff`, `workspace/handoff.ts`:

| App | How it opens | The person |
|---|---|---|
| Claude app (Code tab) | `claude://code/new?folder=…&q=…` | Confirms the folder, presses Send |
| Codex in the ChatGPT app | `codex://new?path=…&prompt=…` | Presses Send |
| Cursor | The folder in Cursor, then `cursor://anysphere.cursor-deeplink/prompt?text=…` | Presses Send |
| VS Code (Copilot agent) | `code -n <folder>`, then `code chat -r -m agent "<prompt>"` | Presses Send |

**In a terminal**: Claude Code, Codex (its CLI or the ChatGPT app's copy), Cursor's agent or Copilot CLI starts in a terminal window on the folder with the task as first prompt (`claude "…"`, `codex "…"`, `cursor-agent "…"`, `copilot -i "…"`) and begins at once. The window is Terminal on macOS (a `.command` file), the first terminal found on Linux, PowerShell on Windows (an encoded command); `terminalScript` quotes the prompt so nothing in it runs as a command.

Vendors let another app fill in a prompt but not send it, so in an app the person presses Send. The prompt ends with a marker (`Ensemble task ens-…`); the agent's `UserPromptSubmit` hook (or a hook in the hand-off's folder, for tools that never see the prompt) links that session to the hand-off.

From then on its permission prompts and questions reach Needs me, and the task page shows "In Claude", then the agent's last words when a turn ends (`Stop`), until the person presses "Done with it". The app uses its own settings and sign-in; Ensemble's mode, sandbox and git choices do not apply. Only the runtime on the person's computer opens apps; the hosted site refuses with 409.

### 5. Prompts from the tools, and answering in either place: implementation reference

The same hook, installed into each tool's settings, sends prompts to Needs me: Settings → Editors & agents → **Connect** (desktop app or the CLI's runtime), `ensemble hooks connect <tool>`, or `node scripts/ensemble-hook.mjs install --target cursor|claude|codex|copilot-cli|vscode --token …`. Connect signs the hook in with a **`hooks` key**: it can open a card, wait on it, withdraw it and report session activity, never answer a card (`hooksTokenRejected` in `bridge/auth.ts`).

**Which sessions.** Only tasks Ensemble opened in the tool (§4) reach Needs me, identified by the prompt marker or an already linked session; folder proximity is not enough. Any other session gets `skipped` at once. `orchestration.editorRequests` is always `ensemble` (a saved `all` reads as `ensemble`). In a run Ensemble started (§1–§3), the engine channel answers and the person's own hook steps aside (`ENSEMBLE_RUN`).

| Tool | Asks | Reports | Answer in either place |
|---|---|---|---|
| Claude Code and the Claude app | `PermissionRequest`, including `AskUserQuestion` (answered with the questions' `answers`) | `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop` (in the background) | **Yes.** Claude's dialog stays open beside the card; the first answer counts. Answered in Claude, the card closes ("Answered in Claude Code") when the tool runs, the turn ends or the next prompt is sent |
| Codex (CLI and ChatGPT app) | `PermissionRequest` | `PostToolUse`, `UserPromptSubmit`, `Stop` | Ensemble first; if nobody answers in time, Codex asks itself (its prompt cannot race the hook). Approve the hooks once in Codex (Settings → Hooks, or `/hooks`) |
| GitHub Copilot CLI | `preToolUse` | `postToolUse`, `userPromptSubmitted`, `sessionEnd` | Ensemble first, then Copilot |
| Cursor | `beforeShellExecution`, `beforeMCPExecution` | `afterShellExecution`, `afterMCPExecution`, `beforeSubmitPrompt`, `stop` | Ensemble first, then Cursor |
| VS Code (Copilot agent) | `PreToolUse` | `PostToolUse`, `UserPromptSubmit`, `Stop` | Ensemble first, then VS Code |

Reporting hooks wait at most 5 s and never block the tool. `POST /api/decisions/activity` links the session, closes cards answered in the tool (status `settled`; the waiting hook lets go) and records a hand-off's progress. An answer applies once, for the session, or always. If Ensemble is unreachable or nobody answers in time, the tool shows its own prompt; the hook never allows by itself. `ensemble needs` lists these too.

**Answers in a run Ensemble started** (§1–§3). *Allow for this run* (`scope: "session"`) is kept as a rule of that run (`RUN_RULE_SOURCE`) and read before the person is asked again (`runRule` in `workspace/tools.ts`).

It covers the same command with other arguments (`commandKind` in `workspace/command-kind.ts`: the program and its script or what it does, as `python3 <script>`, `npm run build`, `git commit`, `npx playwright test`; never inline code, a variable, `VAR=value` in front, another computer, or a command with an option before what it does, which match only themselves), an edit anywhere in the run's own folder, a fetch from the same site, and the run's other browser tools (or capture tools). *Deny for this run* covers the same.

A run on a paired computer takes it from the web and the Node chat too: the computer reports `capabilities.runAnswers: 1`, the web takes *for this run* on a permission (never a question or a push) only for such a computer ("Update Ensemble on <computer> to allow this for the whole run from here. Allow once works now." otherwise), and the computer keeps the rule for its run (`judgeAnswer` in `remote/policy.ts`).

The agents' own "always" is never chosen: Ensemble's run rule answers the agent's next ask at once (Claude Code's hook sees every call, so a Claude `updatedPermissions` session rule would add nothing), while an agent's "always" changes the person's own allowlist (Copilot keeps it per folder in `~/.copilot/permissions-config.json`, Cursor in its allowlist, Grok and OpenCode for the project) and hides later calls from the judge.

### 6. Vendor and account boundaries: implementation reference

Engine adapters and subscription turns launch the person's installed, unmodified program with its own sign-in and never copy a vendor token into a hosted model API. Variables that would bill an API account instead of the plan are removed from the program's environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` for Codex, `CURSOR_API_KEY` for Cursor (`KEY_VARIABLES` in each engine).

The ACP agents (§3.3), subscription turns (§8) and detection drop all of them plus `XAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `ENSEMBLE_DESKTOP_TOKEN` and `ENSEMBLE_INTERNAL_TOKEN` (`agentEnv` in `subscriptions/detect.ts`). GitHub Copilot, as an engine, in a subscription turn and in detection, also loses `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` (which would replace its stored sign-in and reach its shell commands) and `COPILOT_ALLOW_ALL` and `COPILOT_ASSISTED_APPROVAL` (which would approve tool calls without asking), and runs with `COPILOT_AUTO_UPDATE=false` (`copilotEnv` in `subscriptions/copilot.ts`).

A tool the person set up with its own model provider (their Codex `config.toml`, Claude Code settings, Copilot's `COPILOT_PROVIDER_*`) runs as set up: the variable a Codex provider reads its key from (`env_key`) is kept even when it is one of the variables above (`codexEnv` in `subscriptions/detect.ts`). Detecting a binary does not prove a plan or model entitlement; the tool reports its own account and quota errors. Vendor terms are the operator's to review.

**A runtime started inside a Claude session.** Claude in the Claude app's Code tab can start the runtime itself (`pnpm dev`, `ensemble runner start`); the runtime then inherits what the app sets for that session and what the session sets for each command it runs.

Engines, subscription turns, detection, and the terminals, editors and links that hand-offs (§4) and sign-ins (§8) open run without those variables (`withoutHostSession` in `subscriptions/host-session.ts`, in `agentEnv`, each engine's environment and `launch` in `workspace/handoff.ts`), so Claude Code does not wait for the app's sign-in ("Not logged in"), call itself the app or reach the app's messaging socket: Claude Code's marks on a session's commands (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`), the app's entry point, sign-in and account (`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_SUBSCRIPTION_TYPE` and the like), and the `CLAUDE_CODE_HOST_*`, `CLAUDE_CODE_DESKTOP_*`, `CLAUDE_CODE_SDK_HAS_*` and `CLAUDE_AGENT_SDK_*` families.

Where the app manages the provider (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` set: a gateway or a cloud provider), it has written its own provider over the person's, so the provider variables go too: `CLAUDE_CODE_USE_*`, `ANTHROPIC_BASE_URL` and the other base URLs, `ANTHROPIC_CUSTOM_HEADERS`, the provider's project, region and keys, and the model names (`ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`). Claude Code then uses the person's own sign-in and settings (`~/.claude/settings.json`). Anywhere else the provider variables are the person's own and pass through, as do their other `CLAUDE_CODE_*` settings.

### 7. Limits: implementation reference

- GitHub Copilot loads the person's own Copilot setup as it would in a terminal: their plugins, skills, MCP servers and custom instructions (`AGENTS.md` and the like in the folder). With many plugins or MCP tools, each message carries a large fixed context. A tool the person already allowed "always" in Copilot for that folder (`~/.copilot/permissions-config.json`) runs without asking, so the judge does not see it; the same holds for a command in Cursor's own allowlist and a tool in Gemini CLI's `tools.allowed`. Copilot's `/allow-all` and autopilot are turned off for the run (§3).
- An engine run cannot be watched or continued in the agent's own app, and hand-offs (§4) cannot be started on a paired computer from the web. Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code and Kimi Code have no hand-off.
- Grok Build, OpenCode and Gemini CLI load the person's own setup (their MCP servers, Gemini's and OpenCode's global settings and instructions). `ask_person` waits as long as the agent's own MCP request timeout allows; when the agent gives up, the card is withdrawn (§1 step 4).
- Sub-agents that live in their own session are not tracked yet: a Claude app side session or fork (`spawnedFrom.sessionId`, `forkedFromSessionId` in its Code tab record), a Codex sub-agent thread (`source.subagent.thread_spawn.parent_thread_id`; `thread/delete` on the parent removes it), a Cursor sub-agent chat (`~/.cursor/chats/<hash>/<id>`, `subagentInfo.parentAgentId`). Deleting the session leaves the Claude app's and Cursor's behind ([41 §6](41_AGENT_SESSIONS.md#6-deleting-and-cleaning-up-implementation-reference)).
- The VS Code and Cursor editors' own folder-trust prompts do not reach Needs me. VS Code's Copilot sign-in is reachable only through the hand-off (§4); code runs and subscription turns use Copilot CLI's sign-in.

### 8. Your AI subscriptions for the assistant: implementation reference

The assistant (the dock, `@ensemble` on a page, the Ask panel) and Ensemble's quick model calls (triage, summaries, a tier's Test) can run on the person's own Claude, ChatGPT, Cursor, GitHub Copilot, Grok, OpenCode, Gemini, Antigravity, Mistral Vibe, Qwen Code or Kimi Code plan instead of an API key. The plan's agent does the thinking on the person's computer with the vendor's sign-in; Ensemble's tools and data stay where they are. Nothing is billed through Ensemble, and Ensemble never sees the sign-in.

**Choosing it.** Each subscription is a model provider: `claude-code`, `codex`, `cursor-agent`, `copilot-cli`, `grok-cli`, `opencode`, `gemini-cli`, `antigravity`, `mistral-vibe`, `qwen-code`, `kimi-code` (`SUBSCRIPTION_PROVIDERS` in `packages/shared-types/src/subscriptions.ts`). A tier set to one (Settings → Assistant → Models → *Your AI subscriptions* → *Use for everything*, or a tier's provider menu) runs there, on the computer in `models.computer`, else the most recently seen online computer with that agent signed in (`pickComputer` in `subscriptions/turn.ts`). In a space shared with the person, only their own computers are used. On that computer one runtime runs the turn: the first to read it ([25 §4.9](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#49-subscriptions-and-included-models)).

The card shows only the plans found on that computer; *Manage subscriptions* (`?dialog=subscriptions`, `subscriptions-dialog.tsx`) lists every plan like *Manage API keys*: the found ones first, then the rest with how to add each. The plans (marks in `apps/hub-web/components/connectors/provider-logo.tsx`, sources in `public/providers/manifest.json`; Grok shows its initial). A tile with usage windows (Claude, Codex) shows a bar for each with how much is used and when it starts over (`UsageBars`).

A signed-in Copilot tile shows *Signed in as <account>*, and its models show their vendor, cost and context sizes ("OpenAI · low cost · 200K or 922K context"; `lib/engine-models.ts`). A tier on a model that has a long window (a Copilot model, or a Claude model with a 1M choice) offers *Context window*: Standard or Long context, saved as the tier's `context`; a model or provider without one resets it to the default, as does *Use for everything*.

The thinking menu names the model's own default level ("Automatic (Medium)").

**Detection** (`subscriptions/detect.ts`, reported in the heartbeat's `capabilities.agents` with `assistantTurns` (`ASSISTANT_TURNS_API`, 5); rechecked every 10 minutes, on *Check again* and after a sign-in):

| | Where it looks | Signed in? | Models |
|---|---|---|---|
| Claude | `claude` on the PATH, else the Claude app's copy (`claudeAppCopy`, the newest version in any of its profiles) under `Claude/claude-code/` or `Claude-3p/claude-code/` in `~/Library/Application Support` (macOS) or `~/.config` (Linux), `%APPDATA%\Claude\claude-code`, `%LOCALAPPDATA%\Claude-3p\claude-code` or `%LOCALAPPDATA%\AnthropicClaude\claude-code` (Windows) | `claude auth status --json` | One short `claude` in the Agent SDK's control mode (`--input-format stream-json`, no MCP servers; `claudeControl` in `subscriptions/claude-control.ts`): `initialize` lists the plan's models with their thinking levels and fast mode, merged with the table's windows (`claudeCodeModelsFrom`); `get_usage` gives the plan (`subscription_type`) and its usage windows: 5-hour, weekly, weekly per model (Opus, Sonnet, or as Claude names them) and extra usage when on (`claudeLimits`). Without an answer, the table for that version (`claudeCodeModels`). Settings shows when an update would add the newest models (`claudeUpdateNote`) |
| ChatGPT | `codex` on the PATH, else the ChatGPT app's copy (§2) | `account/read` (`codexSignIn`): signed in with ChatGPT (with its plan), with an API key (plan "API key"), or set up with its own model provider in `config.toml` (no account, `requiresOpenaiAuth: false`; plan "own model provider"). Only a Codex that needs an OpenAI sign-in and has none is signed out. A provider's `env_key` (from `config/read`) is taken from this computer's Ensemble's environment, else from the login shell (`loginShellVariable`: the desktop app and a login service do not inherit what the shell profile exports), kept in memory and given to Codex only (`codexProviderKeyEnv`); found in neither, the tile says to export it (on a Mac, or `launchctl setenv`) and Check again | `model/list` with each model's thinking levels (including `ultra`), default level and image input; "Codex's default" when it lists none. Signed in, `account/rateLimits/read` gives the plan's 5-hour and weekly windows (the month on Free and Go; `codexLimits`), shown on the tile as bars with the time each starts over |
| Cursor | `cursor-agent` on the PATH, or `agent` when it resolves into Cursor's install; then `~/.local/bin/cursor-agent` (`%LOCALAPPDATA%\cursor-agent\cursor-agent.exe` on Windows), where Cursor's installer puts it (`cursorAgentProgram` in `subscriptions/agent-apps.ts`, also for runs and the terminal hand-off). Never the copy the Cursor app's Agents window runs (`anysphere.cursor-agent-worker` in the app's global storage), which is signed in only with a key the app passes it | `cursor-agent status` | `cursor-agent models` |
| Grok | `grok` on the PATH | `grok models` ("You are logged in"; it always exits 0) | the same list's bullets (`parseGrokModels`) |
| OpenCode | `opencode` on the PATH, then `~/.opencode/bin/opencode` (its installer, and the OpenCode app's Install CLI), then the copy the OpenCode app runs, `opencode-cli` in the app's resources: `OpenCode.app/Contents/Resources` (macOS), `%LOCALAPPDATA%\Programs\OpenCode\resources` (Windows), `/opt/OpenCode/resources` (.deb, .rpm) (`opencodeProgram`, also for runs) | `opencode auth list` (its credential count; a model list also counts) | `opencode models` (`provider/model`) |
| Gemini | `gemini` on the PATH | a session opened in an empty folder over ACP (`acpProbe` in `subscriptions/acp-probe.ts`); a sign-in error means signed out | that session's model option, with the current model's thinking levels (`acpModels`) |
| Mistral Vibe, Qwen Code, Kimi Code | `vibe-acp`, `qwen`, `kimi` on the PATH (an npm `.cmd` shim on Windows read as Node and its script) | a session opened in an empty folder over ACP (`acpProbe`); a sign-in error, or Vibe's "Missing API key", means signed out | that session's model option, with the current model's thinking levels |
| Antigravity | Ensemble's own install (§3.3) | its sign-in file exists in Ensemble's Antigravity home (never read) | Gemini models with the level in the name (`ANTIGRAVITY_MODELS`, from T3 Code's manifest) |
| GitHub Copilot | `copilot` on the PATH, then where its installers put it: `~/.local/bin` (GitHub's script as the person), `/usr/local/bin`, Homebrew's `/opt/homebrew/bin` (Apple silicon), WinGet's `%LOCALAPPDATA%\Microsoft\WinGet\Links` or package folder (`copilotProgram`, also for runs and the terminal hand-off) | `auth.getStatus` on its headless server (`copilot --headless --stdio`, the Copilot SDK's JSON-RPC), with the GitHub account it reports | `models.list` there: each model's name, thinking levels and default level, context windows (the standard window and, for models priced in two tiers, the long one: `contexts`), whether it takes images, and its request cost (`cost`: the premium-request multiplier, or Copilot's price category); models the plan switched off are left out (`copilotModels` in `subscriptions/copilot.ts`). An older Copilot without the headless server: `copilot help config` |

**An agent's app without its agent** (`appPresence` in `subscriptions/agent-apps.ts`, reported in the heartbeat's `capabilities.agentApps`). Two apps come without the program Ensemble runs:

| App | macOS (Apple silicon and Intel) | Windows | Linux |
|---|---|---|---|
| Cursor app (`cursor-app`) | `Cursor.app` in `/Applications` or `~/Applications` | `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` (user installer), `%ProgramFiles%\cursor\Cursor.exe` (system installer) | `/usr/share/cursor` (.deb, .rpm), `/opt/Cursor` (or `/opt/cursor`), a `Cursor*.AppImage` in `~/Applications` or `/opt` |
| VS Code with GitHub Copilot (`vscode-copilot`) | `Visual Studio Code.app` (or Insiders) in `/Applications` or `~/Applications` | `Microsoft VS Code` (or Insiders) in `%LOCALAPPDATA%\Programs` or `%ProgramFiles%`, with `resources\app` beside `Code.exe` or, from VS Code 1.109, in the build's own folder | `/usr/share/code` (.deb, .rpm), `/usr/share/code-insiders`, the snap, `/opt/visual-studio-code`, the tarball in `/opt/VSCode-linux-x64` or `~/VSCode-linux-x64`, Flathub |

VS Code counts with Copilot built in (`resources/app/extensions/copilot`) or the Copilot extension in `~/.vscode/extensions` (or `~/.vscode-insiders`). The `@github/copilot` package VS Code's Copilot extension bundles is Copilot's SDK: its `bin` names an `npm-loader.js` it does not ship, and no platform program comes with it, so Ensemble never runs it as Copilot CLI.

With the app and not the agent (`appWithoutAgent` in `packages/shared-types/src/subscriptions.ts`), the plan is shown with the found ones as *Cursor app found. Set up its agent* or *VS Code found. Set up Copilot CLI*, with **Set up** (`POST /api/subscriptions/set-up`, frame `agents.setup` to a paired computer; refused for a computer that does not report the app). `startSetUp` in `subscriptions/signin.ts` opens a terminal window there that runs the vendor's installer, then the agent's login from where the installer put it (`setupCommand`): Cursor's `curl https://cursor.com/install -fsS | bash`, what the app's own `cursor agent` runs (`irm 'https://cursor.com/install?win32=true' | iex` on Windows), or GitHub's `curl -fsSL https://gh.io/copilot-install | bash` (`winget install GitHub.Copilot` on Windows). A window that would close by itself stays open when either fails. The agent is then checked every 8 seconds for up to 20 minutes; with the agent already there, Set up is the sign-in. `ensemble doctor` notes the same with the commands to run by hand ([26](26_CLI.md)).

**Signing in.** *Sign in* (web or desktop app) opens a terminal window on that computer running the tool's own login (`claude auth login --claudeai`, `codex login`, `cursor-agent login`, `copilot login`, `grok login`, `opencode auth login`, `vibe-acp --setup`, `kimi login`, or `gemini` or `qwen`, whose first start asks how to sign in; `subscriptions/signin.ts`). Antigravity has no command: Sign in installs its agent when needed and opens Google's sign-in page from it (§3.3). The tool opens the vendor's sign-in page and stores the sign-in where it always does. Ensemble checks the tool every 8 seconds for up to 6 minutes.

**One turn** (`subscriptions/agents.ts`).

The turn is built as for a model key ([11](11_HOW_THE_ASSISTANT_WORKS.md)): the instructions plus a few lines on how it runs there (`howYouRun` in `subscriptions/turn.ts`: Ensemble's tools, all its own tools in a chat, Ask Ensemble or a routine (below), else its own web search and page reading when `ownWeb` is on (only for Claude Code, Codex and Copilot, `OWN_WEB_AGENTS`: Cursor's agent and the ACP agents get every tool of their own refused in a turn, so they read the web through `hub_web_search` and `hub_read_web_page`), for a node's turn its own shell, files and web, what Ensemble's tools add (the owner's browser, capture, files into the chat, `computer_sudo`, coding-agent sessions) and that real coding can go to a coding-agent session when its owner wants to review it (on a computer before `assistantTurns: 5`: that the computer's browser and terminal are reached through Ensemble's tools and real coding goes to a coding-agent session), and that a node's conversation goes on from one message to the next), the message with its context, and the turn's tools (core and playbook tools plus `hub_use_tool`, which calls any of the turn's tools by name).

**Sessions.** Each chat is one session of the plan's agent on the computer that runs it, resumed message to message; a group of chats (an Ensemble Node) shares a project folder, a session the person also used in the agent's own app goes on with what they said there brought in first, an inline ask keeps one short session per page, a one-off completion keeps none, and deleting a chat deletes its session: [41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan) and [§6](41_AGENT_SESSIONS.md#6-deleting-and-cleaning-up).

**The agent's own tools in a chat** (`subscriptions/own-tools.ts`, `assistantTurns: 4`). A chat, an Ask Ensemble or a routine (`ownTools` on the turn's spec; never a one-off completion, whose input is a file, an email or a meeting the person did not write) keeps all of the agent's own tools: its shell, files, web search and its own built-in tools, as in the person's own agent, without asking. A node's turn keeps them too, judged by the node's folder policy (below).

Ensemble decides nothing about what the request needs: the instructions (`howYouRun` with `ownTools`) say most requests need only Ensemble's tools, that a command or a file on the computer is the agent's to judge, that its folder is the chat's scratch folder (keep work in Ensemble with `hub_save_file` or a page, or where the person says), and that a change to code in a repository usually goes better as a task for a coding agent (`hub_assign_to_agent`) unless the person asks for it here.

Only the hard floor refuses a call, judged from the turn's folder (`judgeFloor` in `workspace/engines/judge.ts`, the same floor a run has: the dangerous commands, privilege, persistence and system-settings programs, and outside that folder keys and sign-ins, Ensemble's own data and code, start-up items, the system's files and other accounts, for every path a call names, and a search, Grep or Glob, through a folder that holds any of those); a refused call comes back to the agent with its reason and the turn goes on. `hookCall` reads what each agent names: Copilot's `paths` (a string or a list) on its searches, the files a patch names in its `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` lines, and a glob's folder before its first wildcard; the hook passes arguments Copilot sends as plain text as `{ value }`.

Each agent is asked its own way: Claude Code runs every tool through a PreToolUse hook (`--settings`, `scripts/ensemble-hook.mjs --chat`, which asks the turn's runtime at `POST /api/engine/assistant/ask` with the turn's secret, waits up to 300 seconds, `OWN_TOOL_HOOK_SECONDS`, and fails closed); Copilot CLI gets every tool, path and URL (`--allow-all-tools --allow-all-paths --allow-all-urls`, its built-in MCP servers on) and the same hook as a per-turn plugin (`--plugin-dir`, a `plugin.json` and `hooks.json` in the chat's folder: a folder's own `.github/hooks` load only for a new trusted session, a plugin for a resumed one too), from a Copilot whose help lists `--plugin-dir`; Codex runs without its sandbox and with its environment (no `environments: []`), asking before every command it does not consider safe and every file change, each answered by the turn's judge (`answerCodexOwnTools`); Cursor's agent runs with `--sandbox disabled` and Cursor's and the ACP agents' permission requests are answered by the turn's judge (`answerAcpOwnTools`). The judge is the floor in a chat (`floorJudge`) and the node's policy in a node's turn (`nodeOwnJudge`).

Each of its own calls, with its input and what it returned, and each refusal with why, goes in the person's AI activity log (`OwnToolLog`, [07 §1.4](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#14-the-ai-activity-log)). A computer before `assistantTurns: 4` (`ASSISTANT_TURN_OWN_TOOLS`) runs the turn with Ensemble's tools only, and its agent is told so (`systemWithoutOwnTools`).

**A node's turn with the agent's own tools** (`subscriptions/node-own-tools.ts`, `assistantTurns: 5`, `ASSISTANT_TURN_NODE_TOOLS`). Only a turn its owner started and only they read keeps them; a room-bound turn, another person's or a disclosure draft has Ensemble's tools only, with the agent's own web search (`OWN_WEB_AGENTS`). The spec carries the node's policy (`node`: its id, handle, mission, whether its owner watches, whether it has `computer_sudo`, a helper's folders), and each own call is judged on the computer by it (`nodeOwnJudge`): the hard floor refuses with why (and any call that would answer Ensemble's approval cards); `sudo` and other privilege prompts are refused with guidance to use `computer_sudo`; reads, web searches and public pages pass, as do commands and changes in the node's own folders; a folder an answer about the agent's own calls covers (never one given to the node's computer tools), or an unattended run, passes; anything else asks the owner once per folder at `POST /api/devices/self/assistant-turns/:id/ask`, held at most 90 seconds, with calls asking at once sharing one question. The persistence and system-settings programs a chat's floor refuses (`crontab`, `launchctl`, `osascript` and the like), a tool Ensemble does not know (once per tool for the run, with its input) and a read or change that names no path always ask, unattended too. A tool of the person's own MCP servers is judged like the agent's own: one whose input names a command as that command (for a server's, in the home folder unless it says where), one that names files in full as reading or changing them by its name, one of a server that says it only reads passes. A command that does not say where it runs is judged where a `cd` in an earlier one left the agent's shell too. A helper works only in its folders, whose first change or command asks. A call not answered in time parks the turn: once the computer has that answer the agent's run is stopped (`assistant.stop` with `park`), keeping its session, and the answer wakes it in that session ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)). The turn's stream carries the agent's own calls (`tools`) to the node's chat. A computer before `assistantTurns: 5` runs a node's turn with Ensemble's tools only (its own web search and page reading when `ownWeb` is on), with the node's instructions for such a computer (its stable tier without the agent's own tools, `stableWithoutOwnTools`), which name no shell or files of the agent's own.

**The person's own MCP servers** (`subscriptions/agent-mcp.ts`). Copilot's are listed with `copilot mcp list --json` (every source it reads: the person's `mcp-config.json`, a trusted folder's, plugins', its built-in ones) and Codex's with `codex mcp list --json`, each from its config file when it cannot list them; a listing is kept ten minutes per program and folder (one for every temporary folder) and read again when the person's settings files change. A turn with Ensemble's tools only loads none of them where the agent can be told so, as the command lines below show; Cursor's agent and the other ACP agents load theirs, and a permission request for one is refused, though a tool the person allowed in that agent's own settings runs without one. In a node's turn with the agent's own tools, Copilot keeps them, each call through the node's judge; Codex, Gemini CLI and Qwen Code have them off, as Codex runs an MCP tool without an approval Ensemble could answer (and Gemini CLI one from a server the person trusts); Claude Code never loads them; Cursor's and the ACP agents' permission requests for them are judged. A chat with all of the agent's own tools keeps the servers the person set up, as in their own agent.

Otherwise the agent gets only Ensemble's tools:

- **Claude Code:** `claude -p [--input-format stream-json] --output-format stream-json --verbose --include-partial-messages --system-prompt-file <file> --tools "" --strict-mcp-config --mcp-config <file> --allowedTools mcp__ensemble --permission-mode default (with own web: --tools "WebSearch,WebFetch" --allowedTools mcp__ensemble,WebSearch,WebFetch) --setting-sources user (--session-id <id> | --resume <id> | --no-session-persistence) [--max-turns <n>] [--model] [--effort]`, message on stdin (with files, one stream-json user message), in the chat's folder. The instructions go with every turn (Claude Code does not keep them in a session). Model, level and the tier's long window go through `claudeLaunch` as for a run (§1). No shell or files of its own; web only with own web. The person's user settings load (where Claude Code may keep how it signs in), never a folder's; their MCP servers do not; Ensemble's hook steps aside (`ENSEMBLE_RUN`); the turn is not saved as a Claude Code session.
- **Codex:** `codex app-server`, a thread with Ensemble's instructions as `baseInstructions` (`thread/start`, kept for the chat; `thread/resume` on its next turn, with the instructions again; ephemeral for a one-off), every `turn/start` with `environments: []` (a resumed thread does not keep it), a read-only sandbox without network (with own web, Codex's own `web_search: "live"`), `environments: []` (no shell or file tools; a Codex that rejects the field starts without it), `mcp_servers.<name>.enabled = false` for each of the person's own MCP servers, every approval declined (`answerCodexTurn`).
- **Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code:** started as for a run (§3.3) in the chat's folder (Gemini CLI and Qwen Code with `--allowed-mcp-server-names ensemble` where their help lists it), with the chat's title and then Ensemble's instructions leading a new session's first message (`session/new`; `session/load`, or Antigravity's `session/resume`, after, when the agent offers it); a session that starts in a mode that acts without asking is set to the asking one first (Antigravity, Vibe), so nothing of the agent's own runs unasked; the tier's model and thinking level from the session's options; every permission refused except Ensemble's tools (`answerAcpTurn`).
- **Cursor's agent:** ACP with the chat's title and then Ensemble's instructions leading a new session's first message (`session/load` after); every permission refused except Ensemble's tools (`answerCursorTurn`); the turn's tokens from `session/prompt`'s `usage`.
- **Copilot CLI:** `copilot [-p <prompt>] --stream on --output-format json --allow-all-tools --deny-tool shell --deny-tool write [--deny-tool url --excluded-tools web_search, without own web] --disable-builtin-mcps [--disable-mcp-server <name>…, each of the person's own MCP servers; --deny-tool <name> on a Copilot without it] --no-ask-user --no-auto-update --additional-mcp-config @<file> [--session-id <id>] [--name <title>] [--attachment <file>…] [--model] [--reasoning-effort] [--context long_context]`; a new chat session's `--name` is the chat's title with double quotes made single (Copilot refuses a name with one and fails the turn), and a Copilot whose help has no `--name` gets the title leading the session's first message instead; the long window when a tier set to that Copilot model chose it (`context` on the tier, `tierContext` in `subscriptions/turn.ts`, sent to a paired computer on the turn's spec). From Copilot 1.0.78 (`copilot --version`, asked once per process) the prompt is piped on stdin, which no command line limits; before, it goes as `-p` and is cut to 28,000 characters on Windows (200,000 elsewhere), oldest text first, which could cut a node's instructions. `subscriptions/copilot-output.ts` reads `assistant.message_delta` and `assistant.message` from that process, and the turn's tokens from `--usage-output-file` (Copilot 1.0.81 on; `modelMetrics[model].usage`, input counting cache reads and writes), which holds the whole session's totals: the computer keeps them with the chat's session (`usage` in `assistant-sessions.json`) and a resumed turn counts only what it added; per-call `assistant.usage` events, from a Copilot that sends them, are the turn's own; missing counts stay null, and Copilot's billing units (`cost`, `totalNanoAiu`) are never treated as USD or credits. No quota endpoint or session history is read.

**Sub-agents in a chat turn.** An agent may start sub-agents during a turn (Copilot's task tool is open even without the agent's own tools). Claude Code: a sub-agent's streamed words (`parent_tool_use_id`) are not the reply; a turn that answers again once its background sub-agents finish shows the later answer set apart as it streams, keeps the last one as the reply, and counts tokens and cost as for a run (§1). Codex: only the chat's own thread gives the reply, the tokens and the turn's end (§2). Copilot CLI: an event that carries an `agentId` is a sub-agent's, so its messages are not the reply; its tool calls and usage are the turn's.

The agent's environment is cleaned as in §6.

**Files on the message** (`subscriptions/turn-files.ts`). Every file attached to the person's message is delivered to the agent's computer: it travels with the turn as `files` (`TurnFile`: id, name, media type, kind, size; `TURN_FILES_MAX` 8), passed to `runSubscriptionTurn` with a reader. The desktop runtime and a computer that reports `assistantTurns: 2` get the files; an older computer gets a note after the message naming them and saying Ensemble on that computer must be updated to receive files ([25 §4.9](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#49-subscriptions-and-included-models)).

`runAgentTurn` downloads each file into the turn folder's `files/` (`saveTurnFiles`, names made safe with `diskName`, a repeat gets " (2)"), skipping a file over 32 MB and anything past 64 MB together. Each file then goes inside the agent's message in the agent's own input form.

A file stays out of the message only where putting it in would fail the whole turn, because the agent's message format has no place for that kind; the message names it, says it is saved in `files/` and why it is not inside the message. Ensemble does not read files for the agent and its extracted text is not added (`files/extracted-text-policy.ts`, off). A text file's own contents are the file and go as they are.

| Agent | Inside the message (its own input form) | Saved in `files/` only, because the message format has no place for it |
|---|---|---|
| Claude Code | Pictures (PNG, JPEG, GIF, WebP, up to 3.75 MB) as `image` blocks; PDFs up to 32 MB as base64 `document` blocks; text files (text, Markdown, code, CSV, TSV, JSON, XML, YAML, SVG) as text `document` blocks, up to 2 MB whole (longer: the first 60,000 characters) | Pictures over 3.75 MB, PDFs over 32 MB, Word (.docx, .doc), Excel (.xlsx, .xlsm, .xls), PowerPoint (.pptx, .ppt), OpenDocument (.odt, .ods, .odp), RTF, Keynote, Numbers, HEIC, TIFF, BMP, AVIF and other pictures, audio, video: Claude's message input takes pictures, PDFs and text only, and a turn without own tools gives Claude Code no file tools (`--tools ""`); current chats, asks and routines with `ownTools` can open the saved file themselves |
| Codex | Pictures (PNG, JPEG, GIF, WebP) as `localImage` items (the saved path); text files as their contents in a text item, up to 60,000 characters | PDF (text and scanned), Word, Excel, PowerPoint, every other document, other picture formats, audio, video: Codex's `turn/start` input has no document type, and a turn without own tools declines every command (`approvalPolicy` untrusted, all approvals declined). Current chats, asks and routines with `ownTools` can open the saved file through Codex's tools |
| GitHub Copilot | `--attachment` for pictures (.png, .jpg, .jpeg, .gif, .webp) and documents (.pdf, .doc, .docx, .ppt, .pptx, .xls, .xlsx, .odt, .rtf); text files as their contents in the prompt (`--attachment` refuses .md, .csv, .txt, .json, .html and fails the whole run) | .ods, .odp, .key, .numbers, HEIC, TIFF, SVG, audio, video: `--attachment` does not take them. Attached documents reach Copilot's model as Copilot handles them: with its default model (copilot 1.0.103) a .docx, .xlsx and .pptx arrived as a name only and a scanned PDF was not read |
| Cursor's agent, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code (ACP) | Pictures as `image` blocks when `initialize` reports `promptCapabilities.image`; PDFs as `resource` blocks with the bytes when it reports `embeddedContext`; text files as `resource` blocks with their text when it reports `embeddedContext` (up to 2 MB), else as their contents in a text block | Word, Excel, PowerPoint, OpenDocument, RTF and every other non-PDF document; pictures when the agent does not report `image`; PDFs when it does not report `embeddedContext`. These get a `resource_link` to the saved file and a note: Office types are never embedded (the models behind these agents refuse them inline) and turns without own tools refuse the agent's own file permissions. Current chats, asks and routines with `ownTools` can use the agent's tools to open the saved file |

On a Copilot before 1.0.78 on Windows the files' contents in Copilot's prompt are cut first, so Ensemble's instructions stay within the 28,000-character command line (`copilotPrompt`); piped on stdin nothing is cut. Closing a gap is per agent, without Ensemble reading the file: for example a document-reading MCP server or the agent's own read tools limited to the turn's `files/` folder ([38 §7](38_AGENT_READABLE_FILES.md#7-files-outside-the-message)).

**Tools.** The agent starts Ensemble's MCP server (`scripts/ensemble-ask-mcp.mjs` with `ENSEMBLE_ASSISTANT_TURN`), which lists and calls the turn's tools through this computer's loopback API (`GET /api/engine/assistant/tools`, `POST /api/engine/assistant/tool`) with the turn's own secret (`subscriptions/bridge.ts`). Each call runs where the data is, through the same code as a model-key turn (`runOne` in `assistant/agent.ts`): same space, write policy and refusals. Ensemble sets no limit on a turn's calls or turns: `maxTurns` (Claude Code's `--max-turns`) is sent only for a one-off completion, and as 64 to a computer before `assistantTurns: 5` (`ASSISTANT_TURN_MAX_TURNS`), which takes at most that.

A turn on the person's plan spends none of Ensemble's included credits: `hub_web_search` skips Foundry's search there (`ownPlan` on the tool context) and answers from the free search, and a node's `web_task`, which runs on a server model, is left out.

Every agent waits up to 10 minutes for one call (`TOOL_TIMEOUT_MS`: Claude Code's `MCP_TOOL_TIMEOUT`, Codex's `tool_timeout_sec`, the `timeout` in Copilot's MCP config, whose own default is shorter), as a node's browser task or a slow connected app takes minutes. A relayed turn ends only when its computer sends nothing for 10 minutes (no reply text, status line, tool call or own call; `QUIET_MS`, `quiet` in `subscriptions/relay.ts`); one of Ensemble's tools running or an owner's answer awaited is working, not quiet, and a turn that keeps working has no time limit. When `hub_how_to` loads a playbook, its tools are added and the server sends `notifications/tools/list_changed`.

In the desktop app the tools run in its own process; from Ensemble on the web the turn travels to the computer and back ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

**Problems are said in words:** no computer paired, none online (with when last seen), Ensemble too old there, the agent missing (with the vendor's install link), not signed in (with where to press Sign in), the plan's limit reached (shown like a quota), or the agent's own message.

Tests: `subscriptions/subscriptions.test.ts` (including each agent's form for files), `node-own-tools.test.ts` (a node's policy for the agent's own calls), `subscriptions.integration.test.ts` (the file route, a node's turn spec and its ask, park and resume), `agents.e2e.test.ts`, `remote/assistant.test.ts`.

### 9. The worker's report and evidence: implementation reference

A coding agent reports its own result, separate from its closing words, and attaches what its owner should see (`evidence/run-tools.ts`). Ensemble Node reads the report to decide whether a step is done ([35 §8.12](35_ENSEMBLE_NODE.md#812-results-and-evidence)).

**The tools.** A task run's `ensemble` MCP server (`scripts/ensemble-ask-mcp.mjs`) has `report_result`, `attach_evidence`, `ensemble_context`, `ensemble_search`, `ensemble_actions`, `ensemble_act`, `ensemble_apps`, `ensemble_app_call` and `secret_http` next to `ask_person`, and the browser and capture tools of the computer (below); a Chat run has the board tools, `ensemble_context` and the connected apps instead. Its `initialize` answer carries `instructions` (`instructionsFor`): the agent acts in Ensemble through this server and its brief, and never opens Ensemble's web app to sign in or to read the person's work ([39 §4](39_ENSEMBLE_TOOLS_AUDIT.md#4-never-ensemble-in-a-browser)).

Every engine loads that server, so every engine has them. They reach `POST /api/engine/tool` on loopback with the run's secret, and the judge passes them without a prompt (`ENSEMBLE_OWN_TOOLS` in `engines/judge.ts`; Copilot's `--allow-tool 'ensemble(<tool>)'`), except `ensemble_act` and `ensemble_app_call`, which change things and are decided by the run's mode like a command.

| Tool | Input | What happens |
| --- | --- | --- |
| `report_result` | A `StepReport` (`node/report.ts`): `outcome` (`done`, `pass`, `fail`, `blocked`, `partial`, `uncertain` or `stopped`), `summary`, and optionally `checks` (each with its verdict and the `strength` of its evidence: `A` a file or record made now, `B` output seen in the session, `C` recollection), `subject` (the commit or content hash it produced), `evidence`, `blockedBy`, `remaining` (what is left), `ownerDecision` and `provenance` (the agent and model as the agent knows them) | Checked: its shape, and that the candidate exists (`subject.commit` is in the folder's repository; `subject.contentHash` is the last commit's tree or the working tree's, worked out with a throwaway index). Then redacted and kept on the job (`workspace_jobs.report`, a `report` event). A refusal is the tool's answer, so the agent can fix it and call again. A later call replaces the report. |
| `attach_evidence` | `{path, kind, caption?, requirementId?}`; `kind` is `screenshot`, `image`, `video`, `trace`, `report`, `log` or `file` | A file outside the run's folder is judged as a read by the run's rules first. The file is checked and copied into the run's evidence folder (below), with an `evidence` event. The answer gives its id, for `checks[].evidence`. |
| `ensemble_context` | `{item?, rel?, offset?, limit?}` | The person's records around the task (`workspace/context-tools.ts`, [03 §5](03_MODULE_CONTEXT_ENGINE.md#5-shared-retrieval-and-briefs)): without `item` the task's context packet (its meeting and the words asked, project, people and roles, dependencies, related open work, done-before, files); with an `ensemble://<kind>/<id>` handle from a result, that record and its links; with `rel`, one relation in pages. A task claimed from Ensemble on the web is answered there, for the job's space, under the job's lease (`POST /api/devices/self/jobs/:id/context`); otherwise this computer's Ensemble answers. |
| `ensemble_search` | `{query, kinds?, limit?}` | Task runs only (Chat keeps its board search). Ranked word search across the person's records, closest to the task first, each hit with a handle for `ensemble_context`. Answered where `ensemble_context` is. |
| `ensemble_actions`, `ensemble_act` | `{groups?, names?}`; `{action, input}` | Task runs only. Ensemble's everyday changes around the task, the part of an editor's key's allowlist not marked `keyOnly` ([CONTEXT_BRIDGE §5.1](CONTEXT_BRIDGE.md#51-changes-in-ensemble)): update the task's fields, add or edit pages, put a task or page on a board, make a diagram or plot, link people and projects, add a meeting note (`runRunAction` in `workspace/context-tools.ts`). A task claimed from Ensemble on the web is answered there under the job's lease (`POST /api/devices/self/jobs/:id/act`), and only in the computer owner's own space; a local task on this computer's Ensemble. Changes run at once and are in Ensemble's Undo |
| `ensemble_apps`, `ensemble_app_call` | `{app?, tools?}`; `{tool, input}` (the Context Bridge's own shapes) | Also in Chat runs. The apps the person connected to Ensemble (Notion, GitHub, Gmail, Slack, Linear, Hugging Face…, [31](31_CONNECTORS_IN_USE.md)) and their tools, as an editor's key with apps allowed has them ([CONTEXT_BRIDGE §5.2](CONTEXT_BRIDGE.md#52-connected-apps)): listed (each tool's first sentence; with `app` or `tools` its full description and `inputSchema`) and called with the person's own connection, so the agent needs no app keys. The suite connected, the product on and the scopes granted are checked as for the assistant; a change in an app runs at once, is ledgered and cannot be undone from Ensemble, and is refused while Settings › Assistant has connected-app changes off. Answered where `ensemble_actions` is; in a space shared with the computer's owner, refused (the space owner's apps are not the run's) |
| `secret_http` | `{ref, url, method?, headers?, body?}` | Also in Chat runs. A request this computer makes with a saved secret put in where `{{NAME}}` appears in a header or the body, only to that secret's allowed origins and only when the run may use it; the answer has the value hidden ([35 §8.7](35_ENSEMBLE_NODE.md#87-secrets), `credentials/secret-http.ts`). A run whose internet is off is refused. |

**Secrets by reference.** A run that may use a secret with allowed destinations is told its name and where it may go, never its value (`secretRules` in `lib/run-secrets.ts`), and, when the run names the secret, gets git settings that make git over https to those hosts sign in with it (`credentials/git-credential.ts`). The secret is never in the run's environment.

**Browser and capture.** The server also lists `browser_*` and `capture_*` ([25 §10](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#10-browser-and-capture-on-the-computer)), as `GET /api/engine/tools` gives them for a task run: all of them when the computer has a browser for Ensemble, else only `capture_status`, which says what `ensemble capture setup` adds. A call runs for the run's own operation (its job), writing into its evidence folder (`evidence/capture-tools.ts`).

They follow the run's mode like any MCP tool, for every engine: Review only and Run unattended use them freely, Ask asks before them (*Allow for this run* on one browser tool covers the run's other browser tools, and the same for capture), a read-only run is refused.

What it writes is the run's evidence at once, with no `attach_evidence`: the answer names each file's id (to put in `checks[].evidence` after `capture_check`), or says it is held for the owner's preview (a saved secret or key on screen, a desktop app's window, a site the owner previews first); a held file goes nowhere until the owner releases it ([35 §8.16](35_ENSEMBLE_NODE.md#816-browsing-and-capture)). A run with the internet off opens and loads only this computer's own addresses (`loopbackOnly`).

`capture_app_start` starts an app in the run's folder (or one it was let into), sandboxed as the run is. A run may read its own evidence folder, to look at its screenshots. When the run ends, a recording still going is finished and kept, and its tabs, apps and displays end (`finishRunCapture`).

**Instructions.** Every engine's brief has one line on this (`reportingNote` in `workspace/agent.ts`, part of `workingNotes`): at the end call `report_result`, after `attach_evidence` for files the owner should see (with the path of the run's evidence folder), and without MCP tools write the report as JSON to `.ensemble/result.json`. A `commit` or `contentHash` at the top of a report is taken as its `subject`.

**Without MCP.** When the run ends with no report from the tool, the runtime reads `.ensemble/result.json` in the run's folder (`collectRunResult`). It reads only a regular file with one name, at most 256 KB, written during this run, without following links. It must be a valid `StepReport` with a candidate that exists. The files it names under `evidence` (kinds `screenshot`, `video`, `report`, `log`, `file` or `evidence`; not URLs) are attached under the same checks, and so is any file left in the run's evidence folder.

A problem is recorded as a `report_refused` or `evidence_refused` event; it never fails the run. Chat runs and interrupted runs are not read.

**The evidence folder** (`evidence/files.ts`) is `<Ensemble's data folder>/evidence/<job id>`, never in the repository. Agents cannot write there (the sandbox denies Ensemble's data folder), so the runtime copies each file in. A file is read once, by descriptor:

- opened without following links (`O_NOFOLLOW`); a regular file with one name only (a hard link is refused); its real path is checked again after opening, so a file swapped after the check is refused;
- never a credential file: `.env*`, key and certificate files (`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` and the like), credential stores (`.npmrc`, `.netrc`, `.git-credentials`…), shell histories, or anything under `.ssh`, `.aws`, `.gnupg` or `.git` (`credentialPathReason` in `evidence/limits.ts`);
- nothing in Ensemble's data folder or the browser profile folder, and nothing the outside floor refuses to read (`outsideRefusal`: keys, sign-ins and browser data in the home folder; `evidenceFloor`);
- never a file that holds a saved run-secret value;
- at most 100 MB per file, of any kind, and 100 files per run;
- the kind must match the type read from its bytes (a `screenshot` must be an image).

What is copied is exactly what was checked, and the copy is checked again before it is sent. Folders of runs that ended 30 days ago are removed. A paired computer uploads each file to the web unless `ensemble evidence off` ([25 §4.11](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#411-the-workers-report-and-evidence)).

Tests: `src/evidence/report.integration.test.ts` (the MCP server end to end, content hashes, the result file), `src/evidence/files.test.ts` (the file rules), `src/evidence/capture-run.integration.test.ts` (the browser and capture tools through the MCP server: listed for task runs only, captures kept and held, a blank screenshot failing its check, internet off, a recording finished at the run's end, held files to newer and older servers) and `src/evidence/captures.test.ts` (recording captures as evidence).

### 10. Support matrix: implementation reference

What each agent does for a run Ensemble starts, including the runs a node starts ([35 §8](35_ENSEMBLE_NODE.md#8-work-on-a-computer)), and what each model provider does as a node's brain. Checked against Claude Code 2.1.304, Codex 0.163.0 and GitHub Copilot CLI 1.0.108 on Linux; Copilot's skill runs, tool permissions, `allow_all` and MCP tools were checked live, the others through stand-ins speaking each protocol (`engines/*.e2e.test.ts`).

Mistral Vibe 3.1.1, Qwen Code 0.27.1 and Kimi Code 2.5.3 were started live signed out (version, ACP `initialize`, the sign-in check); signed-in runs follow their documented protocols, as do Cursor's agent, Gemini CLI, OpenCode, Grok Build and Antigravity.

**The desktop chat apps.** The Claude app, the ChatGPT app and the Cursor app are not driven themselves: each ships (or sits beside) the agent Ensemble drives, on the same subscription and sign-in. The Claude app's Code tab is Claude Code (Ensemble finds the copy inside the app when there is no `claude` command); the ChatGPT app's Codex is the Codex CLI (`~/.codex`, the app's own copy when there is no `codex`); the Cursor app's agent is `cursor-agent`, signed in with `agent login`.

A task can still be opened in the app itself (§4), where the app's own settings apply.

### 10.1 Coding agents

| | Claude Code | Codex | Cursor's agent | GitHub Copilot | Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code |
| --- | --- | --- | --- | --- | --- |
| Driven as | `claude -p`, stream-json, a PreToolUse hook on every tool (§1) | `codex app-server`, JSON-RPC (§2) | `cursor-agent acp` (§3) | `copilot --acp` (§3) | ACP, one runner (§3.3) |
| Permissions reach the judge and `agent_decisions` | Every call, through the hook | Every approval Codex asks for (commands with their folder, file changes, more access, MCP forms); with its sandbox in Review only or Run unattended, Codex asks only to leave the sandbox, which is the floor | Every `session/request_permission`; a command in the person's own Cursor allowlist runs without asking | Every `session/request_permission`; `allow_all` and autopilot are set off first; a tool the person allowed "always" for that folder runs without asking | Every `session/request_permission`, with each agent's own prompts forced on (Grok `--permission-mode default`, OpenCode `OPENCODE_PERMISSION`, Gemini and Qwen `--approval-mode default`, Antigravity's and Kimi's `default` mode, Vibe's `ask` agent) |
| Questions | `ask_person`, `AskUserQuestion` | `ask_person`, `item/tool/requestUserInput`, MCP forms | `ask_person`, `cursor/ask_question`, forms | `ask_person` (`--no-ask-user`), forms | `ask_person`, forms (`elicitation/create`: OpenCode's question tool) |
| `ask_person`, `report_result`, `attach_evidence`, `secret_http` | `--mcp-config`, day-long timeout | `config.mcp_servers`, day-long timeout | `session/new` `mcpServers` | `--additional-mcp-config` file, allowed by `ensemble(<tool>)`, day-long timeout | `session/new` `mcpServers`; the wait is the agent's own MCP timeout |
| Browser and capture tools (§9) | Yes, judged by the mode | Yes | Yes | Yes, asked about and judged | Yes |
| Models | The plan's list from `claude` itself, else `CLAUDE_MODELS` | `model/list` | `cursor-agent models` (names) | `models.list` (cost, levels, two windows) | The session's model option (`opencode models`, `grok models`, Antigravity's fixed list; Vibe, Qwen and Kimi from an ACP probe) |
| Thinking level | `--effort`, per model (`claudeLaunch`) | `effort` on `turn/start` | Not set: Cursor names levels in its model ids | `--reasoning-effort` | The session's thought-level option |
| Long context, fast mode | `[1m]`; `fastMode` | One window; the fast service tier | None | `--context long_context` | None |
| Resume and steer | `--resume`; a steer is the next run resuming | `thread/resume` | `session/load` | `session/load` | `session/load` (Antigravity `session/resume`) |
| The person's skills | `~/.claude/skills`, `~/.agents/skills`, enabled plugins; a project's `.claude/skills` in a folder trusted by name | `~/.codex/skills` (with `.system`), `~/.agents/skills`, plugins; a project's in a trusted folder | Its own and `~/.cursor/skills` | `~/.copilot/skills`, `~/.agents/skills`, installed plugins, built-in skills | Gemini `~/.gemini/skills` and extensions; OpenCode `~/.config/opencode/skill(s)`; Vibe `~/.vibe/skills`; Qwen `~/.qwen/skills` and extensions; Kimi `~/.kimi-code/skills`; all of these and `~/.agents/skills`; Antigravity runs in Ensemble's own home, so the person's Antigravity skills do not load |
| Sign-in check | `claude auth status --json` | `account/read` | `cursor-agent status` | `auth.getStatus` (keychain-aware) | `grok models`, `opencode auth list`, an ACP probe (Gemini, Vibe, Qwen, Kimi: a session that fails for want of a sign-in, or Vibe's "Missing API key", is signed out), the sign-in file (Antigravity) |
| OS sandbox (a beta, off by default) | Its own (Seatbelt, bubblewrap) | Its own | Its own | `--sandbox` | Gemini and Qwen on macOS only; none for the others: a sandboxed run stops at once, and a node's start says so before the run (`refuseUnsandboxable` in `node/sessions.ts`) and picks an agent that has one when its profile names none |
| Version gates | Models by `minVersion` | None | None | None | Gemini's and Qwen's `--acp` or `--experimental-acp`, read from its help |

**Skill folders** (`agentSkillRoots` in `engines/skills.ts`): `~/.agents/skills`; `~/.claude/skills`, `~/.claude/plugins/marketplaces`, `~/.claude/plugins/cache` (or under `CLAUDE_CONFIG_DIR`); `~/.codex/skills`, `~/.codex/plugins/cache` (or under `CODEX_HOME`); `~/.copilot/skills`, `~/.copilot/installed-plugins` (or under `COPILOT_HOME`) and Copilot's own package (`~/.cache/copilot/pkg`); `~/.cursor/skills`, `~/.cursor/skills-cursor`; `~/.gemini/skills`, `~/.gemini/extensions`, `~/.gemini/antigravity/skills`; `~/.config/opencode/skill` and `skills`; `~/.vibe/skills` (or under `VIBE_HOME`); `~/.qwen/skills`, `~/.qwen/extensions`; `~/.kimi-code/skills` (or under `KIMI_CODE_HOME`). A link into one of them is followed. Credential files there (`.env`, keys) and git's own files are left to the usual rules.

**Adding an agent.** Each further ACP agent needs an entry in `ACP_AGENTS` (its program, the mode that asks, its sign-in), its id in `SUBSCRIPTION_PROVIDERS`, `CODE_ENGINES` and `ACP_ENGINES` (and `ModelProvider`), a detection (`probeAcpAgent`: version and `acpProbe`), a sign-in command (`LOGIN_ARGS`), session deletion (`deleteNativeSession`), its skill folders, its words in `engineNamed`, shared trust when it keeps a trust file, its MCP setup (`ensemble mcp setup`, the Connect page) and its label and mark on the web and in the CLI.

Mistral Vibe, Qwen Code and Kimi Code are entries of this kind. Goose (`goose acp`), Trae (`traecli acp serve`) and Kiro (`kiro-cli acp`) are further such agents. Pi speaks its own JSON-lines protocol, not ACP, and needs a driver.

### 10.2 A node's brain

| Brain | How a node turn runs | Its tools | Thinking |
| --- | --- | --- | --- |
| Included models (GPT-6 Luna, GPT-6.1 Sol and the server's others) | Ensemble's tool loop on the server ([11](11_HOW_THE_ASSISTANT_WORKS.md)) | All of the turn's | The node's level (low unless set) |
| API keys: OpenAI, Anthropic, Google, Mistral, Kimi, Qwen, OpenRouter, GitHub Copilot | The same loop, on the provider's API (Responses or chat completions, Anthropic messages) | All, when the model takes tools | The node's level, as the provider takes it |
| xAI, DeepSeek, Llama and other vendors | Through OpenRouter (or Grok Build as an AI plan); there is no xAI or Azure key of its own | As above | As above |
| Local models (Ollama, LM Studio or any OpenAI-compatible server) | Provider `ollama`, or the OpenAI key with its own base URL, where Ensemble's server reaches it: the desktop app and a server of one's own; on the hosted site only for its operator. From the hosted site, a model on the owner's computer runs as an AI plan whose agent is set up with it (OpenCode's Ollama or LM Studio provider, Codex's own providers, Copilot's own provider) | All, when the model takes tools | As above |
| AI plans on a computer (each of `SUBSCRIPTION_PROVIDERS`) | The plan's agent on the paired computer runs the turn with Ensemble's tools and its own shell, files and web (§8; its own web search and page reading only, on a computer before `assistantTurns: 5`), through the relay. One session per node conversation, resumed from message to message with only the change in its instructions, in the node's project folder; a session unused 7 days is deleted (`NODE_SESSION_KEEP_DAYS`) | All of the turn's except `web_task` (the agent drives the browser itself), each waited for up to 10 minutes, and the agent's own judged by the node's folder policy ([35 §8.13](35_ENSEMBLE_NODE.md#813-the-nodes-own-tools-on-the-computer)); no limit on calls | The node's level when its owner set one (`turnEffort` in `node/brain.ts`), else the agent's own default |

A node's model is checked against everything its owner can use (`modelProblem` in `node/model.ts`), not only the first 40 per provider the picker lists.

Tests: `engines/judge.test.ts` (skill folders and scripts, run rules by kind), `engines/acp.test.ts` (forms), `engines/codex.test.ts` (a command's folder, MCP forms), `engines/cursor.test.ts`, `engines/copilot.e2e.test.ts` (`allow_all` set off, Ensemble's own tools allowed by name), `remote/policy.test.ts` and `devices/routes.integration.test.ts` (*for this run* from the web), `node/session-control.test.ts` (an agent with a sandbox), `node/model.test.ts`, `subscriptions/subscriptions.test.ts` and `agents.e2e.test.ts` (tool waits).
