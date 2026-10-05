# Assistant, trash, comments, and @ensemble

System design for the LLM stack, retention, text comments, and inline Ensemble replies. This document is the contract for the implementation that follows it. It is written against `main` at `8e8a89c` and the audit in the companion report (bugs B-1..B-23, N-1..N-16).

B-3 (Gemini rejecting OpenAPI tool schemas) was **refuted live** and is not implemented. B-23 (unused embeddings, planner, skill-forge) stays deferred: the embedding column and the planner tests remain, and this design does not delete them. B-2's client already prefers a JSON `error` string; the remaining hole is nested provider JSON and a 500 from the Next proxy while the API is still working (N-8, N-12).

## 1. Goals

1. A user-supplied model key actually works. Keys stay encrypted on the server. The browser and logs see a hint, never the secret.
2. The assistant tells the truth: proposed writes stay proposed until Apply, ambiguity asks a question, and a missing tool is named instead of misused.
3. Tool writes go through the same service layer as REST, including undo, status history, and every field.
4. Reminders fire on the server, in the user's timezone, even when no tab is open, and catch up after downtime.
5. Long turns stream. Stop cancels the real turn. Errors name the quota, the retry, or the missing key.
6. Every entity can be created, edited, and soft-deleted, then restored from Trash. Completed work is bounded on boards and purged on a schedule, after a completion record is written for a future skill miner.
7. Text comments and `@ensemble` sit inside the page, not in a chat app bolted on the side.

## 2. Complexity tiers

Settings owns the mapping. A request does not pick a model id of its own.

| Tier (API) | Label | Default provider / model | Default effort |
|---|---|---|---|
| `easy` | Low | google / `gemini-3.5-flash-lite` | `minimal` |
| `medium` | Medium | google / `gemini-3.5-flash-lite` | `low` |
| `high` | High | google / `gemini-3.5-flash` | `medium` |
| `max` | Max | google / `gemini-3.5-flash` | `high` |

`settings.assistant.defaultTier` defaults to **`medium`**. The dock, triage-adjacent paths, model test, workspace jobs, and `@ensemble` all resolve through `settings.models[tier]` unless the person overrides the tier for that one request. The dock does not keep a second default in `localStorage`. A per-request choice is sent as `tier`; omitting `tier` means the saved default.

Thinking effort is the tier's `effort` field, mapped per provider:

| Stored effort | Gemini (`gemini-3*`) | Gemini (older) | OpenAI-compatible | Anthropic |
|---|---|---|---|---|
| `default` | omit | omit | omit | omit |
| `minimal` | `minimal` | `low` | `minimal` | omit (use default max tokens) |
| `low` / `medium` / `high` | pass through | pass through | pass through | `output_config.effort` when the model accepts it, otherwise omit |

A blind retry that drops `reasoning_effort` happens only when the error text mentions `reasoning_effort` (B-13). Gemini 3 completions omit `temperature` (B-14). `complete()` passes the tier's effort (B-16).

On a 503 "high demand", the runtime may retry the same model, then optionally try one other model the same tier is allowed to fall back to: the other Flash model configured on a sibling tier that shares the provider, never a jump to Pro. The response records `fallbackFrom` when that happens.

## 3. LLM orchestration

### 3.1 Credential path

Unchanged in shape, tightened in failure modes.

1. Settings → Models → Add key → `PUT /api/model-keys/:provider` (hub-api).
2. hub-api forwards to agent-runtime `PUT /api/credentials`.
3. The runtime lists models to validate, then AES-256-GCM encrypts (`v1:` vault). Ciphertext lives in `model_credentials`. The UI receives `hint` (last 4) only.
4. Resolution order: stored key, then env (`GOOGLE_API_KEY`, `GEMINI_API_KEY`, …).
5. Decrypt failures (`InvalidTag`) return "This stored key can't be decrypted — re-enter it in Settings → Models." (B-21). They are not a 502 stack trace.
6. Invalid keys map 400/401/403 to "Google rejected this key (check it was copied fully and the Generative Language API is enabled)." (B-17). The raw httpx URL is not shown.
7. A GitHub token for private clones is a separate secret, provider id `github_git`, same vault and table. It is never a model key and never returned to the browser.

Logs: Fastify does not log bodies. The ledger records `model.key.save` with provider and hint, not the secret. Google calls send the key in `Authorization`, not the URL.

### 3.2 Errors

Provider failures become a structured error before they cross the process boundary:

```ts
{
  status: number;
  kind: "rate_limit" | "quota" | "unavailable" | "auth" | "not_found" | "invalid" | "other";
  message: string;       // error.message extracted from nested Google JSON
  quotaId?: string;
  retryAfterSeconds?: number;
}
```

Parsing order for a Google body: `error.message`, then `error.status`, then the first `error.details[]` entry that carries `retryDelay` or `quotaId` (`google.rpc.RetryInfo`, `google.rpc.QuotaFailure`). The user-facing sentence includes the quota id and the wait when present (N-12).

| Kind | User text |
|---|---|
| `rate_limit` (429, per-minute) | "Rate-limited, retrying in N s." After retries: "Gemini is rate-limiting this key (15 requests/minute on the free tier). Wait a moment and try again." |
| `quota` (429, per-day or `limit: 0`) | "This key is out of quota for that model." |
| `unavailable` (503) | "Gemini is under high demand for this model. Try again, or switch the tier to a model this key can use." |
| `not_found` (404) | "That model is not available to this key." |
| `auth` | The key message above. |
| no key | "No key for google. Paste one in Settings → Models." |

The web client shows `error` / `message` / `detail` when the body is JSON, including when `error` is an object with `message`. `Ensemble can't reach its server right now.` is reserved for a thrown fetch, a non-JSON 502/503/504, or the proxy's bare `Internal Server Error` (B-2).

### 3.3 Retries

`_openai_chat` and `_anthropic_chat` retry 429, 500, 502, 503, and 504.

- Honour `Retry-After` (header or Google `retryDelay`), capped at 60s.
- Otherwise exponential backoff with full jitter: 400ms, 1200ms, 3000ms, plus 0–250ms.
- Up to 3 attempts after the first failure for 429/503; 2 for other 5xx.
- 429 with a per-day quota or a zero limit is **not** retried.
- Workspace agent turns use the same helper. A 429 is not reported as "out of quota" unless `kind === "quota"` (N-10, B-7). The status-code match is `\b(429|5\d\d)\b`, not `/\(5\d\d\)/`.

### 3.4 Streaming and Stop

`POST /api/assistant/turn` responds `text/event-stream` and never buffers the whole turn behind one JSON body. Frames:

| type | When |
|---|---|
| `status` | "Looking through your context…", tool status |
| `delta` | Model text as it arrives. First token is forwarded as soon as the runtime yields it. |
| `tool` | A read finished, or an immediate write finished |
| `pending` | A write is held. `preview` is human-readable |
| `error` | Turn failed. `message` is the user sentence |
| `done` | `{ conversationId, messageId, content, toolCalls, model, tier, interrupted }` |

The Next rewrite sets `experimental.proxyTimeout` to 310s so a non-streaming route (model test) is not cut at 30s. The assistant path does not depend on that: the client reads the POST body as SSE, so a long turn cannot be reported as a failure while the server is still writing (N-8). Heartbeat comment frames (`: ping`) every 15s keep proxies from idling out.

Stop (B-9):

- The turn's activity id is stable: `assistant:<conversationId>`.
- `POST /api/assistant/conversations/:id/stop` sets the Redis cancel key for that id and aborts the in-process `AbortController`.
- The dock's Stop aborts the fetch **and** calls the route. Aborting the fetch alone is not enough, because the server must stop spending tokens.
- The runtime request uses the same signal.

Failed turns (B-18): if the model errors before any assistant text, the user message stays and an assistant row is written with the error, so the conversation is not an orphan user bubble. Apply is compare-and-swap: `awaiting_approval` → `applying` → `ok`. A second click sees `ok` or `applying` and does not write again.

### 3.5 Model catalog (N-11)

`GET /api/models?provider=` returns `{ id, available, reason }[]`.

- Generation-capable models stay listed.
- A probe cache (`model_probes`: user, provider, model, kind, detail, checkedAt, 6h TTL) records 404 ("not available to new users"), 429 with zero Pro quota ("no quota on this key"), and repeated 503 ("high demand").
- The Settings picker shows those rows disabled, with the reason. They are not offered as the silent default.
- Tier model fields draft locally and PATCH on blur or Enter, and only if the id is in the catalog or a deliberate custom override the person confirms (N-13).

### 3.6 Pricing (B-15)

`estimateUsd` knows current public list prices, USD per 1M tokens `[input, output]`:

| Model | Input | Output |
|---|---|---|
| `gemini-3.5-flash-lite` | 0.30 | 2.50 |
| `gemini-3.5-flash` | 1.50 | 9.00 |
| `gemini-3-flash-preview` | 0.50 | 3.00 |
| `gemini-3.1-flash-lite` | 0.25 | 1.50 |
| `gemini-3.1-pro-preview` | 2.00 | 12.00 |

Retired `gemini-2.0-flash` and `gemini-2.0-flash-lite` are removed. Unknown models still show tokens and a blank cost.

### 3.7 Mock provider

`provider: "mock"` never calls the network. It is for tests and the Playwright suite.

- Request body may include `mockFixture`: a name in `apps/agent-runtime/tests/fixtures/`.
- Otherwise the last user message is matched against fixture triggers.
- The provider speaks the same `complete_with_tools` / `complete_text` result shape, including `raw.choices[0].message` so thought-signature echo stays honest.
- Streaming tests use `POST /api/chat/tools/stream`, which yields `delta` frames then a final turn.

Recorded fixtures (no network) cover:

- OpenAI-compatible tool call (`tool_calls[].function.arguments` string).
- Gemini-shaped error JSON (`error.message`, `RetryInfo.retryDelay`, `QuotaFailure`).
- HTTP 429 with `Retry-After: 2`.
- HTTP 503 high demand.
- A text completion with usage.

The mock is deterministic: same fixture, same output, no clock in the response except where a fixture embeds one.

### 3.8 Web search

Tool `hub_web_search({ query })` is a read.

1. Prefer provider-native grounding for the tier's provider:
   - Gemini: native `generateContent` with `tools: [{ google_search: {} }]`, citations from `groundingMetadata.groundingChunks`.
   - OpenAI: Responses API `web_search` tool.
   - Anthropic: `web_search` tool (`web_search_20250305`).
2. If the provider has no grounding, or the call fails, fall back to the existing public-web search used by the workspace agent (DuckDuckGo HTML, SSRF-guarded fetches). Captcha or empty results return a short failure, not invented facts.
3. The tool result is `{ results: [{ title, url, snippet }] }`. The prompt requires the model to cite with those links. The UI renders citations as links. A lawyer-style answer that lacks a citation for a factual claim must say it could not verify it.

`hub_fetch_now` is a write (`isWrite: true`, `risk: "low"`) because it proposes tasks (B-11).

## 4. Context the model receives (B-5, B-6)

Every turn's system prompt starts with:

```text
Today is 2026-09-29 (Tuesday). The user's timezone is Europe/London.
The open page is /tasks/<id> "Write the ranker ADR" (status in_progress, due 2026-10-02, priority p0 High).
Page excerpt:
…
Linked project, people, repo, deliverables, skills: …
```

`AssistantPageContext` gains `documentId` and `projectId` (already present). The server loads the owned task (or project page / document) and includes title, status, due, priority, description, and a bounded page excerpt (4k characters). Peek sends `taskId` even when the path is `/board`. The model is told to use that id and not a similarly named task.

Relative dates ("tomorrow", "Friday", "5pm") are resolved by the model using that date line, then sent as `YYYY-MM-DD` and `HH:MM`. The tool rejects anything else.

### 4.1 Rules added to the prompt (N-1, N-2, N-3)

- If more than one item could match, or the request names none clearly, ask which one. Offer the real choices (title + id). Call no write.
- If no tool can do the job, say so in one sentence. Never use another tool as a substitute.
- A held write is **not done**. Speak in the future or the conditional: "Ready to apply: …". Never "I created", "I set", "Marked as done".
- When any call is `awaiting_approval`, the server appends a fixed line the model cannot remove: `Nothing has changed yet — press Apply.`
- Priority vocabulary: `p0` High, `p1` Normal, `p2` Low.
- Do not invent citations. If web search returned nothing, say so.
- Enabled skills are standing instructions.

Personas are a short addendum, selected from the page and the request, not a mode switch:

| Reader | What "good" looks like |
|---|---|
| Developer | Summarise the open page and the linked repo. Point at related skills. Draft subtasks as proposed todos. |
| Student | Split an assignment into tasks with owners and deadlines. Ask who the teammates are if they are not in People. |
| Teacher | Turn notes into a lesson plan or rubric. Offer reminders for due dates. |
| Lawyer | Summarise the document. List obligations and deadlines as deliverables. Cite sources. Flag uncertainty. Never invent a citation. |

The addendum is always included, condensed, so one account can hold mixed work. The model does not announce the persona.

## 5. Service layer and tools

REST handlers and assistant tools both call `apps/hub-api/src/services/*`. A tool must not write Prisma rows that the route would not write.

### 5.1 Task service (B-4, N-5, N-6)

`createTask(tx, userId, draft, actor)` writes every field the route writes: `due`, `todayFocus`, `boardOrder` (next), `people`, `projectId`, `skillIds`, a `task_transitions` row, `completedAt` when status is `done`, and an undo entry.

`updateTask(tx, userId, id, patch, actor)` copies title, description, notes, owner, status, priority, complexity, due, people, projectId, repoId, deliverableId, skillIds, snoozedUntil, todayFocus, boardOrder. It calls `assertTransition`, sets `completedAt` on the way into or out of `done`, writes a transition when status or owner changes, and records undo. Unknown fields are a tool error, not a silent drop. The tool schema is `.strict()` on the patch.

`priority` is described to the model as `p0 = High, p1 = Normal, p2 = Low`.

`hub_create_tasks` accepts `projectId` or `projectName`. `projectName` is resolved **at apply time** inside the transaction (`findFirst` by name for this user). A project created earlier in the same turn, already applied or applied in order before the tasks, is found. Held previews say "in project &lt;name&gt;" even when the id does not exist yet. If the name is still missing at apply, the call fails and nothing is half-linked.

`hub_list_tasks` status is the `TaskStatus` enum (B-10). `describe()` maps Prisma known-request and validation errors to one sentence with no file path.

### 5.2 Tool catalog

Reads stay. New and repaired writes:

| Tool | Effect |
|---|---|
| `hub_create_person` / `hub_update_person` / `hub_delete_person` | People service. Delete is soft. |
| `hub_link_repo` / `hub_unlink_repo` | `project_repos`. Creates the repo row if `fullName` is new and the user asked to link it. |
| `hub_create_deliverable` / `hub_update_deliverable` / `hub_complete_deliverable` / `hub_delete_deliverable` | Deliverable service. Complete sets status and `completedAt`. |
| `hub_create_reminder` / `hub_update_reminder` / `hub_delete_reminder` | Validated dates. Undo on create and delete (N-16). |
| `hub_delete_task` / `hub_restore` | Soft delete and restore for task, project, person, skill, document, repo, deliverable, reminder, comment. |
| `hub_list_due` | `{ from, to }` over open tasks, upcoming deliverables, and active reminders (N-15). |
| `hub_web_search` | §3.8. |

`hub_create_project` records undo (N-16).

Previews (N-4) are sentences, not JSON and not bare ids:

```text
Update “Reply to Priya”: status To do → Done, priority Normal → High
Add “Q4 roadmap” due 2 Oct, priority High, assigned to you, in Growth Experiments
```

Before/after labels use the same words as the UI.

### 5.3 Reminders (B-5)

`dueDate` matches `^\d{4}-\d{2}-\d{2}$`. `dueTime` matches `^([01]\d|2[0-3]):[0-5]\d$` or is omitted. Timezone defaults to `settings.timezone`, never a hard-coded `Asia/Kolkata`.

`nextNotificationAt` is the UTC instant of that wall time in the user's zone. The scheduler (below) claims due rows, inserts a `notifications` row (`kind: "reminder"`), sets `lastNotifiedAt`, and publishes SSE `reminder.due`. An open tab shows an in-app toast and, when `desktopReminders` is on and permission is granted, a Notification. Missed rows (`nextNotificationAt <= now`) fire on the next tick and on process start, so downtime does not drop them. A reminder created while desktop notifications are off adds one sentence to the tool result: the person can turn them on in Settings. The in-app notification still exists.

`shortDate` / `dateTime` return the raw string when `Date` is invalid, so one bad historical row cannot throw. A one-shot SQL migration nulls `due_time` that is not `HH:MM` and leaves a non-ISO `due_date` in place but the formatter no longer crashes. New writes cannot insert those values. Today is wrapped in an error boundary that renders the rail's failure as a card, not an application error.

Triage "today" and due parsing use `settings.timezone` (B-22).

### 5.4 Apply copy (B-20)

The dock's ground line follows `settings.assistant.writePolicy`:

- `preview`: "Writes wait until you apply them."
- `immediate`: "Writes apply as soon as the assistant makes them."
- `needs-me`: "Writes land on Needs me for you to decide."

## 6. Delete, trash, completed, retention

### 6.1 Soft delete

Every entity the product lets a person create can be deleted from the UI and the API: tasks, proposals (status `dropped` remains a decision; a proposal can also be trashed), deliverables, projects, repos, people, skills, reminders, documents, comments.

Delete sets `deletedAt`. It does not hard-delete. The undo journal records the inverse. A toast offers Undo for a few seconds; the same row is also in Trash.

Cascades:

- Deleting a project does **not** delete its tasks, deliverables, or repo links. Tasks keep `projectId`. The UI shows the project name as "in Trash" and offers to move tasks or leave them. Restoring the project restores the links because they were never removed.
- Deleting a person removes them from pickers. Tasks keep the id in `people[]`. Restore brings the person back; the ids still match.
- Deleting a repo unlinks it from pickers. `project_repos` rows stay. Restore brings them back.
- Deleting a task soft-deletes its page with it (the page is not its own trash row). Comments on that page hide with the task and return on restore.
- Comments delete on their own (`deletedAt`) without deleting the page. The mark is left; the rail shows "Comment removed" and the highlight drops.

`GET /api/deleted` returns every kind. `POST /api/deleted/restore` and `POST /api/deleted/empty` cover the same set. `POST /api/data/delete` remains the explicit hard delete.

Trash UI:

- Settings → Trash (existing section, now complete).
- A Trash view at `/trash`, linked from the sidebar and the command palette.
- Each row: kind, title, deleted time, Restore. Empty trash asks for confirmation.

### 6.2 Completed

Settings:

- `completedVisible` integer 3–20, default **5**. Board Done and list surfaces show the N most recently completed (`completedAt desc`). The column header links to the rest.
- `completedRetentionDays` integer, presets 30/60/90, default **60**.
- `retentionDays` is **deleted items only**, presets 30/60/90, default 30. The old sentence "Keep completed and deleted items for N days" is replaced so the two clocks are obvious.

Completed view:

- Per board: `/board?completed=1`, and a "Completed" disclosure under a list.
- Global: `/completed`, search plus filters (project, priority, kind task/todo/deliverable).
- Reopen sets status back to `todo` (deliverable `upcoming`), clears `completedAt`, writes a transition and undo.
- `pinned` (boolean, default false) on tasks and deliverables. Pinned rows are excluded from the completed purge.

### 6.3 Completion records (future skill miner)

Before a completed task or deliverable is purged, the retention job inserts one row:

```text
completion_records
  id, userId, entityKind ("task" | "deliverable" | "todo")
  entityId          -- the original id, not a foreign key (the source row is about to disappear)
  title
  summary           -- description truncated to 500 chars, whitespace collapsed
  skillIds text[]
  people text[]
  projectId, projectName
  repoId, repoFullName
  outcome           -- "done" | "completed" | "dropped"
  completedAt, createdAt
  sourceJson        -- compact snapshot: status, priority, complexity, due, notes excerpt
```

The table is append-only. The miner is **not** built. The interface it will read:

```ts
interface CompletionRecord {
  id: string;
  userId: string;
  entityKind: "task" | "deliverable" | "todo";
  entityId: string;
  title: string;
  summary: string;
  skillIds: string[];
  people: string[];
  projectId: string | null;
  projectName: string | null;
  repoId: string | null;
  repoFullName: string | null;
  outcome: string;
  completedAt: string | null;
  createdAt: string;
}
```

A future worker may `SELECT … WHERE created_at > $cursor ORDER BY created_at` and advance a cursor in `sync_state` (`connector = "skill-miner"`). It must not require the source row to still exist. It must tolerate missing skills or people (ids may have been trashed).

The Skills page button "Improve skills from my work" no longer toasts a lie. It shows a quiet "Coming soon" state: skill mining will read completion records once that worker exists. Nothing is queued.

### 6.4 Retention job

`jobs/retention.ts` is the implementation. The scheduler calls `runRetention(app, userId, { reason })`.

Schedule: every local day at 03:30 in `settings.timezone`, once, claimed in `sync_state` (`connector = "schedule:retention"`, cursor `retention@YYYY-MM-DD`).

Catch-up: on process start, and on each tick, if the cursor date is before today in that timezone, run immediately (not only when the clock equals 03:30). A process that was down at 03:30 does not skip the day. A run still claims the slot so a restart in the same minute does not double-purge.

Order inside one transaction per entity batch:

1. Select completed tasks and deliverables with `completedAt < now - completedRetentionDays`, `pinned = false`, `deletedAt is null`.
2. Insert `completion_records`.
3. Soft-delete those rows (`deletedAt = now`) so a mistaken window can still be restored until the trash window passes. The next trash pass, or the same pass if `deletedAt` is already older than `retentionDays`, hard-deletes.
4. Hard-delete rows with `deletedAt < now - retentionDays` for task, project, person, skill, document, artifact, repo, deliverable, reminder, comment.
5. Hard-delete dismissed reminders, decided agent decisions, and old notifications on the same window as today.
6. Ledger `retention.purged` with counts. Failures log and do not advance the cursor, so the next tick retries.

Trash purge of a task also removes its completion-record? No. Completion records outlive the row. They are not user-facing trash.

## 7. Comments

The editor is TipTap 2.27. Page JSON stays in `task_pages.content` (task pages) and in the project/document page JSON where those editors already persist. `page_discussions` is the store. It is extended, not replaced:

```text
parent_id       uuid null          -- null = root comment or a page-anchored Ensemble thread
author_kind     text               -- "human" | "ensemble"
mark_id         text null          -- stable id shared with the TipTap mark
quote           text               -- the selected text at creation
deleted_at      timestamptz null
model           text null
tier            text null
pinned          boolean default false
```

Existing columns used as follows: `page_kind` (`task` | `project` | `document`), `page_id`, `kind` (`comment` | `ensemble`), `anchor` `{ markId, quote, contextBefore, contextAfter }`, `body` ProseMirror JSON, `mentions`, `status` (`open` | `resolved`), `resolved`, `conversation_id` for the Ensemble thread.

Anchor survival: the mark is `comment` with attrs `{ id: markId, commentId }`. TipTap keeps the mark across edits that don't delete the range. If the range is deleted, the mark disappears; the row remains with `anchor.orphaned = true` the next time the page is saved (the client reports mark ids still present). The rail shows an orphan at the top: "The highlighted text was removed" plus the quote. Resolving or deleting still works.

UI:

- Select text → floating Comment button, and `Cmd+Shift+M` / `Ctrl+Shift+M`.
- Page-level comments from a control at the top of the rail ("Comment on this page").
- Highlights are a low-contrast accent wash, stronger when the thread is open.
- Right margin rail on wide layouts. Below 960px the rail is a drawer.
- Edit and delete only your own human comments. Resolve and reopen are available to the page's owner (v1 is single-user ownership: `userId` on the row).
- Mentions inside comments use the same mention node as the page (people, projects, tasks).
- Humans cannot reply. The composer on a comment has no reply box. The only nested row is `author_kind = ensemble` (§8).

API (all scoped by `request.userId`):

- `GET /api/pages/:kind/:id/comments`
- `POST /api/pages/:kind/:id/comments` `{ markId, quote, body, mentions, anchor }`
- `PATCH /api/comments/:id` body, resolve, reopen
- `DELETE /api/comments/:id` soft

## 8. @ensemble

Typing `@ensemble` in a page or in a comment, then a question, invokes the same agent as Ask. Enter sends. A bare `@ensemble` with no question does not call a model.

### 8.1 Page text

The reply is inserted as a block node `ensembleReply` directly under the paragraph that contained the trigger (or under the selection). The node attrs hold `threadId` only. The text lives in `page_discussions` (`kind = ensemble`, `parent_id` null, `anchor` around the question) so a collaborator loading the page sees it, and so the page JSON does not become a transcript.

Visual: a quiet left accent rule, the Ensemble mark, streaming text, a chip with model and tier, Stop, Retry, Copy, "Insert into page", Delete. While the first token is pending, a subtle shimmer on the rule — not a bouncing chat bubble. The block collapses to one line.

"Insert into page" writes the answer as ordinary paragraphs below the block and leaves the block in place.

### 8.2 Comments

The comment body can contain `@ensemble …`. The reply is a child row (`parent_id = comment id`, `author_kind = ensemble`). It renders nested under that comment. A human reply is rejected with 400. `@ensemble` inside an existing Ensemble reply continues that thread: same `conversation_id`, the new user text stored as a child with `author_kind = human` is **not** allowed; the follow-up is a new user segment on the conversation and a new Ensemble child. The comment row itself is not rewritten into a chat.

### 8.3 Context and tools

The turn receives: page content and properties, the anchored text, the comment thread, linked project / people / repo / deliverables / skills, timezone and today's date, and a short recent-activity line (last few transitions). Tools are the same catalog. Writes use the same preview → Apply control, rendered inside the reply. The agent can search skills and the web. Every read and write is filtered by `userId` of the requester. There is no cross-user retrieval in v1.

Tier: the saved default (medium unless changed). The chip shows the label. Errors use the §3.2 sentences, inline, with Retry.

Rate limit: 20 Ensemble turns per user per minute, separate from the provider limit, so a stuck retry loop fails locally first. The message is "Too many Ensemble replies in a minute. Wait and try again."

Persistence: the discussion row is created at send (status `streaming`), updated on each flushed delta (at most every 150ms), and marked `open` on `done`. A reload mid-stream shows the text so far plus "Interrupted" if the turn ended without `done`.

## 9. Security and permissions

- v1 is single-tenant per account. Every query includes `userId` from the session. Tools receive that id from the route, never from the model.
- Model keys and the GitHub git token are encrypted at rest. Responses expose `hint` only. Tool arguments are not logged with secrets. Web search queries are ledgered as the query string, not as page bodies beyond 200 characters.
- Comment and Ensemble bodies are rendered with a sanitizer: markdown or ProseMirror to React elements, links `http(s)` only, no raw HTML.
- `hub_web_search` fetches go through the existing public-address guard. Redirects to private IPs fail.
- Apply checks the tool is a write, the area is allowed, and the call is still `awaiting_approval` for this user.
- Stop and stream endpoints check conversation ownership.

## 10. Git credentials for private clones (N-9)

When a workspace job has `useCredentials` and the remote host is `github.com`:

1. Use a saved GitHub token (Settings → Models & access → GitHub, stored as `github_git`) via `GIT_ASKPASS` that echoes the token. The token is not written into the remote URL.
2. Else, if `gh auth status` succeeds, run git with `-c credential.helper= -c credential.helper=!gh auth git-credential`.
3. Else, the configured system credential helper, as today.
4. If clone still fails auth, the message is: "Git has no credentials for github.com. Save a GitHub token in Settings, or run `gh auth setup-git`." The friendly hint is shown even when `useCredentials` is on.

Workspace turns retry 429/503 with the §3.3 policy and resume the message list from the last persisted step instead of failing the job on the first 503.

## 11. UI states

| Surface | Empty | Loading | Error | Success |
|---|---|---|---|---|
| Ask dock | Grounded prompts | Shimmer line + status text, Stop | Inline sentence from §3.2, Retry | Markdown answer, tool rows |
| Apply row | — | Button pending | Toast with the service error | "Applied", row ticks, undo toast |
| Clarifying question | — | — | — | Short question plus choice buttons that send the choice as the next message |
| Trash | "Trash is empty." | Skeleton rows | Banner | Restore toast |
| Completed | "Nothing completed in this view." | Skeleton | Banner | Reopen |
| Comment rail | "No comments on this page." | — | Inline | Highlight + thread |
| @ensemble block | — | Accent shimmer | Inline + Retry | Streamed text, actions |
| Model test | — | "Checking…" | Provider sentence | "answered Ready in N ms" |
| Skills miner | Coming soon, not a toast | — | — | — |

Dark mode is the default. Accent is the existing constellation accent, used as a 2px rule and a wash, not a gradient card. Motion respects `prefers-reduced-motion` and the reduce-motion setting: shimmer becomes a static rule.

## 12. Performance budget

Measured against production builds of `8e8a89c`.

- No route's first-load JS grows by more than 5 kB except chunks that are loaded only when used: comment rail, `@ensemble` block, trash view.
- Those three are `next/dynamic` (or a dynamic `import()` from the editor) and are not on the Today critical path.
- Cold Today and client page switches stay within noise of `8e8a89c`.
- The first streamed token is painted within 150ms of the server receiving it (client applies `delta` on the same frame as the SSE event).
- Routes that are static today stay static. Comment and Ensemble data are client fetches.
- TipTap and CodeMirror stay lazy. Hover, focus, and idle prefetch the chunks (`warmPeek`, `warmFileEditor`, and idle on Board / Code) so the first open does not pay the import.
- The sidebar Connections tile reserves its height (`min-h`) so the count resolving does not shift layout.
- The accent cookie value is `accent|updatedAtMs`. The boot script compares it with `localStorage` and uses the newer stamp, so a change on another device wins on the first frame.

## 13. Carry-over accessibility

- Switches (`Toggle`) require a `label`. Call sites that omitted it pass the setting title.
- Icon-only inputs and fields get `aria-label`.
- Nested interactive controls (a button inside a link, or a card that is both a link and a button) split: the card is one control, the secondary action is a sibling.
- Owner badges that convey the owner expose `role="img"` and their existing `aria-label`.

Dialogs (`role="dialog"`, `aria-modal="true"`, labelled by the title, focus moves in and returns on close) (N-14).

## 14. API summary

New or changed:

- `POST /api/assistant/turn` — SSE.
- `POST /api/assistant/conversations/:id/stop` — cancels `assistant:<id>`.
- `POST /api/assistant/apply` — CAS.
- `GET /api/models` — availability annotations.
- `PUT /api/secrets/github` — encrypted git token, returns hint.
- `GET/POST /api/pages/:kind/:id/comments`, `PATCH/DELETE /api/comments/:id`.
- `POST /api/comments/:id/ensemble` — starts an inline turn (also used by the editor).
- `GET /api/completed?q&kind&projectId`.
- `GET /api/deleted` — all kinds.
- `POST /api/tasks/:id/reopen`, `POST /api/deliverables/:id/reopen`, `POST /api/tasks/:id/pin`.

Settings fields added: `completedVisible`, `completedRetentionDays`. `assistant.defaultTier` default `medium`. `retentionDays` copy and presets change; the numeric field stays so existing rows remain valid.

## 15. Migrations

Ids are `TEXT` and datetimes are `TIMESTAMP(3)`, matching `schema.prisma` (not UUID or `TIMESTAMPTZ`).

`20260929000000_pre_feature_schema` creates the current schema idempotently (`CREATE TABLE IF NOT EXISTS`, enums and foreign keys ignore `duplicate_object`). An empty database bootstraps with `prisma migrate deploy` alone.

`20260929100000_db_push_baseline` is `SELECT 1`. It exists so a database that already has tables can be marked as baselined without running DDL.

`20260929120000_assistant_trash_comments`:

- `page_discussions.parent_id` TEXT, `author_kind`, `mark_id`, `quote`, `deleted_at`, `model`, `tier`, self-FK `ON DELETE CASCADE` for children.
- `tasks.pinned`, `deliverables.pinned` boolean default false.
- `completion_records` as in §6.3, index `(user_id, created_at)`.
- `model_probes` `(user_id, provider, model)` unique, `kind`, `detail`, `checked_at`.
- Invalid reminder times are nulled, not deleted. Existing reminders with a real `due_date` and a null `next_notification_at` are backfilled from `due_date`, `due_time` (or 09:00) and `time_zone`.

`20260929130000_ensemble_everywhere`: `watchers` and `ensemble_replies`. Both statements are idempotent.

### Baselining a db-push database

An empty database:

```
cd apps/hub-api
pnpm exec prisma migrate deploy
```

`prisma migrate deploy` reports P3005 when the database already has tables and no migration has been recorded. That is a db-push database. Record the no-op marker, then deploy. Deploy runs the idempotent schema migration and the feature migrations, including the reminder backfill:

```
cd apps/hub-api
pnpm exec prisma migrate resolve --applied 20260929100000_db_push_baseline
pnpm exec prisma migrate deploy
```

`resolve` does not run SQL. Do not `resolve` the schema migration or the two feature migrations if the columns or the backfill are still missing. The feature files are idempotent (`IF NOT EXISTS`) and repair a `parent_id` that was added as UUID.

`github_git` reuses `model_credentials` and needs no DDL.

## 16. Test plan

Unit and integration (node:test via `tsx`, no network):

- Task service: create with due, update status sets `completedAt` and a transition, undo row, priority round-trip, `projectName` resolved inside the transaction.
- Reminder validation rejects `tomorrow`; accepts ISO; `nextNotificationAt` uses the given zone.
- `shortDate("tomorrow")` does not throw.
- Retention: purge writes a completion record then soft-deletes; a missed day runs on catch-up; pinned rows stay; restoring a project leaves task links.
- Tool schema: bad status fails before Prisma; preview string contains the title and before/after.
- Apply CAS: second apply does not create a second row.
- Retry helper: 429 + Retry-After waits once and succeeds; quota 429 does not retry; 503 falls back once.
- Error mapper: nested Google JSON, 404, 503.
- Pricing: `gemini-3.5-flash-lite` returns a non-null estimate.
- Prompt includes the date, timezone, and open task id.

Python (pytest):

- Fixture replay of tool-call, 429, 503, and error JSON through the parser and retry policy.
- Mock provider returns the fixture verbatim.
- `_effort("google", "minimal", "gemini-3.5-flash")` is `minimal`.

Playwright (mock provider, dark, 1280×800):

- Delete and restore each entity from the UI; the row leaves and returns.
- Completed section hides older than N, settings change N, reopen works.
- Comment create, edit, resolve, delete; the mark survives an edit in the middle of the quote; deleting the range orphans cleanly.
- `@ensemble` in page text and in a comment: stream, Stop, Apply of a proposed task, a clarifying question with choices, a citation link.
- A reminder with `nextNotificationAt` in the past produces a notification row without a browser timer (API-level assertion inside the e2e setup).

Typecheck, `turbo build`, and pytest are green. Live Gemini is out of scope for this change; the mock provider stands in.

## 17. Rollout

One PR, draft until the suite is green, then ready for review. Not merged from here.

Order of commits after this document:

1. Phase 1 — runtime, services, tools, streaming, mock, tests.
2. Phase 2 — trash, completed, retention, completion records.
3. Phase 3 — comments.
4. Phase 4 — `@ensemble`.
5. Carry-over performance and accessibility.

No feature flag. The default write policy stays `preview`, so existing accounts do not gain silent writes. `defaultTier` changes from `easy` to `medium` only when the stored settings omit it; a saved `easy` is left alone. Retention behaviour changes on the next process start (catch-up). Trash contents already soft-deleted stay restorable.

## 18. Non-goals

- Multiplayer cursors, Yjs, or human replies on comments.
- The skill miner itself.
- Embeddings and the unused planner/executor.
- Hosting a shared model key. Every user brings their own.

## 19. @ensemble everywhere

`@ensemble` is invocable on every surface that already shows the user’s work. It answers in place: an inline block under the anchor, a comment-style reply, or a proposal card. It never navigates to a chat page and does not open the assistant dock. Pages and text comments (§8) stay as they are. This section adds the other surfaces on the same turn pipeline.

### 19.1 One invocation

Three pieces, shared:

1. **Context provider.** Each surface implements `loadSurfaceContext(prisma, userId, request)` and returns `{ surface, selection, entities, facts, citations }`. The read is filtered by `userId` on the server. Ids the caller names that they do not own are dropped and reported as not visible. The provider never widens permissions and never changes the tool list.
2. **Mention UI.** One lazy panel: a prompt field, an act-as override, surface quick-action chips, streaming markdown, proposal cards (Apply / Undo), and a citation list. A tiny static button (`Ask Ensemble`) preloads the panel on hover, focus, and click. Keyboard: Ctrl/Cmd+Shift+U opens the panel for the surface last hovered. The button is a sibling of sortable cards, never nested inside a drag handle.
3. **Turn.** `POST /api/ensemble/invoke` streams SSE through `runAssistantTurn`. The surface facts and the act-as persona are extra system messages (`referenceContext` plus a persona preamble). Writes stay proposals. Stop uses the same `assistant:<conversationId>` activity id. The finished answer is stored in `ensemble_replies` so a refresh keeps it.

Default complexity is the user’s saved tier, which is `medium` only when the stored settings omit `defaultTier`. The invoke route resolves that tier to provider, model, and effort the same way the dock does.

### 19.2 Surfaces

| Surface id | Anchor | What the provider loads | What the panel renders |
| --- | --- | --- | --- |
| `page`, `comment` | Already shipped (§8). Act-as is passed through when the existing route is cheap to extend. | Page or comment thread the user owns. | Inline block / nested comment. |
| `board` | Column header, or a shift-click selection bar above the board. Not inside a card. | The named tasks (or the column’s tasks) owned by the user: title, status, priority, owners, blocked-by, project. | Proposals: create subtasks, move, assign. Apply + Undo. |
| `today`, `needs_me` | Page header. | Open tasks, reminders due today, needs-me approvals, each scoped to the user. | Answer plus proposals (plan, draft replies). |
| `graph` | Ask control on the graph, shift-click multi-select. | Nodes and edges from `GET /api/context/graph` for this user. Shortest path between two selected nodes is computed with BFS over those edges and included as facts. | Panel anchored to the graph. Cited node and edge ids that exist in the loaded graph are highlighted on the canvas. |
| `code` | Ask on the open file header. | The path, cursor line, and the selection or diff text the review page already loaded and sends in the request. The server does not read the filesystem. | Explain / find bug / write the test, and a proposal to create a linked task. |
| `deliverable` | Ask on the deliverable row. | That deliverable, its brief, due date, and its tasks, owned by the user. | What’s missing, and proposals that turn feedback into tasks. |
| `watcher` | Parsed out of any invoke prompt that matches the two example shapes, and from the `hub_create_watcher` tool. | The scope entity (deliverable or task) the user owns. | A proposal card. Apply stores the watcher. |
| `trash`, `completed` | Page header. | Completion records (and, for trash, deleted titles) for this user, optionally filtered by project. | Answer citing those records. No writes. |

### 19.3 Act-as presets

`assistant.actAs` is `general | student | engineer | teacher | lawyer`, default `general`. Settings → Models gains a select next to Default complexity. The mention panel can override it for one invoke; the override is not saved.

A preset changes only the system-prompt persona, the tone line, and the suggested quick actions for that surface. It does not change `allowedWriteAreas`, the tool registry, or the `userId` filter.

| Preset | Prompt bias | Quick actions (examples) |
| --- | --- | --- |
| general | Neutral teammate. Cite, then propose. | Summarise this, draft the next step. |
| student | Assignment brief into a plan; quiz from notes; check citations; who did what. | Split into tasks, quiz me, check citations. |
| engineer | Triage into repo-linked tasks; explain a change plainly; who knows this code; release notes from completed work. | Explain this, file a task, who knows this. |
| teacher | Lesson plan or rubric; inline feedback; who is falling behind; practice questions. | Draft feedback, practice questions. |
| lawyer | Summarise a clause; compare drafts; extract obligations and deadlines into tasks with reminders; flag risky wording. Web research must show sources. | Summarise the clause, extract deadlines. |

Zod’s object `.default({})` does not re-apply nested defaults when `assistant` is omitted. `Settings.parse({})` is asserted to yield `actAs: "general"` by giving `AssistantSettings` itself a default object that includes `actAs`, and by a test that parses an assistant object which omits the key.

### 19.4 Watchers

New table `watchers`:

- `id`, `userId`, `surface`, `prompt`
- `scopeKind` (`deliverable` | `task`), `scopeId`
- `condition` (`all_tasks_done` | `days_before_due`), `daysBefore` (nullable int)
- `action` (`notify`), `message`
- `status` (`active` | `fired` | `cancelled`), `firedAt`, `cancelledAt`, `createdAt`

Creating one is a write. The model may call `hub_create_watcher` (preview → Apply, undo cancels). A deterministic parser also runs on the user prompt so these two phrases become a proposal even when the model never calls the tool:

- “tell me when all tasks under this deliverable are done” → `all_tasks_done` on the current deliverable.
- “remind the owner 2 days before due” → `days_before_due` with `daysBefore = 2`.

The scheduler tick calls `evaluateWatchers` beside `dispatchDueReminders`.

- `all_tasks_done`: tasks with that `deliverableId`, `deletedAt` null. If there is at least one and every one is `done` or `dropped`, insert a notification and set `fired`.
- `days_before_due`: fire once when the scope entity’s due date is within N days (and not already past by more than a day). One notification, then `fired`.

`GET /api/watchers` lists the user’s rows. `POST /api/watchers/:id/cancel` sets `cancelled`. Both the panel where it was created and Settings → Models list them and offer Cancel.

### 19.5 Citations and graph paths

Every invoke answer is scanned for ids. An id is kept only when it appears in the loaded context (task, page, graph node, graph edge, completion record, or an `http`/`https` URL the model cited). Invented ids are stripped before the reply is stored and before the client highlights anything. The graph panel highlights the surviving node ids and the edges whose endpoints were both cited or whose edge id was cited. Shortest paths are BFS over the user’s real edges; the path is included as facts so the model is not asked to invent one.

### 19.6 Permissions

`loadSurfaceContext` is the only read. It queries with `userId` (or the equivalent owner column). A requested id owned by someone else is omitted, and the facts include a single line: “Some requested ids are not visible to you.” Tests cover a foreign id on every surface. Act-as never bypasses this.

### 19.7 Performance

The panel module (markdown, streaming, Apply cards) is a dynamic import. Routes keep a static button of a few hundred bytes. Preload on hover and focus. Today stays a static route. First-load JS on any route grows by at most 5 kB versus the build already recorded for this PR. Shared first-load stays 103 kB.

### 19.8 API and migration

- `POST /api/ensemble/invoke` — body `{ surface, prompt, selection?, entityIds?, actAs?, codeText?, path?, line? }`. SSE: `status`, `delta`, `tool`, `pending`, `error`, `done`. Same rate limit as comment `@ensemble` (20/min).
- `GET /api/ensemble/replies?surface&anchorKey` — the stored answers for that anchor.
- `GET /api/watchers`, `POST /api/watchers/:id/cancel`.
- Tool `hub_create_watcher` in the existing registry. Area `reminders`, write, undoable.

Migration `20260929130000_ensemble_everywhere`:

- `watchers` as in §19.4, index `(user_id, status)`.
- `ensemble_replies`: `userId`, `surface`, `anchorKey`, `prompt`, `content`, `toolCalls` json, `citations` json, `actAs`, `model`, `tier`, `status`, `createdAt`. Index `(user_id, surface, anchor_key)`.

Settings field added: `assistant.actAs`, default `general`.

### 19.9 Tests and screenshots

Unit (no network):

- Each surface provider drops a foreign id and keeps an owned id.
- Graph BFS returns the real shortest path and refuses an id not in the graph.
- `personaBlock(actAs)` contains that preset’s bias and does not mention a tool allow-list change.
- `parseWatcher` maps both example phrases; other prompts return null.
- `watcherDue` is true only inside the window.

Integration (Postgres, throwaway user): a provider queried with another user’s id returns no entities.

Playwright (mock provider, dark, 1280×800): Board column ask, graph ask with a cited node, code-review line ask, deliverable ask, and a watcher proposal that becomes a row after Apply. One light-mode shot of the same panel.

Screenshots in `/opt/cursor/artifacts/features/`: one dark frame per surface showing the invocation, the answer, and a proposal where that surface writes, plus `ensemble-light.png`.

### 19.10 What stays out

- Rebuilding the page and comment `@ensemble` UI.
- A second agent loop.
- Reading arbitrary files on the server for the code surface.
- Changing permissions or tools per preset.
- The skill miner.

If a surface cannot be finished to the same depth, it still gets a working provider, a panel, and a test, and the PR description says what is thin.

## 20. Undo/redo

One server-side stack per user, in `undo_entries`. It is shared by the assistant and the UI, across tabs and reloads. Depth is `settings.undoDepth`: default 5, range 3–20. It is never unlimited. Recording a new action deletes the redo tail and drops live entries beyond N in that same transaction.

An entry stores field patches, not full rows: `{ model, id, kind, fields, version }`. `fields` is only what changed, each as `{ before, after }`. `version` is the row’s `updatedAt` after the write. Undo checks that the row still exists, that each changed field still equals `after`, and that `updatedAt` still equals `version`. Redo checks the fields equal `before` and that `updatedAt` equals the stamp the undo wrote. A mismatch returns 409 with “changed since”, deletes that entry, and leaves the rest of the stack usable. A failed entry is never left on top. Unrelated fields are not written. `updatedAt` moves forward; it is not restored to the old instant. A status or owner change appends a new `task_transitions` row for the undo or redo.

Undo of a create sets `deletedAt` (Trash). Redo clears it. A watcher create is cancelled and restored the same way. Undo never hard-deletes.

One Apply is one entry, including a tool that creates several rows. Apply all on a multi-change proposal is one entry (`groupId` is that entry’s id). Undo and redo run every patch in the entry in one transaction.

`POST /api/undo` takes `{ entryId? }`. Toasts and proposal cards pass the id returned by the write. Ctrl+Z and the top bar omit it and undo the newest. Redo replays the most recently undone entry.

Page autosaves are not journaled. The editor keeps its own history, so a global undo cannot revert the open page out from under the next keystroke.

The dock and @ensemble cards show Undo after Apply, then Undone with Redo. A failed undo shows an error toast. The SSE event `undo.changed` refreshes Undo and Redo in every open tab.

`audit_ledger` and `task_transitions` are purged by the 03:30 retention job after `settings.historyRetentionDays` (default 90, range 30–365). That clock is separate from Trash (`retentionDays`, default 30). Purging ledger rows does not rewrite hashes; the oldest remaining row may point at a purged predecessor.
