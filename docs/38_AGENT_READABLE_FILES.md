# 38 · How agents get files, pictures, plots and diagrams

Attach the original file, picture, plot or diagram you want an agent to use. Ensemble passes the file itself and lets the selected model or agent read it. It does not run OCR or substitute its own extracted text.

If a size limit or provider refusal prevents delivery, the agent is told which file was left out and why. File content is treated as information, never instructions.

## 1. What each surface sends

| Where you are working | How to provide the file |
| --- | --- |
| Assistant chat | Upload, drag, paste, choose from Files or mention a file. A message accepts up to eight files |
| Ensemble Node | Attach files to your message. A node can open its owner's Files; another person's file is named with an access limitation |
| A task assigned to an agent | Attach files to the task or its project page, use a page's source file, or tag a file with the task |
| Plots and diagrams on a task page | Mention the plot, dataset or diagram so it is included with the page context |

You can also ask for a saved file by name, summary or text. If several files match, the assistant should ask which one you mean. Choosing an existing file does not upload it again.

Task diagrams supply their source, up to 30,000 characters. Plots supply chart settings, columns, row count and the first 20 rows as CSV. Longer tables are labelled as previews.

## 2. Models with a key and included models

Every attachment is sent as an image or file with its media type. The provider decides what it can read. PNG, JPEG, GIF and WebP are recognized from their bytes; other formats are sent as files.

One request carries up to **20 attachments totaling 32 MB**. In a long conversation, newer files take priority within those limits. Older files become a note so they are not resent on every turn.

If the provider refuses the attachments, Ensemble retries with the formats verified for that model, then with no attachments. It reports the removed files. Text-file contents can stand in for their file attachment. There are at most two narrowing retries.

Included-model reservations count a picture as 8,000 input tokens. A file counts as its byte size, capped at 150,000 tokens, plus 3,000. Final credits use the provider's reported tokens. See [Included AI](33_INCLUDED_AI.md).

Chat history keeps file mentions, not file bytes. Earlier messages name files as links; the agent can reopen them when needed.

## 3. A person's own subscription agent in chat

Choose your AI plan as the chat model and attach the file normally. Ensemble delivers originals to the agent's computer. Formats that fit the agent's message appear there; other files are saved in the turn's folder and named in the message.

| Agent | Formats placed directly in the message |
| --- | --- |
| Claude Code | PNG, JPEG, GIF and WebP up to 3.75 MB; PDFs up to 32 MB; text files |
| Codex | PNG, JPEG, GIF and WebP; text-file contents |
| GitHub Copilot | Supported picture, PDF and Office extensions; text-file contents |
| Agents using ACP | Pictures or PDFs when the agent reports that capability; text files |

Other formats remain saved files. Reading them depends on the tools and permissions available to that agent. A computer too old to receive turn files reports that Ensemble needs an update. See [Agents and AI plans](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

## 4. Ensemble's extracted text is not sent to models

Ensemble extracts text for its own search, previews and page conversion. That extracted text is not passed to its models or agents in place of your file.

File summaries are different: a model creates a summary from the original when the file is added. Names and summaries help an agent find the right file before opening it.

An editor connected through the Context Bridge can request the original file and Ensemble's extracted text. See [Context Bridge](CONTEXT_BRIDGE.md#5-tools-and-resources).

## 5. Safety

- Files stay subject to space access. Selecting or mentioning one does not grant new access.
- A paired computer downloads only files belonging to a turn it is running.
- File text, pictures, captions and plot data cannot change tools or permissions.
- Requests carrying files are not logged. Saved tool-call records keep the file's ID and name only.

## 7. Files outside the message

When a file cannot fit the agent's input format, the message names it, explains the limit and identifies its saved location. The agent must use its own supported tools to read that original.

There is no file-version pinning: replacing a file before the agent reads it gives the agent the current version. The task's **Open in app** handoff passes its title and description, without attached files. Audio and video understanding is unavailable.

## In the code

The rule: every file the person attaches reaches the model or agent as the file itself. Ensemble does not decide beforehand what a model can read, does not read files for it and runs no OCR. A file is left out only when what Ensemble or the provider can carry is exceeded, or when the provider refuses it, and then the model is told which file and why. This applies in Ensemble chat, in Ensemble Node and on a task an agent runs.

File content is always passed as information, never as instructions.

### 1. What each surface sends: implementation reference

| Surface | Which files | Where | What reaches the model |
|---|---|---|---|
| **Ensemble chat** (Hub assistant) | Files attached to the message (upload, drag, paste or "Choose from Files") and `@file` mentions in it. At most 8 (`CHAT_FILES_MAX`) | `components/assistant/assistant-dock.tsx` sends file mentions; `assistant/attachments.ts` reads them | A model with a key or included: every file, as an image or file part (§2). A person's own subscription agent: the files through its CLI (§3) |
| **Ensemble Node** | Files on the node owner's messages since the node's last turn (`files` on `POST /api/node/rooms/:id/messages`) | `node/routes.ts` checks the sender owns them; `node/brain.ts` passes the owner's files to the turn as file mentions | The same as Ensemble chat. Files on another person's message are named with a note that the node cannot open them: a node opens only its owner's own Files ([35](35_ENSEMBLE_NODE.md)) |
| **Ensemble's own agent on a task** | The task's attached files: on its page (mentions and blocks with `attrs.fileId`, including page images), on its project's page, the page's source file, files tagged with the task (`files/attached.ts`) | `workspace/agent.ts` brief, `workspace/tools.ts` | Every file after the brief, as an image or file part; `view_attachment` opens one again |
| **Coding agents on a task** (Claude Code, Codex, Cursor, Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code) | The same task files | `copyForEngine` in `workspace/agent.ts` | The originals copied for the run with their paths in the prompt; the agent opens them with its own tools. GitHub Copilot also gets small images inline ([30](30_ENGINES.md)) |
| **Paired computers** | The same task files | `remote/accept.ts` | Originals downloaded under the job lease, then as above ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| **Plots and diagrams on a task page** | `plot`/`dataset` and diagram mentions on the page | `pages/agent-context.ts` (`pageAgentText`, used by the brief and `read_page`) | A diagram's full source (up to 30,000 characters); a plot's chart settings, its data's columns and row count, and the first 20 rows as CSV, labelled as a preview when the table is longer |

In chat, `hub_list_files` finds files by name, summary or text when the person asks for one in words ("the Q3 deck"), each with its summary; it tells the model to ask which file is meant when several match. `hub_view_file` opens a file by id: the model is given the file itself. Choosing a saved file never uploads it again.

### 2. Models with a key and included models: implementation reference

`files/model-input.ts` attaches every file: a PNG, JPEG, GIF or WebP picture (recognised from its bytes) as an image part, anything else (PDF, Office, text, other pictures, audio, video…) as a file part with its media type. The model's provider decides what it reads.

**What one request carries.** Up to 20 attachments and 32 MB of them together (`MODEL_ATTACHMENTS_PER_REQUEST`, `MODEL_ATTACH_TOTAL_BYTES`): what Ensemble itself can carry, including a desktop or CLI included-model turn (64 MB of base64, `routes/included.ts`). A file past that is named with the tool that opens it. In a running conversation the newest 20 attachments within 32 MB are kept and older ones become a note (`keepRecentAttachments`), so a long run does not resend them every turn.

**When the provider refuses.** If a request with attachments is refused (an answer worded about pictures or files, or any 400, 413 or 415), it goes again with only the attachments verified for that model, then with none (`attachmentsRefused`, `narrowAttachments` in `lib/vision.ts`); the turn says so (a status line in chat, an engine note on a task) and the model is told which files were removed. A text file's own contents stand in for its file part. What is verified:

| Models | Pictures | Files |
|---|---|---|
| Included: GPT-6 Luna, GPT-6.1 Sol, GPT-5 mini, GPT-4.1 mini, Grok 4.7 | Yes | PDF (including scans), .docx, .pptx, .xlsx, CSV, Markdown, JSON, text and code (catalog flags `images` and `documents` in `packages/shared-types/src/included.ts`) |
| Included: DeepSeek V4 Flash | No | No |
| Claude with an Anthropic key (3.5 and later) | Yes | PDF and text |
| OpenAI models with an OpenAI key | GPT-4o and later, o-series | PDF |
| Other keys (Google, Mistral, OpenRouter, Copilot, Ollama…) | By model family (`modelReadsImages`) | No |

Every included deployment was checked on Foundry with files whose answer is only inside the file: each read a text PDF, a scanned (image-only) PDF, a .docx, a .pptx, a .xlsx, a CSV, a Markdown file, a JSON file and a PNG, and answered correctly. An archive (.zip) is refused with "Invalid file data… valid file MIME type".

**Credits.** An included-model reservation counts a picture as 8,000 input tokens and a file as its size in bytes, at most 150,000 tokens, plus 3,000 (`runtime/included.ts`, `included.py`). The call is settled on the tokens Azure reports ([33](33_INCLUDED_AI.md)).

**Transport.** hub-api writes user content as OpenAI chat parts: `{type:"image_url"}` and `{type:"file", file:{filename, file_data}}`. Chat-compatible providers take them as they are; `runtime/content-parts.ts` (and `apps/agent-runtime/ensemble_agent/content_parts.py`, its Python mirror) rewrites them for the OpenAI Responses API (`input_image`, `input_file`) and the Anthropic Messages API (`image` blocks; text files as text `document` blocks, every other file as a base64 `document` block with its own media type; joined to the tool-result turn they follow). Requests to GitHub Copilot that carry a picture add `Copilot-Vision-Request: true`.

A file a tool opened (`hub_view_file`, `view_attachment`) follows all of that step's tool results as a user message, narrowed the same way after a refusal (`partsAtStage`).

**History.** Chat stores only the file mentions. A replayed earlier message names its files as links, and the model opens them again if it needs to. File bytes go only into the model request: they are not stored with the conversation, the tool call or the run trace.

### 3. A person's own subscription agent in chat: implementation reference

When the chat model is one of the person's own subscriptions, the prompt names the attached files ("These come with this message as files…") and `runSubscriptionTurn` (`subscriptions/turn.ts`) delivers every one to the agent's computer. The computer downloads each (`GET /api/devices/self/assistant-turns/:id/files/:fileId`, only the turn's own files, only while the turn runs) into the turn's `files/` folder (`subscriptions/turn-files.ts`), and each goes inside the agent's message in the agent's own input form:

| Agent | Inside the message | Saved in `files/` only |
|---|---|---|
| Claude Code | Pictures (PNG, JPEG, GIF, WebP, up to 3.75 MB) as `image` blocks; PDFs (up to 32 MB) as base64 `document` blocks; text files as text `document` blocks | Word, Excel, PowerPoint, OpenDocument, RTF, Keynote, Numbers, other picture formats, audio, video; larger pictures and PDFs |
| Codex | Pictures (PNG, JPEG, GIF, WebP) as `localImage`; text files as their contents | PDF (text and scanned), Word, Excel, PowerPoint and every other document; other picture formats; audio, video |
| GitHub Copilot | `--attachment`: .png, .jpg, .jpeg, .gif, .webp, .pdf, .doc, .docx, .ppt, .pptx, .xls, .xlsx, .odt, .rtf; text files as their contents | .ods, .odp, .key, .numbers, HEIC, TIFF, SVG, audio, video |
| Cursor's agent, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code (ACP) | Pictures as `image` blocks if the agent reports `image`; PDFs as embedded `resource` if it reports `embeddedContext`; text files embedded, or as their contents | Word, Excel, PowerPoint and every other non-PDF document (with a `resource_link` to the saved file); pictures or PDFs when the agent does not report the capability |

A file is saved only, not put inside the message, where putting it there would fail the whole turn (§7). The message names it, says it is saved in the turn's `files/` folder and why it is not inside the message. In a chat, Ask Ensemble or a routine the agent keeps its own tools ([30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant)), so it can open a saved file itself (a Word file, a deck, a scan) with whatever it has on the computer. The exact rules: [30 §8](30_ENGINES.md#8-your-ai-subscriptions-for-the-assistant).

A computer whose Ensemble is older (`assistantTurns` 1) is not sent the files; the agent is told that updating Ensemble on that computer fixes it ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).

### 4. Ensemble's extracted text is not sent to models: implementation reference

Files extracts text from PDFs with a text layer, Word, PowerPoint, spreadsheets, CSV, Markdown and code ([32 §7](32_FILES.md)) for search, previews and page conversion in the Hub. Ensemble does not give that text to the models and agents it runs: `EXTRACTED_TEXT_TO_MODELS` in `files/extracted-text-policy.ts` is off. The disabled paths are:

- the start of each attached file's text in chat, Ensemble Node and task briefs, and in the assistant's open-page context and a paired computer's task brief (`filesSection`);
- Ensemble's text sent with a file to a person's own agent (`TurnFile.text`, `notGiven` in `subscriptions/turn-files.ts`), and to a computer too old to receive files (`runSubscriptionTurn` `fallback`);
- the read tools: `hub_read_file` (`assistant/tools/files.ts`), `read_attachment` (`workspace/tools.ts`), and uploaded files in `hub_search_context` and `hub_read_context` (`assistant/tools/context.ts`).

A file's **summary** is not that text: a model made it from the file itself when the file was added ([32 §4](32_FILES.md#4-keeping-the-server-light)). Models are given it wherever files are listed for them (`hub_list_files`, the files section of a brief or message), to tell which file is which without opening it, and a file's name and summary are searchable everywhere (`context/graph/search.ts`).

The Context Bridge is the person's own key reading their Files: `ensemble_read` gives a file's details and summary, and `ensemble_get_file` gives Ensemble's text of it when asked and the file itself (`bridge/files.ts`, [CONTEXT_BRIDGE §5](CONTEXT_BRIDGE.md#5-tools-and-resources)).

### 5. Safety: implementation reference

- **Access.** Every read goes through the space's own Files (`filesByIds`, `fileOriginal` filter by space and `deletedAt`). A Node message can carry only the sender's own files; a node reads only its owner's. A computer fetches only the files of a turn it is running. Choosing a file never widens access.
- **Untrusted content.** Files, pictures, captions and plot data arrive marked as information, in the user turn, never in the system prompt. Tools and permissions do not change with what a file says.
- **Logs.** Requests carrying files are not logged; stored tool calls keep the file id and name only.

## 6. Design choices

| Choice | Why |
|---|---|
| Send the file, whatever it is | The person decides what to attach; the models and agents read PDFs (scans included), Office files and pictures themselves. Ensemble connects them, it does not filter |
| Leave a file out only on a real failure | Ensemble's own carrying limit, a provider's refusal, or an agent message format with no place for the kind (which would fail the turn) |
| One narrowing per refusal, at most two | A refused request goes again with the verified attachments, then with none; it never loops |
| No extracted text in place of a file | Ensemble does not hand over its own reading of a person's file |
| Chat attachments are file mentions; page images are ordinary Files ([32](32_FILES.md)) | Persistence, replay, sharing and paired-computer downloads already worked for them |
| Files read as they are now (no version pinning) | Files keeps one original per file |

### 7. Files outside the message: implementation reference

Each case is named to the model when it happens. Closing one is per agent (for example a document-reading MCP server, or the agent's own read tools limited to the turn's `files/` folder), not Ensemble reading the file.

| Who | File types saved in `files/` but not inside the message | Why putting them in would fail |
|---|---|---|
| Claude Code (chat turn) | Word, Excel, PowerPoint, OpenDocument, RTF, Keynote, Numbers; pictures other than PNG, JPEG, GIF, WebP; pictures over 3.75 MB; PDFs over 32 MB; audio, video | Claude's message input takes pictures, PDFs and text; anything else is refused and the turn fails. A turn without own tools cannot open the saved file; current chats, asks and routines with `ownTools` can use Claude Code's own file tools |
| Codex (chat turn) | PDF (text and scanned), Word, Excel, PowerPoint and every other document; other picture formats; audio, video | Codex's input has no document type. Turns without own tools decline every command; current chats, asks and routines with `ownTools` can open the saved file through Codex's tools |
| GitHub Copilot (chat turn) | .ods, .odp, .key, .numbers, HEIC, TIFF, SVG, audio, video | `--attachment` takes only the listed extensions; any other fails the whole run. What Copilot's model does with an attachment is Copilot's: with its default model (copilot 1.0.103) a .docx, .xlsx and .pptx arrived as a name only and a scanned PDF was not read |
| Cursor's agent, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code, Kimi Code (chat turn) | Word, Excel, PowerPoint and every other non-PDF document; pictures and PDFs when the agent does not report the capability | The models behind ACP agents refuse Office types inline; turns without own tools refuse the agent's file permissions. Current chats, asks and routines with `ownTools` can use the agent's tools to open the saved file |

Audio and video understanding and version pinning are unavailable: a file replaced between attaching and reading is read as it is now. The "open in app" handoff (`routes/handoffs.ts`) passes the task's title and description, not its files.

## 8. Tests

| Test | Covers |
|---|---|
| `runtime/content-parts.test.ts`, `agent-runtime/tests/test_content_parts.py` | Image and file parts reach chat, Anthropic and Responses payloads; any file to Anthropic as a document; Copilot's vision header; reservations for pictures and files |
| `lib/vision.test.ts` | Which pictures and files are verified per model; refusal detection; narrowing to verified, then none, with text files' contents |
| `files/model-input.test.ts` | Every file attached as itself; what one request carries; what is kept in a long conversation |
| `files/attached.integration.test.ts` | Files sections without extracted text; `view_attachment` gives the file; `read_attachment` and `hub_read_file` are off; MCP search and `ensemble_read` give a file's summary, not its text |
| `assistant/attachments.test.ts`, `assistant/spaces.integration.test.ts`, `node/node.integration.test.ts` | Chat and Node attachments go as files; uploaded files stay out of `hub_search_context` |
| `included/device.test.ts` | A Responses model's history goes from a computer once |
| `subscriptions/subscriptions.integration.test.ts` | A chat message's file reaches the person's agent through the turn's file route, only that turn's files, only while it runs; an older computer is told to update |
| `subscriptions/subscriptions.test.ts`, `subscriptions/agents.e2e.test.ts`, `remote/assistant.test.ts` | Each agent's input: Claude Code's stream-json blocks, Codex's items, Copilot's `--attachment`, ACP blocks by capability; files outside the message are named with where they are saved and why |
| `workspace/tools-vision.test.ts` | `view_attachment` offered to Ensemble's own model loop; `read_attachment` off |
