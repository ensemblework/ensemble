# 02 · The Hub: surfaces, settings and API map

The Hub is the browser UI in `apps/hub-web`, also loaded by the desktop shell. It organizes work into documents, tasks, linked context and agent runs.

## 1. Interaction principles

Tasks, pages and records keep one identity across views. Saved, pending, failed and completed states look different. Writing autosaves without calling a model; model sends, imports, approvals and irreversible actions are explicit. Drafts survive conflicts and errors. A queued job or a held assistant proposal is never shown as completed work.

## 2. Information architecture & navigation

`app/(hub)` holds the signed-in routes. `components/shell` provides the rail, phone navigation, space switcher, page tree, top-bar search and floating assistant. The top bar's sidebar button switches the sidebar between full and rail (on a phone it opens the navigation drawer). With *Auto-collapse sidebar* on, or the Pages panel docked on the left, the sidebar stays a rail (with auto-collapse, pointing at it or focusing its controls opens it), so on a computer that button and the rail's Expand button are hidden (`sidebarRailForced` in `lib/sidebar-rail.ts`, rules in `app/globals.css`). `/` enters the sign-in/onboarding flow. Search and Jump to share Cmd/Ctrl+K. Pages sits beneath Today and can collapse while keeping its add action.

Navigation follows the signup profession, enabled modules and access. Code, Runs and Skills are offered to engineer and Builder profiles; other profiles get their applicable Context records, Diagrams, Plots and Metrics. Runs is visible when Agent queue (`workspace`) or run history (`runs`) is enabled; each section keeps its own API permission. Optional features and tabs can be hidden without deleting data. A typed URL still goes through module and server authorization.

| Route | Purpose |
| --- | --- |
| `/today`, `/board`, `/tasks`, `/tasks/[id]` | Daily desk, board/list and task document |
| `/pages`, `/pages/[id]` | Nested standalone documents |
| `/context`, `/projects`, `/projects/[id]` | People, projects, repositories, preferences, graph and profile records |
| `/meetings`, `/files`, `/files/[id]` | Notes shelf, file library and original-file preview |
| `/diagrams`, `/diagrams/[id]`, `/plots`, `/plots/[id]` | Diagrams, datasets and figures |
| `/needs-me`, `/runs`, `/code`, `/code/review` | Decisions, live agent queue and run history, code review. `/workspace` opens `/runs` |
| `/skills`, `/morning-brief`, `/recap`, `/metrics` | Personal instructions, briefing preferences, recap and usage |
| `/completed`, `/trash` | Completed work and recoverable deletion |
| `/connect`, `/connect/[app]`, `/settings` | Editor connection guides and settings |
| `/spaces`, `/spaces/new`, `/shared`, `/shared-by-me` | Spaces and sharing |
| `/start`, `/welcome`, `/marketplace`, `/marketplace/[id]` | Setup, tour and built-in template catalog |

Public routes: `/login`, `/signup`, `/forgot`, `/reset`, `/verify` and computer approval `/link`. `/p/[token]` serves public item links; `/shared/[id]` opens an item shared with a signed-in person.

## 3. Screens

### 3.1 Today (Morning Briefing)

Today combines the profession desk, briefing, focus tasks, triage, reminders and relevant calendar/work records. Morning brief delivery starts the local day after signup; the introduction is offered once per account, and `/morning-brief` personalizes it later. Delivery does not fetch connected content.

Native desks store geometry in `desk.layout.<desk>` preferences; Context panels use `desk.context.<desk>.<tab>`. Alternate widget views use `/api/layouts/:surface`. These are separate storage and rendering systems; the assistant reads and edits the one on screen ([34](34_ASSISTANT_ACTIONS.md)). Add-tile choices keep the profession filter. Hiding a tile does not remove its records.

Task `todayFocus` (`auto`, `keep` or `hidden`) controls whether a task appears in focus. Snooze saves a date/time, not another task status. Private reminders: §14.

Pin to Today is in the task's More menu. Open pinned tasks appear above every native desk, independent of its tiles, through `pinnedTasks` in `/api/desk/live`. Completed, deleted and currently snoozed tasks are excluded; pins are not lost when a task falls outside the recent-task window.

### 3.2 Board (Kanban)

Board supports task creation, priority, ordering, filters/grouping, lifecycle actions and assignment, with a compact bounded search field in the toolbar (`components/board/board.tsx`). New task creates an editable document where owner, due date, project, repository, people and skills are set. Changing the owner alone does not start an agent: Run with agent opens the assignment flow.

The Ensemble Kanban collapses independently of Board overview. Its columns are Proposed, To do, In progress and Done. Blocked and awaiting-approval tasks appear in In progress while retaining their task status and approval controls. Flow, WIP counts and the In progress overview filter use the same grouping; the attention tile can still isolate blocked and awaiting-approval work. `/api/tasks?board=default` excludes task pages assigned to custom boards; `/api/tasks` remains the complete task list.

Automatic moves to Done play once per observed completion, scoped to the open space or share for the browser tab. Returning from another screen can show a new completion, but opening a peek, the assistant, or resizing the board does not replay one. Animation clones are excluded from card measurements; system motion uses a viewport layer below active peeks, menus and the assistant (`components/motion/board-drag/board-drag-dnd-kit.tsx`).

A task peek uses the same document as `/tasks/[id]`, and the floating assistant receives its task ID. The overview strip is saved in `desk.board.insights`: at most **four fixed-size tiles** (`MAX_INSIGHTS`), reorder/collapse and a WIP cap (1–50). It is not a resizable widget canvas.

**Custom boards** appear as cards below the Ensemble board (`components/board/custom-boards.tsx`). New board sets a name, description and 1–20 named, colored columns. Each opens at `/board?board=<id>` with its own Kanban, page search, add-existing-page picker and overview. Cards are real standalone or task pages, not copies. New page in a column creates a standalone page; drag handles support pointer, touch and keyboard column moves and ordering (`custom-board.tsx`).

Board settings rename/reorder columns and remove empty columns. A column with pages, including pages in Trash, cannot be removed. Deleting a board requires confirmation and keeps its pages: notes become independent; task pages return to the Ensemble board. Board settings use revision checks to reject conflicting saves. The board's selected overview tiles are saved on `PageBoard`: page count, a column-colored donut, column breakdown and recently edited pages (`board-widgets.tsx`). They use only that board's pages and actual column names, independent of Ensemble's task status metrics.

### 3.3 Needs Me (Approval Queue)

Needs me lists publishing approvals, structured questions, execution permission requests and interrupted attempts, and under *From your nodes* the approval cards the person's Ensemble Node nodes wait on (`components/needs-me/node-approvals.tsx`: approve, discard or open in Node; a node's request for a secret shows a password box whose value goes straight to the computer, [35 §8.7](35_ENSEMBLE_NODE.md#87-secrets); [35 §8.6](35_ENSEMBLE_NODE.md#86-needs-me)). The sidebar badge counts all of them. Cards keep the exact options and pending payloads. Device permissions can require confirmation on that computer. In shared spaces others may see run progress, but only the person running the job may answer. Recovery and authority: [05](05_MODULE_TASK_ORCHESTRATOR.md), [29](29_SHARING.md).

It is one queue, without overview counters or filter tabs. Empty sections are omitted; a fully empty queue shows All caught up. Failed queries keep an explicit retry.

### 3.4 Runs (Agent Timeline / Trace)

Runs combines the live workboard (`components/runs/run-queue.tsx`) with recent run history below it. Up next, Working now and Needs you retain job actions, queue order and waiting reasons. Assign task, Pause all/Resume, sharing and run-limit settings stay available. Completed and stopped work appears in run history, not separate lanes. Queue errors and history errors retry independently.

Run sheets show Results, Files and Traces, with resize/fullscreen. They keep model, tool and thinking events and changed-file metadata; past output is not editable. Feedback is a tag or a separately linked follow-up job using the saved execution choices. The route paginates history; a short overview deletes nothing.

### 3.5 Context

Context tabs depend on profession. Engineer defaults are Overview, People, Projects, Repos and Graph; other profiles get their own records. Optional tabs can be added or hidden. Student Assignments are board tasks; Engineer Mocks are mock services/test doubles. Learning, Hearings and other specialized records stay reachable without a Today tile. On a phone, Graph is a searchable connection list. Data behaviour: [03](03_MODULE_CONTEXT_ENGINE.md).

Projects open the same `components/project/project-page.tsx` in a side peek or at `/projects/[id]`: page-style title, summary and notes, linked people/repos, deliverables, tasks, diagrams and meeting notes. It reuses `PageTitleField` and `HumanDescription`; project notes remain plain text, separate from standalone documents. Graph interaction help is behind its information icon.

### 3.6 Skills

Skills edits each personal instruction body, its enablement and retained versions. Evidence appears only when present. The page has no preview/scoring form or learning teaser. The `/morning-brief` editor uses the same skill versioning. Details and completed-work learning: [04](04_MODULE_SKILL_FORGE.md).

### 3.7 Code

Code opens a review or folder with changed-file diff, editor and Source control. On the hosted app ordinary users work on their paired computer. The terminal is for the person only, needs passkey unlock, and is not an assistant tool. Details: [16](16_CODE_TAB.md).

### 3.8 Metrics

Metrics shows calls routed through Ensemble: token totals, an activity chart, usage by model and purpose, and expandable recent calls. The provider filter and 14/30/90-day period apply to every aggregate; the provider selector keeps its value when a period has no calls for it. Missing token counts and prices are stated, and such calls still appear. The credits card covers the UTC calendar month and shows credits used before a usage erasure. Reading the summary repairs usage left by an earlier Everything deletion, keeping known charges and later work (`repairErasedUsage`). No time-saved estimate is shown. See [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md), [33](33_INCLUDED_AI.md).

### 3.9 Settings

Settings opens as a page or dialog with URL-addressable tabs (`components/settings/navigation.ts`, `url-state.ts`).

| Tab | Controls |
| --- | --- |
| Account | Profile/avatar, login methods/password, profession-relevant Features, computer/account information, export and About |
| Appearance | Theme/palette, font, text scale, motion/reduced motion, sidebar/page-panel preferences |
| Assistant | Allowed actions/write policy, default tier/persona, model profiles/effort, API keys, subscriptions, run profiles/orchestration and prompt transparency |
| Connections | Connector catalog, suite-product grants, MCP servers/tools, paired computers and supported local integrations |
| Notifications | In-app/platform notices, permission and quiet hours |
| Shortcuts | Key bindings, conflict checks and reset |
| Data | Retention, Trash, downloads and a Danger zone: scoped data erasure and hosted account deletion. Erasure needs a typed scope phrase and final confirmation; account deletion needs DELETE and password or recent sign-in. Credit consumption is kept |
| Spaces / Sharing | Owned spaces, settings copy/sync, membership, contacts and outgoing access |

Subcontrols depend on profile, local/hosted mode and permissions. `GET/PATCH /api/settings` takes partial patches, so one save never resets other settings. `PUT /api/settings/modules` sets allowed modules. Time zone is detected automatically or picked from a searchable list; an explicit choice persists.

The assistant can find, read and change **allowlisted** settings after Apply and pick a catalog model/effort; supported appearance changes apply live. Keys, account deletion, sharing, folder trust, sandbox/permission grants and other sensitive controls need the human UI ([34](34_ASSISTANT_ACTIONS.md)).

#### Connector store

`components/connectors` reads `GET /api/connectors/catalog`: operator app configured, the person's connection, products and granted scopes, last sync/error, vendor MCP state/tools. Turning on a product without enough scope offers reconnect/consent. A vendor MCP server holding the person's data but connected without an account shows "Connected · public data only", still offering sign-in and token; where the vendor names the account the badge reads "Connected as <account>". Hugging Face offers **Sign in with Hugging Face** and **Paste an access token**, never an anonymous Connect. Login identity and connector grants are separate. Connecting imports nothing; Sync people updates bounded metadata only ([03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md)).

Connected apps come first wherever connectors are listed: the store grid (every category and search) and the five-app short list in Settings → Connections (`FEATURED_ORDER`: Google Workspace, Microsoft 365, Notion, Linear, GitHub). "Connected" means signed in, a saved token, or the vendor's MCP server connected; connected custom MCP servers join them at the top of the grid. Otherwise catalog order holds (`filterEntries`, `featuredEntries`, `storeCards` in `components/connectors/catalog-view.ts`). The API returns catalog order.

The detail page's connect panel has one **Step-by-step guide** disclosure, open by default (`aria-expanded` button; numbered steps, links in a new tab, "Looks like", "Not this", "Permissions" and "More help" notes). Token, address and own-app ways have written guides in `packages/shared-types/src/connector-guides.ts` (`CONNECTOR_GUIDES`); sign-in gets a short what-to-approve guide (`connectorGuide`). Guides and field labels use the vendor's name for the credential (Notion internal integration secret, GitHub fine-grained personal access token, Slack user OAuth token, Linear personal API key, Trello API key and token). Trello's **Get a token** opens Trello's authorize page for the typed key. A refused token is shown under the fields. **In Ensemble** lists only what the code does for that app ([31 §2](31_CONNECTORS_IN_USE.md#2-what-ensemble-does-with-a-connected-app)).

### 3.10 Files

Files lists uploaded originals and app content the person explicitly saved or imported. Viewers offer supported previews, original download, text/cell editing and page conversion/export. A saved file and its extracted text are distinct from a transient connected-item search result. Caps, formats and edit limits: [32](32_FILES.md).

## 4. Interaction patterns

Dialogs manage focus; tabs support keyboard navigation. Drag/drop and resize persist layout. A blank title restores the saved name or fails validation. Text scaling changes typography, not the root layout. Phone actions wrap within the viewport.

`InfoTip` opens bounded, portalled guidance on hover, focus or tap. Escape dismisses help before its containing dialog; a tap outside closes it. Routine explanations belong there rather than under every control; errors, security warnings and destructive-action confirmations stay visible. Run queue cards keep titles, compact status/priority/Git choices, computer/model and live progress or errors; full summaries belong to the task/run.

Below 768 CSS pixels, Context tiles use full-width rows with a horizontally scrollable tab strip; record grids shrink to the available width. Runs stacks its live queues below 1024 pixels, with recent history below. History actions sit below each title and metadata on phones; run sheets fill the phone width and scroll their content separately from their controls. Needs me choices wrap long answers and keep the recommendation badge inside the button. Code uses a dismissible Explorer/Find/Source control panel on phones, and the read-only run browser switches between Files and code. Desktop panel preferences and saved tile sizes are unchanged.

Phone form fields use at least 16 px text to avoid Safari zooming the page on focus.

The local browser regression `e2e/mobile-layout.mjs` covers 320, 390, 640, 768, 1024 and 1440 pixel widths against the in-memory API fixture `apps/hub-api/scripts/mobile-ui-fixture.ts`. It can include Ensemble Node through `NODE_WEB`; it never targets a hosted account.

`e2e/clean-surfaces.mjs` uses that fixture for help dismissal, compact task actions, persisted Today pins, project peek/full-page editing, blank-page creation and account-deletion guards on phones and desktop.

Notices (`components/toast.tsx`) appear bottom centre and close after 3 seconds (`TOAST_MS` in `lib/toast-bus.ts`); the accent bar runs down over that time. Pointing at or focusing a notice pauses it, so Undo stays reachable; × closes it at once. A caller can ask for longer only for instructions that need reading (the PDF print fallback).

Confirmations are specific to the action. Moving pages to Trash offers Undo; permanent deletion, account removal, sharing revocation and sensitive device permissions have their own confirmations. Ordinary autosave has none.

## 5. State & data flow

React Query caches scoped API responses. SSE events invalidate/refetch queries and drive progress; they are not the database. Live editing has its own authority/version protocol (§13). Preferences hold layouts and UI choices; browser-only draft/position state is shorter-lived.

`lib/api.ts` centralizes requests and readable errors, including off-module errors. `lib/assistant-surface.ts` and view components publish bounded IDs, filters, selection and layout to the assistant; this context grants no authorization.

## 6. API contract (hub-api → UI, abridged)

`apps/hub-api/scripts/route-inventory.json` (checked by `pnpm --filter @ensemble/hub-api route:inventory:check`) lists every registered route. This table groups the main entry points; files are under `apps/hub-api/src`. Sharing access is classed separately in `sharing/policy.ts`.

| Area | Routes / implementation |
| --- | --- |
| Shell and Today | `/api/shell` (account, open space, counts including `nodeApprovals` in the account's own space, modules, `hostCode`: whether this account may read this server's own Code and workspace folders), `/api/today/home`; `routes/views.ts` |
| Tasks and board | `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/move`, `/pin`, `/reopen`, `/api/deliverables`, `/api/completed`; `routes/tasks.ts`, `board.ts`, `completed.ts` |
| Custom boards | `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id`, `POST /api/boards/:id/pages`, `PUT /api/pages/:kind/:id/board`; `routes/page-boards.ts`, `pages/boards.ts`. Space viewers read; editors manage boards and membership |
| Task documents | `/api/tasks/:id/page`, `/api/tasks/:id/page/collab`; `routes/tasks.ts`, `collab.ts` |
| Standalone pages | `/api/pages`, `/api/pages/:id`, `/api/pages/:id/collab`, `/api/pages/delete-many`, `/api/pages/:kind/:id/convert`; `routes/pages.ts` |
| Page history, copies, templates | `/api/page-versions`, `/api/page-versions/:id/restore`, `/api/pages/:id/duplicate`, `/api/pages/:id/template`, `/api/page-templates`, `/api/page-templates/:id/create`; `pages/version-routes.ts` |
| Comments and inline requests | `/api/pages/:kind/:id/comments`, `/api/comments/:id`, `/api/comments/:id/reply`, `/api/pages/:kind/:id/ensemble`, `/api/ensemble/replies`; `routes/comments.ts`, `ensemble.ts` |
| Context and entities | `/api/context/board`, `/api/context/graph`, `/api/entities`, `/api/people`, `/api/people/:id/merge`, `/api/projects`, `/api/repos`, `/api/artifacts`, `/api/preferences/:key`; `routes/context.ts`. `/api/context/search`; `routes/cowork.ts`. `/api/project-links`; `routes/project-links.ts` |
| Morning brief/capture | `/api/brief/today`, `/api/brief/skill`, `/api/brief/prompt`, `/api/capture/preview`, `/api/capture`; `routes/cowork.ts` |
| Meetings | `/api/meetings/sessions`, `/api/meetings/imported`, `/api/meetings/notes/:id`; `routes/cowork.ts`, `meeting-notes.ts` |
| Needs me, reminders, notices | `/api/decisions`, `/api/decisions/:id/decide`, `/api/approvals/:id/decide`, `/api/reminders`, `/api/notifications`; `routes/decisions.ts`, `misc.ts`, `board.ts`, `cowork.ts` |
| Live updates | `/api/events` (SSE), `/api/events/ticket`; `routes/misc.ts` |
| Settings/models | `/api/settings`, `/api/settings/modules`, `/api/models`, `/api/models/refresh`, `/api/models/test`, `/api/model-keys/:provider`; `routes/settings.ts`, `system.ts` |
| Spaces | `/api/spaces`, `/api/spaces/:id`, `/api/spaces/:id/switch`, `/api/spaces/settings/copy`, `/api/spaces/settings/sync`; `spaces/routes.ts`, [28 §3](28_ENSEMBLE_SPACES.md#3-routes) |
| Connectors | `/api/connectors/catalog`, `/api/connectors/:provider/start`, `/callback`, `/token`, `DELETE /api/connectors/:provider`, `PUT /api/connectors/:id/products`, `/api/connectors/apps`; `routes/connectors.ts`. `/api/connections/:id/sync`, `/api/fetch`; `routes/system.ts` |
| Vendor MCP | `/api/mcp-connections`, `/api/mcp-connections/:id`, `/api/mcp-connections/callback`, `/api/mcp-connections/:id/refresh-tools`; `routes/mcp-connections.ts` |
| Connected items | `/api/app-items/*`; operations in [31](31_CONNECTORS_IN_USE.md#6-api) |
| Files | `/api/documents` (`purpose: "page-image"` for images in pages, [32 §6](32_FILES.md#images-in-pages)), `/api/documents/:id`, `/original`, `/text`, `/content`, `/cells`, `/page`, `/style`, `/tags`; `routes/files.ts`. `/api/documents/import`; `routes/file-imports.ts` |
| Imports | `/api/imports/*`; preview/job/undo contract in [27](27_IMPORTS.md#6-api) |
| Plots and diagrams | `/api/plots/*`, `/api/diagrams/*`; `routes/plots.ts`, `diagrams.ts`, [20](20_PLOTS_DESIGN.md) |
| Skills | `/api/skills`, `/api/skills/:id`, `/restore`, `/test`, `/score`; `routes/skills.ts` |
| Runs/metrics | `/api/runs`, `/api/runs/:id`, `/api/runs/:id/feedback`, `/api/metrics/summary?provider=<id>&days=14` (1–90 days), `/api/ledger/verify`; `routes/runs.ts`. `/api/metrics/credits`; `routes/included.ts` |
| Interaction log | `POST /api/telemetry` (the Hub's own usage events, signed-in browser sessions only; [07 §1.3](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#13-the-operators-interaction-log-and-dashboards)); `analytics/telemetry.ts` |
| Assistant | `/api/assistant/tools`, `/conversations`, `/conversations/:id/messages`, `/turn`, `/apply`, `/conversations/:id/stop`; `routes/assistant.ts` |
| Layouts | `/api/layouts/:surface`, `/api/layouts/:surface/reset`; `routes/layouts.ts` (native desks use preferences instead) |
| Workspace/agent | `/api/workspace`, `/api/agent/assign`, `/api/agent/sessions` and job/control routes; `routes/agents.ts`, `job-files.ts` |
| Code/terminal | `routes/code*.ts`, `terminal*.ts`; [16](16_CODE_TAB.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) |
| Trash/data | `/api/deleted`, `/api/deleted/restore`, `/api/deleted/empty`, `/api/data/delete`; `routes/system.ts` |
| Undo/redo | `/api/undo`, `/api/redo`; `routes/misc.ts`, `lib/undo.ts` |
| Sharing/presence | `sharing/routes.ts`; [29](29_SHARING.md#6-routes) |
| Device login/editor MCP | `routes/cli-auth.ts`, `routes/mcp.ts`; [26](26_CLI.md) |
| Ensemble Node | `/api/node/*` (nodes, crews, rooms, messages, approvals and `GET /api/node/approvals` for Needs me, runs, activity, events) and `GET /api/bridge/node`; `node/routes.ts`, [35](35_ENSEMBLE_NODE.md#9-routes) |

Internal service routes need internal credentials; device routes need a scoped device token. Neither bypasses an app's normal authorization. File bytes, model keys and cookie/session headers never go into model prompts.

## 7. Component ownership

`components/editor`, `pages`, `task` and `comments` own documents; `board`, `desk`, `widgets`, `context` and `today` own work views; `assistant` owns chat/proposals; `agent`, `needs-me`, `code` own execution/review; `settings`, `connectors`, `sharing` own account/app controls. Shared primitives live in `components/ui.tsx`; shared models/validation in `packages/shared-types`.

## 8. Visual style

`packages/brand` owns marks, palettes and motion ([BRAND](BRAND.md)). Reduced motion is independent of theme. Menus and dialogs opened from the floating assistant sit on a layer above it, so model and mention menus stay clickable.

Mentions use one chip everywhere: pages, sent assistant messages and comments (`.mention` in `app/globals.css`, `components/mentions/mention-chip.tsx`). Each kind takes its hue from the `--kind-*` tokens, mixed soft and tuned for light and dark, so it reads under every color theme; the chip is inline and does not change line height. Text boxes with the @ menu (assistant composer, comments, Quick capture) use `components/mentions/mention-field.tsx`: a copy of the text behind the transparent box tints picked mentions, a bare `@people:` prefix and the token being picked, while caret, selection, undo and IME stay native.

Addresses in text are links. `lib/linkify.ts` finds http(s) URLs, `www.` hosts and email addresses (no other schemes), trimming sentence punctuation and unbalanced closing brackets; `components/linkified-text.tsx` renders them in raw text (sent assistant messages, run trace thinking/errors/tool input and output, live job logs and events, task short descriptions, plain-text files, app item text, meeting recaps, Morning brief, approval previews). `MarkdownText` also links bare and `<…>` addresses, but not inside code. Web addresses open in a new tab with `noopener noreferrer`; in-app paths stay in the tab. Clicking a link inside a clickable row or click-to-edit field opens only the link.

## 9. Tests

`pnpm --filter @ensemble/hub-web test` plus the relevant API tests cover behaviour changes. Browser scripts in `apps/hub-web/e2e` and `apps/hub-web/scripts` have their own prerequisites. The route inventory check covers registered endpoints, not every happy path.

## 10. The Hub assistant

The floating dock is the shared conversation surface, including over task peeks. Floating, it resizes from its left edge, top edge or top-left corner (anchored bottom-right): drag, or focus an edge and use the arrow keys; double-click or Home restores the default size. The size is kept in this browser (`ensemble.assistant.size`), never below 380 × 440 px or past the window less a 20 px margin, and refitted when the window changes (`components/assistant/use-panel-size.ts`). Expanded, and on phones (640 px wide or less), it has no handles and a fixed layout.

Typed mentions send kind/ID references; names without IDs are resolved conservatively in the current space. The composer tints mentions while typing, and a sent message shows its saved mentions as chips that open the record ([11](11_HOW_THE_ASSISTANT_WORKS.md#3-context-and-prompt-size)). The paperclip uploads files into Files or chooses saved ones (`components/files/add-to-message.tsx`, never connected apps); files can also be dropped or pasted. Up to 8 per message wait on a shelf above the box with progress, Cancel and Remove (`components/assistant/chat-attachments.tsx`), are sent as file mentions, and show under the sent message with links and image thumbnails; the model gets their text and pictures ([38](38_AGENT_READABLE_FILES.md)). Live connected-app reads need a separate explicit request. Model menus choose the tier/model and show who pays. A failed turn is saved as an error with Retry, not as an assistant answer.

Routing, tool execution and Apply: [11](11_HOW_THE_ASSISTANT_WORKS.md). Action map: [34](34_ASSISTANT_ACTIONS.md).

## 11. Undo / redo

`apps/hub-api/src/lib/undo.ts` journals supported Hub writes transactionally, including grouped assistant changes. Undo/redo replays the journal; it does not call the model. It cannot reverse arbitrary external calls, invitations, imports already consumed elsewhere or filesystem side effects; each tool reports whether it supports Undo. Conversions and history restores keep document identity and have their own safeguards.

## 12. Live agent activity and the stop button

Activity state and SSE show work actually running or waiting. Pause stops new jobs and cancels current model/command work; Stop everything also clears the queue. A remote request already accepted can finish. Cancelling does not undo an external write or guarantee a billing refund. Saved work and retry: [05 §6](05_MODULE_TASK_ORCHESTRATOR.md#6-stop-interruption-and-retry).

## 13. Document-style pages

The TipTap editor uses the shared page schema (`packages/shared-types/src/page-schema.json`). A page is writing with structured blocks, not a chat. Task properties and execution controls sit around the document. Task documents and standalone notes share the editor but keep separate identities.

### Creation and properties

Titles and properties edit in place. Task descriptions, page content, linked context and immutable run evidence have different roles. Assigning an owner does not run anything. Focus mode gives a reading-width document with save state and an exit control.

Task More holds Pin to Today, Comment, Add description, diagram creation, board assignment and Trash. Convert to page remains visible. Only an in-progress property save needs a status label.

### Standalone notes

A standalone note is a `TaskPage` with null `taskId`; nullable `parentId` nests pages. Saves and renames lock the row and reject stale revisions, and refresh the saved search text. A note is not a task or project.

Delete soft-deletes the note and its descendants, with Undo, after pending saves finish. Trash keeps content, mentions, discussions and history until purge. A link to a deleted page shows a read-only restore state; a missing or purged ID shows a missing-item screen. Shared and public views hide owner-only recovery controls.

The page header's board picker (inside More for task pages) assigns a page to one custom board and column, moves it between boards, or removes the assignment (`components/pages/page-board-picker.tsx`). Membership is stored as `TaskPage.boardId`, `boardColumnId` and `boardOrder`, without rewriting saved content or editor revisions. Custom column moves do not change a task's agent status or runs.

Choosing Ensemble board for a standalone note attaches the existing page to a new task and clears any custom-board assignment. Quick assign also uses that task conversion. Convert to page detaches the document and trashes the old task, retaining any custom-board membership. Content, mentions and discussions keep their identity; converting back creates a new task without the old execution properties. Conversion rejects stale content and active inline/agent work.

`/pages` and the Pages browser show independent notes first, followed by board-named groups collapsed by default, including an Ensemble board group for default task pages. Expanding a group opens its pages; task pages link to `/tasks/:id`. Searching reveals matching pages inside groups. `/api/pages?all=true` supplies this combined directory, with `q` searching titles and saved text; `/api/pages` lists standalone notes for existing page-only pickers. Custom-board notes remain standalone pages.

### Page history, copies and private templates

`pages/history.ts` coalesces checkpoints within five minutes and keeps at most 30. Restore first saves current work and reconciles an open live editor. Versions show their author when recorded. A stale restore fails with 409.

New page creates and opens a blank page immediately. More offers duplication and version history, without a template picker or Save as template action. Duplicate creates independent writing and omits discussions, shares and active AI bindings; static AI output becomes text. Embedded resources stay same-space references; source-file export associations are not copied. The owner-only template API and saved templates remain available to API clients, capped at 50 per profile and space.

### Blocks and mentions

Slash commands insert writing blocks; `@` links real entities by ID and can request Ensemble. Mentions render as kind-tinted chips; embedded files, plots and diagrams render as cards that keep their resource identity. Plot/diagram height is saved on the mention; removing the embed does not delete the resource. The mention menu must finish selecting an entity before Enter can send an inline request.

Images (`components/editor/page-image.ts`, the `image` node) come from `/image`, a drop, a paste or HTML with `data:` images, upload into Files with `purpose: "page-image"` behind a progress placeholder (`file-attach.ts`), and land as one undoable step. Width (10–100% of the column, or the image's own size), alignment, alt text and the original's size are node attributes, so they save, undo and co-edit; drag handles with a keyboard slider, a toolbar with alignment and width presets, Alt and remove appear only on editable pages. File-backed images load with the share headers and show from object URLs, so shared pages and public links show them. Each image is at most 2 MB (2,097,152 bytes), PNG, JPEG, GIF or WebP; the rules, storage and limits are in [32 §6](32_FILES.md#images-in-pages).

Links in an editable page open on click: in-app paths, `ensemble://` record links and link-to-page blocks in place, everything else in a new tab (Cmd/Ctrl+click always uses a new tab). Resting the pointer on a link for about half a second, or Alt+Enter with the caret in one, shows a card to open, edit or remove it (`components/editor/link-popover.tsx`); selecting part of a link by drag or Shift+click does not open it. Read-only pages use ordinary links that open in a new tab.

### Saving and concurrent edits

Live page/task editing uses `pages/collab.ts`, `collab-core.ts` and `routes/collab.ts`, with epoch/version markers. Whole-document saves and conversions flush the live session first, so they include what others typed. A revision conflict keeps the draft. Annotation-only saves do not rewrite task notes or running instructions. A model action gets bounded current document context and can read more through tools.

### Agent output and human notes

Run output is immutable evidence. Human annotations keep their run/output anchors. Request changes or Redo creates a new assignment/attempt instead of rewriting an answer. Context keeps saved output, annotations and current task instructions apart.

### Selection comments and inline questions

Selection comments keep quote/context anchors and report ambiguous or changed text. Owners and editors edit/resolve/delete according to access; viewers cannot comment or ask the assistant. `@ensemble` plus Enter explicitly sends a request; typing, autosaving, reopening and reading an earlier answer never run a model.

Comments never reserve document width or change the focus-mode reading column. Small gutter markers show thread counts; clicking a marker or highlighted text opens one compact, viewport-bounded thread overlay. Long quotes are limited to two lines; the thread scrolls independently. Close or Escape returns to writing. Page comments and selection drafts use the same overlay, with edits, resolution and delete confirmation (`components/comments/comment-layer.tsx`, `.comment-*` rules in `app/globals.css`).

Inline requests use the normal assistant loop and scoped tools. Newly requested diagrams/plots can be created and attached inline under the existing policy; other held writes still need Apply. Request IDs stop retries from starting duplicate work. Failed drafts stay visible. A request needs a final answer; tool activity alone does not count as a reply. Code: `components/comments`, `apps/hub-api/src/ensemble/`, `routes/comments.ts`.

### Manual and imported meeting notes

Manual meeting sessions use the block editor with serialized, debounced saving. Each shelf card shows Move to Trash on hover or keyboard focus (always on touch screens); it confirms, calls `DELETE /api/meetings/sessions/:id` like Delete notes inside a note, and offers Undo. Typed content also gets a Markdown projection for search and recap. Failed drafts stay in browser memory across in-app navigation, not a full reload. Imported notes share the shelf but are read-only source records. Meetings do not record the microphone or transcribe audio. Routes: [03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context).

### Context graph

Graph derives connections from saved records and mentions; it never starts a provider fetch. Phones use the list view. Data and suppression: [03](03_MODULE_CONTEXT_ENGINE.md).

## 14. Private reminders

Reminders belong to the person, not to shared task context. A due reminder creates a notification. Platform delivery needs permission and a running browser tab or desktop app; quiet hours and OS Focus still apply. Snooze saves a real next time. Reminders are excluded from Context Bridge and search briefs. See [07 §1.2](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#12-private-reminders-and-platform-notifications).

## 15. Waiting, previews and quiet status

Saving, waiting for a person, queued, active and failed each have their own indicator; reduced motion keeps them without animation. Error turns never enter model history. Pending proposals keep Apply; failed dependent work offers Retry remaining steps and is not labelled Applied.

## 16. Accounts and public signup

`routes/auth.ts` and `auth-oauth.ts` provide scrypt passwords and hashed-cookie sessions. `ENSEMBLE_SIGNUP_MODE` is `open`, `allowlist` or `closed`; allowlist reads `ENSEMBLE_SIGNUP_ALLOWLIST`. Local first-account adoption of placeholder data is separate from hosted registration, which never claims localhost data.

Social buttons need `AUTH_<PROVIDER>_CLIENT_ID`/`_SECRET`. Login uses browser-bound PKCE/nonce/single-use state and identity validation, and stores login mappings, not connector tokens. A verified provider email links accounts only under the ownership rules; a Microsoft email or username alone is not email verification. `?return=node` on the start route sends a sign-in begun on Ensemble Node back to `ENSEMBLE_NODE_WEB_ORIGIN` (never another URL); the account and session are the Hub's ([35](35_ENSEMBLE_NODE.md#2-accounts-and-sign-in)).

Hosted email signup needs Resend delivery (`EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`) and both Turnstile keys (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`). Verification codes are hashed, expire after 30 minutes and count attempts; a new code invalidates the old one. The email links to the Hub's `/verify`, or to Ensemble Node's `/welcome` for a sign-up made there ([35](35_ENSEMBLE_NODE.md#2-accounts-and-sign-in)). Turnstile answers are accepted from the Hub's host and from `ENSEMBLE_NODE_WEB_ORIGIN`'s host. Unverified users can write workspace content but cannot use hosted models, connectors or agents. Signup readiness and registration policy are separate.

New accounts pick a profession/profile and a template. The tour uses a preview canvas and never changes real work; Ask opens a draft without sending. Settings has no control to change the signup role.

Account settings manage login methods/password, avatar, export and deletion. Removing a method or deleting the account needs a recent session or password confirmation. Social-only accounts can add a first password. Sign-out confirms and returns to login. Account deletion keeps only the monthly credit-enforcement amount and a minimal operational log ([07 §6](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#6-data-erasure)); no profile snapshot or survey.

## 17. Linking a computer, and connecting editors

`/link` approves a CLI login showing the computer, platform and access requested, and returns correctly after sign-in. Editor access and task-running access are distinct; hosted task access needs a verified account. Settings' Connect this computer dialog shares pairing steps, a ten-minute code and renewal/error state across its entry points.

Connect guides offer CLI setup, a hosted read-only MCP URL/key or a source bridge. Device trust, lease lifetime, subscription calls and approvals: [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md). Assignment choices/profiles: [06](06_MODULE_WORKSPACE_AND_SURFACES.md). Engines and handoff: [30](30_ENGINES.md). Pairing never exposes the hosted server's filesystem.

## 18. Downloads

Page/task exports, original-file downloads, space archives and account exports are separate operations. Exported timestamps carry an explicit offset where the format includes local time. A file-backed page can export back from the browser where supported; server assistant exports rebuild supported documents. Format limits: [32](32_FILES.md). Space archives: [28 §5](28_ENSEMBLE_SPACES.md#5-deleting-and-exporting). Full export: Account. Downloads use the same access checks as reading.
