# 29 · Sharing

People can share an Ensemble space, or one item in it, with other people who have an Ensemble account. A shared space is still the owner's: the work in it is shared, and everything private to the owner stays private. That covers their settings, model keys, connected apps, computers, Today and metrics. Single items (a page, a diagram, a plot space…) open on their own, without the rest of the space. A few harmless items can also be opened by **anyone with the link**, no account needed (§9).

The rules are enforced in `apps/hub-api/src/sharing/`. The Hub side is `apps/hub-web/components/sharing/`, `app/(hub)/shared`, `app/shared/[id]`, and Settings › Sharing (`components/settings/tab-sharing.tsx`).

Checked 8 Oct 2026, with the HTTP suite (`src/sharing/sharing.integration.test.ts`, `src/sharing/policy.test.ts`), after an independent code review whose eight findings are fixed and covered by tests. Also walked through in the browser with three accounts and a second person live on the same diagram and page.

Standalone notes in Trash are unavailable to shared members and item/public-link readers (`resourceTitle` in `apps/hub-api/src/sharing/store.ts` and `pages/store.ts` check `deletedAt`). Restore returns the same note and retained sharing records. Checked 9 Oct 2026 with the in-memory HTTP resource suite; these checks do not create a new share in a hosted account.

## 1. What can be shared

| | Whole space (members) | One item (shares) |
|---|---|---|
| Who | Up to **2** people per space, so 3 with the owner | Any of your contacts |
| Kinds | Everything in the space except the private list below | `page`, `task`, `board`, `diagram`, `plot_space`, `plot`, `meeting`, `skill`, `workspace` (the agent workspace tab), `code` |
| Roles | `viewer` (reads) or `editor` (reads and writes) | `view` or `edit`. `meeting`, `workspace` and `code` are always view-only (`VIEW_ONLY_KINDS` in `policy.ts`) |
| Opens at | The space switcher, under **Shared with you** | `/shared/<shareId>`, a link that only opens for its recipient |

Never shared, even with a whole-space member: Today, metrics, settings, model keys, connected apps (connectors, MCP connections, imports), reminders, the terminal, editor tokens, paired computers, the kill switch, trash and data deletion. Runs, Needs me, metrics and settings cannot be shared on their own either.

**Context is shared, the owner's inbox is not.** Members see the space's people, projects, repos, meeting notes, documents, and work artifacts (files, pull requests, issues, commits, transcripts). Communications the owner's connected apps synced in (email, chat and channel messages, calendar events: `PRIVATE_ARTIFACT_KINDS` in `sharing/context.ts`) are left out of every list, search, graph and assistant answer a member can reach, and so is the connectors' sync state. Tasks proposed from those messages are the space's work and stay visible. Members read the shared items in Files → From your apps (`GET /api/artifacts`, `GET /api/artifacts/:id`, class `shared`); only the owner can remove one (`DELETE /api/artifacts/:id` is unlisted, so owner-only).

**Contacts.** Everyone you share with becomes a contact; you can have **5** (`MAX_CONTACTS`). Sharing with a sixth person is refused until you remove someone. Removing a contact takes back everything you shared with them at once, in every space you own: their memberships and their item shares (`removeContact` in `store.ts`).

**Ownership transfer.** The owner of a space they created (not the first space, which is their account) can hand it to one of its members, **once** per space (`space_transfers` has a unique `space_id`). The content moves. The old owner's connected apps, model keys, devices, API tokens, settings, sync state and synced communications are removed from it, and the new owner's settings are copied in. Chats, comments and runs keep their author: the old owner's become theirs by name, and the new owner's become the owner's. Undo history is cleared. The old owner stays on as an editor. Item shares from that space are deleted. It is refused while an agent run is queued or active, and when the new owner has no contact slot left for the old owner.

**Losing access takes effect at once** (`sharing/revoke.ts`): their open event streams on the space close, a ticket made before cannot open a new one, they leave the presence room, and runs they queued on their computer there are cancelled. Their computer can no longer claim or report on runs in a space they left (`stillMember` in `devices/routes.ts`). Every stream on a space closes after a transfer, so everyone reconnects under their new role.

Someone with the item open sees it straight away. The closed stream (its last frame is `sharing.changed`), a refused ticket, or live steps (§5) answered with 404 `SHARE_GONE` or 403 make `/shared/[id]` (or `/p/[token]`) ask again what the share opens (`useShareLive` and `useRecheck` in `components/sharing/shared-viewer.tsx`). When it is gone, the item stays on screen read-only under "‹owner› stopped sharing this with you…", the stream and presence heartbeat stop, and nothing more is saved. Text typed since the server last confirmed it stays in the editor with **Copy my text** (Markdown) and, for a signed-in recipient, **Save as my own page**, which makes a new page in their own space (`components/pages/kept-edits.tsx`). Checked 16 Oct 2026 with the HTTP test "two people type into a shared page at once" (`apps/hub-api/src/pages/collab.integration.test.ts`: steps after the share is removed get 404 `SHARE_GONE`); not walked through in a browser.

The limits are constants in `apps/hub-api/src/sharing/store.ts` (`MAX_CONTACTS`, `MAX_MEMBERS`, `MAX_TRANSFERS`).

## 2. How access works

A space is a `users` row (docs/28), and every record is scoped by that row's id. Sharing keeps that: a member's or recipient's request runs **as the space** (`request.userId` = the space) while `request.accountId` is the person. `request.access` says how they got in:

| `access.kind` | Set by | Meaning |
|---|---|---|
| `owner` | your own spaces (default) | No restriction |
| `member` | the `ensemble_space` cookie naming a space in `space_members` for you | `role` viewer or editor |
| `share` | the `x-ensemble-share: <shareId>` header, for a share whose recipient is you | One item, `role` view or edit |
| `gone` | a share header that is not yours or no longer exists | Every request gets 404 with `code: "SHARE_GONE"` |

`identify()` and `inSpace()` in `apps/hub-api/src/lib/auth.ts` resolve this; `openableSpace()` in `spaces/store.ts` checks the cookie. Tokens, CLI keys and service calls never read the cookie or the header.

Every request then runs inside an `AsyncLocalStorage` scope (`sharing/context.ts`, set by the `scopeHook` in `sharing/gate.ts`). Code deep in the stack uses it without being passed the request:

- `keysFor(userId)`: whose model keys, settings, pacing, activity panel and metrics apply. For a member or recipient that is their own account, never the owner's.
- `actorFor(spaceId)`: the person acting when it is not the owner. Stamped on undo entries, comments, assistant conversations, ledger entries (`payload.byAccountId`) and jobs (`runner_account_id`).

### The route policy

`sharing/policy.ts` classes every route, and the `sharingGate` pre-handler enforces it for anyone who is not the owner. **Unlisted routes are owner-only**, so a new route is never opened by accident. `policy.test.ts` checks that every route in `scripts/route-inventory.json` has a class and that every share rule names a real route.

| Class | Member | Examples |
|---|---|---|
| `shared` | viewers GET only, editors anything | tasks, pages, comments, projects, diagrams, plots, skills, meeting sessions, context reads and the live Context tiles (`/api/desk/live`, without reminders or the inbox), undo/redo, people |
| `personal` | runs on their own account | settings, model keys, models, notifications, metrics, activity, devices list and pairing |
| `assistant` | allowed, with their own keys; viewers cannot apply writes | `/api/assistant/*`, `/api/ask`, inline @ensemble |
| `runner` | editors; the handler limits it to the runner | assign, stop, retry, answering a run's question |
| `prefs` | the handler decides per key | `ui.*` is yours, `desk.*` is the owner's, other keys are context editors may change |
| `self`, `live`, `open` | always | auth, spaces, sharing, events, presence, catalogues |
| `owner` (default) | 403 "Only ‹owner› can do this in their space." | connectors, imports, Today, reminders, terminal, tokens, layouts, code changes, approvals, data deletion |

Single items use `SHARE_RULES`: each kind lists the routes it may call and which parameter (or query or body field) must be the shared item's id. A shared plot space may also read the datasets its tiles use, and nothing else.

## 3. What stays private, and how

- **Workspace search** (`GET /api/context/search`): shared-space readers search the active space, respecting the existing artifact visibility and deleted-item filters. Single-item shares cannot use this workspace-wide endpoint. It is classed as `shared` through the `/api/context/*` GET rule.
- **Settings** (`lib/settings.ts`): `loadSettings` and `saveSettings` resolve to your account in someone else's space, so the theme, models, assistant tone and page width are yours. `/api/auth/me` and `/api/shell` report your own account, not the owner's.
- **Model keys and verification** (`lib/runtime.ts`, `lib/model-turn.ts`): every model call sends your account to the runtime. The Python runtime only uses that id for keys, pacing and host access, never for data.
- **Connected apps** (`assistant/apps.ts`): the assistant offers no connected-app tools, reminders, syncs or repository links in a space shared with you (`guestMayUse`), so it can never read the owner's mail. Its prompt says whose space it is and that their apps are private (`assistant/state.ts`).
- **Assistant chats**: conversations carry `account_id`; each person lists and opens only their own. Streaming frames go only to the person who asked. `hub_list_due` leaves the owner's reminders out, inline asks about Today or Needs me are refused (`/api/ensemble/invoke`), and a shorthand question like "mock 7/10" never writes to the owner's desk (`askEnsemble`).
- **Preferences** (`routes/context.ts`): `ui.*` keys (your shortcuts) are stored on your account; `desk.*`, `hub.*` and `hosted.*` are the owner's alone; editors may change the other context preferences. `hub.settings` is never written or deleted as a preference by anyone.
- **Undo** (`lib/undo.ts`): one history per person per space (`undo_entries.actor_account_id`). You undo your own changes, never someone else's.
- **Comments** carry their author (`page_discussions.author_account_id`) and show their name. You edit and delete your own; the owner may delete any.
- **Needs me**: questions from the owner's own editors (Cursor, Claude Code…) are never shown to members, and their event frames reach only the owner (`ownerOnly`).
- **Events** (`lib/sse.ts`): every listener records who it is. Actor frames (`assistant.frame`, `assistant.acted`, `undo.changed`) go to the person acting. Owner frames (`reminder.due`, `sync`, `device`) go to the owner only. A single shared item hears only frames about that item. Someone working in another space still gets their own `sharing.changed` and `notification` frames on a second, account-only channel.
- **Directory search** (`GET /api/sharing/people`): matches names, account emails and the emails of linked Google, GitHub and Microsoft sign-ins. Results never include spaces or you, and on hosted only verified accounts. Emails are masked (`ak••••••e@gmail.com`) unless you typed that exact address. Each account gets 40 searches a minute.

## 4. Agent runs in a shared space

A member who assigns a task to the agent runs it **on their own computer**:

- The assign dialog lists only their own paired computers (`GET /api/devices` is personal). The server's runner is the owner's and is refused for members (`workspace/assign.ts`).
- The job lives in the shared space (`workspace_jobs.user_id`) and records the runner (`runner_account_id`). Their computer claims it (`devices/routes.ts`, `runsOn`), and it counts against their daily quota (`createCappedJob`).
- Everyone in the space sees the run, its log and its code. Only the runner sees which computer it is: others get `deviceName: null`, `yours: false`, and the Hub shows "Ben Ito's computer", with the runner's full name (`lib/runner.ts`, `components/agent/job-card.tsx`).
- Only the runner can stop it, run it again, or answer its questions in Needs me. The owner sees the question with a lock. The runner gets the notification, and its link opens the shared space (`?openSpace=`). The owner's kill switch and stop-all skip runs on other people's computers.
- Code stays view-only for everyone but the owner: all `/api/code` writes, the terminal, and approving hosted runs are owner-only.

### Tasks with a person

In a space with members, a task whose owner is `me` can be with any one person: the owner or a member. The task page's Owner menu lists them; picking one sends `assignee` (an account id) and the server stores it in `tasks.assignee_account_id`, or null for the space's owner (`resolveAssignee` in `services/tasks.ts`). Anyone else is refused with 400. `owner: "me"` without an assignee means the person acting, so a member's "Me" is that member. Handing a task to the agent or leaving it unassigned clears the person. Board cards show it relative to whoever is looking: **Me**, **Agent**, or the other person's initials. Checked 9 Oct 2026 by `sharing.integration.test.ts` ("tasks in a shared space").

## 5. Live presence

`POST /api/presence` (heartbeat every 15 s, on every route change, and while typing, moving on a diagram, or moving the text cursor on a page someone else has open) and `GET /api/presence` keep an in-memory room per space (`sharing/presence.ts`). Production runs one API process, like the event stream. Entries expire after 45 s; closing a tab sends a `leave`. Each person has a fixed colour. Presence is only sent when the space has collaborators (`shell.space.collaborators`).

- **Top bar**: up to four avatars of who is here, then a "+N" chip whose hover text names the rest (`PresenceStack` in `components/sharing/people.tsx`). Clicking them opens **Here now**: focus moves into the list, the arrow keys and Tab move between its buttons, and Esc closes it and puts focus back on the avatars. Each row says where the person is; clicking the row (it reads *Go to*) takes you there, and **Follow** keeps you with them. Following frames the window in their colour, shows "Following ‹full name› · Stop · Esc", goes wherever they go and, on a diagram, centres on what they look at. It stops on Esc, when you navigate yourself, or 10 s after they leave. It only follows people working inside this space: someone who opened one shared item (or a public link) sends only that item, never a route, so their row says "On the shared page", *Go to* opens that item in this space (`hrefOf` in `lib/presence.ts`), and an info mark explains why there is no Follow. Someone working in their own space is not here at all.
- **Pages, tasks, diagrams, the board**: the same avatars and "+N" chip for the people on that item, with "‹full name› is editing…" while they type ("‹name› and ‹name› are editing…" for two). Clicking the avatars lists everyone on the item, with the same keyboard handling (`page-people.tsx`).
- **Diagrams**: everyone's cursor, live, in diagram coordinates, labelled with their full name (`live-cursors.tsx`).
- **Names and initials**: people are named in full wherever they are named (presence, "Shared by", Settings › Sharing, `/shared`), because first names alone are often the same. Initials follow one rule in the API and the Hub, `personInitials` in `packages/shared-types/src/avatars.ts`: the first letter or digit of the first and last words ("Test Five" → TF, "Test 3" → T3), or the first two of a one-word name. In a row of avatars, two different names that would read the same get one more letter of the last word (`distinctInitials`: "Test Two" TTw, "Test Three" TTh). Overlapping avatars keep a gap in the page colour so initials stay readable. Checked 15 Oct 2026 with `lib/initials.test.ts`, `lib/presence.test.ts` and `components/sharing/page-people.test.tsx`; not walked through in a browser.
- **Pages and task pages, edited live** (built 16 Oct 2026): like Google Docs, everyone on a page edits one live document and sees the others' typing as it happens. It is ProseMirror's central-authority collaboration: `prosemirror-collab` in the editor (`components/editor/collab.ts`, `components/pages/use-collab.ts`) and one authority per open page in the API process (`apps/hub-api/src/pages/collab.ts`, `collab-core.ts`), in memory like presence. Every change is a step; the server numbers them (`version`). The editor sends your steps about every 60 ms while someone else is on the page and every 250 ms when you are alone, one request at a time. If someone else's steps got in first, the server answers 409 with what you missed, your steps are rebased over them in the editor and sent again, so two people typing at the same spot both keep their text and never interleave letters. Everyone's steps, yours confirmed, arrive over the event stream as `page.steps`. Undo takes back your own typing, never someone else's. Two tabs of the same person are two editors (distinct client ids) and simply work.
- **The server's schema is the editor's.** `packages/shared-types/src/page-schema.json` is the editor's schema as data, written from its TipTap extensions by `pnpm --filter @ensemble/hub-web page-schema`; `components/editor/schema-spec.test.ts` fails when they differ. hub-api builds its schema from it (`src/pages/schema.ts`) and applies the steps exactly as the editors do. After changing an editor extension (a node, a mark, an attribute), run that command and commit the JSON.
- **Saving**: the authority writes the page back through the page store 0.8 s after the last step, and at least every 3 s while steps keep coming (`writeCollabPage` in `pages/store.ts`: next revision, mention index, search text, under the same row locks as the other writers), then publishes the usual `page` event with `by: "collab"`. "Saving…" shows while you have steps the server has not confirmed, "All changes saved" once it has. Pending write-backs are flushed when the API shuts down (`onClose` in `routes/collab.ts`). Pages nobody touched for 15 minutes are written back and dropped from memory; an editor still open on one is moved to the reloaded page as below.
- **Writes from elsewhere** (the assistant's page tools, an agent's output block, a whole-page `PUT` from a tab still running older code, undo, attaching a file): every writer publishes a `page`, `task` or `undo.changed` event after it commits, and the authority then reads the stored copy again. A copy that changed is taken in as server steps: the difference from the copy it last wrote, as small steps (`page-diff.ts`, a copy in hub-web and hub-api kept identical by `page-diff.test.ts`), moved over the steps typed since. When a move would not fit or would delete text typed meanwhile, the change is three-way merged instead (`mergeDocs` in `packages/shared-types/src/page-merge.ts`: block by block, then word by word; both versions stay where both rewrote the same words). A write-back also re-reads the copy under its lock first, so it never overwrites such a write. Undo of a page's content now locks the row and moves its revision on.
- **Offline, expired sessions, restarts**: when the server cannot be reached, your steps stay in the editor, the status says "Offline — your changes will sync when you're back", and they are sent again with backoff and as soon as the browser is back online. Until the server has them, unsent typing is also kept as a draft in this browser (`localStorage`, per account and page), written at most once a second, on leaving the page, and just before an expired session sends the tab to sign in (`SIGNED_OUT_EVENT` in `lib/api.ts`). The next time the page opens, the draft's changes are moved onto the current page and a toast says so. When the server's live page started over (the API restarted, or you fell further behind than its last 1,000 steps: 410 `COLLAB_RESET`), the editor loads the fresh page and proposes your unsent changes again the same way. After the event stream drops, when the tab comes back and when the browser comes back online, the editor fetches the steps it missed.
- **Who may**: joining and receiving needs view access, sending steps needs edit access, by the same rules as reading and saving the page (`/api/pages*` and `/api/tasks*` are `shared`; single shares, the board share and public links list the collab routes in `policy.ts`). Public links use it too: a view-only link follows along, an edit link types live, sending at most about once a second to stay under the link's write limit (§9). A share removed while open stops accepting steps at once (404 `SHARE_GONE`), and the text stays on screen as in §1.
- **Carets**: on pages and task pages, the other people's text cursors and selections show in their colour with their full name (`RemoteCarets` in `components/editor/remote-carets.tsx`). Presence carries `caret: { anchor, head, version }`, sent at most every 0.3 s, only while someone else is on the page, and only once your own typing is confirmed. The receiver maps it from that version through the steps since, so it sits exactly where the person is; incoming steps move it along. A caret is dropped when its person moves to another item, and moving it does not end their "is editing…" pulse.

Checked 16 Oct 2026: `components/editor/collab.test.ts` runs three real block editors (the page's TipTap extensions) against the hub-api authority with random network delays (typing, Enter, deletes and Undo at the same spot; a tab offline; the server restarting three times mid-typing; writes from elsewhere; a session expiring with unsent typing; carets) and checks every editor and the written-back page end identical with every typed word present once. `src/pages/collab.test.ts` covers the authority (409 rebase, gaps, reloads, write-back timing, retries, external writes), `src/pages/collab.integration.test.ts` two people on a shared page and a task page over HTTP. Not walked through in a browser with two accounts.

**Not covered:** meeting notes still save whole documents without a revision, so there the last save wins (`notes-fields.tsx`, read in the code). If the API process dies without shutting down (a crash, not a deploy), up to about 3 s of typing the server had confirmed but not written back is lost from the server; the editors that typed it keep it on screen and in their draft only while it is unconfirmed. One API process holds the live pages; running several would need them shared.

## 6. Routes

All under browser sessions only (`requireBrowserSession`); tokens get 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sharing/people?q=` | Directory search (§3) |
| GET | `/api/sharing/overview` | Limits, contacts, your spaces with members, items you shared, shared with you |
| GET/POST | `/api/sharing/contacts` | `{ personId }`; 409 at 5 |
| DELETE | `/api/sharing/contacts/:id` | Removes and takes back everything → `{ removed: { spaces, items } }` |
| GET | `/api/sharing/with-me` | `{ spaces, items }` |
| GET | `/api/sharing/spaces/:id/members` | Owner and members may read |
| POST | `/api/sharing/spaces/:id/members` | `{ personId, role }`; owner only; 409 at 2 |
| PATCH/DELETE | `/api/sharing/spaces/:id/members/:personId` | Change role / remove. A member removing themself leaves |
| POST | `/api/sharing/spaces/:id/transfer` | `{ toId, confirmation: "‹space name›" }`, once |
| GET | `/api/sharing/items?kind=&resourceId=` | Who has one item (owner of the open space) |
| POST | `/api/sharing/items` | `{ kind, resourceId, personId, role }` from the open space |
| PATCH/DELETE | `/api/sharing/items/:id` | Owner changes or removes; the recipient may remove it from their list |
| GET | `/api/sharing/open/:id` | What a share opens, for its recipient; marks it opened. 404 `SHARE_NOT_YOURS` when the share is another account's, `SHARE_NOT_FOUND` when there is none at that address. A removed share's row is deleted, so a wrong address and a removed share get the same answer. The Hub sends this without the share header |
| GET/POST | `/api/presence` | §5. POST takes `tabId` and optional `route`, `resource`, `cursor`, `viewport`, `caret` (`{ anchor, head, version? }`), `typing`, `leave` |

Adding someone sends them a notification and a live `sharing.changed` frame. Removing them, or deleting a space, sends the frame too: their open tab returns them to their own space with a message.

Also new: `GET /api/skills/:id`.

Live co-editing (§5) is not a sharing route but follows the same classes: `GET/POST /api/pages/:id/collab` and `GET/POST /api/tasks/:id/page/collab` (`routes/collab.ts`). `GET` answers `{ epoch, version, doc, revision }`; `GET ?epoch=&version=` the steps since that version, `{ epoch, from, version, steps, clientIDs }`; `POST { epoch, version, clientID, steps, flush? }` the steps from `version` on, yours included (with `revision` after `flush: true`, which writes the page back first). Refusals: 409 `COLLAB_BEHIND` (with the steps you missed), 410 `COLLAB_RESET` (load the page again), 400 `COLLAB_REJECTED`, 413 `COLLAB_TOO_LARGE`. Steps also go out on the event stream as `page.steps` `{ kind, id, taskId?, epoch, from, version, steps, clientIDs }`; a single page or task share, the board share and public links receive them for their item (`shareSees` in `lib/sse.ts`).

## 7. The Hub

- **Share** buttons: pages, tasks, diagrams, plot spaces, skills, meeting notes, the board, the workspace tab and Code. On a task peek the Share icon sits in the header next to close; on full pages it is at the top right. The space itself is shared from the space switcher (**Share ‹space›…**) and Settings › Sharing. The dialog (`share-dialog.tsx`) searches people as you type, sets the role, lists who has access with each person's own link, shows the "1 of 2 members" and "3 of 5 contacts" meters, and explains what they get and what stays private.
- **Space switcher**: a **Shared with you** section with the owner's avatar; the open shared space reads "‹name› (shared)", and the top bar says "Shared by Mira Chen · Can edit" in text, without a second avatar of the owner next to their live one (`SharedBadge`).
- **In a space shared with you**: no Today, Metrics, Fetch now, layout editing, kill switch, Connections or Data settings; the board is home. Viewers get read-only pages, tasks, diagrams and plots. Settings acts on your own account and says so.
- **`/shared`**: everything shared with you, with a "New" mark until opened. The sidebar link appears when there is something.
- **`/shared/[id]`** (outside the Hub shell): the shared item on its own, using the same editors with a `shared` role. Its header shows who is on the item and "Shared by ‹full name› · can edit" as text. Every request from the page carries the share header (`setOpenShare` in `lib/api.ts`), and it opens its own event stream scoped to the share; after the stream drops and comes back, it reads everything again. Page and task editors remember the share they opened under (`withShare`), so the last save on leaving goes to the right place. An address that opens nothing says "Nothing is shared at this link" (check the link; if it opened before, the owner stopped sharing it), or "This was shared with someone else" for another account's share. A share removed while open is §1's "Losing access".
- **Settings › Sharing**: contacts (5 slots), spaces you share and their members, hand-over, items you shared ("Ben Ito · can edit"), and shared with you (open, leave, remove). Settings › Spaces points here: spaces never share anything with each other, and a space is shared with people only from here, the space switcher or a Share button.
- **Share dialog** role menus have accessible names ("Access for ‹name›", "Who can open it", "What anyone with the link can do"; `RoleSelect`).

## 8. Data

Migration `20261008190000_public_links_avatars` adds `public_links` and `users.avatar`. Migration `20261008160000_sharing`: tables `contacts`, `space_members`, `shares`, `space_transfers`; columns `workspace_jobs.runner_account_id`, `assistant_conversations.account_id`, `undo_entries.actor_account_id`, `page_discussions.author_account_id`. Every foreign key to `users` cascades, so deleting an account or a space removes its memberships, shares and contacts. The data export includes your contacts, memberships and shares.

## 9. Anyone with the link

Built 8 Oct 2026; checked with `src/sharing/links.integration.test.ts` and in the browser.

- **What can be public:** pages, tasks, diagrams and meeting notes (`PUBLIC_KINDS` in `sharing/context.ts`). A whole space, the board, plots, skills, the workspace, code and runs never: they reach other people's data, computers or code. Meeting notes are view only.
- **Roles:** *Can view*, or *Can edit*. Edit means the item's content (a page's text and title, a task's page, a diagram), never a task's properties, comments, history restore or the assistant (`LINK_RULES` in `policy.ts`).
- **Limit:** 5 public links per account for now (`MAX_PUBLIC_LINKS` in `sharing/links.ts`). One link per item. Only the space's owner makes them.
- **The address** is `/p/<token>` (a random 32-character token). The page sends `noindex, nofollow` (`app/p/[token]/layout.tsx`), so a link posted somewhere public does not turn up in search results. *New link* gives the item a new address and the old one stops working at once; turning the link off does the same. Settings › Sharing › Public links lists them with how often each was opened.
- **People without an account** get a creature name and emoji from the browser's visitor id (`sharing/visitors.ts`), for example "Curious Otter 🦦". Everyone on the item sees them in the avatars and, on a diagram, their cursor. Signed-in people opening someone's link appear under their own name; the owner opening their own link is simply in their space.
- **What a visitor can't do:** reach anything else in the space, see comments or who else it is shared with, call a model, leave undo history, or show where else they are. Requests are counted per address (`ENSEMBLE_RATE_LINK_READ_LIMIT`, default 900 a minute, and `ENSEMBLE_RATE_LINK_WRITE_LIMIT`, default 120).
- **How it works:** the page sends `x-ensemble-link` and `x-ensemble-visitor` headers (`setOpenLink` in `lib/api.ts`). `identify()` resolves them to `access: { kind: "link" }` with the visitor's own id (`visitor:…`, never a users row), and the gate applies `linkDecision`.
- **Routes:** `GET /api/links` (yours), `GET /api/links/item?kind=&resourceId=`, `POST /api/links` `{ kind, resourceId, role }` (turn on or change role; 409 past 5, 400 for a kind that can't be public), `DELETE /api/links/:id`, `POST /api/links/:id/rotate`, and `GET /api/links/open` for whoever holds the link.

## 10. Avatars

Everyone can pick a picture avatar in Settings › Account › Avatar: 15 per profession (5 women, 5 men, 5 gender-neutral) for engineers, lawyers, teachers, students, managers and makers. Settings shows only the set for the role chosen at sign-up, with your profile's gender group first; an avatar picked earlier from another set stays until you change it. They are drawn as SVG from their id (`role.gender.n`, `packages/shared-types/src/avatars.ts`, `components/avatars/persona.tsx`), stored on `users.avatar`, and saved with `PATCH /api/auth/me { avatar }`. Without one you keep your initials, made by the one rule in §5 (`personInitials`). Avatars show in the top bar, presence, the share dialog, contacts, comments and board cards.

## 11. Not covered

- The CLI, `ensemble mcp`, the Context Bridge and the desktop app do not know about sharing. Tokens and service calls always act as the space they belong to, never as a guest.
- Answering a run's question from a phone (remote answers) works for your own spaces only.
- Live co-editing of meeting notes; live pages held by more than one API process (§5).

Page bulk deletion (15 Oct 2026): `POST /api/pages/delete-many` is in the existing **shared** space route class (`src/sharing/policy.ts`, `/api/pages*`). It needs space edit access; single-item and public-link grants do not include this route. `pages/store.ts` validates every selected id and scopes descendant traversal to the same space. The batch and descendants share one Undo entry. Device attachment downloads remain in the device route class and require the assigned device and active job lease.
