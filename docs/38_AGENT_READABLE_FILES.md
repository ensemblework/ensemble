# 38 · How agents read files, pictures, plots and diagrams

The rule: the file reaches the model. Ensemble does not read pictures or scans for a model and runs no OCR. It sends the file itself to every model and agent that reads that kind, in that model's or agent's own input form, and its extracted text only where the model or agent cannot take the file. This applies in Ensemble chat, in Ensemble Node and on a task an agent runs. File content is always passed as information, never as instructions.

## 1. What each surface sends

| Surface | Which files | Where | What reaches the model |
|---|---|---|---|
| **Ensemble chat** (Hub assistant) | Files attached to the message (upload, drag, paste or "Choose from Files") and `@file` mentions in it. At most 8 (`CHAT_FILES_MAX`) | `components/assistant/assistant-dock.tsx` sends file mentions; `assistant/attachments.ts` reads them | A model with a key or included: each file whole when the model reads that kind (§2), else up to 4,000 characters of its text (16,000 together). A person's own subscription agent: the files themselves through its CLI (§3) |
| **Ensemble Node** | Files on the node owner's messages since the node's last turn (`files` on `POST /api/node/rooms/:id/messages`) | `node/routes.ts` checks the sender owns them; `node/brain.ts` passes the owner's files to the turn as file mentions | The same as Ensemble chat. Files on another person's message are named with a note that the node cannot open them: a node works in its owner's space ([35](35_ENSEMBLE_NODE.md)) |
| **Ensemble's own agent on a task** | The task's attached files: on its page (mentions and blocks with `attrs.fileId`, including page images), on its project's page, the page's source file, files tagged with the task (`files/attached.ts`) | `workspace/agent.ts` brief, `workspace/tools.ts` | Files its model reads, whole, after the brief; up to 2,000 characters of each other file (10,000 together); `read_attachment` for text, `view_attachment` to open any attached picture or document whole |
| **Coding agents on a task** (Claude Code, Codex, Cursor, Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity) | The same task files | `copyForEngine` in `workspace/agent.ts` | The originals copied for the run with their paths in the prompt; the agent opens them with its own tools. GitHub Copilot also gets small images inline ([30](30_ENGINES.md)) |
| **Paired computers** | The same task files | `remote/accept.ts` | Originals downloaded under the job lease, then as above ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| **Plots and diagrams on a task page** | `plot`/`dataset` and diagram mentions on the page | `pages/agent-context.ts` (`pageAgentText`, used by the brief and `read_page`) | A diagram's full source (up to 30,000 characters); a plot's chart settings, its data's columns and row count, and the first 20 rows as CSV, labelled as a preview when the table is longer |

In chat, `hub_list_files` finds files by name or text when the person asks for one in words ("the Q3 deck"); it tells the model to ask which file is meant when several match. `hub_read_file` reads text in parts and `hub_view_file` opens a picture or document whole. Choosing a saved file never uploads it again.

## 2. Models with a key and included models

`files/model-input.ts` builds the parts; `lib/vision.ts` decides what each model reads.

| Models | Pictures (PNG, JPEG, GIF, WebP) | Documents sent whole |
|---|---|---|
| Included with Ensemble: GPT-6 Luna, GPT-6.1 Sol, GPT-5 mini, GPT-4.1 mini, Grok 4.7 | Yes | PDF (including scans), Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, Markdown, JSON, text and code (catalog flags `images` and `documents` in `packages/shared-types/src/included.ts`) |
| Included: DeepSeek V4 Flash | No | No: Ensemble's text |
| Claude with an Anthropic key (3.5 and later) | Yes | PDF and text |
| OpenAI models with an OpenAI key | GPT-4o and later, o-series | PDF |
| Other keys (Google, Mistral, OpenRouter, Copilot, Ollama…) | By model family (`modelReadsImages`) | No: Ensemble's text |
| Unknown models | No: unknown is not a yes | No |

Every included deployment was checked on Foundry with files whose answer is only inside the file: each read a text PDF, a scanned (image-only) PDF, a .docx, a .pptx, a .xlsx, a CSV, a Markdown file, a JSON file and a PNG sent as `input_file`/`input_image`, and answered correctly. An archive (.zip) is refused with "Invalid file data… valid file MIME type".

**Which formats go whole.** `modelFileMime` (`packages/shared-types/src/files.ts`): PDF, .docx, .pptx, .xlsx, CSV, Markdown, JSON, and text and code (as `text/plain`). Legacy and Apple formats (.doc, .ppt, .xls, .key, .numbers…), audio and video go as Ensemble's text or their name.

**Limits.**
- Pictures: up to 3.75 MB each (`MODEL_IMAGE_MAX_BYTES`: Anthropic's 5 MB limit applies to the base64), 4 with one message or brief, 8 MB together. Larger pictures are refused with their size, never resized.
- Documents: up to 16 MB each and 16 MB together for one message or brief (`MODEL_FILE_MAX_BYTES`, `MODEL_FILE_TOTAL_BYTES`). A larger one gets the start of its text and a note saying why.
- In a running conversation the newest 8 pictures and files, at most 24 MB of them, are kept; older ones become a note (`keepRecentAttachments`), so a long run does not resend them every turn and a desktop or CLI request stays under its 48 MB body limit.
- Credits: an included-model reservation counts a picture as 8,000 input tokens and a whole file as its size in bytes, at most 150,000 tokens, plus 3,000 (`runtime/included.ts`, `included.py`). The call is settled on the tokens Azure reports ([33](33_INCLUDED_AI.md)).

**When a provider refuses.** A refused picture ("image_url is only supported…", or over its size limit) or a refused file ("Invalid file data…") is not retried as is: the request goes once more with each picture or file replaced by a note naming it (and, for a file, the text tool that reads it), and the turn says so: in chat as a status line, on a task as an engine note (`imagesRefused`/`withoutImages`, `filesRefused`/`withoutFiles`). A model that does not read pictures is told plainly, for each one, that it was not shown and that it should say so rather than guess.

**Transport.** hub-api writes user content as OpenAI chat parts: `{type:"image_url"}` and `{type:"file", file:{filename, file_data}}`. Chat-compatible providers take them as they are; `runtime/content-parts.ts` (and `apps/agent-runtime/ensemble_agent/content_parts.py`, its Python mirror) rewrites them for the OpenAI Responses API (`input_image`, `input_file`) and the Anthropic Messages API (`image` blocks; PDFs as base64 `document` blocks, text as text `document` blocks; joined to the tool-result turn they follow). Requests to GitHub Copilot that carry a picture add `Copilot-Vision-Request: true`. A picture or file a tool opened (`hub_view_file`, `view_attachment`) follows all of that step's tool results as a user message, if the model still reads that kind (`readableParts`).

**History.** Chat stores only the file mentions. A replayed earlier message names its files as links, and the model opens them again if it needs to. Picture and file bytes go only into the model request: they are not stored with the conversation, the tool call or the run trace.

## 3. A person's own subscription agent in chat

When the chat model is one of the person's own subscriptions, the prompt names the attached files ("These come with this message as files…") and `runSubscriptionTurn` (`subscriptions/turn.ts`) hands the files themselves to the agent's computer. The computer downloads each one (`GET /api/devices/self/assistant-turns/:id/files/:fileId`, only the turn's own files, only while the turn runs) into the turn's `files/` folder (`subscriptions/turn-files.ts`), and each driver gives them to its agent the way the agent's own app would:

| Agent | Pictures | PDF | Text, code, CSV, JSON | Word, Excel, PowerPoint, other |
|---|---|---|---|---|
| Claude Code | `image` block (up to 3.75 MB) | base64 `document` block | text `document` block | text `document` block with Ensemble's text |
| Codex | `localImage` | Ensemble's text | its own text | Ensemble's text |
| GitHub Copilot | `--attachment` | `--attachment` and Ensemble's text | its own text in the prompt | `--attachment` (.docx, .xlsx, .pptx) and Ensemble's text |
| Cursor and the ACP agents (Grok Build, OpenCode, Gemini CLI, Antigravity) | `image` block when the agent takes images | embedded `resource` when it takes embedded content | embedded text `resource` | a link to the saved file and Ensemble's text |

Ensemble's text goes where an agent's own input form does not take the format: Codex takes no documents, Copilot's `--attachment` refuses text files and gives some documents to its model as a name only, and the models behind ACP agents refuse Office types inline. A scanned PDF read through Ensemble's text has none; the agent is told so. A computer whose Ensemble is older (`assistantTurns` 1) gets Ensemble's text of the files after the prompt instead ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

## 4. Documents without a model that reads them

Ensemble's text comes from Files' extraction ([32 §7](32_FILES.md)): PDFs with a text layer (page markers kept), Word, PowerPoint (slides and notes), spreadsheets (2,000 rows a sheet), CSV, Markdown, code and other text, redacted and capped at 400,000 characters. A file uploaded just before a chat message gets up to 20 seconds to finish extracting (`settleFileText`).

| Input | What a model without whole files gets |
|---|---|
| Scanned PDF | "No text was found in this file; a scanned page or a picture has none." |
| Encrypted or corrupt file | The model is told the file could not be read |
| Legacy Office (.doc, .ppt), Keynote | Not read; the note names the format to save as |
| Audio, video | Name, kind and size only |

## 5. Safety

- **Access.** Every read goes through the space's own Files (`filesByIds`, `fileText`, `fileOriginal` filter by space and `deletedAt`). A Node message can carry only the sender's own files; a node reads only its owner's. A computer fetches only the files of a turn it is running. Choosing a file never widens access.
- **Untrusted content.** Files, pictures, captions and plot data arrive marked as information, in the user turn, never in the system prompt. Tools and permissions do not change with what a file says.
- **Logs.** Requests carrying pictures or files are not logged; stored tool calls keep the file id and name only.

## 6. Design choices

| Choice | Why |
|---|---|
| Send the file, not Ensemble's reading of it | The models and agents read PDFs (scans included), Office files and pictures themselves, better than an extraction pipeline would; Ensemble's job is delivery |
| Formats, models and agents checked before they are trusted | Each included deployment was probed with the formats above; an agent's own input form is used only as far as its CLI documents and accepts it. Unknown means Ensemble's text |
| One fallback per refusal | A refused picture or file becomes a note once; the turn never loops on a provider error |
| Chat attachments are file mentions; page images are ordinary Files ([32](32_FILES.md)) | Persistence, replay, sharing and paired-computer downloads already worked for them |
| Files read as they are now (no version pinning) | Files keeps one original per file |

## 7. Not built

- Documents whole for models with a key other than Claude (PDF and text) and OpenAI (PDF).
- Audio and video understanding.
- Version pinning: a file replaced between attaching and reading is read as it is now.
- The "open in app" handoff (`routes/handoffs.ts`) passes the task's title and description, not its files.

## 8. Tests

| Test | Covers |
|---|---|
| `runtime/content-parts.test.ts`, `agent-runtime/tests/test_content_parts.py` | Image and file parts reach chat, Anthropic and Responses payloads; Copilot's vision header; reservations for pictures and files |
| `lib/vision.test.ts` | Which models get pictures and which documents whole; refusal detection and the fallback notes |
| `files/model-input.test.ts` | Pictures recognised by bytes; documents whole with no duplicate excerpt; size budgets; what is kept in a long conversation |
| `assistant/attachments.test.ts` | File mentions as attachments, the 8-file cap, a missing file reported, replay notes |
| `included/device.test.ts` | A Responses model's history goes from a computer once |
| `subscriptions/subscriptions.integration.test.ts` | A chat message's file reaches the person's agent through the turn's file route, only that turn's files, only while it runs; an older computer gets Ensemble's text |
| `subscriptions/subscriptions.test.ts`, `subscriptions/agents.e2e.test.ts`, `remote/assistant.test.ts` | Each agent's input: Claude Code's stream-json blocks, Codex's items, Copilot's `--attachment`, ACP blocks by capability |
| `workspace/tools-vision.test.ts` | `view_attachment` offered only to a model that opens files |
