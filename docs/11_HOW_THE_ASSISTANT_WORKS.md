# 11 · How the Ensemble assistant works

A walkthrough of the chat that operates the Hub — what it is, how it reaches your data, and why adding a todo from a chat box needed **no change to the app it changes**.

Written to be read start to finish. Design notes live in [02 §10–11](02_MODULE_INTERACTION_HUB_UI.md#10-the-hub-assistant).

---

## 1. The one-sentence answer

**The assistant never touches your UI.** It calls named functions on your own API, those functions write rows to the same Postgres your pages read, and the pages update because the data changed — not because anything simulated a click.

**Connected apps work the same way.** When Google Workspace or Microsoft 365 is connected, a turn also gets typed tools for those apps (area `apps`): read Gmail, Outlook, Teams, calendars and files, create calendar events that email invites, and create or edit Google Docs, Sheets and Slides or Word, Excel and PowerPoint files. A connected Zoom, Docusign or Jira account adds read-only tools for meetings and transcripts, envelopes, and issues. Every change in a connected app waits for **Apply**, whatever the write policy says ([§8.2](#82-connected-apps)).

The same tool loop also serves selected-text comments and inline `@ensemble` questions on tasks and standalone pages. These use the configured assistant default tier. Enter is the explicit send action; opening a saved answer never invokes a model. The live document and **typed entity mention IDs** travel with inline requests, including uploaded dataset IDs. The page's title/body are supplied directly (up to 24,000 characters), while the account's remaining context is available through user-scoped retrieval tools.

Inline page requests authorize **new diagrams and plots** immediately through `hub_create_diagram` and `hub_create_plot`; `holdsAssistantWrite` in `apps/hub-api/src/assistant/agent.ts` keeps every other write under the normal approval policy. Module and allowed-write-area checks are unchanged. `hub_get_dataset` reads real column names and up to 40 preview rows before plotting; the created plot uses the full stored dataset. Successful artifact tool calls carry saved-resource links, and `components/comments/ensemble-artifacts.ts` inserts persistent document mentions below the reply once per call. Removing an embed does not delete its saved resource or cause a later stream update to reinsert it. Stream errors remain errors even when followed by a completion frame.

The page's existing document mentions also supply stable reference IDs, not only the mentions in the current question. `hub_get_plot` reads an owned chart or a specific space/tile configuration and exposes its dataset IDs for follow-up reads. Repeated mentions of the same entity are deduplicated before saving the page's reference index, so using one data file more than once does not fail the page save.

The first inline status frame supplies the saved answer ID and conversation ID. The document adopts that ID before the model finishes, and Stop follows the same stream after adoption. A dropped stream retains its partial text and saved anchor, and reports an incomplete response rather than a successful empty answer.

See [02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages) for persistence, highlights, request deduplication and the UI contract.

The floating assistant offers Low / Medium / High / Max presets rather than a second independent model configuration. Settings owns each model/thinking/context profile, backed by the account's seven-day Copilot capability cache. A context limit is not presented as a selectable tier unless the transport actually supports that choice. Per-task custom overrides belong to assignment only.

Everything below is the detail of that sentence.

---

## 2. The problem, stated precisely

You wanted a chat that can *do things* to the Hub: add a todo, update a deliverable, write a note on a project, revise a skill. There are three obvious ways to build that, and two of them are traps.

### Trap 1 — drive the browser

Point Playwright at the page, find the "Add task" button, click it, type into the form.

This fails for reasons that compound:

- It **breaks whenever the UI moves**. A renamed button is an outage.
- It can only do what a human can reach on screen, at human speed.
- It **cannot be reviewed**. *"The agent clicked something"* is not an audit trail.
- Two of them cannot run at once, because there is one browser.

Browser automation is not the foundation of Hub actions. The old M365 Copilot driver is **not** coming back.

### Trap 2 — let the model write code

Have the model generate SQL, or a script, and run it.

This is worse. An LLM with arbitrary write access to your database is one hallucinated `WHERE` clause from deleting your board, and nothing in the system can tell a good statement from a bad one before it runs.

### What Ensemble does instead

Your Hub already knows how to do all of these things. Every one of them is a function that already exists behind a button:

```text
"Add task" button          → POST /api/tasks          → prisma.task.create(...)
triage keystroke 'm'       → transitionTask(...)
deliverable checkbox       → prisma.deliverable.update(...)
                           → PATCH /api/projects/:id
```

The assistant is given a **typed catalog of those same operations** and allowed to name one. That is the whole trick. It is not a new capability bolted onto the app — it is the app's existing vocabulary, handed to a model.

This is why there was no code change to the webapp: the operations already existed. What was added was a way to address them by name, a gate in front of them, and a chat to choose between them.

---

The assistant works inside the open Ensemble space. Its tools read and write with that space's user id, so it never sees another space's tasks, people, pages, or connected apps ([28](28_ENSEMBLE_SPACES.md)).

## 3. The moving parts

| Path | LOC | What it is |
|---|---|---|
| `apps/hub-web/components/assistant/assistant-dock.tsx` | 629 | the floating panel: transcript, composer, and the empty state ("Good morning, {first name}" with three generic starter prompts; no record titles) |
| `apps/hub-web/components/assistant/ask-launcher.tsx` | 152 | the round launcher: draggable along the bottom or right edge, position saved in the browser; the configurable shortcut (Command-J by default) toggles the panel |
| `apps/hub-web/components/shell/topbar.tsx` | — | the undo / redo buttons in the app bar |
| `apps/hub-web/components/comments/` | ~700 | text comments and `@ensemble` replies on a page |
| `apps/hub-api/src/assistant/types.ts` | 98 | what a tool *is* — the contract every tool obeys |
| `apps/hub-api/src/assistant/registry.ts` | 143 | the Hub catalog + Zod → JSON Schema for the model |
| `apps/hub-api/src/assistant/apps.ts` | 192 | which connected-app tools a turn gets, the `apps` write switch, the Apply resolver hooks |
| `apps/hub-api/src/assistant/apply.ts` | 123 | Apply: Hub writes in one transaction, then connected-app writes outside it, each ledgered |
| `apps/hub-api/src/assistant/state.ts` | 268 | the system prompt and the live Hub snapshot |
| `packages/shared-types/src/personas.ts` | — | the sentences about the person (`personaBlock`, `personaFor`) |
| `apps/hub-api/src/assistant/agent.ts` | 730 | the loop: ask → tool calls → run → feed back |
| `apps/hub-api/src/assistant/cutoff.ts` | 91 | detects a reply cut off by the provider |
| `apps/hub-api/src/assistant/diagram-skill.ts` | 39 | loads the block-diagram skill for diagram turns |
| `apps/hub-api/src/assistant/tools/` | ~1,500 | Hub tools by area: `tasks`, `projects`, `context`, `graph`, `repos`, `skills`, `reminders`, `fetch`, `watchers`, `diagrams`, `diagram-context`, `plots` |
| `apps/hub-api/src/assistant/tools/google-workspace.ts`, `tools/google/` | ~1,270 | Gmail, Google Calendar, Drive, Docs, Sheets, Slides |
| `apps/hub-api/src/assistant/tools/microsoft-365.ts`, `tools/microsoft/` | ~720 | Outlook mail and calendar, Teams, OneDrive, Word, Excel, PowerPoint (Microsoft Graph v1.0) |
| `apps/hub-api/src/assistant/tools/zoom.ts`, `docusign.ts`, `jira.ts` | ~690 | read only: Zoom meetings, recordings, transcripts and AI summaries; Docusign envelopes; Jira issues |
| `apps/hub-api/src/assistant/tools/apps-common.ts` | 338 | tokens and scopes, vendor HTTP with readable errors, dates and preview wording |
| `apps/hub-api/src/lib/office/` | ~980 | Markdown → HTML and .docx, rows ↔ .xlsx, slides → .pptx, text out of Office files |
| `apps/hub-api/src/routes/assistant.ts` | 313 | HTTP: SSE streaming, conversations, Apply, Stop |
| `apps/hub-api/src/routes/comments.ts` | 255 | HTTP: comments and inline `@ensemble` turns on a page |
| `apps/hub-api/src/routes/misc.ts` | — | `GET /api/undo`, `POST /api/undo`, `POST /api/redo` |
| `apps/hub-api/src/lib/undo.ts` | 467 | the journal: snapshots, inverses, stacks |
| `apps/hub-api/src/bridge/` | — | the same reads, reachable from editors ([docs/13](13_MODULE_CONTEXT_BRIDGE.md)) |
| `apps/agent-runtime/ensemble_agent/models.py` | 1,885 | `complete_with_tools()` and the provider adapters — the model credential |
| `apps/agent-runtime/ensemble_agent/main.py` | 290 | `POST /api/chat/tools` (and `/stream`) — one turn, nothing more |
| `packages/shared-types/src/assistant.ts` | 267 | every shape that crosses the wire |
| `packages/shared-types/src/undo.ts` | — | the undo/redo contract |

**51 Hub tools** (24 read, 27 write) in the static catalog, grouped by the data they touch, plus **38 connected-app tools** (23 read, 15 write) offered per person ([§8.2](#82-connected-apps)).

Roughly **2,000 lines of tools and 600 of orchestration**. The tools are the bulk, and that is the right shape: the interesting part is *what the agent may do*, not the loop that lets it.

---

## 4. A complete trace

You type:

> *"Add a todo to raise the PR on MOSAIC for the changes Shachee asked for."*

Here is every step, in order.

### 4.1 The browser opens a stream

`assistant-dock.tsx` posts to `/api/assistant/turn` and reads the response as Server-Sent Events. It is a hand-rolled reader rather than `EventSource`, because that only issues GETs and this request carries a body:

```http
POST /api/assistant/turn
{ "message": "Add a todo to raise the PR on MOSAIC for …",
  "page": { "path": "/today", "label": "the today page" },
  "tier": "easy" }
```

The first frame back is `status { conversationId }`, before the model is called. The dock keeps that id, so **Stop** on the first message of a new chat can call `POST /api/assistant/conversations/:id/stop`.

**`page` matters more than it looks.** It is what makes *"add a todo for this"* answerable — if you are standing on `/tasks/abc`, the prompt is told that the task on screen is `abc`. The server resolves that exact owned task and includes its original ask, assignment instructions, recorded results and human notes. An inline annotation uses the particular run/workspace result it annotates. Long content is bounded and continues through `hub_read_task_page` with explicit offsets; **IDs are lookup keys, not full-text search phrases.**

### 4.2 The server assembles the turn

`routes/assistant.ts` writes your message to `assistant_messages` **before** calling the model, so a turn that fails halfway still shows what you asked. Then `agent.ts` builds three things.

**One — a snapshot of your Hub** (`state.ts`). Ten parallel queries:

```ts
const [proposed, todo, inProgress, needsMe, dueToday, overdue,
       projects, people, repos, skills, events, identity] = await Promise.all([…]);
```

This becomes an **index, not a corpus** — names and ids, not bodies:

```text
*** Projects (use these ids)
- Hackathon 2026 sub-agent evaluation    project-4pf03-…
- MOSAIC                                 …
```

The model now knows MOSAIC and Shachee exist and how to address them. It does **not** yet know anything *about* them — that costs a tool call, which is the point. Putting the whole board in the prompt would spend tokens on every turn to answer questions that are almost always about one row.

**Two — the rules.** Judgement, not a tool list (the provider enforces the tool list separately). The prompt opens by describing the situation, not by giving the model a role: *"This conversation is inside Ensemble, where Mira keeps their tasks, pages, projects, people and the apps they connected. You can read and change that workspace with the tools that come with this message."* The first name comes from the account (`buildHubState` also reads it and the onboarding role). The full text is `assistantRules()` in `apps/hub-api/src/assistant/state.ts`; `ASSISTANT_INSTRUCTIONS` is the same text with "the person" for the name. The load-bearing rules:

1. **Act in this turn.** If a tool can do what was asked, call it now. Do not write *"I'll read your calendar"*.
2. **Never invent an entity.** Use ids from the snapshot and the open page. Match names with a list tool before writing.
3. **Ask when it is ambiguous.** If more than one item could match, ask which one, list the real titles under `Choices:`, and call no write.
4. **No substitute tools.** If no tool supports the action, say so in one sentence.
5. **Speak as a proposal.** A held write is *"Ready to apply: …"* until the person presses Apply. Never claim it is done.

After the rules come a few sentences about the person from `personaBlock` (`packages/shared-types/src/personas.ts`), for example *"Mira works as a lawyer; they usually want a clause summarised, two drafts compared, …"*. The persona is Settings → Act as; while Act as is General, `personaFor` uses the onboarding role instead (student, teacher, lawyer, engineer, `vibe` → engineer, manager, researcher). It changes tone and emphasis only. Tools and permissions are decided in code, so the text no longer carries a disclaimer about them. The main chat gets it in the system prompt; a caller that passes `actAs` gets the same, and an older caller that still puts `personaBlock` in `preamble` without `actAs` is left as it was. Last, a **Connected apps** paragraph (`appsPrompt` in `apps.ts`) names what is connected and switched on, what is not connected, and the Apply rule for those apps.

**Three — the tool list for this turn**: the Hub catalog filtered by your settings, plus this person's connected-app tools (`toolsForTurn` in `apps.ts`), in the shape the provider wants.

### 4.3 The catalog becomes a contract

Each tool declares itself once. The Zod schema is both the validation and the TypeScript type — keeping them the same object is what stops a tool drifting from the shape the model was told to send:

```ts
export const createTasks = defineTool({
  name: "hub_create_tasks",
  area: "tasks",
  description: "Add one or more todos to the board. Prefer one call with several tasks over several calls. Set status to \"proposed\" for work you inferred.",
  input: z.object({ tasks: z.array(TaskDraft).min(1).max(12) }),
  isWrite: true,
  risk: "low",
  undoable: true,
  preview(_ctx, input) { /* markdown for the Apply card */ },
  async run(ctx, input) { /* the actual prisma writes */ },
});
```

`registry.ts` turns the Zod schema into JSON Schema with `z.toJSONSchema()`. Two details in there are deliberate and easy to get wrong:

- **`io: "input"`.** A field with a default is optional coming in and present going out. Generate from the output view and you tell the model every defaulted field is required — it then invents values for all of them.
- **`reused: "inline"`.** No `$ref` / `$defs`. Providers resolve them unevenly, and a half-resolved schema fails at call time with an error naming a property you have never seen.

### 4.4 The model is asked what to do

hub-api posts to agent-runtime, which owns the Copilot credential:

```http
POST http://127.0.0.1:5000/api/chat/tools
{ "messages": […],
  "responsesMessages": […],
  "model": "gpt-5.4-mini",
  "chatTools": […],
  "responsesTools": […] }
```

It answers with a **decision, not prose**:

```json
{ "toolCalls": [{
    "id": "call_g2dy_…",
    "name": "hub_create_tasks",
    "arguments": { "tasks": [{ "title": "Raise the MOSAIC PR …", "priority": "p1", "projectId": "1dc0bcad-…" }] }
}] }
```

This is **function calling** — a first-class provider feature. The model is not writing code or SQL. It is choosing a name from a list you gave it and filling in a form you defined. Everything it can express is something you already decided was allowed.

### 4.5 The server runs it

`runOne()` in `agent.ts`:

```ts
const tool = offered.get(requested.name);                // 1. lookup in this turn's tools, not eval
if (!tool) { /* "There is no tool called X." */ }

const input = tool.input.parse(JSON.parse(requested.arguments));  // 2. validate

if (tool.isWrite && (tool.area === "apps" || writePolicy !== "immediate")) {
  emit({ type: "pending", call, preview: await tool.preview(…) });
  return;                                               // 3. gate — nothing is written
}

const result = await tool.run(ctx, input);              // 4. execute
```

Four things worth naming:

1. **Dispatch is a map lookup** in the tools this turn offered (`offered` is built from `toolsForTurn`). `offered.get("__proto__")` returns `undefined`. A tool the turn did not offer — a Google tool when Google is not connected, an app write when app writes are off — cannot be called however convincingly the model asks; there is no path from a string to arbitrary behaviour.
2. **Validation is the same schema the model was shown.** A bad argument comes back as a message the model can act on, and the turn continues.
3. **The gate is here, not in the model's head.** Whether a write happens is decided by your setting, on the server, after the model has spoken.
4. **`run` is ordinary application code.** No magic:

```ts
const task = await ctx.prisma.$transaction(async (tx) => {
  const row = await tx.task.create({
    data: {
      userId: ctx.userId,
      title: draft.title,
      sourceKind: "manual",
      sourceRef: `assistant:${ctx.conversationId}`,
      createdBy: "agent",
      complexity: draft.complexity ?? inferComplexity({ title: draft.title, … }),
    },
  });
  if (draft.people.length) await syncTaskNotes(tx, row);
  return row;
});
```

That is the same `prisma.task.create` the "Add task" button runs, with the same complexity inference and the same note syncing. It cannot leave the board in a state the board could not otherwise reach, because it is using the board's own vocabulary.

### 4.6 Three things happen on the way out

```ts
await journalBatch(ctx.prisma, {
  label: `Added todo "${only.title}"`,
  inverse: [{ op: "delete", model: "task", id, /* … */ }],
  forward: [{ op: "create", model: "task", id, data: snapshot }],
});
await invalidate(ctx, { keys: ["tasks", "briefing", …], userId });
await appendLedger(prisma, { actor: "agent", action: "assistant.turn", … });
```

The SSE publish is the bit that answers *"how did it appear on my board without a refresh?"* — it did **not** push a card into the DOM. It told every open tab that `tasks` is stale, and React Query refetched. The board renders the new row the same way it renders every other row.

The audit ledger has the real entry from a turn:

```text
assistant.turn | gpt-5.4-mini-2026-03-17 |
[hub_list_projects, hub_get_project, hub_update_project, hub_create_tasks]
```

### 4.7 The loop closes

The result is fed back to the model as a tool message, and it is asked again — up to `MAX_STEPS = 8`:

```text
build state → ask the model → tool calls? → run them → feed results back
```

It stops on a text-only answer. The cap is a **cost guard**, not a performance one: a model that has decided to call `hub_list_tasks` forever will do so until something stops it, and you pay for every turn.

A real 7-step turn from one afternoon:

```text
TOOL [ok] hub_list_needs_me      → approvals and 4 questions waiting
TOOL [ok] hub_list_tasks         → Read 1 task
TOOL [ok] hub_list_deliverables  → Read 3 deliverables
DONE
```

---

## 5. Why two processes

Hosted credential resolution is per user. Both TypeScript `runtime/credentials.ts` (the in-process path) and Python `ensemble_agent/credentials.py` restrict server env/CLI fallback to verified exact `ENSEMBLE_OPERATOR_EMAILS` accounts. Other hosted users must supply their own credential; no caller/user ID means no fallback. Dev/desktop retain local credentials. Verification is checked before hosted model work, including background enrichment and scheduler work.

Tool parameters in `assistant/registry.ts` use JSON Schema draft 7, not OpenAPI 3 schemas. In particular, exclusive numeric bounds are numbers (`exclusiveMinimum: 0`), not OpenAPI booleans plus a separate minimum. Checked against a bounded live Gemini diagnostic on 6 Oct 2026: plain completion worked, but the old assistant tool catalog was rejected at `config.xTickStep.exclusiveMinimum`. `registry-schema.test.ts` checks the complete chat/Responses catalog and preserves that numeric constraint. The corrected catalog still needs a post-deploy live assistant smoke check; no extra quota is spent by its automated regression.

The model credential lives in **agent-runtime** (Python). The tools live in **hub-api** (TypeScript). That split is not arbitrary — it follows the rule the rest of Ensemble already uses: **divide on credentials, not on convenience**.

| | hub-api | agent-runtime |
|---|---|---|
| **Owns** | Prisma, Graph token, audit ledger, undo journal | the Copilot credential, the approved model set |
| **Answers** | *"what should happen to this row?"* | *"given this history and these tools, what next?"* |

Move the tools into the runtime and you have handed a second process your database. Move the credential into hub-api and you have two resolvers for one secret, which drift. So agent-runtime is asked one narrow question at a time and **re-checks the model name against `APPROVED_CHAT_MODELS` on arrival** — a payload arriving over HTTP is not authorisation to spend money.

### The routing wrinkle worth knowing

Copilot splits its models across two APIs, and for tool calls they route the **opposite** way to plain completions.

`/responses` accepts a `tools` array for `claude-haiku-4.5`, returns 200, and answers in prose having **ignored it**. So the assistant said *"I'll read your calendar"* and called nothing. There is no error to read — only the absence of a tool call, which looks exactly like a broken agent loop.

Tool calls now try `/chat/completions` first, in a routing table of their own. Models that cannot use it refuse loudly with `unsupported api for model`, which is a fact worth routing on. `pnpm probe:tools` bisects the live catalog against a model for the next time this changes.

---

## 6. Undo, and why it needed a journal

The assistant can rewrite six rows while the transcript is still streaming. So every reversible mutation — whoever made it — appends to a per-user journal:

```ts
model UndoEntry {
  seq:      BigInt;   // monotonic; createdAt ties inside a transaction
  label:    String;   // 'Added todo "Raise the MOSAIC PR"'
  actor:    Actor;    // me | agent  → the tooltip says which
  inverse:  Json;     // UndoOp — run this to walk it back
  forward:  Json;     // UndoOp — run this to put it back
  undoneAt: DateTime?; // null = on the undo stack; set = on the redo stack
}

type UndoOp =
  | { op: "create"; model: UndoModel; id: string; data: Record<string, unknown> }
  | { op: "update"; model: UndoModel; id: string; data: Record<string, unknown> }
  | { op: "delete"; model: UndoModel; id: string }
  | { op: "batch";  ops: UndoOp[] };
```

An op is **self-contained** — model, id, and a full scalar snapshot. Snapshots rather than handlers, because a journal that can only be replayed by the code that wrote it stops being replayable the moment that code is refactored — and the old entries are exactly the ones you reach for.

Four decisions that carry weight:

- **One entry per intent.** Applying a meeting is one action to you and seven rows to the database. `batch` makes one press undo the whole thing, with the inverse ops reversed so a row nothing depends on comes off first.
- **Updates store only what moved.** Restoring the whole row would silently revert a field something else changed in between — worse than an undo that leaves one field alone, and invisible.
- **Dates are tagged.** An ISO string handed back to Prisma for a DateTime column is rejected in some paths and coerced in others, so snapshots encode `{ "$date": "…" }` and revive it.
- **The journal never fails a write.** `recordUndo` swallows its own errors. Losing an undo entry is an annoyance; losing the task you just created because its bookkeeping row would not insert is not a trade worth making.

Verified round trip:

```text
undo → "Undone — added todo ENSEMBLE VERIFY"   task: gone
redo → "Redone — added todo ENSEMBLE VERIFY"   task: back, project link, priority and rationale intact
redo → 409 "Nothing to redo."
```

**What is deliberately absent:** anything that left the building. A sent mail, an opened PR, a calendar invite, a Google Doc. Those are gated by approval precisely because they cannot be taken back, and a button that appears to undo them but does not would be worse than no button. A connected-app write applied from the chat has no undo entry; it is recorded in the audit ledger as `apps.<tool>` with its link ([§8.2](#82-connected-apps)).

---

## 7. The safety layers, in order

A write passes through **five gates** before it lands:

| Gate | Where | What it stops |
|---|---|---|
| The catalog | `registry.ts` | Anything not on the list. Dispatch is a map lookup. |
| Area filter | `toolsFor(allowedWriteAreas)` | Writes to areas you switched off — the tool is never even shown, so the model does not waste turns trying. `apps` is not one of these areas. |
| Connected-app gate | `apps.ts`, `agent.ts`, `apply.ts` | App tools for suites or products that are not connected or switched on; app writes while `assistant.connectedAppWrites` is off (not offered, refused on Apply); any app write running before Apply. |
| Zod parse | `tool.input.parse` | Malformed arguments, bad enums, missing fields. |
| Write policy | `agent.ts` | `preview` and `needs-me` hold the call; nothing is written until you press Apply. Writes to connected apps are held under every policy. |
| Referential checks | each tool's `run` | Ids that do not exist. A foreign-key error naming `tasks_deliverable_id_fkey` tells the model nothing it can act on and tells you less. |

And the ones that are **not negotiable:** tools that reach *outside* the Hub — starting an agent run that could send mail or open a PR — keep their existing risk-based gates from `ensemble_agent/tools/catalog.py` **whatever the write policy says**. A setting that could be turned up until the agent mails your manager unattended is not a setting, it is a trap.

### Two registries, on purpose

| | `assistant/registry.ts` | `ensemble_agent/tools/catalog.py` |
|---|---|---|
| **Covers** | your own Hub | the outside world (mail, GitHub, Teams, …) |
| **A write is** | a row — restorable | an email in someone's inbox — not |
| **Gate** | your write-policy setting | risk × autonomy matrix, always |

Merging them would force the safer half to carry the stricter half's ceremony.

Connected-app tools (area `apps`) are the outside-world tools that do live in `assistant/registry.ts`, because each one is a single typed call the person can read in full before it happens. They carry the stricter rule themselves: every write is held for Apply whatever the write policy says, and is ledgered when applied.

---

## 8. Meeting notes are ordinary context

Floating and inline turns use the engineer's configured model profile (Copilot, Cursor, OpenAI, Claude, Gemini, …). They do **not** call `m365_copilot_ask`. Meeting recaps arrive from connectors ([03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context--from-connectors-not-a-copilot-paste)). Creating tasks/deliverables still goes through the typed tools and approval policy.

### 8.1 Page answers and private reminders

The final allowed model request is reserved for **synthesis with tools disabled**. A turn that cannot produce a final answer fails explicitly; a list of tool receipts is never substituted for the requested summary. Saved answers are historical results: improving the implementation does not silently rewrite one.

Reminder tools can create, edit, snooze, dismiss or delete the same private rows shown in Today. Their write area remains configurable, with the same preview/Needs me gates as other Hub changes. They are deliberately **absent from shared retrieval, graph construction, fetch extraction and the Context Bridge**. Notification timing, quiet hours and Windows opt-in are in [02 §14](02_MODULE_INTERACTION_HUB_UI.md#14-private-reminders).

### 8.2 Connected apps

Read from the code and checked with mocked Google and Graph responses on 7 Oct 2026 (`src/assistant/tools/google-workspace.test.ts`, `microsoft-365.test.ts`, `apps.test.ts`, and `apply.integration.test.ts` against a local Postgres). Not run against a live Google or Microsoft account.

**Who gets which tools.** `toolsForTurn` (`apps/hub-api/src/assistant/apps.ts`) adds a person's app tools to the Hub catalog for each turn. A tool is offered when its suite is connected (an `oauth_tokens` row for `google` or `microsoft`) and one of its products is switched on in `settings.connectorProducts` (defaults from `connectors/products.ts`). Zoom, Docusign and Jira (`zoom`, `docusign`, `atlassian` rows) have no products: their read tools are offered whenever the account is connected. Reads are always offered then. Writes are offered only while **`assistant.connectedAppWrites`** is on; `apps` is not one of `allowedWriteAreas`. At most `MAX_APP_TOOLS` (64) app tools are offered per turn, built-in suites first, so the Hub and app tools together stay under the 128 functions OpenAI accepts. A product that is on but whose permission was never granted is still offered; the call then says what to do (below).

| Tool | Reads or writes | Product | Scope it needs |
|---|---|---|---|
| `gmail_search`, `gmail_read` | read | Gmail | `gmail.readonly` |
| `calendar_list_events` | read | Calendar | `calendar.events` (or `calendar.readonly`) |
| `calendar_create_event`, `calendar_update_event` | write | Calendar | `calendar.events` |
| `drive_list_files`, `drive_read_file` | read | Docs, Sheets & Slides or Search all of Drive | `drive.file` or `drive.readonly` |
| `docs_create`, `docs_append`, `docs_replace_text` | write | Docs, Sheets & Slides | `drive.file` |
| `sheets_create`, `sheets_update_range`, `sheets_append_rows` | write | Docs, Sheets & Slides | `drive.file` |
| `sheets_read`, `slides_read` | read | Docs, Sheets & Slides or Search all of Drive | `drive.file` or `drive.readonly` |
| `slides_create` | write | Docs, Sheets & Slides | `drive.file` |
| `outlook_search_mail`, `outlook_read_message` | read | Outlook mail | `Mail.Read` |
| `outlook_calendar_list_events` | read | Outlook calendar | `Calendars.Read` or `Calendars.ReadWrite` |
| `outlook_calendar_create_event` | write | Outlook calendar | `Calendars.ReadWrite` |
| `teams_list_chats`, `teams_read_chat` | read | Teams | `Chat.Read` |
| `onedrive_search`, `onedrive_read_file`, `excel_read_range` | read | OneDrive or Office files | `Files.Read` |
| `word_create`, `word_update`, `excel_create`, `excel_update_range`, `powerpoint_create` | write | Office files | `Files.ReadWrite` |
| `zoom_list_meetings` | read | Zoom | `meeting:read:list_meetings` (or classic `meeting:read`) |
| `zoom_get_meeting_summary` | read | Zoom | `meeting:read:summary` (or classic `meeting_summary:read`) |
| `zoom_list_recordings` | read | Zoom | `cloud_recording:read:list_user_recordings` (or classic `recording:read`) |
| `zoom_get_transcript` | read | Zoom | `cloud_recording:read:meeting_transcript` (or classic `recording:read`) |
| `docusign_list_envelopes`, `docusign_get_envelope` | read | Docusign | `signature` |
| `jira_search`, `jira_get_issue` | read | Jira | `read:jira-work` with OAuth; none with a pasted API token |

**Zoom, Docusign and Jira** (`tools/zoom.ts`, `docusign.ts`, `jira.ts`; read only). Zoom calls `https://api.zoom.us/v2` as the person (`users/me`): upcoming or previous meetings, cloud recordings for up to a month at a time (Zoom's limit; a longer range is shortened and says so), the AI Companion summary (`/meetings/{id}/meeting_summary`, Markdown from `summary_content`), and the transcript (`/meetings/{id}/transcript`, then its `download_url`, which must be on `zoom.us` because the token is sent with it; the VTT becomes `[mm:ss] Speaker: words` lines). Recordings, transcripts and summaries need a paid Zoom plan on the host's account; Zoom's code 200 refusal is shown as that. Docusign uses the account's own `baseUri` and `accountId` from connect (only `*.docusign.net` / `*.docusign.com` hosts) with `/restapi/v2.1/accounts/{accountId}/envelopes`, and works out who an envelope is waiting on from recipients that are sent or opened but not done. Jira uses `https://api.atlassian.com/ex/jira/{cloudId}` with the OAuth token, or `https://{site}` with Basic `email:token` for a pasted token (only `*.atlassian.net` / `*.jira.com` sites); search posts JQL to `/rest/api/3/search/jql` with `nextPageToken`, and an issue's description and last five comments come back as Markdown through `adfToMarkdown` (`src/imports/markdown.ts`).

**Tokens.** Every call gets its token from `requireProviderToken` in `connectors/tokens.ts` (through `appToken` in `tools/apps-common.ts`), which refreshes it and throws `ConnectorNotConnectedError` (409) when the suite is not connected. A missing scope throws the same error: *"Google Calendar is connected without the access this needs. Turn it on in Settings → Connections and approve the new permission."* Graph scopes match with or without the `https://graph.microsoft.com/` prefix and in any case. A pasted Jira API token has no OAuth scopes and is not checked for them. A vendor 401 asks the person to reconnect; a 403 for scopes is the same 409; other vendor errors are `AppRequestError` (424, message shown; not 502, which the Hub client reads as "server unreachable") with the vendor's own sentence, never a token.

**The Apply rule.** Every `apps` write is held as `awaiting_approval`, even when `writePolicy` is `immediate` (`holdsAssistantWrite` in `agent.ts`). Before the card is shown, `ensureAppAccess` checks the connection, the product and the scope, so a missing permission is reported now rather than after Apply. The preview says exactly what will happen, for example *"Create event “Design review” Wed 14 Oct 15:00–15:30 IST in Mira's calendar (mira@fieldnote.example) and email invites to sam@fieldnote.example."* Previews make no vendor writes; a few read the target first (an event's title, a document's title, a workbook's first sheet).

On Apply, `applyHeldCalls` (`apps/hub-api/src/assistant/apply.ts`) runs the Hub writes of the batch in one transaction and undo entry as before, then each app write after that transaction commits, outside any database transaction, so a slow vendor never holds row locks. Each applied app write is recorded with `appendLedger` as `apps.<tool>` (payload: tool, provider, summary, link, ids; never the document body or a token), and its result carries the link (`href`). A product switched off after the proposal is refused at Apply before anything is sent.

**A batch that partly lands.** App writes run in order and stop at the first failure. If nothing has landed, Apply fails as a whole, its locks are released and it can be pressed again. Once something has landed, `applyHeldCalls` returns one outcome per call instead of throwing, and `POST /api/assistant/apply` answers 200 with `partial: true` and `failed: [{ callId, name, error, attempted }]` (`attempted: false` for calls never sent). The route records landed calls as `ok` (with `undoEntryId` only on Hub writes) and the rest as `failed` with the error, adds a *Not applied: …* line to the saved reply, writes the `assistant.apply` ledger row with `partial` and `failed`, and releases only the failed calls' locks. A call already saved as `ok` on the conversation is never run again, by any later Apply, even after its 120-second lock expires. The dock's *Apply all* toast says what landed and what did not (`applyNotice` in `apps/hub-web/lib/assistant-apply.ts`); the rows show each call's state. Checked 7 Oct 2026 with `src/assistant/apply.integration.test.ts` (local Postgres, mocked Google) and `components/assistant/assistant-message.test.tsx`.

`resolveTool` in `apps.ts` finds a held tool by name for Apply: the Hub catalog, then the built-in app tools, then any resolver registered with `registerToolResolver`. Per-person sources such as remote MCP servers plug in with `registerAppToolSource`; a tool with its own `jsonSchema` is sent to the model with that schema instead of a Zod conversion.

**Documents.** `docs_create` uploads HTML made from the model's Markdown to Drive with the target type `application/vnd.google-apps.document`, so headings, nested lists, bold, links and tables become real Doc formatting. `docs_append` inserts at the end with Docs `batchUpdate` (headings, bullets, bold, italic, links and code font; a table becomes rows of text). `sheets_create` writes the rows with `USER_ENTERED`, so a string starting with `=` is a formula, then bolds and freezes the header. `slides_create` fills the cover slide, adds one `TITLE_AND_BODY` slide per item with bullets, then the speaker notes. On Microsoft, `word_create`, `excel_create` and `powerpoint_create` build the file on the server (`lib/office/`: `docx`, `exceljs`, `pptxgenjs`, all MIT) and upload it to **OneDrive/Ensemble/** (renamed on a clash). `word_update` replaces the whole document and says so; `excel_update_range` uses the Graph workbook API on an existing workbook. Reading uses Drive exports (Docs as Markdown, Sheets as CSV, Slides as text), and `.docx`, `.xlsx` and `.pptx` are unzipped with `fflate` and read as text on the server. PDFs return their details and link only.

Mail, chat and file text comes back marked as information, not instructions, and long bodies are read in 5,000-character windows (`offset`, `nextOffset`).

---

## 9. Failure modes, and what catches them

| What happens | What catches it |
|---|---|
| Model invents a person/project id | The tool checks it and refuses with *"call `hub_list_people` and match by name — never invent a person."* The turn continues. |
| Model sends `"tomorrow"` as a date | `parseDate` refuses rather than guessing. A due date silently resolved to the wrong day is indistinguishable from one you set. |
| Model sends `""` for an optional id | `OptionalId` normalises it to absent. Empty string is not "no value" to Postgres — it is a key matching nothing. |
| Model loops on the same tool | `MAX_STEPS = 8`. |
| Result too large for the window | Degrades to a truncated string preview. The earlier version cut the JSON and patched `…`, which cannot close arbitrary nesting. |
| Model narrates instead of acting | Prompt rule 1 (act in this turn), plus one bounded nudge if the first turn reads like a promise and no tool ran. Once only. |
| agent-runtime is down | `ToolBlockedError` with the remedy: *"Start it with `pnpm dev:agent`."* |
| The model's daily quota is used up | HTTP 429 or `RESOURCE_EXHAUSTED` becomes `model_quota_exceeded` with the model and `resetsAt` (the provider's retry delay, otherwise the next midnight in America/Los_Angeles). It is not retried and never switches to another model. The dock and the model picker mark that model out of quota until then. Not saved as the reply. |
| The model host cannot be reached | Connection refused, an unknown host or a stopped Ollama is `model_unreachable` (503) with a plain sentence, for example *"Couldn't reach Ollama at http://localhost:11434. Is it running?"*, in both runtimes (`apps/agent-runtime/ensemble_agent/reach.py`, `apps/hub-api/src/lib/model-reach.ts`). Not saved, not sent back in history. A connection that opened and then died is still *"dropped before it replied"*. |
| A cut lands inside an emoji | `truncateText` / `chunkText` (`apps/hub-api/src/lib/text.ts`, Python `textutil.py`) cut on grapheme boundaries and strip lone surrogates, which Postgres rejects. A save that still fails stores *"The reply could not be saved."*; the database error stays in the server log. |
| The reply claims work that did not happen | `reflectProposals` (`assistant/reply.ts`) replaces a reply that says something was added when the tool rows say it was only proposed or failed. After Apply, `replyAfterApply` rewrites the saved reply to say what landed and what still waits. |
| "This week" on a weekend | `workWeekLine` (`lib/clock.ts`) gives Monday–Sunday of the week that contains today. |
| A tool throws after announcing Success | The result is built **before** the `ok` frame is emitted. A tool log must never show the same call as both succeeded and failed. |

A model that already has the answer in its prompt and doesn't call a tool is **correct, not broken** — that was the confusing one. Asking *"list my projects"* returns straight from the snapshot, because the tool would add nothing.

---

## 10. Adding a tool

The practical part. To let the assistant do something new:

```ts
// apps/hub-api/src/assistant/tools/tasks.ts
export const archiveTask = defineTool({
  name: "hub_archive_task",
  area: "tasks",                          // gated by your per-area setting
  description:
    "Archive a task so it leaves the board without being marked done. Use it when the engineer says a task is no longer relevant.",
  input: z.object({ taskId: z.string() }),
  isWrite: true,
  risk: "low",
  undoable: true,
  preview: (_ctx, input) => `Archive **${input.taskId}**`,
  async run(ctx, input) {
    const before = await ctx.prisma.task.findFirst({ … });
    const after  = await ctx.prisma.task.update({ … });
    const undoEntryId = await journalUpdate(ctx.prisma, { before, after, … });
    return {
      summary: `Archived "${after.title}"`,
      invalidate: ["tasks", "board"],
      undoEntryId,
    };
  },
});

export const taskTools = [ /* … */, archiveTask ];
// that is the whole wiring
```

A tool that acts in a connected app is written the same way, with `area: "apps"` and `app: { provider, suite, products, scopes, label }` (see `tools/google/meta.ts`). It gets its token from `appToken(ctx, meta)` and calls the vendor through `appFetch` in `tools/apps-common.ts`. Add it to the suite's list (`googleWorkspaceTools`, `microsoft365Tools`): `apps.ts` offers it per person, `toolsFor()` never does, and if it writes it waits for Apply.

Three rules learned the hard way:

1. **Write the description for the model, not a docs page.** It is the only instruction it gets about when to reach for this. The test suite enforces a **40 character floor** because a one-word description is how a model calls the wrong tool confidently.
2. **Return a summary a human can read.** It is what appears in the transcript and in the undo tooltip.
3. **Journal it if it can be journalled.** Otherwise your undo button quietly skips the thing the user most wants back.

`pnpm --filter @ensemble/hub-api exec vitest run src/assistant` asserts the catalog has no duplicates, that nothing named `hub_list_*` writes, that every schema serialises, and that area filtering actually withholds.

---

## 11. Honest limits

- **Retrieval is keyword-based** until an embedding provider is configured. `hub_search_context` uses the same context-pack builder as everything else. The assistant is only as good as what that returns.
- **Conversation history is flattened.** Prior tool calls are replayed as a short note — *"You did: …"* — not as real tool messages, because a tool result with no matching request in the window is rejected by both APIs. Detail from three turns ago is summarised, not exact.
- **Plans vary between runs.** The orchestrator is a model. The same request can take 3 tools or 7.
- **Credits are an estimate.** The Copilot API reports tokens and never credits; every figure comes from the multiplier table in `models.ts` / `models.py`.
- **Connected-app tools are tested against mocked vendors only.** With the default `drive.file` access, Drive tools see only files Ensemble created or the person picked; Search all of Drive (`drive.readonly`) is a restricted scope a public server must have verified by Google. The Graph workbook API (`excel_read_range`, `excel_update_range`) is documented for OneDrive for work or school; personal OneDrive may refuse it. `word_update` rewrites the whole document from Markdown, so formatting Markdown cannot express is lost. Teams meetings need a work or school account. Sending mail is not a tool. Zoom summaries need the `meeting:read:summary` scope on the host's Zoom app, which Connect does not list yet (`ZOOM_SCOPES` in `connectors/oauth.ts`); Zoom takes scopes from the app's own configuration.
- **`needs-me` surfaces the same record as `preview`.** Held writes live on the assistant message, not as `Approval` rows — those require a `Run`, which requires a `Task`, and creating a synthetic task to hold a pending change would pollute the board it is trying to change.

---

## 12. The shape of the idea

If you take one thing from this: **the agent's power came from constraining it, not from freeing it.**

It cannot write SQL. It cannot click. It cannot name a function you did not write. It can only choose from a list you defined, with arguments you validated, behind a gate you configured, recorded in a ledger and a journal you can walk back.

And that constraint is precisely what let it be given real authority over real data — because every question you would want to ask of it (*"what did it do?"*, *"why?"*, *"can I take it back?"*) has an answer that does not depend on trusting the model.
