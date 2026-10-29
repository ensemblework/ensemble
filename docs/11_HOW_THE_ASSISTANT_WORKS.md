# 11 · How the assistant works

The Hub assistant turns a request into typed, permission-checked tool calls. hub-api owns the loop, reads, writes and receipts; the model only picks among the tools a turn offers. Built-in Markdown playbooks (`apps/hub-api/src/assistant/skills/*.md`) tell it how to use them. Personal Skills are the person's own saved instructions, a separate library ([04](04_MODULE_SKILL_FORGE.md)).

This doc is the architecture. The exact action and tool map is [34](34_ASSISTANT_ACTIONS.md).

## 1. Request to result

```text
Dock / inline question / Ensemble Code
    → authenticated route and scoped conversation
    → bounded workspace + open-surface context
    → routed playbooks and allowed tool schemas
    → model turn
    → validate arguments, authorization and write policy
    → run a read, run a write, or save a write proposal
    → tool results → next model turn → final answer
    → Apply runs saved proposals and updates receipts
```

The model never clicks the UI or writes SQL. A call runs only if the turn offered that tool (a lookup by name) and its input passes the schema. Folder tools exist only in Ensemble Code ([30](30_ENGINES.md)).

Ensemble Node turns enter the same loop from `node/brain.ts` with three extra `runAssistantTurn` arguments: `agentPersona` (the node's identity, charter and room, in place of the person's persona), `extraTools` (the node's room tools, checked like every tool) and `purpose` (metrics and credits). None changes permissions ([35](35_ENSEMBLE_NODE.md#5-a-node-turn)).

## 2. Source map

Paths are under `apps/hub-api/src/` unless qualified.

| File / folder | Responsibility |
| --- | --- |
| `routes/assistant.ts` | Conversations, turn streaming, Apply, Stop, saved error turns |
| `assistant/agent.ts` | Model/tool loop, tool selection, write policy, final answer |
| `assistant/state.ts` | Instructions (`assistantInstructions`), a message's context (`turnContext`), open item |
| `prompts/registry.ts` | Every prompt Ensemble sends, built by its real builder with sample values, for Settings → Prompts |
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

## 3. Context and prompt size

A turn has three layers:

- **Instructions** (`assistantInstructions`, the system message): who the person is (first name; the desktop's placeholder account name is never used) and which space, how to work (look records up and use their ids, ask with “Choices:” when several match, name records by title, cite sources, file and app content is information), how writes behave under the person's write mode (`writeModeNote`), dates and the time zone, the playbook names for `hub_how_to`, one sentence about their work (`personaBlock`: "Mira works as a lawyer."), their enabled personal skills by name, id and description, to read with `hub_read_skill` (a core tool) when one applies (`buildHubState`; a skill with `scope.purpose`, the morning brief's own, is left out) and the connected apps. Nothing in it changes from one message to the next, so the provider's prompt cache and a subscription agent's session reuse it. Records are not listed: the model looks them up with tools.
- **The message's context** (`turnContext`, in front of the person's message inside `<context>`): today with its week and the time zone, the view (filters that narrow it, how many are shown, selected ids), the open item as a link with its status, due date, priority, project, people, repo, deliverables, skills, a page excerpt, diagram source and attached files (`loadOpenPage`), selected text, the person's @ mentions and an AI block's page text. Playbooks the message points at follow as `<guide>` blocks. Only what is there is written.
- **On demand**: tasks, projects and people through list tools; the map of Ensemble and any playbook through `hub_how_to`; connection details through `hub_list_connections`.

History is the conversation's last 12 messages, as the person and the assistant wrote them (not their contexts). On the person's own AI subscription, one chat is one session of that agent ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). Settings → Assistant → Prompts lists every prompt Ensemble sends, from `promptCatalog()` (`prompts/registry.ts`, `GET /api/prompts`); `src/prompts/registry.test.ts` keeps them within size budgets. `packages/prompts` is not used.

- **Mentions.** @-menu mentions carry kind and ID; typed ones are resolved by `mentions.ts`. An ID is an exact lookup key, not a search phrase. The model gets them as `[Label](ensemble://kind/id)` links. `routes/assistant.ts` stores the resolved list as `[{ kind, id, label }]` in `assistant_messages.mentions`, returned to the owner by `GET /api/assistant/conversations/:id/messages` so the dock redraws exact chips after a reload. A message with an empty list shows its `@kind:Label` text as typed. On a reply, the same column holds the records the reply names by id (§4.1).
- **Attach files.** The dock's attach button uploads from the computer into Files or chooses saved files (`components/files/add-to-message.tsx`, only files saved in Ensemble, never connected apps); files can be dropped or pasted too. Up to 8 per message (`CHAT_FILES_MAX`) are sent as file mentions. `assistant/attachments.ts` gives the model every attached file itself (pictures as image parts, everything else as file parts); if the provider refuses the request, it goes again with the files verified for that model, then with none. A person's own subscription agent gets the files through its CLI. `hub_view_file` opens a file from Files, and a replayed earlier message names its files as links rather than resending them. Ensemble's extracted text of a file is not given to the model: `hub_read_file` is off, and `hub_search_context` / `hub_read_context` leave uploaded files out ([38](38_AGENT_READABLE_FILES.md)).
- **The screen.** `AssistantPageContext` carries the path, selected text (≤ 2,000 characters) and `surface`: kind (`desk`, `board`, `context`, `widgets`), tab, filters, selected and visible IDs (≤ 100 each), tile geometry; the dock adds a fixed list of URL parameters. Every ID is resolved in the active space; a supplied ID is never evidence of access. `hub_read_surface` reads scoped data for supported views, never pixels, the DOM or other apps.

**Connected apps.** The instructions name every app connected in this space (`appsPrompt`, from `loadConnections`; MCP servers without a sign-in are marked public data only), at most 30 (the rest via `hub_list_connections`), and the apps added but failing, to reconnect. They say that any other app is not connected (Settings → Connections), and that a change in one waits for Apply with who gets an email (or that app changes are switched off). How each app is reached and with which tools comes from the `apps` playbook and `hub_list_connections`. A guest gets no app paragraph, and tokens are never read for it.

App content (MCP tools included) is read only when the person asks for that app's content, asks to search connected apps, or gives an item link; a connection, the app list or a general file question is not enough. Saved Ensemble files and Hub context are the default; an unclear source gets a question first.

### Playbook routing

- `routePlaybooks` (`skills/index.ts`) scores playbooks by `match` words (2–3) and mention kinds (2); the open path adds 1, which only breaks ties: a page alone loads nothing. At most **two** are preloaded, as guides in the message's context. The instructions name every playbook; `hub_how_to`'s description says what each covers, and `hub_how_to` with `map` returns `map.md`.
- A message naming an app connected in this space also loads `apps` as a third. Names come from that turn's connections (`appNames`: catalog name, id, vendor, parts of a combined name like "Jira & Confluence"); everyday-word names ("Box", "Close", "Front") count only capitalised. A meeting-notes request with a meeting-notes app connected loads it too.
- `hub_how_to` loads another playbook and adds its tools for the rest of the loop.
- A simple todo request gets a one-line recipe and five tools (`hub_how_to`, `hub_create_tasks`, `hub_list_tasks`, `hub_list_people`, `hub_list_projects`). Otherwise the turn shows the nine `CORE_TOOLS` (`skills/index.ts`) plus the loaded playbooks' tools. Ensemble Code uses the same routing plus its own tools.
- Every model request carries at most **128 tool schemas**. `ENSEMBLE_ASSISTANT_TOOLSETS=off` shows every allowed tool; it turns off routing, not the cap or authorization.

Routing changes only what the model sees; what may run is every tool the settings allow. Prompt caching depends on the provider ([CACHING](CACHING.md)).

## 4. Tool contract and execution

`defineTool` (`types.ts`) takes `name`, `area`, `description`, Zod `input`, `isWrite`, `risk`, and optionally `undoable`, `app` (grant/product/scope metadata), `outsideTransaction`, `alwaysHold`, `prepare`, `preview`, `run`. Optional fields stay optional: Responses tools are sent with `strict: false` by both transports.

- `toolsFor` (`registry.ts`) drops disabled write areas and missing modules. `toolsForTurn` (`apps.ts`) adds built-in app tools only for actual grants, products and scopes, plus `apps_*` item tools and enabled MCP tools: at most `MAX_APP_TOOLS` (80), built-in first, then `apps_search`/`apps_read`/`apps_post_update` (never dropped for MCP tools), then MCP.
- Input and current access are validated before running; reads enforce scope too. Route-backed tools go through `request.ts` (`app.inject` with a server-only copy of the request's auth headers), so route validation, quotas, module and sharing checks apply. Headers are never model input.
- Stale page revisions, skill versions, file hashes and layout versions fail readably instead of overwriting newer work.
- `prepare` runs after validation, before preview or write, and fixes the exact records a filter means (`hub_delete_tasks` turns `all: true` into IDs; `hub_assign_to_agent` fixes profile and computer), so Apply changes only what was previewed.
- Results carry a summary and optional bounded data, `href`, invalidation keys or Undo entry. `trim` in `agent.ts` cuts oversized output: a single list (e.g. `hub_list_tasks`) is cut at whole items by `fitList` with a note naming the `offset` to continue; anything else becomes a text preview. An excerpt is never reported as the whole document.
- A summary is display text: titles and counts, never ids (`Added 2 tasks: “Draft brief” and “Call Mira”.`; past five titles, `and N more`; repeated titles get a due date or a number). Ids stay in `data`. A held write's preview names the records it changes; a tool without `preview` gets `readablePreview` (`refs.ts`): its action and fields, ids replaced by the titles the turn knows, never raw JSON.

### 4.1 Records by title, ids for machines

Ids are for tool calls, links and records; people read titles.

- **What the turn knows.** `refs.ts` collects `{ kind, id, label, detail? }` (`AssistantRef`) for every record the model is shown by id: the mentions, the open item and the personal skills named in the instructions (`stateRefs`), records named by the last 12 messages (`historyRefs`), Ensemble Node's rooms (`extraRefs`), and each tool result (`refsFromResult`: objects with a real id and a title or name; kind from the row, its key or the tool's name; at most 50 per call). The list (at most 200) is sent as a `refs` stream frame before any text, and each call keeps its own as `refs`, which tool frames carry and `assistant_messages.tool_calls` saves.
- **What the model is told.** The instructions say ids are for tool calls and replies name records by title or as `[Title](ensemble://kind/id)`, with a raw id only when the person asks. History replays a write's summary with `Records: [Title](ensemble://kind/id)`, so later calls still have the ids.
- **What is saved.** A tool summary that still contains a known id shows its title (`formatEntityText` in plain mode, in `agent.ts` and on Apply). The reply text is saved as the model wrote it; the records it names by id are saved on it (`assistant_messages.mentions`, at most 60) and returned in the `done` frame. `POST /api/assistant/apply` saves each landed call's `refs` and returns them.
- **What is shown.** `formatEntityText` (`packages/shared-types/src/assistant-text.ts`) formats a reply for display: `[@Label](ensemble://kind/id)` shows its label and opens the record; a bare id of a known record becomes its title, linked (`“Draft brief” (id)` becomes the linked title); an unknown id stays, except one in brackets just after a quoted title (older receipts). Code, fenced blocks, block quotes, URLs and link targets are left alone. When the question asked for ids (`id`, `ids`, `uuid`, `identifier`), ids stay. Records that share a title get their kind, detail (due date, email) or a number. While text streams, a half-written known id or record link at the end is held back. The dock (`components/assistant/assistant-dock.tsx`, `lib/assistant-refs.ts`) uses each reply's call refs, saved refs and its question's mentions, and the `refs` frame while streaming; tool rows, Copy and the choice buttons use the same text without links. Page answers (`components/comments/ensemble-view.tsx`) use their calls' refs. `MarkdownText` renders `ensemble://` links anywhere. The Ensemble Node website applies the same rules to node replies ([35 §5](35_ENSEMBLE_NODE.md#5-a-node-turn)). Stored replies and task content are never rewritten.

### Turn limits and final answer

In `agent.ts`: `MAX_STEPS` 8 model requests per Hub turn and `MAX_CODE_STEPS` 16 for Ensemble Code, the last one a tools-off final answer; `MAX_TOOL_RESULT_CHARS` 6,000 per tool result; `MAX_COMPUTER_CALLS` 24 tool calls per turn on an AI subscription ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). A held write is reported as proposed. Error turns are saved but never enter model history as answers; without a valid final answer the UI shows the failure and Retry.

## 5. Provider and credential paths

Hosted calls normally go through the Python runtime; desktop and CLI use the in-process TypeScript adapters, with the same tool-turn contract. Saved keys are encrypted and resolved by the runtime making the call; a hosted account cannot borrow operator environment keys or CLI sign-ins. Provider and model are explicit; effort is checked against the model before spending, and an unsupported option is refused. Included models reserve and settle account credits, also from a paired desktop or CLI, and the Azure key stays on the server ([33](33_INCLUDED_AI.md)). AI subscriptions run on the paired computer with the tool's own sign-in ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)). Policy: [01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy).

## 6. Apply, Undo and dependent actions

`holdsAssistantWrite` (`agent.ts`) applies `settings.assistant.writePolicy`: `immediate` (default; Settings → Assistant → "Just do it (undoable)") runs Hub writes at once with Undo, `preview` waits for Apply in the chat, `needs-me` waits on the Needs me page. Connected-app writes (area `apps`) and `alwaysHold` tools always wait for Apply ([34 §2](34_ASSISTANT_ACTIONS.md#2-writes-that-always-wait-for-apply)). Under `preview` and `needs-me`, the inline artifact flow creates a requested diagram or plot (`hub_create_diagram`, `hub_create_plot`) at once. Each turn adds a `writeModeNote` system line saying which writes run now, so playbooks work under every policy.

`POST /api/assistant/apply` resolves calls saved on the authorized conversation and message, checks state, revalidates arguments and permissions, and locks against double Apply. It never accepts a new tool call as approval.

`applyHeldCalls` (`apply.ts`) runs Hub writes in one transaction (30 s timeout) with one Undo group. Outside writes (area `apps` or `outsideTransaction`) run afterwards, one at a time, outside the transaction; each is ledgered as `apps.<tool>` or `assistant.<tool>` once done. After a partial failure, receipts separate succeeded, failed and unattempted calls, and Retry does not resend succeeded ones. Connected-app writes have no Hub Undo.

### Ordered workflows

`hub_run_workflow` (`tools/workflows.ts`) proposes **2–12 ordered writes** under one Apply. Each step has an `id`, a tool and typed `input`; a later value may be `{"$ref": "person.person.id"}` or `tasks.tasks.0.id`, pointing backward only. Reads happen before proposing; read steps and nested workflows are refused.

The plan is bound to the saved proposal by its hash, and `assistant_workflows` keeps per-step state by space, actor, conversation and tool-call ID. Each step rechecks settings, access and module/app availability. Retry skips successful steps; a failure stops the rest and reports what finished, without rolling back outside changes. A step interrupted while running is never replayed automatically; the UI offers **Retry remaining steps** without claiming completion. Hub steps can have separate Undo entries.

## 7. Permissions and sharing

Layers: authentication, space and resource access, modules, allowed write areas (`settings.assistant.allowedWriteAreas`), connected-app writes (`settings.assistant.connectedAppWrites`), grant/product/tool state, tool preconditions, Apply. A setting cannot authorise an unavailable connector, and a guest's workflow cannot use the owner's private apps. Shared editors get content-scoped tools; viewers get no write tools. Reminders, the owner's calendar copies, private apps, imports and layouts, secrets and account controls keep their own checks. Apply rechecks permissions ([29](29_SHARING.md)).

## 8. Capability areas

Tool names per request: [34](34_ASSISTANT_ACTIONS.md).

### 8.1 Pages, records, files and skills

Writes use real IDs, revisions and schema validation; record tools cover implemented fields only, and arrays documented as complete lists replace rather than append. Original-file edits are format-specific and hash-guarded ([32](32_FILES.md)). Profile layouts differ from the widgets view ([34 §3](34_ASSISTANT_ACTIONS.md#3-tiles-and-layouts)). Personal skills use versioned routes ([04](04_MODULE_SKILL_FORGE.md)).

### 8.2 Connected apps

What is connected comes from the block and `hub_list_connections` (§3). Attach saves a source copy that refresh updates where supported. Source and container IDs are provider-specific; project-link IDs can differ from item-search IDs. Board imports preview and map before Apply starts a background job. Unknown free/busy is never free time. No tool sends mail, Slack or Teams messages, and a catalog entry does not prove an action exists ([31](31_CONNECTORS_IN_USE.md)).

### 8.3 Running work, Code and settings

`hub_assign_to_agent` (`tools/agent-assign.ts`) assigns a task under a run profile: the one named, else the default (`pickRunProfile`: starred, else first saved, else built-in Quick settings). It runs on the computer named (`"any"` for "my computer"), else the profile's computer, else this server when the engine is Ensemble's agent and the server runs agents, else the most recently seen online paired computer (else the most recently seen one). It sends the same request as `POST /api/agent/assign` (`createJob`), always waits for Apply, and is refused while the agent is paused; the computer rechecks the job against its own folders and rules ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). What the person names in the request wins over the profile: the agent, `model`, `effort`, `context` (GitHub Copilot's long window), `branch`, and `pullRequest` (`{base, merge}`, any base, empty for the default branch: "make branch A, open a pull request against testing and merge it" is `branch: "A"`, `pullRequest: {base: "testing", merge: "auto"}`; *ask* confirms on Needs me first; [24 §5.1](24_DESKTOP_SANDBOXING.md#51-pull-requests)). With the profile's git choice No limits the agent may also push and open or merge pull requests itself. `session` (from `hub_list_agent_sessions`: the person's agent sessions, newest first, each with agent, computer, folder, tasks, status and a one-line summary; `taskId` and `query` narrow it) continues in that session: its computer, folder and agent, which resumes its own conversation ([30](30_ENGINES.md), Agent sessions). `hub_list_agent_options` lists profiles (default marked) and paired computers (online state, shared folders, which are shared as repositories, the coding agents each runs, and whether it opens pull requests).

The assistant never runs commands. Ensemble Code adds folder-reading tools and `ensemble_start_agent` ([30](30_ENGINES.md)) and does not bypass routing or host security. Settings tools change allowlisted keys only; model choice uses the available catalog and validates effort. Secrets, permissions, folder trust and account controls stay human actions.

## 9. Failure behavior

Besides the stale-input (§4), partial-Apply and workflow (§6) cases:

| Failure | Handling |
| --- | --- |
| Invalid or unknown call | Schema or "no tool called …" error; nothing dispatched |
| Expired connector grant | Show reconnect; the saved copy is not presented as live |
| Import started | Return job ID and status; check progress before reporting done |
| Stop or disconnect | Keep known usage and receipts; an accepted remote request may still finish |
| Unavailable model | Saved readable error with Retry, never a success-shaped answer |

## 10. Adding a tool

1. Add it beside its domain in `assistant/tools/` with `defineTool`: bounded, clearly named arguments; return real IDs and links.
2. Reuse the existing route or service for authorization and validation. Set `outsideTransaction` for network calls (never inside a Hub transaction) and `alwaysHold` where the write must always wait.
3. Register Hub tools in `registry.ts`; app tools also need metadata and resolution in `apps.ts`. Extend module and sharing restrictions as needed.
4. Add the tool name and a short recipe to the right `skills/*.md` (its `tools:` line decides when it is shown).
5. Test scope, stale input, Apply/Retry and failure; check Chat and Responses schema envelopes where affected.
6. Update this guide, [34](34_ASSISTANT_ACTIONS.md), [00](00_PROJECT_OVERVIEW.md) and the feature's doc in the same change.

### 10.1 Adding a playbook

A playbook is a Markdown file in `assistant/skills/` with `key: value` front matter: `name`, `title`, `when` (required; `name` is what `hub_how_to` takes, `when` the index line), `tools` (shown while loaded), `match` (regex of words that preload it), `paths` and `mentions` (open paths and mention kinds that preload it), `appTools: true` (show every connected-app tool), `module` (hidden without that module), `include` (appends a shared skill; only `block-diagrams`).

Add one only for a distinct request area, keep the recipe small, and let `hub_how_to` load it. Do not put area instructions in the global prompt. Tile metadata is generated from the UI ([34 §3](34_ASSISTANT_ACTIONS.md#3-tiles-and-layouts)).

## 11. Limits and evaluation

The assistant acts only through offered tools. It cannot see pixels or other applications, run arbitrary recurring routines, understand scanned, audio or video input, edit every original format, or change security settings.

`apps/hub-api/scripts/assistant-eval.ts` is an opt-in real-model evaluation over synthetic workspaces: it reports input, output and cached tokens and applies held changes in its isolated database. Keep live-provider evidence in PRs.
