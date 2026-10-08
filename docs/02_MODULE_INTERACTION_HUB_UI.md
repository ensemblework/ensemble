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

**Left rail (Fluent Nav):** Today • Board • Needs Me *(n)* • Runs • Context • Skills • Workspace • Code • Metrics • ⚙ Settings (tabs: Account, Spaces, Sharing, Assistant, Connections, Notifications, Shortcuts, Data; see [§3.9](#39-settings)). **Shared with you** (`/shared`) appears under Pages once someone has shared something with you, with a count of items not yet opened. **Pages** sits directly below Today and starts collapsed on every load, unless the open route is a page (`components/pages/pages-section.tsx`). In the collapsed icon rail, Pages is one icon that opens the sidebar with the list showing, so the rail has no empty row.

**Space switcher.** The top of the sidebar is the open Ensemble space: its emoji or initial and its name (`components/shell/space-switcher.tsx`). The menu lists every space with its template, the spaces **shared with you** (owner's avatar on the icon), **Share ‹space›…**, **New space** (`/spaces/new`) and **Manage spaces**. Switching reloads into Today (the board, in a shared space); other tabs follow. See [28](28_ENSEMBLE_SPACES.md) and [29](29_SHARING.md).

**In a space shared with you** the sidebar has no Today or Metrics, the top bar has no Fetch now and shows "Shared by ‹owner› · Can edit/Can view", and layouts, the kill switch, Connections and Data settings are hidden. Viewers get read-only pages, tasks, diagrams and plots. The top bar shows who else is in the space now; click someone to go to them or follow them. Pages, tasks, diagrams and the board show who is on them, and diagrams show their live cursors ([29 §5](29_SHARING.md#5-live-presence)).

Two surfaces are deliberately **not** in the rail, because they are reached from the thing they belong to rather than browsed:

- `/tasks/<id>`, `/projects/<id>` — document pages, opened from the board, a mention, or a search result. §13.
- `/runs/<id>` — one run's timeline, opened from Runs or from a task.

Prompt transparency is the expandable **Prompts** section at `/settings?tab=assistant#prompts` ("Open prompts"), backed by `GET /api/prompts`. There is no standalone `/prompts` page.

**Global header:** a three-part grid (`components/shell/topbar.tsx`): the page title on the left, the Ask bar centred, and one right-hand cluster with notifications, undo/redo, Fetch, activity, view mode, and an initials avatar. The side columns never shrink below their contents, so on narrow windows the Ask bar gives way instead of the icons overlapping it. The theme switch lives only in the avatar menu. The avatar (`components/shell/account-menu.tsx`, first and last initial from `lib/initials.ts`) opens a menu with the name and email, Account settings, Assistant and models, Connected apps, Spaces, Keyboard shortcuts, Templates (dev tools only), a theme switch, and Sign out. Collapse the sidebar to icons at any desktop width; the choice is saved. Drag the sidebar's right edge to resize it between 184 and 360 px (arrow keys work on the edge too; double-click resets); the width is saved per browser (`components/shell/sidebar-resize.tsx`, `--sidebar-w`). On Board, *Task board* is the heading in this bar, not a second large heading inside the work area.

Below the `lg` breakpoint, Undo/Redo, Fetch, and task-view mode move into **More actions** (`components/shell/topbar.tsx`). Search, notifications, activity, and the kill switch remain directly reachable. The activity popover stays inside the narrow viewport.

Code, Workspace, and Terminal distinguish a denied/failed request from an empty result or loading state. `components/ui.tsx` supplies a shared error message and Retry action; hosted access failures also link to paired-computer setup without granting host privileges. Settings' password, run-limit, fetch-time, and quiet-hour fields have explicit accessible names.

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

- **Resize:** drag the corner of a tile, or focus the corner and use the arrow keys. Sizes snap to whole cells. Every tile has a minimum (`components/desk/layout.ts` `tileLimits`): 3 × 2 cells by default, 4 × 3 for tiles that draw a week, band or timeline, 6 × 3 for hero tiles; at most 12 × 8.
- **Move:** drag the grip before a tile's title, or focus it and use the arrow keys.
- **Hide:** the eye button in a tile's header. The toast offers Undo.
- **Add a tile:** lists tiles hidden from this desk, live tiles borrowed from other desks (one per title, saved with real desk entries), and the older shortcut widgets. **Reset layout** returns to the arrangement the signup template chose, or the bare desk.

The arrangement is the `desk.layout.<desk>` preference `{ v: 1, tiles: [{ key, c, r }], hidden: [] }`. A signup template writes it with `exact: true`, meaning only those tiles; the first edit writes the hidden list out instead. Desk tiles that are in neither list (a new tile in a later release) are appended. The desk extras in Settings → Account → Features (Deadlines, Learning, On the bench) still show or hide their tile when a layout is saved: switching one changes that desk's layout too, an extra that is off is never borrowed back, and one that is on is added to a template layout. An empty desk shows one quiet line offering a sample (`desk.sample`), and the dismissal is remembered in the browser. The desk's name is not shown on Today or Context.

### 3.2 Board (Kanban)

**Columns:** Proposed • To do • In progress • Waiting for me • Done. Each card shows its owner. The previous owner swimlanes are replaced by **one ordered list per column** so arranging work cannot accidentally delegate it.

**Current Hub controls:**

- **New task** in the page header or a column immediately calls `POST /api/tasks` with the title `Untitled` and opens the document editor (`components/board/board.tsx`). There is no creation dialog. The title is selected for editing; owner, priority, due date, and other properties can be set on the page. Header creation uses *To do*, column creation uses that column, and human Waiting work is blocked. The owner starts unassigned; creation never delegates execution.
- Repeated creation is guarded synchronously and by the pending state. Errors are shown as toasts, and success clears filters hiding the new card. **Add page** converts an existing sidebar note into a task and opens it on the board. Task titles remain trimmed and whitespace-only titles are rejected.
- **Search** title/description and labels (`#label` matches labels only; `/board?q=%23label` opens the board filtered), **filter** by owner and priority, and **Load more tasks** when another page exists. Board and Workspace share the same paginated query cache.
- **Drag** with the dedicated handle, leaving the title available for opening. Reordering and cross-column moves persist `boardOrder` in Postgres, using **before/after task anchors** so filters do not overwrite hidden work. Pointer and keyboard sorting are supported. Agent-owned work can be reordered; changing its progress requires an explicit *Take over* first.
- **A new task joins its priority band.** The board's order belongs to the engineer, and nothing re-sorts it — the only question is where a task that did not exist a moment ago should be inserted. It goes **above the first task that matters less than it**, and to the bottom when nothing does: p0 above the first p1 or p2, p1 above the first p2, p2 at the end.

  The rule is written against *the first lower-priority task* rather than *the last equal one* on purpose. A hand-arranged board is not sorted — one real column runs `p1, p2, p0, p1, p2, p2, p0, p2` — and "after the last p0" would drop a new p0 seventh of eight, beneath every p2 above it. "Above the first thing that matters less" puts it on top, which is the point of marking it p0. On a board that *is* sorted the two rules agree.

  *Settings → Place new tasks by priority* turns it off, restoring the previous append-to-the-end behaviour. Either way **no existing card is moved**: the only write to another row is a respace when neighbours share a position, which renumbers the column in its existing sequence without reordering it.
- A human task dropped into *Waiting* is **blocked**, not a fabricated approval. The detail drawer also offers *Start work*, *Mark done* and *Reopen task*, so everyday state changes do not require dragging. Moves are optimistic and roll back visibly on an API failure.
- A `?task=<id>` link loads the task independently of the current filters or pagination. Drawers open after hydration so an initially open Fluent portal cannot mismatch the server HTML.

**Cards** show title, priority, owner, due date and up to three label chips (`components/task/labels.tsx`). An agent card shows only its current working/review step when the task is actually in that state. Details, help, delegation and takeover live in the task page rather than a button strip on every card.

**Task detail drawer (right):** description, provenance, people, related artifacts (auto-linked), plan, runs, comments (chat with the agent scoped to this task), history.

**Current task page:** drag its left edge to resize, use full-width mode, or open `/tasks/<id>`. Width/sidebar preferences are local; task data is in Postgres. Title, description, notes, priority, date, labels (chips; Enter or a comma adds one, Backspace removes the last), project, people, repo, deliverable and explicit skills are editable. Changes **autosave after a short typing pause**; **Ctrl+S** flushes immediately. Failed/conflicting saves retain the draft rather than overwriting another tab. Notes retain Markdown whitespace. Peeks with unsaved changes require confirmation before leaving. The board API omits note bodies; opening a page loads them on demand.

### 3.3 Needs Me (Approval Queue)

This is a **decision inbox**, not only the approvals table. It also shows the actual saved question for blocked tasks, with options or *Answer & resume*. Interrupted older runs are distinguished from pending approvals. **No card is fabricated from a status string.**

Ordered by deadline/risk. Each `ApprovalCard` has:

- **Action type badge** (Send email, Open PR, Post to Teams, Update work item) + **risk level** (low/med/high) + which skill(s) shaped it.
- **Preview exactly as it will appear** (email: rendered with recipients; PR: title/body/diff summary/target branch; Teams: bubble in channel context).
- **Buttons:** *Approve* • *Edit & approve* (inline editor; edits are captured as skill feedback) • *Reject with reason* (reason becomes learning signal) • *Ask agent to revise* (one-line note).
- **"Why this?"** expander: the reasoning summary + context items used (never raw chain-of-thought; a structured rationale).
- **Batch actions:** approve all low-risk.

### 3.4 Runs (Agent Timeline / Trace)

The overview shows **the latest 10 runs and nothing else**. Below them, **Show all runs** opens `/runs/all` in a new tab — a new tab because the recent list is usually read beside work in progress, and navigating away from it and back is the annoyance a separate archive should not introduce.

The archive lists every run, newest first, including failed and cancelled ones, paging 50 at a time. It is also **the only place a run can be deleted**: throwing away a record is a deliberate visit, not something to fat-finger next to the run you are watching. Deleting is a **soft delete** — the run leaves both lists and its detail page answers 404, and it waits in *Deleted items* for the retention window, restorable intact. The append-only audit ledger records that the run happened, and that it was deleted, either way.

- A run that has not finished, or that is waiting on an approval or a question, **cannot be deleted**: resolve or stop it first, so an answer never arrives for a row that is gone.
- A run whose workspace job ended *blocked* **is** deletable — it has already stopped, and it is exactly the failed run worth clearing.

**Details** put questions, approval previews and interruption recovery before the trace. Usage/technical metadata and verbose step outputs are collapsed; the model-request/tool trace is mounted only when expanded. Missing timing/token data is labelled as unreported. Activity dates show *Today*, *Yesterday* or the older date, with the exact timestamp available on hover.

- Left: list of runs (live first). Right: vertical timeline of steps with tool calls (`graph.mail.get`, `github.pr.create`), inputs/outputs collapsed, durations, tokens, model, prompt version, skill versions, approvals. Failed steps show retry history.
- "Replay with different skill version" (P2).
- Export run as JSON (feeds audit).

> Note: 05 §13 says the Runs overview is limited to **eight** recent attempts plus a disclosure for the previous ten; this section says 10. Check `apps/hub-web/app/(hub)/runs` for the current number.

### 3.5 Context (Engineer Graph explorer)

On a persona desk, Context (`components/desk/context-lens.tsx`) has the same tab row for every desk: **Overview, People, Projects**, the desk's own tabs (for example Repos, Reviews, Deploys), **Graph**, and **Artifacts & sync** (`components/desk/context-tabs.ts`). People, Projects, Graph and Artifacts render the full components from `components/context/`. The tab is in the address (`/context?tab=people&search=…`), so mention links land on it. The Overview and the desk's own tabs use the same tile controls as Today (`components/desk/arrange.tsx`): move by the grip, resize from the corner, hide. Each tab's arrangement is the `desk.context.<desk>.<tab>` preference; hidden tiles come back from the chips under the grid, next to **Reset layout**. The Board's widget strip keeps its own **Edit layout** mode. *Add person* takes a name, an optional email and an optional role, reports errors in a toast, and an empty People tab offers the same action. The Overview's People tile links to the People tab.

**Tabs:** *People* (who I work with, on what, last interaction, my typical response time), *Projects* (deliverables, work items, meetings, docs), *Repos* (my ownership, PR stats, style skill), *Preferences* (working hours, focus preferences, tone notes). Each node shows evidence (*"inferred from 14 emails and 3 meetings"*) and an **Edit / Correct** button — corrections are first-class data.

> Later: evidence and confidence badges were removed from the cards (see [03 §3](03_MODULE_CONTEXT_ENGINE.md#3-normalized-model)).

The **Graph** tab has a **Full screen** button. A few hundred nodes are not readable inside a page column, and zooming out to fit them only trades one unreadable view for another. It asks the browser for real fullscreen — the only way to get the browser chrome out of the way — and falls back to an in-page overlay when that is refused, which happens without a user gesture, in some iframes, and on iOS Safari. Both paths use the same layout, so they look identical; **Esc** leaves either one. Full screen changes nothing about the data, only how much of the screen the canvas gets.

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
| Account | Account and profile (`#account`), Avatar (`#avatar`: 15 picture avatars per profession, or initials), Email & time zone (`#you`), Appearance (`#appearance`), Features (`#features`), Remote tasks on this Mac (`#this-mac`, desktop app only) |
| Assistant | The assistant (`#assistant`): *Your field*, write policy, default preset, *What it may change*; Models (`#models`); Watching for you (`#watchers`, only while a watcher is active); Autonomy, Orchestration, Quiet hours, Prompts |
| Connections | Connections (`#connections`), Recent imports (`#imports`, once there is one), Fetching (`#fetch`), Editors & agents (`#editors`, `#connect`), Devices (`#devices`) |
| Notifications | Morning brief (`#brief`), Quiet nudges (`#nudges`), Desktop reminders (`#reminders`), Quick capture (`#capture`) |
| Spaces | Your spaces (`#spaces`): rename, icon, open, delete; *Settings across spaces*: keep every space in sync, or copy another space's settings in ([28](28_ENSEMBLE_SPACES.md)) |
| Sharing | Contacts (`#contacts`, 5 slots), spaces you share and their members, hand over a space (once), items you shared, public links (5), shared with you ([29](29_SHARING.md)). In a space shared with you, Connections and Data are hidden and a note says settings are your own |
| Shortcuts | Every key binding by group (`#shortcuts`, `#keyboard`), see below |
| Data | Data retention (`#retention`), Completed (`#completed`), Trash (`#trash`), Terminal and commits (`#terminal`), Failed jobs, Deleted items, Delete my data (`#danger`) |

Big or rarely used controls open in dialogs (`components/settings/modal.tsx`: Escape and a backdrop click close only the top dialog, Tab stays inside it, focus returns to the button that opened it). Dialogs are in the address too, so a link opens them:

- **Model providers & keys** (`?tab=assistant&dialog=keys`, or `#keys`): API keys per provider with inline add/replace/remove, a Test button per tier, the Ollama URL and the GitHub token for private clones. The Models card itself keeps only "Which model each tier uses" and a one-line summary of which providers have keys (`components/settings/models.tsx`).
- **What the assistant may change** (`?tab=assistant&dialog=changes`, or `#changes`): the six areas inside Ensemble, plus the *Connected apps* switch (`assistant.connectedAppWrites`): the assistant may propose changes in Google, Microsoft and other connected apps, and each one waits for Apply. The card shows a summary such as "Everything inside Ensemble · Connected apps ask first" (`components/settings/assistant.tsx`).

**Shortcuts** (`components/settings/tab-shortcuts.tsx`) lists every binding from `@ensemble/shared-types` `shortcuts.ts`, grouped Everywhere, Create, Go to, Today, Code and Diagrams. *Change* records the next chord; Escape cancels. A custom chord must use Command/Ctrl or Option/Alt with a key, and `customChordProblem` refuses chords the browser or macOS already own (Command-P, Command-W, Command-T, Command-Q and the rest), named keys, function keys, and chords another action uses. Overrides are the `ui.shortcuts` preference, applied by `lib/shortcut-store.ts` everywhere shortcuts are read, including the `?` sheet. *New task* (N then T) and *New page* (N then P) are new bindings; a custom chord works alongside the two-key sequence. Option chords match the physical key, so macOS dead characters do not break them. `ui.*` and `desk.*` preferences are hidden from the Preferences list in Context.

*Your field* (`assistant.actAs`) offers every `ActAs` value, with "Match my sign-up role" for `general`. It shapes the assistant's tone and suggestions only, never what Ensemble can read or change. *Watching for you* lists the conditions the assistant watches after "tell me when …", with Cancel; it is hidden when none are active.

**Fetching** (`components/settings/fetching.tsx`) shows that scheduled fetching is paused product-wide, with **Sync now**, the look-back days and the *Propose todos from what was read* switch. There is no schedule editor while routines are being built.

**Editors & agents** links to `/connect` (*Connect an editor*) instead of embedding the app picker; the permission-prompt hooks, personal token and standing answers sit behind a disclosure that opens by itself for `#editors`.

#### Connector store

Settings → Connections lists the featured catalog entries (`featured: true` in `CONNECTOR_CATALOG`, shown in the order Google Workspace, Microsoft 365, Notion, Linear, GitHub) with their status ("Connected as …", "Not connected", "Not set up on this server") and one action, plus **Browse connectors**, **Import from other apps** (opens `components/imports/import-dialog.tsx`) and **Add custom connector (MCP URL)** (`components/connectors/featured.tsx`).

**Browse connectors** opens the store (`components/connectors/store-dialog.tsx`), a dialog of up to 1000 px by 80 % of the window. The search box has focus when it opens, filters as you type (every word must match the name, vendor, tagline, products or what it reads), and `/` focuses it again; Escape in a non-empty search clears it first. The sidebar (chips on narrow screens) lists All, Connected, each `CONNECTOR_CATEGORIES` entry that has apps, and Import. Each card shows the logo, name, tagline and status; "soon" entries sort last.

A card opens the connector's detail inside the same dialog (`components/connectors/connector-detail.tsx`), with a Back button. The address holds the view (`?tab=connections&store=<category>` and `&connector=<id>`; `connector=custom` is the custom form, `connector=mcp:<id>` a custom server), and OAuth and MCP sign-ins return to `/settings?tab=connections&connector=<id>`, so the detail reopens after the redirect and the page toasts `?connected=` / `?connectError=`. The detail shows:

- what it reads and what it can change ("Each change waits for your Apply"), notes, and the vendor's docs link;
- before connecting, every way in, in catalog order: **Sign in with …** (`GET /api/connectors/:provider/start?products=…&returnTo=…`; suites first ask which products to switch on, and Google uses Google's sign-in button), **Paste a token** (an inline form with a *Where to get it* link: Notion's secret, Atlassian email + API token + site, Trello key + token, one token elsewhere; `POST /api/connectors/:provider/token`), **Connect tools** (`POST /api/mcp-connections {serverId, returnTo}`, then the vendor's approval page; when the server answers `MCP_TOKEN_REQUIRED`, `MCP_PKCE_UNSUPPORTED` or `MCP_TOKEN_REFUSED`, a token field appears in place and the same call is retried with `token`), and **Import** for file-only entries;
- "Not set up on this server yet" when browser sign-in is the only way in and the operator has not registered the provider's app (`state.appReady` false); operators also get the existing *Set up once* dialog there;
- when connected: the account, per-product switches for suites (`PUT /api/connectors/:id/products`; a product that needs new consent shows *Continue to Google/Microsoft* instead of redirecting by surprise, and products waiting for consent show *Approve access*), each sync source with its last sync and **Sync now**, the Slack channel list, and **Disconnect** with an inline confirm that can also delete what Ensemble read (`DELETE /api/connectors/:provider?deleteData=1`);
- for MCP: status, the server's tools with a switch each (`PATCH /api/mcp-connections/:id {disabledTools}`), *Refresh tools* and *Remove*;
- **Import from …** when the entry has `import`, opening the import dialog on that source.

The custom connector form (`components/connectors/custom-connector.tsx`) takes a name and an https URL and asks how the server signs in: on its own page (default), a personal access token, or an OAuth client ID and optional secret. `MCP_URL_REFUSED` is shown under the URL field, and a server that needs a token switches the form to the token field. Recent imports (`components/imports/recent-imports.tsx`) appear under Connections once there is one.

Client calls for the store and MCP routes are in `lib/api-connectors.ts` (the MCP connect call keeps hub-api's error `code`); the catalog comes from `GET /api/connectors/catalog`.

**Logos and trademarks.** `components/connectors/brand-logo.tsx` draws logos from the `simple-icons` package (CC0), imported one icon at a time so only those paths are bundled. Brands simple-icons does not carry (every Microsoft product, Slack and AWS, which asked to be removed, and most meeting recorders) get a plain tile with the name's initials, in the brand colour where we know it; we do not draw imitations of those marks. A simple-icons mark with the same name as a different company (its "Fathom" is Fathom Analytics) is not used for the other one. The store footer and this doc carry the notice: *Product names, logos and brands are property of their respective owners and are used only to identify the services you can connect. Ensemble is not affiliated with or endorsed by them.*

---

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
| GET / PATCH / PUT / DELETE | `/api/pages/:id` | → the note • `{ title }` • `{ revision, content, notes?, annotations? }`, `409` on a stale revision • `204` |
| POST | `/api/pages/:kind/:id/convert` | `{ revision }`; `kind` is `page` or `task`. Converts to the other type and returns `{ kind, id, pageId }`. Ownership, revision, and active-agent checks apply. |
| GET / POST | `/api/pages/:kind/:id/comments` | User-scoped discussion rows for a task, page, project, or deliverable |
| POST | `/api/pages/:kind/:id/ensemble` | Inline SSE answer; accepts `{ prompt, content?, mentions?, parentId?, quote?, tier?, actAs? }` |
| GET | `/api/tasks/:id/context` | → context pack preview (chips, no model call) |
| POST | `/api/tasks/:id/help` | `{ delta, excludeChipIds? }` → streams the answer (SSE) |
| GET | `/api/approvals?state=pending` | → `{ approvals[], questions[], interrupted[] }` |
| POST | `/api/approvals/:id/decide` | `{ decision: 'approved' \| 'edited' \| 'rejected', editedPayload?, reason? }` |
| POST | `/api/approvals/:id/revise` | `{ note }` |
| GET | `/api/runs` • `/api/runs/:id` • `/api/runs/:id/export` | |
| GET | `/api/context/people\|projects\|repos\|preferences` | → graph nodes with evidence |
| POST | `/api/context/corrections` | `{ nodeId, nodeKind, field, value, note }` |
| GET | `/api/connectors/catalog` | → `{ entries[] }`: every `CONNECTOR_CATALOG` entry plus `state` `{ connected, account, appReady, oauthReady, products, needsConsent[], sources{ id: { enabled, lastSyncAt, lastError } }, mcp? }` for the signed-in person ([03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens)) |
| GET | `/api/connectors/:provider/start?products=a,b&returnTo=` | → `{ url }` for the provider's consent screen. Asks for base scopes plus the listed products (or the saved toggles). 409 when the host has not set up that provider's app. Verified accounts only on hosted. |
| GET | `/api/connectors/:provider/callback` | Public OAuth redirect target; stores the token and redirects to `returnTo` with `connected=<provider>` or `connectError=<message>` |
| PUT | `/api/connectors/:id/products` | `{ products: Record<string, boolean>, returnTo? }` → the entry `state`, or `{ reconnect: true, url, needs[], state }` when a product needs access the stored token lacks |
| POST | `/api/connectors/:provider/token` | `{ token, email?, site?, key? }` → `{ ok, account }`. Checks the pasted token with the provider first (github, slack, linear, notion, atlassian, trello, asana, todoist, clickup, monday, and the meeting-notes sources fireflies, fathom, granola, tldv, krisp, jamie, otter; [03 §2.3](03_MODULE_CONTEXT_ENGINE.md#23-meeting-notes-sources)). |
| DELETE | `/api/connectors/:provider?deleteData=1` | → `{ ok, revoked, deleted }`. Revokes where possible, removes the token, switches its sources off; `deleteData` also deletes the artifacts they stored. |
| GET | `/api/connectors/google/picker` | → `{ apiKey, appId, accessToken, origin }` for Google Picker; `accessToken` is null until `drive.file` is granted. 409 without `GOOGLE_PICKER_API_KEY` / `GOOGLE_PROJECT_NUMBER`. |
| GET / PUT | `/api/connectors/apps` • `/api/connectors/apps/:provider` | Instance OAuth apps with redirect URIs and setup steps; saving is operator-only on hosted |
| GET | `/api/mcp-connections` | → `{ connections[] }`: `{ id, serverId, name, url, status (pending\|connected\|error\|disabled), auth (oauth\|bearer\|none), toolCount, tools[{ name, title, description, readOnly }], disabledTools, lastError, toolsSyncedAt, createdAt, updatedAt }`. Never returns tokens ([03 §2.2](03_MODULE_CONTEXT_ENGINE.md#22-remote-mcp-connectors)). |
| POST | `/api/mcp-connections` | `{ serverId }` (a catalog entry with `mcp`) or `{ url, name? }`, plus optional `token` (sent as `Authorization: Bearer`), `clientId`/`clientSecret` (a client the person registered with the vendor) and `returnTo` (a relative Hub path) → `{ id, status, authorizeUrl? }`. `authorizeUrl` means open the vendor's approval page. 400 with `code` `MCP_URL_REFUSED`, `MCP_TOKEN_REQUIRED` (paste a token instead), `MCP_PKCE_UNSUPPORTED` or `MCP_TOKEN_REFUSED`. |
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
| GET / POST | `/api/assistant/conversations` | → the 40 most recent conversations • `{ title? }` → `201 { conversation }` |
| GET | `/api/assistant/conversations/:id/messages` | → `{ conversation, messages }` |
| POST | `/api/assistant/turn` | `{ message, conversationId?, model?, tier?, reasoningEffort?, page?, mentions?, referenceContext? }` → streams the turn (SSE). The first frame is `status { conversationId }`, sent before the model call, so Stop works on a new chat. A quota miss is an `error` frame with `code: model_quota_exceeded` (429, `model`, `resetsAt`); an unreachable model host is `code: model_unreachable` (503). Neither is saved as the reply ([docs/11 §9](11_HOW_THE_ASSISTANT_WORKS.md#9-failure-modes-and-what-catches-them)) |
| POST | `/api/assistant/conversations/:id/stop` | Cancels the running turn → `204` |
| POST | `/api/assistant/apply` | `{ name, input }` or `{ calls[] }` → applies writes the write policy held as a preview (connected-app writes always). Returns `replies[]`: the saved assistant messages, rewritten so they no longer say nothing has changed. When a batch only partly lands: 200 with `partial: true` and `failed[]`; calls already saved as applied are never run again ([11 §8.2](11_HOW_THE_ASSISTANT_WORKS.md#82-connected-apps)) |

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

Fluent v9 with a **Notion-inspired neutral charcoal palette**, compact controls and simple page/card boundaries. No copied Notion assets or remote fonts. Important labels use readable dark red, yellow, blue, green or pink **rectangular fills**; ordinary metadata is plain text. `StatusLabel` replaces pill-shaped Fluent badges throughout the Hub. Priority always has a text label as well as colour: **High/red, Normal/yellow, Low/blue**.

**Appearance:** follows the system by default, with explicit Light and Dark choices in *Settings → Appearance* and a quick header toggle. The preference is saved in `localStorage` and synchronized between tabs. Theme CSS and its initialization script render before the app, including before hydration. Portalled menus, dialogs and drawers use the same CSS-backed Fluent tokens.

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

**Data sources:** Settings → Connections shows five featured connectors (Google Workspace, Microsoft 365, Notion, Linear, GitHub); every other app, including Slack, Jira and the remote MCP servers, is in **Browse connectors** ([§3.9](#39-settings), [18](18_WHAT_IS_REAL.md#connectors-read-only)). Entries the catalog marks `soon` say "Coming soon" and cannot be connected. The sidebar counts actual ready sources. Sample data is opt-in ([docs/03 §11](03_MODULE_CONTEXT_ENGINE.md#11-seed-data-opt-in-only)). **No ADO.**

---

## 10. The Hub assistant

A round launcher (`components/assistant/ask-launcher.tsx`) that expands into a panel. It starts bottom-right and can be dragged anywhere along the bottom or right edge of the content column, never over the sidebar or top bar; it snaps to the nearer edge and the spot is saved in the browser (`ensemble.assistant.launcher`). Arrow keys move it when focused. The shortcut (Command-J by default, configurable in Settings → Shortcuts) still opens it; the launcher no longer prints the shortcut. It is **the only chat surface in Ensemble**, and it is deliberately **not** the front door: the board, the briefing and the approvals queue are. Chat is for the things a board cannot express — *"add todos from today's meeting and update this week's deliverables"* — and for reaching the parts of the tenant no page exposes.

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

**Pages sits directly below Today and can collapse.** The add action remains available while collapsed. Navigation selections use neutral backgrounds rather than colored ribbons; the shell and desk tiles have smaller corners, flat surfaces, and no decorative title dots or accent washes. Accent remains on focus controls, primary actions, and meaningful states. Static Hub UI copy uses simpler punctuation rather than em dashes.

**Add to board** on a note, or **Add page** on the board, links the existing page row to a newly created To do task. **Convert to page** detaches a task's document and moves the old task to Trash, preserving its properties and execution history there. The page keeps its identity, title, document, mentions, annotations, discussions, and diagram links; inline answers are retargeted to the new page/task address. Converting the note back creates a new task, not a restoration of the archived task's properties. Conversion saves pending content first, rejects stale revisions, and is blocked while an inline answer or agent work is active. It deliberately does not add a task-creation Undo entry that could delete the retained document.

The editor tracks an inline request from the moment it starts, before its first server frame. Comment/reply creation and conversion also share a database row lock and recheck ownership/type before writing, so another tab cannot start a reply against a page midway through conversion.

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

**Tables grow from the edge that grows them.** Hovering a table puts a **+** on its right edge and another under its bottom edge: the right one adds a column, the bottom one adds a row, and neither can be ambiguous about which because of where it sits. Columns are resizable by dragging a cell border, and cells carry their alignment.

The controls are an **overlay rather than a node view**. `resizable: true` installs ProseMirror's column-resizing plugin, which owns the table's DOM — it writes the `colgroup` and the drag handles — and a node view competing for the same element is how resizing quietly stops working. The overlay tracks the pointer with a ~26 px reach beyond the table, because a hover zone that stopped at the border would drop the buttons the moment the pointer set off towards one.

Tables round-trip to GitHub-flavoured pipe tables in the Markdown that notes, retrieval and the Context Bridge read, alignment included. Cell text is flattened to one line on the way out: a pipe table cannot express a line break, and emitting one would break every row after it.

Typing **/** opens a filtered menu. Arrows select, Enter or Tab inserts, and Escape dismisses it. Standard Markdown shortcuts and bold, italic and inline code also work. **Slash commands and mentions do not activate inside code.**

**@** first offers **Ask Ensemble**, then people, projects, repositories, tasks/todos, deliverables, skills, diagrams, plots, and dates (optional modules follow their gates). Selecting a category completes its prefix, for example `@people:mi` searches existing people by a partial name. Plots are hierarchical: `@plots:` offers plot spaces, a Saved plots group, and uploaded data files; selecting a space drills into its tiles. `@plot:epochs` and `@plots:epochs` both find a matching file, and the inserted dataset mention retains its stable ID. Entity mentions retain their **kind and stable ID**, not just a display string. Date mentions do **not** change a task's due date. A mention alone is not an instruction to change a task's project, owner, or skills.

Project and deliverable note editors reuse the same blocks while retaining their existing Markdown persistence contracts. Encoded `ensemble://` mention links round-trip back into mentions when Markdown notes are opened.

**Pasting Markdown gives blocks, not a slab.** Plain-text paste used to land verbatim, so a pasted `.md` file arrived as one grey block in which `## Aim` was literally those characters and a checklist was a run of hyphens. A paste whose text carries block-level Markdown is now parsed the same way saved notes are: headings, bulleted and numbered lists, checklists with their checked state, quotes, fenced code, rules, and the inline bold/italic/strike/code/link marks.

Two limits are handled explicitly rather than left to fail:

- The schema stops at heading level 3, so deeper headings are **demoted to level 3**. They stay headings instead of collapsing into body text.
- A pasted Markdown table becomes a real table, with its header row and alignment. (It was briefly kept verbatim in a code block, when pages had no table node; they have one now.)

Conversion is deliberately **conservative**. It needs at least two block-level markers, so prose that merely contains "1." stays exactly as typed — reformatting a paste nobody asked to reformat is worse than not formatting it. Anything the page schema would reject is dropped before it reaches the document, because one unsupported node would otherwise put the whole page into "cannot be saved" and block edits made before the paste. The paste replaces the selection and lands in a single undo step.

### Saving and concurrent edits

Task properties and content save after a short typing pause. **Ctrl+S** saves immediately. Writes are **serialized**: a response for an earlier snapshot never replaces keystrokes typed while it was in flight. HTTP failures and version conflicts leave the draft visible and offer retry or an explicit discard/reload. Leaving with an unsaved draft is guarded; an in-flight save must finish before the peek can be discarded. **Simply opening an editor is never a write.**

The task document endpoint is `GET/PUT /api/tasks/:id/page`; it carries a revision, document, legacy Markdown notes, resolved mentions and run annotations. Writes check the expected revision and notes. The board still receives small task summaries, not document bodies. Mention suggestions are user-scoped and paged through `GET /api/page-mentions?kind=&search=&offset=&limit=`.

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

The floating assistant also uses the mention composer. Alongside visible Markdown, it sends **typed kind/ID references**. The API verifies ownership and resolves canonical names, and includes exact IDs in the tool loop *as data, not additional authority*. Two projects with similar names remain distinguishable.

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

*Context → Graph* presents real stored people/project/repository/task/deliverable/skill/note relationships and page mentions. The overview is bounded and **labels truncation** rather than claiming every database row is visible. Selecting a project/person/task focuses its connected neighbourhood; type filters, zoom, scroll-to-pan, temporary node positioning and direct page links aid inspection. Completed tasks and deliverables are hidden by default, with at most five recent items when enabled. **Reminders never enter this graph or context retrieval.** Dragging graph nodes changes only the local layout, not stored relationships.

Readability (`apps/hub-web/lib/graph-readability.ts`): each node's collision zone is sized from its label box, the camera fits the whole graph on open, and lower-priority labels that would overlap are hidden until you zoom in or select. The fit and every manual zoom share one floor (`MIN_ZOOM` in `components/context/graph.tsx`). In development only, `?graphScale=3` repeats the current graph (capped at 6) and `?graphFixture=seed` forces the seed sample (`lib/graph-fixture.ts`); `next.config.ts` swaps that module for an empty stub in production builds.

### Model presets and capability discovery

*Settings → Assistant → Models* ("Which model each tier uses") defines Low, Medium, High and Max profiles, including the model and any thinking/context options actually advertised and supported by the active transport. The Copilot catalogue is cached for seven days and has an explicit refresh action. The floating assistant selects a preset and shows its configured model; custom per-run overrides are confined to assignment. Inline `@ensemble` uses Low. Saved overrides propagate to the runtime request, not just the UI label. **Unsupported combinations fail before inference.**

The current Copilot discovery response exposes reasoning choices on both transports, and no selectable context tiers at all. The UI therefore offers a thinking level wherever the provider advertises one, and offers **no context-size control**: it reports the model's single context window as read-only information and nothing more. Showing a permanently disabled dropdown was the earlier behaviour, and a control that can never move reads as a bug rather than a limit. Model availability and capabilities may change after refresh. Unknown billing rates remain unknown; the app does not invent a per-request charge for newly discovered models.

### Board card layout, loading and model icons

- Board cards use a **single narrow action rail**: drag above delete. It reserves horizontal space without forcing short titles to the height of two buttons. Agent-output insertion controls are hidden until their local section is hovered or keyboard-focused; touch devices keep them discoverable.
- Columns retain **at least 300 px** of usable card width and scroll horizontally rather than crushing long titles. Card heights stay flexible, with typography following the user's appearance preferences and drag/delete controls in a single keyboard-accessible rail.
- Fetch/agent/run progress uses the shared `LoadingIndicator` / `LoadingStatus` components, driven by actual request/activity state. Their CSS variables are the replacement point for a future custom Ensemble animation. Motion is limited to transform/opacity, never delays an interaction, and respects reduced motion.
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

The two supplied **Lottie animations** are served locally from `apps/hub-web/public/animations/`: `ai-loading.json` for actual agent/model work, `page-loading.json` for page/data waits. The SVG player is dynamically loaded, data is cached, each player gets its own mutable copy, and animations are destroyed on unmount. Hidden/offscreen players pause; reduced motion uses a static frame. **No artificial delay, minimum display period or idle animation** is introduced. Styling hooks live in `loading-indicator.css`; swapping the future custom animation does not require changing the request lifecycle. Fluent's spinner slot is replaced using its supported render function, because the default renderer supplies its own children. The pale AI dots get a light-theme contrast adjustment, including when the theme follows the OS.

Fetch, calendar-sync and refresh icons rotate **only while their own operation is pending**. Successful fetch notices dismiss after five seconds, with the timer reset for every completed fetch. Errors and partial failures stay visible.

Workspace previews prefer the original ask, remove Markdown deterministically, and clamp to three lines; no model is involved. Both completed-work lists show at most five items. Blocked execution has a compact expandable notice, and run metadata uses quiet `#` labels instead of emoji. Preferences render as labelled values/lists rather than JSON. M365 intake follows **Paste → Review → Propose**; Artifacts provides a real file chooser, drag/drop, optional AI enrichment and manual entity tags.

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
| GET | `/api/auth/me` | Identity/appearance/modules plus `user.profile`, `verificationRequired`, `onboardingComplete`, and `profileComplete` |
| PATCH | `/api/auth/me` | `{ name?, password?, current? }`; sensitive password changes require browser authentication |
| PUT | `/api/auth/profile` | Browser session. `{ name, gender?, profession?, organization?, heardFrom? }`; trims optional empty values to `null`, sets `profileCompletedAt`, returns `{ user, profile }` |
| GET / POST | `/api/spaces` | Ensemble spaces: list, create from a template with settings copied, synced or fresh. Also `POST /api/spaces/:id/switch`, `PATCH`/`DELETE /api/spaces/:id`, `POST /api/spaces/settings/copy`, `PUT /api/spaces/settings/sync` ([28](28_ENSEMBLE_SPACES.md) §3) |
| GET | `/api/onboarding/templates?role=` | → `{ templates: [{ id, role, name, blurb, desk, tiles: [key, c, r][], features[3], preview: { project, tasks[], people[], deliverables[] } }] }` for the `/start` previews |
| POST | `/api/onboarding` | `{ role, templateId }` → `{ role, templateId, onboardingComplete }`. Once per account (409 after). Seeds starters, sets the desk and modules, sets `profession` when empty, writes `desk.layout.<desk>` |
| GET | `/api/auth/oauth/:provider/start` | Redirects to login provider; `?link=1` requires an existing browser session |
| GET | `/api/auth/oauth/:provider/callback` | Consumes browser-bound state and returns to a fixed Hub-origin page |
| POST | `/api/auth/verify-email` | Browser session. `{ code }`; normalizes spaces/dashes/case, locks after five wrong tries, consumes the active verification code |
| POST | `/api/auth/resend-verification` | Browser session; sends a fresh code and returns `{ sent }` |
| POST | `/api/auth/forgot` | `{ email }`; generic response, whether an account exists or not |
| POST | `/api/auth/reset` | `{ token, password }`; single use, ends all sessions |
| GET / DELETE | `/api/auth/identities` • `/api/auth/identities/:provider` | List login methods • `{ current? }`; cannot remove the last method |
| GET | `/api/auth/export` | Browser-only JSON attachment of user-scoped records, excluding credentials |
| DELETE | `/api/auth/account` | `{ confirmation: "DELETE", current? }`; recent/password-confirmed browser session, no active agent jobs; removes account data and revokes devices |

`/verify` (`app/verify/page.tsx`, `components/account-recovery.tsx`) is now a code entry page. It shows the signed-in email, posts `{ code }`, offers **Send a new code**, and asks signed-out people to sign in at `/login?next=/verify`. Successful verification follows a safe relative `next` query, then `/start` if onboarding is incomplete, otherwise `/today`.

`/start` (`app/(hub)/start/page.tsx`) is a focused two-step screen without the sidebar, top bar or assistant launcher. The left column asks the questions; the right column previews the desk live.

1. **About you.** Name, then *What do you do?* (Student, Teacher, Lawyer, Engineer, Builder, Manager), plus optional organization and how they heard about Ensemble. The role is saved as the profession, so the question is asked once; gender stays in Settings → Account. Someone whose profile is already complete sees only the role question, preselected from their profession when it matches (`components/onboarding/roles.ts`).
2. **Your desk.** Six templates for that role, each with a small preview. The large preview switches between **Today**, **Board** and **Context**, drawn from fictional sample rows (`components/onboarding/sample.ts`) by the same tile renderer as Today (`PreviewTiles`), scaled to fit. Nothing in the preview is saved.

*Start with …* calls `POST /api/onboarding`, which seeds the template's starters, sets the desk, saves the profession when it was empty, and writes the template's Today layout to `desk.layout.<desk>`. There are 36 templates, six per role, and no two in a role share a Today layout (`packages/shared-types/src/templates/manifest.ts`, checked in `apps/hub-api/src/layouts/layouts.test.ts`).

Settings → Account supports profile editing, linked methods, adding/changing passwords, JSON export and deletion. Sensitive method removal/deletion uses a recent session (10 minutes) or current-password confirmation. Deletion leaves local user files alone; provider copies and infrastructure backup retention are separate. The landing site includes `/privacy`, `/terms`, and direct registration links.

Sign-in and sign-up (`components/auth-form.tsx`) use a split screen: on the left, `components/auth-backdrop.tsx` draws a slow context graph and three app-like cards (a task, an `@ensemble` answer, a chart); on the right, the form. The motion stops under reduced motion, and below 900 px only the form shows.

`emailSignupAvailable` describes method readiness, independently of open/allowlist/closed policy. Hosted email signup requires configured delivery and both Turnstile keys; development and desktop retain no-mail signup. `components/auth-form.tsx` hides an unusable email form, keeps configured social providers, and shows an upfront unavailable message when none can be offered. Existing password logins remain available. Provider configuration and real verification mail still need operator setup; the UI does not bypass those guards.

## 17. Linking a computer, and connecting editors

- **`/link`** (`app/link/page.tsx`, `components/cli-link.tsx`): approves or denies an `ensemble login`. It is a standalone signed-in page; signed-out visitors go to `/login?next=/link?code=…` and come back, and the onboarding redirect skips it so a new account does not lose the code. It shows the computer name, platform, CLI version and requested access ("Read your Ensemble context in editors" and "Run tasks you assign to this computer") with a warning to approve only a code you just started. An unverified hosted account can approve editor access only.
- **Connect your apps** (`/connect`, `components/connect/*`, `lib/connect/{catalog,configs,guides}.ts`): each editor guide offers three methods: Ensemble CLI (recommended; install command per OS, `ensemble login`, `ensemble mcp setup <editor>`, the config it writes), Hosted URL (no install; a read-only key from this page and the `${publicApiUrl}/mcp` snippet), and From source (the earlier developer flow; only this method shows the local bridge status). Editors: VS Code, Cursor, Windsurf, Claude Code, Claude Desktop, Codex & ChatGPT, Gemini CLI, GitHub Copilot CLI, Zed, Visual Studio, JetBrains, Cline, Continue, opencode; macOS, Windows and Linux paths. Each card shows the app's own logo (`components/connect/brand-logos.ts`): Simple Icons marks (CC0) in the brand colour, dark marks on a dark tile, and the vendors' own icons for VS Code, Visual Studio, Codex (OpenAI) and Continue. The logos are their owners' trademarks and only name the app a guide is for.
- **Settings → Devices** (`components/settings/devices.tsx`): "Add a computer with the Ensemble CLI" (install per OS, `ensemble login`, `ensemble folders add`, `ensemble runner install`) above the pairing code, which stays for the desktop app. The assign dialog's empty state points there.
