# 11 · How the assistant works

Ask the Hub assistant to find information, work on a page or make a change in Ensemble. Include the item you mean, what you want done and any constraints. The assistant uses permission-checked tools and shows receipts for the actions it runs. Save recurring instructions as [Personal skills](04_MODULE_SKILL_FORGE.md).

Use the steps below to provide context, review changes and recover when a call fails. [Assistant actions](34_ASSISTANT_ACTIONS.md) lists the exact available actions.

## 1. Request to result

1. Ask in the dock, inline on a page or in Ensemble Code.
2. The assistant gathers bounded context and the tools your settings allow.
3. Each proposed call is checked for valid arguments, access and write policy.
4. Reads and permitted immediate writes run; other writes become proposals.
5. Review the answer and receipts. Choose Apply to run a saved proposal when asked.

The model never clicks the UI or writes SQL. A call runs only if the turn offered that tool (a lookup by name) and its input passes the schema. Folder tools exist only in Ensemble Code ([30](30_ENGINES.md)).

## 3. Context and prompt size

Make a question specific by naming the records it concerns or using the @ menu. Mentions carry the record’s identity, so a later reload still shows the exact item. If several records match, the assistant asks you to choose. Replies normally show titles and links; ask explicitly when you need an ID.

### Attach a file

Use the attach button to upload from your computer or choose a file already saved in Ensemble. You can also drop or paste files. Attach up to **8 files per message**. The attachment picker does not search connected apps.

The model receives each file itself, not Ensemble’s extracted text. Pictures are image inputs; other formats are file inputs. If the provider refuses the files, Ensemble retries with the files supported for that model, then without files. A subscription agent receives them through its CLI. Earlier messages replay file links without sending the files again.

### Use the open page or a connected app

The assistant receives the current date and time zone, supported view state, selected records and text, and the open item’s relevant fields. Selected text is capped at 2,000 characters; selected and visible record lists at 100 each. It reads structured app data rather than screenshots or the DOM, and every record is checked against the active space’s permissions.

Name the connected app, ask to search connected apps or paste an item link when you want remote content. Connecting an app alone does not authorize reading it for an unrelated question. Saved Ensemble files and context are the default; an unclear source prompts a question first. A guest cannot use the space owner’s private connections.

### Manage a conversation

A model turn receives the conversation's newest messages, as written, without their old context blocks: as many as fit about 8,000 tokens on an included model, 24,000 on your own API key and 4,000 on a local model ([Turn limits](#turn-limits-and-final-answer)). On your own AI subscription, one chat is one session of that agent ([41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan)).

What you and the agent said in that session in the agent's own app comes into the chat before your next message there. It's marked "In the Claude app" (or wherever it was said) with its time, and the agent's answers show without Ensemble's name. In the history a model receives, those messages read "(Said in the Claude app, outside Ensemble) …" (`assistant/outside.ts`).

Open recent chats in the dock to return to a conversation. Use its delete button, Delete or Backspace and confirm once to remove it. Deleting the open chat starts a fresh chat. **Settings → Assistant → Prompts** shows every prompt Ensemble sends.

## 6. Apply, Undo and dependent actions

Choose how Hub changes run in **Settings → Assistant**:

- **Just do it (undoable)** is the default: Hub writes run immediately with Undo.
- **Preview** holds changes for Apply in the chat.
- **Needs me** holds them on the Needs me page.

`holdsAssistantWrite` in `agent.ts` applies the saved `settings.assistant.writePolicy` values `immediate`, `preview` and `needs-me`. Connected-app writes (area `apps`) and `alwaysHold` tools always wait for Apply ([34 §2](34_ASSISTANT_ACTIONS.md#2-writes-that-always-wait-for-apply)).

Under `preview` and `needs-me`, the inline artifact flow creates a requested diagram or plot (`hub_create_diagram`, `hub_create_plot`) at once. Each turn adds a `writeModeNote` system line saying which writes run now, so playbooks work under every policy.

`POST /api/assistant/apply` resolves calls saved on the authorized conversation and message, checks state, revalidates arguments and permissions, and locks against double Apply. It never accepts a new tool call as approval.

`applyHeldCalls` (`apply.ts`) runs Hub writes in one transaction (30 s timeout) with one Undo group. Calls that name a space (an Ensemble Node's, [35 §5.4](35_ENSEMBLE_NODE.md#54-every-space-its-owner-can-open)) are first checked again in that space, and then run in one transaction and Undo group per space, in that space's scope.

Outside writes (area `apps` or `outsideTransaction`) run afterwards, one at a time, outside the transaction; each is ledgered as `apps.<tool>` or `assistant.<tool>` once done. After a partial failure, receipts separate succeeded, failed and unattempted calls, and Retry does not resend succeeded ones. Connected-app writes have no Hub Undo.

The dock shows a reply's work in `components/assistant/tool-calls.tsx` (styles in `assistant-work.css`). Finished calls fold behind one line ("8 steps · 1 change · 1 failed"), open when one failed.

Each call is one row: an icon for what it touched, its receipt (a failed call names its action, with the error under it), a small mark for Applied or Undone, and Undo, Redo and Open on the row; a click opens its input (known ids as titles, other ids left out) and the tool's name.

Once a reply has more than four calls, a run of three or more finished reads folds into one "N steps" row that opens in place.

Proposals sit in a dashed card under the reply that says nothing changes until you apply, with Apply on each and Apply all for several. A live turn lists its calls as they land and, until text streams, the step in progress: the last `status` line, or "Thinking…" once results have arrived, with its seconds after three.

### Ordered workflows

`hub_run_workflow` (`tools/workflows.ts`) proposes **2–12 ordered writes** under one Apply. Each step has an `id`, a tool and typed `input`; a later value may be `{"$ref": "person.person.id"}` or `tasks.tasks.0.id`, pointing backward only. Reads happen before proposing; read steps and nested workflows are refused.

The plan is bound to the saved proposal by its hash, and `assistant_workflows` keeps per-step state by space, actor, conversation and tool-call ID. Each step rechecks settings, access and module/app availability.

Retry skips successful steps; a failure stops the rest and reports what finished, without rolling back outside changes. A step interrupted while running is never replayed automatically; the UI offers **Retry remaining steps** without claiming completion. Hub steps can have separate Undo entries.

## 8. Capability areas

Tool names per request: [34](34_ASSISTANT_ACTIONS.md).

### 8.1 Pages, records, files and skills

Writes use real IDs, revisions and schema validation; record tools cover implemented fields only, and arrays documented as complete lists replace rather than append.

Custom boards (`tools/boards.ts`) share `pages/boards.ts` with `routes/page-boards.ts`, so a tool checks and changes a board exactly as the Board screen does; a board is named by id, pasted link or title, and its changes have no Undo (deleting one always waits for Apply). Original-file edits are format-specific and hash-guarded ([32](32_FILES.md)).

Profile layouts differ from the widgets view ([34 §3](34_ASSISTANT_ACTIONS.md#3-tiles-and-layouts)). Personal skills use versioned routes ([04](04_MODULE_SKILL_FORGE.md)).

### 8.2 Connected apps

What is connected comes from the block and `hub_list_connections` (§3). *Tools* under the message box switches connected apps, or single tools in them, off for that chat; the chat keeps the choice and a new chat starts with everything on. A switched-off app is named in the block as off, without its tools, and cannot be called or applied ([Context Bridge §5.5](CONTEXT_BRIDGE.md#55-choosing-which-apps-an-agent-may-use)). Attach saves a source copy that refresh updates where supported. Source and container IDs are provider-specific; project-link IDs can differ from item-search IDs. Board imports preview and map before Apply starts a background job. Unknown free/busy is never free time.

No tool sends mail, Slack or Teams messages, and a catalog entry does not prove an action exists ([31](31_CONNECTORS_IN_USE.md)).

### 8.3 Running work, Code and settings

`hub_assign_to_agent` (`tools/agent-assign.ts`) assigns a task under a run profile: the one named, else the default (`pickRunProfile`: starred, else first saved, else built-in Quick settings).

It runs on the computer named (`"any"` for "my computer"), else the profile's computer, else this server when the engine is Ensemble's agent and the server runs agents, else the most recently seen online paired computer (else the most recently seen one).

It sends the same request as `POST /api/agent/assign` (`createJob`), with the profile's sandbox choice (a beta, off unless turned on; [24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)), always waits for Apply, and is refused while the agent is paused; the computer rechecks the job against its own folders and rules ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

What the person names in the request wins over the profile: the agent, `model`, `effort`, `context` (GitHub Copilot's long window), `branch`, and `pullRequest` (`{base, merge}`, any base, empty for the default branch: "make branch A, open a pull request against testing and merge it" is `branch: "A"`, `pullRequest: {base: "testing", merge: "auto"}`; *ask* confirms on Needs me first; [24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)).

With the profile's git choice No limits the agent may also push and open or merge pull requests itself.

`session` (from `hub_list_agent_sessions`: the person's agent sessions, newest first, each with agent, computer, folder, tasks, status and a one-line summary; `taskId` and `query` narrow it) continues in that session: its computer, folder and agent, which resumes its own conversation ([41 §1](41_AGENT_SESSIONS.md#1-coding-sessions)).

`hub_list_agent_options` lists profiles (default marked) and paired computers (online state, shared folders, which are shared as repositories, the coding agents each runs, and whether it opens pull requests).

The assistant never runs commands or edits code. Ensemble Code adds folder-reading tools and `ensemble_start_agent` ([30](30_ENGINES.md)) and does not bypass routing or host security. Coding with Ensemble's tools at hand is the Code tab's agent ([16 §9](16_CODE_TAB.md#9-the-agent)): the person's own coding agent, not the assistant. Settings tools change allowlisted keys only; model choice uses the available catalog and validates effort. Secrets, permissions, folder trust and account controls stay human actions.

## 7. Permissions and sharing

Layers: authentication, space and resource access, modules, allowed write areas (`settings.assistant.allowedWriteAreas`), connected-app writes (`settings.assistant.connectedAppWrites`), grant/product/tool state, tool preconditions, Apply. A setting cannot authorise an unavailable connector, and a guest's workflow cannot use the owner's private apps.

Shared editors get content-scoped tools; viewers get no write tools. Reminders, the owner's calendar copies, private apps, imports and layouts, secrets and account controls keep their own checks. Apply rechecks permissions ([29](29_SHARING.md)).

## 9. Failure behavior

Besides the stale-input (§4), partial-Apply and workflow (§6) cases:

| Failure | Handling |
| --- | --- |
| Invalid or unknown call | Schema or "no tool called …" error; nothing dispatched |
| Expired connector grant | Show reconnect; the saved copy is not presented as live |
| Import started | Return job ID and status; check progress before reporting done |
| Stop or disconnect | Keep known usage and receipts; an accepted remote request may still finish |
| Unavailable model | Saved readable error with Retry, never a success-shaped answer |
| A rate limit (429) or an overloaded service (503) | The runtime that called the provider waits it out first, as Retry-After asks, up to a minute, three times; a 429 without Retry-After (such as `insufficient_quota`) is not retried. The loop does not ask again on top ([Turn limits](#turn-limits-and-final-answer)) |
| A model call that fails in a way the runtime does not retry: a dropped connection or a cut stream, a server error (500, 502, 504) that still reached hub-api, a network or gateway timeout | Asked again after 5 and 20 seconds, also after tools ran in the turn (they do not run again). Then the chat shows a sentence such as "The model's service failed (502). Nothing more was changed.", never the provider's JSON |
| A stuck turn: the same call with the same result again and again (or the same round of calls), or every call failing | One nudge after the third repeat; at the fifth, or after eight steps of only failed calls, the turn ends with an answer from what it has and what it did ([Turn limits](#turn-limits-and-final-answer)) |
| A long turn on the person's own key or a local model | Pauses after 120 steps with what it did and asks whether to go on; "continue" goes on ([Turn limits](#turn-limits-and-final-answer)) |
| A model call past its limit (§5) | The provider's stream is closed; the chat says which model did not answer in how long |

## 5. Provider and credential paths

Hosted calls normally go through the Python runtime; desktop and CLI use the in-process TypeScript adapters, with the same tool-turn contract. Saved keys are encrypted and resolved by the runtime making the call; a hosted account cannot borrow operator environment keys or CLI sign-ins.

Provider and model are explicit; effort is checked against the model before spending, and an unsupported option is refused. Included models reserve and settle account credits, also from a paired desktop or CLI, and the Azure key stays on the server ([33](33_INCLUDED_AI.md)).

AI subscriptions run on the paired computer with the tool's own sign-in ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). Policy: [01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy).

One model call waits at most `ENSEMBLE_MODEL_CALL_TIMEOUT_MS` (15 minutes by default, 30 seconds to 30 minutes; `lib/model-timeout.ts`); a caller may set a shorter limit (a vision check 2 minutes, a web task's step 1 minute, the answer checklist 20 seconds). hub-api starts the clock in `askRuntime` and `askRuntimeStream` and sends its limit to the runtime as `timeoutMs`; the runtime (in-process, or `ensemble_agent/model_timeout.py`) waits that long plus 10 seconds, so hub-api cuts first. A call past its limit ends with `ModelTimeoutError` (504, kind `timeout`), whose message is what the chat shows: "GPT-6.1 Sol did not answer within 15 minutes, so I stopped waiting.

Ask again, or try a narrower question." Text the model had already streamed stays, with that line after it. Stop, the limit, or hub-api closing its request closes the provider's stream: the Python runtime runs each call in a task its closed request cancels (`ensemble_agent/disconnect.py`).

Node's fetch would give up after 300 seconds without response headers or between two pieces of a body, so model calls (hub-api to the Python runtime, the in-process runtime to a provider, a computer's included calls) go through an agent of fetch's own build without those limits (`lib/long-fetch.ts`), and the Python runtime's stream sends a comment line every 15 seconds while a model thinks.

## 11. Limits and evaluation

The assistant acts only through offered tools. It cannot inspect other applications, run arbitrary recurring routines, perform OCR or transcription, edit every original format, or change security settings. Attached originals go to the selected model or agent, whose format support determines what it can read ([38](38_AGENT_READABLE_FILES.md)). What it, a node and a node's agent runs can and cannot do in each area of Ensemble: [39](39_ENSEMBLE_TOOLS_AUDIT.md).

`apps/hub-api/scripts/assistant-eval.ts` is an opt-in real-model evaluation over synthetic workspaces: it reports input, output and cached tokens and applies held changes in its isolated database. Keep live-provider evidence in PRs.

It has two kinds of scenario: actions (the expected tool runs, or waits for Apply and applies cleanly) and answers checked against live ground truth (Node.js LTS and Python releases from endoflife.date, a date read from a linked page, a two-part request, a look-up followed by a write, with no permission asked). Each round uses a fresh person.

`ENSEMBLE_EVAL_ENV_FILE=~/ensemble-test/ensemble.env` calls Azure Foundry as the included models do (the key is read from the file, never printed); `ENSEMBLE_EVAL_REPEAT=3` repeats, `ENSEMBLE_EVAL_EFFORT` sets an effort (default none, as Hub chat sends for included models), `ENSEMBLE_EVAL_WITHOUT=hub_read_web_page` leaves tools out, `ENSEMBLE_EVAL_SCENARIOS` picks scenarios.

## Reading the web

`hub_web_search` finds sources; `hub_read_web_page` (`tools/web-page.ts`) reads one: a public page or PDF fetched by hub-api through `fetchPublicFile`'s guards in page mode (http(s) only, every address and redirect checked against private networks, 10 MB, 20 seconds; `tools/save-file.ts`), read like a node's `browser_extract` (`browser/extract.ts`: main content as Markdown, products and prices from structured data, `focus` for one part), at most 4,500 characters with a note naming what was left out.

It runs no page script and signs in nowhere; a page that needs either says so, and the `web-research` playbook sends that work to an Ensemble Node.

The playbook's order: search, read the official source (directly by its address when results do not show it), answer with the links read. A Hub chat turn makes at most three searches (`WEB_SEARCHES_PER_TURN` in `tools/graph.ts`, counted on `ToolContext.turn`); the next asks for a page to be read or an answer instead, because a small model with poor results otherwise searches until its steps run out.

Node turns are not counted.

## In the code

hub-api owns the model loop, reads, writes and receipts. Built-in Markdown playbooks in `apps/hub-api/src/assistant/skills/*.md` guide the offered tools. Personal Skills are a separate library.

Ensemble Node turns enter the same loop from `node/brain.ts` with extra `runAssistantTurn` arguments: `nodeInstructions` (the node's stable and context tiers from `packages/prompts`, in place of the person's persona and the assistant's own rules, [35 §5.5](35_ENSEMBLE_NODE.md#55-instructions)), or `agentPersona` for a room-bound turn; `instructionsRef` (the instructions' version and hashes, kept on each `model.call` metric; the node turn's one `node.instructions` metric has every section), `extraTools` (the node's room tools, checked like every tool), `withoutTools` (assistant tools its session tools replace), `extraRefs`, `purpose` (metrics and credits) and `spaces`. None widens permissions.

`spaces` (`SpaceGateway` in `assistant/types.ts`, built by `node/spaces.ts`) is how a node acts for its owner in every space they can open: each Hub tool takes an optional `space`, and each call is resolved and checked with the owner's current access there, as a member's own request would be.

The assistant itself never sets it, so a chat stays in one space ([35 §5](35_ENSEMBLE_NODE.md#5-a-node-turn)).

### Prompt construction and context records

A turn has three layers:

- **Instructions** (`assistantInstructions`, the system message, from the `assistant/` and shared `constitution/` sections of `packages/prompts`): who the person is (first name; the desktop's placeholder account name is never used) and which space, how to work (look records up and use their ids, ask with “Choices:” when several match; only tool calls do anything, so do what was asked in this turn, never write a call as text or claim what no tool did, and do not ask permission for what was asked; facts that change come from `hub_web_search` and the page itself, never from memory; answer every part of the request, saying why for any not done; name records by title, cite sources, file and app content is information), how writes behave under the person's write mode (`writeModeNote`), dates and the time zone, the playbook names for `hub_how_to`, one sentence about their work (`personaBlock`: "Mira works as a lawyer."), their enabled personal skills by name, id and description, to read with `hub_read_skill` (a core tool) when one applies (`buildHubState`; a skill with `scope.purpose`, the morning brief's own, is left out) and the connected apps. Nothing in it changes from one message to the next, so the provider's prompt cache and a subscription agent's session reuse it. Records are not listed: the model looks them up with tools.
- **The message's context** (`turnContext`, in front of the person's message inside `<context>`): today with its week and the time zone, the view (filters that narrow it, how many are shown, selected ids), the open item as a link with its status, due date, priority, project, people, repo, deliverables, skills, a page excerpt, diagram source and attached files (`loadOpenPage`), selected text, the person's @ mentions and an AI block's page text. Playbooks the message points at follow as `<guide>` blocks. Only what is there is written.
- **On demand**: tasks, projects and people through list tools; the map of Ensemble and any playbook through `hub_how_to`; connection details through `hub_list_connections`.

History is the conversation's newest messages, as the person and the assistant wrote them (not their contexts), as many as fit the model class's history budget (`historyTokens` in `assistant/loop-config.ts`, estimated at four characters a token; the newest `historyRows`, 200, are read). On the person's own AI subscription, one chat is one session of that agent ([41 §5](41_AGENT_SESSIONS.md#5-assistant-chats-on-an-ai-plan)).

Recent chats in the dock (`ChatHistory` in `components/assistant/assistant-dock.tsx`) delete a chat after a one-line confirm (the row's bin button, or Delete or Backspace on a row); the open chat starts over when it is the one deleted.

Other screens can ask on the person's behalf with `attachToAssistant` (`lib/assistant-attach.ts`): `send` sends the prompt at once, `context` goes with it as the turn's `referenceContext` (never shown), `tier` sets that one message's tier and `fresh` asks in a new chat; Connect's **Need a hand?** uses all four ([02](02_MODULE_INTERACTION_HUB_UI.md)), and on Connect the dock's starter questions go with the same setup facts.

Settings → Assistant → Prompts lists every prompt Ensemble sends, from `promptCatalog()` (`prompts/registry.ts`, `GET /api/prompts`); `src/prompts/registry.test.ts` keeps them within size budgets.

The words of the instructions are Markdown sections in `packages/prompts` ([README](../packages/prompts/README.md)). The assistant's own lines are in `sections/assistant/`; its rules on looking things up, acting only through tool calls, sources, records and answering every part are `sections/constitution/` files shared word for word with Ensemble Node, whose turns get the whole constitution ([35 §5.5](35_ENSEMBLE_NODE.md#55-instructions)). A node turn passes `rules: false`, so those rules are not given twice, and `skills: false`: its own skills catalogue lists the person's skills ([35 §5.6](35_ENSEMBLE_NODE.md#56-context-db-memory-and-skills-implementation-reference)). `scripts/generate.mjs` writes them into `src/sections.generated.ts`, which is what the API reads.

- **Mentions.** @-menu mentions carry kind and ID; typed ones are resolved by `mentions.ts`. An ID is an exact lookup key, not a search phrase. The model gets them as `[Label](ensemble://kind/id)` links. `routes/assistant.ts` stores the resolved list as `[{ kind, id, label }]` in `assistant_messages.mentions`, returned to the owner by `GET /api/assistant/conversations/:id/messages` so the dock redraws exact chips after a reload. A message with an empty list shows its `@kind:Label` text as typed. On a reply, the same column holds the records the reply names by id (§4.1).
- **Attach files.** The dock's attach button uploads from the computer into Files or chooses saved files (`components/files/add-to-message.tsx`, only files saved in Ensemble, never connected apps); files can be dropped or pasted too. Up to 8 per message (`CHAT_FILES_MAX`) are sent as file mentions. `assistant/attachments.ts` gives the model every attached file itself (pictures as image parts, everything else as file parts); if the provider refuses the request, it goes again with the files verified for that model, then with none. A person's own subscription agent gets the files through its CLI. `hub_view_file` opens a file from Files, and a replayed earlier message names its files as links rather than resending them. Ensemble's extracted text of a file is not given to the model: `hub_read_file` is off, and `hub_search_context` / `hub_read_context` leave uploaded files out ([38](38_AGENT_READABLE_FILES.md)).
- **The screen.** `AssistantPageContext` carries the path, selected text (≤ 2,000 characters) and `surface`: kind (`desk`, `board`, `context`, `widgets`), tab, filters, selected and visible IDs (≤ 100 each), tile geometry; the dock adds a fixed list of URL parameters. Every ID is resolved in the active space; a supplied ID is never evidence of access. `hub_read_surface` reads scoped data for supported views, never pixels, the DOM or other apps.

**Connected apps.** The instructions name every app connected in this space (`appsPrompt`, from `loadConnections`; MCP servers without a sign-in are marked public data only), at most 30 (the rest via `hub_list_connections`), and the apps added but failing, to reconnect.

They say that any other app is not connected (Settings → Connections), and that a change in one waits for Apply with who gets an email (or that app changes are switched off). How each app is reached and with which tools comes from the `apps` playbook and `hub_list_connections`. A guest gets no app paragraph, and tokens are never read for it.

App content (MCP tools included) is read only when the person asks for that app's content, asks to search connected apps, or gives an item link; a connection, the app list or a general file question is not enough. Saved Ensemble files and Hub context are the default; an unclear source gets a question first.

### Playbook routing

- `routePlaybooks` (`skills/index.ts`) scores playbooks by `match` words (2–3) and mention kinds (2); the open path adds 1, which only breaks ties: a page alone loads nothing. At most **two** are preloaded, as guides in the message's context. The instructions name every playbook; `hub_how_to`'s description says what each covers, and `hub_how_to` with `map` returns `map.md`.
- On a custom board (the surface's `customBoard` filter), a message that loads `tasks` also loads `boards`, so "move this to Done" moves the board's card.
- A message naming an app connected in this space also loads `apps` as a third. Names come from that turn's connections (`appNames`: catalog name, id, vendor, parts of a combined name like "Jira & Confluence"); everyday-word names ("Box", "Close", "Front") count only capitalised. A meeting-notes request with a meeting-notes app connected loads it too.
- `hub_how_to` loads another playbook and adds its tools for the rest of the loop.
- A simple todo request gets a one-line recipe and five tools (`hub_how_to`, `hub_create_tasks`, `hub_list_tasks`, `hub_list_people`, `hub_list_projects`). Otherwise the turn shows the ten `CORE_TOOLS` (`skills/index.ts`, including `hub_web_search` and `hub_read_web_page`) plus the loaded playbooks' tools. Ensemble Code uses the same routing plus its own tools.
- Every model request carries at most **128 tool schemas**. `ENSEMBLE_ASSISTANT_TOOLSETS=off` shows every allowed tool; it turns off routing, not the cap or authorization.

Routing changes only what the model sees; what may run is every tool the settings allow. Prompt caching depends on the provider ([CACHING](CACHING.md)).

### 2. Source map

Paths are under `apps/hub-api/src/` unless qualified.

| File / folder | Responsibility |
| --- | --- |
| `routes/assistant.ts` | Conversations, turn streaming, Apply, Stop, saved error turns |
| `assistant/delete-chat.ts` | Deleting a chat (`DELETE /api/assistant/conversations/:id`): its messages, its held workflow, and the agent session behind it on the person's computers ([41 §6](41_AGENT_SESSIONS.md#6-deleting-and-cleaning-up)) |
| `assistant/agent.ts` | Model/tool loop, tool selection, write policy, final answer |
| `assistant/loop-config.ts` | The loop's numbers by model class, and the `ENSEMBLE_LOOP_CONFIG` override |
| `assistant/tool-output.ts`, `runaway.ts`, `compaction.ts` | Long results kept for `read_tool_output`, runaway detection, compaction |
| `assistant/state.ts` | Instructions (`assistantInstructions`), a message's context (`turnContext`), open item |
| `prompts/registry.ts` | Every prompt Ensemble sends, built by its real builder with sample values, for Settings → Prompts |
| `packages/prompts` | The instructions' words as Markdown sections (the shared constitution, the assistant's and nodes' own), their generated module and `assemble` |
| `assistant/skills/index.ts`, `skills/*.md` | Playbook parsing and routing, `map.md`, recipes; `diagram-skill.ts` adds `.github/skills/block-diagrams/SKILL.md` |
| `assistant/registry.ts`, `types.ts`, `tools/` | Hub and built-in app tools, `defineTool`, previews, operations |
| `assistant/apps.ts`, `mcp-tools.ts`, `connections.ts` | Grants and products, item and MCP tools, the Connected apps block, `hub_list_connections` |
| `assistant/mentions.ts` | Typed mentions (`@people:Mira Chen`) resolved by exact name in the space |
| `assistant/apply.ts`, `request.ts` | Applying held writes; internal route calls with the original credentials |
| `assistant/reply.ts`, `batch.ts`, `cutoff.ts`, `schedule.ts` | Claims allowed by receipts, all-or-nothing write batches, cut-off replies, past-date warnings |
| `assistant/refs.ts`, `packages/shared-types/src/assistant-text.ts` | Records a turn knows by id and title; reply text that names them by title (§4.1) |
| `lib/model-turn.ts`, `model-choice.ts`, `model-meta.ts` | Provider, model and effort; transport |
| `runtime/`, `apps/agent-runtime/ensemble_agent/` | TypeScript (in-process) and Python (hosted) provider adapters |
| `apps/hub-web/components/assistant`, `lib/assistant-surface.ts` | Dock, proposals, current view |

`lib/activity.ts` publishes `activity.changed` after a call starts, changes status or ends. Frames contain an activity ID and lifecycle phase, addressed only to its account (the owner when no request scope is present); a shared-space guest receives their own activity on their personal stream.

`components/live.tsx` refreshes the `agent-state` query on these events and when the stream connects or reconnects. Polling reconciles missed events. The dock's working text belongs to its local turn; another conversation's broadcast frame cannot replace it.

Direct completions in `lib/runtime.ts` (meeting preparation, meeting tasks, triage, document enrichment and model/skill tests) register their own activity until the call succeeds, fails or is stopped.

Stop and Pause abort the HTTP, in-process or subscription call through its signal; the HTTP/in-process completion retains its two-minute timeout. A completion nested inside an assistant turn or workspace job inherits that operation's activity and cancellation through `withActivity`, so it is counted once. Ending one completion leaves other active calls alone.

The top-bar activity endpoint and its pause, resume and stop controls are core routes, available without the optional Workspace module. `/api/agent/state` omits workspace jobs when that module is off. Until an activity snapshot is available, the pill says Checking; a failed check says Unavailable with Retry. Queued work, human decisions, stopping and paused states stay distinct from working.

### 4. Tool contract and execution

`defineTool` (`types.ts`) takes `name`, `area`, `description`, Zod `input`, `isWrite`, `risk`, and optionally `undoable`, `app` (grant/product/scope metadata), `outsideTransaction`, `alwaysHold`, `parallelSafe` (a read that may run beside the other reads of its step; `registry.ts` sets it on every Hub read), `readOnly` (it only looks, though it runs alone, such as a node's page snapshot: runaway detection never counts it as progress), `prepare`, `preview`, `run`. Optional fields stay optional: Responses tools are sent with `strict: false` by both transports.

- `toolsFor` (`registry.ts`) drops disabled write areas and missing modules. `toolsForTurn` (`apps.ts`) adds built-in app tools only for actual grants, products and scopes, plus `apps_*` item tools and enabled MCP tools: at most `MAX_APP_TOOLS` (80), built-in first, then `apps_search`/`apps_read`/`apps_post_update` (never dropped for MCP tools), then MCP.
- `drive_export_file` is a Google Drive write for the owner's connected account. Given an Ensemble file ID, it saves a new copy to My Drive, keeping the original name and bytes.
- Input and current access are validated before running; reads enforce scope too. Route-backed tools go through `request.ts` (`app.inject` with a server-only copy of the request's auth headers; in a node turn, the delegated identity of the call's space), so route validation, quotas, module and sharing checks apply. Headers are never model input.
- Stale page revisions, skill versions, file hashes and layout versions fail readably instead of overwriting newer work.
- `prepare` runs after validation, before preview or write, and fixes the exact records a filter means (`hub_delete_tasks` turns `all: true` into IDs; `hub_assign_to_agent` fixes profile and computer), so Apply changes only what was previewed.
- Results carry a summary and optional bounded data, `href`, invalidation keys or Undo entry. `trim` in `agent.ts` keeps oversized output out of the context. A single list (e.g. `hub_list_tasks`) is cut at whole items by `fitList` with a note naming the `offset` to continue. Anything else over the turn's inline budget ([Turn limits](#turn-limits-and-final-answer)) shows its start and its end in place (`headAndTailParts` in `lib/text.ts`), so a command's error or a result's last fields survive, and the whole result is kept for the turn as `out_<n>` (`TurnOutputs` in `assistant/tool-output.ts`): a line names its size, its lines, the characters shown, and how to read the rest with `read_tool_output`, by `id` with `offset` and `length` in characters, or with `grep` (words to find, in any case) and `context` lines around each match. That tool joins the turn's tools after the first kept output. A turn keeps at most 4,000,000 characters of such output (`keptOutputChars`); past that the oldest goes, and reading it says so. Long text fields are kept on their own lines, so a search finds lines. A call on an AI subscription is cut at 6,000 characters (`MAX_TOOL_RESULT_CHARS`) and nothing is kept. An excerpt is never reported as the whole document.
- A summary is display text: titles and counts, never ids (`Added 2 tasks: “Draft brief” and “Call Mira”.`; past five titles, `and N more`; repeated titles get a due date or a number). Ids stay in `data`. A held write's preview names the records it changes; a tool without `preview` gets `readablePreview` (`refs.ts`): its action and fields, ids replaced by the titles the turn knows, never raw JSON.

#### 4.1 Records by title, ids for machines

Ids are for tool calls, links and records; people read titles.

- **What the turn knows.** `refs.ts` collects `{ kind, id, label, detail? }` (`AssistantRef`) for every record the model is shown by id: the mentions, the open item and the personal skills named in the instructions (`stateRefs`), records named by the messages in the history (`historyRefs`), Ensemble Node's rooms (`extraRefs`), and each tool result (`refsFromResult`: objects with a real id and a title or name; kind from the row, its key or the tool's name; at most 50 per call). The list (at most 200) is sent as a `refs` stream frame before any text, and each call keeps its own as `refs`, which tool frames carry and `assistant_messages.tool_calls` saves.
- **What the model is told.** The instructions say ids are for tool calls and replies name records by title or as `[Title](ensemble://kind/id)`, with a raw id only when the person asks. History replays a write's summary with `Records: [Title](ensemble://kind/id)`, so later calls still have the ids.
- **What is saved.** A tool summary that still contains a known id shows its title (`formatEntityText` in plain mode, in `agent.ts` and on Apply). The reply text is saved as the model wrote it; the records it names by id are saved on it (`assistant_messages.mentions`, at most 60) and returned in the `done` frame. `POST /api/assistant/apply` saves each landed call's `refs` and returns them.
- **What is shown.** `formatEntityText` (`packages/shared-types/src/assistant-text.ts`) formats a reply for display: `[@Label](ensemble://kind/id)` shows its label and opens the record; a bare id of a known record becomes its title, linked (`“Draft brief” (id)` becomes the linked title); an unknown id stays, except one in brackets just after a quoted title (older receipts). An id or record link in brackets right after the record's own title, whole or its first clause (`Title (ensemble://task/id)`), links that title once; its label is never added beside the same words. Code, fenced blocks, block quotes, URLs and link targets are left alone. When the question asked for ids (`id`, `ids`, `uuid`, `identifier`), ids stay. Records that share a title get their kind, detail (due date, email) or a number. While text streams, a half-written known id or record link at the end is held back. The dock (`components/assistant/assistant-dock.tsx`, `lib/assistant-refs.ts`) uses each reply's call refs, saved refs and its question's mentions, and the `refs` frame while streaming; tool rows, Copy and the choice buttons use the same text without links. Page answers (`components/comments/ensemble-view.tsx`) use their calls' refs. `MarkdownText` renders `ensemble://` links anywhere. The Ensemble Node website applies the same rules to node replies ([35 §5](35_ENSEMBLE_NODE.md#5-a-node-turn)). The CLI's chat collects the `refs` frames and tool refs of the chat and shows replies, tool rows and Apply previews with titles (`titled` in `apps/cli/src/tui/app.tsx`); a terminal cannot open records, so record links (`ensemble://…`, app paths) print their title only. Tool errors meant for the model name no ids (`hub_stop_activity` says the work is no longer running). Stored replies and task content are never rewritten.

#### Turn limits and final answer

Every number of Ensemble's own loop is in one versioned config, `assistant/loop-config.ts`. `ENSEMBLE_LOOP_CONFIG` overrides it without a release: a JSON object with only the fields to change (`{"steps":{"key":60}}`), or the path of a file with one, read again at most once a minute. An invalid override is ignored and logged. Each turn's `assistant.turn` metric records `loop`: the config's version and hash, the model class, the steps it used and its cap, calls run in parallel, kept outputs, retries, nudges, compactions, a runaway stop and a pause at the checkpoint. A caller can pass `runAssistantTurn` a `trace` (`LoopTrace` in `agent.ts`), which the loop fills as it goes: a hash and count of the tools it offered, each tool call's name, time, state, result size, the size the model was shown and whether it was kept for `read_tool_output`, the tokens and estimated cost, and the same `loop` block; Ensemble Node keeps it as the turn's trace ([35 §5.7](35_ENSEMBLE_NODE.md#57-traces-outcomes-and-decisions)).

The defaults follow the model class: `included` (Ensemble's included models, which Ensemble pays for), `key` (the person's own API key) and `local` (Ollama).

| Setting | Included | Own key | Local |
|---|---|---|---|
| Model requests per turn (`steps`) | 24; Ensemble Code 24 too (`includedCode`, at least 16) | no cap | no cap |
| Pause to ask whether to go on (`checkpointSteps`) | none: the cap ends the turn | after 120 requests | after 120 requests |
| A tool result in place (`inlineChars`) | 8,000 characters | 16,000 | 8,000 |
| History (`historyTokens`) | 8,000 tokens | 24,000 | 4,000 |
| Context window (`contextTokens`, unless `contextTokens.models` names the model) | 128,000 tokens | 128,000 | 32,000 |

Where there is a cap, its last request is a tools-off final answer. Included models keep their credit budget besides ([33](33_INCLUDED_AI.md)); an owner caps their own key or local model only by setting `steps.key` or `steps.local`. Where there is none, the turn pauses at the checkpoint: its 120th request is a tools-off answer that says what it did, what it found and what is left, and the reply ends "I paused after 120 steps. Say continue to go on." (the turn result's `paused`). It is a confirmation, not a limit: "continue" starts a new turn that goes on with fresh counts. An Ensemble Node turn ends the same way, and its reply carries the question; a plan step's turn has no reply, so its step stays working with the pause leading its progress ([35 §6.2](35_ENSEMBLE_NODE.md#62-plans-and-missions)).

- **Reads run together.** When the model asks for several calls in one step, calls next to each other that `runsInParallel` (`registry.ts`) allows run at the same time, at most `parallelReads` (6) at once: tools that are not writes and set `parallelSafe` (every Hub read, Ensemble Code's folder reads, `read_tool_output`). Writes, connected-app and MCP tools and an Ensemble Node's own tools (which act on a computer or post) run one at a time, in order. Results go back in the model's order; held writes are previewed one by one and settled together (`settleWriteBatch`).
- **Long results** stay outside the context, readable with `read_tool_output` (§4).
- **Runaway detection** (`runaway.ts`), for every class, judged by what calls return. A call with the same tool and input (key order and spacing aside) that returns the same result again, or a round of two to four calls that comes back with the same results, changed nothing. The result is compared as the model was told it, leaving out record ids, times, durations and kept-output names, which every call makes anew. At the third repeat (`runaway.nudge`) the model gets one nudge to take another approach or answer; at the fifth (`runaway.stop`), or after eight steps in a row in which every call failed (`runaway.failedSteps`), no more tools run and the next request asks for the answer from what it has. Looking again at something that changed (a terminal or a status being polled) is never a repeat. Only progress starts the counts again: a call that can change something succeeded and returned what it had not returned before in the turn. A call that only looks is never progress: Hub reads, connected-app and MCP reads, and tools marked `readOnly`, such as an Ensemble Node's page snapshots, screenshots, page reads and terminal reads, and a room-bound node turn's reads of the room, its history and its board (`readsOnly`, `registry.ts`). If that request fails or gives no words, the reply says why the turn stopped and what it did, never an error.
- **Compaction** (`compaction.ts`), with no model call. Before each request the loop estimates it at four characters a token, tools included (an attached picture or file counts as 1,500 tokens). Past `compactAt` (60%) of the model's context window, older history replies become a placeholder, then older tool results of this turn become their one-line summaries, oldest first, until it fits; a shortened result's whole text stays readable with `read_tool_output`. The model's last eight replies and what follows them (`keepExchanges`) go last: only when the rest is not enough do their results shrink too, then their history replies, oldest first. User messages stay word for word, and so does the newest exchange (the model's last reply and its results). A shortened result keeps its `tool_call_id`, so it still answers its request. The chat gets the status line "Shortened earlier parts of this turn to fit the model's context.", and the metric counts it.
- **Model errors the runtime does not retry.** The runtime that calls the provider retries first, before any output (`retryPlan` in `runtime/payload.ts`, `retry_plan` in the Python runtime): a 429 or 503 up to three more times, waiting what Retry-After asks for (at most a minute each time) or a few seconds without it, and a 500, 502 or 504 twice. A 429 without Retry-After (such as `insufficient_quota`) and quota are never retried. The loop asks again only what is left (`loopRetries`, `lib/model-turn.ts`): a dropped connection or a cut stream, a 500, 502 or 504 that still reached hub-api, and a network or gateway timeout, after 5 and 20 seconds (`retryDelaysMs`), also after tools ran in the turn; the wait shows as a status line, and Stop ends it. A request that had started answering keeps its words instead (a cut-off reply, `cutoff.ts`). A 429, a 503, anything that came with Retry-After, quota, credits, a refused key or request, a model host that was never reached and the call's own time limit (§5) are not asked again by the loop. In an Ensemble Node turn, a rate limit before any tool ran goes to the node, which answers with its fast model or runs the turn again later ([35 §5.1](35_ENSEMBLE_NODE.md#51-lanes)).
- **Errors are sentences.** `friendlyModelError` (`lib/model-error.ts`) never passes on a provider's JSON or HTML: a failure without words reads "The model's service failed (502). Nothing more was changed.", and `safePublicError` (`lib/text.ts`) replaces any message that is a data document. What the provider said goes to the server log as the error's `cause`.

A held write is reported as proposed. A text-only reply that promises a lookup before any tool ran, or, after tools ran, writes a tool call as text or announces the next write ("Proceeding to create the task"; `leavesWorkUndone`), goes back once with a nudge to make the call.

A turn on an AI subscription runs the agent's own loop, with no limit of Ensemble's on its calls or turns ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)).

Error turns are saved but never enter model history as answers; without a valid final answer the UI shows the failure and Retry. A surface may pass a `verify` hook (Ensemble Node's answer check, [35 §6.1](35_ENSEMBLE_NODE.md#61-who-does-the-work)): on the model's final text it returns what is still missing, which goes back to the model as a user message, at most `MAX_VERIFY_ROUNDS` (2) per turn and only while a step with tools remains; if the model then fails, the answer it was sent back with stands.

### 10. Adding a tool

1. Add it beside its domain in `assistant/tools/` with `defineTool`: bounded, clearly named arguments; return real IDs and links.
2. Reuse the existing route or service for authorization and validation. Set `outsideTransaction` for network calls (never inside a Hub transaction) and `alwaysHold` where the write must always wait.
3. Register Hub tools in `registry.ts`; app tools also need metadata and resolution in `apps.ts`. Extend module and sharing restrictions as needed.
4. Add the tool name and a short recipe to the right `skills/*.md` (its `tools:` line decides when it is shown).
5. Test scope, stale input, Apply/Retry and failure; check Chat and Responses schema envelopes where affected.
6. Update this guide, [34](34_ASSISTANT_ACTIONS.md), [00](00_PROJECT_OVERVIEW.md) and the feature's doc in the same change.

#### 10.1 Adding a playbook

A playbook is a Markdown file in `assistant/skills/` with `key: value` front matter: `name`, `title`, `when` (required; `name` is what `hub_how_to` takes, `when` the index line), `tools` (shown while loaded), `match` (regex of words that preload it), `paths` and `mentions` (open paths and mention kinds that preload it), `appTools: true` (show every connected-app tool), `module` (hidden without that module), `requires` (tools the build must have, or the playbook is not offered: `setToolCatalog` in `registry.ts`), `include` (appends a shared skill; only `block-diagrams`).

Add one only for a distinct request area, keep the recipe small, and let `hub_how_to` load it. Do not put area instructions in the global prompt. Tile metadata is generated from the UI ([34 §3](34_ASSISTANT_ACTIONS.md#3-tiles-and-layouts)).
