# 38 · How agents read files, pictures, plots and diagrams

What a model is given when a person attaches or mentions something: in Ensemble chat, in Ensemble Node, and on a task an agent runs. One read layer serves all three; each surface only decides which files belong to the turn. File content is always passed as information, never as instructions.

## 1. What each surface reads

| Surface | Which files | Where | What the model gets |
|---|---|---|---|
| **Ensemble chat** (Hub assistant) | Files attached to the message (upload, drag, paste or "Choose from Files"), and `@file` mentions typed in it. At most 8 (`CHAT_FILES_MAX`). | `components/assistant/assistant-dock.tsx` sends them as file mentions; `assistant/attachments.ts` reads them | Each file's text (up to 4,000 characters each, 16,000 together) and, for a model that reads images, the pictures themselves |
| **Ensemble Node** | Files on the node owner's messages since the node's last turn (`POST /api/node/rooms/:id/messages` with `files`) | `node/routes.ts` checks the sender owns them; `node/brain.ts` hands the owner's files to the turn as file mentions | The same as Ensemble chat. Files on another person's message are named in the transcript with a note that the node cannot open them: a node works in its owner's space ([35](35_ENSEMBLE_NODE.md)) |
| **Ensemble's own agent on a task** | The task's attached files: on its page (mentions and blocks with `attrs.fileId`, including images placed on the page), on its project's page, the page's source file, and files tagged with the task (`files/attached.ts`) | `workspace/agent.ts` brief and `workspace/tools.ts` | Up to 2,000 characters of each file (10,000 together) in the brief, the pictures after the brief for a model that reads images, `read_attachment` for more text, `view_attachment` to look at another picture |
| **Coding agents** (Claude Code, Codex, Cursor, Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity) | The same task files | `copyForEngine` in `workspace/agent.ts` | The originals copied for the run, with their paths in the prompt; the agent opens pictures and PDFs with its own tools. GitHub Copilot also gets small images inline ([30](30_ENGINES.md)) |
| **Paired computers** | The same task files | `remote/accept.ts` | Originals downloaded under the job lease, then read locally as above ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)) |
| **Plots and diagrams on a task page** | `plot`/`dataset` mentions and diagram mentions on the page | `pages/agent-context.ts` (`pageAgentText`, used by the brief and `read_page`) | A diagram's full source (up to 30,000 characters). A plot's chart settings, its data's columns and row count, and the first 20 rows as CSV, labelled as a preview when the table is longer |

In chat, `hub_list_files` finds files by name or text when the person asks for one in words ("the Q3 deck"); its description tells the model to ask which file is meant when several match. `hub_read_file` reads text in parts and `hub_view_file` opens a picture by id. Files are referenced where they are: choosing a saved file never uploads it again.

## 2. Pictures

`files/model-input.ts` turns a file into an image part (`{type:"image_url", image_url:{url:"data:…;base64,…"}}`):

- **Kinds.** PNG, JPEG, GIF and WebP, recognised from the first bytes (`sniffImage`), not the name. Anything else, including SVG, HEIC and TIFF, is described instead: "not a PNG, JPEG, GIF or WebP picture… a PNG or JPEG copy can be read."
- **Size.** Up to 5 MB a picture (`MODEL_IMAGE_MAX_BYTES`, the smallest provider limit). Larger pictures are refused with their size, never resized.
- **How many.** Up to 4 pictures with one message or brief, 12 MB together. The rest are listed with "open it with hub_view_file" (chat) or "view_attachment" (task). In a running conversation only the newest 4 pictures are kept; older ones become a note (`keepRecentPictures`), so a long run does not resend them every turn.
- **Order.** A picture a tool opened follows all of that step's tool results as a user message, which every provider API accepts.
- **History.** Chat stores only the file mentions. A replayed earlier message says which files it had, and the model opens them again if it needs to.

### Which models get pictures

`lib/vision.ts` `modelReadsImages(provider, model)` decides:

| Models | Pictures |
|---|---|
| Included with Ensemble | The catalog's `images` flag (`packages/shared-types/src/included.ts`): GPT-6 Luna, GPT-6.1 Sol, Grok 4.7, GPT-5 mini and GPT-4.1 mini yes; DeepSeek V4 Flash no |
| A person's own key (OpenAI, Anthropic, Google, Mistral, OpenRouter, Copilot, Ollama, Kimi, Qwen…) | By model family: GPT-4o/4.1/5/6, o1/o3/o4-mini, Claude 3 and later, Gemini, Gemma 3, Grok 4, Pixtral and recent Mistral Small/Medium, Qwen VL, Llama 3.2 Vision and 4, LLaVA-style local models |
| Anything else, `cursor`, and the subscription agents in Ensemble chat | No. Unknown is not a yes |

A model that does not read images is told plainly, for each picture, that it was not shown and that it should say so rather than guess. If a provider still refuses image input ("image_url is only supported by certain models"), the request is sent once more with each picture replaced by a note and the turn says so (`imagesRefused`, `withoutImages`): in chat as a status line, on a task as an engine note.

### Transport

hub-api writes user content as OpenAI chat parts. Chat-compatible providers take them as they are; `runtime/content-parts.ts` (and `apps/agent-runtime/ensemble_agent/content_parts.py`, its Python mirror) rewrites them for the Anthropic Messages API (`image` blocks with a base64 source, joined to the tool-result turn they follow) and the OpenAI Responses API (`input_image`). Requests to GitHub Copilot that carry a picture add `Copilot-Vision-Request: true` (`withVision`). Subscription agents used as the chat model get text only: `subscriptions/turn.ts` sends them one text prompt.

Image bytes go only into the model request: they are not stored with the conversation, the tool call or the run trace.

## 3. Documents

Text comes from Files' extraction ([32 §7](32_FILES.md)): PDFs with a text layer (page markers kept), Word, PowerPoint (slides and notes), spreadsheets (2,000 rows a sheet), CSV, Markdown, code and other text. Extraction is redacted and capped at 400,000 characters. A file uploaded just before a chat message is sent gets up to 20 seconds to finish extracting (`settleFileText`); after that the model is told it is still being read.

| Input | What happens |
|---|---|
| Scanned PDF (no text layer) | "No text was found in this file; a scanned page or a picture has none." A picture of the page (PNG or JPEG) can be read by a model that reads images; coding agents can open the PDF themselves |
| Encrypted or corrupt file | Extraction fails and the model is told the file could not be read |
| Legacy Office (.doc, .ppt), Keynote | Not read; the note names the format to save as |
| Audio, video | Name, kind and size only |

## 4. Safety

- **Access.** Every read goes through the space's own Files (`filesByIds`, `fileText`, `fileOriginal` filter by space and `deletedAt`). A Node message can only carry the sender's own files; a node reads only its owner's. Choosing a file never widens access.
- **Untrusted content.** File text, pictures, captions and plot data arrive marked as information, in the user turn, never in the system prompt. Tools and permissions do not change with what a file says.
- **Logs.** Model requests carrying pictures are not logged; stored tool calls keep the file id and name only.

## 5. Not built

- OCR, rendering PDF pages or slides to pictures, and native PDF input to providers. A scanned PDF is read only by a coding agent or as a picture of its pages.
- Pictures for subscription agents used as the Ensemble chat model.
- Audio and video understanding.
- Version pinning: a file replaced between attaching and reading is read as it is now.
- The "open in app" handoff (`routes/handoffs.ts`) passes the task's title and description, not its files.

## 6. Tests

| Test | Covers |
|---|---|
| `runtime/content-parts.test.ts`, `agent-runtime/tests/test_content_parts.py` | Image parts reach chat, Anthropic (after tool results) and Responses payloads unchanged in meaning; Copilot's vision header |
| `lib/vision.test.ts` | Which models get pictures; refusal detection and the text-only retry |
| `files/model-input.test.ts` | Pictures recognised by bytes; text-only models told plainly; too large or not-a-picture explained; only the newest pictures kept |
| `assistant/attachments.test.ts` | File mentions as attachments, the 8-file cap, a missing file reported, replay notes |
| `workspace/tools-vision.test.ts` | `view_attachment` offered only to a model that reads images |
