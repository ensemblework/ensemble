# 02 · The Hub: surfaces, settings and API map

The Hub is the browser UI in `apps/hub-web`, also exported into the desktop shell. It organizes work into documents, tasks, linked context and agent runs. This guide describes code inspected **18 Oct 2026**, including current profile/module restrictions. It is not a build-order proposal.

## 1. Interaction principles

Use the existing task/page/record identity across views. Show saved, pending, failed and completed states distinctly. Autosave writing without triggering model calls; keep model sends, imports, approvals and irreversible actions explicit. Preserve drafts on conflicts and errors. Do not show a queued job or held assistant proposal as completed work.

## 2. Information architecture & navigation

`app/(hub)` contains authenticated routes. `components/shell` provides the rail, phone navigation, space switcher, page tree, top-bar search and floating assistant. The top bar's sidebar button switches the sidebar between full and rail (on a phone it opens the navigation drawer). With *Auto-collapse sidebar* on, or the Pages panel docked on the left, the sidebar stays a rail (with auto-collapse, pointing at it or focusing its controls opens it), so on a computer that button and the rail's Expand button are hidden (`sidebarRailForced` in `lib/sidebar-rail.ts`, rules in `app/globals.css`). `/` enters the authenticated/onboarding flow. Search and Jump to share Cmd/Ctrl+K. Pages sits beneath Today and can collapse while retaining its add action.

Navigation follows the signup profession, enabled modules and access scope. Code, Workspace, Runs and Skills are offered to engineer and Builder profiles; other profiles retain applicable Context records, Diagrams, Plots and Metrics. Optional features/tabs can be hidden without deleting data. A manually entered URL still undergoes module and server authorization checks.

| Route | Purpose |
| --- | --- |
| `/today`, `/board`, `/tasks`, `/tasks/[id]` | Daily desk, board/list and task document |
| `/pages`, `/pages/[id]` | Nested standalone documents |
| `/context`, `/projects`, `/projects/[id]` | People, projects, repositories, preferences, graph and profile records |
| `/meetings`, `/files`, `/files/[id]` | Notes shelf, file library and original-file preview |
| `/diagrams`, `/diagrams/[id]`, `/plots`, `/plots/[id]` | Diagrams, datasets and figures |
| `/needs-me`, `/runs`, `/workspace`, `/code`, `/code/review` | Decisions, attempts, agent workboard and code review |
| `/skills`, `/morning-brief`, `/recap`, `/metrics` | Personal instructions, briefing preferences, recap and usage |
| `/completed`, `/trash` | Completed work and recoverable deletion |
| `/connect`, `/connect/[app]`, `/settings` | Editor connection guides and settings |
| `/spaces`, `/spaces/new`, `/shared`, `/shared-by-me` | Workspace and sharing management |
| `/start`, `/welcome`, `/marketplace`, `/marketplace/[id]` | Setup, tour and built-in template catalog |

Public authentication routes include `/login`, `/signup`, `/forgot`, `/reset`, `/verify` and computer approval `/link`. `/p/[token]` serves public item links; `/shared/[id]` opens authenticated item sharing.

## 3. Screens

### 3.1 Today (Morning Briefing)

Today combines the active profession desk, briefing, focus tasks, triage, reminders and relevant calendar/work records. Morning brief delivery starts the local day after signup; the introduction is offered once per account. `/morning-brief` remains available for later personalization. Delivery does not silently fetch all connected content.

Native desks store geometry in `desk.layout.<desk>` preferences; Context panels use `desk.context.<desk>.<tab>`. Alternate widget views use `/api/layouts/:surface`. These are different persistence/rendering systems. The assistant reads/edits the one actually displayed ([34](34_ASSISTANT_ACTIONS.md)). Add-tile choices retain the profession filter. Hiding a tile does not remove its records.

Task `todayFocus` controls automatic/kept/hidden inclusion. Snooze uses saved date/time rather than another task status. Private reminder visibility and notices follow §14.

### 3.2 Board (Kanban)

Board supports task creation, priority, ordering, filters/grouping, lifecycle actions and assignment. New task creates an editable document; owner, due date, project, repository, people and skills can be set on it. Changing owner alone does not start an agent: Run with agent opens the assignment flow.

Task peeks use the same document as `/tasks/[id]`. The floating assistant receives the peek's task ID. The Board overview strip is stored in `desk.board.insights` and supports at most **four fixed-size tiles**, reorder/collapse and WIP cap. It is not an unrestricted resizable widget canvas.

### 3.3 Needs Me (Approval Queue)

Needs me presents publishing approvals, structured questions, execution permission requests and interrupted older attempts. Cards retain exact options and pending payloads. Device permissions can require confirmation on that computer. In shared spaces, people may see run progress while only the executing person may answer. [05](05_MODULE_TASK_ORCHESTRATOR.md) and [29](29_SHARING.md) describe recovery and authority.

### 3.4 Runs (Agent Timeline / Trace)

Run sheets show Results, Files and Traces, with resize/fullscreen controls. They retain model/tool/thinking events and changed-file metadata without turning historical output into editable evidence. Feedback can be a tag only or a separately linked follow-up job using the saved execution choices. History is paginated/bounded by the route, not deleted when a short overview is shown.

### 3.5 Context

Context tabs are profession-specific. Engineer defaults include Overview, People, Projects, Repos and Graph; other profiles get their applicable records. Optional tabs can be added/hidden persistently. Student Assignments are board tasks; Engineer Mocks are mock services/test doubles. Learning/Hearings and other specialized records remain accessible without a Today tile. Phone Graph uses a searchable connection list. Data behavior: [03](03_MODULE_CONTEXT_ENGINE.md).

### 3.6 Skills

Skills edits the current personal instruction body, enablement and retained versions. Model previews are explicit. The separate morning-brief editor uses the same personal skill/versioning rules. Retention learning and its current direct-publication behavior are documented in [04](04_MODULE_SKILL_FORGE.md).

### 3.7 Workspace

Workspace is the agent workboard for queued, active, waiting, stopped and recent completed work. Every account can see its own jobs, including paired-device jobs; server folder/checkout access remains operator-only. Errors show Retry or paired-computer guidance. Assignment uses saved profiles and explicit execution choices ([06](06_MODULE_WORKSPACE_AND_SURFACES.md)).

#### 3.7.1 Code

Code opens a review or folder, changed-file diff, editor and Source control. On the hosted app ordinary users control their paired computer. The terminal is for the person, requires passkey unlock, and is not an assistant tool. [16](16_CODE_TAB.md) owns details.

### 3.8 Metrics

Metrics shows recorded model usage, included credits, events, throughput and available baseline observations. Unknown prices and insufficient data stay explicit. It does not infer measured time savings from task counts. [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) and [33](33_INCLUDED_AI.md).

### 3.9 Settings

Settings is available as a page/dialog, with URL-addressable tabs (`components/settings/navigation.ts`, `url-state.ts`).

| Tab | Controls |
| --- | --- |
| Account | Profile/avatar, login methods/password, profession-relevant Features, computer/account information, export/deletion and About |
| Appearance | Theme/palette, font, text scale, motion/reduced motion, sidebar/page-panel preferences |
| Assistant | Allowed actions/write policy, default tier/persona, model profiles/effort, API keys, subscriptions, run profiles/orchestration and prompt transparency |
| Connections | Connector catalog, suite-product grants, MCP servers/tools, paired computers and supported local integrations |
| Notifications | In-app/platform notices, permission and quiet hours |
| Shortcuts | Supported key bindings, conflict checks and reset |
| Data | Retention, Trash, downloads and workspace data erasure |
| Spaces / Sharing | Owned spaces, settings copy/sync, membership, contacts and outgoing access |

Exact subcontrols depend on profile, local/hosted mode and permissions. `GET/PATCH /api/settings` uses partial patches; an unrelated save must not reset other settings. `PUT /api/settings/modules` controls allowed modules. Automatic time zone detection and a searchable manual picker are supported; explicit choices persist.

The assistant can find/read/change **allowlisted** settings after Apply and choose a catalog model/effort. It can change supported appearance live. Keys, account deletion, sharing, folder trust, sandbox/permission grants and other sensitive controls require the human UI. See [34](34_ASSISTANT_ACTIONS.md).

#### Connector store

`components/connectors` consumes `GET /api/connectors/catalog`. Entries distinguish configured operator app, the person's connection, products/granted scopes, last sync/error and vendor MCP state/tools. Turning on a product without sufficient scopes offers reconnect/consent. Login identity and connector grants are separate. Connecting does not import content; Sync people updates bounded metadata only. Native search, file/board import and MCP tools have separate coverage ([03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md)).

### 3.10 Files

Files lists uploaded originals and explicitly saved/imported app content. Format viewers offer supported previews, original download, text/cell editing and page conversion/export. Files and their extracted text are distinct from a transient connected-item search result. [32](32_FILES.md) defines caps, formats and edit limitations.

## 4. Interaction patterns

Dialogs manage keyboard focus; tabs support keyboard navigation. Drag/drop and resize controls persist real layout state. Blank titles restore the saved name or fail validation rather than saving empty records. Text scaling changes typography without scaling the entire root layout. Phone actions wrap within the viewport.

Confirmations are specific to the action. Moving recoverable pages to Trash offers Undo; permanent deletion, account removal, sharing revocation and sensitive device permissions have their own confirmations. Do not add a universal confirmation to ordinary autosave.

## 5. State & data flow

React Query caches scoped API responses. SSE events invalidate/refetch relevant queries and drive progress; they are not the database. Live editor collaboration additionally has its own authority/version protocol. Saved preferences hold layouts and UI choices; browser-only draft/position state has a different lifetime.

`lib/api.ts` centralizes requests and readable errors, including off-module errors. `lib/assistant-surface.ts` and view components publish bounded IDs, filters, selection and layout information. This context carries no additional authorization.

## 6. API contract (hub-api → UI, abridged)

The checked-in route inventory and route modules are authoritative; this table groups the current entry points. Sharing classification is enforced separately in `src/sharing/policy.ts`.

| Area | Routes / implementation |
| --- | --- |
| Shell and Today | `/api/shell` (account, open space, counts, modules, `hostCode`: whether this account may read this server's own Code and workspace folders), `/api/today/home`; `routes/views.ts` |
| Tasks and board | `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/move`; `routes/tasks.ts`, `board.ts` |
| Task documents | `/api/tasks/:id/page`, `/api/tasks/:id/page/collab`; task and collaboration routes |
| Standalone pages | `/api/pages`, `/api/pages/:id`, `/api/pages/delete-many`; `routes/pages.ts` and `pages/` |
| Context and entities | `/api/context/board`, `/api/context/graph`, `/api/entities`, `/api/context/search`; `routes/context.ts`, `cowork.ts` |
| Morning brief/capture | `/api/brief/today`, `/api/brief/skill`, `/api/brief/prompt`, `/api/capture/preview`, `/api/capture`; `routes/cowork.ts` |
| Meetings | `/api/meetings/sessions`, `/api/meetings/imported`, `/api/meetings/notes/:id`; `cowork.ts`, `meeting-notes.ts` |
| Settings/models | `/api/settings`, `/api/settings/modules`, `/api/models`, `/api/models/refresh`, `/api/models/test`, `/api/model-keys/:provider`; `settings.ts`, `system.ts` |
| Connectors | `/api/connectors/catalog`, `/api/connectors/:provider/start`, `/api/connectors/:provider/callback`, `/api/connectors/:provider/token`, `/api/connections/:id/sync`, `/api/fetch`; connector/system routes |
| Vendor MCP | `/api/mcp-connections`, `/api/mcp-connections/:id`, callback and refresh-tools; `routes/mcp-connections.ts` |
| Connected items | `/api/app-items/*`; [31](31_CONNECTORS_IN_USE.md#6-api) lists actual operations |
| Files | `/api/documents`, `/api/documents/:id`, `/original`, `/text`, `/content`, `/cells`, `/page`, `/style`, `/tags`; `routes/files.ts` |
| Imports | `/api/imports/*`; [27](27_IMPORTS.md#6-api) owns the preview/job/undo contract |
| Skills | `/api/skills`, `/api/skills/:id`, `/restore`, `/test`, `/score`; `routes/skills.ts` |
| Runs/metrics | `/api/runs`, `/api/runs/:id`, `/api/runs/:id/feedback`, `/api/metrics/summary`, `/api/metrics/credits`, `/api/ledger/verify` |
| Assistant | `/api/assistant/tools`, `/conversations`, `/conversations/:id/messages`, `/turn`, `/apply`, `/conversations/:id/stop`; `routes/assistant.ts` |
| Layouts | `/api/layouts/:surface`, `/api/layouts/:surface/reset`; `routes/layouts.ts`; native desks instead use preferences |
| Workspace/agent | `/api/workspace`, `/api/agent/assign` and job/control routes; `routes/agents.ts`, `job-files.ts` |
| Code/terminal | `routes/code*.ts`, `terminal*.ts`; [16](16_CODE_TAB.md) and [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) |
| Trash/data | `/api/deleted`, `/api/deleted/restore`, `/api/deleted/empty`, `/api/data/delete`; `routes/system.ts` |
| Undo/redo | `/api/undo`, `/api/redo`; `routes/misc.ts`, `lib/undo.ts` |
| Sharing/presence | `sharing/routes.ts`, [29](29_SHARING.md#6-routes) |
| Device login/editor MCP | `routes/cli-auth.ts`, `routes/mcp.ts`; [26](26_CLI.md) |

Internal service routes require internal credentials; device routes require a scoped device token. They are not public alternatives to an app's normal authorization. File bytes, model keys and cookie/session headers must never be placed in model prompts.

## 7. Component ownership

`components/editor`, `pages`, `task` and `comments` own documents; `board`, `desk`, `widgets`, `context` and `today` own work views; `assistant` owns chat/proposals; `agent`, `needs-me`, `code` own execution/review; `settings`, `connectors`, `sharing` own account/app controls. Shared primitives live in `components/ui.tsx`; shared models/validation live in `packages/shared-types`.

## 8. Visual style

`packages/brand` owns marks, palettes and motion. [BRAND](BRAND.md) describes the current system. Reduced motion is independent of theme. Menus/dialogs opened from the floating assistant use a layer above their parent, so model and mention menus stay clickable.

Mentions use one chip everywhere: page mentions, mentions in sent assistant messages and in comments (`.mention` in `app/globals.css`, `components/mentions/mention-chip.tsx`). Each kind takes its hue from the `--kind-*` tokens, mixed soft and tuned separately for light and dark, so it reads under every color theme; the chip is inline and does not change its line's height. Text boxes with the @ menu (assistant composer, comments, Quick capture) use `components/mentions/mention-field.tsx`: a copy of the text behind the transparent box tints picked mentions, a bare `@people:` prefix and the token being picked, while caret, selection, undo and IME stay the browser's.

Addresses in text are links. `lib/linkify.ts` finds http(s) URLs, `www.` hosts and email addresses (never other schemes), trimming sentence punctuation and unbalanced closing brackets; `components/linkified-text.tsx` renders them in raw text (sent assistant messages, run trace thinking/errors/tool input and output, live job logs and events, task short descriptions, plain-text files, app item text, meeting recaps, Morning brief, approval previews). `MarkdownText` also links bare and `<…>` addresses, but not inside code. Web addresses open in a new tab with `noopener noreferrer`; in-app paths stay in the tab. A click on a link inside a clickable row or a click-to-edit field opens only the link.

## 9. Verification

Use `pnpm --filter @ensemble/hub-web test` and relevant API tests for behavior changes. Browser scripts under `e2e` and `scripts` have individual prerequisites; a historical screenshot or mock does not verify today's production page. The route inventory checks registered endpoints, not every happy-path contract. This documentation audit does not rerun the complete UI/provider matrix.

## 10. The Hub assistant

The floating dock remains the shared conversation surface, including over task peeks. Floating, it resizes from its left edge, top edge or top-left corner (it stays anchored bottom-right): drag, or focus an edge and use the arrow keys; double-click or Home goes back to the default size. The size is kept in this browser (`ensemble.assistant.size`), never below 380 × 440 px and never past the window less a 20 px margin, and is fitted again when the window changes (`components/assistant/use-panel-size.ts`). Expanded, and on phones (640 px wide or less), it has no handles and keeps its fixed layout. Typed mentions send kind/ID references; names without IDs are resolved conservatively in the current space. The composer tints mentions while typing, and a sent message shows its saved mentions as chips that open the record in the app ([11](11_HOW_THE_ASSISTANT_WORKS.md#3-context-and-prompt-size)). A From your apps picker can add a source URL for explicit live reading. Model menus choose the available tier/model and identify the funding source. Unavailable turns persist as errors with Retry, not successful assistant messages.

[11](11_HOW_THE_ASSISTANT_WORKS.md) owns routing, tool execution and Apply. [34](34_ASSISTANT_ACTIONS.md) owns the current action map.

## 11. Undo / redo

`lib/undo.ts` records supported Hub writes transactionally, including grouped assistant changes. Undo/redo replays journaled operations rather than invoking the model again. It cannot reverse arbitrary external calls, invitations, imports already consumed elsewhere or filesystem side effects. Specific tools report whether Undo is supported. Conversion/history operations preserve document identity and apply their own safeguards.

## 12. Live agent activity and the stop button

Activity state and SSE show work actually running/waiting. Pause stops new jobs and cancels current model/command work; Stop everything also cancels the queue. A remote request already accepted can finish. Cancellation does not undo an external write or guarantee a billing refund. [05](05_MODULE_TASK_ORCHESTRATOR.md#6-stop-interruption-and-retry) explains saved work and explicit retry.

## 13. Document-style pages

The TipTap editor uses the shared page schema (`packages/shared-types/src/page-schema.json`). A page is writing with structured blocks, not a second chat. Task properties and execution controls sit around the document. A task document and a standalone note share the editor but retain different identities.

### Creation and properties

Titles/properties edit in place. Task descriptions, detailed page content, linked context and immutable run evidence have different roles. Assigning ownership does not execute. Focus mode provides a reading-width document with save state and exit control.

### Standalone notes

A standalone note is a `TaskPage` with null `taskId`; nullable `parentId` supports nested pages. Page saves/renames lock the row and reject stale revisions. Saved search text is refreshed for retrieval. A standalone note is not automatically a task or project.

Delete soft-deletes the note and descendants with Undo after pending saves finish. Trash retains content, mentions, discussions and history until purge. Deleted links show a read-only restore state; a missing/purged ID shows a missing-item screen. Shared/public views do not expose owner-only recovery controls.

Add to board attaches the existing page to a new task. Convert to page detaches the document and trashes the old task. Content, mentions and discussion identity survive; converting back creates a new task rather than restoring old execution properties. Conversion rejects stale content and active inline/agent work.

### Page history, copies and private templates

`pages/history.ts` coalesces checkpoints within five minutes and keeps at most 30. Restore first preserves current work and reconciles an open live editor. Author/time are retained; old unattributed entries are labeled accordingly. Stale restoration fails with 409.

Duplicate creates independent writing. Save as template snapshots for the owner's current profile in the space, at most 50. Copies/templates omit discussions, shares and active AI bindings; static AI output becomes text. Embedded resources remain same-space references; source-file export associations are not copied. History, duplication and templates are owner-only.

### Blocks and mentions

Slash commands insert supported writing blocks; `@` links real entities by ID and can request Ensemble. Mentions render as kind-tinted chips; embedded files, plots and diagrams render as cards and retain their resource identity. Plot/diagram height is saved on the mention; removing the embed does not delete the resource. The mention menu must finish entity selection before Enter can send an inline request.

Links in an editable page open on a click: in-app paths, `ensemble://` record links and link-to-page blocks in place, everything else in a new tab (Cmd/Ctrl+click always uses a new tab). Resting the pointer on a link for about half a second, or Alt+Enter with the caret in one, shows a card to open, edit or remove it (`components/editor/link-popover.tsx`); selecting part of a link with a drag or Shift+click does not open it. Read-only pages use ordinary links that open in a new tab.

### Saving and concurrent edits

Live page/task editing uses `pages/collab.ts`, `collab-core.ts` and collaboration routes, with epoch/version markers. Legacy full-document saves are reconciled through that authority. Revision conflicts keep the draft. Annotation-only saves do not rewrite task notes or running instructions. A model action uses current bounded document context and can read more through tools.

### Agent output and human notes

Run output remains immutable evidence. Human annotations keep their run/output anchors. Request changes or Redo creates a new assignment/attempt rather than rewriting a historical answer. Saved output, annotations and current task instructions are distinguished in context.

### Selection comments and inline questions

Selection comments retain quote/context anchors and report ambiguous or changed text. Owners/editors can edit/resolve/delete according to access; viewers cannot write comments or ask the assistant. `@ensemble` plus Enter explicitly sends a request; typing, autosaving, reopening and reading a previous answer do not run a model.

Inline requests use the normal assistant loop and scoped tools. Newly requested diagrams/plots can be created/attached in that inline flow under its existing policy; other held writes still need Apply. Request IDs prevent retries from starting duplicate discussion work. Failed drafts remain visible. A final answer is required; tool activity alone is not a successful-looking reply. These paths are implemented in `components/comments`, `ensemble/` and `routes/comments.ts`.

### Manual and imported meeting notes

Manual meeting sessions use the block editor and serialized debounced saving. Typed content also has a Markdown projection used by search/recap. Failed drafts remain in browser memory across SPA navigation, not a full reload. Imported notes share the shelf but are source records and read-only. Meetings do not record the microphone or transcribe audio. [03](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context) describes the actual routes.

### Context graph

Graph derives connections from saved records and mentions; it does not start provider ingestion. A phone uses the list presentation. [03](03_MODULE_CONTEXT_ENGINE.md) owns data/suppression details.

## 14. Private reminders

Reminders belong to the person, not shared task context. Due reminders create notifications. Platform delivery needs permission and a running browser tab or desktop app; quiet hours and OS Focus still apply. Snooze saves a real next time. They are excluded from Context Bridge/search briefs. [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#12-private-reminders-and-platform-notifications).

## 15. Waiting, previews and quiet status

Saving, waiting for a person, queued, active and failed states have distinct copy and indicators. Error turns do not enter model history as valid answers. Pending proposals keep Apply; failed dependent work offers Retry remaining steps without relabeling it Applied. Reduced motion keeps the same status semantics without animation.

## 16. Accounts and public signup

`routes/auth.ts` and `auth-oauth.ts` support scrypt passwords and hashed-cookie sessions. `ENSEMBLE_SIGNUP_MODE` is open/allowlist/closed; allowlist uses `ENSEMBLE_SIGNUP_ALLOWLIST`. Local first-account placeholder adoption is separate from hosted registration, which never claims old localhost data.

Social buttons require configured `AUTH_<PROVIDER>_CLIENT_ID/SECRET`. Login uses browser-bound PKCE/nonce/single-use state and identity validation. It stores login mappings, not connector tokens. Verified provider email can link only under the implemented ownership rules; Microsoft email/username alone is not email verification.

Hosted email signup needs Resend delivery (`EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`) and both Turnstile keys. Verification codes are hashed, expire after 30 minutes and count attempts; requesting a new one invalidates the old. Unverified users can write local workspace content but cannot use hosted models/connectors/agents. Signup readiness and registration policy are separate.

New accounts complete profession/profile and template setup. The tour uses a preview canvas rather than navigating/mutating real work; Ask opens a draft without sending. A one-time profession change remains a design, not a general Settings control.

Account settings manage linked login methods/password, avatar, export and deletion. Sensitive method removal/deletion requires a recent session or password confirmation. Social-only accounts can add their first password. Sign-out uses confirmation and returns to login. Account deletion retains only the separate minimal operational log described in [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#6-data-erasure), not a profile snapshot or feedback survey.

## 17. Linking a computer, and connecting editors

`/link` approves a CLI login with the actual computer/platform/access requested and returns correctly after sign-in. Editor access and task-running access are distinct; hosted task access needs verification. Settings' Connect this computer dialog shares pairing steps, a ten-minute code and renewal/error state across connection/subscription entry points.

Connect guides offer CLI setup, a hosted read-only MCP URL/key or a source bridge. Device trust, lease lifetime, subscription calls and approval routing are in [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md). Assignment choices/profiles are in [06](06_MODULE_WORKSPACE_AND_SURFACES.md), engine/handoff behavior in [30](30_ENGINES.md). Pairing does not expose the hosted server filesystem.

## 18. Downloads

Page/task exports, original-file downloads, space archives and account exports are different operations. Exported timestamps retain an explicit timezone offset where the format includes local time. A file-backed page can use supported browser export-back; server assistant exports rebuild supported documents. [32](32_FILES.md) owns format limitations, [28](28_ENSEMBLE_SPACES.md#5-deleting-and-exporting) space archives, and Account owns full export. Download availability is subject to the same resource access checks as reading.
