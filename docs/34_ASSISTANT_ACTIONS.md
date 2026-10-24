# 34 · Assistant actions

What the assistant can do, by request, and the tools that do it. Tools live in `apps/hub-api/src/assistant/tools/`, playbooks in `assistant/skills/`. How a turn picks tools, applies writes and runs workflows is in [11](11_HOW_THE_ASSISTANT_WORKS.md).

## 1. Action map

| Request | Tools | Behavior |
| --- | --- | --- |
| Create or change tasks | `hub_create_tasks`, `hub_update_task` | Several todos at once, real links, dates and status; detail goes on the task's page |
| Delete many tasks | `hub_delete_tasks` (one: `hub_delete_task`) | `all: true`, a filter (status, owner, label, project, words) or up to 500 IDs; IDs are fixed before the preview, so later tasks are not swept up; one statement and one Undo entry ("Moved 41 tasks to Trash"); an ID not on the board refuses the whole change |
| Assign a task to an agent | `hub_list_agent_options`, `hub_assign_to_agent` | Ensemble's agent, Claude Code, Codex, Cursor's agent or GitHub Copilot (`copilot-cli`), with the model, thinking level and context window the person names; a repository to clone or a folder the computer shared; a named branch and a pull request into an allowed base, merged on approval or when checks pass; profile and computer choice in [11 §8.3](11_HOW_THE_ASSISTANT_WORKS.md#83-running-work-code-and-settings) |
| Current view | `hub_read_surface` | Today, Board, Context, pages/tasks/projects, meeting notes, Files, plots, diagrams, skills, settings (on Connections: the connected apps), Needs me, runs, Code, Completed, Trash, recap, spaces, sharing |
| What is connected | `hub_list_connections` | Each app connected in this space: how, account, tools; failing MCP servers apart; `app` checks one. Never returns a token; empty for a guest ([11 §3](11_HOW_THE_ASSISTANT_WORKS.md#3-context-and-prompt-size)) |
| Find or list items in a connected app | `apps_search`, `apps_read` | `app` is the id from its Connected apps line ("vercel", "todoist"), `kind` narrows; an empty query or one that only names a kind ("all my deployments") lists recent items |
| Post back to a linked issue | `apps_post_update` | Comment on the issue, card or ticket a task came from |
| Tiles | `hub_read_layout`, `hub_edit_layout` | Reads the actual layout first; keeps unrequested tiles; refuses a stale version (§3) |
| Precise page edit | `hub_read_page_blocks`, `hub_edit_page` | Nested block paths, revision and exact expected Markdown; replace text (formatting kept, `find` must occur once), replace or delete a block, insert before/after |
| Linked actions | `hub_run_workflow` | 2–12 ordered writes under one Apply with `$ref` to earlier results ([11 §6](11_HOW_THE_ASSISTANT_WORKS.md#6-apply-undo-and-dependent-actions)) |
| App relationships | `hub_list_app_relationships`, `hub_manage_app_relationship` | Attach, detach or refresh context; app item → source-linked task; import app people; link/unlink project sources; merge People on request |
| Whole-board import | `hub_preview_board_import`, `hub_start_board_import`, `hub_read_import`, `hub_manage_import` | Connected boards or an export in Files; preview containers, samples and mapping; start, check, cancel or undo |
| Original files | `hub_file_edit_info`, `hub_edit_file` | Hash-guarded text changes in Word, PowerPoint, text, code and CSV; spreadsheet cell/row changes (1-based) |
| File ↔ page | `hub_file_to_page`, `hub_export_page_file` | File to page; page to Word, PDF, Markdown or text in Files, optionally replacing a file by its content hash |
| Personal skills | `hub_list_skills`, `hub_read_skill`, `hub_manage_skill` | Create, read in parts, update with `expectedVersion`, enable/disable, restore a version, delete |
| Settings | `hub_find_setting`, `hub_get_settings`, `hub_update_settings` | Keys in `ASSISTANT_SETTING_KEYS` (`packages/shared-types/src/settings-map.ts`) and allowed values; Undo restores them; appearance changes reach the open browser |
| Model selection | `hub_list_model_choices`, `hub_choose_model` | Exact available provider/model for a tier, on existing keys or included credits; credentials unchanged |
| Projects, repositories | `hub_update_project`, `hub_update_repo` | Project fields, People and repository links (`personIds`/`repoIds` replace the list); repository tracking and description |
| Profile lists | `hub_update_desk_item` | Update an existing part, check, objective, timetable, attendance, citation, grade, deploy or similar entry, keeping its ID |
| Other records | `hub_move_page`, `hub_manage_record` | Page nesting with cycle checks; restore one record, convert page ↔ task, diagram/plot/dataset maintenance, file tags, internal comments |
| Calendar changes | `calendar_manage_event`, `outlook_calendar_manage_event` (plus the create/list tools) | Time, title, location, guests, cancel, RSVP, recurrence; one occurrence and the whole series are distinct |
| Calendars and availability | `calendar_list_calendars`, `outlook_calendar_list_calendars`, `calendar_free_busy`, `outlook_calendar_free_busy` | Accessible calendars and provider-reported busy intervals; an unknown attendee is never free |

**Built-in app tools** (shown when granted and the product is on): Gmail `gmail_search`, `gmail_read`; Google Calendar `calendar_list_events`, `calendar_create_event`, `calendar_update_event`; Drive `drive_list_files`, `drive_read_file`; Docs `docs_create`, `docs_append`, `docs_replace_text`; Sheets `sheets_create`, `sheets_read`, `sheets_update_range`, `sheets_append_rows`; Slides `slides_create`, `slides_read`; Outlook `outlook_search_mail`, `outlook_read_message`, `outlook_calendar_list_events`, `outlook_calendar_create_event`; Teams `teams_list_chats`, `teams_read_chat`; OneDrive `onedrive_search`, `onedrive_read_file`; `word_create`, `word_update`, `excel_create`, `excel_read_range`, `excel_update_range`, `powerpoint_create`; Zoom `zoom_list_meetings`, `zoom_list_recordings`, `zoom_get_transcript`, `zoom_get_meeting_summary`; DocuSign `docusign_list_envelopes`, `docusign_get_envelope`; Jira `jira_search`, `jira_get_issue`. Remote MCP tools are named `mcp_<server>_<tool>`.

**Playbooks** (`hub_how_to` takes the name): `tasks`, `pages`, `context` (people, projects, repositories, profile lists), `calendar`, `meeting-notes`, `inbox` (mail and chats), `files`, `apps`, `layouts`, `agents` (assignments, runs, Code), `workflows`, `recap`, `settings`, and with their module `diagrams`, `plots`, `personal-skills`. Their `tools:` lines cover the remaining tools, including reminders, watchers, research and run inspection.

## 2. Writes that always wait for Apply

Whatever the write policy, these wait for Apply ([11 §6](11_HOW_THE_ASSISTANT_WORKS.md#6-apply-undo-and-dependent-actions)):

- Every connected-app write (area `apps`): built-in app writes, calendar changes, `apps_post_update`, MCP tools.
- `alwaysHold` tools: `hub_update_settings`, `hub_choose_model`, `hub_assign_to_agent`, `hub_run_workflow`, `hub_manage_skill`, `hub_edit_file`, `hub_export_page_file`, `hub_manage_app_relationship`, `hub_start_board_import`, `hub_manage_import`, `hub_import_meeting_notes`.

Other Hub writes follow the person's policy (default "Just do it", undoable). Viewers get no write tools. The owner's private connections, imports and layout writes are not offered to guests.

## 3. Tiles and layouts

`tools/native-layouts.ts` implements the layouts; `packages/shared-types/src/desk-layout.ts` is shared with the UI.

| Surface | Stored in | Limits |
| --- | --- | --- |
| Profile Today desk | Preference `desk.layout.<desk>` | 12-column grid; tiles up to 12 columns and 8 rows, at least 3 × 2 (more for some tiles, `tileLimits`) |
| Context panel | Preference `desk.context.<desk>.<tab>` | As desks |
| Board overview | Preference `desk.board.insights` | At most four fixed-size tiles; add, remove, move only |
| Today/Context widgets view | `/api/layouts/:surface` | Per-tile filters live here only; Board has no widgets view |

`apps/hub-web/e2e/assistant-tile-catalog.ts` generates `packages/shared-types/src/workspace-tiles.generated.ts` from the UI definitions; `pnpm --filter @ensemble/hub-web test` fails on drift. After changing tile definitions run `pnpm --filter @ensemble/hub-web exec tsx --tsconfig tsconfig.json e2e/assistant-tile-catalog.ts`.

## 4. Limits

- **Calendars.** An explicit create or update keeps that event visible in Ensemble and returns `hubEventId` for meeting-note links (`tools/calendar-receipts.ts`); cancel or decline removes the saved copy. Nothing else is imported or refreshed in the background; live tools stay authoritative. Google availability needs the `calendar.freebusy` scope, requested on consent or reconnection; a connection without it keeps event features. Outlook availability needs work/school scheduling access. Guest changes, invitations, cancellations and RSVPs can email attendees.
- **Imports** use the existing bounded job, mapping, deduplication and Undo rules; starting is not finishing. A preview expires after 30 minutes.
- **Office edits** keep surrounding XML and other package files; they do not redesign slides or edit images, and run in the memory- and time-limited worker. Complex spreadsheets are refused.
- **Page export** rebuilds the file, so Word or PDF layout can differ. PDF uses standard fonts and refuses characters it cannot render; use Word for those. Scanned PDFs are unreadable (no OCR).
- **Not offered:** sending email, Teams or Slack messages; arbitrary scheduled routines; OCR; audio or video understanding; arbitrary database writes. Credentials, permission escalation, sandbox and folder trust, and destructive account or data controls stay the person's own settings actions.

## 5. Tests

`assistant/workspace-actions.integration.test.ts`, `bulk-tasks.integration.test.ts`, `assign-agent.integration.test.ts`, `tools/calendar-management.test.ts`, plus the connector, import, file, page, skill, settings, schema and space/sharing suites. Automated tests use an isolated database and mocked connector APIs. `apps/hub-api/scripts/assistant-eval.ts` is the opt-in real-model evaluation ([11 §11](11_HOW_THE_ASSISTANT_WORKS.md#11-limits-and-evaluation)).
