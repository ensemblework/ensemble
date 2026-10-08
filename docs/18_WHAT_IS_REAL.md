# 18 · What is real, and what is still a placeholder

Updated 2026-09-27. Corrections on 2 Oct and 5 Oct 2026 come from reading the code, not from a new live run, except where a line says it was run. Read this before trusting a button. "Real" here means the code talks to the actual service and was exercised against it; where a live test was not possible, the entry says so.

**Initial checks on 6 Oct 2026:** public signup/OAuth/recovery and hosted safety passed automated HTTP/PGlite tests; Hub and landing production builds passed. Live Gemini plain completion worked, but the deployed assistant's old catalog was rejected for a boolean `exclusiveMinimum`; the draft-7 catalog fix is in code and has a complete-catalog regression. Post-deploy consent/email/assistant checks still require configured provider accounts. The route inventory covers generic gates but is not a complete resource-contract audit.

**Local QA fixes checked 6 Oct 2026:** concurrent task/undo and ledger writes are serialized per account; blank titles are rejected; quoted/multiline CSV exports round-trip. Mac plot startup, process cleanup, resource budgets, and warm rendering passed the Python regressions after fixing Seatbelt path access and the launcher. The Mac memory budget is parent-sampled, not a hard address-space cap. Signup readiness, explicit Code/Workspace/Terminal errors, named Settings controls, responsive header overflow, and a guarded shared task-creation form are implemented with regressions. These checks use isolated local data and mocked identity/model providers, not a claim of newly deployed behavior.

## Changes after review (2 Oct 2026)

The old placeholder said Assign to agent records a job and nothing runs it. That was wrong. `apps/hub-api/src/workspace/worker.ts` claims queued jobs, and `workspace/agent.ts` runs them. The queue is started from `index.ts`. Model turns still go to agent-runtime. See **Code on this computer**. The rest of this page was not re-tested on that date.

## Starting it

```bash
pnpm infra:up
pnpm db:migrate
pnpm dev
```

`pnpm infra:up` starts Postgres and Redis. `pnpm db:migrate` applies migrations and does not reset the database. `pnpm dev` starts the API on port 4000, the site on port 3000, and the agent on port 5055.

`pnpm dev` now starts the model runtime too. `scripts/agent-dev.sh` creates `apps/agent-runtime/.venv` on first run with any Python ≥ 3.11 it can find (the macOS system Python 3.9 is too old).

Open http://localhost:3000. You are sent to **/login**. In development, the first account claims localhost placeholder data and lands on **/start**. Hosted public registration never claims placeholder data.

`ENSEMBLE_DEV_AUTH_BYPASS=true` still gives the old no-login mode for scripts.

## Real today

### Accounts and sign-in
- Sign-up, sign-in, sign-out, profile editing, and password changes (Settings → Account). Passwords are scrypt-hashed; sessions are an httpOnly cookie whose SHA-256 is the only thing stored.
- Public signup remains open after the first account. `ENSEMBLE_SIGNUP_MODE` provides `open`, `allowlist` and `closed`. Google/GitHub/Microsoft identity login, 4-character email verification codes, password reset, linked login methods, account export and deletion are implemented in `routes/auth.ts` and `routes/auth-oauth.ts`; see [02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup). Provider buttons require separate configured `AUTH_*` clients; email requires Resend and Turnstile. Microsoft email ownership is verified by Ensemble, not assumed from an email/username claim. Existing private password accounts are grandfathered as verified by the public-signup migration; existing onboarded accounts are grandfathered as profile-complete by the profile migration.
- Landing `/privacy` and `/terms` are starter policy pages, not a claim of legal review. Registration links no longer describe an invitation requirement; GitHub links are enabled for the now-public repository.
- Every API route requires a session, a personal token (`Authorization: Bearer ens_…`), or the internal token agent-runtime uses. CORS only answers the Hub's own origin.
- The live event stream uses a one-use ticket, because it connects to `127.0.0.1` and the cookie belongs to `localhost`.

### Models
- The model runtime (`apps/agent-runtime`) is the only process that holds model keys (docs/11 §5). hub-api sends the provider and model a tier names; the runtime resolves the key and calls that vendor.
- **Google Gemini**: live. Tested with `gemini-3.5-flash-lite` for chat with tool calls, plain completions, and JSON triage. It is the default on every tier because it is the cheapest; `gemini-2.5-flash-lite` is no longer offered to new keys. The request goes to Google's OpenAI-compatible endpoint with the key as a bearer token.
- **Cursor**: the key is validated and its models listed live (`api.cursor.com/v0/models`). Cursor runs agents, not a chat endpoint, so choosing it for the chat gives a clear error. It is meant for delegated runs (the next step).
- **OpenAI, OpenRouter, Ollama, Anthropic (native Messages API with tools), GitHub Copilot (token exchange)**: the adapters are written. They were not called live, because no keys for them were available.
- **Settings → Assistant → Models → Manage keys** (the *Model providers & keys* dialog): paste a key per provider. It is checked against the provider before it is saved, then stored encrypted per account. A key you paste wins over the server's `.env` key. Hosted public accounts cannot borrow server env/CLI credentials or host Ollama; only verified exact `ENSEMBLE_OPERATOR_EMAILS` accounts can. Dev and desktop retain local fallback behavior. The model catalog is fetched live from each provider. The same dialog has a **Test** button per tier.
- The chat assistant uses the tier's provider. Verified: "add a todo…" produced a real `hub_create_tasks` call through Gemini, held for your approval because the write policy is "preview".

### Connectors (read-only)
Each one calls the real API; triage turns asks into **proposed todos** on Today.

| Source | How you connect | What it reads | Live-tested |
|---|---|---|---|
| Gmail | **Connect Google Workspace** with Gmail on (`gmail.readonly`) | Messages since the last fetch (look-back window after a gap), minus promotions, social and forums. Quoted history stripped. | Earlier with a live Google client. The products/PKCE flow added 7 Oct 2026 is tested with mocked Google responses only. |
| Google Calendar | Same Google Workspace connection with Calendar on (`calendar.events`, `calendar.calendarlist.readonly`) | The calendars shown in Google Calendar (up to 10), last week to three weeks out → the Today calendar | Mocked responses only for the calendar list |
| Outlook mail | **Connect Microsoft 365** with Outlook mail on (`Mail.Read`) | Inbox and sent mail since the last fetch, minus drafts and Focused Inbox "Other". Asks → proposals. | Parsing and paging unit-tested with recorded shapes; not run against a live tenant |
| Outlook calendar | Microsoft 365 with Outlook calendar on (`Calendars.ReadWrite`) | Last week to three weeks out with Teams join links → the Today calendar | Same |
| Teams | Microsoft 365 with Teams on (`Chat.Read`; work or school accounts) | One-to-one and group chats; direct asks and @mentions → proposals. No channels. | Same |
| GitHub | **Sign in with GitHub** (OAuth app) *or* paste a token; `gh auth token` fallback | Your open PRs, PRs waiting on your review, issues assigned to you. Review requests and assignments become proposals directly. | Token validation only: a bad token is rejected by GitHub. `gh` is not installed on this machine. |
| Slack | Paste a user token, or Slack OAuth when the host set up a Slack app | DMs, group DMs, and channels you list in Settings | Token validation only |
| Linear | Paste a personal API key, or Linear OAuth when the host set up a Linear app | Open issues assigned to you → proposals | Key validation only |
| Notion, Atlassian (Jira), Trello, Asana, Todoist, ClickUp, monday.com | Paste a token (Notion, Jira, Zoom, Docusign and others also by OAuth when the host set up that app) | No scheduled sync. The token is checked once and stored for imports and assistant tools. | Token checks tested with mocked responses only |
| Zoom, Docusign | OAuth when the host set up the app | No sync yet; the account is stored for tools | Not run against the live services |
| Fireflies, Fathom, Granola, tl;dv, Krisp, Jamie, Otter | Paste your own API key from the vendor (plans vary: Fathom's free plan has one; Granola needs Business, Otter Enterprise, tl;dv/Krisp/Jamie a paid plan) | Meetings since the last sync (up to 20): transcript, summary, decisions and action items → a meeting note matched to your calendar event; your action items → proposals that cite the meeting; others' → "waiting on" ([03 §2.3](03_MODULE_CONTEXT_ENGINE.md#23-meeting-notes-sources)) | Mocked vendor responses only (7 Oct 2026); not run against live accounts |

Any verified person can connect on the hosted site; only saving the instance OAuth apps is operator-only. Connect asks only for the products switched on (`settings.connectorProducts`); turning one on later asks for that permission alone. **Disconnect** revokes the grant where the provider has an endpoint, removes the token, switches the sources off, and can delete what was read. Details in [03 §2.1](03_MODULE_CONTEXT_ENGINE.md#21-connector-store-oauth-apps-products-and-tokens).

**Remote MCP connectors** (every catalog entry with an `mcp` URL in `packages/shared-types/src/connectors.ts` — 49 ready on 7 Oct 2026, including Notion, Linear, Atlassian, Todoist, ClickUp, monday.com, Airtable, the meeting tools Granola, Fireflies, Fathom, Read AI, Otter, Krisp, Jamie, Avoma, Gong, Grain, Fellow, Supernormal, MeetGeek, Bluedot and Tactiq, and Canva, Miro, Calendly, Cal.com, Pipedrive, Attio, PostHog, Mixpanel, Amplitude, QuickBooks, PayPal, Greenhouse and Ashby — or any pasted MCP server URL): Connect signs in at the vendor with no operator setup (PKCE S256 and `resource`; Client ID Metadata Document on https, dynamic registration otherwise), or takes a pasted token. The assistant then gets that server's tools: reads run, writes wait for Apply. Discovery ran against every catalog server on 7 Oct 2026 without signing in, and Connect ran as far as the vendor's approval page for Notion and Linear. Signing in, token refresh and tool calls are tested only against a mock MCP server. Asana is listed for imports only, because its MCP server needs a client registered with Asana; Atlassian site admins may need to allow Ensemble's domain. Details in [03 §2.2](03_MODULE_CONTEXT_ENGINE.md#22-remote-mcp-connectors).

- **Triage** (the classifier prompt) runs on the low tier. Verified with Gemini: an email asking for load-test numbers "before Thursday" became "Send p95 load test numbers to Rahul", p1, due that Thursday, with the exact sentence quoted. A newsletter in the same batch was skipped. If no model is reachable, a conservative rule-based fallback runs instead, and the extraction row records which one decided.
- **Fetch now**, the per-source **Sync** button, **Sync calendar** on Today, and the assistant's `hub_fetch_now` tool all run the same sync.
- **Scheduled fetching is paused** product-wide until routines replace it: the scheduler skips fetch slots unless the host sets `ENSEMBLE_SCHEDULED_FETCH=on`, whatever older saved fetch times say; Settings → Connections → Fetching shows a paused notice with Sync now, look-back and propose-todos. Fetch now and Sync still work.
- People and repos are learned from what is read. A person is found by any address or handle they are known by (email first); ingest never merges two people, it suggests (`GET /api/people/identity-suggestions`) and you merge (`POST /api/people/:id/merge`). There is no merge screen yet: the routes exist for the UI to come ([03 §4.7](03_MODULE_CONTEXT_ENGINE.md#47-one-person-across-sources-identities)).
- **Project links**: on a project page, *Linked sources* maps a Slack channel, GitHub repo, Linear project or team, or an imported Jira/Notion/Trello container to the project; new artifacts and proposals from it land there, and imports remember their containers ([03 §4.8](03_MODULE_CONTEXT_ENGINE.md#48-project-links)). Tested over HTTP on PGlite with mocked data, 7 Oct 2026.
- The Meeting notes page lists notes from meeting-notes connectors (summary, decisions, your action items, waiting on others, the matched calendar event); a todo proposed from a meeting shows *From meeting* on its page.
- Anything you deleted stays suppressed. Tokens and secret-looking strings are redacted before storage. Connector tokens are encrypted at rest.

### Imports from other apps ([docs/27](27_IMPORTS.md))

| What | State |
|---|---|
| Notion (API and Markdown & CSV zip), Linear, Jira, Trello (API and board JSON), Asana, Todoist, ClickUp, monday.com, GitHub Issues, CSV/TSV with presets for Notion, Asana, Todoist, Jira, Linear and ClickUp exports | Built (`apps/hub-api/src/imports/`, `routes/imports.ts`, `components/imports/import-dialog.tsx`). Titles, due dates, labels, status (mapping editable per import), priority, assignees, descriptions, page bodies and projects. Re-running updates, never duplicates; edited pages are kept; "Undo this import" removes what it created |
| Task labels | Built: `labels` on task create/update/list, chips on board cards, a chip editor on the task page, `#label` board search |
| Tested | 7 Oct 2026: CSV, Trello JSON and Notion zip end to end over HTTP on PGlite (preview, import, re-import, undo, isolation); Notion, Linear, Jira and Todoist importers and a cancelled Linear token import against mocked `fetch`. **No importer has been run against a live vendor account.** Asana, ClickUp, monday.com, GitHub and Trello over the API are built from their current docs without a mocked test of their own |

### Assistant can act in Google and Microsoft apps, and read Zoom, Docusign and Jira

| What | State |
|---|---|
| Read Gmail, Outlook mail, Teams chats, Google and Outlook calendars, Drive and OneDrive files (Docs as Markdown, Sheets as CSV, Word/Excel/PowerPoint as text; PDFs as details only) | Built (`apps/hub-api/src/assistant/tools/google/`, `tools/microsoft/`). Offered only for a connected suite and the products switched on. |
| Create and change calendar events with invites (Google Meet or Teams link optional); create and edit Google Docs, Sheets and Slides and Word, Excel and PowerPoint files (new Office files go to OneDrive/Ensemble) | Built. **Every change waits for Apply**, whatever the write policy says, is not offered while the assistant setting `assistant.connectedAppWrites` is off, and is recorded in the audit ledger as `apps.<tool>` with its link. No undo. |
| Read Zoom meetings, cloud recordings, transcripts and AI Companion summaries; Docusign envelopes and who still has to sign; Jira issues by JQL with descriptions and comments | Built, read only (`apps/hub-api/src/assistant/tools/zoom.ts`, `docusign.ts`, `jira.ts`). Offered whenever that account is connected. Jira works with OAuth or a pasted API token. Zoom recordings, transcripts and summaries need a paid Zoom plan, and summaries need `meeting:read:summary` on the host's Zoom app. Tested 7 Oct 2026 with mocked vendor responses only. |
| Tested | 7 Oct 2026 with mocked Google and Graph responses and the Apply path against a local Postgres. **Not run against a live Google or Microsoft account.** The host's Google Cloud project needs the Gmail, Calendar, Drive, Docs, Sheets and Slides APIs enabled. Details in [11 §8.2](11_HOW_THE_ASSISTANT_WORKS.md#82-connected-apps). |

### Needs me: a real router for other agents' permission prompts
- A hook in **Cursor** (shell commands and MCP calls), **Claude Code** (every permission prompt), or **VS Code Copilot agent** (tool calls that change things) holds the tool call open and posts it to Ensemble. The card appears on Needs me live. **Allow once**, **Allow for this session**, **Always allow**, or **Deny** (with a reason) goes back to that exact call, in each tool's own output format.
- Verified end to end with the real hook script and each editor's payload shape. Cursor received `{"permission":"allow"}`; the same command in the same session was then allowed at once by the rule. Claude Code received a `PermissionRequest` deny with the reason. Copilot received a `PreToolUse` allow. Read-only tools (read_file and the like) never prompt.
- If Ensemble is down, or nobody answers within 10 minutes, the editor shows its own prompt. **The hook never allows on its own.**
- Setup: Settings → Connections → Editors & agents → *Answer permission prompts from Needs me* → Create token, then run the one install command shown for each editor. `scripts/ensemble-hook.mjs install|uninstall` writes `~/.cursor/hooks.json`, `~/.claude/settings.json`, or `.github/hooks/ensemble.json` and keeps any hooks already there.
- Standing answers ("always allow `npm test`") are listed and removable in Settings.
- **Not yet tested inside the real editors on this machine.** Restart the editor after installing, and check its Hooks panel or output channel if a prompt does not arrive.

### Settings that now do something
- **Models, Connections, Editors & agents, Account**: as above.
- **Fetching**: scheduled fetching is paused (above), so Settings shows no schedule; look-back and "propose todos" are honoured by Sync now and triage.
- **Settings layout** (read from the code and checked with the hub-web tests, 7 Oct 2026): five tabs in the address (`/settings?tab=…`), old `#anchors` still land, Model providers & keys and What it may change open as dialogs, and Connections has five featured connectors plus the connector store ([02 §3.9](02_MODULE_INTERACTION_HUB_UI.md#39-settings)).
- **Data retention**: a daily pass at 03:30 local time purges soft-deleted rows older than the window, plus old notifications and answered decisions. The purge is recorded in the ledger.
- **Desktop reminders and quiet hours**: while a Ensemble tab is open, due reminders pop up as browser notifications, held during quiet hours. Editor decisions notify even in quiet hours, because a tool call is waiting.
- Appearance, the assistant's write policy and areas, terminal folders, and deleted items were already real.
- **Folders Code can use** is its own list, separate from the terminal's ([16 §1](16_CODE_TAB.md#folders-code-can-use)).

### Code on this computer
- **Assign to agent** creates a `WorkspaceJob` (`routes/agents.ts`). `startAgentQueue` in `index.ts` starts the queue. `worker.ts` claims a queued job and calls `executeJob` in `agent.ts`, which prepares the folder, calls agent-runtime for each model turn, and runs the tools. A job that was running when the process died is marked interrupted on the next launch.
- The sandbox is macOS-only (`sandboxAvailable` in `guard.ts`). On Linux and Windows the same job can run as "This machine", with the argument allow-list and the path jail, and without Seatbelt.
- `unattended` is stored per job: a local code job keeps the assigner's choice (`workspace/assign.ts`), and a job sent to a paired device is always `false`. `orchestration.runWithoutAsking` lets commands in a trusted folder run without a prompt (`silentWorkspace` in `workspace/trust.ts`).
- Choosing Cursor as the model for a local task is refused. Cursor's cloud agents are a different path.

## Cowork surfaces (feature-one)

In-app, not email. Schema change is `20260929180000_cowork_surfaces`.

- **Morning brief**: Settings → Morning brief (default 08:00, on). The scheduler writes one `notifications` row per local day (`kind: morning_brief`, `channel: hub`) from the same today briefing the Context Bridge uses. The bell shows it. Quiet hours do not send it as a desktop popup.
- **Quick capture**: `POST /api/capture`. Command-Control-Shift-U on macOS, Ctrl+Alt+Shift+U on Windows and Linux, also C in the Hub when you are not typing. The global hook is a Tauri shell at `apps/quick-capture` ([docs/20_QUICK_CAPTURE.md](20_QUICK_CAPTURE.md)). Parsing stays in hub-api.
- **Meetings**: ambient cards on Today (not a modal), keyboard notes, confirmation before attaching notes onto the calendar event stored in Ensemble. Declining keeps them under Meeting notes, with a cross-meeting question box. **Calendar sync is read-only**, so attach does not update Google or Outlook. Voice is a TODO; there is no microphone.
- **Ask Ensemble**: the bar in the top of every page. It searches with the existing Hub search and read helpers and links each source.
- **Weekly recap**: `/recap`, copy or download. Meeting rows are the per-meeting recap text.
- **Quiet nudges**: Settings → Quiet nudges, default 14 days. Keep, snooze (7 days), done, or Trash.
- **Shortcuts**: `packages/shared-types/src/shortcuts.ts` is the only binding list. The help sheet is `?`. Alt+Shift+T cycles starred code themes (not Ctrl+Alt+T).

## Code themes (feature-themes)

The code review space has a VS Code theme picker. Built-in themes live in `@ensemble/ide-theme`. Open VSX themes are fetched through hub-api (`/api/themes/search`, `/api/themes/openvsx`) and cached under `.theme-cache` (gitignored). The choice is `ideTheme` on the user settings document, so there is no database migration. Star up to three themes; Alt+Shift+T switches between them.

## Hub polish pass (8 Oct 2026, local checkout)

- **Shell:** the top bar is a title, a centred Ask bar and one right-hand cluster ending in an initials avatar with an account menu (Account settings, Assistant and models, Connected apps, Keyboard shortcuts, theme, Sign out). Pages starts collapsed. The assistant opens from a round launcher that can be dragged along the bottom or right edge and remembers where it was. Its empty state greets the person by first name with three generic starters. Settings has a **Shortcuts** tab where bindings can be changed; chords the browser or macOS own are refused ([02 §3.9](02_MODULE_INTERACTION_HUB_UI.md#39-settings)).
- **Today:** persona-desk tiles can be resized from the corner (with per-tile minimums), moved by the grip, hidden, and added back. *Add a tile* also offers live tiles from other desks. The arrangement is saved per desk and *Reset layout* returns to the signup template's ([02 §3.1](02_MODULE_INTERACTION_HUB_UI.md#31-today-morning-briefing)). Desk names ("Branch desk lens", "You're on …") are no longer shown.
- **Context:** every desk has People, Projects, Graph and Artifacts tabs, so people can be added and the graph is reachable whatever template was picked ([02 §3.5](02_MODULE_INTERACTION_HUB_UI.md#35-context-engineer-graph-explorer)).
- **Onboarding:** one role question (no second profession field), then six templates per role, 36 in all, each with its own Today layout, previewed live as Today, Board and Context from fictional sample rows ([02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup)). The static SVG template images and their render script are removed.
- **Sign-in:** a split screen with a decorative, slow context graph; motion stops under reduced motion.
- **Pages:** plot and diagram embeds keep the page width and have a height handle (160 px minimum) saved on the mention ([20 §8](20_PLOTS_DESIGN.md#8-tiled-workspace)).

**Checked 8 Oct 2026:** all-package TypeScript checks, the production Hub UI build, 245 Hub UI checks, 34 shared-type checks, 3,560 public API checks, the template and layout checks, and the route inventory passed. The rest of the API suite passed 363 checks; 79 that need Postgres, including the onboarding integration check that now asserts the saved desk layout and profession, were skipped because no database was running. Locally, `REDIS_URL` must reach Redis or be `memory://`, otherwise two assistant and runtime tests wait for it. Browser checks used an isolated PGlite API with headless Chrome at 1440 × 900 in dark and light: signup onboarding for a new and a returning profile, applying a template and landing on its exact Today layout, corner and keyboard resizing, moving, hiding, restoring, borrowing and resetting tiles with the result surviving reload, Context tabs with *Add person* and the graph, the avatar menu, dragging the launcher (position kept after reload), the assistant greeting, the Shortcuts tab, resizing a diagram embed (kept after reload, clamped at the minimum), and sign-in and sign-up in both themes. Nothing was deployed and no live model was called. Independent Ensemble spaces are still not built.

## Hub UI and editor pass (7 Oct 2026, local checkout)

The focused in-memory API and editor regressions were run locally, not against a deployed service. Navigation and tiles use quieter neutral selections and smaller corners, Pages is collapsible below Today, and new tasks open immediately as untitled documents. Notes can be added to the board and tasks converted back to pages while retaining their document/discussions/diagram links ([02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages)).

Inline `@ensemble` requests now include standalone-page and live-editor context. New diagrams and plots are created through real tool calls and attached beneath the answer; other writes still follow approval settings. Plot spaces can be named/switched, file/tile mentions are hierarchical, and embedded plots render real charts with compact/remove controls. The sample-data entry point is removed ([20 §8](20_PLOTS_DESIGN.md#8-tiled-workspace)).

**Independent Ensemble spaces remain a separate implementation pass.** Plot spaces do not isolate account context, connectors, tasks, or agent retrieval. This change does not claim workspace-level isolation.

**Checked 7 Oct 2026:** all-package TypeScript checks, the production Hub UI build, 3,166 public API checks, 33 shared-type checks, and all 190 Hub UI checks passed. Focused editor/plot/page tests passed. Browser checks used an isolated PGlite account and mocked model transport, covering immediate task creation, page/task round-trip, mention selection before sending, actual chart sizing, removal surviving reload, and plot-space creation/switching. No live-model or deployment claim is made. The earlier assistant-message test-process timeout was a retained mutation-cache timer; its test client now uses zero mutation garbage-collection time, matching the other isolated UI tests without changing application behavior or weakening the Apply/reload assertions.

## Added since 27 Sep (read from the code on 5 Oct 2026)

These are on `main` and have their own docs. They were not re-tested live for this page.

- **Plots** (`/plots`): charts from uploaded tables with ECharts on screen and matplotlib for publication export. Export runs in agent-runtime (`ensemble_agent/plots/`) or, on desktop, the computer's own `python3`. See [20 · Plots](20_PLOTS_DESIGN.md).
- **Block diagrams** (`/diagrams`): a text DSL in `packages/block-diagrams`, revisions in `apps/hub-api/src/diagrams/`, and assistant tools to draw them. See [21](21_BLOCK_DIAGRAMS_DSL.md) and [22](22_BLOCK_DIAGRAMS_FOR_AGENTS.md).
- **Desktop app** (`apps/desktop`): a Tauri window with a static export of the site and a local hub-api sidecar on PGlite. No Docker. Model calls run in-process. See [DESKTOP.md](DESKTOP.md) and the [Mac checklist](desktop/MAC_CHECKLIST.md).
- **Remote tasks on your computer**: pair a computer under Settings → Devices (`/api/devices/*`), then choose it under *Run on* when assigning. The desktop app claims and runs the job and asks for approvals through Needs me (`apps/hub-api/src/remote/`, `src/devices/`). See [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).
- **Templates, desks and marketplace**: role templates at signup, the Today desk widgets, and the marketplace (`/marketplace`, `apps/hub-api/src/marketplace/`, `src/layouts/`). See [`design/`](design/) and [DEMO_DATA.md](DEMO_DATA.md).
- **Hosting**: a VM deploy with Caddy and systemd (`infra/deploy/`) and production start-up checks (`apps/hub-api/src/lib/production.ts`).
- **CI and deploys** (added 5 Oct 2026): `.github/workflows/ci.yml` checks every pull request and push to `main`; `deploy.yml` then moves the `production` branch, the VM follows it (`infra/deploy/autodeploy.sh`), and the Hub and landing page are published on Vercel ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)). `ci.yml` passes on GitHub; the VM half of the deploy was run against a local git remote. `deploy.yml` has not run against a live VM or Vercel project yet.
- **Landing page** (`apps/landing`): a static one-page site for ensemblework.com that links to the hosted Hub. GitHub links stay hidden until `repoPublic` in `apps/landing/lib/site.ts` is true.

## Merged on 5 Oct 2026 (#88, #90, #92, #95, #89)

Checked on 5 Oct 2026 with the hub-api, hub-web and agent-runtime suites on a fresh migrated database. The assistant fixes were also run live against Gemini in an earlier recheck. Nothing here was re-tested in a browser for this page.

- **Standalone notes**: pages with no task, in the sidebar and at `/pages/[id]` ([02 §13](02_MODULE_INTERACTION_HUB_UI.md#standalone-notes)).
- **Code folders**: the Code tab's folder list is separate from the terminal's and is checked on add and on use ([16 §1](16_CODE_TAB.md#folders-code-can-use)).
- **Assistant errors**: a used-up quota is `model_quota_exceeded` with a reset time, with no silent retry or model switch. An unreachable model host is `model_unreachable` in both runtimes. Neither is saved as the reply. Stop works on the first message of a new chat ([11 §9](11_HOW_THE_ASSISTANT_WORKS.md#9-failure-modes-and-what-catches-them)).
- **Context graph**: labels no longer pile up; the camera fits the graph ([02 §13](02_MODULE_INTERACTION_HUB_UI.md#context-graph)).
- **Triage due times** are read in your time zone. A `due_time` wins; an ISO time with `Z` or an offset keeps that instant; no time means 17:00 (`apps/hub-api/src/connectors/triage.ts`). When the model's JSON cannot be read, triage logs a warning and the rule-based fallback runs.
- **Hosted plot exports**: a queued export waits at most 110 s before the busy reply, under Vercel's 120 s proxy cut, and the plot child's process group is killed at its time limit ([20](20_PLOTS_DESIGN.md)).

The earlier Mac “plot runtime is not available” failures also reproduced on Python 3.12. The local QA fix addresses interpreter/worker path grants and direct-launch lifecycle, rather than attributing them to Python version alone. Python 3.12 plot regressions now pass on this checkout; native Windows/Linux installer UX was not rechecked.

## Ensemble CLI and hosted MCP (6 Oct 2026)

Checked on 6 Oct 2026 on macOS (Apple Silicon) against a local hub-api and Hub with an isolated database ([26 §9](26_CLI.md#9-verified)).

- **`ensemble` CLI** (`apps/cli`): device login through `/link`, pairing this computer, sharing folders, the runner (a code task assigned from the hosted API finished on the Mac with the `mock` model), `ensemble mcp`, editor setup, status/doctor, logout (key revoked, device removed). Not run here: Windows and Linux archives (CI builds and smoke-tests them), `runner install` against real service managers, real editors other than an MCP SDK client.
- **Hosted MCP** at `POST /mcp` (`apps/hub-api/src/routes/mcp.ts`): same 17 tools as the local bridge, bearer `ens_` key only.
- **Installers**: Homebrew tap (`ensemblework/homebrew-tap`), Scoop bucket (`ensemblework/scoop-bucket`), `install.sh`, `install.ps1`, `.deb`/`.rpm` come from `.github/workflows/cli-release.yml`; `cli-v0.1.0` is published (6 Oct 2026). winget, npm and AUR files are produced but not published ([26 §1](26_CLI.md#1-install)).
- **Guides**: `ensemblework.com/download`, Connect your apps (CLI, hosted URL, from source per editor and OS), Settings → Devices.

## Still a placeholder

- **Autonomy and Orchestration settings** are stored. The running queue uses `maxConcurrentJobs`, and a job uses its minute, turn and tool limits, the sandbox-network default, and `runWithoutAsking` (above). `defaultDelivery` only pre-selects the choice in the Assign dialog; the runner does not read it. Check the unattended rules in [doc 24](24_DESKTOP_SANDBOXING.md) against `workspace/trust.ts` before relying on them.
- **Context Bridge** (read-only MCP for editors) is built, locally (`ensemble mcp` or from source) and hosted at `/mcp`. Setup, tools, and the entities this schema does not have are in [CONTEXT_BRIDGE.md](CONTEXT_BRIDGE.md). It reads hub-api over HTTP. It does not write.
- **Skill mining**, **embeddings / semantic retrieval**, and **Metrics baselines**: unchanged.
- **Sending** mail replies or PR comments: drafts and approval cards exist, but no connector asks for a send scope. The write scopes Connect can ask for (`calendar.events`, `drive.file`, `Calendars.ReadWrite`, `Files.ReadWrite`) are for assistant tools that wait for Apply ([11](11_HOW_THE_ASSISTANT_WORKS.md)).

## One-time Google setup (whoever runs this Ensemble)

Gmail and Calendar share one **Sign in with Google** button. People using Ensemble never open Google Cloud. The host does this once. It is separate from the Gemini key.

The console is now **Google Auth Platform** (not the old “OAuth consent screen” menu).

1. [Audience](https://console.cloud.google.com/auth/audience): External, publishing status Testing.
2. Branding: app name, support email = your Gmail. Save before adding test users. If Google says an address is ineligible, Branding or Data Access was not saved yet.
3. Data Access: add scopes `gmail.readonly`, `calendar.events`, `calendar.calendarlist.readonly` and `drive.file` (and `drive.readonly` only if you offer Search all of Drive). Enabling the APIs in the Library is not this step.
4. Clients → Web application. Redirect URI: `http://localhost:4000/api/connectors/google/callback`.
5. Paste the client ID and secret in **Settings → Connections → Google Workspace → Set up once** (shown to the operator only), or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`. Without them the sign-in client (`AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET`) is used, so add the redirect URI above to that client.
6. Audience → Test users: add each Gmail that will press the button, including yours. While the app stays in Testing, Google blocks everyone else. Publishing Gmail access for the public needs Google’s own verification, which is a later step.

After that, each person presses **Connect** on Google Workspace and approves the products they switched on. Nobody else sees the secret.

GitHub sign-in works the same way with a GitHub OAuth App (callback `http://localhost:4000/api/connectors/github/callback`). A pasted fine-grained token needs no setup. Microsoft 365, Linear, Notion, Atlassian, Slack, Zoom and Docusign apps are set up the same way; the steps for each are in Settings → Connections → Browse connectors → the connector → Set up once (`GET /api/connectors/apps`).

## Where things live

| Piece | Files |
|---|---|
| Accounts, sessions, tokens | `apps/hub-api/src/lib/auth.ts`, `routes/auth.ts`, `apps/hub-web/app/login`, `app/signup`, `app/(hub)/welcome` |
| Model runtime | `apps/agent-runtime/ensemble_agent/models.py`, `credentials.py`, `vault.py`, `main.py`; the desktop in-process path is `apps/hub-api/src/runtime/` |
| Connectors | `apps/hub-api/src/connectors/{google,microsoft,github,slack,linear}.ts`, `oauth.ts`, `accounts.ts`, `tokens.ts`, `products.ts`, `catalog.ts`, `token-providers.ts`, `forget.ts`, `ingest.ts`, `triage.ts`, `sync.ts`, `routes/connectors.ts` |
| Scheduler and retention | `apps/hub-api/src/jobs/scheduler.ts` |
| Decision router | `apps/hub-api/src/lib/decisions.ts`, `routes/decisions.ts`, `scripts/ensemble-hook.mjs`, `apps/hub-web/components/needs-me/editor-decisions.tsx` |
| Settings UI | `apps/hub-web/app/(hub)/settings/page.tsx`, `components/settings/` (tabs, dialogs, sections), `components/connectors/` (store, detail, logos), `lib/api-connectors.ts` |
| Shared encryption key | `ENSEMBLE_SECRET_KEY`, or `.ensemble/secret.key` (git-ignored, created on first use) |
| Smoke test | `pnpm --filter @ensemble/hub-api exec tsx scripts/smoke-triage.ts` (two sample emails through live triage) |
