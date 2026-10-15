# 32 · Files

People bring almost any common file into Ensemble — uploaded from their computer or imported from a connected app — then preview it, edit it where that makes sense, turn it into a page, attach it inside pages, and let the assistant and agents read it.

Written 12 Oct 2026 from the code; every claim below is covered by the tests listed at the end. No vendor API and no real browser were used for these tests (vendor calls are mocked; viewers are tested with generated files in a DOM test environment).

## 1. What each kind of file can do

The table is `FILE_FORMATS` in `packages/shared-types/src/files.ts`; the format comes from the file name, never from the media type a browser or app claimed.

| Kind | Formats | Preview | Edit | Becomes a page | Agents read |
|---|---|---|---|---|---|
| PDF | pdf | Pages rendered with pdf.js (its legacy build, so Safari and the macOS desktop app work too); Full screen | Convert to a page first | In the browser; export back to PDF with the original's page size, margins, sizes and colours | Text of the first 300 pages |
| Word | docx | docx-preview | Convert to a page first | In the browser; export back to Word into the original file (its styles, fonts, page setup, headers and footers) | Paragraphs, tables, headers, footers, notes |
| Slides | pptx | Ensemble's own slide renderer; Present | — | — | Slide text and speaker notes |
| Spreadsheets | xlsx, xlsm | Grid with sheet tabs | Cells, rows; saved into the original file | — | Each sheet as CSV (2,000 rows per sheet) |
| | csv, tsv | Grid | Cells, rows; saved as CSV/TSV | Server: a table (first 200 rows) | The text |
| | xls, ods, numbers | Grid | After "Make an editable .xlsx copy" | — | No (agents are told to use .xlsx) |
| Images | png, jpg, gif, webp, avif, svg, bmp, ico | Image (SVG only as an image) | — | — | No text |
| Text | txt, md, log | Text | — | Server: Markdown keeps its structure; text as paragraphs | The text |
| Code | json, yaml, toml, xml, html, css, js/ts, py, java, go, rust, sql, shell and more | Code with line numbers | — | Server: one code block in its language | The text |
| Audio, video | mp3, wav, m4a, ogg, flac, mp4, mov, webm | The browser's own player | — | — | No text |
| Not previewable | doc, odt, rtf, ppt, odp, key, heic, tiff, anything else | Details, a note on how to make it previewable, Download | — | — | No (a warning says which format to save as) |

Every file, previewable or not, can be attached to pages and downloaded.

**Present and Full screen.** On a file's own screen (`components/files/file-screen.tsx`), slides have **Present**: one slide at a time, fitted to the screen on black (`components/files/viewers/present.tsx`). It starts at the slide in view, skips slides marked hidden in PowerPoint, draws the next one ahead, and leaves the viewer where the presentation stopped. → ↓ Space PageDown Enter N go forward; ← ↑ PageUp Backspace P go back; Home and End jump to the first and last; a click on the left third goes back, anywhere else forward; F leaves or re-enters the browser's fullscreen; Esc stops. The controls and the cursor hide after 2 seconds without the mouse moving. PDFs, Word files, spreadsheets, images, video, text and code have **Full screen** instead: the same viewer, with its zoom (− / + and Fit width for PDFs and Word files) and unsaved edits, fills the screen under a bar with the file name and an × that leaves; Esc leaves too. PDFs presented one page at a time until 13 Oct 2026. Both ask the browser for fullscreen and use an in-page layer where it is refused ([docs/02 §3.10](02_MODULE_INTERACTION_HUB_UI.md#310-files)).

## 2. Where files live

- **Original bytes** are a `context_documents` row (`Document`): `original` (bytea, PGlite on desktop), `filename`, `format`, `mediaType` (from the format table), `byteSize`, `sha256`, `pageCount`, `warnings`, `source` (the app it came from) and `style` (formatting read from a PDF that became a page).
- **Text for agents and search** is one file `Artifact` per document (`externalId = file:<documentId>`), up to 400,000 characters, secret-redacted (`redact`).
- **Pages made from a file** keep the link in `task_pages.source_file_id` (migration `20261012130000_files`), and page reads return `sourceFile: { id, filename, format, hasStyle }`.
- **Attachments in pages** are mention nodes `{ type: "mention", attrs: { kind: "file", id, label, height } }`. They render as preview cards; `pageText` shows them to agents as `[file: <name> (id <id>)]`.

Code: `apps/hub-api/src/files/` (store, extract and its worker, page, import, attached), routes `apps/hub-api/src/routes/files.ts` and `routes/file-imports.ts`, web `apps/hub-web/components/files/`, `apps/hub-web/lib/files/`, `apps/hub-web/lib/api-files.ts`, `app/(hub)/files`.

## 3. Limits

| | Hosted (ensemblework.com) | Desktop and local servers |
|---|---|---|
| Files kept | 10 per account, over all its spaces (`ENSEMBLE_MAX_DOCUMENTS`) | No limit |
| Combined size | 50 MB (`ENSEMBLE_MAX_DOCUMENT_BYTES`) | No limit |
| One file | 25 MB | 100 MB |

Removed files do not count. Messages say what to do ("You can keep 10 files on the hosted plan. Remove one to add another."). A server-wide guard, `ENSEMBLE_FILES_TOTAL_MAX_BYTES` (10 GiB by default, counting every stored original including removed ones not yet purged), protects the server's disk and answers 507 "File storage on this server is full right now." Uploads, imports and edits all check the caps (`lib/hosted-limits.ts`, `files/store.ts`).

## 4. Keeping the server light

Previews, PDF and Word conversion, export back, and reading old spreadsheet formats run in the browser. The server stores bytes, reads text for agents, saves spreadsheet cell edits and makes pages from text:

- PDF, .docx, .pptx and .xlsx text is read once per upload in a worker thread with a 256 MB memory limit and a 30-second time limit, two at a time (`files/extract.ts`, `extract-worker.ts`). .xlsx text uses a streaming reader (`files/xlsx-text.ts`). Text, code and CSV are read when saved.
- Cell edits load the workbook in a worker with a 512 MB limit (about 3 MB of workbook); larger or more complex workbooks get "too large or complex to edit here".
- Images, audio and video are never parsed.
- A summary is asked for once, when the text is first read; edits do not ask again.

## 5. Bringing files in from apps

**Files → Add from your apps** (also offered from a page's `/file` command) lists each source with its state for this person (`GET /api/documents/import-sources`):

| Source | Imports | Needs |
|---|---|---|
| Google Drive | Any file; Google Docs, Sheets and Slides come as .docx, .xlsx and .pptx, Drawings as PDF. Google's export call stops at 10 MB, so larger ones come through the file's own export link (as Drive's File → Download does); when Google offers none, the message says how to download it from Google and upload it | Google Workspace connected with Drive on. With only "Drive, Docs, Sheets and Slides" Ensemble sees files it created or the person picked, so the dialog offers **Pick from Google Drive** (the Google Picker, when the server has `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER`) or "Search all of Drive" |
| Gmail | Files attached to emails | Gmail switched on |
| OneDrive | Any file | OneDrive switched on |
| Outlook | File attachments | Outlook mail switched on |
| Dropbox | Any file (Paper as Markdown) | Dropbox connected |
| Box | Any file | Box connected |

Each state comes with one plain sentence, short numbered steps and a button to the right place in Settings → Connections: *ready*, *needs permission* (connected, but the product is off or the scope is missing), *not connected*, or *not set up* (whoever runs the server has not registered that app yet). Importing downloads the file through the person's own connection (25 MB at most; tokens never follow a redirect to another host) and saves it like an upload (`POST /api/documents/import`, `files/import.ts`, `download()` in `connectors/items/sources/*`). Importing the same item again returns the copy already kept.

## 6. Pages

- **Attach**: type `@` and a file name, use `/file` (upload, choose from Files, or from your apps), or drop or paste files into the editor; files upload first, then appear as cards. Cards are resizable and show a compact preview with Open; on a page you can edit, the card's × takes it off the page (the file stays in Files).
- **Shared pages and public links** preview the files on them: the sharing gate allows reading a file (`GET /api/documents/:id`, `/original`, `/text`) only when the shared page currently mentions it (`sharing/gate.ts`). Nothing else about files is reachable through a share or link.
- **Converted pages** show "Made from report.pdf" with **Export back** (PDF or Word), also offered in the page's Download menu under "With the original's formatting".
- After converting, a notice says for a few seconds that export back keeps the original's formatting.

## 7. Agents, the assistant and editors

`files/attached.ts` also includes the original document a page was converted from (`sourceFileId`), even after that page becomes a task. Originals stay attached through nested page content and bulk Trash/Undo. Research and code agents can use `read_attachment` and `save_attachment`; engine runs receive original copies. Paired computers download originals before queueing the local job through `GET /api/devices/self/jobs/:id/attachments/:fileId`, using the owning device token and active `x-ensemble-job-lease` header. The route verifies the file is still attached to this task; it is not a general Files download. The same route supplies full source text for diagrams embedded in the page, saved locally as `.ensemble-diagram.txt` files so source beyond the prompt excerpt remains readable. The runner remaps page references to the copied files' local ids before starting. Transfers are bounded to 100 MB per run.

- **Ensemble's agent**: its brief lists the files on the task's page, its project's page and files tagged with the task, with up to 2,000 characters of each (10,000 in total). `read_attachment` reads a file in parts; `save_attachment` (research and code runs) copies the original into the work folder (`attachments/<name>`).
- **Claude Code, Codex and Cursor**: the originals are copied for the job and their paths listed in the prompt — to `<workspace>/files/<jobId>/` when the run may read outside its folder, otherwise to `<folder>/.ensemble/attachments/<jobId>/` (git-ignored). Copies are removed when the job ends.
- **Paired computers**: the claim's task description gets a "Files attached" section with short excerpts.
- **The assistant**: `hub_list_files` and `hub_read_file`; `hub_import_app_file` brings a file or attachment in from a connected app the same way as `POST /api/documents/import`, after Apply (its preview says when the app is not ready or the hosted plan's 10 files are used); `hub_create_page` and `hub_update_page` attach a file with a `[@name](ensemble://file/<id>)` link; `hub_import_dataset` with `fileId` makes a Plots dataset from a CSV, TSV or `.xlsx` sheet in Files ([11 §8.4](11_HOW_THE_ASSISTANT_WORKS.md)).
- **Editors over MCP** (Context Bridge and hosted `/mcp`): search finds files, the brief lists a task's files, and `ensemble_read` reads a file's text in parts. Original bytes are never sent over MCP.

File text is always passed on as information, not instructions.

## 8. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/documents?q=` | → `{ files: FileRecord[], usage: FileUsage }` |
| POST | `/api/documents` | `{ filename, mediaType, dataBase64, summarize?, tags? }` → 201 `{ file, document }` |
| GET | `/api/documents/:id` | → `{ file }` |
| GET | `/api/documents/:id/original` | Bytes; Content-Type from the format table (HTML as text/plain, unknown as octet-stream), `nosniff`, a sandbox CSP, `attachment` with `filename*`, `ETag`/304, ranges |
| GET | `/api/documents/:id/text?offset=&limit=` | → `{ text, offset, total, nextOffset? }` (6,000 by default, at most 20,000) |
| PUT | `/api/documents/:id/content` | `{ dataBase64, filename?, mediaType? }` → `{ file }` |
| POST | `/api/documents/:id/cells` | `SheetPatch` → `{ file }` (.xlsx/.xlsm) |
| POST | `/api/documents/:id/page` | `{ title?, content?, style? }` → 201 `{ pageId }` |
| GET | `/api/documents/:id/style` | → `{ style }` |
| PATCH | `/api/documents/:id/tags` | Manual tags |
| DELETE | `/api/documents/:id` | → 204; the file and its text go to Trash together |
| GET | `/api/documents/import-sources` | → `{ sources: FileImportSource[] }` |
| POST | `/api/documents/import` | `{ source, kind: "file" \| "attachment", id }` → 201 `{ file }` (200 when already kept) |
| GET | `/api/artifacts?exclude=uploads&kind=&q=&before=` | Explicit connected-item browser (§11): → `{ artifacts[], counts[], sync[], nextCursor }` |
| GET | `/api/artifacts/:id` | → `{ artifact }` with `text`, `participants`, `origin`, `documentId` |
| DELETE | `/api/artifacts/:id` | Owner only → 204; 409 `{ error, documentId }` for an uploaded file's text |

Hosted: a verified email for everything; imports 60 per 10 minutes. Space members may use files like other shared content (viewers read only). Ledger: `document.upload`, `document.import`, `document.update`, `document.cells`, `document.page`, `document.delete`, `artifact.remove`.

## 9. Honest limits

- PDFs without a text layer (scans) have no text for agents and say so; there is no OCR.
- Spreadsheet cell edits are refused for workbooks with charts, pivot tables, slicers, macros, form controls, comments or links to other workbooks, because saving would drop them. Values that depend on edited cells refresh when Excel next opens the file.
- Typing into a formula cell saves the value typed, not a formula. New rows are added at the end of a sheet. Sheets over 50,000 rows show their first 50,000 rows and cannot be edited here.
- "Make an editable .xlsx copy" (for .xls, .ods and .numbers) replaces the file in Ensemble; values, formulas and every sheet come across, some formatting, charts and pictures may not.
- Export back to PDF matches fonts to the nearest standard font (Helvetica, Times, Courier); it keeps page size, margins, sizes and colours, but writes each paragraph in one style, so bold or italic words inside a paragraph come out plain (export back to Word keeps them). Images in a Word file are not carried into the page; they stay in the original.
- Legacy Office formats (.doc, .ppt) and Apple Keynote cannot be previewed; the note says which format to save as.

## 10. Tests

- `apps/hub-api/src/routes/files.integration.test.ts`: upload, list and usage, hosted caps (count, bytes, per-file, removed files free room, server guard), original headers (nosniff, ETag/304, HTML as text), text paging, replace, cell edits that keep another cell's formatting, pages from Markdown, code, CSV and browser content with a style, `sourceFile` on page reads, delete hides the text, isolation, and the shared-page rule.
- `apps/hub-api/src/files/extract.test.ts`: extraction per format and its limits.
- `apps/hub-api/src/files/import.integration.test.ts`, `attached.integration.test.ts`, `connectors/items/downloads.test.ts`: import sources and states, downloads per app, attached files for agents, `read_attachment` and `save_attachment`.
- `apps/hub-api/src/routes/artifacts.integration.test.ts`: From your apps without uploads, paging, one item in full, removal from the list, graph, live tiles and MCP search and read, a later sync and a purged row staying removed, attaching again restoring it, the 409 for uploads, isolation, and a space member refused.
- Web: `components/editor/file-attach.test.tsx`, `components/files/*.test.tsx` (`from-apps.test.tsx`: the switch, list, chips, search, reader, Remove, paging, empty state, guests), `lib/files/*.test.ts`.
- Present and Full screen: `components/files/present.test.tsx` runs them on a generated .pptx and a code file (keys, clicks, hidden slides, focus, the × and Esc, the in-page layer when the browser has no Fullscreen API, and a browser that grants it). A PDF in full screen uses the same layer; that path was read, not run, because pdf.js does not run in the test DOM.

## 11. Connected items opened explicitly

The Files home (`components/files/files-screen.tsx`) shows only uploaded or explicitly imported documents and makes no connected-item list request. **Add from your apps** opens an explicit search/import picker. Existing direct links to `/files?view=apps` or `&item=…` (`apps/hub-web/components/files/from-apps.tsx`) open the items Ensemble keeps from connected apps: synced mail, events, chats, channel messages, transcripts, pull requests and issues, and items attached to a task or project from an app. It reads `GET /api/artifacts?exclude=uploads`, which leaves out uploaded files' text Artifacts (a Document is linked, or `externalId` starts with `file:`). `origin` says which app each item came from (`apps/hub-api/src/context/artifacts.ts`: `metadata.source`, the attached item's app, or the link). The reader is `GET /api/artifacts/:id`; for an uploaded file's text it returns `documentId` and Files opens the file. Space members see the shared kinds only: never the owner's mail, chats or calendar (`visibleArtifacts`).

**Remove** (`DELETE /api/artifacts/:id`, owner only; members get 403):

- sets `deletedAt` on the Artifact, so it leaves `/api/artifacts`, the Context graph and board, the live tiles, calendars, the assistant's context tools, a task's or project's attached items, and MCP search, read and briefs, which all read only rows with no `deletedAt`;
- records a `ContextSuppression` with kind `artifact` and key `<artifact kind>:<externalId>`; `upsertArtifact` (`apps/hub-api/src/connectors/ingest.ts`) then returns null for that item, even after the retention purge erases the row, and each sync skips it (no item count, todo proposal, triage or meeting note);
- refuses an uploaded file's text with 409; delete the file instead (`DELETE /api/documents/:id`);
- writes `artifact.remove` to the ledger and sends a `context` event.

A calendar sync also soft-deletes events that left the calendar; those have no suppression and come back when seen again. Attaching the same item again from an app (`saveContent` in `connectors/items/index.ts`) clears the suppression and restores the row. Removed items are not in Trash.

Checked 12 Oct 2026 with `artifacts.integration.test.ts` for the list, the graph, live tiles, attached items and MCP search and read; that calendars and the assistant's context tools skip removed items was read in the code, not run.

Paired-run original-file transfer is included in CLI 0.3.11 and desktop 0.3.8; update older receivers to get the original bytes and local file-ID remapping.
