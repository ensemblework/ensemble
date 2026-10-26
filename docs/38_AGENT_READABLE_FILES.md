# 38 · How agents read files, pictures, plots and diagrams

The rule: the file reaches the model. Ensemble does not read pictures or scans for a model and runs no OCR. It sends the file itself to every model and agent that reads that kind, in that model's or agent's own input form. Where a model or agent cannot take a file, it is told the file's name and why it was not given; Ensemble's extracted text does not go in its place (§4). A text file's own contents are the file and go as they are. This applies in Ensemble chat, in Ensemble Node and on a task an agent runs. File content is always passed as information, never as instructions.

## 1. What each surface sends

| Surface | Which files | Where | What reaches the model |
|---|---|---|---|
| **Ensemble chat** (Hub assistant) | Files attached to the message (upload, drag, paste or "Choose from Files") and `@file` mentions in it. At most 8 (`CHAT_FILES_MAX`) | `components/assistant/assistant-dock.tsx` sends file mentions; `assistant/attachments.ts` reads them | A model with a key or included: each file whole when the model reads that kind (§2), a text file's contents, else a note that it was not given. A person's own subscription agent: the files themselves through its CLI (§3) |
| **Ensemble Node** | Files on the node owner's messages since the node's last turn (`files` on `POST /api/node/rooms/:id/messages`) | `node/routes.ts` checks the sender owns them; `node/brain.ts` passes the owner's files to the turn as file mentions | The same as Ensemble chat. Files on another person's message are named with a note that the node cannot open them: a node works in its owner's space ([35](35_ENSEMBLE_NODE.md)) |
| **Ensemble's own agent on a task** | The task's attached files: on its page (mentions and blocks with `attrs.fileId`, including page images), on its project's page, the page's source file, files tagged with the task (`files/attached.ts`) | `workspace/agent.ts` brief, `workspace/tools.ts` | Files its model reads, whole, after the brief; text files' contents; the others named as not given. `view_attachment` opens any attached picture or document whole |
| **Coding agents on a task** (Claude Code, Codex, Cursor, Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity) | The same task files | `copyForEngine` in `workspace/agent.ts` | The originals copied for the run with their paths in the prompt; the agent opens them with its own tools. GitHub Copilot also gets small images inline ([30](30_ENGINES.md)) |
| **Paired computers** | The same task files | `remote/accept.ts` | Originals downloaded under the job lease, then as above ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| **Plots and diagrams on a task page** | `plot`/`dataset` and diagram mentions on the page | `pages/agent-context.ts` (`pageAgentText`, used by the brief and `read_page`) | A diagram's full source (up to 30,000 characters); a plot's chart settings, its data's columns and row count, and the first 20 rows as CSV, labelled as a preview when the table is longer |

In chat, `hub_list_files` finds files by name or text when the person asks for one in words ("the Q3 deck"); it tells the model to ask which file is meant when several match. `hub_read_file` reads text in parts and `hub_view_file` opens a picture or document whole. Choosing a saved file never uploads it again.

## 2. Models with a key and included models

`files/model-input.ts` builds the parts; `lib/vision.ts` decides what each model reads.

| Models | Pictures (PNG, JPEG, GIF, WebP) | Documents sent whole |
|---|---|---|
| Included with Ensemble: GPT-6 Luna, GPT-6.1 Sol, GPT-5 mini, GPT-4.1 mini, Grok 4.7 | Yes | PDF (including scans), Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, Markdown, JSON, text and code (catalog flags `images` and `documents` in `packages/shared-types/src/included.ts`) |
| Included: DeepSeek V4 Flash | No | No: not given (text files go as their contents) |
| Claude with an Anthropic key (3.5 and later) | Yes | PDF and text |
| OpenAI models with an OpenAI key | GPT-4o and later, o-series | PDF |
| Other keys (Google, Mistral, OpenRouter, Copilot, Ollama…) | By model family (`modelReadsImages`) | No: not given (text files go as their contents) |
| Unknown models | No: unknown is not a yes | No |

Every included deployment was checked on Foundry with files whose answer is only inside the file: each read a text PDF, a scanned (image-only) PDF, a .docx, a .pptx, a .xlsx, a CSV, a Markdown file, a JSON file and a PNG sent as `input_file`/`input_image`, and answered correctly. An archive (.zip) is refused with "Invalid file data… valid file MIME type".

**Which formats go whole.** `modelFileMime` (`packages/shared-types/src/files.ts`): PDF, .docx, .pptx, .xlsx, CSV, Markdown, JSON, and text and code (as `text/plain`). Legacy and Apple formats (.doc, .ppt, .xls, .key, .numbers…), audio and video are named as not given. A model that does not take a text file whole gets its contents as text, up to 1 MB each (`MODEL_TEXT_FILE_MAX_BYTES`).

**Limits.**
- Pictures: up to 3.75 MB each (`MODEL_IMAGE_MAX_BYTES`: Anthropic's 5 MB limit applies to the base64), 4 with one message or brief, 8 MB together. Larger pictures are refused with their size, never resized.
- Documents: up to 16 MB each and 16 MB together for one message or brief (`MODEL_FILE_MAX_BYTES`, `MODEL_FILE_TOTAL_BYTES`). A larger one is not given, and the model is told why.
- In a running conversation the newest 8 pictures and files, at most 24 MB of them, are kept; older ones become a note (`keepRecentAttachments`), so a long run does not resend them every turn and a desktop or CLI request stays under its 48 MB body limit.
- Credits: an included-model reservation counts a picture as 8,000 input tokens and a whole file as its size in bytes, at most 150,000 tokens, plus 3,000 (`runtime/included.ts`, `included.py`). The call is settled on the tokens Azure reports ([33](33_INCLUDED_AI.md)).

**When a provider refuses.** A refused picture ("image_url is only supported…", or over its size limit) or a refused file ("Invalid file data…") is not retried as is: the request goes once more with each picture or file replaced by a note naming it, and the turn says so: in chat as a status line, on a task as an engine note (`imagesRefused`/`withoutImages`, `filesRefused`/`withoutFiles`). A model that does not read pictures is told plainly, for each one, that it was not shown and that it should say so rather than guess.

**Transport.** hub-api writes user content as OpenAI chat parts: `{type:"image_url"}` and `{type:"file", file:{filename, file_data}}`. Chat-compatible providers take them as they are; `runtime/content-parts.ts` (and `apps/agent-runtime/ensemble_agent/content_parts.py`, its Python mirror) rewrites them for the OpenAI Responses API (`input_image`, `input_file`) and the Anthropic Messages API (`image` blocks; PDFs as base64 `document` blocks, text as text `document` blocks; joined to the tool-result turn they follow). Requests to GitHub Copilot that carry a picture add `Copilot-Vision-Request: true`. A picture or file a tool opened (`hub_view_file`, `view_attachment`) follows all of that step's tool results as a user message, if the model still reads that kind (`readableParts`).

**History.** Chat stores only the file mentions. A replayed earlier message names its files as links, and the model opens them again if it needs to. Picture and file bytes go only into the model request: they are not stored with the conversation, the tool call or the run trace.

## 3. A person's own subscription agent in chat

When the chat model is one of the person's own subscriptions, the prompt names the attached files ("These come with this message as files…") and `runSubscriptionTurn` (`subscriptions/turn.ts`) hands the files themselves to the agent's computer. The computer downloads each one (`GET /api/devices/self/assistant-turns/:id/files/:fileId`, only the turn's own files, only while the turn runs) into the turn's `files/` folder (`subscriptions/turn-files.ts`), and each driver gives them to its agent the way the agent's own app would:

| Agent | Given | Not given in a chat turn |
|---|---|---|
| Claude Code | Pictures (PNG, JPEG, GIF, WebP, up to 3.75 MB) as `image` blocks; PDFs (up to 32 MB) as base64 `document` blocks; text files as text `document` blocks | Word, Excel, PowerPoint, OpenDocument, RTF, Keynote, Numbers, other picture formats, audio, video; larger pictures and PDFs |
| Codex | Pictures (PNG, JPEG, GIF, WebP) as `localImage`; text files as their contents | PDF (text and scanned), Word, Excel, PowerPoint and every other document; other picture formats; audio, video |
| GitHub Copilot | `--attachment`: .png, .jpg, .jpeg, .gif, .webp, .pdf, .doc, .docx, .ppt, .pptx, .xls, .xlsx, .odt, .rtf; text files as their contents | .ods, .odp, .key, .numbers, HEIC, TIFF, SVG, audio, video |
| Cursor's agent, Grok Build, OpenCode, Gemini CLI, Antigravity (ACP) | Pictures as `image` blocks if the agent reports `image`; PDFs as embedded `resource` if it reports `embeddedContext`; text files embedded, or as their contents | Word, Excel, PowerPoint and every other non-PDF document (a link to the saved file only); pictures or PDFs when the agent does not report the capability |

Each file not given is named in the message with the reason, and the agent is asked to say it could not open it rather than guess. Why each gap exists, and the exact rules: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant). A computer whose Ensemble is older (`assistantTurns` 1) is not sent the files; the agent is told to say that updating Ensemble on that computer fixes it ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

## 4. Ensemble's extracted text is not sent to models

Files extracts text from PDFs with a text layer, Word, PowerPoint, spreadsheets, CSV, Markdown and code ([32 §7](32_FILES.md)) for search, previews and page conversion. That text is not put into a model's or agent's prompt in place of a file: `EXTRACTED_TEXT_TO_MODELS` in `files/extracted-text-policy.ts` is off. Behind that switch, kept for a later decision:

- the start of each attached file's text in chat, Ensemble Node and the task brief, for formats a model does not take whole (`filesSection`, `filesForModel`);
- Ensemble's text sent with a file to a person's own agent when its CLI cannot take that format (`TurnFile.text`, `notGiven` in `subscriptions/turn-files.ts`), and to a computer too old to receive files (`runSubscriptionTurn` `fallback`);
- excerpts of a page's or task's files in the assistant's open-page context (`assistant/state.ts`) and a paired computer's task brief (`devices/routes.ts`).

A model can still call a read tool itself: `hub_read_file` (chat), `read_attachment` (task) and `ensemble_read` (Context Bridge) return a file's extracted text in parts when asked.

## 5. Safety

- **Access.** Every read goes through the space's own Files (`filesByIds`, `fileText`, `fileOriginal` filter by space and `deletedAt`). A Node message can carry only the sender's own files; a node reads only its owner's. A computer fetches only the files of a turn it is running. Choosing a file never widens access.
- **Untrusted content.** Files, pictures, captions and plot data arrive marked as information, in the user turn, never in the system prompt. Tools and permissions do not change with what a file says.
- **Logs.** Requests carrying pictures or files are not logged; stored tool calls keep the file id and name only.

## 6. Design choices

| Choice | Why |
|---|---|
| Send the file, not Ensemble's reading of it | The models and agents read PDFs (scans included), Office files and pictures themselves, better than an extraction pipeline would; Ensemble's job is delivery |
| Formats, models and agents checked before they are trusted | Each included deployment was probed with the formats above; an agent's own input form is used only as far as its CLI documents and accepts it. Unknown means not given |
| No extracted text in place of a file | Modern models and agent apps read documents themselves; a gap is named precisely and closed per agent later, not papered over with Ensemble's reading |
| One fallback per refusal | A refused picture or file becomes a note once; the turn never loops on a provider error |
| Chat attachments are file mentions; page images are ordinary Files ([32](32_FILES.md)) | Persistence, replay, sharing and paired-computer downloads already worked for them |
| Files read as they are now (no version pinning) | Files keeps one original per file |

## 7. Not given yet

The gaps, by agent or model and file type. Each is named to the model when it happens; closing one is per agent (for example a document-reading MCP server, or the agent's own read tools limited to the turn's `files/` folder), not Ensemble reading the file.

| Who | File types not given | Why |
|---|---|---|
| Claude Code (chat turn) | Word, Excel, PowerPoint, OpenDocument, RTF, Keynote, Numbers; pictures other than PNG, JPEG, GIF, WebP; pictures over 3.75 MB; PDFs over 32 MB; audio, video | Claude's message input takes pictures, PDFs and text; the chat turn runs with no tools of Claude Code's own |
| Codex (chat turn) | PDF (text and scanned), Word, Excel, PowerPoint and every other document; other picture formats; audio, video | Codex's input takes pictures and text only; the chat turn declines every command |
| GitHub Copilot (chat turn) | .ods, .odp, .key, .numbers, HEIC, TIFF, SVG, audio, video. Attached but seen as a name only with Copilot's default model: .docx, .xlsx, .pptx; a scanned PDF not read | `--attachment` takes only the listed extensions; what Copilot's model does with an attachment is Copilot's |
| Cursor's agent, Grok Build, OpenCode, Gemini CLI, Antigravity (chat turn) | Word, Excel, PowerPoint and every other non-PDF document; pictures and PDFs when the agent does not report the capability | The models behind ACP agents refuse Office types inline; the chat turn refuses the agent's file permissions |
| DeepSeek V4 Flash (included) | Every picture and document except text files | The deployment takes text only |
| Models with a key other than Claude and OpenAI | Every document except text files | Not checked per provider; unknown means not given |
| Claude with a key | Word, Excel, PowerPoint and other Office formats | The Messages API takes PDFs and text documents |
| OpenAI with a key | Every document except PDF and text files | Chat Completions takes PDFs as files |
| Every model | Audio and video | Not built |

Also not built: version pinning (a file replaced between attaching and reading is read as it is now), and the "open in app" handoff (`routes/handoffs.ts`) passes the task's title and description, not its files.

## 8. Tests

| Test | Covers |
|---|---|
| `runtime/content-parts.test.ts`, `agent-runtime/tests/test_content_parts.py` | Image and file parts reach chat, Anthropic and Responses payloads; Copilot's vision header; reservations for pictures and files |
| `lib/vision.test.ts` | Which models get pictures and which documents whole; refusal detection and the fallback notes |
| `files/model-input.test.ts` | Pictures recognised by bytes; documents whole or named as not given, never extracted text; text files as their contents; size budgets; what is kept in a long conversation |
| `files/attached.integration.test.ts` | The files section names each file and carries no extracted text |
| `assistant/attachments.test.ts` | File mentions as attachments, the 8-file cap, a missing file reported, replay notes |
| `included/device.test.ts` | A Responses model's history goes from a computer once |
| `subscriptions/subscriptions.integration.test.ts` | A chat message's file reaches the person's agent through the turn's file route, only that turn's files, only while it runs; an older computer is told to update, with no extracted text |
| `subscriptions/subscriptions.test.ts`, `subscriptions/agents.e2e.test.ts`, `remote/assistant.test.ts` | Each agent's input: Claude Code's stream-json blocks, Codex's items, Copilot's `--attachment`, ACP blocks by capability; every file not given is named with the agent's reason and no extracted text |
| `workspace/tools-vision.test.ts` | `view_attachment` offered only to a model that opens files |
