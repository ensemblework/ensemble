# 02 · Module M1 — Interaction Hub (UI)

**Purpose:** The single place where the engineer and the agent look at the same picture of the work. It replaces *"open chat → explain → hope"* with **see → decide → delegate/act → review**. Chat exists, but as a side panel bound to the currently selected task, never the front door.

**Current state:** this document is the design plus as-built notes for the Notion-like Hub ([00](00_PROJECT_OVERVIEW.md#direction)). [18](18_WHAT_IS_REAL.md) says which parts run today.

---

## 1. Design principles

1. **Glanceable first, conversational second.** Anything the agent wants from me is a card with buttons, not a paragraph.
2. **Every item carries its provenance.** A todo shows the email/transcript/work item it came from, with a one-click jump and the exact excerpt.
3. **Ownership is explicit.** Every task is *Me*, *Agent*, or *Unassigned*. The agent never silently takes a task.
4. **Progress is visible without asking.** Agent tasks show a step list and live status; clicking opens the run trace.
5. **Control points are obvious.** "Needs Me" is a first-class queue with a badge count, not a notification toast that disappears.
6. **Zero-typing help.** "Help me with this" from any task/workspace pre-loads the agent with the task's context pack + skills. The engineer types only the delta.
7. **Reversible where possible; previewed always.** Sends, PRs and posts are previewed as they will appear.

---

## 2. Information architecture & navigation

**Left rail (Fluent Nav):** Today • Board • Needs Me *(n)* • Runs • Context • Skills • Workspace • Code • Metrics • ⚙ Settings (tabs: Account, Spaces, Sharing, Assistant, Connections, Notifications, Shortcuts, Data; see [§3.9](#39-settings)). **Shared with you** (`/shared`) appears under Pages once someone has shared something with you, with a count of items not yet opened. **Pages** sits directly below Today and starts collapsed on every load, unless the open route is a page (`components/pages/pages-section.tsx`); its header has **Import from Notion** next to +, which opens the import dialog on Notion ([27](27_IMPORTS.md)). In the collapsed icon rail, Pages is one icon that opens the sidebar with the list showing, so the rail has no empty row. **Files** (`/files`) sits just below Pages ([§3.10](#310-files), [32](32_FILES.md)).

**Brand and space switcher.** The existing U mark and **Ensemble** home link sit above the open space. The U home link remains visible in the collapsed rail and phone header (`components/shell/sidebar.tsx`, `topbar.tsx`). Below it is the open Ensemble space: its emoji or initial and its name (`components/shell/space-switcher.tsx`). The menu lists every space with its template, the spaces **shared with you** (owner's avatar on the icon), **Share ‹space›…**, **New space** (`/spaces/new`) and **Manage spaces**. Switching reloads into Today (the board, in a shared space); other tabs follow. See [28](28_ENSEMBLE_SPACES.md) and [29](29_SHARING.md).

**In a space shared with you** the sidebar has no Today or Metrics, the top bar has no Fetch now and shows "Shared by ‹owner› · Can edit/Can view", and layouts, the kill switch, Connections and Data settings are hidden. Viewers get read-only pages, tasks, diagrams and plots. The top bar shows who else is in the space now; click someone to go to them or follow them. Pages, tasks, diagrams and the board show who is on them, and diagrams show their live cursors ([29 §5](29_SHARING.md#5-live-presence)).

Two surfaces are deliberately **not** in the rail, because they are reached from the thing they belong to rather than browsed:

- `/tasks/<id>`, `/projects/<id>` — document pages, opened from the board, a mention, or a search result. §13.
- `/runs?run=<id>` — one run's preview over the Runs list, opened from Runs, from a task page (*View run*) or from the Code tab.

Prompt transparency is the expandable **Prompts** section at `/settings?tab=assistant#prompts` ("Open prompts"), backed by `GET /api/prompts`. There is no standalone `/prompts` page.

**Global header:** a three-part grid (`components/shell/topbar.tsx`): the page title on the left, the Ask bar centred, and one right-hand cluster with notifications, undo/redo, Fetch, activity, view mode, and an initials avatar. The side columns never shrink below their contents, so on narrow windows the Ask bar gives way instead of the icons overlapping it. The theme switch lives only in the avatar menu. The bell (`components/shell/notification-bell.tsx`) shows a count of unread notes and opens a notification center with unread-update and unread-request counts, All activity / Unread / Needs you / Agent / Reminders / Sharing filters, and date groups. Unread entries use neutral cards, readable titles, type icons, and explicit mark-read controls. The panel has a bounded scrolling feed, retry/error states, Escape dismissal, focus containment, and focus restoration to the bell. Opening or filtering it never marks anything read. The avatar (`components/shell/account-menu.tsx`, first and last initial from `lib/initials.ts`) opens a menu with the name and email, Account settings, Assistant and models, Connected apps, Spaces, Keyboard shortcuts, Take a tour (owners after setup), Templates (dev tools only), a theme switch, and Sign out. Collapse the sidebar to icons at any desktop width; the choice is saved. Drag the sidebar's right edge to resize it between 184 and 360 px (arrow keys work on the edge too; double-click resets); the width is saved per browser (`components/shell/sidebar-resize.tsx`, `--sidebar-w`). On Board, *Task board* is the heading in this bar, not a second large heading inside the work area.

Below the `lg` breakpoint, Undo/Redo, Fetch, and task-view mode move into **More actions** (`components/shell/topbar.tsx`). Search, notifications, activity, and the kill switch remain directly reachable. The activity popover stays inside the narrow viewport.

On phones, a setting row or card header whose control does not fit beside its text puts the control on its own line below, instead of squeezing the text (`SettingRow` and `SectionCard` in `components/ui.tsx` use a wrapping flex row, so wide screens are unchanged). Page gutters are 16 px below 640 px (`px-4 sm:px-10`). Context tiles take the full width below 640 px (`components/desk/desk.css`); their saved sizes apply on wider screens. Checked 9 Oct 2026 at 390 px, and at 1440 px against the previous build: eight desktop pages pixel-identical.

Code, Workspace, and Terminal distinguish a denied/failed request from an empty result or loading state. `components/ui.tsx` supplies a shared error message and Retry action; hosted access failures also link to paired-computer setup without granting host privileges. Settings' password, run-limit, fetch-time, and quiet-hour fields have explicit accessible names.

**Keyboard and phone behavior (checked locally 9 Oct 2026).** Phone navigation is a full labelled drawer with Jump to even when the desktop preference is a collapsed rail. Shared dialogs, the tile gallery, phone navigation and the focused plot editor use `lib/modal-focus.ts`: background inertness, Tab/Shift+Tab containment, Escape dismissal and opener restoration. Portalled popovers remain in their owning modal scope. Context and chart settings tabs use one tab stop with Left/Right, Home and End. Completed rows stack their readable title and actions on phones.

**Right side panel (collapsible, contextual):** *Ask about this* chat bound to the selected task/run — every message automatically includes the task's context-pack id; the engineer sees a chip list of what context is attached (e.g. `Ranker design review transcript`, `PR #412`, `skill: pr-description.service-x`).

> Superseded later by the floating Hub assistant (§10) and document pages (§13).

---

## 3. Screens

### 3.1 Today (Morning Briefing)

The old count tiles, *Your day*, *Recent meetings* and uneditable deliverable list are removed from this surface.

- **Work calendar:** a horizontal Monday–Friday row with natural-height event lists, all-day labels and Outlook/meeting links. Previous/next week controls read saved events; *Sync calendar* refreshes just that week from Graph.
- **My focus:** open high-priority tasks, tasks due by today, and explicit pins. *Add task* pins work; *Remove* hides it from focus without deleting it. `todayFocus` persists as `auto | keep | hidden`.
- **Proposed todos:** keyboard triage is retained. Details/source are expandable. A failed decision restores the card; *Later* persists its snooze even when ownership/status do not change.
- **Deliverables:** one board of real project deliverables. Checkboxes persist completion, titles open editable pages, and new deliverables can be added to a project. This is not a duplicate of every open task.
- **Reminders:** private, mention-aware title/date rows below deliverables. Date-only reminders start at 09:00; timed reminders start 30 minutes early. Snooze is always 15 minutes, with strict 22:00–09:00 quiet hours. See §14.

Focus and triage flow together without reserving a tall empty grid cell after triage finishes. Meetings remain accessible in Context, not duplicated here.

**Persona desks.** An account with a desk template (`activeTemplateId` maps to a desk in `components/desk/desks.ts`) sees `DeskView` instead: live tiles on a 12-column grid (72 px rows) drawn by `LiveBoard` (`components/desk/live-board.tsx`) from `/api/desk/live`. The person arranges it in place:

- **Resize:** drag the corner of a tile, or focus the corner and use the arrow keys. Sizes snap to whole cells. Every tile has a minimum (`components/desk/layout.ts` `tileLimits`): 3 × 2 cells by default, 4 × 3 for tiles that draw a week, band or timeline, 6 × 3 for hero tiles, 3 × 3 for analytics, and 3 × 5 for the month calendar; at most 12 × 8.
- **Move:** drag the grip before a tile's title, or focus it and use the arrow keys.
- **Hide:** the eye button in a tile's header. The toast offers Undo.
- **Add a tile:** opens a responsive two-pane library (`components/desk/add-tile.tsx`). Search and categories sit on the left; the selected tile uses the actual Today renderer with fictional, profile-specific data on the right. Compact, Medium and Wide respect tile minimums. Previewing never saves sample entries. Adding writes the layout once, reports errors, and marks existing tiles as already on Today. Categories cover Progress & insights, Planning & calendar, People & meetings, and Work & resources. `tile-catalog.ts` keeps specialist tiles relevant to the current profile (for example, no periods or hearings for an engineer). Existing custom placements are preserved; **Reset layout** restores the updated signup arrangement. Previously added shortcuts still render and can be removed.

The arrangement is the `desk.layout.<desk>` preference `{ v: 1, tiles: [{ key, c, r }], hidden: [] }`. A signup template writes it with `exact: true`, meaning only those tiles; the first edit writes the hidden list out instead. Desk tiles that are in neither list (a new tile in a later release) are appended. The profile-relevant desk extras in Settings → Account → Features (Deadlines, Learning, On the bench) still show or hide their tile when a layout is saved: switching one changes that desk's layout too, an extra that is off is never borrowed back automatically (adding it in the gallery enables it), and one that is on is added to a template layout. An empty desk shows one quiet line offering a sample (`desk.sample`), and the dismissal is remembered in the browser. The desk's name is not shown on Today or Context.

**Tile designs.** `tile-visuals.tsx` and `tile-data.ts` draw semantic teal, blue, amber, rose and violet charts in both themes, independent of the interface accent. Task progress is a selectable donut; Workload and Week ahead use columns; Time breakdown uses logged hours; Calendar is an interactive month of dated work; Calendar agenda reads upcoming connected events from `/api/widgets/feed` (`calendar-agenda.tsx`). Grading compares marked/expected submissions, mock scores have a subject selector and a 0–100% line, syllabus/revision use recorded completion states, and reading, drafts, people, meetings and citations have distinct card layouts. Unknown progress is not guessed from row position. Counts summarize the bounded `/api/desk/live` payload (up to 48 recent tasks and the endpoint's per-list limits), not all-time analytics. Team bars show configured weekly capacity, not measured workload. The sample mode uses these same renderers and the saved arrangement; its entries remain fictional.

Checked 11 Oct 2026: all 36 starting layouts rendered without tile-body overflow at the preview design width; the gallery was exercised at laptop and phone widths, in light and dark themes, and with preview/add behavior. `components/desk/tiles.test.tsx` covers role relevance, distinct template layouts, static thumbnails, numerical/zero cases, sample isolation, date deduplication, and successful/failed adds.


**Workspace search and Jump to (11 Oct 2026).** The top Ask Ensemble field (`components/shell/ask-bar.tsx`) searches as you type through read-only `GET /api/context/search?q=…`. Results are scoped to the current space, omit Trash, rank title matches first, deduplicate destinations, and show a single line around the literal match even deep inside a document. Task titles/descriptions/notes/documents, standalone pages, diagram titles/text, meeting sessions and existing Context search records are searchable. Exact title matches rank first. Submitting a unique result opens it directly, including when Enter is pressed before the fetch finishes; multiple destinations stay available as separate results. Typing alone never navigates. Arrow keys and Enter open results; Escape or an outside click dismisses them. Searching never captures a task or starts a model turn. Selecting a result opens its address with `match=…`; `components/shell/search-match.tsx` scrolls to the matched text and paints it for 1.8 seconds without changing saved content. A range overlay supports browsers without CSS Custom Highlights. Jump to (`components/shell/command-palette.tsx`, `navigation-destinations.ts`) searches a static destination catalog with breadcrumbs and keyword aliases: views, Context tabs, Code sections, settings controls, connector products/categories, actions and spaces. `components/settings/navigation.ts` owns nested destinations such as Accent, App font, time zone, model presets and retention controls. Settings resolves the requested label after its lazy tab renders and scrolls it below the sticky tabs. The catalog respects module and shared-space gates and never loads person, task, page or diagram names; those belong in top content search.

**Small screens.** Tile libraries below 980px switch between Browse and Preview, with one vertical dialog scroll area and wrapped categories. Today and Context tile bodies grow with their content on phones. Board overview tiles stack instead of adding another horizontal strip. Meeting notes use a library/reading switch with Back to notes on phones. Diagram editing already requires the minimum viewport; pan, zoom and download remain available. Plot code is view-only below 768px wide or 500px tall, with an explicit larger-screen message; chart viewing and export remain available.

### 3.2 Board (Kanban)

**Columns:** Proposed • To do • In progress • Waiting • Done. Each card shows its owner. The previous owner swimlanes are replaced by **one ordered list per column** so arranging work cannot accidentally delegate it.

**Current Hub controls:**

- **New task** in the page header or a column immediately calls `POST /api/tasks` with the title `Untitled` and opens the document editor (`components/board/board.tsx`). The separate **Capture idea** action in the Idea inbox tile opens a title-first dialog and creates an unassigned Proposed task only after submission. The title is selected for editing; owner, priority, due date, and other properties can be set on the page. Header creation uses *To do*, column creation uses that column, and human Waiting work is blocked. The owner starts unassigned; creation never delegates execution.
- Repeated creation is guarded synchronously and by the pending state. Errors are shown as toasts, and success clears filters hiding the new card. **Add page** converts an existing sidebar note into a task and opens it on the board. Task titles remain trimmed and whitespace-only titles are rejected. The shared `PageTitleField` restores the previous title on blank blur and displays a required-title message. Task property buttons include their property name in their accessible name.
- **Search** task titles and labels (`#label` matches labels only; `/board?q=%23label` opens the board filtered), then filter by owner and priority. The Board overview follows these filters. Selecting a chart segment or a tile action applies a second, clearly labelled board focus; its close button clears that focus.
- **Drag** with the dedicated handle, leaving the title available for opening. Reordering and cross-column moves persist `boardOrder` in Postgres, using **before/after task anchors** so filters do not overwrite hidden work. Pointer and keyboard sorting are supported. **Enter opens** a focused card; **Space** starts or drops keyboard dragging, arrows move it, and **Escape** cancels (`components/motion/board-drag/board-drag-dnd-kit.tsx`). Agent-owned work can be reordered; changing its progress requires an explicit *Take over* first.
- **Priorities** are Critical, High, Medium and Low (`critical`, `p0`, `p1`, `p2` in the API; `p1` is the default). Each has a muted color for dark and light themes (`--prio-*` in `app/globals.css`), used on the priority tag. Task cards keep neutral surfaces and borders. Decorative colored edge strips, card-wide priority washes, and colored state outlines are removed across waiting/error/streaming cards and drag targets. Status labels, icons, and charts carry meaning; keyboard focus remains visible.
- **Order** is a select next to the filters: *By priority* (the default; Critical first, then the saved order within a priority) or *Manual* (the saved `boardOrder` from dragging). The choice is kept in `localStorage` (`ensemble.board.order`). Reordering cards inside a column while sorted by priority switches to *Manual*; moving a card to another column does not. A new task is appended to the end of the saved order (`nextBoardOrder` in `apps/hub-api/src/services/tasks.ts`). *Settings › Place new tasks by priority* is stored as `orchestration.placeByPriority`, but the server does not read it yet.
- A human task dropped into *Waiting* is **blocked**, not a fabricated approval. The detail drawer also offers *Start work*, *Mark done* and *Reopen task*, so everyday state changes do not require dragging. Moves are optimistic and roll back visibly on an API failure.
- **Import** (before New task; `components/app-items/board-import.tsx`) has two entries: *Add from apps…* opens the app picker limited to issues, pull requests, cards, tasks, tickets, work items and conversations, and *Add as task* turns the pick into a task with the item attached (`POST /api/app-items/task`); *Import a board…* opens the import dialog ([27](27_IMPORTS.md)). Hidden in a space shared with you.
- A `?task=<id>` link loads the task independently of the current filters or pagination. Drawers open after hydration so an initially open Fluent portal cannot mismatch the server HTML.

**Cards** show title, priority, who the task is with, due date and up to three label chips (`components/task/labels.tsx`). Who it is with is relative to the person looking: **Me** for your own tasks, **Agent** for delegated ones, and colored initials (AS for Akash Sharma, AK for a one-word name) for anyone else in a shared space (`lib/space-people.ts`, `OwnerMark` in `components/board/task-card.tsx`). The owner select has All owners, Me, Agent and Unassigned. The ownership tile also offers Teammates, resolving legacy human tasks to the space owner and explicit assignments to their member. In a shared space the task page's Owner menu lists every member; picking one sends `assignee` (an account id) to `POST`/`PATCH /api/tasks`, and the server accepts only the space's owner or a member (`resolveAssignee`). An agent card shows only its current working/review step when the task is actually in that state. Details, help, delegation and takeover live in the task page rather than a button strip on every card. Hovering a card (or tabbing to it) shows one trash button at its top right, in spaces you can edit: it moves the task to Trash at once, with Undo in the toast (`remove` in `components/board/board.tsx`). There is no edit button; clicking the card opens it.

**Board overview (11 Oct 2026).** `components/board/insights.tsx` replaces the old numeric widget strip. It offers ten compact tiles: Board progress, Idea inbox, Who owns what, Agent work, On my plate, Waiting for a next step, Needs a fresh look, Dates to watch, A week of progress, and Work in progress. Each signup profile has three relevant defaults and profile-specific names; at most four tiles can be selected. A saved legacy strip maps its existing tiles into the new designs, including an explicitly empty layout.

**Board tiles** opens the same two-pane library pattern as Today, with categories, search, an interactive sample preview, add/remove, ordering, a WIP cap (1-50), and Reset for my profile. Tiles also have inline drag/keyboard handles and remove controls; one shared Ask action applies to the board or selected tasks instead of one per column. Layout is saved as `desk.board.insights` (`{ v: 1, tiles, collapsed, wipCap? }`). Failures leave the current layout intact. The overview collapses; it starts collapsed on phones unless the user has saved a preference. Shared viewers can inspect previews and collapse locally, but never fetch or write the owner's private preferences. Single-item shares use the visible board's tasks without private layout reads.

Metrics come from the same tasks fetched for the board, narrowed by the current search/owner/priority filters. A tile focus filters the kanban without changing any task. Me uses the viewer's account and task assignment. Agent work describes task ownership/status, not live runner execution. Quiet work means no update for at least seven elapsed days, not time spent in a status. Completion totals and the chart use today plus the previous six local calendar days; dated work includes overdue tasks and the next seven calendar dates. Unknown or missing dates are not invented.

**Task detail drawer (right):** description, provenance, people, related artifacts (auto-linked), plan, runs, comments (chat with the agent scoped to this task), history.

**From your apps** (`components/app-items/attached-items.tsx`, after the description on the task page and after the properties on a project page): items attached from connected apps with Open, Refresh and Remove, and *Add from apps…* which opens the picker (`components/app-items/app-item-picker.tsx`: search box first, app chips with "All apps", a kind filter, Preview of the first 800 characters, arrow keys and Enter; apps that failed are listed under the results; with nothing connected it links to Settings → Connections). **Post an update to …** (`components/app-items/post-update.tsx`) appears when the task has an issue, card or ticket to comment on (`GET /api/app-items/update-target`), prefilled from the last successful agent run; Post is the approval. Both are hidden on shared tasks ([31](31_CONNECTORS_IN_USE.md)).

**Agent on the task page** (`TaskAgentPanel` in `components/agent/job-card.tsx`): the latest job for the task, live while it runs (progress line, live log, Stop). When it has finished: its state, the model (and *answered by …* when the provider reported a different one), turns, tool calls and tokens, how long it **took**, the cost estimate, *View run* (the run preview above) and *Review changes* for a server review. **Agent output** is a collapsible section, open by default, with the job's summary rendered as Markdown (long output fades with *Show all*) and the files it changed with lines added and removed. *What it did* lists the job's events and its log.

**Current task page:** drag its left edge to resize, use full-width mode, or open `/tasks/<id>`. Width/sidebar preferences are local; task data is in Postgres. Title, description, notes, priority, date, labels (chips; Enter or a comma adds one, Backspace removes the last), project, people, repo, deliverable and explicit skills are editable. Changes **autosave after a short typing pause**; **Ctrl+S** flushes immediately. Failed/conflicting saves retain the draft rather than overwriting another tab. Notes retain Markdown whitespace. Peeks with unsaved changes require confirmation before leaving. The board API omits note bodies; opening a page loads them on demand.

### 3.3 Needs Me (Approval Queue)

`app/(hub)/needs-me/page.tsx` groups the work into **Agent & editor requests**, **Outgoing approvals**, and **Waiting tasks**, with counts and filters. The all-clear state appears only when all three reads succeed and every queue is empty. Fetch errors offer Retry. Empty editor sections stay out of the Everything view while other queues have work.

Requests retain their source-specific controls in `components/needs-me/editor-decisions.tsx`: questions, permissions, device-only approval requirements, and read-only cards for another runner. Outgoing approvals retain the exact payload preview and Approve, Edit / Approve edited, and Reject with a reason. Shared-space guests cannot approve the owner's outgoing actions. Waiting-task cards link to the task and show its status and last update; a blocked status alone does not create a permission request or claim that the current viewer can answer it.

All review cards use neutral borders and small status labels, with no colored edge ribbons.

### 3.4 Runs (Agent Timeline / Trace)

As built 14 Oct 2026 (`app/(hub)/runs/page.tsx`, `components/runs/run-preview.tsx`, `lib/run-trace.ts`). The page lists the latest 10 runs; **Show all runs** loads up to 200 in place. Each row shows the task, when it started and how long it took, the harness for an agent run (Ensemble agent, Claude Code, Codex or Cursor), the model (the one that answered when the run reported it, else the one asked for), where it ran (a paired computer by name, the Ensemble server, or this computer), its tool calls (or steps), and its cost (the harness's estimate in dollars, or credits). The list refreshes while a run is still going. Hover a row to delete it (a soft delete).

**Clicking a run opens its preview**, a sheet over the list (`?run=<id>` keeps it in the address; Esc or × closes it). *Open task* on a row opens the task in the side peek instead; *Open task* in the preview goes to the task page. The preview shows:

- **Facts:** harness (and the provider for Ensemble's agent), the model asked for and its thinking level, the model that **answered** (flagged when it is not the one asked for; `sameModel` treats dated ids such as `claude-sonnet-4-6-20260101` as the same model), where it ran, guardrails (sandbox, internet, git permission), folder and branch, turns and tool calls (limits on hover), tokens in and out, and cost.
- **Trace:** time per tool (calls, total time, failures, as bars), then every step in order: thinking, messages, each tool call with its input and output (copyable), its time, its status, and a bar placing it on the run's timeline. Filters (All, Tool calls, Thinking, Messages) and Expand all. A failed step and the result open by default. A live run refreshes every 3 s.
- **Result:** the run's result as Markdown. **Files:** the files changed with lines added and removed, and any pull request or commit. **Activity:** the job's events (folder ready, sandbox, engine and session, commands, decisions) and approvals. **Log:** the job's log output.

The steps are what each harness recorded (doc [06](06_MODULE_WORKSPACE_AND_SURFACES.md), [30](30_ENGINES.md)); a paired computer sends previews of them (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) §4.3). A run from a computer with Ensemble older than 0.3.5 has only its result. The preview reads `GET /api/runs/:id`, which returns `{ run, job }`. Markdown here and in the assistant renders headings, lists (numbered, nested, task lists), fenced code with a Copy button, tables, quotes, rules, bold, italics, strikethrough, inline code and links; links open only for `http(s)` and app paths (`components/markdown-text.tsx`).

### 3.5 Context (Engineer Graph explorer)

On a persona desk, Context (`components/desk/context-lens.tsx`) has the same tab row for every desk: **Overview, People, Projects**, the desk's own tabs (for example Repos, Reviews, Deploys), and **Graph** (`components/desk/context-tabs.ts`). People, Projects and Graph render the full components from `components/context/`. The tab is in the address (`/context?tab=people&search=…`), so mention links land on it. Files and items from connected apps are in Files ([§3.10](#310-files)); old `/context?tab=artifacts` links (also with `view=widgets`) go to `/files?view=apps`. The Overview and the desk's own tabs use the same tile controls as Today (`components/desk/arrange.tsx`): move by the grip, resize from the corner, hide. Each tab's arrangement is the `desk.context.<desk>.<tab>` preference; hidden tiles come back from the chips under the grid, next to **Reset layout**. The Board has its own compact overview and **Board tiles** gallery. Context overview sections reuse Today's live tile bodies; People and Artifacts use navigable cards, while saved placement keys and resizing controls are retained. Each card in the Overview's Artifacts tile opens that item in Files → From your apps (`/files?view=apps&item=<id>`). *Add person* takes a name, an optional email and an optional role, reports errors in a toast, and an empty People tab offers the same action. **Add people from…** (`components/app-items/people-from-apps.tsx`) lists the connected apps that have a people list and adds their members (`POST /api/app-items/people`), toasting how many were new and how many were already known. The Overview's People tile links to the People tab.

**Tabs:** *People* (who I work with, on what, last interaction, my typical response time), *Projects* (deliverables, work items, meetings, docs), *Repos* (my ownership, PR stats, style skill), *Preferences* (working hours, focus preferences, tone notes). Each node shows evidence (*"inferred from 14 emails and 3 meetings"*) and an **Edit / Correct** button — corrections are first-class data.

> Later: evidence and confidence badges were removed from the cards (see [03 §3](03_MODULE_CONTEXT_ENGINE.md#3-normalized-model)).

The **Graph** tab has a **Full screen** button. A few hundred nodes are not readable inside a page column, and zooming out to fit them only trades one unreadable view for another. It asks the browser for real fullscreen — the only way to get the browser chrome out of the way — and falls back to an in-page overlay when that is refused, which happens without a user gesture, in some iframes, and on iOS Safari. Both paths use the same layout, so they look identical; **Esc** leaves either one. Full screen changes nothing about the data, only how much of the screen the canvas gets. The Graph, Files (§3.10) and pages (§13) share one helper, `lib/fullscreen.ts`. It asks for fullscreen on the whole document rather than one element, so menus, dialogs and toasts that render into the page body still show. In Chromium it also asks to keep Esc for the page (Keyboard Lock), so the first Esc clears a highlighted node and the next leaves; holding Esc always leaves. While the mode is on, the rest of the app is inert and does not scroll, and leaving the browser's fullscreen by any route ends the mode.

**Meeting notes.** `app/(hub)/meetings/page.tsx` presents a searchable library with All notes, In progress and With recap views for meeting pages, date/status/excerpt cards, and a reading pane. The library count includes notes from connected meeting tools; those notes have their own source, action-item and decision cards (`components/meetings/imported-notes.tsx`) and share the text search. Picking a meeting updates its `session` URL. Existing autosave, draft recovery, recap requests, explicit event attachment, sharing and deletion behavior stays in the existing handlers. Empty/error states distinguish no notes from a failed fetch. New notes and recap requests disable while pending.

### 3.6 Skills

Library of personal skills (cards: name, scope, version, confidence, last used, acceptance rate). Click → `SKILL.md` editor with side-by-side evidence (the 8 PRs it was mined from) and test (*"draft a PR description for #412 with this skill"*). Toggle enable/disable; *"Regenerate from latest history"*.

### 3.7 Workspace

*Upcoming / Working now / Recently completed* is the agent's workboard. The last column contains **at most five** actual completed tasks, newest first. Review, blocked and stopped attempts have a separate attention area; no waiting state keeps calling a model. Queue rows explain shared-resource or capacity waits.

Board and Workspace import the same `TaskCard` and open the same `TaskPanel`. The assignment form is shared by task pages, deliverables and Today (the **a** key opens it without committing an assignment). Each task can select sandbox or native execution, model, review/unattended publishing, an existing checkout, branches and limits. Native's lack of hard isolation is explicit.

Results remain on the original pages: final notes, verified PR/commit, real file additions/deletions, checks, context/skill snapshot and native provider events. Heavy diff/response bodies load only when details are expanded. VS Code links open the actual Windows checkout, not a separate copy.

Connector sync and switches are in Settings, not Workspace. Conversational help remains under *Ask the agent* on a task and in the Hub assistant. Its context chips still support exclusion, keyboard selection and per-task state isolation.

#### 3.7.1 Code

Every run that changed files, then an IDE-style review of one: unified diff with accept/reject per change (rejecting writes the old lines back to disk and offers — inline, no popup — to write that part yourself); whole-file view with change bars; commit/push/PR panel; a guarded, passkey-gated terminal. The list is plain Ensemble styling; the review is full-bleed and follows the theme (or stays dark). Details, including snapshots and the failed-run discard, are in [docs/16](16_CODE_TAB.md).

### 3.8 Metrics

Before/after tiles + charts (see [module 07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#6-before--after-measurement-the-headline-for-judges)): triage time, drafts accepted, context re-typing avoided, agent actions by type, approvals turnaround.

### 3.9 Settings

`app/(hub)/settings/page.tsx` is one page with eight tabs (`components/settings/settings-tabs.tsx`): a vertical list on wide screens and a scrolling row on narrow ones. Arrow keys, Home and End move between tabs, and each tab is a real link. The tab lives in the address (`/settings?tab=connections`); switching tabs pushes a history entry, so Back returns to the previous tab. Old one-page anchors still land: `/settings#models`, `#connections`, `#devices`, `#fetch`, `#retention` and the rest are mapped to their tab in `components/settings/url-state.ts` (`SECTION_TAB`) and scrolled into view. Only the open tab's code loads (`next/dynamic`).

| Tab | Sections (anchor) |
|---|---|
| Account | Account and profile (`#account`), Avatar (`#avatar`: the 15 picture avatars for the sign-up role, or initials), Email & time zone (`#you`), Appearance (`#appearance`), Features (`#features`), Remote tasks on this Mac (`#this-mac`, desktop app only) |
| Assistant | The assistant (`#assistant`): write policy, default preset, *What it may change*; Models (`#models`); Watching for you (`#watchers`, only while a watcher is active); Autonomy (with "Trust folders in your other AI tools too" on the desktop app and CLI), Orchestration (with "Outside the work folder, in sandboxed tasks"), Quiet hours, Prompts |
| Connections | Connections (`#connections`), Recent imports (`#imports`, once there is one), Fetching (`#fetch`), Editors & agents (`#editors`, `#connect`), Devices (`#devices`) |
| Notifications | Morning brief (`#brief`), Quiet nudges (`#nudges`), Desktop reminders (`#reminders`), Quick capture (`#capture`) |
| Spaces | Your spaces (`#spaces`): rename, icon, open, delete; *Settings across spaces*: keep every space in sync, or copy another space's settings in ([28](28_ENSEMBLE_SPACES.md)) |
| Sharing | Contacts (`#contacts`, 5 slots), spaces you share and their members, hand over a space (once), items you shared, public links (5), shared with you ([29](29_SHARING.md)). In a space shared with you, Connections and Data are hidden and a note says settings are your own |
| Shortcuts | Every key binding by group (`#shortcuts`, `#keyboard`), see below |
| Data | Download this space (`#export`, see [§18](#18-downloads)), Data retention (`#retention`), Completed (`#completed`), Trash (`#trash`), Terminal and commits (`#terminal`), Failed jobs, Deleted items, Delete my data (`#danger`) |

**The settings map.** `packages/shared-types/src/settings-map.ts` (`SETTINGS_MAP`) lists every setting on these tabs with a plain label, search words, one line on what it does and its link (`/settings?tab=…#jump-…`, the jump ids `components/settings/navigation.ts` resolves, or `&dialog=keys` / `&dialog=changes`). The assistant's `hub_find_setting` searches it, and only the entries with a `key` can be changed by `hub_update_settings` ([11 §8.3](11_HOW_THE_ASSISTANT_WORKS.md#83-running-work-code-and-settings)). `components/settings/url-state.test.ts` checks that every link opens its tab and lands on a known section or control. The page's own jump search still uses `navigation.ts`.

Big or rarely used controls open in dialogs (`components/settings/modal.tsx`: Escape and a backdrop click close only the top dialog, Tab stays inside it, focus returns to the button that opened it). Dialogs are in the address too, so a link opens them:

- **Model providers & keys** (`?tab=assistant&dialog=keys`, or `#keys`): API keys per provider with inline add/replace/remove, a Test button per tier, the Ollama URL and the GitHub token for private clones. The Models card itself keeps only "Which model each tier uses" and a one-line summary of which providers have keys (`components/settings/models.tsx`).
- **What the assistant may change** (`?tab=assistant&dialog=changes`, or `#changes`): the six areas inside Ensemble, plus the *Connected apps* switch (`assistant.connectedAppWrites`): the assistant may propose changes in Google, Microsoft and other connected apps, and each one waits for Apply. The card shows a summary such as "Everything inside Ensemble · Connected apps ask first" (`components/settings/assistant.tsx`).

**Shortcuts** (`components/settings/tab-shortcuts.tsx`) lists every binding from `@ensemble/shared-types` `shortcuts.ts`, grouped Everywhere, Create, Go to, Today, Pages, Code and Diagrams. *Change* records the next chord; Escape cancels. A custom chord must use Command/Ctrl or Option/Alt with a key, and `customChordProblem` refuses chords the browser or macOS already own (Command-P, Command-W, Command-T, Command-Q and the rest), named keys, function keys, and chords another action uses. Overrides are the `ui.shortcuts` preference, applied by `lib/shortcut-store.ts` everywhere shortcuts are read, including the `?` sheet. *New task* (N then T) and *New page* (N then P) are new bindings; a custom chord works alongside the two-key sequence. Option chords match the physical key, so macOS dead characters do not break them. `ui.*` and `desk.*` preferences are hidden from the Preferences list in Context.

The assistant's tone follows the role chosen at sign-up, or the persona a template set (`assistant.actAs`). Nothing after onboarding asks for the role again (13 Oct 2026): Settings has no *Your field* picker, the inline `@ensemble` panel has no *Act as* picker, and the avatar picker shows only the sign-up role's set. *Watching for you* lists the conditions the assistant watches after "tell me when …", with Cancel; it is hidden when none are active.

**Fetching** (`components/settings/fetching.tsx`) shows that scheduled fetching is paused product-wide, with **Sync now**, the look-back days and the *Propose todos from what was read* switch. There is no schedule editor while routines are being built.

**Editors & agents** links to `/connect` (*Connect an editor*) instead of embedding the app picker; the permission-prompt hooks, personal token and standing answers sit behind a disclosure that opens by itself for `#editors`. Inside it (12 Oct 2026): "Which sessions come to Needs me" (tasks Ensemble opened, or every session; `orchestration.editorRequests`), and on the desktop app or the CLI's runtime a **Connect** / Disconnect button per tool (Claude Code and the Claude app, Codex, GitHub Copilot CLI, Cursor) that installs the hook with a `hooks` key (`POST /api/editors/connect`); VS Code and other computers keep the copy-a-command steps.

#### Connector store

Settings → Connections lists the featured catalog entries (`featured: true` in `CONNECTOR_CATALOG`, shown in the order Google Workspace, Microsoft 365, Notion, Linear, GitHub) with their status ("Connected as …", "Not connected", "Not set up on this server") and one action, plus **Browse connectors**, **Import from other apps** (opens `components/imports/import-dialog.tsx`) and **Add custom connector (MCP URL)** (`components/connectors/featured.tsx`).

**Browse connectors** opens the store (`components/connectors/store-dialog.tsx`), a dialog of up to 1000 px by 80 % of the window. The search box has focus when it opens, filters as you type (every word must match the name, vendor, tagline, products or what it reads), and `/` focuses it again; Escape in a non-empty search clears it first. The sidebar (chips on narrow screens) lists All, Connected, each `CONNECTOR_CATEGORIES` entry that has apps, and Import. Each card shows the vendor's own logo (`components/connectors/brand-logo.tsx`, [31 §5](31_CONNECTORS_IN_USE.md#5-logos)), name, tagline and status. Every entry can be connected; none is listed as coming soon.

A card opens the connector's detail inside the same dialog (`components/connectors/connector-detail.tsx`), with a Back button. The address holds the view (`?tab=connections&store=<category>` and `&connector=<id>`; `connector=custom` is the custom form, `connector=mcp:<id>` a custom server), and OAuth and MCP sign-ins return to `/settings?tab=connections&connector=<id>`, so the detail reopens after the redirect and the page toasts `?connected=` / `?connectError=`. The detail shows:

- **In Ensemble**: what Ensemble does with the app once connected (`connectorUses` in `components/connectors/catalog-view.ts`: syncs, attach, add as task, post updates, people, repositories for agents, import, the assistant's tools), then what it reads and what it can change ("Each change waits for your Apply"), notes, and the vendor's docs link;
- before connecting, every way in, in catalog order: **Sign in with …** (`GET /api/connectors/:provider/start?products=…&returnTo=…`; suites first ask which products to switch on, and Google uses Google's sign-in button), **Paste a token** (an inline form with a *Where to get it* link: Notion's secret, Atlassian email + API token + site, Trello key + token, one token elsewhere; `POST /api/connectors/:provider/token`), **Connect tools** (`components/connectors/mcp-way.tsx`: `POST /api/mcp-connections {serverId, returnTo}`, then the vendor's approval page; entries with address `fields` ask for them first (Grafana stack, AWS Region); `token.only` entries show the token form instead (Intercom, Render, Smartsheet, Wrike) and other `token` entries offer *Paste … instead*; `ownClient` entries ask for the client ID and secret the person's admin registered (Salesforce, Front) and show the redirect URI to register; `connection` entries offer *Use your GitHub/Linear connection*; `client` entries whose operator app is missing say so and give operators *Set up once*; when the server answers `MCP_TOKEN_REQUIRED`, `MCP_PKCE_UNSUPPORTED` or `MCP_TOKEN_REFUSED`, a token field appears in place and the same call is retried with `token`), and **Import** for file-only entries;
- "Not set up on this server yet" when browser sign-in is the only way in and the operator has not registered the provider's app (`state.appReady` false); operators also get the existing *Set up once* dialog there;
- when connected: the account, per-product switches for suites (`PUT /api/connectors/:id/products`; a product that needs new consent shows *Continue to Google/Microsoft* instead of redirecting by surprise, and products waiting for consent show *Approve access*), each sync source with its last sync and **Sync now**, the Slack channel list, and **Disconnect** with an inline confirm that can also delete what Ensemble read (`DELETE /api/connectors/:provider?deleteData=1`);
- for MCP: status, the server's tools with a switch each (`PATCH /api/mcp-connections/:id {disabledTools}`), *Refresh tools* and *Remove*;
- **Import from …** when the entry has `import`, opening the import dialog on that source.

The custom connector form (`components/connectors/custom-connector.tsx`) takes a name and an https URL and asks how the server signs in: on its own page (default), a personal access token, or an OAuth client ID and optional secret. `MCP_URL_REFUSED` is shown under the URL field, and a server that needs a token switches the form to the token field. Recent imports (`components/imports/recent-imports.tsx`) appear under Connections once there is one.

Client calls for the store and MCP routes are in `lib/api-connectors.ts` (the MCP connect call keeps hub-api's error `code`); the catalog comes from `GET /api/connectors/catalog`.

**Logos and trademarks.** `components/connectors/brand-logo.tsx` draws logos from the `simple-icons` package (CC0), imported one icon at a time so only those paths are bundled. Brands simple-icons does not carry (every Microsoft product, Slack and AWS, which asked to be removed, and most meeting recorders) get a plain tile with the name's initials, in the brand colour where we know it; we do not draw imitations of those marks. A simple-icons mark with the same name as a different company (its "Fathom" is Fathom Analytics) is not used for the other one. The store footer and this doc carry the notice: *Product names, logos and brands are property of their respective owners and are used only to identify the services you can connect. Ensemble is not affiliated with or endorsed by them.*

---

### 3.10 Files

`/files` (`components/files/files-screen.tsx`) has two views, switched at the top and kept in the address (`app/(hub)/files/page.tsx`): **Your files** (`/files`) and **From your apps** (`/files?view=apps`). Your files lists every file this person keeps, as a grid or a list, with a name search and a filter for each kind of file it holds (PDF, Document, Slides, Spreadsheet, Image, Text, Code, Audio, Video, File). Each file has a delete button (on the card's corner in the grid, at the end of the row in the list; hidden for space viewers) that asks the same "Delete this file?" question as the file's own screen (`delete-file.tsx`). **Upload** takes many files at once, and files can be dropped anywhere on the screen; each upload shows its progress. On the hosted site a meter shows files and megabytes used against the 10-file, 50 MB cap and says "Delete a file to add another" when it is full; desktop and local servers show no meter. **Add from your apps** (`import-from-apps.tsx`) lists Google Drive, Gmail, OneDrive, Outlook, Dropbox and Box with their state (Ready, Needs permission, Not connected, Not set up yet). A ready source opens a search ("Find attachments" for mail); the others show the plain sentence, numbered steps and a button to the right place in Settings → Connections. Google Drive with only the narrower Drive scope offers **Pick from Google Drive** (the Google Picker) when the server is set up for it.

**From your apps** (`components/files/from-apps.tsx`) lists what Ensemble synced or attached from connected apps: mail, calendar events, chats and channel messages, transcripts, pull requests, issues, and pages or files attached to a task or project. Uploaded files are not repeated there. Each row shows the title, the kind (or the app's own word for an attached item, such as Page or Card), the app with its logo and the date; there is a search over titles and text, a chip per kind with its count, and **Show more** (50 at a time). Choosing an item opens a reader beside the list (full width on phones; `&item=<id>` in the address) with its facts (dates, from and to, place, repository, the app's own fields), the people on it, its text, **Open in <app>** when it has a link, and **Remove** for the space's owner. Remove asks first, then the item leaves every reader and later syncs do not bring it back ([32 §11](32_FILES.md#11-from-your-apps)). An item that is an uploaded file's text opens that file instead. With nothing yet, an empty state says what appears here and, for the owner, links to Settings → Connections. The search fields in both views draw one focus edge, on the box (`search-line`).

`/files/[id]` (`file-screen.tsx`) shows the file full size (`file-preview.tsx` loads one viewer per kind, only when needed) with **Download**, **Convert to a page** (PDF and Word; "Make a page" for text, code, Markdown, CSV and TSV), **Attach to a page…** (search pages and tasks, or copy a link to paste with @) and Delete. Imported files show the app they came from. Spreadsheets edit in place: double-click or type into a cell, **Add row**, then save; .xls, .ods and .numbers first need **Make an editable .xlsx copy**. Converting a PDF or Word file shows a short notice (about 3.5 seconds) that export back keeps the original's formatting. Slides have **Present** (one slide at a time over the whole screen, `viewers/present.tsx`); PDFs, Word files, spreadsheets, images, video, text and code have **Full screen** (the same viewer, with its page number, − / + zoom and Fit width, fills the screen under a bar with the file name and an × that leaves; 13 Oct 2026 for PDFs, which presented before). Both use `lib/fullscreen.ts` (§3.5): the browser's fullscreen where it is allowed, and otherwise a fixed layer over the app, which is what iPhone Safari and WebViews that refuse fullscreen get. Focus moves into the layer and back to the button afterwards, and Esc leaves. The presenting keys, and what each format can do, are in [32 §1](32_FILES.md#1-what-each-kind-of-file-can-do).

## 4. Interaction patterns (details worth getting right)

| Pattern | Behaviour |
|---|---|
| **Delegation dialog** | Appears inline (popover), never a full modal. Fields: autonomy (radio), deadline, one-line note. Default = *"Draft & ask before send"*. *(Later replaced by the shared assignment form — [06 A1](06_MODULE_WORKSPACE_AND_SURFACES.md#a1-assign-once-then-leave-it-working).)* |
| **Take over** | Pauses the agent's run, moves task to Me, keeps the agent's partial output as a draft attached to the task. |
| **Hand to agent midway** | From a Me-task: agent gets my partial work (branch diff, half-written email) + context pack. |
| **Confidence shading** | Proposed todos with confidence < 0.6 render muted with *"Not sure this is for you — from CC thread"*. |
| **Quiet hours** | Agent still works but batches "Needs Me" items; no notifications 19:00–08:30 IST. |
| **Undo** | Sent email → can't undo, so default autonomy never sends without approval. PR → close + comment. Teams → delete message within 5 min. Work item → revert field. |
| **Corrections teach** | Every *Edit & approve* diff, every *Reject reason*, every Context correction becomes a `skills.evidence` row for the Skill Forge to consume. |
| **In-app prompts** | Questions and confirmations (new skill name, delete a skill, empty Trash, and similar) use `askText` / `confirmAction` from `components/ask-dialog.tsx`, a themed dialog mounted once in `app/providers.tsx`. The Hub does not call `window.prompt` or `window.confirm`. |
| **Keyboard** | `j`/`k` move, `m` me, `a` agent, `l` later, `Enter` open, `y` approve — triage in seconds. |

---

## 5. State & data flow

- **React Query** for REST (`/api/tasks`, `/api/approvals`, `/api/runs`, `/api/briefing/today`, `/api/context/*`, `/api/skills/*`, `/api/metrics/*`).
- **SSE channel** `/api/events` pushes: `task.created | task.updated`, `run.step`, `approval.requested`, `briefing.updated`, `agent.status`. Client invalidates queries on events.
- **Zustand** for UI-only state (selected task, filters, panel open).
- **Optimistic updates** for triage actions.

---

## 6. API contract (hub-api → UI, abridged)

> Abridged. The routes themselves are in `apps/hub-api/src/routes/` (one module per area). The reusable API factory registers them; `apps/hub-api/src/index.ts` manages listening and background services.

### Core

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/briefing/today` | → `{ proposedTodos[], day[], deliverables[], changes[], meetingsRecap[], connectors[] }` |
| GET | `/api/tasks?owner=&status=&project=` | → `Task[]` |
| POST | `/api/tasks` | `{ title, description?, priority?, owner?, due?, projectId?, repoId?, labels? }` → `Task` (201). Labels are trimmed and de-duplicated; at most 20 of 40 characters |
| POST | `/api/tasks/:id/move` | `{ status, beforeId? \| afterId? }` → `Task` |
| GET | `/api/calendar/week?offset=0` | → `{ days[5], today, timeZone, events[], connector }` |
| POST | `/api/calendar/sync` | `{ offset? }` → calendar-only sync |
| GET | `/api/today/focus` | → `{ tasks[] }` |
| GET | `/api/deliverables` • `/api/deliverables/:id` | |
| POST | `/api/tasks/:id/triage` | `{ decision: 'mine' \| 'agent' \| 'later' \| 'drop', autonomy? }` |
| POST | `/api/tasks/:id/assign` | `{ owner: 'me' \| 'agent', autonomy, note }` |
| POST | `/api/tasks/:id/delegate` | `{ autonomy, note?, due? }` |
| POST | `/api/tasks/:id/takeover` | |
| PATCH | `/api/tasks/:id` | `{ status?, owner?, priority?, notes?, projectId?, people?, labels?, repoId?, deliverableId?, skillIds?, todayFocus?, expectedUpdatedAt?, … }` |
| GET / POST | `/api/pages` | → `{ pages[] }`, standalone notes newest first • `POST` → `201 { page }` (§13) |
| GET / PATCH / PUT / DELETE | `/api/pages/:id` | → the active note • `{ title }` • `{ revision, content, notes?, annotations? }`, `409` on a stale revision • `204`, moves a standalone note to Trash |
| POST | `/api/pages/:kind/:id/convert` | `{ revision }`; `kind` is `page` or `task`. Converts to the other type and returns `{ kind, id, pageId }`. Ownership, revision, and active-agent checks apply. |
| GET / POST | `/api/pages/:kind/:id/comments` | User-scoped discussion rows for a task, page, project, or deliverable |
| POST | `/api/pages/:kind/:id/ensemble` | Inline SSE answer; accepts `{ prompt, content?, mentions?, parentId?, quote?, tier?, actAs? }` |
| GET | `/api/tasks/:id/context` | → context pack preview (chips, no model call) |
| POST | `/api/tasks/:id/help` | `{ delta, excludeChipIds? }` → streams the answer (SSE) |
| GET | `/api/approvals?state=pending` | → `{ approvals[], questions[], interrupted[] }` |
| POST | `/api/approvals/:id/decide` | `{ decision: 'approved' \| 'edited' \| 'rejected', editedPayload?, reason? }` |
| POST | `/api/approvals/:id/revise` | `{ note }` |
| GET | `/api/runs` • `/api/runs/:id` • `/api/runs/:id/export` | List rows add the agent job's harness, model that answered, where, tool calls, tokens and cost. `/api/runs/:id` → `{ run, job }`: the run with its steps and approvals, and the job behind it (harness, models asked for and used, where it ran, sandbox, internet, git permission, limits, counts, cost, files, results; no server paths), or `job: null` |
| GET | `/api/context/people\|projects\|repos\|preferences` | → graph nodes with evidence |
| GET | `/api/context/search?q=…` | Read-only literal workspace search, up to 12 deduplicated destinations with snippets; current-space access, no Trash |
| POST | `/api/context/corrections` | `{ nodeId, nodeKind, field, value, note }` |
| GET | `/api/connectors/catalog` | → `{ entries[] }`: every `CONNECTOR_CATALOG` entry plus `state` `{ connected, account, appReady, oauthReady, mcpReady, products, needsConsent[], sources{ id: { enabled, lastSyncAt, lastError } }, mcp? }` for the signed-in person (`mcpReady` false when the vendor's MCP server needs an operator-registered app that is missing) ([03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens)) |
| GET | `/api/connectors/:provider/start?products=a,b&returnTo=` | → `{ url }` for the provider's consent screen. Asks for base scopes plus the listed products (or the saved toggles). 409 when the host has not set up that provider's app. Verified accounts only on hosted. |
| GET | `/api/connectors/:provider/callback` | Public OAuth redirect target; stores the token and redirects to `returnTo` with `connected=<provider>` or `connectError=<message>` |
| PUT | `/api/connectors/:id/products` | `{ products: Record<string, boolean>, returnTo? }` → the entry `state`, or `{ reconnect: true, url, needs[], state }` when a product needs access the stored token lacks |
| POST | `/api/connectors/:provider/token` | `{ token, email?, site?, key? }` → `{ ok, account }`. Checks the pasted token with the provider first (github, slack, linear, notion, atlassian, trello, asana, todoist, clickup, monday, and the meeting-notes sources fireflies, fathom, granola, tldv, krisp, jamie, otter; [03 §2.3](03_MODULE_CONTEXT_ENGINE.md#23-meeting-notes-sources)). |
| DELETE | `/api/connectors/:provider?deleteData=1` | → `{ ok, revoked, deleted }`. Revokes where possible, removes the token, switches its sources off; `deleteData` also deletes the artifacts they stored. |
| GET | `/api/connectors/google/picker` | → `{ apiKey, appId, accessToken, origin }` for Google Picker; `accessToken` is null until `drive.file` is granted. 409 without `GOOGLE_PICKER_API_KEY` / `GOOGLE_PROJECT_NUMBER`. |
| GET / PUT | `/api/connectors/apps` • `/api/connectors/apps/:provider` | Instance OAuth apps with redirect URIs and setup steps, the registered MCP clients some vendors need (`hubspot_mcp`, `asana_mcp`, `slack_mcp`, `dropbox_mcp`, redirect URI = the MCP callback), and `mcpRedirectUri`; saving is operator-only on hosted |
| GET | `/api/mcp-connections` | → `{ connections[] }`: `{ id, serverId, name, url, status (pending\|connected\|error\|disabled), auth (oauth\|bearer\|connection\|none), toolCount, tools[{ name, title, description, readOnly }], disabledTools, lastError, toolsSyncedAt, createdAt, updatedAt }`. Never returns tokens ([03 §2.2](03_MODULE_CONTEXT_ENGINE.md#22-remote-mcp-connectors)). |
| POST | `/api/mcp-connections` | `{ serverId }` (a catalog entry with `mcp`) or `{ url, name? }`, plus optional `token` (sent as `Authorization: Bearer`), `clientId`/`clientSecret` (a client the person or their organisation registered with the vendor), `fields` (values for the entry's address, e.g. `{ stack }`; a reconnect reuses the stored ones), `useConnection` (sign in with the person's connection to the entry's `mcp.connection` provider; nothing is copied) and `returnTo` (a relative Hub path) → `{ id, status, authorizeUrl? }`. `authorizeUrl` means open the vendor's approval page. 400 with `code` `MCP_URL_REFUSED`, `MCP_FIELD`, `MCP_TOKEN_REQUIRED` (paste a token instead), `MCP_PKCE_UNSUPPORTED` or `MCP_TOKEN_REFUSED`; 409 `MCP_APP_MISSING` when the vendor needs an operator-registered app that is not set up, `MCP_RECONNECT` when the connection to sign in with is missing. |
| GET | `/api/mcp-connections/callback?code&state` | Public OAuth redirect target. Single-use state, 10 minutes. On hosted the browser's session must belong to the person who started the connection, or nothing is saved. Redirects to `${HUB_WEB_ORIGIN}${returnTo}` with `mcp=connected\|error`, `server=<serverId>` and, on error, `mcpError=<message>` |
| POST | `/api/mcp-connections/:id/refresh-tools` | → `{ connection }` after listing the server's tools again |
| PATCH | `/api/mcp-connections/:id` | `{ disabledTools?: string[], status?: "disabled"\|"connected" }` → `{ connection }` |
| DELETE | `/api/mcp-connections/:id` | → 204. Revokes the tokens at the vendor when it offers revocation, then deletes the connection |
| GET | `/api/mcp-client-metadata.json` | Public. Ensemble's OAuth Client ID Metadata Document; its URL is the `client_id` on https deployments |
| GET / POST | `/api/connections` • `/api/connections/:id/sync` • `/api/fetch` | Sync sources and their status; Sync one source; Fetch now (all enabled sources). Scheduled fetching is paused ([03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors)). |
| GET | `/api/people/identity-suggestions` | → `{ suggestions[] }`: `{ key, people[2]{ id, name, email, identities[] }, reason (seen-together\|same-name\|handle-matches-email), question, evidence }`. Computed on read; ingest never merges ([03 §4.7](03_MODULE_CONTEXT_ENGINE.md#47-one-person-across-sources-identities)) |
| POST | `/api/people/identity-suggestions/dismiss` | `{ personId, otherId }` → `{ ok }`; the pair is not suggested again |
| POST | `/api/people/:id/merge` | `{ otherId }` → `{ person, moved }`. Keeps `:id`; moves identities, task people, meeting people, document tags, project membership, artifact authors and attendance, then deletes `otherId` |
| GET / POST | `/api/project-links?projectId=` • `/api/project-links` | → `{ links[] }` • `{ projectId, source, containerId, containerName? }` → `201 { link, applied{ artifacts, tasks } }` (200 when the container moves to another project). Items already in from that container without a project join it ([03 §4.8](03_MODULE_CONTEXT_ENGINE.md#48-project-links)) |
| DELETE | `/api/project-links/:id` | → 204 |
| GET | `/api/project-links/containers?source=` | → `{ containers[] }`: `{ source, id, name, count, lastSeenAt, projectId, projectName }` from synced artifacts, imported projects and links |
| GET / POST | `/api/meetings/sessions` | → `{ sessions[] }` • `{ title?, artifactId? }` → `201 { session }`, manual meeting notes |
| GET / PATCH / DELETE | `/api/meetings/sessions/:id` | → `{ session, openTasks[], voice }` (`session.content` is the notes as a page document) • `{ title?, content?, notes? }` (at least one; nonblank title up to 200 characters; `content` is the editor's document and `notes` becomes its Markdown, while `notes` alone is Markdown made into the document) → `{ session }` • moves notes and their linked meeting-note mirror to Trash |
| GET | `/api/deleted` | → `{ items[] }`, including standalone notes as `kind: "page"` and manual meetings as `kind: "meeting"` |
| POST | `/api/deleted/restore` | `{ kind?, id? }` → `{ restored }`; owner-scoped, restores the same note identity and linked meeting-note mirrors |
| POST | `/api/deleted/empty` | Permanently removes the owner's deleted rows, including standalone notes |
| GET | `/api/meetings/imported` • `/api/meetings/notes/:id` | → `{ notes[] }` (newest 50 from meeting-notes connectors) • `{ note }`: `{ title, sourceLabel, occurredAt, summary, decisions[], actionItems[], waitingOn[], transcriptUrl, event, project, people[], tasks[] }` |
| GET / PUT / POST | `/api/skills` • `/api/skills/:id` • `PUT /api/skills/:id` • `POST /api/skills/:id/regenerate` | |
| GET / POST | `/api/agent/state` • `POST /api/agent/pause` • `POST /api/agent/resume` | |
| POST | `/api/day/replan` | |
| GET | `/api/events` | SSE stream |

### Repository execution ([docs/06](06_MODULE_WORKSPACE_AND_SURFACES.md))

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspace` | |
| POST | `/api/tasks/:id/workspace-jobs` | |
| POST | `/api/deliverables/:id/workspace-jobs` | |
| GET | `/api/workspace/jobs?taskId=\|runId=\|deliverableId=` | |
| GET | `/api/workspace/jobs/:id` | |
| GET | `/api/workspace/jobs/:id/export` | → execution, saved context, paginated events |
| POST | `/api/workspace/jobs/:id/stop` | |

### The Code tab ([docs/16](16_CODE_TAB.md))

| Method | Path | Notes |
|---|---|---|
| GET | `/api/code/runs` | → runs with changes, review progress (database only) |
| GET | `/api/code/:jobId/manifest` | → files, blob SHAs, on-disk state, decisions (ETag) |
| GET | `/api/code/:jobId/blobs?shas=` | → file versions by SHA (this run's only; immutable) |
| POST | `/api/code/folders/resolve` | `{ path }` → `{ path }`, the real path, or an error when Code may not use that folder ([docs/16](16_CODE_TAB.md)) |
| GET \| POST | `/api/code/:jobId/file` | → read / write one file (`expectedHash` guard, EOL kept) |
| POST | `/api/code/:jobId/revert-file` | |
| PUT | `/api/code/:jobId/decisions` | |
| POST | `/api/code/:jobId/restore` | |
| GET / POST | `/api/code/:jobId/scm` • `POST /api/code/:jobId/commit` | commit/push/PR — passkey session |
| GET / POST / DELETE | `/api/stepup/status` • `POST /api/stepup/{register,auth}/{options,verify}` • `DELETE /api/stepup/session` | Passkey step-up |
| GET \| PUT / POST | `/api/terminal/settings` • `POST /api/terminal/sessions` • `GET …/:id/events` (SSE) • `POST …/:id/run\|cancel` | Guarded terminal |

### The Hub assistant (§10)

Source: `apps/hub-api/src/routes/assistant.ts`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/assistant/tools` | → `{ tools }`, the Hub Action Layer catalog |
| GET / POST | `/api/assistant/conversations` | → the 40 most recent conversations; `?chats=1` → the 20 most recent dock chats (conversations with messages, not inline or comment answers) • `{ title? }` → `201 { conversation }` |
| GET | `/api/assistant/conversations/:id/messages` | → `{ conversation, messages }` |
| POST | `/api/assistant/turn` | `{ message, conversationId?, model?, tier?, reasoningEffort?, page?, mentions?, referenceContext? }` → streams the turn (SSE). The first frame is `status { conversationId }`, sent before the model call, so Stop works on a new chat. A quota miss is an `error` frame with `code: model_quota_exceeded` (429, `model`, `resetsAt`); an unreachable model host is `code: model_unreachable` (503). Neither is saved as the reply ([docs/11 §9](11_HOW_THE_ASSISTANT_WORKS.md#9-failure-modes-and-what-catches-them)) |
| POST | `/api/assistant/conversations/:id/stop` | Cancels the running turn → `204` |
| POST | `/api/assistant/apply` | `{ name, input }` or `{ calls[] }` → applies writes the write policy held as a preview (connected-app writes always). Returns `replies[]`: the saved assistant messages, rewritten so they no longer say nothing has changed. When a batch only partly lands: 200 with `partial: true` and `failed[]`; calls already saved as applied are never run again ([11 §8.2](11_HOW_THE_ASSISTANT_WORKS.md#82-connected-apps)) |

### Items in connected apps ([docs/31](31_CONNECTORS_IN_USE.md))

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/app-items/sources` | → `{ sources[{ id, name, logo, kinds[], people, comments }] }`: the connected apps Ensemble can search |
| GET | `/api/app-items/search?source=&q=&kind=&limit=` | → `{ items[{ source, kind, id, title, subtitle?, url?, updatedAt? }], errors[{ source, message }] }`; no `source` searches every connected app |
| POST | `/api/app-items/read` | `{ source, kind, id }` → `{ item }` with Markdown `text`, `facts`, `people` |
| GET | `/api/app-items/attached?taskId=\|projectId=` | → `{ items[] }` attached to that task or project |
| POST | `/api/app-items/attach` | `{ source, kind, id, taskId?, projectId? }` → `{ item }` (stored as an artifact; attaching again refreshes) |
| POST • DELETE | `/api/app-items/attached/:artifactId/refresh` • `/api/app-items/attached/:artifactId?taskId=\|projectId=` | → `{ item }` • 204 |
| POST | `/api/app-items/task` | `{ source, kind, id, projectId? }` → `{ taskId, created }` |
| POST | `/api/app-items/people` | `{ source }` → `{ seen, added, matched, skipped }` |
| GET • POST | `/api/app-items/update-target?taskId=` • `/api/app-items/update` | → `{ target \| null }` • `{ taskId, body }` → `{ source, url? }` (posts a comment on the task's issue, card or ticket) |

Verified email on hosted; per person 120 searches and reads and 60 changes per 10 minutes, people 10 per hour.

### Files ([docs/32](32_FILES.md))

Upload, list with usage, read (`/original`, `/text`), replace, spreadsheet cells, make a page, formatting profile, tags, delete, and import from apps, all under `/api/documents`. The full table is [32 §8](32_FILES.md#8-api).

Files → From your apps reads synced and attached items (`routes/context.ts`):

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/artifacts?kind=&q=&take=&exclude=uploads&before=` | → `{ artifacts[], counts[], sync[], nextCursor }`. Newest first, `take` up to 200 (60 by default). Each artifact has `origin: { app, label } \| null`. `exclude=uploads` leaves out uploaded files' text (in `counts` too); `before` is the previous page's `nextCursor` |
| GET | `/api/artifacts/:id` | → `{ artifact }` with `text`, `participants`, `authoredByMe`, `origin` and `documentId` (set for an uploaded file's text) |
| DELETE | `/api/artifacts/:id` | Owner only → 204. Soft-deletes the item and keeps later syncs from bringing it back; 409 `{ error, documentId }` for an uploaded file's text ([32 §11](32_FILES.md#11-from-your-apps)) |

### Imports ([docs/27](27_IMPORTS.md))

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/imports/sources` | → `{ sources[] }`: each app, whether it is connected, token help, file formats and export steps |
| POST | `/api/imports/preview` | JSON `{ source, credentials?, containers?, options? }` or `{ previewId, containers?, columns?, options? }`; multipart `source` + `file` (50 MB) → `{ previewId, containers[], mapping: { tables[], statuses[] }, samples[], summary }`. One preview per person, 30 minutes in memory; the upload is kept as bytes and read again at import start |
| POST | `/api/imports` | `{ previewId, containers[], statusMap?, importAs?, columns?, options? }` → `202 { job }`; one running import per person |
| GET | `/api/imports` • `/api/imports/:id` | → `{ jobs[] }` (newest 20) • `{ job }` with status, counts, progress, links, `canUndo` |
| POST | `/api/imports/:id/cancel` • `/api/imports/:id/undo` | → `{ job }`. Undo removes only what that import created |

All import routes need a verified email on the hosted site. Per person: 60 previews per 10 minutes, 30 starts and 30 undos per hour.

### Undo / redo (§11)

| Method | Path | Response |
|---|---|---|
| GET | `/api/undo` | → `{ undo[], redo[] }` |
| POST | `/api/undo` • `/api/redo` | → `{ ok, message, invalidate[], state }` |

### CLI login and hosted MCP ([docs/26](26_CLI.md))

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/cli/auth/start` | public. `{ clientName, platform, version, scopes: ("mcp"\|"runner")[] }` → `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn: 600, interval: 5 }` |
| GET | `/api/cli/auth/request?code=` | browser session. → `{ clientName, platform, version, scopes, createdAt, expiresAt, status, requestedFrom, sameNetwork }`; `requestedFrom` is the address that called `/start` (cleared once the request is decided, used or expired) and `sameNetwork` compares it with the browser's; 404 when unknown, expired or used |
| POST | `/api/cli/auth/approve` | browser session. `{ userCode, scopes, decision: "approve"\|"deny" }` → `{ ok, scopes }`; `runner` needs a verified email on the hosted site (403 `EMAIL_UNVERIFIED`) |
| POST | `/api/cli/auth/token` | public. `{ deviceCode }` → once `{ token, tokenId, scopes, account, apiBase, appUrl, pairingCode?, pairingExpiresAt? }`, else 400 `authorization_pending` \| `slow_down` \| `access_denied` \| `expired_token` |
| POST | `/api/cli/logout` | bearer `ens_` key (bridge or full). Revokes that key → 204 |
| POST | `/mcp` | bearer `ens_` key (bridge or full). Stateless Streamable HTTP MCP: the Context Bridge tools. `GET`/`DELETE` → 405 |
| DELETE | `/api/devices/self` | device key. Revokes this device ([docs/25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#43-endpoints)) |
| GET | `/api/devices/self/model-keys` | device key. → `{ shared, keys: [{ provider, secret, hint, updatedAt }] }`: the account's model keys for the computer's own model calls, or `{ shared: false, keys: [] }` when Settings → Models → *Use these keys on my computers* is off. Keys with a custom base URL are not sent |

Rate limits: `/api/cli/auth/start` 10 per 10 minutes per address (`ENSEMBLE_RATE_CLI_START_*`), `/token` 120 per minute (`ENSEMBLE_RATE_CLI_TOKEN_*`), `/request` and `/approve` together 30 per 10 minutes per user (`ENSEMBLE_RATE_CLI_APPROVE_*`), `/mcp` 240 per minute per user (`ENSEMBLE_RATE_MCP_*`).

### Sharing and presence ([docs/29](29_SHARING.md))

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sharing/people?q=` | People with an Ensemble account by name or email; masked emails |
| GET | `/api/sharing/overview` • `/api/sharing/with-me` | Everything for Settings › Sharing • what is shared with you |
| GET / POST / DELETE | `/api/sharing/contacts` • `/api/sharing/contacts/:id` | At most 5. Removing takes back everything shared with them |
| GET / POST / PATCH / DELETE | `/api/sharing/spaces/:id/members` • `…/members/:personId` | At most 2 members; viewer or editor; removing yourself leaves |
| POST | `/api/sharing/spaces/:id/transfer` | Hand a space to a member, once |
| GET / POST / PATCH / DELETE | `/api/sharing/items` • `/api/sharing/items/:id` | One item from the open space; view or edit |
| GET | `/api/sharing/open/:id` | What a share link opens, for its recipient |
| GET / POST | `/api/presence` | Who is here, and your heartbeat, cursor and view |
| GET | `/api/skills/:id` | One skill (used by a shared skill) |
| GET / POST / DELETE | `/api/links` • `/api/links/item` • `/api/links/:id` • `POST /api/links/:id/rotate` | Public links: anyone with the link, no account. Pages, tasks, diagrams, meeting notes; 5 per account ([29 §9](29_SHARING.md#9-anyone-with-the-link)) |
| GET | `/api/links/open` | What a public link opens, for whoever holds it (`x-ensemble-link` header) |

Requests from `/shared/[id]` carry `x-ensemble-share: <shareId>`; requests from `/p/[token]` carry `x-ensemble-link` and `x-ensemble-visitor`. `PATCH /api/auth/me` also takes `avatar`. Every route has a sharing class in `apps/hub-api/src/sharing/policy.ts`; unlisted routes are owner-only.

### Internal, called by agent-runtime (service-to-service)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/runs` | |
| PUT | `/api/internal/runs/:id/steps` | → fans out `run.step` over SSE |
| PATCH | `/api/internal/runs/:id` | |

---

## 7. Component inventory (build order)

1. `AppShell` (rail, header, right panel)
2. `ProposedTodoCard` + `DelegatePopover`
3. `DayTimeline`
4. `WhatChangedList`
5. `Board` (`Column`, `Lane`, `TaskCard`, DnD)
6. `TaskDrawer` (tabs)
7. `ApprovalCard` + `PreviewRenderer` (Email, PR, Teams, WorkItem)
8. `RunTimeline`
9. `ContextExplorer`
10. `SkillEditor`
11. `HelpMePanel`
12. `MetricsTiles`

The shared `PageHeader` and `PageTitleField` provide consistent headings and editable document titles. Task creation opens the document directly. The shell uses real navigation links, an icon rail at narrower desktop widths, a mobile navigation drawer, and a skip-to-content link.

**As built.** All twelve existed under `apps/hub-web/components/hub/` and `app/(hub)/`. MSW was not needed: the UI ran against the real API from the start, so there is no second, drifting mock contract to maintain. `DelegatePopover` is inline in `proposed-todo-card.tsx`; `TaskDrawer` is the Fluent Drawer in `board/page.tsx`.

---

## 8. Visual style

Fluent v9 with the **Woven Chorus identity and Deep Petrol / Satin Gold palette**, compact controls and simple page/card boundaries. No copied Notion assets or remote fonts. Important labels use readable dark red, yellow, blue, green or pink **rectangular fills**; ordinary metadata is plain text. `StatusLabel` replaces pill-shaped Fluent badges throughout the Hub. Priority always has a text label as well as colour: **Critical/red, High/amber, Medium/blue, Low/grey**, muted for the dark theme (`PriorityTag` in `components/ui.tsx`, `--prio-*` variables).

**Appearance:** *Settings → Account → Appearance* separates **Mode** (Light, Dark, System; Dark by default), **Color theme**, and **Accent**. The avatar menu offers an Appearance shortcut and a quick light/dark switch. Seven color themes are available: **Ensemble · Deep Petrol**, **Smoked Aubergine**, neutral **Graphite**, sea-glass **Lagoon**, lavender **Aurora**, sage **Juniper**, and blue **Blueprint**. Every theme has coordinated light and dark palettes. The keyboard-selectable radio cards show both modes with the user's current accent (`components/settings/color-theme-picker.tsx`). Choosing a palette preserves mode, preset/custom accent, font, text size and motion. Reset appearance restores Deep Petrol, Satin Gold and Expressive motion. The Code/plot editor's VS Code theme picker remains a separate setting.

`lib/color-themes.ts` is the palette source for both previews and the static root CSS injected by `app/layout.tsx`. Surface, text, border, shadow and diagram tokens inherit throughout the shell, cards and portalled Fluent menus/dialogs. The Hub main canvas (`data-theme-canvas`) adds restrained, static backgrounds: original SVG wave contours, botanical strokes and drafting marks under `public/themes/`, and two soft CSS gradients for Aurora. These sit behind the content; Graphite and Ensemble have plain canvases. The three SVG paths are anonymously available decorative assets. Canvas-based Context and plots repaint on `data-color-theme` changes without resetting their view or data.

`appearance.colorTheme` in the existing settings JSON defaults to `ensemble` for older accounts. Color theme and accent follow the active space's server settings (`components/shell/notifier.tsx`); browser mode, typography and motion stay local. All appearance choices are cached in `localStorage` and synchronized between tabs. Middleware reads the authenticated `/api/auth/me` appearance summary and sets `ensemble_color_theme` alongside `ensemble_accent`. Both cookies carry the settings timestamp; the inline boot script and hydration use the newer cookie or browser choice so a fresh browser paints the saved palette before hydration. No database migration or remote font is needed. Accent contrast is checked against all five surfaces in every palette, with lightness adjusted for readability while retaining the preset/custom choice.

**Checked 13 Oct 2026:** `lib/color-themes.test.ts` verifies foreground/muted/secondary text contrast of at least 4.5:1 in all ten new palettes, preset and extreme custom accents, legacy defaults and cookie precedence. `e2e/color-themes.mjs`, against an isolated local PGlite API and production Hub build, checked all twelve theme/mode combinations, account persistence, fresh-browser first paint, custom accents, keyboard selection, system switching, the account-menu mode switch, cross-tab updates, core routes, mobile fit and reset without writing work data. The slowest measured two-frame palette paint was 25 ms, within the 200 ms warm interaction budget.

**Speed:** changing one root attribute switches the palette without refetching data or rebuilding the card tree. Fluent transition durations are zero so theme and source-selection changes do not fade through unreadable intermediate colours. Dialogs and drawers also opt out of Fluent's JavaScript surface/backdrop motion, so opening or closing them does not wait for a fade or slide. No animation library or remote font was added. Help answers load the existing markdown renderer lazily and parse only after streaming finishes. Long boards scroll inside a bounded work area rather than squeezing every column narrower. Next's development indicator is disabled with `devIndicators: false`; application errors remain visible.

**Browser coverage:** `pnpm verify:ui` checks the pages in light/dark and narrow layouts, plus isolated creation/retry/pagination/drag flows, theme persistence, cross-tab and system changes, keyboard-selectable context, per-task state isolation, and source-text contrast of at least 4.5:1. Warm theme/source interactions have a **200 ms paint budget** in this local browser check.

---

## 9. Acceptance criteria (P0)

- [ ] Open Hub → Today page populated from real ingested data within 3 s (cached briefing).
- [ ] Triage 6 proposed todos with keyboard only in < 60 s.
- [ ] Delegated task visibly progresses through steps without refresh.
- [ ] Approval card previews an email exactly as it will be sent; *Edit & approve* sends the edited version and logs both.
- [ ] Run page shows every tool call with inputs/outputs and the approval that authorised the write.
- [ ] "Help me" from a task streams an answer that references ≥ 2 context items without the user typing them.

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

### Notes from the earlier prototype

These measurements and file names come from an earlier prototype. They describe how each criterion was met there; most of the files named are not in this tree.

| Criterion | Verified | Notes |
|---|---|---|
| Today ≤ 3 s | 1.4 s warm | Briefing cached in Redis (`ensemble:briefing:<user>`, 300 s). Any task/approval mutation drops the cache via an `onResponse` hook in `server.ts`, so a triaged todo cannot reappear. |
| 6 todos, keyboard, < 60 s | 3.6 s | `lib/use-keyboard-triage.ts`. All mutable state lives in refs with a single `keydown` listener — an earlier version re-registered the listener per render and applied decisions to the previous card. Decided ids are never pruned mid-session, because an optimistic removal plus a background refetch can briefly resurrect a card. |
| Live step progress, no reload | 5 distinct states | agent-runtime reports each step to `PUT /api/internal/runs/:id/steps`; hub-api persists and fans out over SSE. Board cards render the step list inline. |
| Email preview + Edit & approve | ✓ | `preview-renderer.tsx` renders the exact payload and doubles as the editor. Ledger stores `input_hash` (original) and `output_hash` (edited) — verified to differ — and the diff is written to `metric_events` as a Skill Forge signal. |
| Run trace | ✓ | Every tool call shows `server.tool`, risk, inputs and outputs. Writes display *authorised by <approval title> (<decision>)*; un-approved writes show *waiting for approval — not executed*. |
| Help me, zero typing | 4 items cited | Context pack built on panel open and shown as removable chips. Falls back to a grounded, citing summary when no model credential is present, so the behaviour is demonstrable before Copilot auth. |

**Data sources:** Settings → Connections shows five featured connectors (Google Workspace, Microsoft 365, Notion, Linear, GitHub); every other app, including Slack, Jira and the remote MCP servers, is in **Browse connectors** ([§3.9](#39-settings), [18](18_WHAT_IS_REAL.md#connectors-read-only)). Every catalog entry can be connected ([31](31_CONNECTORS_IN_USE.md)). The sidebar counts actual ready sources. Sample data is opt-in ([docs/03 §11](03_MODULE_CONTEXT_ENGINE.md#11-seed-data-opt-in-only)). Azure DevOps connects for search and updates only; it is not synced.

---

## 10. The Hub assistant

A round launcher (`components/assistant/ask-launcher.tsx`) that expands into a panel. It starts bottom-right and can be dragged anywhere along the bottom or right edge of the content column, never over the sidebar or top bar; it snaps to the nearer edge and the spot is saved in the browser (`ensemble.assistant.launcher`). Arrow keys move it when focused. It stays mounted while the panel or a task is open and is only hidden, so closing a task does not slide it in from the corner; it moves with an animation only for those arrow keys. The shortcut (Command-J by default, configurable in Settings → Shortcuts) still opens it; the launcher no longer prints the shortcut. In the panel, the message box grows with what is typed (Shift+Enter for a new line) up to eight lines and then scrolls (`lib/auto-grow.ts`). The clock button left of **New chat** lists the 20 most recent chats (`GET /api/assistant/conversations?chats=1`) and opens one. When a turn changes something (a task created, a page edited), the dock refetches what the rest of the app shows at once (`refreshAfterAssistantWrite` in `lib/assistant-apply.ts`), so the board has the new task without a reload even when the live stream is down. It is **the only chat surface in Ensemble**, and it is deliberately **not** the front door: the board, the briefing and the approvals queue are. Chat is for the things a board cannot express — *"add todos from today's meeting and update this week's deliverables"* — and for reaching the parts of the tenant no page exposes.

### 10.1 The Hub Action Layer

The assistant does not describe work; it does it. It does so **without driving a browser and without a line of the Hub changing**, because the Hub already has a vocabulary for everything it can do — its own domain operations — and the assistant is given a typed catalog of them.

```text
engineer ──► POST /api/assistant/turn ──► hub-api builds the turn
                                           (system prompt + live Hub state + tool catalog)
                                                   │
                                                   ▼
                                  agent-runtime  POST /api/chat/tools
                                  (owns the model credential and the approved set, nothing else)
                                                   │  tool calls
                                                   ▼
                              hub-api validates → gates → runs the tool → journals undo
                              → publishes SSE invalidation → writes the ledger
```

The full walkthrough is in [docs/11](11_HOW_THE_ASSISTANT_WORKS.md).

Typing `@` in the assistant's box opens the same @ menu as pages ([§13 Blocks and mentions](#blocks-and-mentions)). `@anik` then Enter writes `@people:Anika Rao`, and the turn carries that person's ID.

---

## 11. Undo / redo

Two things in Ensemble move faster than the engineer can check them: keyboard triage, where one keystroke decides a todo, and the assistant, which can rewrite six rows while the transcript is still streaming. Both need a way back that does not require first working out what happened.

Every reversible mutation, **whoever made it**, appends to a per-engineer journal. In a shared space each person has their own journal there, so you only ever undo your own changes ([29](29_SHARING.md#3-what-stays-private-and-how)). The buttons sit in the app bar; **Ctrl+Z / Ctrl+Shift+Z** work anywhere except inside a text field, which owns its own undo.

- **Ten deep.** The span within which "that was wrong" is still a reaction rather than an investigation, and enough to walk back a whole assistant turn that touched several rows.
- **Server-side.** A browser-local history would not contain the rows the agent changed while the tab was on another page, which is the case the feature exists for.
- **Snapshots, not handlers.** An entry stores the row values before and after. A journal that can only be replayed by the code that wrote it stops being replayable the moment that code is refactored.
- **One entry per intent.** Applying a meeting is one action to the engineer and seven rows to the database; undo matches the engineer's unit.
- **Minimal payloads.** An update records only the fields that moved, so undo cannot silently revert something another part of the system changed in between.

**What is deliberately absent:** anything that left the building. Those are gated by approval precisely because they cannot be taken back, and a button that appears to undo them but does not would be worse than no button.

### 11.1 What is journalled

| Area | Covered |
|---|---|
| Tasks | create, edit, move, triage, assign, pin to Today |
| Deliverables | add, edit, complete/reopen, delete |
| Projects | create, edit |
| Context | delete a person, project, repo or preference — *and the suppression that delete writes*; track a repo; corrections |
| Assistant | everything above, when the assistant is the one doing it |

Two that are deliberately **out**:

- **Skills.** A skill is a versioned `SKILL.md` with its own history and `skill_versions` rows; undo would be a second, worse version of a mechanism that already exists.
- **Delegated agent work.** Once a run is executing, "undo" would mean asking a model to reverse itself — tokens spent to produce an apology. Stop it instead (§12); what it already wrote is journalled row by row and can be walked back individually.

Undoing a context delete **restores the row and lifts the suppression**. Doing only the first would put the card back and leave the next fetch under standing orders never to recreate it — a half-undo that looks complete until the afternoon.

---

## 12. Live agent activity and the stop button

The app bar used to read *Agent: Ready* whenever no Run row was open. That was true and useless: a Hub-assistant turn spending credits for ninety seconds is not a run, so it showed as Ready, and the only way to stop it was to close the tab.

Both processes now register every call that costs money or time in **one shared Redis registry** — hub-api for assistant turns and fetches, agent-runtime for delegated runs. In-memory would have shown half the truth and called it a status.

### 12.1 One word, and a queue behind it

| State | Meaning |
|---|---|
| **Idle** | Nothing in flight. |
| **Working** | A model or agent call is running. |
| **Queued** *(label inferred)* | Work is waiting for the runtime to pick it up. |
| **Stopping** | Stop requested; waiting for calls to acknowledge. |
| **Paused** | Nothing new will start, and everything in flight was interrupted. |
| **Error** | The agent runtime is not answering. |

Clicking it opens a panel listing what is actually running — kind, model, the tool currently executing, how long it has been going — with an interrupt on each row and a **Stop everything** above them.

### 12.2 Pause is a kill switch

It used to set a flag that stopped new work being picked up, leaving anything already running to finish. Pressing it mid-run did nothing visible for a minute and then produced the draft anyway.

It now flags **every in-flight call** as well. The executor has always accepted an `is_paused` hook and nothing ever passed one; it does now, and the assistant loop checks between every step and between every tool in a step, so a turn told to stop does not carry on running the other five writes the model asked for in the same breath.

### 12.3 Cancellation, and what it cannot undo

Model entry points share a **cancellable three-request limiter**. Stop aborts the provider request instead of merely waiting for another tool boundary. Workspace commands run under tracked process/container identities and are terminated on stop; a checkout stays reserved until cleanup is confirmed. The whole worker service is not killed.

An already-received provider/GitHub request may still complete or be billed. The UI says *Stopping* until acknowledgement, and **Resume never clears an older in-flight call's stop flag**. Paused queued work stays durable; review and blocked work make no model calls. See [docs/06 A5](06_MODULE_WORKSPACE_AND_SURFACES.md#a5-durable-queue-and-global-stop).

A stopped turn **keeps and labels its partial work** — *"Stopped. I had already done: …"* — rather than discarding it. Work that was done is still worth reporting; silently returning it as though the turn had finished would misrepresent what happened.

Entries carry a **heartbeat** and stale ones are reaped on every read, so a process killed mid-call cannot leave the bar reading *Working* for ever.

---

## 13. Document-style pages

Task pages are **documents**, not a second chat or a large edit form. This supersedes the earlier task-local *Help me* panel described above. The floating Ensemble assistant is the conversation surface; it receives the open task ID from both a board peek and a standalone page. Non-modal peeks sit below the assistant, while assignment and unsaved-change confirmations remain modal.

### Creation and properties

**New task** creates an untitled document immediately, as described in §3.2. Complexity remains inferred. Owner, complexity, repository, and other document properties can be changed on the saved task page. Assigning ownership alone never authorizes execution; **Run with agent** confirms the execution, model, review, and delivery choices.

The title and description look like editable text. Properties are quiet values with a chooser only when clicked. Owner and execution controls are at the top; repository, deliverable and explicit skills remain available under related properties. Existing resize, full-width, full-page, lifecycle, focus, source, question and run-history controls are retained.

### Standalone notes

A note that belongs to no task is a `task_pages` row with a null `task_id` (migration `20261004180000_standalone_pages`). The sidebar lists them, and `/pages/[id]` opens one in the same block editor, with the same revision check as a task page. Saves and renames lock the row first (`apps/hub-api/src/pages/store.ts`), so two tabs saving the same revision get one save and one `409`. `search_text` is rewritten on every save and filled in for older rows by a batched pass that starts after the API is listening, so context search finds a note by its body. A standalone note never appears as a task, project or deliverable. *Delete everything* removes them, and the Context Bridge's `ensemble_read` returns the note body. Routes are in §6.

**Delete and recovery.** `DELETE /api/pages/:id` sets `TaskPage.deletedAt` (migration `20261009073000_note_trash`). The note leaves navigation, search, sharing and normal read/write routes while its document, mentions and discussions remain intact. Deletion moves the note to Trash immediately without a confirmation dialog, after pending editor saves finish. The deletion toast offers Undo; `/trash` and Settings → Data → Trash restore it through `/api/deleted/restore` with `kind: "page"`. The current daily retention job (`apps/hub-api/src/jobs/retention.ts`) permanently removes standalone notes after `retentionDays`; Empty trash removes them immediately. Restore only accepts standalone pages, so it cannot detach or restore a task document through the page kind.

**Manual meeting notes.** `/meetings` uses `components/meetings/notes-fields.tsx` for editable titles and notes. Since 13 Oct 2026 the notes are a page: the same block editor as task pages and notes (`/` for blocks, `@` to mention people, tasks, files, diagrams and the rest, `@ensemble …` and Enter to ask in place), without comments (`BlockEditor` `comments={false}` mounts only `InlineEnsemble` from `components/comments/inline-ensemble.tsx`). The document is stored in `meeting_sessions.content` and its Markdown in `notes` (`meetingNotesFields` in `cowork/service.ts`), which search, recaps, the mirror note, exports and the assistant keep reading. Notes typed before then open as a page made from their text. Inline answers are page discussions with page kind `meeting` (`routes/comments.ts`). When the assistant changes the notes while they are open and nothing is waiting to save, the editor takes the new version in place. Writes serialize per session, including across rapid SPA reopenings, after a 600 ms pause. They flush on blur and SPA navigation, update the detail cache, and show Saving/Saved or an error with Retry save. Failed drafts remain in browser memory across SPA navigation and retry on reopening the authorized session; a full reload does not persist that memory. Closing/reloading with outstanding writes prompts before leaving. Delete notes confirms a move to Trash and offers Undo. Restore also restores a mirror deleted with that meeting. The UI states that microphone recording is unavailable; these are keyboard notes. No model is needed for editing, deleting or restoring them.

**Pages sits directly below Today and can collapse.** The add action remains available while collapsed. Navigation selections use neutral backgrounds rather than colored ribbons; the shell and desk tiles have smaller corners, flat surfaces, and no decorative title dots or accent washes. Accent remains on focus controls, primary actions, and meaningful states. Static Hub UI copy uses simpler punctuation rather than em dashes.

**Add to board** on a note, or **Add page** on the board, links the existing page row to a newly created To do task. **Convert to page** detaches a task's document and moves the old task to Trash, preserving its properties and execution history there. The page keeps its identity, title, document, mentions, annotations, discussions, and diagram links; inline answers are retargeted to the new page/task address. Converting the note back creates a new task, not a restoration of the archived task's properties. Conversion saves pending content first, rejects stale revisions, and is blocked while an inline answer or agent work is active. It deliberately does not add a task-creation Undo entry that could delete the retained document.

The editor tracks an inline request from the moment it starts, before its first server frame. Comment/reply creation and conversion also share a database row lock and recheck ownership/type before writing, so another tab cannot start a reply against a page midway through conversion.

### Focus mode

A task's own page (`/tasks/[id]`, not the side peek) and a standalone note, shared and public-link copies included, have a **Focus mode** button next to Export and Share (`components/pages/page-focus.tsx`). The title and the page body fill the screen at a reading width (780 px, wider when comments sit in the margin) under one line with the save state and **Exit focus mode**. Properties, page actions, the sidebar, the top bar and the assistant are out of sight and inert. The editor is the same one, so it keeps its cursor and undo history, stays read-only for view-only access, and the file cards in it keep working. **Esc** leaves once an open slash or mention menu has had it. **Alt+Shift+Z** toggles focus mode (`page-focus` in `packages/shared-types/src/shortcuts.ts`, listed under Pages in the shortcut help). It uses the same full-screen helper as the Graph and Files (§3.5).

### Blocks and mentions

The shared, lazily loaded **TipTap** editor supports:

| Command | Inserts |
|---|---|
| `/text` | Paragraph |
| `/h1`, `/h2`, `/h3` | Heading levels 1–3 |
| `/bullet-list` | Bulleted list |
| `/list` | Numbered list |
| `/check-list` | Interactive checklist |
| `/code` | Plain code block, without language-specific highlighting |
| `/table` | A 2 × 2 table with a header row |
| `/file` | Upload a file, choose one from Files, or add one from your apps; it lands as a file card |

**Tables grow from the edge that grows them.** Hovering a table puts a **+** on its right edge and another under its bottom edge: the right one adds a column, the bottom one adds a row, and neither can be ambiguous about which because of where it sits. Columns are resizable by dragging a cell border, and cells carry their alignment.

The controls are an **overlay rather than a node view**. `resizable: true` installs ProseMirror's column-resizing plugin, which owns the table's DOM — it writes the `colgroup` and the drag handles — and a node view competing for the same element is how resizing quietly stops working. The overlay tracks the pointer with a ~26 px reach beyond the table, because a hover zone that stopped at the border would drop the buttons the moment the pointer set off towards one.

Tables round-trip to GitHub-flavoured pipe tables in the Markdown that notes, retrieval and the Context Bridge read, alignment included. Cell text is flattened to one line on the way out: a pipe table cannot express a line break, and emitting one would break every row after it.

Typing **/** opens a filtered menu. Arrows select, Enter or Tab inserts, and Escape dismisses it. Standard Markdown shortcuts and bold, italic and inline code also work. **Slash commands and mentions do not activate inside code.**

**@** works the same in pages and in the plain text boxes that take mentions (the assistant, comments, quick capture). One file holds the rules: `apps/hub-web/lib/mentions/menu.ts`.

- `@` alone lists the groups, each with its prefix: People · `@people:`, projects, repositories, tasks/todos, deliverables, skills, diagrams, plots, files and dates. Pages also offer **Ask Ensemble** first. Diagrams and plots follow their module gates.
- `@people` or `@people:` shows only people. Singular, plural and other names work too (`person`, `projects`, `todo`, `repository`, `data`, `attachment`). Picking a group row writes its prefix. `@people:mi`, `@diagram:transformer` and `@file:report` search inside the group.
- Plots nest: `@plots:` offers plot spaces, a Saved plots group and uploaded data files; picking a space drills into its tiles. `@plot:epochs` and `@plots:epochs` both find a matching file.
- Anything else, like `@anik`, searches every kind, at most 10 rows, each showing its kind ("Person", "Diagram"). Rows are ranked: exact name, then name starts with, then a word starts with, then contains. People also match on their email, below name matches. Ties go people, projects, tasks, deliverables, files, diagrams, plots, data files, repositories, skills. Mail senders that look automated (no space and no capital letter, an `_` or `@`, or a single word like `support` or `noreply`) come after real names that match as well; nothing is hidden. The best match is first, so Enter picks it.

In a page the pick becomes a chip that shows `@Label`. Entity mentions retain their **kind and stable ID**, not just a display string. Date mentions do **not** change a task's due date. A mention alone is not an instruction to change a task's project, owner, or skills.

**@ in plain text boxes** (`components/mentions/mention-menu.tsx`). A pick writes the mention as text, `@people:Anika Rao `, and remembers its ID. Picking a group writes `@people:` and keeps the menu open. After a prefix the name may have spaces while the menu is open, so `@people:Anika R` still searches. Up and down move, Enter or Tab picks, Escape closes; Enter sends or saves only when the menu is closed. On send, the box passes the IDs of the picked mentions still in the text:

- The assistant sends them with the turn as `mentions` ([11 §4.1](11_HOW_THE_ASSISTANT_WORKS.md#41-the-browser-opens-a-stream)).
- New comments and page comments save them on the comment; the Ask Ensemble box under a comment sends them with the question. Editing a comment uses the menu too.
- Quick capture sends plain names (`@people:Priya Shah` goes as `Priya Shah`), because capture finds people in plain text.

The search bar at the top is a search box and has no @ menu.

**Files in pages.** Picking a file after `@` (`@files:` searches only files), `/file`, or dropping or pasting files into the editor inserts a file card (`components/files/file-embed.tsx`, `components/editor/file-attach.ts`). Dropped and pasted files upload to Files first, so every attachment is a stored file that agents can fetch. A card shows a compact preview (320 px tall by default, resizable from its bottom edge) with the file's name, type, **Open** and, on a page you can edit, **×** to take it off the page (the file stays in Files). Shared pages and public links preview the files they mention. A page converted from a PDF or Word file shows "Made from report.pdf" (`components/files/source-file-banner.tsx`) with **Export back as PDF/Word**, also in the page's Download menu under "With the original's formatting" ([32 §6](32_FILES.md#6-pages)).

Project and deliverable note editors reuse the same blocks while retaining their existing Markdown persistence contracts. Encoded `ensemble://` mention links round-trip back into mentions when Markdown notes are opened.

**Pasting Markdown gives blocks, not a slab.** Plain-text paste used to land verbatim, so a pasted `.md` file arrived as one grey block in which `## Aim` was literally those characters and a checklist was a run of hyphens. A paste whose text carries block-level Markdown is now parsed the same way saved notes are: headings, bulleted and numbered lists, checklists with their checked state, quotes, fenced code, rules, and the inline bold/italic/strike/code/link marks.

Two limits are handled explicitly rather than left to fail:

- The schema stops at heading level 3, so deeper headings are **demoted to level 3**. They stay headings instead of collapsing into body text.
- A pasted Markdown table becomes a real table, with its header row and alignment. (It was briefly kept verbatim in a code block, when pages had no table node; they have one now.)

Conversion is deliberately **conservative**. It needs at least two block-level markers, so prose that merely contains "1." stays exactly as typed — reformatting a paste nobody asked to reformat is worse than not formatting it. Anything the page schema would reject is dropped before it reaches the document, because one unsupported node would otherwise put the whole page into "cannot be saved" and block edits made before the paste. The paste replaces the selection and lands in a single undo step.

### Saving and concurrent edits

Task properties and content save after a short typing pause. **Ctrl+S** saves immediately. Writes are **serialized**: a response for an earlier snapshot never replaces keystrokes typed while it was in flight. HTTP failures and version conflicts leave the draft visible and offer retry or an explicit discard/reload. Leaving with an unsaved draft is guarded; an in-flight save must finish before the peek can be discarded. **Simply opening an editor is never a write.**

The task document endpoint is `GET/PUT /api/tasks/:id/page`; it carries a revision, document, legacy Markdown notes, resolved mentions and run annotations. Writes check the expected revision and notes. The board still receives small task summaries, not document bodies. The @ menu's suggestions come from `GET /api/entities`, scoped to the space ([03](03_MODULE_CONTEXT_ENGINE.md)).

`content` is omitted on annotation-only saves. Those saves preserve task notes byte-for-byte, including legacy Markdown formatting, and do not change a live run's instructions or task timestamp. Explicit body edits still compare their original notes snapshot and honour workspace locks. The additive `20260919190000_task_pages` migration stores documents, annotations and normalized mention identities; page edits participate in the existing transactional undo journal.

Notes written through the assistant or older clients are detected rather than silently overwritten by a stale rich-text copy. The existing task-note context mirror remains the compatibility path. Run annotations stay separate from the original agent result and do not silently change a running agent's input.

### Agent output and human notes

Actual final responses are shown as page text. **Add your note here** inserts an editable, subtly tinted human block between output sections. Each annotation retains its original run/workspace source, output identity and section anchor. Old annotations remain accessible after a new attempt or changed result; **the recorded agent response and execution evidence are never rewritten**.

**Request changes** and **Redo with another model** prepare a new attempt using the approved-model selector and the existing assignment flow. The engineer can include their annotations and the previous response, or redo from the task's current context. Inputs exceeding the assignment limit are reported, never silently truncated. Execution and publishing still require the normal explicit assignment/review choices. No unsupported reasoning-effort control is shown.

Files, checks, context and execution controls are collapsed behind the result; previous attempts and their editors are loaded only when expanded. Immutable Markdown sections are memoized so typing in a human note does not repeatedly parse the agent's entire answer.

#### Verification

The focused browser check intercepts every API request with synthetic data. It does not run a model, sync connectors, publish code, or modify real tasks:

```powershell
uv run --project apps\agent-runtime --no-sync python apps\hub-web\scripts\verify-document-ui.py
pnpm --filter @ensemble/shared-types exec vitest run src\page-content.test.ts
```

It checks inline creation, failure recovery, all block and mention categories, keyboard completion, save/reload, in-flight typing, conflict preservation, annotation attribution, revision/model payloads, floating-assistant task context, mobile overflow and a sub-200 ms input-to-paint budget on a substantial document. The existing isolated interaction suite also covers board order, resizing, themes, Today, approvals and native/sandbox assignment with the new page UI.

### Selection comments and inline questions

Select text in task notes, project notes, deliverables or agent output to reveal **Comment on selection**. Comments are saved separately from the document and original agent result. Their editor supports plain paragraphs and linked @mentions, but not slash-command blocks. Existing comments can be reopened, edited, resolved and restored from the compact *Comments* disclosure. Editable text shows a quiet highlight for open comments. Anchors retain the selected quote and surrounding text, follow unambiguous moves, and report changed or ambiguous original text rather than silently attaching to a different passage.

Select **Ask Ensemble** from the `@` menu, or type `@ensemble`, write a request, and press **Enter**. Enter selects a file from an active mention menu before it can send the request; Shift+Enter remains a line break. Requests work in standalone pages and task documents, not code blocks. **Typing, autosaving, reopening, refreshing and expanding a previous answer never start a model request.** The live document and typed mention IDs travel with the request, so a save debounce does not hide the newest page content.

Inline answers use the configured assistant default tier. They run the normal tool loop with user-scoped task/context retrieval. Page context is bounded to 24,000 characters; additional account context is read through tools rather than copying the entire database into a prompt. **New diagrams and plots requested inline are created immediately and attached below the answer.** Allowed-write areas and module gates still apply, and all other writes retain the configured immediate/preview/Needs me policy and show Apply when held. Dataset mentions are read through `hub_get_dataset` before plotting; the renderer uses the complete stored table. Attachments persist as document mentions, are inserted once per successful tool call, and are not re-added after removal. Plot embeds show real charts at chart/tile proportions, with compact and remove controls; Backspace also removes the mention, not the saved plot or dataset. Plot and diagram embeds always take the page width and have a resize bar along the bottom edge (`components/editor/embed-resize.ts`): drag it, or focus it and use the up and down arrows. Heights run from 160 px to 1,400 px and are saved on the mention as `height`, so they survive reload; a diagram with no saved height fits its drawing (up to 560 px) and has a *Fit* button.

A comment containing `@ensemble` is sent with Enter and receives an attributed Ensemble reply in that comment. There is **no human reply composer**: the engineer can edit/resolve the original comment, but only the assistant writes its answer. Comments on editable and immutable result text carry a muted orange highlight; ambiguous or removed text leaves the original quote accessible in *Comments*.

The floating assistant uses the same @ menu (see Blocks and mentions above). A **From your apps** link under the message box (shown when an app Ensemble can search is connected; `components/app-items/add-to-message.tsx`) picks an item and adds `From Notion: “Q4 plan” <url>` to the message; the assistant reads it with `apps_read` ([11 §8.2](11_HOW_THE_ASSISTANT_WORKS.md#82-connected-apps)). Alongside the text, it sends the picked mentions as **kind/ID references**; a `@kind:name` token sent without an ID is resolved on the server by exact name in this space ([11 §4.1](11_HOW_THE_ASSISTANT_WORKS.md#41-the-browser-opens-a-stream)). The IDs go into the tool loop *as data, not additional authority*. Two projects with similar names remain distinguishable.

The additive `20260920123000_page_discussions` migration stores discussion anchors, body, version, answer, model, tool calls and conversation identity.

`GET/POST /api/page-discussions`, `PATCH /api/page-discussions/:id` and `POST /api/page-discussions/:id/ask` check the owning task/project/deliverable and execution source. Writes never modify the quoted agent output. Optimistic versions protect edits; **caller-generated request IDs** prevent a network retry from repeating an action. No model runs on GET or save. Stale interrupted asks are marked failed, not automatically replayed; a bounded heartbeat fences the in-flight assistant. Discussion storage and transient dialogs are loaded only for opened editors/results, not for board cards.

Focused synthetic browser validation:

```powershell
uv run --project apps\agent-runtime --no-sync python apps\hub-web\scripts\verify-page-interactions-ui.py
pnpm --filter @ensemble/shared-types exec vitest run src\page-discussions.test.ts
```

#### Grounding, final answers and autosave

Inline questions now receive the original task description, saved assignment instructions, actual recorded agent responses and human annotations. A question inside an annotation is grounded in the run/workspace output that annotation belongs to, not only the tiny note containing the question. The floating assistant also receives the open task's page context. Long pages are bounded in the initial prompt with a typed `hub_read_task_page(taskId, offset, limit)` reader. **IDs are exact lookup keys, never full-text search phrases.**

The assistant **reserves its last allowed model request for a real, tools-disabled answer**. A missing final answer is an explicit failure, not a successful-looking list of "Read 5 tasks" receipts. Tool activity remains separately inspectable.

Project and deliverable notes now share serialized debounced autosave with task pages. Responses cannot replace keystrokes made during an earlier save. Version conflicts retain the draft. Enter-to-send inline questions flush pending page and annotation edits first, so a newly added note exists before its request is stored.

Irreversible operations, model sends, uploads and approvals remain explicit actions; **autosave does not execute them**.

### Context graph

*Context → Graph* presents real stored people/project/repository/task/deliverable/skill/note relationships and page mentions. The overview is bounded and **labels truncation** rather than claiming every database row is visible. Selecting a project/person/task focuses its connected neighbourhood; type filters, zoom, scroll-to-pan, temporary node positioning and direct page links aid inspection. Completed tasks and deliverables are hidden by default, with at most five recent items when enabled. **Reminders never enter this graph or context retrieval.** Dragging graph nodes changes only the local layout, not stored relationships. Opening an item synced or attached from an app goes to it in Files → From your apps.

Readability (`apps/hub-web/lib/graph-readability.ts`): each node's collision zone is sized from its label box, the camera fits the whole graph on open, and lower-priority labels that would overlap are hidden until you zoom in or select. The fit and every manual zoom share one floor (`MIN_ZOOM` in `components/context/graph.tsx`). In development only, `?graphScale=3` repeats the current graph (capped at 6) and `?graphFixture=seed` forces the seed sample (`lib/graph-fixture.ts`); `next.config.ts` swaps that module for an empty stub in production builds.

### Model presets and capability discovery

*Settings → Assistant → Models* ("Which model each tier uses") defines Low, Medium, High and Max profiles (`components/settings/models.tsx`). Each tier has a provider menu that shows which providers have a key (yours, your account's on a paired computer, the server's), a model picker (`ModelPicker` in `components/settings/model-picker.tsx`: the provider's list for your key, searchable, cheapest first, each model with its thinking range, arrow keys and Enter, and "Use ‹name›" for a model not in the list), and the thinking levels that model takes as buttons (`ThinkingPicker`), with where the levels come from underneath. Picking a model or provider that does not take the tier's level sets it back to Default; a saved level the model does not take is flagged in amber. The lists are stored a week (§ docs/01 §6); **Refresh model lists** beside the heading, and in the keys dialog, asks each provider with a key now. Before 13 Oct 2026 the model was a browser datalist, the thinking choice a fixed Minimal/Low/Medium/High menu whatever the model, and Minimal was dropped for Claude without saying so. The floating assistant selects a preset and shows its configured model; custom per-run overrides are confined to assignment. Inline `@ensemble` uses Low. Saved overrides propagate to the runtime request, not just the UI label. **Unsupported combinations fail before inference.**

The Copilot model list gives each model's reasoning choices and no selectable context tiers. The UI offers **no context-size control**: it reports the model's single context window as read-only information and nothing more. Showing a permanently disabled dropdown was the earlier behaviour, and a control that can never move reads as a bug rather than a limit. Model availability and capabilities may change after refresh. Unknown billing rates remain unknown; the app does not invent a per-request charge for newly discovered models.

### Board card layout, loading and model icons

- Board cards show a **single trash button** on hover, where the drag grip otherwise appears; the whole card drags. It reserves horizontal space without forcing short titles to the height of two buttons. Agent-output insertion controls are hidden until their local section is hovered or keyboard-focused; touch devices keep them discoverable.
- Columns retain **at least 300 px** of usable card width and scroll horizontally rather than crushing long titles. Card heights stay flexible, with typography following the user's appearance preferences and drag/delete controls in a single keyboard-accessible rail.
- Fetch/agent/run progress uses the shared `BrandMorph`, `ThinkingStatus`, `RunMark` and `Spinner` components, driven by actual request/activity state. The shared SVG controller never delays the result and respects reduced motion.
- `ModelIcon` / `ModelSignature` use locally bundled, MIT-attributed provider icons for OpenAI, Gemini, Claude, Microsoft MAI and Copilot/Auto families. Unknown names retain neutral attribution; icon recognition does not enable unsupported models or alter routing. Requested workspace models remain labelled as *requested*, not confused with the provider that actually produced the reply.

---

## 14. Private reminders

Reminders have **no page** and never become artifacts, context-graph nodes, embeddings, fetch inputs or MCP context. The title supports stable @ mentions, but those links do not turn the reminder into a retrieval source. Date is required; time is optional. Existing title/date/time edits autosave with revision protection. Creation, Snooze, Dismiss and Delete are explicit actions.

The host scheduler works **with the browser closed** while the Hub API and Windows session remain running and awake. Enable Windows reminders once in Settings: this creates a per-user Start Menu identity for native notifications, not a Windows service or recurring OS task. Native notices use the system notification sound and remain subject to Windows notification/Focus Assist settings.

- **Date-only:** first notice at 09:00 in the reminder's saved timezone.
- **Timed:** first notice 30 minutes before the selected time.
- **Quiet hours:** no delivery from 22:00 until 09:00, including overdue notices.
- **Snooze:** fixed 15 minutes; snoozing future work never brings its notice forward.
- **Unacknowledged reminders repeat** at that interval outside quiet hours. Swiping away a Windows toast only hides the current notice; *Dismiss* or *Delete* stops the reminder.
- **Native Snooze/Dismiss buttons** open Today and apply a one-use, user-bound authenticated action. The token travels in a URL fragment and is then removed.

Windows 11 collapses toast buttons into the banner: they appear on hover, or after expanding the notice in Action Center. That is OS behaviour, not a missing action.

**The delivery check may only veto on an answer it received.** The sender asks `ToastNotifier.Setting` whether Windows will show a notice. Windows PowerShell 5.1 does not project that WinRT enum on every build — on this host it reads back as `$null` even for `Microsoft.Windows.Explorer`, whose notifications plainly work. Calling `ToString()` on the null threw, the sender exited non-zero, and every reminder was recorded as *"Windows could not deliver this reminder. Check notification settings"* while Windows was willing to deliver it and the settings being blamed were already correct. An engineer following that message has nowhere to go.

So the guard now reads the setting defensively and **blocks only on a value it actually got**; an unreadable setting is not evidence of anything. Failures also report a reason — the **exception type, never its message**, because a message can quote the toast XML and with it the reminder's private title — so a genuine refusal says *Windows has notifications turned off for Ensemble (DisabledForUser)* rather than sending the engineer to a page where nothing is wrong.

The assistant has typed reminder read/write tools, subject to the existing allowed-write-areas and preview/Needs me policy. Reminder content is separate from the context database even when the assistant creates it. Clearing context alone therefore leaves reminders intact. The explicit everything-deletion scope removes reminder rows and disables future desktop delivery for that user. Already delivered Windows notices keep their normal OS expiration/dismissal behaviour.

> Full policy (retention, tombstones, DST handling, Start Menu shortcut setup): [07 §1.2](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#12-private-today-reminders-and-the-windows-desktop).

---

## 15. Waiting, previews and quiet status

The shared **Woven Chorus** system lives in `packages/brand`, with React integration in `components/motion/brand-morph.tsx`. Expressive is the only motion system; the motion-style picker is removed. Old `minimal-quiet` / `minimal-dot` preferences normalize to `expressive`, while the separate **Reduce motion** control and the OS preference remain effective.

Unfurl plays once on assistant opening and home navigation. Infinity follows the assistant's actual pending/streaming work, including its minimized floating launcher. Relay follows running assigned tasks and terminal work. Threadline handles page/document waits. Beacon handles compact controls, refreshes, and the aggregate top-bar activity count. Queued, paused, failed, offline and needs-human states are still. Import/export and connected-app waits use the same controller. Successful completion settles to the logo in 340 ms without waiting for a loop boundary. Loaders appear after 180 ms; `lib/motion/delay.ts` imposes no minimum hold on completed work.

All instances share a 30 fps scheduler, pause while offscreen or the document is hidden, and release their timers/observers on unmount. Reduced motion shows the still mark and meaningful status text. The resting logo uses the selected Satin Gold gradient independently of a user's custom interface accent. White-on-dark and ink-on-light variants are available from the same source. Tab icons use content-hashed public URLs to refresh cached site icons. See [Brand and motion](BRAND.md) for assets, generation and verification.

Fetch, calendar-sync and refresh marks animate only while their own operation is pending. Successful fetch notices dismiss after five seconds, with the timer reset for each completed fetch. Errors and partial failures stay visible.

Workspace previews prefer the original ask, remove Markdown deterministically, and clamp to three lines; no model is involved. Both completed-work lists show at most five items. Blocked execution has a compact expandable notice, and run metadata uses quiet `#` labels instead of emoji. Preferences render as labelled values/lists rather than JSON. M365 intake follows **Paste → Review → Propose**.

The **Failed jobs** section is a real retry interface, not a decorative error list. Its explanation/details are behind information affordances. The planner's structured-context normalization fixes the reported dictionary/string join failure without discarding the job or inventing a successful result.

### Compact review and settings follow-up

- **Needs me** renders held changes as labelled fields, formatted Markdown and exact monospaced command/code blocks, not JSON dumps. Linked task/person/project/repo IDs resolve to user-owned names; unavailable references are explicit. Approve/Deny and model-provided choices are large option tiles. The action payload and saved option IDs are unchanged by formatting.
- **Waiting decisions are persisted**, not continuously running model sessions. Hours or days of waiting add no model requests or tokens. The workspace checkpoint releases its lease and clears heartbeat/deadline timers; its active execution budget resumes with the saved job after an answer. Separate external approval validity and changed-checkout checks still apply.
- **Today** keeps only reminder rows, creation and an information button. Windows notification opt-in/disable controls live in Settings. Retention shows three short status lines; detailed policy and cutoff explanations live in its information tooltip. Settings links to `/deleted-items` in a new tab for individual page/item restoration, rather than embedding the recycle bin.
- **Workspace previews** enforce clipping above Fluent's atomic text styles, and cards cannot shrink beneath their content. Long repository names wrap within the card, including at enlarged text sizes and in completed/attention lists.
- **Model presets** use compact model/thinking/context rows. Tier guidance, transport limitations, refresh metadata and rate explanations are available through keyboard-focusable information icons; discovery failures/stale state remain visible. Retention's label and selector share a row on desktop and stack on narrow screens.
- **Deleted items** uses the same Settings tile width and offers *Restore all* with confirmation. Bulk restore is user-scoped, transactional, audited and not limited by the visible page; linked source mirrors return too. It leaves private reminders, task progress and agent execution unchanged.

## 16. Accounts and public signup

`routes/auth.ts` and `routes/auth-oauth.ts` retain custom scrypt passwords and hashed-cookie sessions. Registration defaults to open, including after the first account. `ENSEMBLE_SIGNUP_MODE=closed` stops new registrations but not existing logins; `allowlist` uses `ENSEMBLE_SIGNUP_ALLOWLIST` and denies an empty list. Local development can claim the placeholder user; hosted production never gives placeholder data to the first public registrant.

Login supports email/password, Google, GitHub and Microsoft. Provider buttons are shown only when both corresponding `AUTH_<PROVIDER>_CLIENT_ID/SECRET` settings exist. Login OAuth clients/scopes are separate from connector OAuth. OAuth uses PKCE, nonce validation, signed browser-flow cookies, expiring single-use database state, and JWKS validation of Google/Microsoft identity tokens. It stores identity mappings, not provider access tokens.

Verified Google and primary GitHub emails can verify a new account. Automatic email linking requires both the provider email and the existing account email to be verified; otherwise sign in through the existing method and explicitly link in Account. Microsoft email/username claims are not trusted as ownership proof: Microsoft-created accounts receive an Ensemble email code. A provider without an email can be linked to an already signed-in account.

Hosted email signup needs `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM` and both Turnstile keys. An unverified account can save notes/tasks/context; agents, models and connectors are gated. `/forgot`, `/reset`, `/verify` are public pages. Verification mail sends a 4-character code for `/verify`; the `email_tokens` row stores only `sha256("verify:" + userId + ":" + code)`, expires after 30 minutes, counts wrong attempts, and a new code invalidates the previous one. Verification requires a signed-in browser session for that same account. Reset mail still uses a single-use URL-fragment token that lasts 30 minutes. Reset and password changes invalidate old sessions; recovering an unverified address removes pending social identities to prevent account pre-hijacking.

| Method | Path | Body / behavior |
|---|---|---|
| GET | `/api/auth/status` | Signup mode, configured providers, `emailConfigured`, `emailSignupAvailable`, public Turnstile key; no secrets |
| POST | `/api/auth/signup` | `{ email, password, name?, turnstileToken? }`; creates session and sends verification |
| POST | `/api/auth/login` • `/api/auth/logout` | `{ email, password }` • ends session |
| GET | `/api/auth/me` | Identity/modules plus `user.profile`, `verificationRequired`, `onboardingComplete`, and `profileComplete`; appearance summary includes `theme`, `colorTheme`, `accent`, `accentCustom` and settings timestamp `accentAt` for the initial palette cookies |
| PATCH | `/api/auth/me` | `{ name?, password?, current? }`; sensitive password changes require browser authentication |
| PUT | `/api/auth/profile` | Browser session. `{ name, gender?, profession?, organization?, heardFrom? }`; trims optional empty values to `null`, sets `profileCompletedAt`, returns `{ user, profile }` |
| GET / POST | `/api/spaces` | Ensemble spaces: list, create from a template with settings copied, synced or fresh. Also `POST /api/spaces/:id/switch`, `PATCH`/`DELETE /api/spaces/:id`, `POST /api/spaces/settings/copy`, `PUT /api/spaces/settings/sync` ([28](28_ENSEMBLE_SPACES.md) §3) |
| GET | `/api/onboarding/templates?role=` | → `{ templates: [{ id, role, name, blurb, desk, tiles: [key, c, r][], features[3], preview: { project, tasks[], people[], deliverables[] } }] }` for the `/start` previews |
| POST | `/api/onboarding` | `{ role, templateId }` → `{ role, templateId, onboardingComplete }`. Once per space (409 after). Seeds starters, sets the desk and modules, sets `profession` when empty, writes `desk.layout.<desk>` and a ready `ui.onboarding-tour` preference in the same transaction |
| GET | `/api/auth/oauth/:provider/start` | Redirects to login provider; `?link=1` requires an existing browser session |
| GET | `/api/auth/oauth/:provider/callback` | Consumes browser-bound state and returns to a fixed Hub-origin page |
| POST | `/api/auth/verify-email` | Browser session. `{ code }`; normalizes spaces/dashes/case, locks after five wrong tries, consumes the active verification code |
| POST | `/api/auth/resend-verification` | Browser session; sends a fresh code and returns `{ sent }` |
| POST | `/api/auth/forgot` | `{ email }`; generic response, whether an account exists or not |
| POST | `/api/auth/reset` | `{ token, password }`; single use, ends all sessions |
| GET / DELETE | `/api/auth/identities` • `/api/auth/identities/:provider` | List login methods • `{ current? }`; cannot remove the last method |
| GET | `/api/auth/export` | Browser-only JSON attachment of user-scoped records, excluding credentials |
| DELETE | `/api/auth/account` | `{ confirmation: "DELETE", current? }`; recent/password-confirmed browser session, no active agent jobs; removes account data and revokes devices |

`/verify` (`app/verify/page.tsx`, `components/account-recovery.tsx`) uses the sign-in backdrop and form layout, a short entrance transition (disabled for reduced motion), and four code slots backed by one paste/autofill input. It shows the signed-in email, posts `{ code }`, offers **Send a new code**, and asks signed-out people to sign in at `/login?next=/verify`. Successful verification follows a safe relative `next` query, then `/start` if onboarding is incomplete, otherwise `/today`.

`/start` (`app/(hub)/start/page.tsx`) is a focused two-step screen without the sidebar, top bar or assistant launcher. The left column asks the questions; the right column previews the desk live.

1. **About you.** Name, then *What do you do?* (Student, Teacher, Lawyer, Engineer, Builder, Manager), plus optional organization and how they heard about Ensemble. The role is saved as the profession, so the question is asked once; gender stays in Settings → Account. Someone whose profile is already complete sees only the role question, preselected from their profession when it matches (`components/onboarding/roles.ts`).
2. **Your desk.** Six templates for that role, each with a small preview. The large preview switches between **Today**, **Board** and **Context**, drawn from fictional sample rows (`components/onboarding/sample.ts`) by the same tile renderer as Today (`PreviewTiles`), scaled to fit. Nothing in the preview is saved.

*Start with …* calls `POST /api/onboarding`, which seeds the template's starters, sets the desk, saves the profession when it was empty, and writes the template's Today layout to `desk.layout.<desk>`. There are 36 templates, six per role, and no two in a role share a Today layout (`packages/shared-types/src/templates/manifest.ts`, checked in `apps/hub-api/src/layouts/layouts.test.ts`).

**Guided walkthrough.** After setup, the first visit to `/today` opens a contained, eleven-chapter preview (`components/onboarding/guided-tour.tsx`, loaded by `app/(hub)/layout.tsx`). It waits for any appearance picker or other modal to close. One fixed popup contains a simulated Ensemble window, explanation and playback/navigation controls. The real app behind it keeps its route and scroll position throughout the walkthrough and on completion. There are no live-page spotlights, changing bounding boxes or navigation cursor clicks in the user's workspace.

`tour-scenes.tsx` renders fictional, non-interactive examples using the app's theme, brand, connector logos, profile-specific sample rows from `sample.ts`, and the real Today `PreviewTiles` renderer. The chosen signup template determines the first Today tile and role-specific copy. Common chapters show Today, adding a tile, Board, a named page followed by Context, Needs me, Connected apps and the assistant. The page story uses fictional names and work suited to the role: a lesson, assignment, matter review, release or team update. It explicitly adds the page to the board and sets its due date; person, project and date mentions alone do not assign work or set task properties. Context then shows that task and its saved mention edges, rather than invented inferred relationships. Needs me mirrors the actual queue categories and controls: engineers/builders with Code enabled see an agent git-push request with Allow once/Deny; other roles see an outgoing email preview with Approve/Edit/Reject. Connected apps highlights a source appropriate to the role. Engineers and builders get a Code demonstration when it is enabled; managers get Meeting notes; other profiles get Files (`tour-plan.ts`). All preview content is inert and hidden from the accessibility tree; the explanation describes each chapter.

Scene durations are 5 seconds for welcome, adding a tile, Board and finish; 6 for Today, Context and the specialist chapter; 8 for the page story; 10 for Needs me and the assistant; and 7 for Connected apps. Each scene holds at its final frame. Pointer movements generally take 350–600 ms, with reading pauses between them. Tile-library and page click positions are measured inside the fictional preview so they stay aligned at compact sizes and zoom. The user advances chapters manually. **Pause/Play** freezes/resumes the demonstration; **Restart scene** replays it. Next and Back stay in the same position, with a 650 ms crossfade of the scene and explanation; the Next label never becomes a loading message. Chapter shortcuts are available on larger screens. `FitPreview` in `tour-scenes.tsx` measures the available preview area with ResizeObserver and uniformly scales the entire 1040 × 500 canvas (480 × 500 in narrow or tall preview panes), including app chrome. It contains the whole scene at browser zoom and in short windows without clipping or stretching. Phones keep the same popup and footer throughout; desktop windows up to 680 CSS pixels high place the explanation beside the preview, keeping the contained app large enough to read at zoom. OS reduced motion or the appearance setting shows a still final frame and disables playback motion. Hidden browser tabs do not consume playback time (`tour-playback.ts`).

Progress remains `{ v: 1, status: "ready" | "active" | "completed" | "skipped", step, updatedAt }` in `ui.onboarding-tour`, through the existing preferences API. The browser fallback is `ensemble.tour:<account id>:<space id>`. Existing progress from the earlier tour uses the same chapter IDs. Refresh resumes the saved chapter; completion, Escape and Skip dismiss it. Existing accounts without a ready marker are left alone. **Account menu → Take a tour** replays it for an owner. Setup screens and spaces shared with the user do not show it. Each new space keeps its own progress, excluded from settings copy/sync ([28 §4](28_ENSEMBLE_SPACES.md#4-settings-separate-copied-or-synced)).

The dialog contains and restores keyboard focus and suppresses app shortcuts while a walkthrough control is focused. The demonstrations fetch no live workspace data, write no sample rows, approve no requests, connect no apps and call no model. At the end, **Done** returns to the page underneath; the optional **Try my first question** opens the assistant with a profile-specific draft, without sending it. `tour.test.tsx` covers profile/module selection, timing, pause/restart, persistent controls, no real navigation, focus, resume, dismissal across tabs and offline progress. `e2e/onboarding-tour.mjs` checks full setup and the preview against isolated local services, measuring the popup, Next button and complete canvas across every chapter, including effective 125%, 150% and 200% zoom viewports and 125% appearance text scaling. Checked 13 Oct 2026 against a production Hub build and isolated PGlite API: all six profiles across seven viewport cases passed, with no navigation or task creation by the tour. A separate HTTP fixture confirmed page-to-task conversion preserves mention edges in the real Context graph and that due dates are set explicitly.

Checked 13 Oct 2026: all-package TypeScript checks, 396 Hub UI tests, focused playback/focus/reduced-motion checks and the production Hub build passed. Headless Chrome with an isolated PGlite API completed setup and every chapter in dark desktop (1440 × 900), light phone (390 × 844) and light landscape (844 × 390). It measured identical popup and Next-button bounds across all chapters, verified pause/restart and the 12-second final-frame hold, refresh/resume, completion, replay and Escape, and checked that the real route and task count stayed unchanged. No live model was called.

Settings → Account supports profile editing, linked methods, adding/changing passwords, JSON export and deletion. Sensitive method removal/deletion uses a recent session (10 minutes) or current-password confirmation. Deletion leaves local user files alone; provider copies and infrastructure backup retention are separate. The landing site includes `/privacy`, `/terms`, and direct registration links.

Sign-in and sign-up (`components/auth-form.tsx`) use a split screen: on the left, `components/auth-backdrop.tsx` draws a slow context graph and three app-like cards (a task, an `@ensemble` answer, a chart); on the right, the form. The motion stops under reduced motion, and below 900 px only the form shows.

`emailSignupAvailable` describes method readiness, independently of open/allowlist/closed policy. Hosted email signup requires configured delivery and both Turnstile keys; development and desktop retain no-mail signup. `components/auth-form.tsx` hides an unusable email form, keeps configured social providers, and shows an upfront unavailable message when none can be offered. Existing password logins remain available. Provider configuration and real verification mail still need operator setup; the UI does not bypass those guards.

## 17. Linking a computer, and connecting editors

- **`/link`** (`app/link/page.tsx`, `components/cli-link.tsx`): approves or denies an `ensemble login`. It is a standalone signed-in page; signed-out visitors go to `/login?next=/link?code=…` and come back, and the onboarding redirect skips it so a new account does not lose the code. It shows the computer name, platform, CLI version and requested access ("Read your Ensemble context in editors" and "Run tasks you assign to this computer") with a warning to approve only a code you just started. An unverified hosted account can approve editor access only.
- **Connect your apps** (`/connect`, `components/connect/*`, `lib/connect/{catalog,configs,guides}.ts`): each editor guide offers three methods: Ensemble CLI (recommended; install command per OS, `ensemble login`, `ensemble mcp setup <editor>`, the config it writes), Hosted URL (no install; a read-only key from this page and the `${publicApiUrl}/mcp` snippet), and From source (the earlier developer flow; only this method shows the local bridge status). Editors: VS Code, Cursor, Windsurf, Claude Code, Claude Desktop, Codex & ChatGPT, Gemini CLI, GitHub Copilot CLI, Zed, Visual Studio, JetBrains, Cline, Continue, opencode; macOS, Windows and Linux paths. Each card shows the app's own logo (`components/connect/brand-logos.ts`): Simple Icons marks (CC0) in the brand colour, dark marks on a dark tile, and the vendors' own icons for VS Code, Visual Studio, Codex (OpenAI) and Continue. The logos are their owners' trademarks and only name the app a guide is for.
- **Settings → Devices** (`components/settings/devices.tsx`): "Add a computer with the Ensemble CLI" (install per OS, `ensemble login`, `ensemble folders add`, `ensemble runner install`) above the pairing code, which stays for the desktop app. The assign dialog's empty state points there.
- **Assign to agent** (`components/agent/assign-dialog.tsx`): every option is listed with its meaning in [doc 06](06_MODULE_WORKSPACE_AND_SURFACES.md). In a space whose template leaves agents out (the `workspace` module off), the dialog asks **Turn on agents for this space?** and turns on Agent runs and Code review in place (`setFeature`), instead of failing with the API's `MODULE_DENIED`. Any other request to a module that is off shows "That feature is off in this space. Turn it on in Settings → Account → Features." (`ApiError.moduleOff` in `lib/api.ts`). With GitHub connected, **Pick from GitHub** beside the repository field (`components/app-items/github-repo-picker.tsx`) lists the repositories that connection can reach and fills in `owner/name`. A **Profile** row at the top holds up to three saved run profiles (`lib/run-profiles.ts`, stored in `settings.runProfiles` and `defaultRunProfileId`; the API refuses a fourth) plus a built-in Quick profile while none is saved: pick one, see "modified" after a change, Update it, Save as profile (inline name field), rename, delete, or star it as the default the dialog opens with. The same Mode, internet, limits and profiles apply to a paired computer; its branch is As is for now. A code task for a paired computer with no repository and no shared folder works in a new empty folder there, as it does on this computer (13 Oct 2026; it was refused before, while the field's hint said to leave it empty). Computers show "last contact", not an online dot; in the desktop app "This server" reads "This computer". **When Assign cannot go ahead** (13 Oct 2026), the footer says why in place of the start line (`assignBlocker`: no task, no computer paired, a folder still being checked or refused, a computer that has shared no folders, an earlier task not picked, a branch without a name, Review only or Run unattended without a trusted folder or sandbox). The button stays pressable: pressing it scrolls to that field, focuses it and rings it. A typed folder path is checked half a second after typing stops, not only when the field loses focus. **Who does the work** (11 Oct 2026, a select since 12 Oct) chooses Ensemble's agent, Claude Code, Codex or Cursor's agent with the person's own sign-in, or **In its own app or a terminal** (on this computer, listing the targets `GET /api/agent/apps` found: the Claude app, Codex in the ChatGPT app, Cursor, VS Code, and Claude Code, Codex, Cursor's agent or Copilot CLI in a terminal): it hides the mode, sandbox, git and limit choices (the tool's own apply), and the button becomes "Open in …" or "Start in a terminal" (`POST /api/agent/handoff`); doc [30](30_ENGINES.md). With Claude Code the model list is Claude Code's own (default, Sonnet, Opus, Haiku), with Codex and Cursor a free model name (empty: the tool's default); run profiles remember the engine. A task opened in an app shows a card on the task page (`components/agent/handoff-card.tsx`): waiting for Send, working, or the agent's last words, with "Done with it". **Sandbox** names this computer's sandbox (macOS, Linux bubblewrap or Landlock, Windows) from `GET /api/workspace/guard`, or for a paired computer from its reported `sandboxInfo`; when there is none it says why, the run goes ahead with the sandbox off, and on Windows a **Set up the sandbox** button calls `POST /api/sandbox/setup` (one Windows permission prompt; only on the computer itself). With the sandbox on, **Outside the work folder** (Read only, Read and write, No access) starts at the Settings value (`orchestration.outsideAccess`, Settings → Orchestration) and a change applies to this run only (`outsideAccess` on `POST /api/agent/assign`); run profiles do not store it.
- **Questions from other tools** (`EditorQuestionCard` in `components/needs-me/editor-decisions.tsx`, 11 Oct 2026): a question Claude Code asked through the hook shows the tool's own options with their descriptions, lets several be picked when the tool allows it, takes a typed answer, or hands it back ("Answer in Claude Code instead"). The answer goes back to the tool as if picked there. Codex and Copilot CLI permission prompts use the permission card. Settings → Editors & agents lists Claude Code, Codex, GitHub Copilot CLI, Cursor and VS Code. Since 12 Oct 2026 Claude's questions arrive through `PermissionRequest`, so Claude's own card stays open too; whichever is answered first counts, and a card answered in Claude leaves Needs me by itself (status `settled`).
- **Needs me for a paired computer** (`DeviceCard` in `components/needs-me/editor-decisions.tsx`, `lib/device-copy.ts`): options show the agent's recommended one; a typed answer is offered when the agent allowed one; a push, a path outside the folder or trusting a folder asks "Allow …?" before sending (`confirmed: true`). When the computer accepts such answers only on itself, the card says "Approve this on <computer>". The desktop app's "This computer" card (`components/settings/remote-mac.tsx`) has the **Accept approvals from the web and phone** switch.

## 18. Downloads

Everything is built in the browser (`apps/hub-web/lib/export/`). The API only answers the same GET routes the pages already use, so a download costs the server nothing extra.

- **One item.** A download icon next to Share (`components/export-menu.tsx`) on pages, tasks (the full page and the side peek), meeting notes and skills. It offers PDF (jsPDF, real text), Word `.docx` (`docx`), Apple Pages (the same `.docx`; Pages opens it, since Apple publishes no writable `.pages` format), Markdown, a web page and plain text. Tasks put Status, Priority, Owner, Due, Labels and Source under the title, then the description and page. People who can only view an item, including on a public link, can still download it. Pages are read with `blocksFromPage` (`lib/export/document.ts`): headings, lists, to-dos, quotes, code, tables and mentions; embeds with no text are left out.
- **Diagrams.** The Diagrams list has a download menu on each row (PNG, SVG, PDF, JPG) next to Delete (`components/diagrams/download-menu.tsx`), as well as the one in the editor.
- **A whole space.** *Settings › Data › Download this space* (`components/settings/space-export.tsx`, `lib/export/space.ts`) lets you tick any of Pages, Tasks, Context, Meeting notes, Skills, Diagrams and Plots (Select all ticks every one). Modules turned off in the space are not offered. It builds one ZIP with `fflate`: Markdown for pages, tasks (one folder per status), meeting notes and skills; `tasks.csv` and `tasks.json`; people, projects, repos and deliverables as CSV and JSON; each diagram as PNG, SVG and its source text; each plot space's settings as JSON with its data as CSV. A README lists the counts and anything that could not be read. Requests run a few at a time with a progress bar. Settings, keys and connected apps are never included. To get a plot as a PDF figure, use *Export figure* in Plots, which renders on the server.

Checked 9 Oct 2026 in a local browser: a page downloaded as `.md`, `.pdf` and `.docx`, a task from the side peek as `.md`, and a full-space ZIP with every section ticked.
