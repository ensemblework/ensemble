# 11 · How the assistant works

The Hub assistant turns a request into **typed, permission-checked tool calls**. hub-api owns the loop, reads/writes and receipts; a model chooses among the tools it is offered. Built-in Markdown playbooks explain how to use those tools. Personal Skills are a separate library of saved user instructions.

Code inspected **18 Oct 2026**. [34](34_ASSISTANT_ACTIONS.md) lists current actions and limitations. This document explains their implementation and how to extend it without expanding every prompt.

## 1. Request to result

```text
Dock / inline question / Ensemble Code
    → authenticated route and scoped conversation
    → bounded workspace + open-surface context
    → intent-selected playbooks and allowed tool schemas
    → model turn
    → validate arguments, authorization and write policy
    → execute read OR save write proposal
    → tool results → next model turn → final answer
    → Apply executes saved proposals and updates receipts
```

The model does not click the UI or generate arbitrary SQL to perform app actions. Registry lookup and schema validation determine which operation can execute. Filesystem tools belong to the separate Code/agent execution context.

## 2. Source map

All paths below are relative to `apps/hub-api/src/` unless qualified.

| File / folder | Responsibility |
| --- | --- |
| `routes/assistant.ts` | Conversation/messages, turn streaming, Apply, stop and persisted error turns |
| `assistant/agent.ts` | Bounded model/tool loop, cancellation, dynamic tool selection and final answer |
| `assistant/state.ts` | Small current workspace snapshot, open-item projection and prompt construction |
| `assistant/skills/index.ts`, `skills/*.md` | Intent routing, area index and exact tool recipes |
| `assistant/registry.ts` | Hub tools, built-in connected-app tools, module filtering and schemas |
| `assistant/types.ts`, `tools/` | `defineTool`, input/output contracts, previews and domain operations |
| `assistant/apps.ts`, `mcp-tools.ts` | Per-person grants/products, dynamic connected-item/MCP tools and resolution, the Connected apps prompt block |
| `assistant/connections.ts`, `tools/connections.ts` | Every app connected in the space with how, account and tools, for the prompt, routing and `hub_list_connections` |
| `assistant/apply.ts` | Transactional Hub batches and sequential outside writes |
| `assistant/request.ts` | Internal route calls preserving the original server-only request credentials |
| `assistant/reply.ts`, `batch.ts` | Proposal-aware reply/receipt and grouped-write behavior |
| `lib/model-turn.ts`, `model-choice.ts`, `model-meta.ts` | Provider/model/effort selection and model transport |
| `runtime/` and `apps/agent-runtime/ensemble_agent/` | Local TypeScript and hosted Python provider adapters |
| `apps/hub-web/components/assistant`, `lib/assistant-surface.ts` | Dock, proposals, current view and selection |

## 3. Context and prompt size

`buildHubState` reads a bounded summary, not the whole account. `loadOpenPage` resolves the actual open task/page/project/meeting ID; current excerpts, linked records, embedded diagram source and attached-file summaries are bounded. Typed mentions retain kind/ID; names without IDs are resolved in the current scope. An ID is an exact lookup key, not a search phrase. `routes/assistant.ts` resolves them before it saves the person's message and stores the result as `[{ kind, id, label }]` in `assistant_messages.mentions` (migration `20261018130000_assistant_message_mentions`). `GET /api/assistant/conversations/:id/messages` returns that column, only for the conversation's owner, so the dock draws exact mention chips after a reload. Messages saved before the column have `[]` and show their `@kind:Label` text as typed, because the end of an unknown label cannot be told from the words after it.

The prompt places stable instructions/playbooks before changing workspace state. Personal skills start as name/description entries; relevant bodies are read on demand. Settings → Prompts exposes the actual prompt sources; `packages/prompts` is not the working prompt store.

Every turn's prompt carries a "Connected apps in this space" block (`appsPrompt` in `apps.ts`, built from `loadConnections` in `connections.ts`). It names every connected app by its catalog name, one line each: how it is connected (sign-in, token, MCP sign-in, MCP token, MCP without sign-in, which only sees public data), the account label, and what reaches it, for example `- Vercel (token, as mira-chen): deployments and projects via apps_search/apps_read app "vercel".` It covers token and OAuth accounts (`oauth_tokens`, item sources from `connectedItemSources`), the built-in Google/Microsoft/Zoom/Docusign/Jira tools with the products switched on, connected MCP servers with how many of their tools the turn offers, and meeting-notes apps (`hub_import_meeting_notes`). MCP servers that were added but are pending or failing get one "not working" line. Apps that are not connected are not listed; the block says that an app it does not name is not connected in this space and points to Settings → Connections. At most 30 apps are listed (the rest through `hub_list_connections`), each line at most 400 characters. A guest in a shared space gets no block: the owner's connections are private, and `loadConnections` returns nothing for a guest. Tokens are never read for it.

`AssistantPageContext.surface` can carry surface kind/tab, filters, selected/visible IDs and supported layout state. `hub_read_surface` reads current scoped data for supported views. It does not read pixels, arbitrary DOM, another app's window or every record that exists outside the current view.

### Playbook routing

- `routePlaybooks` scores request intent and path; explicit request intent wins over path-only matches.
- At most **two** playbooks are preloaded. The area index/map names the routes and action tools.
- A message that names an app connected in this space also loads the `apps` playbook, as a third, so the app's tools (`apps_search`, its `mcp_*` tools…) are shown. The names come from that turn's connections (`appNames`: catalog name, id, vendor, the parts of a combined name such as "Jira & Confluence"), not a fixed list; app names that are everyday words ("Box", "Close", "Front") count only with a capital. A meeting-notes request while a meeting-notes app is connected loads it too. Questions such as "what's connected?" or "is Asana connected?" match the playbook's own words.
- `hub_how_to` loads another recipe and makes its tools available during the same loop.
- A simple todo request gets a short recipe and only the relevant create/list/how-to tools. It need not scan every feature manual.
- Hub and Ensemble Code use the same routing; Code retains its local tools.
- Every model request is bounded to **128 tool schemas**, including `ENSEMBLE_ASSISTANT_TOOLSETS=off` debug mode. That environment option disables area routing, not the provider cap or authorization.

This reduces input and can improve reuse of a stable prompt prefix. Provider caching, actual cached-token counts and model quality remain provider-dependent; routing is not a guarantee of a fixed token bill or universal small-model success. [CACHING](CACHING.md).

## 4. Tool contract and execution

A `defineTool` entry specifies name, area, description, Zod input, write/read flag, risk, optional Undo, optional preview and `run`. Optional fields must remain optional in the provider schema. Chat and Responses have different envelopes; Responses tools deliberately send `strict: false` so optional arguments are not converted into required fabricated values by strict schema normalization.

`toolsFor` removes disabled write areas and unavailable modules. `apps.ts` offers built-in app tools only for the actual grants/products/scopes, adds supported dynamic item tools and wraps enabled vendor MCP tools. A turn offers at most `MAX_APP_TOOLS` (80) app tools: built-in ones first, then `apps_search`/`apps_read`/`apps_post_update`, then MCP tools. The `apps_*` tools are never dropped to make room for MCP tools, since they are the only reach into apps such as Vercel or Todoist. A missing tool cannot be invoked by inventing its name.

Before running, the server validates input and current access. Read tools still enforce scope. Existing API-backed tools use `assistant/request.ts` to preserve route auth, quotas, module and sharing checks. Original request headers remain server-only and are never model input. Stale page revisions, skill versions, file hashes and layout versions cause a readable failure instead of overwriting new work.

Results contain a summary and optional bounded data, `href`, invalidation keys or Undo entry. The loop truncates oversized tool output (`trim` in `agent.ts`): a result holding one list, such as `hub_list_tasks`, is cut at whole items by `fitList`, so every id the model sees is complete, and the note names the `offset` to continue from; any other oversized result becomes a text preview. Readers offer chunking for longer content. Do not claim a complete document was read if only an excerpt was returned.

A tool may define `prepare`, which runs after the input is validated and before the preview or the write. Tools that act on a filter use it to fix the exact records (`hub_delete_tasks` turns `all: true` into task ids; `hub_assign_to_agent` fixes the profile and computer), so Apply changes only what the preview showed.

### Turn limits and final answer

`MAX_STEPS` is 8 for Hub and `MAX_CODE_STEPS` 16 for Ensemble Code; the loop reserves its last request for a tools-disabled final answer. Tool result bodies are capped by `MAX_TOOL_RESULT_CHARS` (6,000). Subscription-driven loops have their separate call cap (`MAX_COMPUTER_CALLS`, 24). These are loop guards, not promises that every request fits in one turn.

A held action is reported as proposed. Persisted unavailable/error turns do not enter model history as valid assistant answers. If no valid final answer arrives, the UI shows failure/retry rather than only tool receipts styled as success.

## 5. Provider and credential paths

Hosted calls normally use the Python runtime; desktop/CLI local calls use TypeScript in-process adapters. Both implement the same tool-turn contract. It is no longer true that only Python can hold model keys. User-saved keys are encrypted and resolved by the appropriate runtime; hosted ordinary accounts cannot borrow arbitrary operator environment/CLI credentials.

Provider and model are explicit. Effort is checked against the selected model before spending; unsupported options are refused rather than silently dropped. Catalog discovery/cache and refresh are metadata-only. Included-model calls use account reservations/settlement, including through paired desktop/CLI; the Azure key remains on the host. Supported local subscriptions use the paired computer's bridge and its own sign-in. See [01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy), [30](30_ENGINES.md), [33](33_INCLUDED_AI.md).

## 6. Apply, Undo and dependent actions

`holdsAssistantWrite` applies the person's write policy, `settings.assistant.writePolicy`: `immediate` (Settings → Assistant → "Just do it (undoable)", the default), `preview` (waits for Apply in the chat) or `needs-me`. Migration `20261018120000_assistant_writes_immediate` moved accounts that had Preview saved to `immediate` on 18 Oct 2026; Needs me was kept. Connected-app writes and `alwaysHold` tools (settings changes, agent assignments) always wait for Apply. Under Preview, the inline artifact flow has a limited existing exception for requested diagrams/plots. Playbooks are written for every policy, so each turn adds one system line from `writeModeNote` saying which writes run at once and which wait.

`POST /api/assistant/apply` resolves calls saved on the authorized conversation/message, checks state, validates proposed arguments and current permissions, and locks against duplicate application. It does not accept an arbitrary new tool call as an approval.

`applyHeldCalls` groups ordinary Hub writes in a database transaction (30 s timeout, so a large batch is not rolled back by Prisma's 5 s default) with one Undo group. Outside writes run afterward, sequentially, without holding the Hub transaction across a slow network request. Each landed outside write is ledgered. After a partial failure, receipts distinguish succeeded, failed and unattempted calls; retry does not resend the succeeded calls. External writes generally have no Hub Undo.

### Ordered workflows

`hub_run_workflow` contains **2–12 ordered writes**. Resolve/read source IDs before proposing it. Steps may reference earlier results with `{"$ref":"person.person.id"}`; forward references, nested workflows and read steps inside the plan are refused.

The approved plan is bound to the saved proposal. `AssistantWorkflow` retains its canonical plan hash and per-step state, scoped by space, actor, conversation and tool-call ID. Each step rechecks current settings, access and module/app availability. Retry skips successful steps and stops on failure. A step interrupted in Running has an uncertain result and is refused automatic replay until inspected. The UI offers Retry remaining steps without claiming completion. Separate Hub steps can retain separate Undo entries.

## 7. Permissions and sharing

The controlling layers are authentication, current-space/resource access, module availability, allowed write areas, connected grant/product/tool state, tool schema/preconditions and Apply. Settings cannot turn an unavailable connector into an authorized one. A workflow cannot use an owner's private app as a guest.

Shared editors receive supported content-scoped tools; viewers cannot write. Personal reminders, owner calendar copies, private apps/imports/layouts, secrets and account controls remain restricted by their own checks. Apply rechecks permissions even when a tool was available earlier in the turn. [29](29_SHARING.md).

## 8. Capability areas

The exact tool/action map is [34](34_ASSISTANT_ACTIONS.md), avoiding a second long inventory here.

### 8.1 Pages and personal records

Task/page creation and precise block edits use real IDs, revisions and schema validation. People/project/repo and profession-specific record tools implement supported domain fields; arrays marked as complete lists replace rather than append. Comments and resource maintenance reuse existing routes. They are not arbitrary record/SQL access.

### 8.2 Connected apps

What is connected comes from the prompt's Connected apps block and `hub_list_connections` (§3), which also answers "what's on my screen" on Settings → Connections through `hub_read_surface`. Search/read is explicit. Attach saves a source copy; refresh updates that copy when supported. Source/container IDs are provider-specific, and project-link source IDs can differ from item-search provider IDs. Whole-board imports preview/map before Apply starts a background job. Progress must be checked separately. Native Google/Outlook calendars support current event operations and supported recurrence/availability; unavailable free/busy is not free time.

Native mail/Slack/Teams sending is not offered. Supported connected-item updates and enabled vendor MCP tools may have their own writes after Apply. A catalog entry is not proof that a particular action exists. [31](31_CONNECTORS_IN_USE.md).

### 8.3 Running work, Code and settings

Assignments enter the durable job queue and retain execution choices. In chat, `hub_assign_to_agent` (`tools/agent-assign.ts`) assigns a task under a run profile: the one the person names, else their default (the starred one, else the first saved, else the built-in Quick settings; `pickRunProfile`). It runs on the computer they name (or `"any"` for "my computer"), else the profile's computer, else this server when it runs Ensemble's agent, else their most recently seen paired computer. It sends the same request as `POST /api/agent/assign` (`createJob`), always waits for Apply, refuses while the agent is paused, and the computer checks the job again against its own folders and rules ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). `hub_list_agent_options` lists the profiles (default marked) and paired computers (online, shared folder names). The assistant itself never runs commands. Ensemble Code adds its own local tools; it is not an exception to Hub routing or a way to change host security settings. Settings tools edit the allowlist; model selection uses the actual available catalog and validates effort. Secret/permission/folder-trust/account controls remain human actions.

### 8.4 Files, layouts and skills

Original edits use format-specific operations and hashes. Native desk/Context/Board layouts differ from alternate widgets. Personal skills use current versioned routes and are distinct from built-in playbooks. Owning guides: [32](32_FILES.md), [34](34_ASSISTANT_ACTIONS.md), [04](04_MODULE_SKILL_FORGE.md).

## 9. Failure behavior

| Failure | Expected handling |
| --- | --- |
| Invalid/unknown call | Reject with schema or tool error; no invented dispatch |
| Stale revision/hash/version | Read latest data and prepare a new precise edit |
| Expired connector grant | Show reconnect; do not pretend the saved copy is live |
| Apply partial failure | Keep landed receipts; stop remaining outside operations |
| Workflow interruption | Refuse uncertain step replay; retain successful steps |
| Import started | Return job ID/status and inspect progress before reporting complete |
| Stop/disconnect | Preserve known usage/receipts; an accepted remote request may still finish |
| Unavailable model | Persist readable error/Retry; no success-shaped answer |

## 10. Adding a tool

1. Add the operation beside its domain in `assistant/tools/` using `defineTool`. Use bounded, clearly named arguments and return real IDs/links.
2. Reuse the existing service/route authorization and validation. Declare outside-transaction and always-hold behavior correctly; do not place network calls inside a grouped Hub transaction.
3. Register Hub tools in `registry.ts`; connected-app tools need the app metadata/resolution path in `apps.ts`. Extend module/sharing restrictions where appropriate.
4. Add the exact tool name and a short recipe to the relevant `skills/*.md` playbook. Add a new playbook only when it represents a distinct request area, with explicit intent/path metadata.
5. Test meaningful scope, stale-input, Apply/retry and failure behavior. Check both Chat and Responses schema envelopes where affected.
6. Update this guide, [34](34_ASSISTANT_ACTIONS.md), [18](18_WHAT_IS_REAL.md) and the feature's owning documentation in the same change.

### 10.1 Adding a playbook

A playbook needs a distinct name/title, intent match, applicable paths and exact tool list in its front matter. Add the smallest useful recipe and let `hub_how_to` load it on demand; do not preload every area.

Do not add unrelated full instructions to the global prompt. Generated tile metadata comes from the actual UI catalog (`apps/hub-web/e2e/assistant-tile-catalog.ts`); update/check it through that generator instead of hand-maintaining a second tile list.

## 11. Honest limits and validation

The assistant cannot inspect every pixel/open application, execute arbitrary recurring routines, understand scanned/audio/video input, edit every original format or control every security setting. It only acts through offered, implemented operations.

`apps/hub-api/scripts/assistant-eval.ts` supports real-model evaluation over synthetic workspaces with usage/cache reporting. Prior GPT-5 mini exercises covered selected successful workflows; they do not establish reliability for every prompt or real calendar/connector account. The documentation audit itself only reviews source and docs. Keep live-provider evidence and screenshots in PRs, not as perpetual current claims here.

The composer’s **Attach file** button (`components/files/add-to-message.tsx`) reads only `/api/documents`, the files already uploaded/imported into Ensemble. Selecting a result registers its file ID with `useMentionMenu` and inserts `@file:Filename`; the next turn sends the saved mention ID. It does not mount the live app-item picker or search Google Drive, Microsoft, or any other connector. Connected-app tools still require an explicit request for that app’s content. Checked 20 Oct 2026 with a picker regression test that rejects every request except the saved-files list.

Copilot subscription replies now stream from JSONL assistant events, with per-turn input/output counts captured from `assistant.usage` (`subscriptions/copilot-output.ts`). No account quota or earlier session is read; vendor billing-unit cost is kept separate from dollars and Ensemble credits. See [30](30_ENGINES.md).

`assistant/apps.ts` explicitly instructs every connected-app read path, including remote MCP tools, to wait for a request for that app’s content, a request to search connected apps, or a user-supplied item link. A connection, app inventory, open picker or general file question is not authorization to read app content. Saved Ensemble files and stored Hub context are the default; an unclear source requires clarification before a connector query. This instruction applies with connected-app writes both enabled and disabled. `apps_search` repeats the scope rule in its tool description. Checked 20 Oct 2026 with prompt regressions.
