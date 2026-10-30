# 29 · Sharing

An Ensemble space, or one item in it, can be shared with people who have an Ensemble account. The space stays the owner's: its work is shared, while the owner's settings, model keys, connected apps, computers, Today and metrics stay private. A single item opens on its own, without the rest of the space. Pages, tasks, diagrams and meeting notes can also open for **anyone with the link** (§9).

Code: `apps/hub-api/src/sharing/` (tests `sharing.integration.test.ts`, `policy.test.ts`, `links.integration.test.ts`). Hub: `components/sharing/`, `app/(hub)/shared`, `app/(hub)/shared-by-me`, `app/shared/[id]`, `app/p/[token]`, `components/settings/tab-sharing.tsx`.

## 1. What can be shared

| | Whole space (members) | One item (shares) |
|---|---|---|
| Who | Up to **2** people per space by default, so 3 with the owner (your choice, §1 Limits) | Any of your contacts |
| Kinds | Everything except the private list below | `page`, `task`, `board`, `diagram`, `plot_space`, `plot`, `meeting`, `skill`, `workspace` (the agent workspace tab), `code` |
| Roles | `viewer` (reads) or `editor` (reads and writes) | `view` or `edit`; `meeting`, `workspace` and `code` are always view-only (`VIEW_ONLY_KINDS` in `policy.ts`) |
| Opens at | The space switcher, under **Shared with you** | `/shared/<shareId>`, only for its recipient |

Limits: contacts, people per space, people per Ensemble Node room and spaces are each account's own choice (`settings.sharing`, `accountLimits` in `lib/limits.ts`), set in Settings › Sharing › Limits or with `PUT /api/sharing/limits {contacts?, members?, roomPeople?, spaces?}`:

| Setting | Default | Most an account may choose (`SHARING_CAPS`) |
|---|---|---|
| `contacts` | 5 (`MAX_CONTACTS`) | 500 |
| `members` (people per space you own) | 2 (`MAX_MEMBERS`) | 50 |
| `roomPeople` (people in an Ensemble Node room you make, you and open requests to join included) | 10 | 50 |
| `spaces` (spaces you own, your account's own included; [28](28_ENSEMBLE_SPACES.md)) | 12 | 100 |

A lower limit takes nobody and nothing away; it only stops new additions until fewer are in use. A space handed over counts against the receiver's own `spaces`. The space owner's limits apply, whoever adds the person (an Ensemble Node room's offer included: [35](35_ENSEMBLE_NODE.md) §12.11; such an offer stands only while the room's creator owns the space, and is withdrawn when the person loses the space). `GET /api/sharing/overview` returns `limits` and `caps`. Fixed: `MAX_TRANSFERS` 1 (`sharing/store.ts`); `MAX_PUBLIC_LINKS` 3 (`sharing/links.ts`).

**Never shared**, even with a member: Today, metrics, settings, model keys, connected apps (connectors, MCP connections, imports), reminders, the terminal, editor tokens, paired computers, the kill switch, Trash, data deletion, page history and templates. Runs, Needs me, metrics and settings cannot be shared on their own.

**Context is shared, the owner's inbox is not.** Members see the space's people, projects, repos, meeting notes, documents and work artifacts (files, pull requests, issues, commits, transcripts). Mail, chat and channel messages and calendar events synced by the owner's apps (`PRIVATE_ARTIFACT_KINDS` in `sharing/context.ts`), and connector sync state, are left out of every list, search, graph and assistant answer a member reaches. Tasks proposed from those messages stay visible. Members read Files → From your apps (`GET /api/artifacts`, `/api/artifacts/:id`); only the owner removes an item.

**Trash.** Items in Trash are unavailable to members, recipients and link visitors (`resourceTitle` in `sharing/store.ts` and `pages/store.ts` check `deletedAt`). Restore brings the item back with its shares and links.

**Contacts.** Everyone you share with becomes a contact: 5 per account unless you choose otherwise, counted as unique people across all your spaces and items. One past the limit gets 409 `CONTACT_LIMIT`. Allocations serialise on the account row (`ensureContact`). Removing a contact first revokes their memberships and item shares in every space you own (`removeContact`). The limit dialog (`components/sharing/sharing-limits.tsx`) offers **Remove and revoke access**.

**Ownership transfer** (`transferSpace`). The owner of a space they created (not their first space, which is their account) can hand it to one of its members, **once** per space (`space_transfers.space_id` is unique). The content moves. The old owner's connected apps, model keys, devices, API tokens, settings, sync state and synced communications are removed, and the new owner's settings are copied in. Chats, comments and runs keep their author. Undo history and the space's item shares are deleted. The old owner stays as an editor; other members stay only if they are the new owner's contacts. Refused while an agent run is queued or active, when the new owner has the most spaces allowed, or has no contact slot for the old owner. Both accounts are locked while it runs.

**Losing access is immediate** (`sharing/revoke.ts`): their event streams on the space close, an older ticket cannot open a new one, they leave the presence room, and runs they started there on their computer are cancelled. Their computer can no longer claim or report on those runs (`stillMember` in `devices/routes.ts`). A transfer closes every stream on the space so everyone reconnects with their new role.

An open shared item notices at once: the closed stream (last frame `sharing.changed`), a refused ticket, or live steps answered 404 `SHARE_GONE` or 403 make `/shared/[id]` or `/p/[token]` re-check the share (`useShareLive`, `useRecheck` in `shared-viewer.tsx`). If it is gone, the item stays read-only under "‹owner› stopped sharing this with you…", the stream and heartbeat stop, and nothing more is saved. Unconfirmed typing stays in the editor with **Copy my text** (Markdown) and, when signed in, **Save as my own page** (`components/pages/kept-edits.tsx`).

## 2. How access works

A space is a `users` row ([28](28_ENSEMBLE_SPACES.md)) and every record is scoped by its id. A member's or recipient's request runs **as the space** (`request.userId`), with `request.accountId` the person and `request.access` how they got in:

| `access.kind` | Set by | Meaning |
|---|---|---|
| `owner` | your own spaces (default) | No restriction |
| `member` | the `ensemble_space` cookie naming a space in `space_members` for you | `role` viewer or editor |
| `share` | `x-ensemble-share: <shareId>`, for a share whose recipient is you | One item, `role` view or edit |
| `link` | `x-ensemble-link` and `x-ensemble-visitor` (§9) | One public item |
| `gone` | a share header that is not yours or no longer exists; a node's request for a space its owner cannot open | 404 `SHARE_GONE` on every request |

`identify()` and `inSpace()` in `apps/hub-api/src/lib/auth.ts` resolve this; `openedSpace()` there (with `openableSpace()` in `spaces/store.ts`) checks the cookie. Tokens, CLI keys and service calls never read the cookie or these headers.

**An Ensemble Node acting for its owner** ([35 §5.2](35_ENSEMBLE_NODE.md#52-every-space-its-owner-can-open)) has a delegated identity of its own, not a copy of a browser's: `via: "node"`, `accountId` the owner, `userId` the space, and `access` the owner's current access there (`owner`, or `member` with its role) with `node` set to the node's id. It is the internal token with `x-ensemble-node-account`, `x-ensemble-space` and `x-ensemble-node` (`nodeRequestHeaders`), sent only by the server itself. `identify()` checks on every request that the node is the account's and, with `openedSpace()`, that the account can still open the space. It installs the scope a member's own request gets, so the route policy, `guestMayUse` and the private-apps rule apply unchanged, and it is never a browser session: `requireBrowserSession`, the terminal, passkeys, spaces, sharing and device pairing refuse it. Tool calls that do not go through a route run in the same scope (`node/spaces.ts`). A node turn whose answer a room with other people reads ([35 §12.3](35_ENSEMBLE_NODE.md#123-room-bound-turns)) runs as a guest of its owner's own account (`access: member`, `node` set), so the owner's connected apps, reminders, imports and syncs stay out of it, as they do in a space shared with someone; its Hub tools reach only the room's bound space, through that space's own scope.

`ENSEMBLE_COOKIE_NAMESPACE` gives a deployment its own session, active-space and OAuth cookie names. Set it identically on API and web when a testing deployment shares the production parent domain; the default names above apply when it is unset ([36](36_WEB_TESTING.md)).

Each request runs in an `AsyncLocalStorage` scope (`sharing/context.ts`, set by `scopeHook` in `gate.ts`):

- `keysFor(userId)`: whose model keys, settings, pacing, activity and metrics apply; for a guest, their own account.
- `actorFor(spaceId)`: the acting person when not the owner, stamped on undo entries, comments, assistant conversations, ledger entries (`payload.byAccountId`) and jobs (`runner_account_id`).
- `nodeActingIn(spaceId)`: the node acting for the person, if any, stamped on ledger entries (`payload.byNodeId`) and undo entries (`source` `node:<id>`).
- `madeBy(spaceId)`: "@node for person". Tasks keep `created_by_account_id` and `created_by_node_id`, pages `editor_node_id` next to `editor_account_id` (the last editor), and comments `author_node_id` next to `author_account_id`. The account is null when the space's owner acted themselves, as with `actorFor`. A run a node started is `node_runs` (node, its owner, the job).

### The route policy

`sharing/policy.ts` classes every route (first match wins); the `sharingGate` pre-handler (`gate.ts`) enforces it for non-owners. **Unlisted routes are owner-only.** `policy.test.ts` checks that every route in `apps/hub-api/scripts/route-inventory.json` has a class and every share rule names a real route.

| Class | Member | Examples |
|---|---|---|
| `shared` | viewers GET only, editors anything | tasks, pages, custom boards and board membership, comments, projects, deliverables, diagrams, plots, skills, documents, meeting sessions, undo/redo, people; GET of repos, context, artifacts, runs, workspace and `/api/desk/live` (without reminders or inbox) |
| `personal` | runs on their own account | settings, model keys, models, secrets, notifications, metrics, activity, device list, rename and pairing, Code tab and terminal on their own computer, Ensemble Node (`/api/node/*`: its own room membership and visibility decide what each person reads, [35](35_ENSEMBLE_NODE.md#3-rooms-messages-and-visibility)) |
| `assistant` | own keys; viewers cannot apply writes | `/api/assistant/*`, `/api/ask`, `/api/ensemble/invoke`, inline @ensemble, meeting summaries |
| `runner` | editors; the handler limits it to the runner | assign, stop, retry, answering a run's question, `POST /api/runs/:id/feedback` |
| `prefs` | the handler decides per key | §3 |
| `self`, `live`, `open` | always | auth, spaces, sharing, links, events, presence, catalogues, health |
| `owner` (default) | 403 "Only ‹owner› can do this in their space." | connectors, imports, Today, reminders, terminal, tokens, layout edits, code changes, approvals, data deletion, `/api/brief/skill`, `/api/page-versions*`, `/api/page-templates*`, `POST /api/pages/:id/duplicate` and `/template` |

Notes: `POST /api/pages/delete-many` (shared) checks every id, keeps descendants in the same space and records one Undo entry. `POST /api/skills/:id/test` (shared) runs with the acting person's credentials. Run feedback starts a follow-up only for the run's runner and repeats the assignment checks.

**Single items** use `SHARE_RULES`: each kind lists its routes and which param, query or body field must be the item's id; `personal`, `self`, `live` and `open` routes stay allowed. `gate.ts` also lets a shared page or task (and a public link to one) read files its current content mentions or embeds, file cards and images alike (`/api/documents/:id`, `/original`, `/text`), and a shared plot space read the datasets its tiles use.

A computer downloads a run's attachments (`GET /api/devices/self/jobs/:id/attachments/:fileId`) only with the job's live lease (`x-ensemble-job-lease`), on its assigned device, while the runner is still a member.

## 3. What stays private, and how

- **Search** (`GET /api/context/search`): members search the open space with the usual visibility and deleted-item filters; single-item shares cannot call it.
- **Settings** (`lib/settings.ts`): `loadSettings`/`saveSettings` resolve to your account, so theme, models, assistant tone and page width are yours. `/api/auth/me` and `/api/shell` report your account.
- **Model keys** (`lib/runtime.ts`, `lib/model-turn.ts`): model calls send your account; the runtime uses it only for keys, pacing and host access.
- **Connected apps**: for a guest, `guestMayUse` (`assistant/apps.ts`) removes connected-app, reminder and sync tools and `OWNER_TOOLS` (calendar events, layout edits, app relationships, imports, Fetch now, repo links, watchers); viewers get no write tools. The prompt says whose space it is and that their apps are private (`assistant/state.ts`); `loadConnections` returns nothing and `hub_list_connections` says the apps are private.
- **Assistant actions** that call routes forward the person's own request credentials (`assistant/request.ts`), never an owner token, so route classes apply; workflows recheck each nested tool (`assistant/tools/workflows.ts`). See [34](34_ASSISTANT_ACTIONS.md). A node's actions send its delegated identity for the space each call acts in (§2).
- **Assistant chats** carry `account_id`; each person sees only their own, and stream frames go only to the asker. `hub_list_due` omits the owner's reminders, inline asks about Today or Needs me are refused (`/api/ensemble/invoke`), and shorthand like "mock 7/10" never writes to the owner's desk (`askEnsemble`).
- **Preferences** (`routes/context.ts`): `ui.*` (your shortcuts) is stored on your account; `desk.*`, `hub.*` and `hosted.*` are the owner's; editors may change other context preferences. `hub.settings` is never written or deleted as a preference.
- **Undo** (`lib/undo.ts`): one history per person per space (`undo_entries.actor_account_id`).
- **Comments** carry their author (`page_discussions.author_account_id`). You edit and delete your own; the owner may delete any.
- **Page history**: only the owner lists or restores versions, reads templates or duplicates pages. Live edits are stamped with the server-authenticated editor (`routes/collab.ts`), so authorship cannot be spoofed.
- **Needs me**: questions from the owner's own editors (Cursor, Claude Code…) and their frames reach only the owner (`ownerOnly`).
- **Events** (`lib/sse.ts`): actor frames (`assistant.frame`, `assistant.acted`, `undo.changed`, `undo.recorded`) go to the acting person; owner frames (`reminder.due`, `sync`, `device`) to the owner; a single shared item hears only frames about it (`shareSees`). `sharing.changed` and `notification` reach you on an account-only channel in any space.
- **Directory search** (`GET /api/sharing/people`, `searchPeople`): 2+ characters; matches names, the start of account emails, and exact emails of linked Google, GitHub or Microsoft sign-ins. Never spaces or you; on hosted only verified accounts; at most 25 results. Emails are masked (`ak••••••e@gmail.com`) unless you typed the exact address. 40 searches a minute per account.

## 4. Agent runs in a shared space

A member who assigns a task to the agent runs it **on their own computer**:

- The assign dialog lists only their own paired computers (`GET /api/devices` is personal); the server runner is the owner's and refused for members (`workspace/assign.ts`).
- The job lives in the shared space (`workspace_jobs.user_id`) with `runner_account_id`. Their computer claims it (`runsOn` in `devices/routes.ts`) and it counts against their daily quota (`createCappedJob`).
- Everyone in the space sees the run, its log and its code. Only the runner sees which computer: others get `deviceName: null`, `yours: false`, and the Hub shows "Ben Ito's computer" (`lib/runner.ts`, `components/agent/job-card.tsx`).
- Only the runner can stop it, rerun it, start a follow-up or answer its questions; the owner sees the question with a lock. The runner's notification link opens the shared space (`?openSpace=`). The owner's kill switch and stop-all skip runs on other people's computers.
- Code stays view-only for all but the owner: `/api/code` writes, the terminal and approving hosted runs are owner-only.

### Tasks with a person

In a space with members, a task owned by `me` can be with one person, the owner or a member, chosen in the task page's Owner menu. The request sends `assignee` (an account id), stored in `tasks.assignee_account_id`, null for the owner (`resolveAssignee` in `services/tasks.ts`); anyone else gets 400. `owner: "me"` without an assignee means the acting person. Handing the task to the agent or unassigning it clears the person. Board cards show **Me**, **Agent** or the other person's initials, relative to the viewer.

## 5. Live presence

`POST`/`GET /api/presence` keep an in-memory room per space (`sharing/presence.ts`, one API process). The Hub posts every 15 s (`components/sharing/presence-host.tsx`), on route changes, and while typing, moving on a diagram or moving the caret on a page someone else has open. Entries expire after 45 s; closing a tab sends `leave`. Each person has a fixed colour. Presence runs only when the space has collaborators or is shared with you. Single-item and link visitors report only their item, never a route, and see only people on it.

- **Top bar**: up to four avatars and a "+N" chip naming the rest (`PresenceStack` in `components/sharing/people.tsx`). Clicking opens **Here now** (arrow keys and Tab move, Esc closes and returns focus). Each row says where the person is, with *Go to* and **Follow**. Following frames the window in their colour, shows "Following ‹full name› · Stop · Esc", goes where they go and, on a diagram, centres on their view; it stops on Esc, when you navigate, or 10 s after they leave. Single-item and link visitors read "On the shared page": *Go to* opens that item here (`hrefOf` in `lib/presence.ts`) and an info mark explains why there is no Follow. People working in their own space are not listed.
- **Pages, tasks, diagrams, the board**: the same avatars for people on the item, with "‹full name› is editing…" ("‹name› and ‹name› are editing…" for two); clicking lists them (`page-people.tsx`).
- **Diagrams**: everyone's live cursor in diagram coordinates, labelled with their full name (`live-cursors.tsx`).
- **Carets** on pages and task pages: others' cursors and selections in their colour and name (`RemoteCarets` in `components/editor/remote-carets.tsx`). Presence carries `caret: { anchor, head, version }`, sent at most every 0.3 s, only while someone else is on the page and once your typing is confirmed; the receiver maps it through the steps since. A caret is dropped when its person moves to another item; moving it does not end the "is editing…" pulse.
- **Names and initials**: people are named in full everywhere. Initials come from `personInitials` (`packages/shared-types/src/avatars.ts`, API and Hub): first letter or digit of the first and last words ("Test Five" → TF, "Test 3" → T3), or the first two of a one-word name. In one row, names that would collide get another letter of the last word (`distinctInitials`: TTw, TTh). Overlapping avatars keep a gap in the page colour.

### 5.1 Pages edited live

Everyone on a page or task page edits one live document: ProseMirror's central-authority model, with `prosemirror-collab` in the editor (`components/editor/collab.ts`, `components/pages/use-collab.ts`) and one in-memory authority per open page in the API process (`apps/hub-api/src/pages/collab.ts`, `collab-core.ts`) that numbers every step (`version`).

- **Concurrent typing.** Steps sent after someone else's get 409 `COLLAB_BEHIND` with the missed steps; the editor rebases and resends, so two people typing at one spot both keep their text, never interleaved. Every step reaches every editor as a `page.steps` event. Undo takes back only your own typing; two tabs are two editors.
- **Identity.** Join issues a client id starting with the account id, plus a token (an HMAC keyed at API start) only that join's answer carries. Steps with another account's id or a wrong token get 410 `COLLAB_REJOIN`; the editor rejoins and resends (also when a signed-in session expires on a public link and the person goes on as visitor).
- **Saved means stored.** "Saving…" shows until the server reports `saved` at or past your last step, then "All changes saved". Until then the typing is also a draft in the tab.

| What | Value |
|---|---|
| Editor sends | ~60 ms after typing with others on the page, 250 ms alone; one request at a time |
| One request | ≤ 200 steps and 1 MiB (one step always goes); route body limit 8 MiB (API default 4 MiB). The answer is the steps taken, so a request larger than the log is never mistaken for a restart |
| Write-back | 0.8 s after the last step, at least every 3 s |
| Idle page | written back and dropped after 15 min; an open editor moves to the reloaded page |
| Failing write-backs | 3 in a row: 503 `COLLAB_UNSAVED` until one succeeds; editors keep the typing, say "Could not save", resend |
| Step log | 1,000 steps, 8 MB |

**Schema.** `packages/shared-types/src/page-schema.json` is generated from the editor's TipTap extensions by `pnpm --filter @ensemble/hub-web page-schema` and is hub-api's schema (`src/pages/schema.ts`); `components/editor/schema-spec.test.ts` fails when they differ. After changing a node, mark or attribute, run it and commit the JSON.

**Saving.** `writeCollabPage` (`pages/store.ts`) writes the next revision, mention index, search text and which authority and version wrote it, under the usual row locks, then publishes `page` with `by: "collab"`, `epoch` and `saved`. Pending write-backs flush on shutdown (`onClose` in `routes/collab.ts`). The mention index skips mentions it cannot hold.

**Refusals** (`collab-core.ts`):

| Code | Cause |
|---|---|
| 400 `COLLAB_REJECTED` | U+0000 or a lone surrogate (half an emoji) in parsed text or attribute values; an unknown mention kind; blocks nested over 48 deep; a `data:` image over 2 MiB the page did not already hold ([32 §6](32_FILES.md#images-in-pages)) |
| 413 `COLLAB_TOO_LARGE` | a step over 1 MB; over 1,000 steps; growing the page past 4,200,000 positions or 8,000,000 characters of JSON (at least what a 4 MiB page save holds) |

Only growth past a limit is refused, so an oversized page can still be shortened. A refusal names the step (`step`): if no other steps arrived since, the editor drops it, moves later typing past it (`without`), sends the rest and says what was removed; otherwise it asks again. A body-limit 413 counts the same for one step; with several, the editor then sends one step per request. Pasted and dropped text loses U+0000 and lone surrogates first (`storableText`); whole-page saves store well-formed text (`storable` in `pages/content.ts`: U+0000 dropped, lone surrogates as U+FFFD).

**Writes from elsewhere** (assistant page tools, agent output, whole-page `PUT`, undo, attaching a file) publish `page`, `task` or `undo.changed`; the authority re-reads the stored copy (again after 0.3 s and 2 s when a `page` event changed nothing yet, since the assistant publishes before committing). An unwritten task page follows the task's notes. A changed copy enters as server steps, the diff from the copy last written (`page-diff.ts`, identical in hub-web and hub-api per `components/editor/page-diff.test.ts`), moved over newer typing; if that would not fit or would delete new typing, it is three-way merged (`mergeDocs` in `packages/shared-types/src/page-merge.ts`: by block, then word; both versions stay where both rewrote the same words). Write-backs re-read under their lock, so they never overwrite such writes. Undo of page content locks the row and bumps its revision.

**Offline and drafts.**

- Offline, steps stay in the editor ("Offline — your changes will sync when you're back") and are resent with backoff and on reconnect. After a stream drop, tab return or reconnect, the editor fetches missed steps, also on a frame from an unknown epoch.
- The draft (`sessionStorage`, `ensemble.draft:<kind>:<id>:<client id>`) holds the stored copy as last known, server steps since with senders, and unconfirmed steps. It is written 3 s after sending and at once on leaving, going offline, a refusal, or before an expired session goes to sign-in (`SIGNED_OUT_EVENT` in `lib/api.ts`). Full storage is reported once.
- Only the same account takes a draft over, and only from an editor that is gone; open or sending editors in any tab keep theirs (Web Locks by client id, `CollabTab`). A closing page keeps sending and flushes; reopening it in that tab waits up to 10 s. Applied drafts are noted in `localStorage` (`ensemble.draft-applied:<client id>`, 30 days) so a duplicated tab never applies one twice. A toast says when typing was put back.
- Closing the tab or browser with unstored typing asks first (`beforeunload`); a reload keeps the draft. The desktop app's window close does not ask.

**Restarts.**

- An API restart starts live pages over (410 `COLLAB_RESET`, new `epoch`). The editor fetches the stored copy and its writer (`GET …/collab?start=1`; columns `collab_epoch`, `collab_version`, `collab_revision`, migration `20261016120000_collab_marker`) and resends exactly its own steps after that version, over what others resent first. If something else wrote the copy since, the union merge (`mergeDocs` with `union: true`, used only here) adds your typing once where the server has the same words or blocks, else keeps it whole beside theirs (theirs first, a space between), never paired word by word; deletions stay deleted.
- On the same server (behind its log, or asked to rejoin) nothing is merged by words: if the log has the steps since your version, they show which of yours it took (under any of your ids) and the rest are rebased; otherwise unconfirmed steps move over the diff to its current document (`carryOver`), and only a step that no longer fits uses the three-way merge. Same-server drafts are put back the same way. A page that closed while its last request met a restart releases its draft for the next open.
- After a crash, typing confirmed but not written back is resent by open editors or from the tab's draft on next open; a tab closed meanwhile cannot.

**Trash, delete, convert.** Deleting, trashing or converting a page writes back live typing first. A page trashed another way (the assistant) still gets it, keeping the page's time so Undo of the delete works. Editors then get 404 `PAGE_IN_TRASH` and keep their draft until Restore; trashed pages are not joined. If joining fails for 10 s (a deploy), the page offers Reload.

**Who may.** Joining needs view access and sending needs edit access, as for reading and saving the page; share, board and link rules list the collab routes. A view-only link follows along; an edit link types live, sending about once a second to stay under the link write limit (§9). A removed share refuses steps at once (404 `SHARE_GONE`; §1).

**Tests.** `components/editor/collab.test.ts` runs three real block editors against the hub-api authority with random network delays (concurrent typing and Undo, offline, restarts, crashes, outside writes, expired sessions, drafts, duplicated tabs, refusals, limits, Trash, carets) and requires identical editors and stored page with every word once. Also `components/pages/use-collab.test.tsx`, `page-diff.test.ts`, `packages/shared-types/src/page-merge.test.ts`, and hub-api `src/pages/collab.test.ts` and `collab.integration.test.ts`.

Meeting notes are not live: they save whole documents without a revision, so the last save wins (`components/meetings/notes-fields.tsx`).

## 6. Routes

Sharing and link management need a browser session (`browserOnly` in `sharing/routes.ts`); tokens and internal calls get 403. `/api/presence` and `/api/links/open` do not.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sharing/people?q=` | Directory search (§3) |
| GET | `/api/sharing/overview` | Limits, contacts, your spaces with members, items you shared, shared with you |
| GET/POST | `/api/sharing/contacts` | `{ personId }`; 409 at 5 |
| DELETE | `/api/sharing/contacts/:id` | Removes and takes back everything → `{ removed: { spaces, items } }` |
| GET | `/api/sharing/with-me` | `{ spaces, items }` |
| GET | `/api/sharing/spaces/:id/members` | Owner and members may read |
| POST | `/api/sharing/spaces/:id/members` | `{ personId, role }`; owner only; 409 at 2 |
| PATCH/DELETE | `/api/sharing/spaces/:id/members/:personId` | Change role / remove; a member removing themself leaves |
| POST | `/api/sharing/spaces/:id/transfer` | `{ toId, confirmation: "‹space name›" }`, once |
| GET | `/api/sharing/items?kind=&resourceId=` | Who has one item (owner of the open space) |
| POST | `/api/sharing/items` | `{ kind, resourceId, personId, role }` from the open space |
| PATCH/DELETE | `/api/sharing/items/:id` | Owner changes or removes; the recipient may remove it from their list |
| GET | `/api/sharing/open/:id` | What a share opens, for its recipient; marks it opened. 404 `SHARE_NOT_YOURS` for another account's share, `SHARE_NOT_FOUND` otherwise (a removed share's row is deleted, so it looks like a wrong address). Sent without the share header |
| GET/POST | `/api/presence` | §5. POST: `tabId` and optional `route`, `resource`, `cursor`, `viewport`, `caret` (`{ anchor, head, version? }`), `typing`, `leave` |
| | `/api/links…` | §9 |

Adding someone sends a notification and a live `sharing.changed` frame. Removing them or deleting the space sends the frame too, and their open tab returns them to their own space with a message.

**Live editing** (§5.1), `routes/collab.ts`, follows the page and task classes: `GET/POST /api/pages/:id/collab` and `GET/POST /api/tasks/:id/page/collab`.

| Call | Answer |
|---|---|
| `GET` (join) | `{ epoch, version, doc, revision, saved, clientID, token }`. `?stored=1` adds `stored` (stored copy, its version, steps since); `?start=1` adds `start` (the document as loaded, `previous`: the authority and version that wrote it, steps since) |
| `GET ?epoch=&version=` | `{ epoch, from, version, steps, clientIDs, saved }` since that version |
| `POST { epoch, version, clientID, token, steps, flush? }` | Body up to 8 MiB. Returns the steps from `version` on, yours included, and `saved` (plus `revision` after `flush: true`, which writes the page back first). `clientID` must be `<your account id>/…` as join issued it, with its `token` |

Errors: 409 `COLLAB_BEHIND` (with the missed steps), 410 `COLLAB_RESET` (reload), 410 `COLLAB_REJOIN` (join again), 400 `COLLAB_REJECTED` and 413 `COLLAB_TOO_LARGE` (with `step` when one step is to blame), 503 `COLLAB_UNSAVED`, 404 `PAGE_IN_TRASH`. The stream event `page.steps` is `{ kind, id, taskId?, epoch, from, version, steps, clientIDs, saved }`; page and task shares, the board share and public links receive it for their item (`shareSees` in `lib/sse.ts`).

## 7. The Hub

- **Share** buttons on pages, tasks, diagrams, plot spaces, skills, meeting notes, the board, the workspace tab and Code (in a task peek's header next to close; top right on full pages). A space is shared from the space switcher (**Share ‹space›…**) and Settings › Sharing. The dialog (`share-dialog.tsx`) searches people as you type, sets roles, lists who has access with each person's link, shows the "1 of 2 members" and "3 of 5 contacts" meters, and says what stays private. Role menus have accessible names ("Access for ‹name›", "Who can open it", "What anyone with the link can do"; `RoleSelect`).
- **Space switcher**: a **Shared with you** section with owner avatars; the open shared space reads "‹name› (shared)", and the top bar says "Shared by Mira Chen · Can edit" in text (`SharedBadge`).
- **In a space shared with you**: no Today, Metrics, Fetch now, personal-desk layout editing, kill switch, Connections or Data settings; the board is home. Viewers get read-only pages, tasks, diagrams and plots. Settings acts on your own account and says so.

Custom boards (`/api/boards*`, `PUT /api/pages/:kind/:id/board`) are space content: viewers may read them; editors may create boards, manage columns/tiles and move pages. They have no individual-board share link. Sharing a page or task does not expose its board directory or allow membership changes. The `board` item-share kind grants task access, not access to custom boards or their standalone pages; organizing a task on a custom board does not revoke its existing task-access grants.
- **`/shared`**: everything shared with you, with a "New" mark until opened, live page and task titles, first-line previews and share dates (`sharing/previews.ts`, batched). The sidebar link appears when there is something.
- **`/shared-by-me`**: searchable items and spaces grouped by person with Remove / Remove access, then public links with Turn off; each asks for confirmation. Settings and the limit dialogs link here.
- **`/shared/[id]`** (outside the Hub shell): the item alone in its usual editor with a `shared` role, a header of who is on it and "Shared by ‹full name› · can edit". Every request carries the share header (`setOpenShare` in `lib/api.ts`), with its own share-scoped event stream; after a reconnect it reloads everything. Page and task editors keep the share they opened under (`withShare`) so the last save on leaving goes to the right place. An address that opens nothing says "Nothing is shared at this link" (or "This was shared with someone else" for another account's share).
- **Settings › Sharing**: contacts (5 slots unless you choose otherwise), **Limits** (contacts and people per space, up to the caps), spaces you share with their members and hand-over, items you shared ("Ben Ito · can edit"; first five, then **Manage all sharing**), shared with you (first five with excerpt, source space and date, then **View all**; open, leave, remove), and public links. Settings › Spaces points here: spaces never share with each other.

## 8. Data

Migration `20261008160000_sharing`: tables `contacts`, `space_members`, `shares`, `space_transfers`; columns `workspace_jobs.runner_account_id`, `assistant_conversations.account_id`, `undo_entries.actor_account_id`, `page_discussions.author_account_id`. Migration `20261008190000_public_links_avatars`: `public_links`, `users.avatar`. Foreign keys to `users` cascade, so deleting an account or space removes its memberships, shares and contacts. The data export includes contacts, memberships and shares.

## 9. Anyone with the link

- **Kinds:** pages, tasks, diagrams and meeting notes (`PUBLIC_KINDS` in `sharing/context.ts`); meeting notes are view only. Never a space, the board, plots, skills, the workspace, code or runs.
- **Roles:** *Can view* or *Can edit*. Edit covers the content (a page's text and title, a task's page, a diagram), never task properties, comments, history restore or the assistant (`LINK_RULES` in `policy.ts`).
- **Limit:** 3 links per account, one per item, made only by the space's owner; allocation locks the account row so parallel requests cannot pass it. At the limit the Share dialog lists current links with **Revoke and continue**.
- **Address:** `/p/<token>` (random, 32 characters), served `noindex, nofollow` (`app/p/[token]/layout.tsx`). *New link* rotates it and turning it off ends it; the old address stops at once. Settings › Sharing › Public links shows how often each was opened.
- **Visitors** without an account get a creature name and emoji from the browser's visitor id (`sharing/visitors.ts`), e.g. "Curious Otter 🦦", shown in avatars and diagram cursors. Signed-in people appear under their own name; the owner opening their own link is simply in their space.
- **Visitors cannot** reach anything else in the space, see comments or who else has access, call a model, create diagrams, leave undo history, or show where else they are. On an edit link, `@ensemble`, `@ask Ensemble`, diagram requests and the mention menu's AI actions open `components/sharing/join-invitation.tsx` (sign up, sign in, or **Keep writing**, which keeps the text and starts no model request).
- **Rate limits** per address: `ENSEMBLE_RATE_LINK_READ_LIMIT` (default 900 a minute) and `ENSEMBLE_RATE_LINK_WRITE_LIMIT` (default 120).
- **Mechanics:** the page sends `x-ensemble-link` and `x-ensemble-visitor` (`setOpenLink` in `lib/api.ts`); `identify()` gives `access: { kind: "link" }` with a `visitor:…` id (never a users row) and the gate applies `linkDecision`.
- **Routes:** `GET /api/links` (yours), `GET /api/links/item?kind=&resourceId=`, `POST /api/links` `{ kind, resourceId, role }` (on or change role; 409 `PUBLIC_LINK_LIMIT` past 3, 400 for other kinds), `DELETE /api/links/:id`, `POST /api/links/:id/rotate`, and `GET /api/links/open` for the link holder (404 once the item is deleted).

## 10. Avatars

Settings › Account › Avatar offers 30 original geometric portraits per profession (10 women, 10 men, 10 gender-neutral; the second five of each group add details such as buns, a head scarf, an afro, a knitted hat, a mustache, earrings or freckles) and five backgrounds (Blue, Green, Peach, Rose, Slate); tops never match the background. Settings shows the set for your sign-up role, your gender group first; an avatar from another set stays until changed. Ids are `role.gender.n` plus an optional background (`vibe.f.7.mint`), drawn as SVG (`packages/shared-types/src/avatars.ts`, `components/avatars/persona.tsx`), stored on `users.avatar` and saved with `PATCH /api/auth/me { avatar }`. Without a background the profession's colour is used; picking that colour saves the id without one. Without an avatar you keep your initials (§5). Avatars show in the top bar, presence, the share dialog, contacts, comments and board cards.

## 11. Not supported

- The CLI, `ensemble mcp`, the Context Bridge and the desktop app do not know about sharing; tokens and service calls always act as the space they belong to.
- Answering a run's question from a phone works only in your own spaces.
- Live editing of meeting notes, and live pages across more than one API process.
