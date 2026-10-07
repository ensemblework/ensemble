# 27 · Imports from other apps

Ensemble can bring your work across from Notion, Linear, Jira, Trello, Asana, Todoist, ClickUp, monday.com, GitHub Issues and any spreadsheet: titles, due dates, labels and tags, status, priority, assignees, descriptions, page content and projects. Running an import again updates what came over instead of adding copies, and "Undo this import" removes what an import added.

Code: `apps/hub-api/src/imports/` (importers and writer), `apps/hub-api/src/routes/imports.ts` (API), `apps/hub-web/components/imports/` (dialog and recent list), `apps/hub-web/lib/api-imports.ts` (client). Labels on tasks: `packages/shared-types/src/domain.ts` (`TaskLabels`), `apps/hub-api/src/services/tasks.ts`, `apps/hub-web/components/task/labels.tsx`.

Checked 7 Oct 2026 with the tests listed at the end. Vendor APIs were checked against each vendor's current documentation the same day; no test calls a real vendor API.

## 1. How it works

1. **Pick the app** in the import dialog (`ImportDialog`; Settings → Connections opens it).
2. **Connect or upload.** Use the account already connected in Settings → Connections, paste a token, or upload the app's export. A pasted token is kept in server memory for this import only (at most 30 minutes); it is not written to the database or logs.
3. **Choose** databases, projects, boards, teams, lists or repositories. Counts show where the app reports them cheaply.
4. **Review.** Status values found (from the file, or a first page sampled from the API) each get an Ensemble status you can change; for spreadsheets, each Ensemble field gets a column you can change; Notion databases and files can come in as tasks or as pages. A sample table shows the first rows as they will land.
5. **Run.** The import runs in the background on the Hub. You can close the dialog; it shows under Recent imports (`RecentImports`). Cancel stops after the current batch.
6. **Summary** with counts and links: the board, each project, `#label` searches, the imported pages, and **Undo this import**.

## 2. What each app brings

| App | Connect | File export | Becomes | Fields |
|---|---|---|---|---|
| Notion | Connected account or internal integration secret (share the pages with the integration) | Markdown & CSV zip, or a database CSV | Databases → projects, rows → tasks (or pages), other pages → pages | Title; first date property (prefer Due/Deadline; a range gives start and due); Status property or a select named Status/State/Stage; select named Priority; every multi-select → labels; people; a checkbox named Done/Complete → done; a text property named Description/Summary/Notes → description; all other properties listed at the top of the page; page body as blocks (headings, lists, to-dos, code, quotes, callouts, toggles, tables, dividers, images and files as links) |
| Linear | Connected account or personal API key | CSV | Issues → tasks; project → project | Title, description (Markdown), status name and state type, priority, labels, cycle as a label, assignee, due date, link; sub-issues note their parent. Containers: "Issues assigned to me" and each team |
| Jira Cloud | Connected account (OAuth or email + API token) or email + API token + site | CSV (all fields) | Issues → tasks; Jira project → project | Summary, description (Atlassian Document Format → Markdown), due date, labels, issue type (except Task/Sub-task) as a label, status and status category, priority, assignee, parent/epic noted in the description. Containers: "Issues assigned to me" and each project, with approximate counts |
| Trello | Connected account or API key + token | Board JSON (free on every plan) | Boards → projects, cards → tasks | Name, description, due and start, "due complete" → done, labels (name, or colour when unnamed), members, list name → status (Done list → done), checklists → a to-do list on the task page. Archived cards and lists are skipped |
| Asana | Connected account or personal access token | Project CSV | Projects → projects, tasks → tasks | Name, notes, due date or time, start date, completed, tags, assignee, section → status, subtask parent noted. Containers: each project and "My tasks" per workspace |
| Todoist | Connected account or API token (unified API v1) | Project template CSV | Projects → projects, tasks → tasks | Content, description, deadline (else the due date) as due, recurring rule noted, priority (API 4 / CSV 1 = urgent), labels, section as a label, assignee for shared projects, completed tasks from the last 90 days |
| ClickUp | Connected account or personal token | CSV export | Lists → projects, tasks → tasks | Name, Markdown description, status and status type, priority, tags, assignees, due and start dates, closed date |
| monday.com | Connected account or personal API token | — | Boards → projects, items → tasks | Name, status column, a status column named Priority, date or timeline column, tags, people, a checkbox named Done, first long-text column as description, group as a label |
| GitHub Issues | Connected account or fine-grained token with Issues read | — | Repositories → projects, issues → tasks (pull requests skipped) | Title, body, open/closed (closed as not planned → dropped), labels, milestone as a label and its due date as due, assignees. Containers: "Issues assigned to me" and each repository |
| CSV or TSV | — | Any spreadsheet | Rows → tasks (or pages) | Column mapping below |

API versions used: Notion `2026-03-11` (databases are read through their data sources, `POST /v1/data_sources/{id}/query`), Jira `POST /rest/api/3/search/jql` with `nextPageToken`, Todoist `https://api.todoist.com/api/v1`, monday.com `API-Version: 2026-07`, GitHub `X-GitHub-Api-Version: 2022-11-28`, Linear GraphQL, Asana 1.0, Trello 1, ClickUp v2.

### How to export from each app

The dialog shows these next to the upload box (`EXPORT_HELP` in `src/imports/sources.ts`).

- **Notion:** Settings → General → Export all workspace content (or ••• on a page → Export), choose **Markdown & CSV** and include subpages, then upload the zip as downloaded. Notion often wraps the export in a second zip; Ensemble opens one level of that.
- **Linear:** Settings → Administration → Import / export → Export CSV. The file arrives by email.
- **Jira:** Filters → View all issues, pick the issues, then Export → Export CSV (all fields).
- **Trello:** board menu (•••) → Print, export and share → Export as JSON. (Trello's CSV export needs a paid plan; JSON does not.)
- **Asana:** the arrow next to the project name → Export/Print → CSV.
- **Todoist:** project ••• → Export as a template → Download as CSV file.
- **ClickUp:** Settings → Import/Export → Export, or a List view's ••• → Export view → CSV.
- **Spreadsheets:** File → Download → CSV (Google Sheets) or Save As → CSV (Excel). A header row is needed; a title line above it is skipped.

## 3. Mapping rules

`src/imports/mapping.ts` and `src/imports/apply.ts`.

- **Status** uses the choice made in the review step. Values you did not see are matched by name: done, complete, closed, resolved, shipped, merged → Done; cancelled, won't do, duplicate, not planned → Dropped; blocked, on hold, waiting → Blocked; in progress, doing, started, review, testing, QA → In progress; backlog, to do, open, unstarted, not started, new, triage → To do. When the name says nothing, the app's status group decides (Linear state type, Jira status category, ClickUp status type). Anything else is To do. A done checkbox or completion date makes the task Done.
- **Priority:** Ensemble has High, Normal and Low. Urgent, highest, critical and high → High; medium, normal and no priority → Normal; low and lowest → Low.
- **Dates:** a date with no time is stored the way Ensemble stores date-only dues, midnight UTC on that day (`parseDue` in `src/lib/clock.ts`). A time with a zone is kept as that instant; a time with no zone keeps its day. Spreadsheet dates may be ISO, `MM/DD/YYYY` (or `DD/MM/YYYY` when the first part is over 12), Jira's `07/Oct/26`, "October 7, 2026" or "7 Oct 2026"; ranges ("start → end") give start and due.
- **Labels** are trimmed, de-duplicated without regard to case, at most 20 per task and 40 characters each.
- **Assignees** become the task's people, by name.
- **Descriptions:** a short single paragraph stays as the task description. Anything longer or structured moves to the task's page, and the task keeps its first paragraph. Notion page bodies, Trello checklists and unmapped Notion properties go to the page too.
- **Pages:** standalone pages start with an "Imported from Notion · in *Parent* · Open original" line that keeps the hierarchy visible.
- **Projects** are found by the app's id first, then by name (case-insensitive), so an existing "Launch" project is reused. A project Ensemble created for an earlier import and you since deleted is restored.
- Tasks are created as yours (`createdBy: me`, owner Me), with `sourceKind` set to the app and a link back in Source.

### Spreadsheet columns

Ensemble guesses columns from their headers and recognises exports from Notion, Asana, Todoist, Jira, Linear and ClickUp by their header sets (`detectPreset` in `src/imports/files/csv.ts`). Fields: title, due date, start date, labels/tags (split on commas and semicolons; repeated columns such as Jira's several "Labels" are merged), status, priority, assignee, description, project, link, ID and a done checkbox. Todoist CSVs also turn `@label` words into labels and sections into labels. Delimiters (comma, tab, semicolon, pipe) are detected; UTF-8, UTF-16 (Excel "Unicode text") and Windows-1252 files are read.

## 4. Running it again, and undo

- Every task, page and project written by an import carries `external_source` and `external_id` (unique per person). Running the same import again **updates** rows whose values changed in the other app and leaves the rest; nothing is duplicated. Spreadsheet rows without an ID column are matched by project and title (and their order among rows with the same title), not by file name, so a re-downloaded file matches. An ID column in a plain spreadsheet or a Notion database CSV counts only within that sheet: the id is prefixed with a key made from the file name (without dates, "(1)" and Notion ids) and its column headers, so `Hiring.csv` and `Q3 roadmap.csv` both numbered 1, 2, 3 stay separate while `Q3 roadmap (1).csv` updates the roadmap. Vendor exports whose ids are unique across the app (Jira issue ids, Asana task ids, ClickUp task ids, Linear identifiers) use the id as it is.
- The other app's values win for title, status, priority, dates, labels, people and link. **Page bodies you edited in Ensemble are kept**: an import only replaces a page it wrote and nobody has saved since. The summary counts these as "kept with your edits".
- Notion zip ids are the page ids, so a later import over the API updates the same rows.
- **Undo this import** soft-deletes the tasks and projects that import created (tasks go to Trash) and deletes the standalone pages it created. Items it only updated are left as they are. Each job records up to 10,000 created ids per kind; past that, undo also removes tasks from the same app created during the import's run time.
- A task or project you deleted comes back if a later import brings it again; that import's undo removes it again.

## 5. Limits and safety

- Files up to 50 MB. A zip may unpack to at most 100 MB, counted as real inflated bytes across every entry and Notion's inner zip together (one shared budget; the unzip stops as soon as it is spent), and at most 50,000 entries and 40 million characters of page text. Only `.md` and `.csv` entries are inflated.
- Up to 20,000 items per import; for more, import the projects or boards in several runs. One running import per person.
- Writes go in transactions of 100 items; progress, counts and created ids are saved after each batch.
- API calls run one at a time with a gap under each vendor's published rate limit (`SOURCE_GAP_MS`), wait on 429 and 503 using `Retry-After`, and retry network errors with backoff. Errors name the app and never include the token.
- A preview keeps the uploaded file as received (not the parsed rows) or the pasted token, in memory for 30 minutes, one per person (a new preview replaces the older one), and only its owner can use it. The file is read again for the review step and at import start, and the preview is dropped once the import starts. All previews together hold at most 300 MB; when full, previews idle for five minutes make room, otherwise the upload is refused with "try again in a few minutes". Each person has one upload being read at a time (429 otherwise).
- If the Hub restarts during an import, the job shows as interrupted within two minutes (running jobs check in every 30 seconds). Run it again; it continues without copies.
- Notion page bodies take one request per page and Notion allows about three a second, so a 1,000-row database with bodies takes several minutes.
- Hosted: every import route needs a verified email (`requireVerifiedUser`). Rate limits per person: 60 previews per 10 minutes, 30 starts and 30 undos per hour.

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

Task routes accept and return `labels` (`POST /api/tasks`, `PATCH /api/tasks/:id`, `GET /api/tasks`). The board search matches labels, and `#label` searches labels only (`/board?q=%23label` opens it filtered).

## 7. Tests

- `apps/hub-api/src/routes/imports.integration.test.ts`: CSV, Trello JSON and Notion zip previews and imports through HTTP; re-import updates without duplicating; two sheets numbered 1..N stay separate; page edits kept; undo; another person cannot see, use, cancel or undo; a mocked Linear token import that is cancelled mid-way and never stores the token; bad input; unverified hosted accounts; task labels validation.
- `apps/hub-api/src/imports/importers.test.ts`: mapping rules, CSV presets, sheet id scoping, the shared unzip budget (nested zips included), the page-text cap, preview limits and the one-upload-at-a-time slot, 429 handling, and the Notion, Linear, Jira and Todoist importers against mocked `fetch`.
- `apps/hub-web/components/imports/import-dialog.test.tsx` and `components/task/labels.test.tsx`: the dialog flow (upload, review, run, summary, undo; connected account with containers), the recent list, and the label editor.

Fixtures (fictional Fieldnote data) are in `apps/hub-api/src/imports/fixtures/`.

## 8. Not built yet

- No scheduled re-sync; imports run when you start them.
- Comments, attachments (other than links) and sub-task trees are not imported; parents are noted in the description.
- Notion relations and rollups come across as text in the page's property list.
