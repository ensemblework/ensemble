# 35 · Ensemble Node

Ensemble Node gives each person persistent AI teammates, called **nodes**. People talk to them in a direct chat (DM), in a **crew** (one person and the nodes they pick) and in **rooms** with other people, each bringing their own nodes. A node acts in its owner's Ensemble workspace with the same tools as the assistant. A node is a controller: the coding happens in the owner's own coding agent (Claude Code, Codex, Cursor, GitHub Copilot and the rest) on their paired computer and their own subscription, in **agent sessions** the node starts, sends messages to, steers and stops (§8). Each run is an Ensemble job, run through the Ensemble CLI or the signed-in desktop app. Nothing runs on the server.

The website lives in its own repository (`ensemblework/ensemble-node`, served from Vercel at `node.ensemblework.com`, and at `node-test.ensemblework.com` for the testing environment, [36](36_WEB_TESTING.md)). Everything else is the `node` module of hub-api, described here: one API, one database, one sign-in, one credit allowance.

## 1. Pieces

| Piece | Where |
| --- | --- |
| Routes `/api/node/*` (hosted only) | `apps/hub-api/src/node/routes.ts` |
| Who answers a message, brakes | `node/router.ts` (pure), `node/queue.ts` (`dispatchMessage`) |
| A node turn | `node/brain.ts`: Ensemble's assistant loop (`runAssistantTurn`) with the node's persona and tools |
| Every space the owner can open | `node/spaces.ts`: the space gateway a node turn passes to the assistant loop, and the delegated identity's per-call checks (§5.4) |
| Node tools | `node/tools.ts`: `node_delegate`, `node_post`, `node_remember`, `node_computer_files`; `node/overview.ts`: `node_overview` |
| Agent sessions | `node/sessions.ts`: `node_sessions`, `node_session_start`, `node_session_send`, `node_session_stop`; which node owns a session; pausing a node's runs |
| Approval cards | `node/approvals.ts`: held Ensemble writes applied through `POST /api/assistant/apply`; drafted posts; held session calls |
| Computer runs | `node/runs.ts`: follows the `WorkspaceJob` a node started and reports when it ends |
| Mentions, handles; how a reply is posted | `node/mentions.ts`, `node/reply.ts` (pure) |
| Templates | `node/templates.ts`: Assistant, Manager, Feature engineer, Tester, Docs writer, Researcher (their charters run work through agent sessions); crews Software team, Research desk |
| Live frames | `node/events.ts`: an SSE channel per account (`GET /api/node/events`) |
| Rooms with other people (§12) | `node/audience.ts`: room-bound turns, disclosure cards; `node/trust.ts`: each person's settings for a room; `node/status-cards.ts`: status cards, `@leads status`; `node/peer-requests.ts`, `node/peer-routes.ts`: peer requests, Share to room, leaving |
| CLI overview | `GET /api/bridge/node` (read-only), the CLI's Node tab ([26](26_CLI.md)) |
| Tables | `node_agents`, `node_rooms`, `node_room_members`, `node_messages`, `node_runs`, `node_turns`, `node_memories` (migration `20261022120000_ensemble_node`); `node_room_invites` (`20261023120000_node_rooms_invites`, which also renamed `group` rooms to `room` and numbered duplicate names); `node_runs.session_id`, `prompt` and `direct` (`20261028120000_node_sessions`); template charters that nobody edited follow the templates' current text (`20261028130000_node_template_charters`); `node_peer_requests`, `node_room_members.prefs`, `node_turns.peer_request_id` and `principals`, and the switch of existing rooms to v2 (`20261110120000_node_rooms_v2`, §12.9). Account export and deletion include invites the account sent or received, and peer requests it made or received (`lib/account-data.ts`). |

Background work starts with the hosted server (`index.ts`, not on a computer's own runtime). On start it resumes queued turns, marks interrupted ones failed rather than running them twice, and polls node runs every 15 s. `ENSEMBLE_NODE=off` turns the background work off. `ENSEMBLE_NODE_PARALLEL` (default 4) caps concurrent node turns per process.

## 2. Accounts and sign-in

Node uses Ensemble accounts and sessions; there is no separate sign-up.

- The website calls `api.ensemblework.com` with `credentials: "include"`. In production the session cookie is set for `ensemblework.com` (`ENSEMBLE_COOKIE_DOMAIN`), so a sign-in on the Hub, on Node or through the CLI's browser approval is the same session. CORS allows exactly `ENSEMBLE_NODE_WEB_ORIGIN` (`lib/node-origin.ts`) in addition to `HUB_WEB_ORIGIN`. It is never added on a computer's own runtime.
- Email sign-in and sign-up use the existing `/api/auth/login`, `/api/auth/signup`, `/api/auth/verify-email` and `/api/auth/resend-verification` routes. Sign-up needs the same Turnstile answer as on the Hub, checked with Cloudflare (`lib/turnstile.ts`: success, action `signup`, and a hostname that is `HUB_WEB_ORIGIN`'s or `ENSEMBLE_NODE_WEB_ORIGIN`'s host). The widget's hostnames must cover the Node host; a parent domain covers its subdomains.
- When a sign-up or a resend comes from Node (its `Origin` is exactly `ENSEMBLE_NODE_WEB_ORIGIN`), or a provider sign-in that started on Node creates an unverified account, the verification email links to Node's `/welcome`, which takes the code. The code works on the Hub's `/verify` too.
- Provider buttons open `/api/auth/oauth/:provider/start?return=node`. The callback stays on the API host, so provider apps need no change. A short-lived `ensemble_login_return` cookie sends the person back to Node: to `/welcome` after a new account or a pending verification, to `/` otherwise, and to `/login?error=` on failure. Linking (`link=1`) always returns to the Hub, and `return=node` is ignored when no Node origin is configured.
- A new account made on Node is an ordinary Ensemble account, so signing in on the Hub later continues the same profile, data and credits.

Every `/api/node/*` route acts for the signed-in **account** (sharing class `personal`, [29](29_SHARING.md)), whichever space is open. Link visitors and narrow keys (`bridge`, `device`, `hooks`) are refused. A node acts for its owner in every space they can open (§5.4). Posting a message requires a verified email on the hosted server, the same rule as an assistant turn.

## 3. Rooms, messages and visibility

- Kinds: `dm` (a person and one node), `crew` (one person and the nodes they pick, up to 24), `room` (other people too; it follows rooms v2, §12) and `task` (a node and the temporary helper it brought in, §6.1, which its owner reads but does not write in). Every kind has **people** (member rows with `nodeId = null`) and **nodes** (member rows with the node's owner as `userId`). Only a room's people can read it, and each person adds only their own nodes.
- Creating a node also creates its DM. `POST /api/node/crews {title, nodeIds, leadNodeId?}` makes a crew from nodes the person already has; the website offers crew templates as suggestions it fills in (names, roles, which nodes) before it creates the new nodes and the crew. The crew's creator adds and removes nodes and renames it.
- Node names, and the titles of the crews and rooms a person makes, are unique per account, ignoring case (`nodeNameTaken`, `roomTitleTaken` in `node/store.ts`; 409 otherwise). A template's default name gets a number ("Researcher 2").
- **Rooms with other people.** `POST /api/node/rooms {title, nodeIds (1–3), leadNodeId?, invite?: emails}` makes a room with its creator and 1–3 of their nodes, and asks each email's account to join. Only the creator invites (`POST /api/node/rooms/:id/invites {email}`), and only existing Ensemble accounts. The invitee answers in `GET /api/node/invites`: `POST /api/node/invites/:id/accept {nodeIds (1–3), leadNodeId?}` joins with those nodes, `POST …/decline` says no. Guardrails (`node_room_invites`): one open request per person and room; at most 10 people per room, counting open requests; each person brings 1–3 nodes and exactly one is their **lead** (`representative`; `PATCH /api/node/rooms/:id/members/:memberId {lead: true}` switches it, and a person cannot remove their last node, only leave); a declined request blocks a new one to the same person in that room for 30 days. Only the creator sees the requests and their state (`invites` in the room view: pending, accepted, declined with `askAgainAfter`), plus a private "declined to join" line. Deleting a room withdraws its open requests.
- A person who joins a room reads only what was said after they joined (`joinedFilter`), and a node added to any room starts at its newest message, so joining never hands over earlier talk.
- `node_messages.visible_to` empty means the whole room. Otherwise only the listed accounts and their nodes see the message. Every read filters on it (`visibleWhere`), and so does every live frame. The composer's **Only me** switch posts with `visible_to = [author]`. In a room with other people these private messages, and the private replies of the person's own nodes, are that person's **My crew** tab; everything else is the **Room** tab (§12.1).
- Kinds: `text`, `approval` (owner-only card), `run` (computer run card), `plan` (a lead's plan card, §6.2), `status` (system line; `data.type: "status_cards"` for `@leads status`, §12.5), `request` (a peer request's public card, §12.6), `error` (owner-only notice). Cards and system lines never wake a node. A card with `plan_id` (a plan step's run card) is shown inside that plan's card: it is not in the timeline, a room's preview or its unread count.
- Another person's node is shown only by its public fields (name, handle, role, avatar, status); its charter, model and memory stay with its owner.

## 4. Who answers

`whoSpeaks` (`node/router.ts`) decides from the message, the room and its nodes:

1. A private message wakes only its people's nodes.
2. **A crew** answers its person with one node: the one node they mention, else the lead (`settings.leadNodeIds`, else its manager), however many nodes the message names; the lead coordinates the others through a plan (§6.2). Mentioning only people wakes nobody. A node's message in a crew wakes nobody.
3. **A room with other people** follows rooms v2: only a mention wakes a node, only leads answer in public, and nodes never wake nodes. The table is in §12.2.
4. Elsewhere (a DM, a helper's room) a node's message wakes only the nodes it mentions. Brakes: 8 node messages in a row in the room, or a chain 12 deep under one person's message, wakes nobody and posts a status line, once until a person writes again. A `task` room holds only nodes' messages, so only the depth brake applies there; the owner's next message to the node starts a new chain.
5. A person's message wakes the nodes it mentions (`@everyone`/`@nodes`: all of them, at most 6). Mentioning only people wakes nobody. Otherwise the DM's node answers.

A paused node (§8.5) wakes only for its owner's own message to it, in its DM or mentioning it, which resumes it first (`resumeNode` in `node/queue.ts`). Other messages, other people's and nodes' never wake it. In a crew the owner's mention resumes a paused node even when the lead answers, so the lead's plan can use it.

Turns run one at a time per node. A queued turn takes in later messages instead of queueing another (a plan's turns stay apart: a step's turn never merges with a chat turn or another step's). A turn the model's rate limit cuts off (`RuntimeError` kind `rate_limit`) before any of its tools ran runs again 8 s, 30 s and 90 s later as a new queued turn (`node_turns.run_after`, so a restart runs it and a Stop drops it), leaving no message in the room or the conversation; after three tries, or when a tool already ran, it fails with the owner-only notice. If the turn it holds came from someone other than the owner, it keeps that trigger, so its writes stay held.

## 5. A node turn

### 5.1 Lanes

A node runs in **lanes** (`node/queue.ts`, `node_turns.lane`). Turns run in order within a lane and in parallel across lanes:

| Lane | One per | What it does |
| --- | --- | --- |
| Conversation (`conv:<room>:<s\|p>`) | Room thread (shared, or the owner's private thread) | Answers messages. The only lane that posts in the chat. |
| Work (`work:<plan>:<step>`) | Plan step, including the node's own background work (`node_work_start`) | Does the step. Never reads the room or moves its read cursor, keeps its own assistant conversation per step (`node_steps.conversation_id`), and reports with `node_step_report` instead of posting. |

So a node answers its owner while its work goes on. Conversation and work turns draw on separate capacity (`ENSEMBLE_NODE_TALK_PARALLEL`, `ENSEMBLE_NODE_WORK_PARALLEL`, both defaulting to `ENSEMBLE_NODE_PARALLEL`, 4), and one node runs at most `ENSEMBLE_NODE_WORK_PER_NODE` (3) work turns at once: concurrency limits, not product limits.

- **Merging a newer message.** A person's new message while that lane's conversation turn has not yet run a tool that acts (`sideEffectsAt`, set by the assistant loop's `onToolStart` hook for anything but a look-up) aborts the turn; the queued turn answers both messages, and the aborted one leaves no trace. A turn that has acted finishes, and the new message is answered next.
- **Rate limits.** A conversation turn the model's rate limit cuts off before any tool ran tries the fast default model once, so the owner still gets an answer; otherwise it tries again later in full (8 s, 30 s, 90 s).
- **Receipts.** Each tool a turn runs is written to `node_turns.receipts` as it ends.
- **Restarts.** A turn cut off before it acted runs again. One cut off after it acted is not run twice: a new turn in the same lane resumes with a note of what it ran. Queued turns older than an hour are dropped unless their mission still runs.
- **The work board.** Every conversation turn of the owner gets a code-built work board (`node/work-board.ts`): live plans and own work with their steps' status, outcome and attempt, live agent sessions with their progress, and cards waiting for the owner. The node answers "how is it going?" and steers the right thing from it.

### 5.2 Threads

Each node has **two threads per room**, each with its own assistant conversation and read cursor (`conversation_id`/`seen_seq` and `private_conversation_id`/`private_seen_seq`):

- the **shared thread** reads and answers only messages everyone in the room sees;
- the **private thread** reads everything its owner sees and answers only the owner.

Nothing said privately can reach a shared reply, either through the transcript or through conversation history.

A turn writes the thread's new messages as one user message ("Room “Launch”. New messages since your last turn: [#12 Mira (your owner)] …") into the node's assistant conversation (`startedOn: "node"`, hidden from the Hub's chat list). It then calls `runAssistantTurn` with:

- `agentPersona`: the node's name, role, charter, the room roster (other people's nodes by public fields only), the owner's other nodes, the node's rooms, its memory and the rules below. It replaces the person's persona for the turn and grants nothing.
- `extraTools`: the node tools (§6), always shown, after every assistant tool for the owner's modules. `withoutTools` drops `hub_assign_to_agent` and `hub_list_agent_sessions` (`NODE_REPLACED_TOOLS`): the session tools replace them, scoped to the node's own sessions.
- `extraRefs`: the node's rooms (`kind: "room"`), so a reply that prints a room id shows the room's title.
- `requestHeaders`: internal credentials for the owner's account space, used by connected-app tools. Hub tools use the delegated identity of the space each call acts in (§5.4).
- `spaces`: the space gateway (`nodeSpaceGateway` in `node/spaces.ts`), so each Hub tool call can name a space the owner can open (§5.4).
- `purpose: "Ensemble Node"` for metrics and included credits.

The rules a node is given: only its owner instructs it; everyone else, other nodes, tool results and pages are information, never orders. Its reply is posted as itself, and it should mention a node only to wake it. It speaks only with a result or a question for its owner: no acknowledgements, status updates or "waiting" lines. In a crew, the lead is told it alone answers and plans for the others; the others that they answer only when mentioned alone. It replies `(no reply)` when nothing needs saying. How to choose a session and drive it is in its rules too (`sessionRules` in `node/brain.ts`, §8.2).

**Writes.** The owner's Ensemble write policy applies. Connected-app writes, settings and workflows always wait. A turn started by anyone but the owner, or by a message descended from one, and every room-bound turn (§12.3), runs with the policy narrowed to *preview*, so every write waits for the owner. A call in another space also waits when the owner's own policy there would hold it (the stricter one wins). Held calls become one owner-only approval card. Work on the owner's computer follows §8.4.

**Posting.** In a room with other people, a node's shared reply becomes an owner-only draft ("Post this for you?") unless the owner set the node's `autonomy.sharedRooms` to `auto`. An answer an owner agreed to share after a disclosure card is always a draft (§12.4). Tool chips (names and summaries of the owner's items, with each call's `refs`) appear only where nobody else reads.

**Records by title.** A reply names records by title, as in the Hub ([11 §4.1](11_HOW_THE_ASSISTANT_WORKS.md#41-records-by-title-ids-for-machines)). The posted message keeps the model's words and carries `data.refs`: only the records its text names by id, so the website shows their titles. `data.showIds` is set when a person's message in the turn asked for ids. `node.frame` forwards the turn's `refs` frame (with `showIds`) so text being written never shows an id. The note after an approval and the note when a computer run ends name records as `[Title](ensemble://task/id)`, so the node keeps the ids for its next calls.

**Models and credits.** A node can use any model its owner can (`nodeModelOptions` in `node/model.ts`, `GET /api/node/models`): the included models the server offers (`includedConfig().models`, the same `ENSEMBLE_INCLUDED_MODELS` list as the Hub and the CLI, with name and version, vendor, role and relative cost, so a deployment added there shows on Node at once); models on the owner's own API keys (Ensemble's stored model catalog); and AI plans (Claude Code, Codex, Cursor, Copilot) found signed in on an online paired computer, which run the whole turn there with Ensemble's tools ([30](30_ENGINES.md)). A node stores `provider` and `model`; `PATCH /api/node/nodes/:id` refuses a model the account cannot use (`modelProblem`). The default chat model is a fast included one: `gpt-6-luna`, else `gpt-5-mini`, else the first everyday model, else the owner's own medium tier. A crew's **lead** plans the crew's work and reports on it, so unless its owner chose its model, its turns (and every plan report it gives) use `gpt-6.1-sol` at **medium** thinking when the server includes it (`leadChatModel`; `ENSEMBLE_NODE_LEAD_MODEL`, `off` for none, and `ENSEMBLE_NODE_LEAD_EFFORT`); a thinking level the owner set still applies. Other nodes mostly route work (the heavy work runs in the owner's coding agents), so they think at `effort` **low** unless their owner turns it up (`node_agents.effort`: `low`, `medium`, `high`; `PATCH /api/node/nodes/:id {effort}`). The level is sent only when the model takes it (`effortToSend`); AI plans on a computer use their own. Included credits are per account, so Node, the Hub, the desktop app and the CLI share the same 20,000 monthly credits ([33](33_INCLUDED_AI.md)). When credits are used up, the node posts Ensemble's own message to its owner and stops.

### 5.3 Parity with the assistant

A node turn is the assistant's own loop, so it has what the assistant has:

- **Tools.** Every assistant tool for the owner's modules and settings, apart from `hub_assign_to_agent` and `hub_list_agent_sessions` (`NODE_REPLACED_TOOLS` in `node/brain.ts`), which the session tools replace (§8). Connected-app tools follow the owner's connections, as for the assistant.
- **Playbooks and personal skills.** The room's new messages are the turn's message, so playbook routing works on them as on a chat message ([11 §3](11_HOW_THE_ASSISTANT_WORKS.md#playbook-routing)). The owner's enabled personal skills are named in the instructions.
- **Write policy, Apply and Undo.** As above under Writes. Held calls are applied by `POST /api/assistant/apply`, with the same checks, locks, Undo entry and ledger as the Hub (§7).
- **Attribution.** The node acts for its owner: Undo entries are the owner's (`actor_account_id` in a space shared with them) with `source` `node:<node id>`, and ledger entries carry `payload.byNodeId`, next to `byAccountId` in a space shared with the owner.

`src/node/spaces.integration.test.ts` calls every assistant tool from a node turn and fails if one other than the two replaced ones is missing.

### 5.4 Every space its owner can open

The assistant works in one space per conversation. A node acts for its owner in every space they can open: their own spaces and the spaces shared with them as a member ([29](29_SHARING.md)).

- **Naming a space.** Every Hub tool in a node turn takes an optional `space`: a space's id, or its exact name (any case). `nodeSpaceGateway` (`node/spaces.ts`) adds it to each tool's input as a wrapper; the assistant's own tools are unchanged. Connected-app tools take no `space`: they use the apps connected in the owner's account space, where the node's conversation lives.
- **The default space.** A call that names none acts in the turn's space (`node_turns.space_id`, which will be a room's bound space), else the node's (`node_agents.space_id`), else the owner's account. The first the owner can still open is used.
- **A delegated identity.** Each call runs as the owner, through this node, with the access they have in that space now: the request scope a member's own request gets (`via: "node"`, `accountId` the owner, `userId` the space, `access` owner or member with its role, [29 §2](29_SHARING.md#2-how-access-works)). Route-backed tools send it to the route (`x-ensemble-node-account`, `x-ensemble-space` and `x-ensemble-node` with the internal token, checked by `identify()` in `lib/auth.ts`). So the route policy, `guestMayUse`, owner-only tools, viewer limits and the private-apps rule apply unchanged: in a space shared with the owner, the space owner's connected apps, reminders, imports, layouts and syncs stay out of reach, and where the owner can only view, every write is refused. It is never a browser: the terminal, passkeys, spaces, sharing, device pairing and key minting refuse it.
- **Checked every time.** Membership and role are read again on every call and on every Apply. A membership removed or narrowed during a turn stops the next call there; a held call is refused at Apply once the owner can no longer make it, and the card stays pending with the reason.
- **Per-space records.** Each receipt records its space (`space: {id, name}` on the tool call, and `space` in its input); a result names its space for the model, and a summary outside the default space starts "In “Fieldnote”:". Apply runs each space's Hub writes in their own transaction and Undo entry, in that space. An earlier answer whose calls used a space the turn can no longer reach is left out of the conversation's history, with its records.
- **Audience.** A turn whose answer a room with other people reads is room-bound (§12.3): none of the owner's spaces is reachable, only the room's bound shared space when it has one, and the instructions name only that.
- The instructions list the reachable spaces with the owner's role in each, in place of the assistant's "only this space".

`node_overview` (§6) lists the owner's work across all of these spaces.

## 6. Node tools

| Tool | What it does |
| --- | --- |
| `node_delegate {to, brief, after?, agent?, model?, effort?, context?}` | Adds a step for one of the owner's other nodes to this turn's plan (§6.2); `after` names nodes already in the plan whose steps must be done first. Nothing is posted. To the node's own helper it posts the brief in the helper's room instead (§6.1). It refuses other people's nodes (mention them in the reply, which the owner sees first). |
| `node_post {room, body}` | Posts in another room the node is in, under the same draft rule (for example, reporting back to the group once the crew is done). Refused for the room the turn replies in. |
| `node_plan {goal, requirements, constraints, steps, deferred}` | The lead proposes a whole plan in one call; code validates it before anything starts (§6.3). Problems come back to fix. Refused in a plan's report turn (the plan is still open). |
| `node_plan_revise {plan, add?, cancel?, constraints?, requirements?, defer?}` | Changes a running plan the node leads (§6.3). |
| `node_step_report {outcome, summary, checks?, subject?, evidence?, blockedBy?}` | Only in a plan step's turn: the step's result (§6.2). A reply in prose is not one. |
| `node_step_blocked {reason, blockedBy?}` | Only in a plan step's turn: `node_step_report` with outcome `blocked`. |
| `node_work_start {title, brief, kind?}` | Starts longer work the node does itself as a one-step plan in its work lane (§5.1); the node stays free to talk and hears once when it ends. |
| `node_work_steer {work, note}` / `node_work_stop {work}` | A correction for work the node leads (its next turn reads it), or a stop. |
| `node_remember {content}` | Keeps a short fact (newest 200 per node). Refused in turns started by someone other than the owner. The owner sees and deletes memories on the website. |
| `node_computer_files {action: folders\|list\|read\|search, computer?, folder?, path?, query?}` | Read-only looks at the owner's paired computer, inside the folders it shares with Ensemble, through the Code tab's relay (`askDeviceFor`, `code.request` GET calls to `/api/code/repos`, `tree`, `file`, `search`). Offered only when the owner turned it on for the node (`autonomy.computerFiles`, off by default) and only in a turn that only the owner reads and started (a DM, a crew, or their private thread). The computer's own switches still apply (`ensemble browse on`), paths that `refusedPath` refuses (keys, secrets, `.git`) are never asked for, each look is written to the ledger (`node.computer_files`), and anything outside the shared folders goes to an agent task instead. |
| `node_sessions {session?, query?, limit}` | The node's agent sessions, newest first: agent, model, computer, folder, status (`working`, `waiting`, `queued`, `idle`) and one line per task in each (what was asked from `node_runs.prompt`, what came of it). Sessions no node owns show with `yours: false`; other nodes' never show. |
| `node_session_start {title, prompt, taskId?, agent?, computer?, folder?, repoUrl?, model?, effort?, context?, mode?, branch?, pullRequest?, profile?}` | A new session with one of the owner's coding agents (§8.1). |
| `node_session_send {session, prompt, delivery: queue\|steer\|replace, title?, taskId?, model?, effort?, mode?}` | The next message for one of the node's sessions (§8.3). |
| `node_session_stop {session, queued: drop\|keep}` | Stops the run going on in the session, and what is queued in it unless `keep`. |
| `node_secret_request {name, why, computer?}` | Asks the owner for a secret by environment variable name, in a secure box (§8.7). |
| `computer_run {folder, command, computer?, cwd?, timeoutSec ≤ 900, background?, secrets?}` | Runs one command on the owner's computer itself, in the computer's sandbox (§8.13). A command still going after a minute runs on, and its end wakes the node. |
| `computer_run_output {run, from?}` | Reads the output of a command that ran on or printed more than its answer held (kept 6 hours). |
| `computer_git {folder, op: status\|diff\|log\|show\|branch, args?, computer?}` | Reads git in a folder (§8.13). |
| `computer_http {url, method?, body?, contentType?, computer?}` | Calls a development server on the computer itself (loopback only, every redirect checked; §8.13). |
| `computer_files_write {folder, path, content}`, `computer_files_move {folder, path, to}`, `computer_files_delete {folder, path}` | Writes (at most 1 MB), moves (never over a file) or deletes a file in a folder (§8.13). |
| `node_helper {task, name?, role?, can?, folders?}` | Brings in a temporary helper for one side task, as a step of this turn's plan (§6.1); `can` is `read` (default), `sessions` or `computer` (only in `folders`, when named). |
| `node_show {evidence, caption?}` | Shows the owner screenshots, videos or files their runs attached (evidence ids), with the node's reply (§8.14). Only in turns the owner started. |
| `node_routines {action: list\|create\|pause\|resume\|delete\|run_now, …}` | The owner's routines for this node (§6.5), when they ask. Only where the owner reads alone. |
| `node_create {name, role, charter, templateId?}` | Makes the owner a lasting node, with its own DM, when they ask (§6.1). Only where the owner reads alone. |
| `node_create_group {title, members, lead?}` | Makes a crew of the owner's nodes (`createCrew`, the same as `POST /api/node/crews`), when they ask. Only where the owner reads alone. |
| `node_overview {days?}` | What the owner is working on across every space they can open (§5.4), read-only (`node/overview.ts`): open tasks that are theirs (`owner: me`, in their own spaces unassigned or theirs, elsewhere `assignee_account_id` them), what is due by `days` (default 7) or overdue (those tasks, and deliverables and reminders in their own spaces), and agent runs they have going (in their own spaces, and on their computer in spaces shared with them), each with its space's name. Only where the owner reads alone and asked. |
| `node_peer_request {kind, text, to?, refs?, candidate?}` | A peer request (§12.6). In My crew, the owner's own, to another person in the room (`to`: their handle or their lead's), attributed to the owner and relayed by this node. In a room-bound turn, someone's request for work or a review for this node's owner; it waits for the owner. |
| `node_room_history {before?, query?, limit?}`, `node_owner_status {}`, `node_shared_items {item?}`, `node_ask_owner {question, need}` | Only in room-bound turns (§12.3): the room's public history, the owner's status card for the room, items the owner marked shareable here, and one disclosure card to the owner (§12.4). |

Node turns also have every assistant tool for the owner's modules (§5.3): workspace search across tasks, pages and files, page and board edits, settings, connected-app reads (`apps_search`, `apps_read`, MCP tools for what the owner connected) and `hub_web_search`. Each Hub tool takes an optional `space` (§5.4). Writes follow the owner's write policy (§7).

**Files on messages.** A person can attach up to 8 of their own Files to a message. The node reads the files on its owner's messages since its last turn: their text and, when its model reads images, the pictures (`node/brain.ts` passes them to the turn as file mentions; [38](38_AGENT_READABLE_FILES.md)). A node opens only its owner's own Files, so files on someone else's message are named in the transcript with a note that it cannot open them.

### 6.1 Who does the work

The node is the one its owner talks to. Its rules (`persona` in `node/brain.ts`) say who does what: quick work (look-ups, searches, reading, summaries, short reports) it does itself in the turn; code, files, commands and long work go to an agent session (§8); a side task that should be independent of it (an audit, a second opinion, a parallel investigation) goes to a helper; nodes and crews it makes only when the owner asks.

**Helpers** (`node/helpers.ts`). `node_helper` makes a node with `parent_node_id` set, `effort` low and the parent's model, whose charter is the task, and a `task` room (`settings {parentNodeId, helperNodeId, originRoomId, originPrivateTo}`) with the owner (to read), the parent and the helper: the helper's **thread**, which the website shows inline where the parent was asked (the room view's `helper`: `parentNodeId`, `helperNodeId`, `originRoomId`, `originPrivate`, `originMessageId` (the message that asked) and `planId` (the plan card its step is in)). The brief opens the thread without waking anyone, and the task becomes a step of the parent's plan for that turn (`executor: helper`, §6.2): helpers brought in together are steps of one plan, so the parent hears once, with every result, when they have all reported, and tells its owner in one message. A helper:

- runs with no write areas and no connected-app writes. With `can: read` (the default) it only reads: workspace search, pages, tasks, notes, connected apps, the web. With `can: sessions` it also runs its own coding-agent session on the owner's computer (the session tools); with `can: computer` the computer tools (§8.13), only in the folders the parent named (`folders`; none named: the same as its parent). A helper never gets more than its parent (`autonomy.grant`);
- does its step in its thread (a work turn) and reports with `node_step_report`, which code also posts in its thread; it never posts where the owner talks. Asked again later (`node_delegate` to its own helper), it answers in its thread by mentioning its parent;
- is not in the node list, the sidebar's nodes, the CLI overview or the 24-node count, and cannot join a crew or room.

In a task room the parent's own reply goes to `originRoomId` (where it made the helper) instead, in the same thread: privately when it was asked privately (`originPrivateTo`); if the node or its owner has left that room, to its DM. People cannot post in a task room (403). A node has at most 4 helpers working at once, and the account 8 (a turn going on, or their room active in the last 10 minutes): the owner changes this per node (`autonomy.helpers`; the account allows twice it; 0 for no limit). Finished ones stay for the owner to read, 12 per node, the quietest going first. A task room quiet for 3 days goes with its helper (`sweepHelpers`, every 10 minutes); deleting the room, or the parent, removes the helper at once; pausing the parent stops its helpers' turns too.

**Keeping a helper.** `POST /api/node/nodes/:id/promote` keeps a helper as a lasting node: it leaves its parent, keeps its charter and memories, and gets its own DM; its task room stays as history.

**Lasting nodes and crews.** `node_create` and `node_create_group` propose what the website would make (`createNode`, `createCrew`): an owner-only card (`data.type: "node_proposal"`, `action: node | crew`, `input`) with the name, role and charter, or the crew's nodes and lead. Approving it makes exactly that, with the same unique-name rules and limit, and the node hears it; the new node's chat appears in the owner's sidebar and the node can hand it work with `node_delegate`. An owner who sets the node's `autonomy.createNodes` to `auto` lets it make them without asking.

### 6.2 Plans and missions

A lead hands work to its owner's other nodes as one **plan**, never as chat between nodes; a node's own background work is the same thing with one step. Both are **missions** (`node/plans.ts`, `node_missions` and `node_steps`), whose card is a `plan` message with the mission's id. The card's `data` is a view of the tables (`project` in `node/plans.ts`), rebuilt on every change.

- **Making it.** In one turn the lead calls `node_plan` with the whole plan (§6.3), or `node_delegate` per step. Only a turn its owner started may. The card (owner-only where other people read) is posted in the crew, or in the crew the lead leads when it was asked elsewhere. A step has `{node, kind, brief, after, verifies?, requirementIds, run}`: `kind` is `build`, `verify`, `write`, `research` or `other` (from the node's role when not given); a `verify` step names the build it checks (`verifies`); `run` is the agent, model, thinking level and context the owner named. At most 30 steps, a brake on runaway planning. When the turn ends, the lead's reply opens the card, and the steps that can start, start.
- **Execution and outcome.** A step's `status` is its execution (`waiting`, `working`, `done`, `blocked`, `skipped`, `stopped`); its `outcome` is its result (`unknown`, `done`, `pass`, `fail`, `blocked`, `unverified`), computed from the report's checks (`verdictOf` in `node/report.ts`), never from prose. A verification passes only when it has at least one check, every check passed and every mandatory acceptance criterion has a passing check; `node_step_report` refuses a report that contradicts its own checks. A step whose turn ends in prose is asked once to report (`nudged`); after that the attempt is `unverified`.
- **Order and holding.** A step starts when every step in its `after` has the outcome `done` or `pass`. One after a step that failed, is blocked or is unverified is **held** (`held`, `heldBy` on the card) and never starts on its own; when the plan ends it is `skipped` with what held it.
- **Repair.** A `verify` step that fails reopens the build it verifies as a new **attempt** (`reason: repair`) in the same agent session, with the failing checks and the tested commit in its note; when the repair is done with a new candidate, the check runs again as a retest of that candidate. Steps after the check wait meanwhile. A repair that changes nothing (the same commit or content hash), or the same failure twice (`failureSignature`, which ignores commits, paths and numbers), stops repairing: the lead gets one judgement turn; a third identical failure asks the owner. There is no fixed number of rounds. Every attempt keeps its outcome, checks and candidate on the card (`attempts`).
- **Steps' turns.** A step's turn runs in its work lane (§5.1) with the step's note: its brief, the requirements it covers, the mission's constraints rendered by code, its run settings ("already applied; do not check them") and the results of the steps before it. It has the session tools, `node_secret_request`, `node_remember`, `node_step_report` and `node_step_blocked`. A step that started agent runs, or has a card waiting on the owner, stays `working` until they come back. A run's end wakes its node for the same step, unless the run reported a structured result (`WorkspaceJob.report`): then the step ends with it directly, with no node turn. A run, card or turn from an earlier attempt of the step changes nothing.
- **Straight to the agent.** A step that is work in files, where the mission names the folder or repository (`build`, `write`, and the `verify` of a build or writing), skips its node's turn: code compiles a **packet** (`node/packet.ts`: Goal, Your part, Constraints, Inputs, Who you are, Report; at most 6,000 characters, every constraint once, earlier results linked rather than pasted) and starts the session itself (`node/dispatch.ts`). The mission's folder path is matched to a folder a paired computer shares (by name, or its last part); a single repository address is cloned instead. A repair continues the builder's own session and a retest the checker's; a builder's next build continues its session too; a check starts a session of its own. The run card keeps the packet (`data.told`). The worker's `report_result` ends the step with no model turn. A run that ends without a result is asked once, in the same session, to report (`data.reportAsked`); after that, a blocked report, a failed run, or a hand-over that could not happen (no shared folder, a refusal), the step's node takes a turn with the step and the reason in front of it. "Ask me before computer work" still holds the packet for the owner's card. Research and other steps, and a node's own work, are turns of their node as before.
- **Report.** When nothing can move (nothing working, nothing ready) the mission is `reporting` and the lead gets one turn where it was asked, with every step's result, failed checks, the requirement ledger and anything that needs its judgement. It may continue the plan (`node_delegate`, `node_plan_revise`); otherwise the mission ends `succeeded` (every step done or passed and every requirement accepted), `partially_completed`, `failed` (a check failed) or `stopped`.
- **Durability.** Every change runs in one transaction that locks the mission row, applies the pure rules in `node/missions-core.ts`, stores the steps and writes its effects (start a step's turn, the lead's report, expire cards) to `node_outbox`. The outbox (`node/outbox.ts`) delivers them right after the commit and in a sweep every 5 seconds; a turn it enqueues carries the effect's `operation_id` (unique on `node_turns`), so a redelivered effect starts nothing new. Plans made before this change continue as contract 1, where a finished step keeps its old meaning.
- **Stopping.** `POST /api/node/plans/:id/stop`, the room's Stop, pausing or deleting its lead stop a plan: its turns stop, steps that have not ended become `stopped`, the runs they started are stopped and wake nobody, cards waiting for the owner expire, and nobody reports. Pausing or deleting a step's node stops only its steps.
- **Cards of ended work.** When a step or a mission ends, its approval and secret cards still pending become `expired` ("Its step ended."); answering one then changes nothing.

### 6.3 The mission contract

`node_plan` takes the whole plan at once (`node/plan-contract.ts`):

| Field | Meaning |
| --- | --- |
| `goal` | One line. |
| `requirements` | One per deliverable the owner asked for: `{id, text, acceptance: [{id, text, mandatory?}], evidence?}`. |
| `constraints` | Written once for every step: `computer`, `folder`, `repos`, `branch`, `publish` (`none`, `commit`, `push`, `pr`), `environment`, `agent`, `model`, `effort`, `context`, `substitution` (`forbid`, `ask`, `allow`), `order` (`serial`, `parallel_ok`), `notes`. Agent settings become each step's run settings. |
| `steps` | `{id, to, kind, requirementIds, brief, after, verifies?, run?}`; briefs at most 1,500 characters, the step's own objective only. |
| `deferred` | `{requirementId, reason}` for what will not be done now. |

Validation (`validatePlan`) refuses: unknown or duplicate ids; cycles; a requirement no step covers and not deferred; a requirement with acceptance criteria but no verify step; a verify step without a build before it; under `order: serial`, a build step covering more than one feature, or a feature not after the previous feature's check. The card shows a **requirement ledger** (`open`, `in_progress`, `accepted`, `failed`, `deferred`, `cancelled`). `node_plan_revise` changes a running plan: merged constraints (an empty string clears one) apply to every later step note, steps can be added (their `after` naming new ids, existing step ids or `@handle`), waiting steps cancelled, requirements added or deferred; the revision number goes up.

### 6.4 The stop path

`POST /api/node/rooms/:id/stop {scope?: room|all}`, or a message that is only `stop`, `stop all` or `stop everything` (`node/stop.ts`), stops work at once without a model: the replies in progress, the plans started here and the agent runs started here (`all`: everything the owner's nodes in this room do, in every room). The owner gets one private status line ("Stopped 1 plan and 2 agent runs. What was already done stays.").

### 6.5 Routines

A **routine** is work a node does by itself on a schedule, when something changes in its owner's Ensemble, or when a webhook calls (`node/routines.ts`, `node_routines` and `node_routine_runs`).

| Field | Meaning |
| --- | --- |
| `instruction` or `template` | What to do each time: an instruction the node does as its own work, or a saved plan (a `node_plan` input, §6.3) its nodes run as a plan. One or the other. |
| `trigger` | `schedule` (`cron`, five fields, in `timezone`, the owner's by default), `event` (`event: {on: task\|page, actions?, space?, windowSeconds}`) or `webhook`. Any routine can also be run now. |
| `notify` | `always` (the node posts the result), `needed` (only when something failed, changed or needs the owner) or `never` (nothing is posted; the run is listed with the routine). |
| `roomId` | Where it reports: the node's chat by default, or one of the owner's crews it is in. Never a room other people read. |
| `status` | `active` or `paused`. |

- **Occurrences.** Each has a key unique per routine (`at:<time>`, `event:<window>`, `hook:<window>`, `manual:<id>`), so a restart or a second server records and starts it once. A scheduled time missed by more than an hour, because Ensemble was not running, is recorded as missed rather than run late. A tick every 20 seconds (`ENSEMBLE_NODE_ROUTINE_TICK_MS`) records the times that came and starts what is due.
- **Bursts.** Changes (Ensemble's own live frames for tasks and pages in the watched space) and webhook calls arriving within a window gather into one occurrence with every change listed, at most 50. Each change is added to its occurrence in one statement, so changes arriving together are all kept; one arriving after its window's occurrence started opens a follow-up occurrence. Changes made while the routine's previous run is still going are its own and start nothing. A run still going when the next one is due makes it wait.
- **What runs.** An occurrence runs through missions like any other work (§6.2): an instruction as the node's own work, with the time and what happened as information, never as instructions; a template as a plan in the node's crew. Its card is listed with the routine, not in the chat (its `plan_id` is the routine's id), so only the report is a message. The report turn knows it is a routine and its rule.
- **Webhooks.** `POST /api/node/hooks/routines/:id` with `Authorization: Bearer <token>` (or `?token=`). The token is shown once, when the routine is made or the token renewed, and only its SHA-256 is stored. Every refusal is the same 403. A delivery id (`X-GitHub-Delivery`, `Idempotency-Key`, `X-Request-Id`, else a hash of the body) seen in the last day starts nothing. The body (up to 8,000 characters kept) reaches the node as information.

## 7. Approvals

`POST /api/node/approvals/:messageId {decision: approve|discard, callIds?, body?}`. Only the card's owner can settle it, and only while they are still in the room. A card is settled once: it moves from `pending` to `applying` with a JSON-guarded update. Held tool calls are applied by `POST /api/assistant/apply` with the node's conversation (same dedupe, locks, undo entry and ledger as the Hub). For a node's conversation Apply checks each call again in the space it names, with the owner's access at that moment (`conversationSpaces` in `node/spaces.ts`, §5.4). If that fails, the card returns to pending with the error so the owner can retry or discard. Discarding marks the calls failed with "Not approved by the person." in the conversation. Approving a draft posts exactly the approved (optionally edited) words, which then speak for the owner. After an approval, the node gets a follow-up turn with the result so it can continue its plan.

## 8. Work on a computer

A node does not do long work on a computer itself. It controls the owner's own coding agents on their paired computer, on their own subscriptions, through **agent sessions** ([30](30_ENGINES.md), Agent sessions): a session is one conversation with one agent, carried across the runs that continue each other. Every run is a `WorkspaceJob` made by `createJob`, so Ensemble's queue, device protocol, sandbox, Needs me and publishing rules apply as for any task ([06](06_MODULE_WORKSPACE_AND_SURFACES.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). For quick checks (a test run, `git status`, a look at a development server, a small file change) it has its own tools on the computer (§8.9).

### 8.1 Starting a session

`node_session_start` plans the run as `hub_assign_to_agent` does (`plan` in `assistant/tools/agent-assign.ts`): the owner's default run profile (or the one named) decides the agent, computer, mode and git rules unless the node names others. With no coding agent in the profile, it takes one signed in on the chosen computer. The agent works in a folder the computer shares, a fresh clone, or a new empty folder.

A run the node starts on its own keeps its record on an internal task (`sourceRef` `node:<nodeId>`, `lib/node-tasks.ts`) that stays off the board: the board, Today, the assistant's task lists and the CLI's task list leave it out (`ON_BOARD`). The run still shows in Runs and Needs me. When the owner wants the work on their board, the node makes a task (`hub_create_tasks`) and passes `taskId`; the run then belongs to that task.

Each run gets a `node_runs` row (`session_id`, the node's `prompt`, `direct` for an off-board task) and a run card in the room, owner-only in rooms with other people. A new session's id is its first run's job id.

A model named by its label ("GPT 6.1 Sol") or alias becomes the id the computer's agent lists (`agentModel` in `node/sessions.ts`, from `capabilities.agents`); a model the agent does not list (unless it takes typed names) and a thinking level the model does not take ("extra high" is `xhigh`) are refused before any run is made, with the ones it takes.

### 8.2 Which session

The node chooses (`sessionRules` in `node/brain.ts`): the same line of work in the same repository or folder goes to the session that did the earlier work, so the agent remembers it and its provider reuses the cached conversation; unrelated work, another repository or folder, another computer or agent starts a new session. `node_sessions` is the only list it sees.

**Isolation.** A session belongs to the node of its first node run (`sessionOwners`). Other nodes never see it, and `node_sessions`, `node_session_send` and `node_session_stop` refuse it. A session started outside Node (the Hub, the CLI) belongs to no node until one continues it; then it is that node's.

### 8.3 Queue, steer, replace, stop

Continuing a session needs Ensemble 0.4.18 or later on its computer (`capabilities.sessions`, else the app version; `continuesSessions`): older runtimes open a new agent session for every message, so `node_session_send` is refused there with the update to make. A computer that never reported its version is not refused.

`node_session_send` `delivery`:

| Delivery | What happens |
| --- | --- |
| `queue` (default) | A new run at the end of the session's queue. It waits for its turn (`sessionTurn`, §8.9), so messages run in order. On an idle session it runs now. |
| `steer` | Changes the run going on. A new run with `context.steer {update}` continues it and goes first in the queue; then the run is stopped. On the computer the agent resumes its conversation and gets only the change (`steerPrompt` in `workspace/engine-watch.ts`; the claim spec carries `steer`). A run not claimed yet, or a change still waiting to go in, takes the new change into its brief or its `steer` instead. On an idle session it is `queue`. |
| `replace` | Queues this after the last run that reached the computer, then takes what is queued out of the queue and stops the run going on. If the new run cannot be made, nothing stops. |

`node_session_send` takes the same run settings as `node_session_start`: `model`, `effort`, `context` and `fast`. Each one left out is kept from the session (§8.10).

The order is the session's queue (§8.9), not when runs were made. A new message starts from the end of the chain (`lastJobId`, `workspace/sessions.ts`); when it is claimed it continues the run that actually ran before it.

`node_session_stop` stops the run going on, and the queued ones unless `queued: keep`. `node_session_queue {session, order | cancel}` reorders the queued messages or takes some out, as the owner can on the card. Runs a newer call took over (steered, replaced, stopped, taken out, paused) get `data.quiet` on their card and do not wake the node when they end.

### 8.4 Who decides

Where only the owner reads and the owner started the turn (a DM, a crew, their private thread; one of their own nodes by delegation), these run at once, and the node also gets `node_session_queue` and `node_answer_question` (§8.11). With the node's **Work on your computer: Ask me first** (`autonomy.computerWork: "ask"`), `node_session_start` and `node_session_send` post an owner-only approval card (`data.type: "session"`) instead, run exactly as shown when approved. In a room with other people, the shared thread's turns are room-bound and get no session tools at all, even for the owner's own request (§12.3): work on the computer is asked for in My crew, or arrives as an accepted peer request (§12.6). Ensemble's Stop everything refuses new work.

When a run ends (succeeded, failed, cancelled, interrupted), the watcher (`node/runs.ts`) wakes the node in the same thread with the summary and what is still queued in the session, so it reports to whoever asked. Questions a run asks are answered in Needs me (§8.6).

### 8.5 Pausing a node

`PATCH /api/node/nodes/:id {status: "paused"}` stops everything the node is doing: its reply, its queued turns and every run it started that has not ended (`stopNodeRuns`). It then posts in its DM, without a model call, what it stopped: the runs that were working and the ones it took out of the queue, or only that it paused when nothing was running (`pausedNotice`). It resumes with `{status: "active"}` or with its owner's next message to it (§4).

### 8.6 Needs me

Needs me is one list in every product: Ensemble's run approvals and agents' questions, the nodes' approval cards, and board tasks blocked or waiting for an approval.

- Node's Needs me page reads `GET /api/approvals`, `GET /api/decisions?status=pending` and `GET /api/node/activity` (its `approvals` are the node cards, `waitingTasks` the tasks), and answers each in place.
- The Hub's Needs me lists the node cards under *From your nodes* (`GET /api/node/approvals`, with each card's node and conversation and the Node site's address) and settles them with `POST /api/node/approvals/:messageId`; `GET /api/shell` counts them in `nodeApprovals` for the sidebar badge.
- A card created or settled sends `approval` on the owner's Ensemble stream (`needsMeChanged` in `node/store.ts`), which the Hub re-reads and Node gets as `node.needs`.
- The CLI lists the cards after the computer's own questions in `ensemble needs` and on its Node tab, read through `GET /api/bridge/node` ([26](26_CLI.md)); they are answered on Node or in the Hub.
- A run's questions and permissions close when the run ends, and the first answer from anywhere wins; a late answer is refused with "This request ended with its work." ([05 §5](05_MODULE_TASK_ORCHESTRATOR.md#5-decisions-and-publishing)).

### 8.7 Secrets

Work often needs a secret (an API key, a token). No model is ever given one, and Ensemble on the web never stores one.

- A node asks with `node_secret_request {name, why}` (an environment variable name; names that would change how the computer or an agent runs or signs in, such as `PATH`, `GITHUB_TOKEN`, `ANTHROPIC_*`, `OPENAI_*`, `ENSEMBLE_*`, are refused by `secretNameProblem` in `lib/run-secrets.ts`). It posts an owner-only card (`data.type: "secret"`, with the computer: the one named, else the default run profile's, else one online; the computer must report `capabilities.secrets`).
- The owner types the value into a password box on the card, on Node or in the Hub's Needs me. `POST /api/node/secrets/:messageId {value}` sends it straight to that computer as a `secret.save` frame on its event stream and waits for its answer (`askDeviceFor`, 20 s). The card records only that it was saved, where, and when; the value is not in the card, the message, the ledger or any log. An offline computer, or one that does not answer, leaves the card pending with the reason. Saving and declining change the card by compare-and-set (`updateMessageDataIf`), so only one wins; a card a restart left `saving` can be answered again after 30 seconds. Declining (`POST /api/node/approvals/:messageId {decision: "discard"}`) tells the node to go on without it.
- The computer keeps the value encrypted with its own key (`run_secrets`, `lib/secrets.ts`) and gives saved secrets to its coding-agent runs as environment variables (`runSecretEnv`; Codex gets them through `shell_environment_policy.set`, since it leaves `*KEY*`/`*TOKEN*` variables out of commands). The agent's brief names them (`$NAME`) and says never to print one; when a run needs one it does not have, it says which name it needs rather than asking for the value.
- **A node's run gets only the secrets it names.** Every run a node starts or continues carries a list of names (`context.secrets`, the claim's `secrets`; [25 §4.9](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#49-subscriptions-and-included-models)), possibly empty: the names saved through this node's own secret requests or any secret card in the conversation, the names the mission's constraints list (`node_missions.constraints.secrets`) and the names its plan step's run settings list (`node_steps.run.secrets`, or the step on an older plan card) (`secretScopeFor` in `node/secret-scope.ts`, called where `node/sessions.ts` queues the job). None by default. A run from the Hub or the CLI still gets every saved secret. `computer_run` puts the named secrets in that one command's environment only (§8.9).
- Every value the computer knows is hidden in anything it sends to the server (`hideSecretsDeep` in `remote/client.ts`) and in every redaction (`lib/redact.ts`); it loads them for this at start-up (`rememberRunSecrets`), before it sends anything.
- When saved, the node hears the name only and continues the session, telling the agent to use `$NAME`. The person can also manage them on the computer: `ensemble secrets`, `ensemble secrets set NAME` (typed without echo) and `ensemble secrets remove NAME` ([26](26_CLI.md)), or the local `GET/PUT/DELETE /api/run-secrets`.

### 8.8 The session card

Each run in a session has its run card in the thread; the web shows one session card per session from them. Two fields keep it current:

| Field | What it holds |
| --- | --- |
| `data.settings` | `{ requested, resolved, observed }`, each `{ agent?, model?, effort?, context?, fast? }` (§8.10). Observed values are `"not_reported"` until the agent says. |
| `data.session` | `{ id, nodeId, status, agent, agentId, model, computer, folder, running, queue, updatedAt }`: `status` is `working`, `waiting` (on Needs me), `queued` or `idle`; `running` is the current message (`{ jobId, title, prompt, status }`); `queue` the messages after it, `[{ jobId, title, prompt, position }]`. `agent` is the name shown, `agentId` the agent's id. |

The session's cards still going and its newest card get `data.session` after every action on it (`refreshSessionCards` in `node/session-queue.ts`). The run watcher calls `refreshRunCard(prisma, run)` (`node/settings.ts`) as a run's job changes: it reads the job's settings again and the session's state. Both patch the card's data in one statement (`data || patch`), so they never overwrite another writer's fields.

### 8.9 Session control from the card

The owner controls a session from its card with the same functions the node's tools call (`node/session-routes.ts` calls `sendToSession`, `stopSession` and `editSessionQueue` in `node/sessions.ts`). The routes take the owner's browser session only: no key, no link visitor, no other person. They act as the session's node (the node of its first node run), in the thread of its newest run, and for its plan step while that step goes on. A session no node manages is read but not controlled (409).

| Route | Effect |
| --- | --- |
| `GET /api/node/sessions/:id` | `{ session: { id, nodeId, status, agent, agentName, model, computer, folder, running, queue, runs } }`; `runs` are the 20 newest with their status, position, prompt, summary and settings |
| `POST /api/node/sessions/:id/control {action, prompt?, title?, queued?}` | `queue`, `steer` or `replace` with `prompt` (as `node_session_send`), or `stop` with `queued: keep \| drop` (as `node_session_stop`); `{ ok, jobId? }` |
| `POST /api/node/sessions/:id/queue {order}` | Every queued message's `jobId` in the new order |
| `DELETE /api/node/sessions/:id/queue/:jobId` | Takes one queued message out: it is cancelled and never starts (204) |

A refusal (the computer's agent cannot honour a setting, Stop everything is on, a message already started) is a 409 with what to do instead.

**Queue order.** A session's queued messages run in the order of `workspace_jobs.queue_position`, separate from `continueFromJobId`, which stays the true resume ancestry. The session's first run always comes first; a queued message goes last, a steer first, and a reorder sets them all (`queuedOrder`, `placeInQueue`, `reorderQueue`, `dropFromQueue` in `workspace/sessions.ts`). A queue from before positions runs along `continueFromJobId` until it is next changed.

**Resume ancestry.** Each change to a session's queue and each claim of one of its runs (the server's queue and a computer's claim, both through `claimQueuedJob` and `sessionTurn`) holds the session's lock, a Postgres advisory transaction lock on its first run's id. A queued run starts only when no other run of its session is on a computer and it is first in the queue. As it is claimed, its `continueFromJobId` becomes the run of the session that actually ran last, so the chain of runs that ran is one line in the order they ran, whatever was reordered, taken out or steered. When nothing in the session ever reached a computer, it starts afresh in the session's folder and stays in the session. A reorder or a cancel touches only runs still queued, with a compare-and-set on their status; an order made from a queue that changed meanwhile is refused (409) and changes nothing.

**The work board.** Every action is recorded in `node_session_events` (`queue`, `steer`, `replace`, `stop`, `reorder`, `cancel`, `answer`, `attention`), with who did it (`owner`, `node` or `watchdog`) and from where (`card`, `chat` or `watchdog`). `sessionEvents(prisma, nodeId, { since, sessionId })` and `sessionEventLine` (`node/session-queue.ts`) give the node's work board what happened since its last turn, so it is never surprised by what its owner did on the card.

### 8.10 Run settings

Every node run records three sets of settings on `node_runs.settings` and its card (`node/settings.ts`):

| Set | What it is |
| --- | --- |
| `requested` | What was asked, as asked: named in the call, or the plan step's run settings. Nothing else. |
| `resolved` | What the agent was sent: the job's own `provider`, `model`, `reasoningEffort` and the context window and fast mode on its context. `"default"` is the agent's own. |
| `observed` | What the agent itself reported it runs with (`workspace_jobs.observed_settings`, else the job's `engine` and `engine_context` events; [30 §3.4](30_ENGINES.md#34-what-the-agent-says-it-runs-with)). Anything it did not report is `"not_reported"`. |

`settingsLine(settings)` gives one line for people and nodes, for example "GitHub Copilot · GPT 6.1 Sol · default effort · long context (requested); observed model gpt-6.1-sol, effort not reported, context not reported". `refreshRunSettings(prisma, run)` reads the job again and updates `observed`.

**Continuing a session.** Each setting has three states (`sessionChoices` and `resolveSessionTuning` in `workspace/assign.ts`): left out, the session's is kept; `"default"` (or `fast: false`), the agent's own default; anything else, that value. Naming a model keeps the session's thinking level, context window and fast mode. The task's model tier adds nothing to a run in a session (`keepSettings`).

**What the computer can honour.** Before any run is made, the settings are checked against what the computer reported for the agent (`capabilities.agents`; `tuningProblem`): long context needs a model the agent offers it for (or a fixed 1M window; on Claude Code a named model), fast mode needs Claude Code or Codex and a model that has it, and a thinking level kept from the session must suit a newly named model. A setting that cannot be honoured is refused once, with what to do instead ("GitHub Copilot on Mira's laptop does not offer long context for GPT-5 mini. This session used long context, so it was kept. Run with the default window (context: default), or choose another model."). Nothing is swapped quietly. A computer that did not report its agents is not refused on a guess.

When settings were asked for, the agent's instructions end with "Ensemble already started you with …. Do not check these settings yourself." (`appliedLine`), so no worker stops to check its own model.

### 8.11 The watchdog and the agent's questions

`checkSessions(app)` (`node/watchdog.ts`; `startWatchdog`, `stopWatchdog`) applies code rules to the runs of nodes' sessions. Each finding gives the run's node one attention turn (`reason: "attention"`) with a note, never a chat message; the node decides whether to steer, ask its owner one short question, or leave it.

| Rule | Raised when | Setting |
| --- | --- | --- |
| No progress | A working run shows no events, output or step changes for this long (the computer's heartbeat does not count) | `ENSEMBLE_NODE_WATCHDOG_STALL_MS`, 15 minutes |
| The same error | The same failing command, tool call or engine restart this many times | `ENSEMBLE_NODE_WATCHDOG_REPEATS`, 3 |
| Tokens without changes | A code run spends this many tokens without a file-changing tool call or a changed file | `ENSEMBLE_NODE_WATCHDOG_TOKENS`, 2,000,000 |
| Files outside the folder | A run, going or ended in the last 30 minutes, changed files outside its folder | — |
| An agent's question | A question of fact (below) waits in Needs me | — |

Each condition reaches the node once per run (`node_runs.watchdog`, taken with a compare-and-set). A paused node hears nothing; the finding stays open for when it is back. The check runs every `ENSEMBLE_NODE_WATCHDOG_MS` (a minute).

**The agent's questions.** A run's `ask_person` question goes to its node first, unless the owner turned that off (`autonomy.answerAgentQuestions: false`). The node may answer with `node_answer_question {decision, answer, quote, source}` only from a fact quoted word for word (letter case and spacing aside) from its source: `owner` (the owner's own message that started the work), `mission` (its goal and requirements), `step` (the step's brief) or `constraints` (the mission's). The node's own words to the agent are not a source. A question with options takes one of them. The answer is recorded on the request (`detail.answeredBy {nodeId, handle, source, quote}`), on the run ("Answered by @node from its owner's message: …") and on the session, and goes to the agent as the owner's would. Permissions, widening the scope, security, cost and anything destructive (`questionRefusal` in `node/session-questions.ts`) never reach the node and are refused if it tries; they wait in Needs me, as does every question it leaves. The first answer wins, from the node or the owner.

### 8.12 Results and evidence

A coding agent reports its own result, apart from its closing words: `report_result` on the run's MCP server, or `.ensemble/result.json` when it has no MCP ([30 §9](30_ENGINES.md#9-the-workers-report-and-evidence)). The report is a `StepReport` (`node/report.ts`): outcome, summary, checks with verdicts, the commit or content hash it produced, evidence, and why it is blocked. The computer checks it and keeps it on the job; `complete` brings it to the web, where it is checked again and kept on the job (`workspace_jobs.report`) for the node and its plan to read.

**Evidence.** The agent attaches what its owner should see (`attach_evidence`): screenshots, videos, traces, reports, logs and other files. The computer checks each file and keeps a copy in the run's evidence folder, outside the repository, then uploads it ([25 §4.11](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#411-the-workers-report-and-evidence)). Each upload lists the file on the run's card: `data.evidence` is `[{id, kind, name, mime, size, caption?, requirementId?, createdAt, local?}]` (`refreshRunCard` in `evidence/store.ts`, from the `node_runs` row of the job). `GET /api/node/evidence?jobId=` is the full list and `GET /api/node/evidence/:id` the file ([32 §7](32_FILES.md#evidence-from-agent-runs)).

- **Owner only.** Only the account whose computer ran the job reads the files, never other people in the room; the run card is already owner-only where others read (§8.1).
- **Kept on the computer.** With `ensemble evidence off` on that computer, the files stay there. The card lists them with `local: true`, for the website to show as "on this computer, not uploaded"; they cannot be opened from the web (409).
- **Never attached:** links, hard links, key, certificate and `.env` files, shell histories, Ensemble's own data, the browser profile and any file holding a saved secret value. Text is redacted on the computer and again on the web.

### 8.13 The node's own tools on the computer

For a quick check a node does not need a coding agent: it can run a command, read git, call a development server and change a file on its owner's computer itself (`node/device-tools.ts`, `deviceTools(scope)`; tools in §6). Longer work, or work that edits code over several steps, still goes to an agent session (§8.1).

- **Where.** Only in a turn that only the owner reads and that the owner started (a DM, a crew, their private thread). Never in a turn someone else started, never for a helper, never where other people read. The output stays in that turn.
- **Which computer.** The one named (`computer`), else the owner's computer seen online most recently. It must report `capabilities.nodeTools` 1; otherwise the node is told "Update Ensemble on <computer>" and can start an agent session instead.
- **How.** Each call goes to the computer as `node.tool.request` and is judged and run there ([25 §4.10](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#410-a-nodes-own-tools-on-the-computer)): the guard and the OS sandbox as for an agent's commands, with keys, Ensemble's data, the run secrets and the browser profile denied.

**Who decides** is the computer, in this order:

1. **The hard floor.** Keys, sign-ins, Ensemble's own data and code, system folders and links are refused, whatever the owner chose.
2. **The owner's answers** kept on that computer, for a folder or a web address, for one mission or always.
3. **Unattended** (the node's run profile runs unattended and Work on your computer is not *Ask me first*): the call runs inside the sandbox.
4. **Attended:** the first use of a folder (or an address) asks the owner once in Needs me. The card (`agent_decisions`, tool name `Computer tools`; `node/device-tool-decisions.ts`) offers *Once*, *This mission* and *Always for this folder* (or *for this address*), on Node, in the Hub, on the phone and in `ensemble needs`. While it waits, more calls for the same folder do not ask again. The answer reaches the computer with the node's next call there, and the node is woken to make the call again. *This mission* covers the plan the turn works for, else this conversation.

Where the computer's sandbox is weak, the floor is best effort: *Always* is not offered for commands, which ask once per mission instead. The answers count only while the computer accepts approvals from the web; with that off, a call without an answer kept there is refused.

**Commands.** `computer_run` takes one program and its arguments (a shell line through `bash -c`), up to 900 seconds. Its output is redacted and at most 64 KB comes back; `computer_run_output` reads the rest (kept 6 hours, at most 1 MB per command). A command still going after a minute, or started with `background`, runs on, and its end wakes the node once (`enqueueTurn`, reason `tool`) in the same conversation. `secrets` puts named saved secrets into that command's environment only; the node never sees a value. `git push` and `git fetch` are refused (they need the owner's sign-in: an agent session does that).

**Ledger.** Every call writes `node.device_tool.<tool>` on the web and `node.tool.*` on the computer, with the folder and the program, operation or address, never the output.

### 8.14 Media in the conversation

A node's message can carry screenshots, videos and files its owner's runs attached (`data.media: [{evidenceId, kind, name, mime, caption, size}]`, at most 8; `node/media.ts`):

- **Chosen by the node.** `node_show` attaches the owner's own uploaded evidence to the turn's reply (a run's end note lists its files by id). Evidence of someone else, or kept on the computer (upload off), is refused with why. Files with nothing to say are posted on their own.
- **A plan's report.** The lead's report message brings the media of the steps that were done or passed: the files the worker named in its report or checks first, then the screenshots and videos its runs attached; video first, at most 6. A failed or held step's media is not shown by itself: what reaches the chat was checked.
- **Who can open a file.** `GET /api/node/evidence/:id?message=<id>`: its owner, and anyone who may read the message that shows it (a person of the room who can see the message and, in a room with other people, had joined when it was posted). An approved draft keeps its files and record names, so sharing a result in a room is the owner's act (§5).

## 9. Routes

| Route | Purpose |
| --- | --- |
| `GET /api/node/bootstrap` | Me, my nodes, my rooms (with unread counts and last message), my computers, credits, models, templates |
| `GET /api/node/events` | SSE: `node.message`, `node.message.updated`, `node.status`, `node.frame` (owner only), `node.room`, `node.needs` (a Needs me card was opened or answered on the person's own channel; no content, so Node re-reads its lists; `mirrorNeedsMe` in `node/events.ts`), `node.routine` (`{id}`: a routine changed or started a run), `node.request` (`{roomId, requestId}`: a peer request changed, to the room's people; Node re-reads it, §12.6) |
| `GET/POST /api/node/nodes`, `PATCH/DELETE /api/node/nodes/:id` | My nodes (24 at most; helpers are not listed or counted). PATCH: name (the DM follows), `slug` (unique per account; each room's handle follows unless someone there has it), role, charter, avatar, model, `effort` (§5), `autonomy {sharedRooms, computerFiles, computerWork, answerAgentQuestions, createNodes, helpers}` (§6.1), `status` (§8.5). Deleting one removes its DM, runs, conversations, session events and helpers |
| `GET/POST /api/node/nodes/:id/memory`, `DELETE …/memory/:memoryId` | A node's memory |
| `POST /api/node/nodes/:id/promote` | Keep a helper as a lasting node (§6.1) |
| `GET /api/node/models` | Every model a node can use: included, own keys, AI plans on paired computers |
| `POST /api/node/crews` | A crew from nodes I pick (unique title) |
| `GET/POST /api/node/rooms`, `GET/PATCH/DELETE /api/node/rooms/:id` | Rooms I am in (task rooms included, read-only); a new room with 1–3 of my nodes and emails to invite; title (unique) and crew lead by the creator; my own responsibility line. Deleting a task room removes its helper |
| `POST /api/node/rooms/:id/invites`, `DELETE …/invites/:inviteId`, `GET /api/node/invites`, `POST /api/node/invites/:id/accept`, `POST …/decline` | Requests to join a room (§3) |
| `POST /api/node/rooms/:id/nodes`, `PATCH/DELETE …/members/:memberId` | Add my node (a crew: its creator; a room: 3 per person); make one of mine the lead; leave or remove mine (the creator may remove anyone) |
| `GET/POST /api/node/rooms/:id/messages`, `POST …/read`, `POST …/stop` | Messages I may see (`after`/`before`/`limit`, `author=people\|nodes`); `replyToId` quotes a message (a public reply may not quote a private one); post (`clientId` makes a resend return the first copy, `private`, `files`: up to 8 of the sender's own Files ids, so `body` may be empty); read marker; stop my nodes' work here, or everywhere with `{scope: "all"}` (§6.4). A message that is only `stop` or `stop all` does the same, without a model |
| `GET /api/node/messages/:id`, `DELETE /api/node/messages/:id` | One message I may see; delete my own (its text, reactions and attached file names go, a deleted line stays) |
| `POST /api/node/messages/:id/reactions {emoji}` | Add or take back my reaction (one of eight) |
| `GET/POST /api/node/rooms/:id/pins` | Pinned messages (25 at most; only ones everyone in the room can read), pin or unpin |
| `GET /api/node/search?q&roomId?&author?` | Messages I may read containing every word, across my rooms or in one |
| `GET /api/node/rooms/:id/export` | The room as Markdown, what I may read |
| `POST /api/node/approvals/:messageId` | §7; also disclosure cards (§12.4) and the target owner's peer-request card (approve accepts, discard declines, §12.6) |
| `GET /api/node/plans/:id` | One of my plans (or a routine's run) with its steps' run cards, which are not in the timeline |
| `POST /api/node/plans/:id/stop` | Stops one of my plans (§6.2) |
| `GET/POST /api/node/routines`, `PATCH/DELETE /api/node/routines/:id` | My routines (§6.5), with when they run next and their last runs. POST returns a webhook routine's token once |
| `POST /api/node/routines/:id/run`, `POST …/token`, `GET …/runs` | Run now; a new webhook token (the old one stops working); runs with their mission's status |
| `POST /api/node/hooks/routines/:id` | A routine's webhook: its own token, no session (§6.5) |
| `POST /api/node/secrets/:messageId {value}` | Sends a secret to the card's computer (§8.7) |
| `GET /api/node/evidence?jobId=`, `GET /api/node/evidence/:id` | A run's evidence and one file's bytes, for the account whose computer ran it (§8.12) |
| `GET/PUT /api/node/rooms/:id/trust` | My settings for this room: what my lead may do for everyone and for each person without asking, and my budget for free-form answers (§12.5). Rooms with other people only |
| `GET/PUT /api/node/rooms/:id/status` | Every person's status card as I may see them (mine in full); I am away (`{away, until?, note?}`) or back (§12.5) |
| `GET/PUT /api/node/rooms/:id/shareable` | Items I marked shareable in this room; `{kind: page\|task\|file, id, spaceId?, shared}` marks or unmarks one (§12.3) |
| `GET/POST /api/node/rooms/:id/requests` | Peer requests in this room since I joined; a new one `{to, kind, text, refs?, candidate?}` (§12.6) |
| `POST /api/node/requests/:id/accept {text?, always?, mode?: private\|shared}`, `POST …/decline {note?}`, `POST …/cancel` | The target owner accepts (optionally edited, optionally always for this person and kind, and for a proposed task private work or a shared run) or declines; the requester cancels one nobody decided yet (§12.6, §12.11) |
| `GET /api/node/rooms/:id/space` | The linked space as I see it: `{space: {id, name, ownerId, ownerName, role} \| null, offer: {messageId, status} \| null}` (§12.11) |
| `PUT /api/node/rooms/:id/space {spaceId} \| {create: true, name?}`, `DELETE …/space` | The room's creator links a space they own, makes one, or unlinks it (§12.11) |
| `POST /api/node/rooms/:id/space/join {join}` | I take, or leave, the offer to join the linked space as an editor (§12.11) |
| `GET /api/node/rooms/:id/board` | The linked space's board, for its owner and members: `{space: {id, name, role}, tasks: [{id, title, status, priority, due, assignee, requestedBy, peerRequestId, madeBy, updatedAt}]}` (§12.11) |
| `POST /api/node/messages/:id/share {as: me\|lead}` | Share to room: one of my private messages, or my own node's private reply, published in the room (§12.7) |
| `GET /api/node/approvals` | My nodes' pending cards with their node and conversation, and the Node site's address: Needs me in the Hub (§8.6) |
| `GET /api/node/runs`, `GET /api/node/activity` | Runs; pending approvals, runs, recent turns, computers, credits, and board tasks waiting for me (`waitingTasks`) |
| `GET /api/node/sessions/:id`, `POST …/control`, `POST …/queue`, `DELETE …/queue/:jobId` | One of my sessions: read it, queue, steer, replace or stop, reorder its queue, take a message out (§8.9) |
| `GET /api/bridge/node` | The CLI's read-only overview (bridge key); its `approvals` name the node and conversation |

## 10. Limits

- A node's conversations, connected-app tools and files stay in its owner's account space; its Hub tools reach the other spaces (§5.4). `node_agents.run_profile_id` is stored and ignored.
- Only the node's own replies leave history when their space can no longer be reached; the room's messages and the notes the node gets after a run or an approval stay.
- Requests to join need an existing Ensemble account (the error says so); there are no invite links.
- There are no voice or phone apps. Live frames come from one API process (as with the Hub's own stream).
- Node turns use included credits like any other assistant call; there is no separate Node budget. In a room with other people, a person may set a monthly budget for their lead's free-form answers to others there (§12.5); nothing is capped unless they do.
- Presence on status cards counts open Node streams on the API process, so it assumes one API process (as live frames do).
- A room's linked space takes as many people as its owner's sharing limits allow (2 per space and 5 contacts by default; the owner's choice up to 50 and 500, [29](29_SHARING.md) §1). A room holds 10 people, each bringing up to 3 nodes.
- Helpers: 4 working per node and 8 per account at once by default (the owner's `autonomy.helpers`); they read unless their parent grants `sessions` or `computer`.
- Plans: 30 steps each; an attempt of a step stops trying after 4 failed agent runs (runs that work are never counted, and repairs are not capped while each one changes something). Secrets: 100 per computer, 16 KB each, kept only on the computer that runs the agents.
- Work turns: 3 per node at once, conversation and work capacity 4 each per server (environment settings).
- The node's own tools (§8.13): a command runs at most 900 seconds and prints at most 1 MB, 64 KB of it in the answer; a file written is at most 1 MB; `computer_http` reads at most 64 KB and follows at most 5 redirects, on the computer's own addresses only. There is no list of ports a command started; any loopback port but Ensemble's own may be called.
- Evidence (§8.12): 20 MB per file (100 MB for video and traces), 100 files per run.

## 11. Verification

`src/node/missions-core.test.ts` tests the pure plan rules without a database, including the reported incident (a failed check never releases the next feature; the build is repaired and retested), repairs that change nothing, the same failure twice and three times, holding behind unverified work, contract-1 plans, attempt fencing and checks that were skipped. `src/node/report.test.ts` covers verdicts and failure signatures; `src/node/plan-contract.test.ts` the plan validation and constraint rendering. `src/node/missions.integration.test.ts` runs the incident end to end through the API, then: prose asked for once then unverified; a verification refused when a check was skipped or a mandatory criterion is missing; `node_plan` refusing an incomplete plan and then gating each feature on its check with the constraints in every note; `node_plan_revise`; a node answering while its own work runs; a newer message merging with a turn that has not acted; stop without a model; an outbox effect delivered twice starting one turn; a restart re-running and resuming turns; cards of ended work expiring; a late run from an earlier attempt changing nothing; a worker's structured report ending its step directly; a helper's sessions grant and keeping a helper.

`src/node/packet.test.ts` covers the packet (each constraint once, settings as facts, repair and retest packets, the length limit) and which steps go straight to an agent; `src/node/dispatch.integration.test.ts` a crew plan where the lead is the only node that thinks (plan, report) while the build and its check run from packets, a repair in the builder's own session and a retest in the checker's, a run asked once for its result before its node judges, and the owner's card before computer work.

`src/node/missions.integration.test.ts` also covers helpers: two brought in together report into one plan and their node tells its owner once; a read helper has no computer tools, and a computer grant gives them only in the folders named. `src/node/node.integration.test.ts` covers a node's proposal card for a new node, approved, and making a crew without asking once its owner allows it.

`src/node/dispatch.integration.test.ts` also covers media: a plan's report shows the checked video and screenshot (named first, no logs), `node_show` refuses another account's file, and a file opens for its owner and for nobody who cannot read a message showing it.

`src/node/cron.test.ts` covers schedules in a time zone, clock changes and both day fields; `src/node/routines.integration.test.ts` a scheduled time started once however often the tick runs, each notification rule, a missed time, pausing and running now, a burst of changes as one run that its own changes do not restart, a webhook's token, redeliveries and a renewed token, and a saved plan run as a plan.

`src/node/router.test.ts` (routing, rooms v2 and `@leads status`, brakes, mentions, one node answering in a crew, templates) and `src/node/node.integration.test.ts`, which runs against PGlite with a scripted model. It covers: a DM turn that uses Hub tools; a session a node starts on its own, off the board, followed to its report; queue, steer (the claim carries only the change; a second change joins the first), queueing after a steer, a replacement that cannot start and stops nothing, replace and stop; no session tools where other people read, even for the owner; isolation between nodes, through any run of a long session, and adopting a session started elsewhere; pausing without a model, not waking for an unaddressed message, and resuming on the owner's message; Ask me first and the card in Needs me on Node, the Hub and the CLI; handle and name changes; a room where a node drafts for its owner, private threads stay out of shared turns and history, other people cannot see, approve or add someone else's node, and a message that names no node wakes nobody; requests to join (limits, one lead, the 30-day block after a decline, reading only after joining); unique names and crews from chosen nodes; search, people-only reading, pins, reactions, replies, deletion and export within visibility; when `node_computer_files` is offered; steps finishing together start the next one and the report once; declining a step's card lets the step finish; another person cannot have a plan made; a crew plan for the owner's whole request (only the lead answers; two builders in parallel, the tester after both, docs last, one turn each with the reports before them; the owner sees the plan card and one report; step run cards inside the card and not unread); stopping a plan stops its runs and nobody reports; a step whose runs keep failing stops after 4 failed runs and the lead reports, while one whose runs work keeps going; a rate-limited turn retried quietly; `node_post` refused for its own conversation; a session model named by its label, an unsupported thinking level refused, and an old computer refused for continuing a session; the bridge overview, narrow-key refusals and node deletion; a secret request (refused on a computer too old for it and for reserved names, the card in Needs me, an offline computer refused, the value delivered to the computer's stream and absent from every stored row, decline, owner only); a helper (its read-only tools and low effort, the task room, the parent's report in the DM, people refused in the task room, kept out of node lists and crews, removed when idle or when its room is deleted; one brought in from a private thread of a shared room reports privately there; only working helpers count toward the cap); a save and a decline of a secret card never both win, and a card a restart left saving can be answered again; `node_create`, `node_create_group` and the thinking level sent with each turn. `src/node/spaces.integration.test.ts` (PGlite, scripted model) covers §5.3 and §5.4: every assistant tool but the two replaced ones reachable from a node turn, each Hub tool with a `space`; playbook routing, personal skills, the write policy, Apply and Undo, with the Undo entry naming the node; a task created in a space the owner edits as a member, with Undo there for the owner; a call without a space acting in the node's own space, and in the owner's account once that space is gone; reads but no writes where the owner only views, by tools and routes; the space owner's connected apps, reminders and syncs out of reach; a membership removed during a turn stopping the next call there, and that space's answer leaving later turns; Apply refused after the owner's role there becomes viewer and applied once they can edit again; none of the owner's spaces where other people read, only the room's bound space; `node_overview` across three spaces; and the delegated identity through routes (ledger attribution, owner-only and personal routes, browser-only gates, another account's node, a space the owner cannot open, headers without the internal token). `src/lib/redact.test.ts` covers hiding saved values and the reserved names. `src/routes/auth.integration.test.ts` covers the return to Node after a provider sign-in, `src/lib/cors-origin.test.ts` covers the Node origin, and `src/lib/turnstile.test.ts` covers a Turnstile answer from the Node host.

`src/node/rooms.integration.test.ts` (PGlite, scripted model) covers §12: a room-bound turn never sees its owner's private page, memories or DM, even when asked directly (checked in everything the model was sent and in the tools offered); the owner's own public question is room-bound and My crew never reaches it; one disclosure card per question, declined with a neutral line and respected after, or agreed and drafted by an owner-wide turn that only the owner's post publishes; free-form answers held by trust or by a spent budget; an unaddressed message waking nobody, only leads answering in public, another person's node answered for by their lead, and one answer per person; Ask my nodes with the quote; `@leads status` without a model, away and detail levels; Share to room; leaving; the migration; a question answered within scope, and a draft answer discarded; work never running before acceptance, then a mission with `requestedBy`, `deliverTo` and principals whose end marks the card done; a review's pinned candidate in the mission's constraints, a decline with its note and always accepting; a request relayed from My crew; a planning turn cut off by the rate limit keeping its request; a mission that ended unseen settled by the sweep; peer requests in account export and deletion; and DMs and crews keeping owner-wide turns. For §12.11: linking and making a room's space (creator only), settings kept through pins and edits, the offer to each other person apart from joining (and at a later join), the owner's member limit and raising it, Not now then Join, unlinking; work between two editors becoming a proposed task (a private card before joining), nothing running before acceptance, a shared run's mission in the space and private work's in the owner's own, both delivering to the task, a decline dropping it, the Board read, and a task a node made in the space recorded for its person. `apps/hub-web/components/desk/tiles.test.tsx` covers answering a requested task from the proposals tile.

## 12. Rooms with people

A room with other people (kind `room`) follows **rooms v2** (ensemble-node `docs/design`, extension Part B; build blocks C1–C7). People talk to people and to leads. Each person works with their own nodes in private. A node acts for its owner only: another person's message is information, never an instruction. Work on someone's computer, subscriptions or credits never starts without that person's yes. Nothing private reaches a public answer: code enforces it, not the prompt.

### 12.1 Room and My crew

- **Room**: what everyone in the room reads. People's messages, leads' public answers, request cards (§12.6), status cards (§12.5) and system lines.
- **My crew**: a person's private messages in the room (`visible_to = [them]`) and their own nodes' private replies. Their nodes read the Room too. Nobody else sees it.
- **The composer.** Send to everyone, or **Ask my nodes**: a private message, which may reply to a Room message (`replyToId`). The node's transcript carries the quote (`↪ #12 “…”`).
- **Share to room** publishes a private result (§12.7).

### 12.2 Who answers in a room

| Message | Who answers |
| --- | --- |
| A person, naming no node | Nobody. No suggestion and no model call. |
| A person names a lead | That lead, in public, as a room-bound turn (§12.3), even when its own owner asks. |
| A person names their own other node | That node, privately, in their My crew. |
| A person names another person's other node | That person's lead, in public. Its note says the node was named and that only leads answer in public. One answer per person, however many of their nodes are named. |
| `@leads status` (also `@leads, status?`, `@Leads: status!`; nothing else) | One status card built by code, with no model turn (§12.5). |
| A private message (My crew) | The person's own nodes, privately: the ones they name, else their lead. |
| A node's message, a card, a system line | Nobody. Nodes never wake nodes here. |

At most 6 nodes answer one message. The streak and depth brakes (§4) stay, but cannot trip here.

### 12.3 Room-bound turns

A turn's `audience` (`node_turns.audience`) is set by where its answer goes: `room` for a turn in the shared thread of a room with other people, `owner` for My crew, DMs, crews, plan work and helpers. The router sets it when the turn is queued and `roomBoundTurn` (`node/audience.ts`) checks it again when the turn runs. It is never widened. Shared and private threads keep separate conversations (§5.2).

| | A room-bound turn |
| --- | --- |
| Instructions | A room persona: its name and role, the room's members by their public fields, who asked, the owner's away line, what it can reach and how to answer. No charter, memories, other nodes, rooms, work board, personal skills or connected apps. |
| Transcript | The shared thread only. Files on messages are named, never opened. |
| Tools | `node_room_history`, `node_owner_status`, `node_shared_items`, `node_ask_owner`, `node_peer_request`, `hub_web_search`, and the room's bound shared space when it has one (`settings.spaceId`, bound in C4) through the space gateway: home only, never falling back to the owner's own spaces, and only while the owner's settings answer from it. Nothing else. |
| Scope | It runs as a guest of the owner's own account, so their connected apps, reminders, imports and syncs are out of reach. |
| Writes | Preview: every write waits for the owner as an approval card. |
| Principals | `node_turns.principals {data, billing, executionDevice, approver, askedBy}`: the owner's data and credits, and who asked. |

**Shareable items.** `PUT /api/node/rooms/:id/shareable {kind, id, spaceId?, shared}` marks a page, task or file in a space the owner can open. `node_shared_items` lists them and reads one at that moment, with the owner's access then.

### 12.4 Disclosure cards

- `node_ask_owner {question, need}` raises one private approval card for the owner (`data.type: "disclosure"`, `mode: "share"`): “Ben asked: “…”. May I share: …?”. There is one per room, asker and question (and one per message). It is settled once; a late answer gets 409, and the card expires when the asker leaves.
- **Yes.** A private, owner-wide turn of the lead in My crew (operation `disclose:<card id>`) looks it up and writes the answer. It reaches the owner as a “Post this for you?” draft (`data.disclosure`), which they may edit. Only the owner's post publishes it. Discarding the draft shares nothing.
- **No.** Nothing is shared. The room gets a neutral line from code: “Akash chose not to share that.”
- **Free-form answers.** When the owner's setting for the asker is `ask`, or the room's budget is spent, someone else's question does not run the model. Instead a card with `mode: "answer"` asks the owner (“Ben asked me: “…”. Answer it? It uses your credits.”). Yes runs the room-bound turn (`reason: answer`); no posts “Akash chose not to answer that.” The owner's own public questions are never held.

### 12.5 Trust, status and away

Each person decides, per room, what their lead may do for everyone and for each person without asking (`GET/PUT /api/node/rooms/:id/trust`, stored on their own row as `node_room_members.prefs`). These are the person's choices, not product limits.

| Setting | Options | Default |
| --- | --- | --- |
| `status` | `answer`, `ask` | `answer` |
| `statusDetail` | `nothing`, `titles`, `details` | `titles` |
| `shareSpaceArtefacts` | `answer`, `ask` | `answer` |
| `shareOther` | `ask`, `never` | `ask` |
| `workRequests`, `acceptKinds` | `ask`, or `accept` for the kinds in `acceptKinds` (only `review` and `work` need accepting; the lead answers questions and shares) | `ask` |
| `freeFormAnswers` | `allow`, `ask` | `allow` |
| `budget` (per room) | included credits a month, or none | none |

A public answer is read by the whole room, so what it may disclose (status, detail, shared space, other items) follows the most careful setting for anyone in the room. Free-form answers and work requests follow the asker's own. The budget counts the credits of the owner's room-bound turns asked by others this month (UTC).

**Status cards** (`node/status-cards.ts`), per person and room, built by code:

| Part | Shown at |
| --- | --- |
| Lead, presence (online: an open Node stream, or a message in this room in the last 5 minutes; away; offline), away status | Every level |
| Missions for this room (started here or delivering here; live, or ended in the last 3 days): title and status | `titles`, `details` |
| Tasks assigned to them in the room's bound space, open ones, when every reader can open that space | `titles`, `details` |
| Requirement status, steps done, due dates | `details` |

`GET /api/node/rooms/:id/status` shows each card as the caller may see it, their own in full. `status: ask` shows presence only. `@leads status` posts one `status` message with `data.type: "status_cards"`, `cards` and `replyTo`: in public with the room-wide view, or privately to the asker with theirs.

**Away.** `PUT /api/node/rooms/:id/status {away: true, until?, note?}` (ends at `until`), or `{away: false}`. The lead's room-bound turns are told, say so, answer status, and leave work for the owner. Work they would accept automatically waits too.

### 12.6 Peer requests

A **peer request** (`node_peer_requests`, `node/peer-requests.ts`) is a record, not a chat: room, from (a person, and their node when it relayed it), to (a person, through their lead), `kind`, `text`, `refs`, `candidate`, `status`, `answer`, `missionId`, and its two cards. It is made from the composer (`POST /api/node/rooms/:id/requests {to, kind, text, refs?, candidate?}`, `to` an account id or a handle), from My crew (`node_peer_request`, attributed to the person and relayed by their lead), or by a lead recording someone's request for work for its owner. Leads never negotiate with each other in public.

| Kind | Flow |
| --- | --- |
| `question`, `share` | The target's lead answers in the room, as a room-bound turn (`reason: request`), with only what the room may see. Private information goes through a disclosure card. `open` → `answered`, or `awaiting_owner` while a draft or card waits for the owner; a draft the owner discards declines it. |
| `work` | Nothing runs before the target owner accepts. Their private card (`data.type: "peer_request"`) offers Accept (optionally editing the text), Decline with a note, and Always accept requests like this (their trust for that person: `workRequests: accept` and the kind). Accepting gives their lead one private turn in My crew (operation `request:<id>:accepted`) to plan it with `node_plan`. Its mission records `requestedBy {accountId, nodeId, roomId, requestId, kind}`, `deliverTo {roomId, audience: room}` and `principals` (`missionOriginFor`, called where `node/plans.ts` makes missions). When the mission ends, code marks the request `done`, with the mission's final status and requirement states on the public card. The lead's report stays in My crew, for the owner to share. |
| `review` | A `work` request whose candidate is pinned: a commit (7 to 64 hex characters) with its repository, or a URL. On accepting, the mission's constraints carry the repository, `publish: none` and notes: a fresh clone at exactly that commit, no secrets, sandboxed with network only for the checks, pass or fail with each check, and no repair. Ensemble does not yet grant the reviewer read access to the commit (for example on GitHub). |

Statuses: `open`, `answered`, `awaiting_owner`, `approved`, `declined`, `done`, `cancelled`. The public card (`request` message) is updated in place; every change sends `node.request` to the room's people. The requester sees status and public answers (`GET /api/node/rooms/:id/requests`); the target owner also sees their card and the mission. Accept and decline are the target owner's alone (`POST /api/node/requests/:id/accept|decline`, or their card in Needs me); the requester may cancel one nobody has decided yet. A decision checks that the other person is still in the room, and so does the delivery when the work ends.

### 12.7 Share to room

`POST /api/node/messages/:id/share {as: me|lead}` publishes one of the owner's own private messages, or their own node's private reply, in the room. As `me` it is the person's message; as `lead`, their lead's, with `data.sharedBy`. Both keep `data.sharedFrom {id, seq, authorKind, authorNodeId}`, refs and files. A shared message wakes nobody, and sharing the same message twice returns the first copy.

### 12.8 Leaving

A person who leaves, or whom the room's creator removes, takes their nodes along (§9). In the same transaction:

- the trust others in the room gave them goes;
- their undecided requests, made or received, are cancelled;
- their nodes' queued conversation turns there are dropped (plan turns stop as for any removal);
- pending cards for them or about them there expire: their own cards, disclosures they asked for, and requests they made. Answering one gets 409.

Requests already accepted go on as the owner's own work; their delivery checks again that both people are still there.

### 12.9 Migration

Migration `20261110120000_node_rooms_v2` switches every room with other people to v2: `settings.version = 2`, one status line (“This room now follows rooms v2: only leads answer in public, and only when addressed. Use My crew to talk to your own nodes.”), and its nodes' shared-thread conversations start afresh, so no room-bound turn sees history from before. History is kept. Rooms made since are v2 from the start.

### 12.10 Card data

| Message | `data` |
| --- | --- |
| Public request card (`kind: "request"`, system) | `{type: "peer_request", requestId, kind, status, text, refs, candidate, from {accountId, name, handle, nodeId, nodeHandle}, to {accountId, name, handle, leadNodeId, leadHandle}, answer, answerMessageId?, outcome, requirements [{text, status}], taskId, mode, updatedAt}` |
| Target owner's card (`kind: "approval"`) | `{type: "peer_request", status: pending\|applying\|accepted\|declined\|cancelled\|expired, requestId, kind, text, refs, candidate, from {accountId, name}, nodes [{handle, name, role, lead}], cost, note?}`; with a proposed task also `taskId`, `modes: ["private", "shared"]`, `defaultMode: "private"` (§12.11) |
| Space offer (`kind: "status"`, system, private to the person) | `{type: "space_offer", status: pending\|joined\|declined\|expired, spaceId, spaceName, ownerName, role: "editor"}` |
| Space linked or unlinked (`kind: "status"`, system) | `{roomSpace: {spaceId, action: bound\|unbound}}` |
| Disclosure card (`kind: "approval"`) | `{type: "disclosure", mode: share\|answer, status: pending\|applying\|approved\|declined\|expired, key, asker {accountId, name}, question, need, triggerMessageId, requestId, shared?, why?}` |
| Status cards (`kind: "status"`, system) | `{type: "status_cards", cards [{accountId, name, handle, lead, presence, away, detail, asks, missions, tasks}], replyTo {id, seq}}` |
| Shared message (`kind: "text"`) | `{sharedFrom {id, seq, authorKind, authorNodeId}, sharedBy? (as lead), refs?, files?}` |
| A draft answering someone (`kind: "approval"`, `type: "post"`) | adds `disclosure` (card id) and/or `peerRequest` (request id) |

### 12.11 The room's shared space

The room is the conversation; a space holds its work (build block C4; `node/room-space.ts`). The room's creator links a space they own, or makes one for it (“Room space”; [28](28_ENSEMBLE_SPACES.md)). The link is `settings.spaceId`. A room's settings keep every key through edits and pins (`roomSettings` in `node/store.ts`), so `version` and `spaceId` survive.

- **Linking** posts one status line and offers each other person membership as an **editor**: a private card (`space_offer`) with Join and Not now. Joining the room is not joining its space; that is a separate yes (`POST /api/node/rooms/:id/space/join {join}`). Someone who joins the room later is offered it then. Not now can become Join later. Joining adds them for the space's owner, who offered it by linking the space, within the owner's sharing limits ([29](29_SHARING.md) §1); at the limit the person is told the owner can raise it in Settings › Sharing.
- **Unlinking** (`DELETE …/space`) leaves the space, its board and its members as they are; pending offers expire.
- **Room-bound turns** reach the linked space only, with the person's own role there (§12.3). A viewer's nodes read and never write; the space owner's connected apps never reach members' nodes ([29](29_SHARING.md) §2).
- **The Board tab** reads `GET /api/node/rooms/:id/board`: the space's tasks (not dropped), each with `assignee`, `requestedBy` (with the node that relayed it), `peerRequestId` and `madeBy` (“@node for person”), for the space's owner and members only.

**Work becomes a proposed task.** A `work` request (§12.6) between two current editors of the linked space (its owner counts) becomes a `proposed` task there, assigned to the person asked, with who asked (`requested_by_account_id`, `requested_by_node_id`), `peer_request_id` and `source_ref` `room-request:<id>` ([05](05_MODULE_TASK_ORCHESTRATOR.md)). Otherwise it stays a private card only. The target owner's card names the task and asks the one question when accepting:

| Mode | Where the mission runs | What members see |
| --- | --- | --- |
| `private` (default): private work, shared result | The assignee's own space (`node_missions.space_id` null) | The result and evidence delivered to the task, never the run's transcript or code |
| `shared`: shared run | The linked space (`node_missions.space_id`); the lead's note says to work there | The run, as for any member's run there |

`POST /api/node/requests/:id/accept {text?, always?, mode?}` records the mode on the request. The task follows the request: accepted → In progress (with the edited text as its title), declined or cancelled → Dropped. The Hub's proposals tile answers it too. The mission's `deliverTo` carries `taskId`.

