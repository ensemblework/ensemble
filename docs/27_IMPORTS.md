# 27 · Imports from other apps

Ensemble imports work from Notion, Linear, Jira, Trello, Asana, Todoist, ClickUp, monday.com, GitHub Issues and any spreadsheet: titles, due dates, labels and tags, status, priority, assignees, descriptions, page content and projects. Running an import again updates what came over instead of adding copies, and **Undo this import** removes what an import added.

Code: `apps/hub-api/src/imports/` (importers and writer), `apps/hub-api/src/routes/imports.ts` (API), `apps/hub-web/components/imports/` (dialog, summary, recent list), `apps/hub-web/lib/api-imports.ts` (client). Labels on tasks: `packages/shared-types/src/domain.ts` (`TaskLabels`), `apps/hub-api/src/services/tasks.ts`, `apps/hub-web/components/task/labels.tsx`. No test calls a real vendor API.

## 1. How it works

1. **Pick the app** in the import dialog (`ImportDialog`). It opens from Settings → Connections, the Board's **Import** menu (*Import a board…*) and the Pages sidebar (*Import from Notion*, which starts on Notion).
2. **Connect or upload.** Use the account connected in Settings → Connections, paste a token, or upload the app's export. A pasted token stays in server memory for this import only (at most 30 minutes); it is never written to the database or logs.
3. **Choose** databases, projects, boards, teams, lists or repositories. Counts show where the app reports them cheaply.
4. **Review.** Each status value found (in the file, or a first page sampled from the API) gets an Ensemble status you can change. For spreadsheets, each Ensemble field gets a column you can change, and files can come in as tasks or pages. Notion imports become pages and ordinary editable tables. A sample table shows the first rows as they will land.
5. **Run.** The import runs in the background on the Hub. You can close the dialog; the job shows under Recent imports (`RecentImports`). Cancel stops after the current batch.
6. **Summary** with counts and links: the board, each project, `#label` searches, the imported pages, and **Undo this import**.

## 2. What each app brings

| App | Connect | File export | Becomes | Fields |
|---|---|---|---|---|
| Notion | Connected account or internal integration secret (share the pages with the integration) | Markdown & CSV zip, or a database CSV | Databases → ordinary tables in pages; rows → linked child pages; nested pages → nested Ensemble pages | Every table column and value, with property types from the API. Rich text marks, nested lists, checklists, code, quotes/callouts, collapsible blocks, tables, dividers and linked child pages become native page blocks. API images stay images; other media stay source links. No database, board or alternative-view feature is created |
| Linear | Connected account or personal API key | CSV | Issues → tasks; project → project | Title, description (Markdown), status name and state type, priority, labels, cycle as a label, assignee, due date, link; sub-issues note their parent. Containers: "Issues assigned to me" and each team |
| Jira Cloud | Connected account (OAuth or email + API token) or email + API token + site | CSV (all fields) | Issues → tasks; Jira project → project | Summary, description (Atlassian Document Format → Markdown), due date, labels, issue type (except Task/Sub-task) as a label, status and status category, priority, assignee, parent/epic noted in the description. Containers: "Issues assigned to me" and each project, with approximate counts |
| Trello | Connected account or API key + token | Board JSON export | Boards → projects, cards → tasks | Name, description, due and start, "due complete" → done, labels (name, or colour when unnamed), members, list name → status (Done list → done), checklists → a to-do list on the task page. Archived cards and lists are skipped |
| Asana | Connected account or personal access token | Project CSV | Projects → projects, tasks → tasks | Name, notes, due date or time, start date, completed, tags, assignee, section → status, subtask parent noted. Containers: each project and "My tasks" per workspace |
| Todoist | Connected account or API token | Project template CSV | Projects → projects, tasks → tasks | Content, description, deadline (else the due date) as due, recurring rule noted, priority (API 4 / CSV 1 = urgent), labels, section as a label, assignee in shared projects, completed tasks from the last 90 days |
| ClickUp | Connected account or personal token | CSV export | Lists → projects, tasks → tasks | Name, Markdown description, status and status type, priority, tags, assignees, due and start dates, closed date |
| monday.com | Connected account or personal API token | — | Boards → projects, items → tasks | Name, status column, a status column named Priority, date or timeline column, tags, people, a checkbox named Done, first long-text column as description, group as a label |
| GitHub Issues | Connected account or fine-grained token with Issues read | — | Repositories → projects, issues → tasks (pull requests skipped) | Title, body, open/closed (closed as not planned → dropped), labels, milestone as a label and its due date as due, assignees. Containers: "Issues assigned to me" and each repository |
| CSV or TSV | — | Any spreadsheet | Rows → tasks (or pages) | Column mapping (§3) |

Vendor APIs (`src/imports/api/`): Notion `2026-03-11` (databases read through their data sources, `POST /v1/data_sources/{id}/query`), Jira `POST /rest/api/3/search/jql` with `nextPageToken`, Todoist unified API v1 (`https://api.todoist.com/api/v1`), monday.com GraphQL `API-Version: 2026-07`, GitHub `X-GitHub-Api-Version: 2022-11-28`, Linear GraphQL, Asana 1.0, Trello 1, ClickUp v2.

### How to export from each app

The dialog shows these next to the upload box (`EXPORT_HELP` in `src/imports/sources.ts`).

- **Notion:** Settings → General → Export all workspace content (or ••• on a page → Export), choose **Markdown & CSV**, include subpages, and upload the zip as downloaded. Ensemble opens one level of the inner zip Notion often adds.
- **Linear:** Settings → Administration → Import / export → Export CSV. The file arrives by email.
- **Jira:** Filters → View all issues, pick the issues, then Export → Export CSV (all fields).
- **Trello:** board menu (•••) → Print, export and share → Export as JSON.
- **Asana:** the arrow next to the project name → Export/Print → CSV.
- **Todoist:** project ••• → Export as a template → Download as CSV file.
- **ClickUp:** Settings → Import/Export → Export, or a List view's ••• → Export view → CSV.
- **Spreadsheets:** File → Download → CSV (Google Sheets) or Save As → CSV (Excel). A header row is needed; a title line above it is skipped.

## 3. Mapping rules

`src/imports/mapping.ts` and `src/imports/apply.ts`.

- **Status** uses the review-step choice. Unseen values are matched by name: done, complete, closed, resolved, shipped, merged → Done; cancelled, won't do, duplicate, not planned → Dropped; blocked, on hold, waiting → Blocked; in progress, doing, started, review, testing, QA → In progress; backlog, to do, open, unstarted, not started, new, triage → To do. When the name says nothing, the app's status group decides (Linear state type, Jira status category, ClickUp status type); anything else is To do. A done checkbox or completion date makes the task Done.
- **Priority** (`mapPriority`): critical, blocker, showstopper, P0 → Critical; urgent, highest, high, P1 → High; medium, normal, no priority → Medium; low, lowest, minor, P3 or lower → Low.
- **Dates:** a date without a time is stored like Ensemble's date-only dues, midnight UTC on that day (`parseDue` in `src/lib/clock.ts`). A time with a zone keeps that instant; a time without one keeps its day. Spreadsheet dates may be ISO, `MM/DD/YYYY` (`DD/MM/YYYY` when the first part is over 12), Jira's `07/Oct/26`, "October 7, 2026" or "7 Oct 2026"; a range ("start → end") gives start and due.
- **Labels** are trimmed and de-duplicated ignoring case: at most 20 per task, 40 characters each.
- **Assignees** become the task's people, by name.
- **Descriptions:** a short single paragraph stays the task description. Anything longer or structured moves to the task's page and the task keeps its first paragraph. Trello checklists and unmapped properties go to the page too. Notion row properties stay on their ordinary page.
- **Pages:** standalone pages start with an import credit and original link. Notion parents are stored in `TaskPage.parentId` and resolved after all batches (`finishPageImport` in `imports/apply.ts`), so children fetched before their parents still nest. The Pages browser indents children with each child group collapsed at first, and each page lists its child pages. Notion imports never create projects or board tasks.
- **Notion formatting:** API imports convert blocks directly (`imports/notion-content.ts`). Toggles become `toggleBlock` with every nested block kept while collapsed. Tables keep column names, values and property types as normal `tableHeader` / `tableCell` attributes; formulas and rollups are snapshots, not live calculations. When pages and databases are selected together, embedded tables are imported inside their page once, not again as standalone table pages. Row titles and relation values link to imported pages when available; file values keep their source links. Markdown/CSV exports keep the exported values but their CSV has no type schema; columns become sequential blocks, media source URLs can expire, and exported local images are not copied into Files.
- **Projects** are matched by the app's id first, then by name (case-insensitive), so an existing "Launch" project is reused. A project an earlier import created and you since deleted is restored.
- Tasks are created as yours (`createdBy: me`, owner Me), with `sourceKind` set to the app and a link back in Source.

### Spreadsheet columns

Columns are guessed from their headers; exports from Notion, Asana, Todoist, Jira, Linear and ClickUp are recognised by their header sets (`detectPreset` in `src/imports/files/csv.ts`). Fields: title, due date, start date, labels/tags (split on commas and semicolons; repeated columns such as Jira's several "Labels" are merged), status, priority, assignee, description, project, link, ID and a done checkbox. Todoist CSVs also turn `@label` words and sections into labels. Delimiters (comma, tab, semicolon, pipe) are detected. Files are read as UTF-8, UTF-16 when there is a BOM (Excel "Unicode text"), or Windows-1252 when UTF-8 fails (`src/imports/files/index.ts`).

## 4. Running it again, and undo

- Every task, page and project an import writes carries `external_source` and `external_id` (unique per person). Running the same import again **updates** rows whose values changed in the other app and leaves the rest; nothing is duplicated.
- Spreadsheet rows without an ID column are matched by project and title (and their order among rows with the same title), not by file name, so a re-downloaded file matches. An ID column in a plain spreadsheet or a Notion database CSV counts only within that sheet: the id is prefixed with a key made from the file name (without dates, "(1)" and Notion ids) and its column headers, so `Hiring.csv` and `Q3 roadmap.csv` both numbered 1, 2, 3 stay separate while `Q3 roadmap (1).csv` updates the roadmap. Vendor ids unique across the app (Jira issue ids, Asana and ClickUp task ids, Linear identifiers) are used as they are.
- Notion zip ids are the page ids, so a later import over the API updates the same rows.
- The other app's values win for title, status, priority, dates, labels, people and link. Two things are kept and counted as "kept with your edits": **trashed standalone pages stay deleted** (keeping their external identity), and **page bodies edited in Ensemble are kept** (an import replaces only a page it wrote that nobody has saved since).
- **Undo this import** soft-deletes the tasks and projects that import created (tasks go to Trash) and deletes the standalone pages it created. Items it only updated are left as they are. Each job records up to 10,000 created ids per kind (`CREATED_CAP`); past that, undo also removes tasks from the same app created during the import's run time.
- A task or project you deleted comes back if a later import brings it again; that import's undo removes it again.

## 5. Limits and safety

- Files up to 50 MB (413 otherwise). A zip may unpack to at most 100 MB, counted as real inflated bytes across every entry and Notion's inner zip together (one shared budget; unzipping stops when it is spent), with at most 50,000 entries and 40 million characters of page text. Only `.md` and `.csv` entries are inflated.
- Notion API imports read at most 5,000 pages and 5,000 rows per table; nesting deeper than 32 levels is refused with a message.
- Up to 20,000 items per import (`MAX_ITEMS`); import larger sets in several runs. One running import per person.
- Writes go in transactions of 100 items; progress, counts and created ids are saved after each batch.
- API calls run one at a time with a gap under each vendor's published rate limit (`SOURCE_GAP_MS`), wait on 429 and 503 using `Retry-After`, and retry network errors with backoff. Errors name the app and never include the token.
- A preview keeps the uploaded file as received (not the parsed rows) or the pasted token in memory for 30 minutes, one per person (a new preview replaces the older one), usable only by its owner. The file is read again for the review step and at import start, and the preview is dropped once the import starts. All previews together hold at most 300 MB; when full, previews idle for five minutes make room, otherwise the upload is refused with "try again in a few minutes". Each person has one upload being read at a time (429 otherwise).
- If the Hub restarts during an import, the job shows as interrupted within two minutes (running jobs check in every 30 seconds). Run it again; it continues without copies.
- Notion page bodies take one request per page and Notion allows about three a second, so a 1,000-row database with bodies takes several minutes.
- Rate limits per person: 60 previews per 10 minutes, 30 starts and 30 undos per hour (429 with `Retry-After`). Hosted, every import route needs a verified email (`requireVerifiedUser`).
- Not imported: comments, attachments other than links, and sub-task trees (parents are noted in the description). Notion relations and rollups come across as text in the page's property list. There is no scheduled re-sync; imports run when you start them.

## 6. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/imports/sources` | → `{ sources: [{ id, name, logo, api, connected, tokenUrl, tokenHint, tokenFields, files, exportHelp, brings }] }` |
| POST | `/api/imports/preview` | JSON `{ source, credentials?: { token, email?, site?, key? }, containers?, options?: { includeCompleted? } }` or `{ previewId, containers?, columns?, options? }`; multipart `source` + `file` for uploads → `{ previewId, source, via, format, containers[], mapping: { fields, tables[], statuses[] }, samples[], summary, expiresAt }`. 409 when the app is not connected and no token was sent |
| POST | `/api/imports` | `{ previewId, containers[], statusMap?, importAs?, columns?, options? }`, or `{ source, containers[] }` for a connected account → `202 { job }`. 409 while another import runs |
| GET | `/api/imports` | → `{ jobs[] }`, newest 20 |
| GET | `/api/imports/:id` | → `{ job }` with `status` (`running`, `cancelling`, `done`, `failed`, `cancelled`, `interrupted`, `undone`), `counts`, `progress`, `links`, `canUndo` |
| POST | `/api/imports/:id/cancel` | → `{ job }` |
| POST | `/api/imports/:id/undo` | → `{ job }`; 409 when already undone or still running |

Task routes accept and return `labels` (`POST /api/tasks`, `PATCH /api/tasks/:id`, `GET /api/tasks`). Board search matches labels, and `#label` searches labels only (`/board?q=%23label` opens it filtered).

## 7. From the assistant

The assistant runs the same flow (`assistant/tools/board-imports.ts`). `hub_preview_board_import` lists a connected account's containers, or previews an export already uploaded in Files (`fileId`); a second call with the chosen containers returns sample rows and statuses. `hub_start_board_import` waits for Apply and starts the job; `hub_read_import` reports progress; `hub_manage_import` cancels or undoes (after Apply). Tokens are not accepted in tool arguments. Mapping, expiry, caps and re-import rules are the same. A started job is not reported as completed.

## 8. Tests

| Test | Covers |
|---|---|
| `apps/hub-api/src/routes/imports.integration.test.ts` | CSV, Trello JSON and Notion zip imports over HTTP; nested Notion parents; re-import without copies; sheet id scoping; page edits kept; undo; isolation; a cancelled token import that never stores the token; bad input; unverified hosted accounts; task labels |
| `apps/hub-api/src/imports/importers.test.ts` | Mapping rules, CSV presets, the unzip budget and page-text cap, preview limits, 429 handling, and the Notion (native blocks), Linear, Jira and Todoist importers against mocked `fetch` |
| `apps/hub-web/components/imports/import-dialog.test.tsx`, `components/task/labels.test.tsx` | The dialog flow, the recent list, the label editor |

Fixtures (fictional Fieldnote data) are in `apps/hub-api/src/imports/fixtures/`.
