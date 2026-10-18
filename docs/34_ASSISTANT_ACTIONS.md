# 34 · Assistant actions

Implemented capabilities in the current code, checked 18 Oct 2026. Automated tests use an isolated database and mocked connector APIs. A live GPT-5 mini evaluation used fictional workspaces for todos, dependent actions, tiles, personal skills, settings and precise document edits; it did not call a real user's calendar or import their files. Provider access and source limitations still apply.

## How a request becomes an action

Tools do the work. The Markdown playbooks in `apps/hub-api/src/assistant/skills/` explain which tool to call and how to use its results. They are different from personal Skills, which hold the person's reusable instructions.

`skills/index.ts` routes by the request, mentions and open surface. Explicit intent takes precedence over a page's default playbook. At most two playbooks start loaded; `hub_how_to` loads another when needed. A message that names an app connected in this space (its catalog name, id or vendor: "Vercel", "Hugging Face", "Jira"), or asks about meetings while a meeting-notes app is connected, also loads the connected-apps playbook as a third, so that app's tools are shown. A simple todo request has a short recipe and five tools, including create, lookup and help. Other requests receive core tools plus the relevant playbooks' tools. Ensemble Code uses the same routing plus its local tools. Every model request is capped at 128 schemas, including the diagnostic all-tools mode. The permitted catalog remains the authority for execution.

The system prompt places stable guidance ahead of live workspace state. Personal skill names/descriptions are indexed, and matching bodies are read on demand instead of injecting every body on every turn. Responses function schemas explicitly set `strict: false`: optional arguments must remain optional rather than being normalized into mandatory fields. Both the TypeScript and Python transports keep this behavior. Provider-side caching is conditional; Ensemble does not promise a cache hit.

## Action map

| Request | Tools | Behavior |
| --- | --- | --- |
| Create/change tasks | `hub_create_tasks`, `hub_update_task` | Multiple todos, real links, dates and status; written detail belongs on the task's page |
| Delete many tasks | `hub_delete_tasks` (one: `hub_delete_task`) | `all: true`, a filter (status, owner, tag, project, words) or up to 500 ids; the ids are fixed before the preview, so a task added later is not swept up; one statement, one Undo entry ("Moved 41 tasks to Trash"); an id not on the board refuses the whole change |
| Assign a task to an agent | `hub_list_agent_options`, `hub_assign_to_agent` | "Do this on my machine": the default run profile unless one is named, on the named or the profile's computer; Ensemble's agent, Claude Code, Codex or Cursor's agent; a repository to clone or a folder the computer shared; always waits for Apply |
| Current view | `hub_read_surface` | Reads supported documents, tasks/projects, Today/Board/Context, Files, diagrams/plots, meeting notes, skills/settings (on Settings → Connections, the connected apps from `hub_list_connections`), runs, Code, recap, Completed, Trash, spaces and sharing through scoped tools/routes |
| What is connected | `hub_list_connections` (and the Connected apps block of every prompt) | Every app connected in this space by its catalog name: how (sign-in, token, MCP sign-in, MCP token, MCP without sign-in = public data only), the account label, and the tools that reach it (`apps_search`/`apps_read` with its app id and kinds, its own `mcp_<app>_*` tools, `hub_import_meeting_notes`). MCP servers that were added but are not working are listed apart. Pass `app` to check one. Never returns a token; empty for a guest in a shared space |
| Find or list items in a connected app | `apps_search`, `apps_read` | `app` is the id from its Connected apps line ("vercel", "todoist"…), `kind` narrows it; an empty query, or one that only names a kind ("projects", "all my deployments"), lists recent items of that kind |
| Tiles | `hub_read_layout`, `hub_edit_layout` | Reads the actual profile desk, Board overview, Context panel or alternate widgets view before editing; preserves unrequested tiles and refuses a stale version |
| Precise page edit | `hub_read_page_blocks`, `hub_edit_page` | Nested block paths, revision and exact expected Markdown; replace text, replace/delete a block, or insert before/after; text replacement preserves other formatting |
| Linked actions | `hub_run_workflow` | 2–12 ordered writes under one Apply, with references to earlier results and durable step receipts |
| App relationships | `hub_list_app_relationships`, `hub_manage_app_relationship` | Attach/detach/refresh context, add an app item as a source-linked task, import app people, link/unlink project sources, explicitly merge People |
| Whole-board import | `hub_preview_board_import`, `hub_start_board_import`, `hub_read_import`, `hub_manage_import` | Connected boards/projects or an export already in Files; preview containers/samples/mapping, approve, check progress, cancel or undo |
| Original files | `hub_file_edit_info`, `hub_edit_file` | Hash-guarded exact text changes in Word/PowerPoint/text/code/CSV, and supported spreadsheet cell/row changes |
| File/page conversion | `hub_file_to_page`, `hub_export_page_file` | Convert a supported file to a page, export Word/PDF/Markdown/text into Files, optionally replace a file with its current content hash |
| Personal skills | `hub_list_skills`, `hub_read_skill`, `hub_manage_skill` | Create, read in parts, update with expected version, enable/disable, restore a retained version or Trash |
| Settings | `hub_find_setting`, `hub_get_settings`, `hub_update_settings` | Exact setting keys and allowed values; approved appearance changes reach the active browser |
| Model selection | `hub_list_model_choices`, `hub_choose_model` | Exact available provider/model for a tier; uses existing keys or included credits, without changing credentials |
| Project/repository properties | `hub_update_project`, `hub_update_repo` | Project properties, People/repository links, tracking and description |
| Profile records | `hub_update_desk_item` | Update an existing part/check/objective/timetable/attendance/citation/grade/deploy or specialized task, preserving its ID |
| Other record actions | `hub_move_page`, `hub_manage_record` | Page nesting with cycle checks; one-record restore, page/task conversion, supported diagram/plot/dataset maintenance, file tags and internal comments |
| Calendars | Existing create/list tools plus `calendar_manage_event` / `outlook_calendar_manage_event` | Edit time/title/location/guests, cancel, RSVP and change recurrence; one occurrence and entire series are distinct |
| Calendar choices/availability | `calendar_list_calendars`, `outlook_calendar_list_calendars`, `calendar_free_busy`, `outlook_calendar_free_busy` | Accessible calendars and provider-reported busy intervals; an unavailable attendee is unknown, never free |

Existing meeting notes/imports, reminders/watchers, diagrams, plots, recaps, app search, research and run inspection tools remain available. Email/Teams/Slack sending, arbitrary scheduled routines, OCR and audiovisual understanding are not introduced by this change.

## What the screen contributes

`apps/hub-web/lib/assistant-surface.ts` collects bounded structured view state. Board supplies live filters, visible task IDs and selected IDs; profile desks and Context supply tile geometry; the widgets canvas identifies its view. The dock also sends selected text and a whitelist of URL parameters. The server resolves records in the active space; a supplied ID is never evidence of access. Credentials and arbitrary screen/DOM text are not included.

Profile Today layouts use `desk.layout.<desk>`, Context arrangements use `desk.context.<desk>.<tab>`, and the Board overview uses `desk.board.insights` preferences. The alternate Today/Context widgets views use `/api/layouts/:surface`; Board has no alternate widgets view. Board overview has at most four fixed-size tiles; desks support 12-column geometry. Per-tile filters belong to the widgets view, not profile tiles. `tools/native-layouts.ts` implements this distinction; `packages/shared-types/src/desk-layout.ts` is shared with the UI.

`apps/hub-web/e2e/assistant-tile-catalog.ts` generates `workspace-tiles.generated.ts` from the actual UI definitions. The web test command checks it for drift. After changing those definitions, regenerate with `pnpm --filter @ensemble/hub-web exec tsx --tsconfig tsconfig.json e2e/assistant-tile-catalog.ts`.

## Dependent actions and approval

A workflow step has an `id`, a tool name and typed `input`. A later value may be `{ "$ref": "person.person.id" }`; a task result can be `tasks.tasks.0.id`. References must point backward. Reads happen before proposing the plan. Nested workflows are refused.

Every step is checked against current area/module/app permissions. The approved plan is hashed. `assistant_workflows` stores its receipts by space, actor, conversation and tool-call ID. A retry of the same Apply skips successful steps. A later failure stops the rest and reports completed work; it does not imply rollback of outside changes. A step interrupted while running is not replayed automatically because its external outcome may be unknown. Separate Hub steps can have separate Undo entries.

Route-backed tools use a server-only copy of the original request's authentication headers with `app.inject`. Existing route validation, verification, rate limits, sharing rules and quotas remain in effect. Headers are never model input. Connected-app changes, workflows, settings, agent assignments, personal skill changes and original file changes retain explicit Apply gates; other Hub writes follow the person's write policy (default "Just do it", undoable). A viewer gets no write tools. The owner's private connections/imports and layout writes are not offered to guests.

## Limits and validation

- Explicit calendar creates/updates keep that selected event visible in Ensemble and return `hubEventId` for meeting-note links (`tools/calendar-receipts.ts`). Cancels/declines remove the matching saved copy. This is not an import of unrelated events or a background refresh; live tools remain authoritative for current and recurring events.
- Calendar operations require the provider's access. Google availability asks for `calendar.freebusy` on new consent/reconnection; an older Calendar connection retains existing event features without it. Outlook availability uses work/school scheduling access. Guest updates, invitations, cancellations and RSVP can send calendar notifications.
- Imports use the existing bounded job, mapping, deduplication and Undo rules; starting a job is not completion. Preview state expires after 30 minutes.
- Exact Office text changes preserve surrounding XML and other package files; they do not redesign a slide or edit images. Office editing runs in the existing memory/time-limited worker. Complex spreadsheets retain their existing refusal rules.
- Page export rebuilds the output. Word/PDF layout can differ from the original. PDF uses standard fonts and refuses characters it cannot render reliably; use Word for those documents. Scanned PDFs remain unreadable without OCR.
- Tools cover the app's implemented records, not arbitrary database writes or new UI capabilities. Credentials, permission escalation, sandbox/folder trust and destructive account/data controls remain the person's settings actions.

Primary automated coverage: `assistant/workspace-actions.integration.test.ts`, `assistant/bulk-tasks.integration.test.ts`, `assistant/assign-agent.integration.test.ts`, `tools/calendar-management.test.ts`, the existing connector/import/file/page/skill/settings suites, schema tests and space/sharing tests. `apps/hub-api/scripts/assistant-eval.ts` is an opt-in real-model evaluation using synthetic data; it reports actual input/output/cached-token usage and applies the held changes in its isolated database.
