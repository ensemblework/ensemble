# 32 · Files

People bring common files into Ensemble, uploaded from their computer or imported from a connected app, then preview them, edit them where that makes sense, turn them into pages, attach them inside pages, and let the assistant and agents read them. Tests cover specific contracts with generated files and mocked providers, not perfect fidelity for every document or vendor account.

Code: `apps/hub-api/src/files/` (store, originals, extract and its worker, office-edit, page, page-image, import, attached), routes `apps/hub-api/src/routes/files.ts` and `routes/file-imports.ts`, web `apps/hub-web/components/files/`, `apps/hub-web/lib/files/`, `apps/hub-web/lib/api-files.ts`, `app/(hub)/files`, and in the page editor `components/editor/file-attach.ts` and `page-image.ts`. Formats: `packages/shared-types/src/files.ts`; images in pages: `packages/shared-types/src/page-images.ts`.

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
- **Images in pages** are `image` nodes whose `attrs.fileId` names the file ([§6](#images-in-pages)).

**Blob storage.** By default the bytes sit on the row. With `ENSEMBLE_FILE_STORAGE=azure-blob`, `AZURE_STORAGE_CONNECTION_STRING` and optionally `AZURE_STORAGE_CONTAINER` (default `ensemble-files`), the server's blob store is on (`lib/blob-store.ts`, shared with plot tables, [20 §2](20_PLOTS_DESIGN.md#2-data-ingestion)):

- Every new or replaced original goes to the Azure Blob container as `documents/<userId>/<documentId>/<sha256>`; the row keeps only `blobKey` with `original` null (migration `20261021090000_document_blob_originals`; a check constraint requires one of the two). Rows that hold their bytes in `original` still read.
- Evidence a run's agent attached ([§7](#evidence-from-agent-runs)) goes there too, as `evidence/<userId>/<jobId>/<evidenceId>`.
- Every read (download, preview, text extraction, page conversion, cell and text edits, assistant tools) goes through `originalBytes` in `files/originals.ts`.
- A replaced version, a purged file or a deleted account leaves a blob no row uses; the scheduler's hourly sweep (`jobs/blob-sweep.ts`, `sweepOrphanOriginals`, and `sweepOrphanEvidence` for evidence) deletes those once they are an hour old.
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
- An image shown in a page can be up to 2 MB (2,097,152 bytes) whatever the plan ([§6](#images-in-pages)); larger images can still be kept as files.
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

- **Attach:** type `@` and a file name, use `/file` (upload, choose from Files, or from your apps), or drop or paste files into the editor; files upload first, then appear as cards. Dropped and pasted PNG, JPEG, GIF and WebP images become images in the page instead (below); `/file` makes a card of any file, images included. Cards are resizable and show a compact preview with Open; on a page you can edit, the card's × takes it off the page (the file stays in Files).
- **Shared pages and public links** preview their files: the sharing gate allows reading a file (`GET /api/documents/:id`, `/original`, `/text`) only while the shared page mentions it (`sharing/gate.ts`). Nothing else about files is reachable through a share or link.
- **Converted pages** show "Made from report.pdf" with **Export back** (PDF or Word), also in the page's Download menu under "With the original's formatting". Right after converting, a notice says for a few seconds that export back keeps the original's formatting.
- **Download** (the menu on pages, tasks, meeting notes and skills, `components/export-menu.tsx`) builds a PDF, Word, Markdown, web page or plain-text file in the browser (`apps/hub-web/lib/export/`); the server only answers the reads.
  - Bold, italic, strikethrough, inline code and links are kept in every format; bare web addresses become links; only `http(s)` and `mailto` links are written.
  - Tables stay tables. In a PDF (`toPdf` in `lib/export/formats.ts`) a table is a grid sized to its content with a shaded bold header row repeated on each page; rows are not split across pages unless taller than a page, and long URLs wrap inside their cell. Word gets a repeating shaded header row, the web page a header that repeats when printed, Markdown a pipe table, plain text padded columns.
  - Markdown tables in task descriptions, meeting recaps, skills and Ensemble answers on a page count with or without pipes at the ends (`blocksFromMarkdown` in `lib/export/document.ts`; pages read Markdown the same way, `packages/shared-types/src/page-markdown.ts`).
  - A PDF whose text the standard PDF fonts cannot draw (Hindi, Chinese, emoji and so on) opens the browser's print dialog on the web-page version instead (`pdfCanDraw`, `printDocument`).

### Images in pages

PNG, JPEG, GIF (animated too) and WebP images show inside a page as images, not file cards.

**Adding one** (`components/editor/file-attach.ts`):

- `/image` opens the system file picker (several at once); `/file` still attaches any image as a card, which is how to keep one over 2 MB on a page.
- Drop or paste image files, such as a screenshot. Other files, SVG included, become cards as before.
- HTML pasted or dropped with `data:` images (`<img src="data:…">`): the rest goes in as usual and each image is uploaded where it was, under the same rules, so image bytes never go into the page. One that is refused is left out with a message.
- Each image gets a placeholder where it will land: a dimmed preview, a progress bar and a percentage (`filesApi.upload` with `onProgress`). The finished image replaces it as one undoable step; placeholders are not saved and are not in undo history. An image placed at the start or end of a line goes above or below it; in the middle of a line it splits the line.
- A refusal says why in a toast. For a size or format refusal the toast offers **Attach as file**, which uploads the same file as a card at the same spot.
- People a single page is shared with, and public-link visitors, cannot add images: uploads are not part of a share (`sharing/policy.ts`). The editor says so before sending.

**Adjusting one** (`components/editor/page-image.ts`; pages you can edit only; read-only pages, viewers and links show the image without controls):

- Drag the handles on the image's left and right edges; the height follows, so the aspect ratio is kept. The right handle is a keyboard slider (`role="slider"`, in the tab order): arrow keys change the width by 5%, Home and End go to 10% and 100%.
- The toolbar (on hover, keyboard focus, or when the image is selected): align left, center or right; width 25%, 50%, 75%, 100% or Original (its own size, at most the page width); **Alt** edits the alt text (Enter saves, Esc cancels); × removes the image. Every button has an `aria-label`.
- Backspace and Delete remove a selected image like any block. Each change is one undo step and reaches co-editors as an attribute step.

**The limit** is 2 MB (2,097,152 bytes): `PAGE_IMAGE_MAX_BYTES` in `packages/shared-types/src/page-images.ts`, used by the editor and the API. An image of exactly 2,097,152 bytes is accepted; one byte more is refused, before sending and again on the server. Nothing is compressed or resized: "photo.jpg is 3.4 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file."

**What the server checks** for `POST /api/documents` with `purpose: "page-image"` (`files/page-image.ts`, `checkPageImage` in shared-types), whatever the client did:

| Check | Refusal |
|---|---|
| Over 2 MiB; a body whose base64 alone is larger is refused before decoding | 413 |
| The bytes, read without an image library (`readImageHeader`): PNG with a valid IHDR checksum, chunks inside the file, an IDAT and IEND; JPEG segments up to a frame header and the scan, then an end marker; GIF blocks with at least one whole image; WebP's whole RIFF container with VP8, VP8L or VP8X image data. Pixels are not decoded | 400 "looks damaged" |
| Zero width or height | 400 |
| More than 16,384 pixels a side or 40 megapixels | 413 |
| SVG, by content, name or type: it can carry scripts and links, and an image in a page must be inert | 415 |
| AVIF, HEIC, BMP, TIFF, ICO or anything else. AVIF is not taken because checking it needs a full ISOBMFF box walk; the four formats cover screenshots and the web | 415 |
| A name or media type that says another image format than the bytes (a JPEG named `.png`) | 415 |

The editor runs the same checks before sending and renames a file whose extension is wrong for its bytes; a name without an image extension gets one on the server too. The width and height read from the header (turned for EXIF orientations 5–8) come back as `image: { format, width, height }`. No summary is requested and images are never parsed for text.

**Page writes** (`assertNewPageImages`): saving a page (`PUT /api/pages/:id`, `PUT /api/tasks/:id/page`), writes by the assistant and agents through `writePageContent` and `hub_create_page`, and the content sent to `POST /api/documents/:id/page` refuse an image they add when it is a `data:` URL over 2 MiB (413), or a file in this space over 2 MiB or not PNG, JPEG, GIF or WebP (413 or 415, naming the `[@name](ensemble://file/<id>)` link that attaches it instead). Images the page already held are kept, so pages saved before the limit still save; restoring a saved version is not checked. Live co-editing (`pages/collab-core.ts`) refuses a step that adds a `data:` image over 2 MiB; moving one the page already holds is fine. Co-editing steps and an agent run's output block (`writeAgentBlock`) are not checked against Files; an image there of a file that breaks the rules shows as unavailable (below).

**Storage and access.** An image is an ordinary Files `Document` (§2), and the page's node names it:

```json
{ "type": "image", "attrs": { "fileId": "<document id>", "src": null, "alt": "North field", "width": 60, "align": "left", "naturalWidth": 1200, "naturalHeight": 800 } }
```

- `width` is a percentage of the page column (10–100); null shows the image at its own size, at most the column. `align` is `left`, `center` (default) or `right`. `naturalWidth` and `naturalHeight` come from the upload and keep the image's shape while it loads. All of it saves with the page, so it survives reloads and co-editing.
- `src` holds a web address instead, for images from Notion imports and pasted HTML; those render as before. Old `{ src, alt }` nodes still read.
- The node view reads `GET /api/documents/:id/original` with the share or public-link headers (`itemViewHeaders()`), because an `<img src>` cannot send them, and shows it from an object URL that is revoked when the image leaves the page. The bytes are kept for the session by file id and asked for again with `If-None-Match`, so an unchanged file answers 304 while access is checked every time. A file over 2 MB or not a PNG, JPEG, GIF or WebP is not shown.
- Who can see it follows file cards: a shared page or public link reads a file only while the page's current content places it (`contentHasFile` in `sharing/gate.ts` reads `attrs.fileId`); any other file answers 403. Space members read it as shared content.
- Agents: `attrs.fileId` makes it one of the task's attached files (`mentionedFileIds`, `filesOnTask` in `files/attached.ts`), so briefs, `view_attachment`, engine copies and paired-computer downloads include it. Page Markdown writes it as `![alt](ensemble://file/<id>){width=60% align=left natural=1200x800}`, leaving out defaults, and reads that back as the same node (`imageMarkdown` and `markdownToNodes` in `page-markdown.ts`), so an agent rewriting a page keeps its images. Web images stay `![alt](https://…)`. `pageText` shows `[image: <alt> (file id <id>)]`.

**Why a Files row and not bytes in the page.** Images as base64 `data:` URLs in the page JSON were considered and rejected: every save, co-editing step, version checkpoint (up to 30 per page) and search-text rebuild would carry the bytes, a large photo would pass the 1,000,000-character step and 4 MB save limits, and agents and the sharing gate could not refer to an image by id. A Files row reuses what exists: the `original` column or private blob storage (`ENSEMBLE_FILE_STORAGE`), the hosted caps, Trash and purge, backups, reading through a shared page, and attachment for agents. The costs: each image is a file in Files and counts toward the hosted plan's 10 files and 50 MB, and an image copied into a page in another space shows as unavailable there.

**Lifecycle.**

- Removing an image from a page leaves its file in Files, so Undo, page history and other pages that show it keep working. Nothing removes files no page uses; delete them in Files.
- Deleting the file in Files leaves the node, and the page shows "Image unavailable" with "Its file was deleted from Files." Restoring the file from Trash brings the image back.
- Duplicating a page or saving it as a template keeps the same file id.
- Backups: an image is a Files original, so it is in the database dump while kept in the `original` column, or in the blob container (which the nightly backup does not copy again) when blob storage is on ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)). Page JSON and its versions hold only the id.

**Known limitations.**

- Download (PDF, Word, Markdown, web page, text) leaves images out.
- Images on task pages opened through a shared board are unavailable to its viewers, as file cards are.
- A mixed drop puts file cards in the line and images below it; pasted HTML keeps each image in place.
- The editor has no picker for an image already in Files (an agent can place one with Markdown), and no captions, cropping, rotation or replacing an image in place.

**Future work (not built yet).** This is a plan, not current behaviour: today an image over 2 MB is refused. The plan is to accept source images up to 10 MB, compress or resize them before saving so the stored image is close to 2 MB, keep 2 MiB (2,097,152 bytes) as the enforced final limit, and then insert the result into the page. To settle first:

- quality settings: the JPEG/WebP quality to start from and how far to step down;
- transparency: PNG and WebP alpha would be lost as JPEG, so images with alpha need a format that keeps it;
- EXIF orientation: apply it before re-encoding, then drop the tag;
- animated GIFs: re-encoding keeps one frame, so refuse them or keep them as they are;
- failure: when compression cannot reach the limit, refuse with the same message and never store more than 2 MiB;
- resource safeguards: check pixel limits before decoding, cap memory and CPU per image, and decide where it runs: in the browser (canvas or `createImageBitmap`, keeping the server light) or on the server (a bounded worker and an image library the server does not have today).

## 7. Agents, the assistant and editors

File text is always passed on as information, not instructions. Which files each agent gets, how pictures reach models that read images, and the limits are in [38](38_AGENT_READABLE_FILES.md).

**What counts as attached.** `files/attached.ts` collects the files on the task's page, its project's page and files tagged with the task, plus the original a page was converted from (`sourceFileId`), even after that page becomes a task. Originals stay attached through nested page content and bulk Trash/Undo.

- **Ensemble's agent:** the attached files follow its brief as the files themselves; `view_attachment` opens one again; `save_attachment` (research and code runs) copies the original into the work folder (`attachments/<name>`) ([38](38_AGENT_READABLE_FILES.md)).
- **The coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity):** the originals are copied for the job and their paths listed in the prompt: to `<workspace>/files/<jobId>/` when the run may read outside its folder, otherwise to `<folder>/.ensemble/attachments/<jobId>/` (git-ignored). Copies are removed when the job ends. GitHub Copilot also gets them with its first message: images inline (up to 3 MB, for models that take images), other files as links ([30 §3](30_ENGINES.md)).
- **Paired computers:** the claim's task description gets a "Files attached" section naming the files. Before queueing the local job, the computer downloads originals through `GET /api/devices/self/jobs/:id/attachments/:fileId` with the owning device token and the active `x-ensemble-job-lease` header. The route checks that the file is still attached to this task; it is not a general Files download. It also supplies the full source of diagrams embedded in the page, saved as `.ensemble-diagram.txt` files. The runner remaps page references to the copies' local ids before starting. Transfers are capped at 100 MB per run (`remote/accept.ts`). Receiving originals needs CLI 0.3.11+ or desktop 0.3.8+ on the computer.
- **The assistant:**
  - `hub_list_files` lists files and `hub_view_file` opens one: the model is given the file itself. `hub_import_app_file` brings a file or attachment in from a connected app like `POST /api/documents/import`, after Apply (its preview says when the app is not ready or the hosted plan's 10 files are used). `hub_create_page` and `hub_update_page` attach a file with a `[@name](ensemble://file/<id>)` link and show an image with `![alt](ensemble://file/<id>)` on its own line ([§6](#images-in-pages)). `hub_import_dataset` with `fileId` makes a Plots dataset from a CSV, TSV or `.xlsx` sheet ([11](11_HOW_THE_ASSISTANT_WORKS.md)).
  - `hub_file_edit_info` and `hub_edit_file` (`assistant/tools/file-edits.ts`): read the current SHA-256, then replace one unique passage in a Word, PowerPoint, text, code or CSV file, or edit supported spreadsheet cells and rows. Office edits keep the rest of the package and run in the bounded worker (`files/office-edit.ts`, `files/extract-worker.ts`). File ids stay fixed. `PUT /api/documents/:id/content` and cell patches accept `expectedSha256`; `replaceFileBytes` checks it under the storage lock and refuses a stale write (409 "The file changed. Read it again before editing.").
  - `hub_file_to_page` makes a supported file into a page; PDF and Word need Markdown from the text the assistant read. `hub_export_page_file` writes Word, PDF, Markdown or text into Files, or replaces a named file given its current hash. Server export rebuilds formatting instead of using the browser's original-template export; its PDF uses jsPDF's standard fonts and refuses characters they cannot draw (Word is the alternative). Every original-file edit and export waits for Apply.
  - Scanned PDFs, charts and slide pictures are read by the model itself from the file; Ensemble runs no OCR. There is no audio or video understanding, or slide redesign.
  - **Attaching to a message:** the dock's attach button uploads files into Files or chooses saved ones (`components/files/add-to-message.tsx`, filtered by filename); files can also be dropped or pasted. Up to 8 per message travel as file mentions, and the turn gets their text and pictures ([38](38_AGENT_READABLE_FILES.md)). It does not browse connectors or import remote files; bring those into Files first.
- **Ensemble Node:** a message can carry up to 8 of the sender's files (`files` on `POST /api/node/rooms/:id/messages`); a node reads those on its owner's messages ([35](35_ENSEMBLE_NODE.md)).
- **Editors over MCP** (Context Bridge and hosted `/mcp`): search finds files by name and text, the brief lists a task's files, and `ensemble_read` gives a file's details and its link in Ensemble, not its text. Original bytes are never sent over MCP.
- **Extracted text and models.** A file's extracted text is used for search, previews and page conversion in the Hub, and is not given to models or agents: `EXTRACTED_TEXT_TO_MODELS` in `files/extracted-text-policy.ts` is off ([38 §4](38_AGENT_READABLE_FILES.md#4-ensembles-extracted-text-is-not-sent-to-models)).

### Evidence from agent runs

A coding agent can attach files for its owner to see with the run's result: screenshots, videos, traces, reports, logs and other files ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)). They are not Files: they do not count toward the limits in §3, are not searched and are not given to models. Code: `apps/hub-api/src/evidence/`.

- **On the computer** each run has one evidence folder in Ensemble's data folder, never in the repository. The runtime checks each file and copies it in: no links or hard links, no credential files, no file holding a saved secret value, and the path checked again after opening ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)). Folders are removed 30 days after their run.
- **On the web** each file is a `job_evidence` row (`JobEvidence`, migration `20261103120000_node_device_evidence`): kind, name, media type, size, SHA-256, caption, requirement id and `local`. The bytes are where Files keeps originals (§2): the blob store, else the row's `bytes`. Deleting the run or the account deletes the rows; the hourly sweep removes their blobs.
- **Upload** (`POST /api/devices/self/jobs/:id/evidence`, with the job's lease; [25 §4.11](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#411-the-workers-report-and-evidence)). The server checks everything again: at most 20 MB per file, or 100 MB for video and traces; 100 files per run; credential names refused. The media type is sniffed from the bytes (`sniffMime` in `evidence/limits.ts`), never taken from the name or the computer, and must suit the kind. Text (any `text/` type, JSON, XML, SVG and JavaScript) is redacted (`redactText`) before it is kept.
- **Kept on the computer.** With `ensemble evidence off` only the name and size reach the web (`local`). The run's card says "on this computer, not uploaded".
- **Reading** is for the account whose computer ran the job only: another account gets 404, and link visitors and narrow keys 403. Pictures (not SVG) and video show inline. Everything else downloads (`attachment`). Active formats (HTML, SVG, XML, JavaScript) never run: every answer has `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox`, so `?view=1` shows a file inline with no script, request or form. A file kept on the computer answers 409.
- Ensemble Node lists a run's files on its run card (`data.evidence`, [35 §8.8](35_ENSEMBLE_NODE.md#88-results-and-evidence)).

## 8. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/documents?q=` | → `{ files: FileRecord[], usage: FileUsage }` |
| POST | `/api/documents` | `{ filename, mediaType, dataBase64, summarize?, tags?, purpose? }` → 201 `{ file, document }`; 400 empty, 413 over the size limit, 415 a program (§3). `purpose: "page-image"` applies the page-image checks and adds `image: { format, width, height }` ([§6](#images-in-pages)) |
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
| GET | `/api/node/evidence?jobId=` | A run's evidence ([§7](#evidence-from-agent-runs)) → `{ evidence: [{ id, kind, name, mime, size, caption?, requirementId?, createdAt, local? }] }`; only for the account whose computer ran it |
| GET | `/api/node/evidence/:id` | Bytes; the sniffed type, `nosniff`, a sandbox CSP, `inline` for pictures and video and `attachment` for the rest (`?view=1`: inline in the sandbox), `ETag`/304, ranges; 409 when kept on the computer |

- Hosted, uploads, edits and imports need a verified email. App imports are limited to 60 per 10 minutes per person (429 with `Retry-After`).
- Space members may use files like other shared content (viewers read only).
- Ledger: `document.upload`, `document.import`, `document.update`, `document.cells`, `document.page`, `document.delete`, `artifact.remove`.

## 9. Limitations

- PDFs without a text layer (scans) have no extracted text, so search does not find their words. Models are given the PDF itself.
- Spreadsheet cell edits are refused for workbooks with charts, pivot tables, slicers, macros, form controls, comments or links to other workbooks, because saving would drop them. Values that depend on edited cells refresh when Excel next opens the file.
- Typing into a formula cell saves the value typed, not a formula. New rows are added at the end of a sheet. Sheets over 50,000 rows show their first 50,000 rows and cannot be edited here.
- "Make an editable .xlsx copy" (for .xls, .ods and .numbers) replaces the file in Ensemble; values, formulas and every sheet come across, some formatting, charts and pictures may not.
- Export back to PDF maps fonts to the nearest standard font (Helvetica, Times, Courier). It keeps page size, margins, sizes and colours, and bold, italic, code and links inside a paragraph, but not the original's exact typefaces. Images in a Word file are not carried into the page; they stay in the original.
- Legacy Office formats (.doc, .ppt) and Apple Keynote cannot be previewed; the note says which format to save as.

## 10. Tests

| Test | Covers |
|---|---|
| `apps/hub-api/src/routes/files.integration.test.ts` | Upload, list, usage, hosted caps and the server guard, refusals (§3), original headers, text paging, replace, cell edits, pages from files, delete, isolation, the shared-page rule; page images: 2,097,152 bytes kept and 2,097,153 refused, damaged, SVG and misnamed files, a shared page's viewer and link reading only the images placed on it, page writes refusing new oversized images |
| `packages/shared-types/src/page-images.test.ts`, `page-markdown.test.ts` | The header reader per format, the limit and refusal messages, image Markdown |
| `apps/hub-api/src/pages/collab.test.ts`, `files/attached.integration.test.ts` | Co-editing steps with oversized `data:` images; an image on a task page as an attached file, in agent text, and through a Markdown round trip |
| `apps/hub-api/src/files/originals.integration.test.ts` | Blob storage (§2): key-only rows, reads, replace/purge and the sweep, 503 when unreachable, rows that keep their bytes, the storage settings check |
| `apps/hub-api/src/evidence/evidence.integration.test.ts`, `evidence/files.test.ts` | Evidence (§7): the upload's lease, sizes, sniffed types, credential names, redaction, active formats as downloads in a sandbox, owner-only reads, files kept on the computer, the blob store and its sweep; on the computer, links, hard links, swapped files, saved secret values |
| `apps/hub-api/src/files/extract.test.ts` | Extraction per format and its limits |
| `apps/hub-api/src/files/import.integration.test.ts`, `attached.integration.test.ts`, `connectors/items/downloads.test.ts` | Import sources and states, downloads per app, attached files for agents, `view_attachment` / `save_attachment`, no extracted text to models |
| `apps/hub-api/src/routes/artifacts.integration.test.ts` | §11: the list, reader, Remove and suppression, re-attach, the 409 for uploads, isolation, members refused |
| `apps/hub-web/components/files/*.test.tsx`, `components/editor/file-attach.test.tsx`, `lib/files/*.test.ts` | From your apps, duplicates (Skip, Replace), refusals on rows, search and Retry, Present and Full screen (keys, clicks, hidden slides, the in-page layer), attaching in the editor |
| `apps/hub-web/components/editor/page-image.test.tsx` | `/image`, drop and paste, progress, refusals before sending and Attach as file, pasted `data:` images, attributes through save and HTML, the controls by keyboard and button, read-only, loading with share headers and the unavailable state |
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
