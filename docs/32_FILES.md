# 32 · Files

People bring common files into Ensemble, uploaded from their computer or imported from a connected app, then preview them, edit them where that makes sense, turn them into pages, attach them inside pages, and let the assistant and agents read them. Tests cover specific contracts with generated files and mocked providers, not perfect fidelity for every document or vendor account.

Code: `apps/hub-api/src/files/` (store, originals, extract and its worker, office-edit, page, import, attached), routes `apps/hub-api/src/routes/files.ts` and `routes/file-imports.ts`, web `apps/hub-web/components/files/`, `apps/hub-web/lib/files/`, `apps/hub-web/lib/api-files.ts`, `app/(hub)/files`. Formats: `packages/shared-types/src/files.ts`.

## 1. What each kind of file can do

The table is `FILE_FORMATS` in `packages/shared-types/src/files.ts`. The format comes from the file name, never from the media type a browser or app claimed.

| Kind | Formats | Preview | Edit | Becomes a page | Agents read |
|---|---|---|---|---|---|
| PDF | pdf | Pages rendered with pdf.js (legacy build, so Safari and the macOS desktop app work); Full screen | Convert to a page first | In the browser; export back to PDF with the original's page size, margins, sizes and colours | Text of the first 300 pages |
| Word | docx | Reading view or page view | Assistant exact text replacements; page conversion for broader writing | In the browser; export back to Word into the original file (its styles, fonts, page setup, headers and footers) | Paragraphs, tables, headers, footers, notes |
| Slides | pptx | Ensemble's own slide renderer; Present | Assistant exact text replacements | — | Slide text and speaker notes |
| Spreadsheets | xlsx, xlsm | Grid with sheet tabs | Cells, rows; saved into the original file | — | Each sheet as CSV (2,000 rows per sheet) |
| | csv, tsv | Grid | Cells, rows; saved as CSV/TSV | Server: a table (first 200 rows) | The text |
| | xls, ods, numbers | Grid | After "Make an editable .xlsx copy" | — | No (agents are told to use .xlsx) |
| Images | png, jpg, gif, webp, avif, svg, bmp, ico | Image (SVG only as an image) | — | — | No text |
| Text | txt, md, log | Text | Assistant exact text replacements | Server: Markdown keeps its structure; text as paragraphs | The text |
| Code | json, yaml, toml, xml, html, css, js/ts, py, java, go, rust, sql, shell and more | Code with line numbers | Assistant exact text replacements | Server: one code block in its language | The text |
| Audio, video | mp3, wav, m4a, ogg, flac, mp4, mov, webm | The browser's own player | — | — | No text |
| Not previewable | doc, odt, rtf, ppt, odp, key, heic, tiff, anything else except programs and raw binaries (refused, §3) | Details, how to make it previewable, Download | — | — | No (a warning says which format to save as) |

Every file, previewable or not, can be attached to pages and downloaded.

**Present and Full screen** (on a file's own screen, `components/files/file-screen.tsx`):

- Slides have **Present** (`components/files/viewers/present.tsx`): one slide at a time, fitted to the screen on black. It starts at the slide in view, skips slides hidden in PowerPoint, draws the next one ahead, and leaves the viewer where the presentation stopped. → ↓ Space PageDown Enter N go forward; ← ↑ PageUp Backspace P go back; Home and End jump to the first and last; a click on the left third goes back, anywhere else forward; F leaves or re-enters browser fullscreen; Esc stops. Controls and cursor hide after 2 seconds without mouse movement.
- PDFs, Word files, spreadsheets, images, video, text and code have **Full screen**: the same viewer, with its zoom (− / + and Fit width for PDFs and Word files) and unsaved edits, under a bar with the file name and an × that leaves; Esc leaves too.
- Both ask the browser for fullscreen and fall back to an in-page layer when it is refused ([02 §3.10](02_MODULE_INTERACTION_HUB_UI.md#310-files)).

**Word reading view** (`components/files/viewers/docx-viewer.tsx`) is the default when the preview pane is narrower than 600 px: text flows in one column at a readable size with normal paragraph and bullet spacing. **Page view** keeps the original geometry with Fit width and zoom, scaled by a transform on the page wrapper with browser text inflation off inside the sandboxed iframe. Reading view affects only the preview, never the stored file or exports. Compact thumbnails use page view.

## 2. Where files live

- **Original bytes** are a `context_documents` row (`Document`): `original` (bytea; PGlite on desktop) or `blobKey` when the blob store is on (below), plus `filename`, `format`, `mediaType` (from the format table), `byteSize`, `sha256`, `pageCount`, `warnings`, `source` (the app it came from) and `style` (formatting read from a PDF that became a page).
- **Text for agents and search** is one file `Artifact` per document (`externalId = file:<documentId>`), up to 400,000 characters, secret-redacted (`redact`).
- **Pages made from a file** keep the link in `task_pages.source_file_id`; page reads return `sourceFile: { id, filename, format, hasStyle }`.
- **Attachments in pages** are mention nodes `{ type: "mention", attrs: { kind: "file", id, label, height } }`. They render as preview cards; `pageText` shows them to agents as `[file: <name> (id <id>)]`.

**Blob storage.** By default the bytes sit on the row. With `ENSEMBLE_FILE_STORAGE=azure-blob`, `AZURE_STORAGE_CONNECTION_STRING` and optionally `AZURE_STORAGE_CONTAINER` (default `ensemble-files`), the server's blob store is on (`lib/blob-store.ts`, shared with plot tables, [20 §2](20_PLOTS_DESIGN.md#2-data-ingestion)):

- Every new or replaced original goes to the Azure Blob container as `documents/<userId>/<documentId>/<sha256>`; the row keeps only `blobKey` with `original` null (migration `20261021090000_document_blob_originals`; a check constraint requires one of the two). Rows that hold their bytes in `original` still read.
- Every read (download, preview, text extraction, page conversion, cell and text edits, assistant tools) goes through `originalBytes` in `files/originals.ts`.
- A replaced version, a purged file or a deleted account leaves a blob no row uses; the scheduler's hourly sweep (`jobs/blob-sweep.ts`, `sweepOrphanOriginals`) deletes those once they are an hour old.
- Unreachable storage answers 503 "File storage is not reachable right now. Try again in a minute." and saves no row; text extraction stays queued and runs again when Files is listed.
- Production refuses to start with an unknown `ENSEMBLE_FILE_STORAGE` or without the connection string (`lib/production.ts`).

The hosted site uses blob storage; the desktop app and local servers keep the default.

## 3. Limits

| | Hosted (ensemblework.com) | Desktop and local servers |
|---|---|---|
| Files kept | 10 per account, over all its spaces (`ENSEMBLE_MAX_DOCUMENTS`) | No limit |
| Combined size | 50 MB (`ENSEMBLE_MAX_DOCUMENT_BYTES`) | No limit |
| One file | 25 MB | 100 MB |

- Removed files do not count.
- Every upload and import refuses an empty file (400 "This file is empty, so there is nothing to keep.") and programs and raw binaries (415; `.exe`, `.msi`, `.dll`, `.bin`, `.dmg`, `.pkg`, `.apk`, `.jar`, `.iso` and the rest of `fileTypeProblem` in `packages/shared-types/src/files.ts`). A replacement cannot rename a file to one of them (`assertNewFile` in `files/store.ts`). An import from Gmail or Outlook keeps `.bin`, the name mail apps give attachments they cannot type (`ATT00001.bin`). `.com` and `.app` are not refused, because a name ending in a domain ("Invoice from acme.com") reads as one. Other formats Ensemble cannot show, such as `.zip`, are kept. Copies of files already kept (a paired computer's task attachments) are not checked again.
- The file travels as base64 inside JSON, so a request is about 4/3 of the file. `POST /api/documents` and `PUT /api/documents/:id/content` accept a body that fits the one-file limit (`uploadLimit()` in `routes/files.ts`); a larger one is refused from its `Content-Length` before it is read, with 413 and the same "Files can be up to … MB" message.
- The Hub's `/api` rewrite passes bodies through Next.js, which cuts them off past `experimental.middlewareClientMaxBodySize` (10 MB unless set) and leaves the API waiting; `apps/hub-web/next.config.ts` sets it to 140 MB, above the largest body the API reads.
- The Files screen checks the same rules before sending (`checkUploads` and `fileRefusal` in `components/files/use-uploads.ts`); a refused file, or one the server refused, stays in the upload list with its reason.
- Messages say what to do ("You can keep 10 files on the hosted plan. Remove one to add another.").
- A server-wide guard, `ENSEMBLE_FILES_TOTAL_MAX_BYTES` (10 GiB by default, counting every stored original including removed ones not yet purged), protects the server's storage (database or blob container) and answers 507 "File storage on this server is full right now."
- Uploads, imports and edits all check the caps (`lib/hosted-limits.ts`, `files/store.ts`).

**Uploading a file that is already here.** Before sending, the Files screen compares each picked or dropped file with the files kept (`findDuplicates` in `components/files/use-uploads.ts`): same content by SHA-256 (hashed in the browser, only for files the size of one already kept), else the same name. A file picked twice in one batch is added once. When any match, nothing is sent until the person chooses, for all of them (`DuplicateDialog` in `files-screen.tsx`): **Skip** (default), **Keep both** (upload as new files), or, when a name matches with different content, **Replace**, which puts the new bytes into the existing file (`PUT /api/documents/:id/content`) so pages it is attached to show the new version. An exact copy is skipped. Long names on cards wrap to two lines and are shortened in the middle, keeping the extension; the full name is the tooltip.

## 4. Keeping the server light

Previews, PDF and Word conversion, export back, and reading old spreadsheet formats run in the browser. The server stores bytes, reads text for agents, saves spreadsheet cell edits and makes pages from text:

- PDF, .docx, .pptx and .xlsx text is read once per upload in a worker thread with a 256 MB memory limit and a 30-second time limit, two at a time (`files/extract.ts`, `extract-worker.ts`). .xlsx text uses a streaming reader (`files/xlsx-text.ts`). Text, code and CSV are read when saved.
- Cell edits load the workbook in a worker with a 512 MB memory limit. A workbook over 15 MB is refused (413), as is one the worker cannot finish ("too large or complex to edit here"); one save takes at most 20,000 cell changes.
- Images, audio and video are never parsed.
- A summary is requested once, when the text is first read; edits do not request another.

## 5. Bringing files in from apps

Connecting an app or running Sync people adds no file or artifact. Files arrive only through an upload, an app import/attach/save, or an assistant action the person asked for.

**Files → Add from your apps** (also offered from a page's `/file` command) lists each source with its state for this person (`GET /api/documents/import-sources`):

| Source | Imports | Needs |
|---|---|---|
| Google Drive | Any file; Google Docs, Sheets and Slides come as .docx, .xlsx and .pptx, Drawings as PDF. Google's export call stops at 10 MB, so larger ones come through the file's own export link (as Drive's File → Download does); when Google offers none, the message says how to download it from Google and upload it | Google Workspace connected with Drive on. With only "Drive, Docs, Sheets and Slides", Ensemble sees files it created or the person picked, so the dialog offers **Pick from Google Drive** (the Google Picker, when the server has `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER`) or "Search all of Drive" |
| Gmail | Files attached to emails | Gmail switched on |
| OneDrive | Any file | OneDrive switched on |
| Outlook | File attachments | Outlook mail switched on |
| Dropbox | Any file (Paper as Markdown) | Dropbox connected |
| Box | Any file | Box connected |

Each state comes with one plain sentence, short numbered steps and a button to the right place in Settings → Connections: *ready*, *needs permission* (connected, but the product is off or the scope is missing), *not connected*, or *not set up* (whoever runs the server has not registered that app). Importing downloads the file through the person's own connection (25 MB at most; tokens never follow a redirect to another host) and saves it like an upload (`POST /api/documents/import`, `files/import.ts`, `download()` in `connectors/items/sources/*`). Importing the same item again returns the copy already kept.

## 6. Pages

- **Attach:** type `@` and a file name, use `/file` (upload, choose from Files, or from your apps), or drop or paste files into the editor; files upload first, then appear as cards. Cards are resizable and show a compact preview with Open; on a page you can edit, the card's × takes it off the page (the file stays in Files).
- **Shared pages and public links** preview their files: the sharing gate allows reading a file (`GET /api/documents/:id`, `/original`, `/text`) only while the shared page mentions it (`sharing/gate.ts`). Nothing else about files is reachable through a share or link.
- **Converted pages** show "Made from report.pdf" with **Export back** (PDF or Word), also in the page's Download menu under "With the original's formatting". Right after converting, a notice says for a few seconds that export back keeps the original's formatting.
- **Download** (the menu on pages, tasks, meeting notes and skills, `components/export-menu.tsx`) builds a PDF, Word, Markdown, web page or plain-text file in the browser (`apps/hub-web/lib/export/`); the server only answers the reads.
  - Bold, italic, strikethrough, inline code and links are kept in every format; bare web addresses become links; only `http(s)` and `mailto` links are written.
  - Tables stay tables. In a PDF (`toPdf` in `lib/export/formats.ts`) a table is a grid sized to its content with a shaded bold header row repeated on each page; rows are not split across pages unless taller than a page, and long URLs wrap inside their cell. Word gets a repeating shaded header row, the web page a header that repeats when printed, Markdown a pipe table, plain text padded columns.
  - Markdown tables in task descriptions, meeting recaps, skills and Ensemble answers on a page count with or without pipes at the ends (`blocksFromMarkdown` in `lib/export/document.ts`; pages read Markdown the same way, `packages/shared-types/src/page-markdown.ts`).
  - A PDF whose text the standard PDF fonts cannot draw (Hindi, Chinese, emoji and so on) opens the browser's print dialog on the web-page version instead (`pdfCanDraw`, `printDocument`).

## 7. Agents, the assistant and editors

File text is always passed on as information, not instructions.

**What counts as attached.** `files/attached.ts` collects the files on the task's page, its project's page and files tagged with the task, plus the original a page was converted from (`sourceFileId`), even after that page becomes a task. Originals stay attached through nested page content and bulk Trash/Undo.

- **Ensemble's agent:** its brief lists the attached files with up to 2,000 characters of each (10,000 in total). `read_attachment` reads a file in parts; `save_attachment` (research and code runs) copies the original into the work folder (`attachments/<name>`).
- **Claude Code, Codex, Cursor and GitHub Copilot:** the originals are copied for the job and their paths listed in the prompt: to `<workspace>/files/<jobId>/` when the run may read outside its folder, otherwise to `<folder>/.ensemble/attachments/<jobId>/` (git-ignored). Copies are removed when the job ends. GitHub Copilot also gets them with its first message: images inline (up to 3 MB, for models that take images), other files as links ([30 §3](30_ENGINES.md)).
- **Paired computers:** the claim's task description gets a "Files attached" section with short excerpts. Before queueing the local job, the computer downloads originals through `GET /api/devices/self/jobs/:id/attachments/:fileId` with the owning device token and the active `x-ensemble-job-lease` header. The route checks that the file is still attached to this task; it is not a general Files download. It also supplies the full source of diagrams embedded in the page, saved as `.ensemble-diagram.txt` files. The runner remaps page references to the copies' local ids before starting. Transfers are capped at 100 MB per run (`remote/accept.ts`). Receiving originals needs CLI 0.3.11+ or desktop 0.3.8+ on the computer.
- **The assistant:**
  - `hub_list_files` and `hub_read_file` list and read files. `hub_import_app_file` brings a file or attachment in from a connected app like `POST /api/documents/import`, after Apply (its preview says when the app is not ready or the hosted plan's 10 files are used). `hub_create_page` and `hub_update_page` attach a file with a `[@name](ensemble://file/<id>)` link. `hub_import_dataset` with `fileId` makes a Plots dataset from a CSV, TSV or `.xlsx` sheet ([11](11_HOW_THE_ASSISTANT_WORKS.md)).
  - `hub_file_edit_info` and `hub_edit_file` (`assistant/tools/file-edits.ts`): read the current SHA-256, then replace one unique passage in a Word, PowerPoint, text, code or CSV file, or edit supported spreadsheet cells and rows. Office edits keep the rest of the package and run in the bounded worker (`files/office-edit.ts`, `files/extract-worker.ts`). File ids stay fixed. `PUT /api/documents/:id/content` and cell patches accept `expectedSha256`; `replaceFileBytes` checks it under the storage lock and refuses a stale write (409 "The file changed. Read it again before editing.").
  - `hub_file_to_page` makes a supported file into a page; PDF and Word need Markdown from the text the assistant read. `hub_export_page_file` writes Word, PDF, Markdown or text into Files, or replaces a named file given its current hash. Server export rebuilds formatting instead of using the browser's original-template export; its PDF uses jsPDF's standard fonts and refuses characters they cannot draw (Word is the alternative). Every original-file edit and export waits for Apply.
  - There is no OCR, image, audio or video understanding, or slide redesign.
  - **Attaching to a message** (`components/files/add-to-message.tsx`) lists saved `/api/documents` records filtered by filename; choosing one inserts an `@file:` token and its `PageMention` id into the draft, and the turn reads the saved file. It does not browse connectors or import remote files; bring those into Files first.
- **Editors over MCP** (Context Bridge and hosted `/mcp`): search finds files, the brief lists a task's files, and `ensemble_read` reads a file's text in parts. Original bytes are never sent over MCP.

## 8. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/documents?q=` | → `{ files: FileRecord[], usage: FileUsage }` |
| POST | `/api/documents` | `{ filename, mediaType, dataBase64, summarize?, tags? }` → 201 `{ file, document }`; 400 empty, 413 over the size limit, 415 a program (§3) |
| GET | `/api/documents/:id` | → `{ file }` |
| GET | `/api/documents/:id/original` | Bytes; Content-Type from the format table (HTML as text/plain, unknown as octet-stream), `nosniff`, a sandbox CSP, `attachment` with `filename*`, `ETag`/304, ranges |
| GET | `/api/documents/:id/text?offset=&limit=` | → `{ text, offset, total, nextOffset? }` (6,000 characters by default, at most 20,000) |
| PUT | `/api/documents/:id/content` | `{ dataBase64, filename?, mediaType?, expectedSha256? }` → `{ file }` |
| POST | `/api/documents/:id/cells` | `SheetPatch` (with `expectedSha256?`) → `{ file }` (.xlsx/.xlsm) |
| POST | `/api/documents/:id/page` | `{ title?, content?, style? }` → 201 `{ pageId }` |
| GET | `/api/documents/:id/style` | → `{ style }` |
| PATCH | `/api/documents/:id/tags` | Manual tags |
| DELETE | `/api/documents/:id` | → 204; the file and its text go to Trash together |
| GET | `/api/documents/import-sources` | → `{ sources: FileImportSource[] }` |
| POST | `/api/documents/import` | `{ source, kind: "file" \| "attachment", id }` → 201 `{ file }` (200 when already kept) |
| GET | `/api/artifacts?exclude=uploads&kind=&q=&before=` | Connected-item browser (§11): → `{ artifacts[], counts[], sync[], nextCursor }` |
| GET | `/api/artifacts/:id` | → `{ artifact }` with `text`, `participants`, `origin`, `documentId` |
| DELETE | `/api/artifacts/:id` | Owner only → 204; 409 `{ error, documentId }` for an uploaded file's text |

- Hosted, uploads, edits and imports need a verified email. App imports are limited to 60 per 10 minutes per person (429 with `Retry-After`).
- Space members may use files like other shared content (viewers read only).
- Ledger: `document.upload`, `document.import`, `document.update`, `document.cells`, `document.page`, `document.delete`, `artifact.remove`.

## 9. Limitations

- PDFs without a text layer (scans) have no text for agents and say so; there is no OCR.
- Spreadsheet cell edits are refused for workbooks with charts, pivot tables, slicers, macros, form controls, comments or links to other workbooks, because saving would drop them. Values that depend on edited cells refresh when Excel next opens the file.
- Typing into a formula cell saves the value typed, not a formula. New rows are added at the end of a sheet. Sheets over 50,000 rows show their first 50,000 rows and cannot be edited here.
- "Make an editable .xlsx copy" (for .xls, .ods and .numbers) replaces the file in Ensemble; values, formulas and every sheet come across, some formatting, charts and pictures may not.
- Export back to PDF maps fonts to the nearest standard font (Helvetica, Times, Courier). It keeps page size, margins, sizes and colours, and bold, italic, code and links inside a paragraph, but not the original's exact typefaces. Images in a Word file are not carried into the page; they stay in the original.
- Legacy Office formats (.doc, .ppt) and Apple Keynote cannot be previewed; the note says which format to save as.

## 10. Tests

| Test | Covers |
|---|---|
| `apps/hub-api/src/routes/files.integration.test.ts` | Upload, list, usage, hosted caps and the server guard, refusals (§3), original headers, text paging, replace, cell edits, pages from files, delete, isolation, the shared-page rule |
| `apps/hub-api/src/files/originals.integration.test.ts` | Blob storage (§2): key-only rows, reads, replace/purge and the sweep, 503 when unreachable, rows that keep their bytes, the storage settings check |
| `apps/hub-api/src/files/extract.test.ts` | Extraction per format and its limits |
| `apps/hub-api/src/files/import.integration.test.ts`, `attached.integration.test.ts`, `connectors/items/downloads.test.ts` | Import sources and states, downloads per app, attached files for agents, `read_attachment` / `save_attachment` |
| `apps/hub-api/src/routes/artifacts.integration.test.ts` | §11: the list, reader, Remove and suppression, re-attach, the 409 for uploads, isolation, members refused |
| `apps/hub-web/components/files/*.test.tsx`, `components/editor/file-attach.test.tsx`, `lib/files/*.test.ts` | From your apps, duplicates (Skip, Replace), refusals on rows, search and Retry, Present and Full screen (keys, clicks, hidden slides, the in-page layer), attaching in the editor |
| `apps/hub-web/lib/export/*.test.ts` | Markdown table parsing and tables in every Download format |

## 11. Connected items opened explicitly

The Files home (`components/files/files-screen.tsx`) shows only uploaded or explicitly imported documents and makes no connected-item list request; **Add from your apps** opens an explicit search/import picker. Direct links to `/files?view=apps` or `&item=…` (`components/files/from-apps.tsx`) open the items Ensemble keeps from connected apps: synced mail, events, chats, channel messages, transcripts, pull requests and issues, and items attached to a task or project from an app.

- The list reads `GET /api/artifacts?exclude=uploads`, which leaves out uploaded files' text Artifacts (a Document is linked, or `externalId` starts with `file:`). `origin` says which app each item came from (`apps/hub-api/src/context/artifacts.ts`: `metadata.source`, the attached item's app, or the link).
- The reader is `GET /api/artifacts/:id`; for an uploaded file's text it returns `documentId` and Files opens the file.
- Space members see the shared kinds only, never the owner's mail, chats or calendar (`visibleArtifacts`).

**Remove** (`DELETE /api/artifacts/:id`, owner only; members get 403):

- sets `deletedAt` on the Artifact, so it leaves `/api/artifacts`, the Context graph and board, live tiles, calendars, the assistant's context tools, a task's or project's attached items, and MCP search, read and briefs, which all read only rows with no `deletedAt`;
- records a `ContextSuppression` with kind `artifact` and key `<artifact kind>:<externalId>`; `upsertArtifact` (`apps/hub-api/src/connectors/ingest.ts`) then returns null for that item, even after the retention purge erases the row, and each sync skips it (no item count, todo proposal, triage or meeting note);
- refuses an uploaded file's text with 409; delete the file instead (`DELETE /api/documents/:id`);
- writes `artifact.remove` to the ledger and sends a `context` event.

A calendar sync also soft-deletes events that left the calendar; those have no suppression and come back when seen again. Attaching the same item again from an app (`saveContent` in `connectors/items/index.ts`) clears the suppression and restores the row. Removed items are not in Trash.
