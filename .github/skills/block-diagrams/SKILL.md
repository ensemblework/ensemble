---
name: block-diagrams
description: Draw and edit Ensemble block diagrams from facts already in the workspace. Use when the person asks for a diagram, flowchart, architecture sketch, pipeline, or a picture of a repo, project, or task.
---

# Block diagrams

You draw diagrams by writing Ensemble diagram text and saving it with the diagram tools. The person edits on the canvas. You do not invent boxes.

The language reference is `docs/21_BLOCK_DIAGRAMS_DSL.md`. This skill is how to decide what to draw.

## Tools

Reads:

- `hub_list_diagrams` — diagrams this person already has.
- `hub_get_diagram` — one diagram’s text, so you can edit it.
- `hub_validate_diagram` — parse the text and return diagnostics. It does not save.
- `hub_explain_diagram` — a plain-language reading of one diagram. Use it when they ask what a diagram says, including someone who does not write software.
- `hub_diagram_context` — the bounded text of a task, project, deliverable, or page: title, notes, page text, deliverables, tasks, meeting notes, and linked repo ids. Call this before drawing from a task, project, deliverable, or page.
- `hub_repo_overview` — a compact summary of a repository. A saved link is enough. You do not clone, and you do not call GitHub yourself. The server uses an allowed checkout, a cached shallow mirror, or the GitHub API.
- `hub_repo_read_file` — one file from that same checkout or mirror, when a heading is ambiguous.

Writes (the person presses Apply; until then say “Ready to apply”, not “I created it”):

- `hub_create_diagram` — `title`, `text`, and optional `links` (`task`, `deliverable`, `project`, `repo`, or `page`, each with an id you already have).
- `hub_edit_diagram` — semantic edits that keep ids, locks, and layout: `add_node`, `remove_node`, `rename_node`, `add_edge`, `remove_edge`, `move_to_group`, `set_node`, `set_curve`, or one `patch` find/replace. Prefer this when a diagram already exists.
- `hub_update_diagram` — replace the whole `text`, or a single unique `find` / `replace`. Keep ids.

If a name is not in `hub_diagram_context`, a repo overview, a file you read, or the person’s message, it is not in the diagram.

## When to draw

Draw when the person asks for a diagram, a flowchart, an architecture picture, or “show me how X fits together”.

Do not draw when they asked for a task, a deliverable, or a paragraph. Offer a diagram only if the structure is the point of the answer.

One request, one diagram, unless they asked for several or the picture will not fit in 20 blocks.

## Which kind

Pick the kind from the facts, then name blocks after those facts.

| Kind | Use it when | Direction | Typical shapes |
|---|---|---|---|
| Flowchart | A person or job moves through steps and a question | down | circle start, rectangle step, diamond question, rounded screen |
| Architecture | Services and the stores they call | right | server, cylinder, cloud, rounded app |
| Sequence-style | A few parties and the messages between them, in order | right | actor or rectangle per party; edge labels are the messages |
| Data pipeline | Records move from a source, through jobs, into a store | right | parallelogram input, server job, cylinder store |
| ER-ish | A handful of records and how they point at each other | right | rectangle entity, edge label is the relationship |
| Org | People and who they report to | down | actor |
| Decision tree | One question splits into outcomes | down | diamond, then a short chain per answer |
| Repo or module map | The parts of one repository the workspace actually names | right | rectangle module, group per area |

Sequence-style is still boxes and arrows. Do not invent a lifeline syntax. Put the parties in a row and label each arrow with the message.

An ER-ish diagram names entities and relationships. It is not a full schema. Skip columns unless the person listed them.

## Gather facts first

1. If they named a task, project, deliverable, or page, call `hub_diagram_context` with that id. Use the title, description, notes, page text, deliverables, tasks, and meeting notes it returns. Link those ids.
2. For each repo id in that payload, or when they named a repo (`@` a repository, or “diagram of <owner/name>”), call `hub_list_repos` if you still need the id, then `hub_repo_overview` once. Draw only apps, services, stores, and files the overview names. Read one or two files with `hub_repo_read_file` when a heading is ambiguous. Link the repo id. Do not clone the repo and do not browse GitHub yourself.
3. If they pasted a tree, a manifest, routes, or a schema, use only the names in that paste.
4. Read an existing diagram with `hub_get_diagram` before you change it. Refine it with `hub_edit_diagram`.
5. Call `hub_explain_diagram` when they want the picture described in sentences.

Every block label must appear in that material or in the person’s own words. A box called “Auth service” is allowed only if something you read says so. Prefer fewer true boxes over a plausible architecture.

If the material is too thin (a repo name and nothing else), draw that one box and say what you could not see. Do not fill the gaps.

## Names, ids, labels

- Quote every label: `node api "API" shape server`.
- The id is short, stable, and lowercase: `api`, `users-db`, `valid`.
- The label is what a person reads. It can have spaces.
- Refer to ids on edges, not to the label text.
- Never reuse an id. Never rename an id on an edit unless the person asked.
- Do not use ids `straight`, `curved`, `elbow`, `curve`, `shape`, or `color`.

## Size

Aim for 7 to 20 blocks. Under 7 is fine when the facts are few. Over 20, split into two diagrams or put a cluster in a `group`.

A group is a dashed frame with a label, not a new system. Example: a group `edge` around the web and mobile apps, a group `data` around the databases.

## Direction and curves

- `direction down` for flows, orgs, and decision trees. Fit vertically in the editor does the same.
- `direction right` for architecture, pipelines, ER-ish maps, and repo maps. Fit horizontally does the same.
- Leave `layout` out of a new diagram. The editor places the blocks when it opens.
- `curve` defaults to `straight`. Set `curve elbow` for architecture and ER-ish maps (right-angle connectors). Set `curve curved` only when a flow should feel soft. One diagram-level line is enough.
- Add `curve` on a single edge only when that edge should differ: `edge api > cache curve curved : "optional"`.

## Shapes

Leave `color` off. The shape already has a colour.

| Shape | Means |
|---|---|
| rectangle | a step, module, or service with no stronger shape |
| rounded | a screen |
| diamond | a decision |
| circle | start or end |
| cylinder | a database or store |
| server | a service or machine |
| parallelogram | input or output data |
| document | a file or report |
| cloud | something outside this system |
| actor | a person |
| hexagon | a check or a gate |
| note | a note stuck on the diagram |
| trapezoid | a manual step |

`text` is a caption, not a block. It cannot take an arrow.

Colour overrides are rare. `color red` on an error step is enough. Do not paint every block.

## Edges

- `edge a > b` is a solid arrow.
- `edge a --> b` is dashed.
- `edge a -- b` has no arrowhead. Use it for a lookup or a relationship that is not a step.
- `edge a > b : "yes"` labels the line. Keep labels to one or two words.
- One edge, one fact. Do not draw both directions unless both are in the source.
- A chain `edge a > b > c` is two edges. Prefer separate lines so each can have a label.

## Self-check

Before `hub_create_diagram` or `hub_update_diagram`:

1. Call `hub_validate_diagram` with the full text.
2. If `errors` is not 0, fix the lines it names and validate again.
3. If `warnings` is not 0, fix those too. A warning means a block was invented or a word was skipped.
4. Save only when `ok` is true.
5. On create, pass `links` for every id the person pointed at.

Do not call the write twice while it is waiting for Apply.

## Editing an existing diagram

1. `hub_list_diagrams` if you do not have the id, then `hub_get_diagram`.
2. Prefer `hub_edit_diagram`. A locked block cannot be removed or moved. Rename and colour changes keep the lock. Ids and layout lines stay.
3. `add_node` needs `label` and usually `shape`. `add_edge` needs `from` and `to`. `rename_node` needs `id` and `label`. `set_node` sets `shape` or `color`. `set_curve` sets the diagram curve, or one edge when `edge` is set. `patch` is one unique `find` / `replace`.
4. The Apply card shows the added, removed, and changed blocks. Do not describe a change you did not send.
5. Validate, then the write. A full `hub_update_diagram` text replace must still contain the layout and locks you did not mean to drop.

## Common mistakes

- Boxes that were not in the repo, project, task, or message.
- A diagram of a whole company when the task is one route.
- More than 20 blocks in one picture.
- Colours on every node.
- `curve` on every edge when the diagram already sets it.
- New ids for blocks that already exist.
- Rewriting `layout` and clearing locks.
- Saying the diagram exists before Apply.
- A second diagram when they asked to edit the one in the list.

## Worked examples

### A task that names three steps

Facts from `hub_get_task`: title “Login”, description “User submits the form. If the password matches Users, open the dashboard. Otherwise show an error.”

```udl
title Login
direction down

node start "Start" shape circle
node form "Submit form" shape parallelogram
node check "Password matches?" shape diamond
node home "Dashboard" shape rounded
node err "Show error" shape rounded
node users "Users" shape cylinder

edge start > form
edge form > check
edge check > home : "yes"
edge check > err : "no"
edge form -- users : "lookup"
```

Link `task` to that task id. Users is in the description, so the cylinder is fair. Do not add “session service”.

### A task, from hub_diagram_context

`hub_diagram_context` for the task returns a description “The clinic web app calls the API. The API stores visits in Postgres.” and a project named “Clinic visits”.

```udl
title Clinic visits
direction right
curve elbow

node app "Clinic web app" shape rounded
node api "API" shape server
node db "Postgres" shape cylinder

edge app > api
edge api > db
```

Link `task` to that task id. Do not add a box the context did not name.

### This monorepo, from hub_repo_overview

`hub_repo_overview` for `ensemblework/ensemble` names apps `hub-web`, `hub-api`, `agent-runtime`, `context-bridge`, and `skill-forge`. Compose services are `postgres` and `redis`. A notable file is `apps/hub-web/components/shell/quick-capture.tsx`. skill-forge is drawn because the overview names it, and it gets no arrow because nothing read says what it calls.

```udl
title ensemblework/ensemble
direction right
curve elbow

node web "hub-web" shape rounded
node api "hub-api" shape server
node agent "agent-runtime" shape server
node bridge "context-bridge" shape cloud
node forge "skill-forge" shape rectangle
node capture "quick-capture" shape rectangle
node db "Postgres" shape cylinder
node cache "Redis" shape cylinder

edge web > api
edge agent > api
edge bridge > api : "read"
edge web > capture
edge api > db
edge api > cache
```

Link `repo` to that id. Postgres and Redis are the compose services. quick-capture is a file under hub-web, so it hangs off the web app. Do not add a queue, an auth service, or a second database.

### A repo description that names parts

Description: “Next.js app. API routes in app/api. Prisma schema for Account and Invoice. Stripe webhooks.”

```udl
title acme/billing
direction right
curve elbow

node web "Next.js app" shape rounded
node api "API routes" shape server
node db "Account and Invoice" shape cylinder
node stripe "Stripe" shape cloud

edge web > api
edge api > db
edge stripe > api : "webhook"
```

Those four names are in the description. Do not add Redis, a queue, or an admin app.

### Architecture with a group

Project summary: “Clinic web app and the worker share one API. The API stores visits in Postgres.”

```udl
title Clinic
direction right
curve elbow

group clients "Clients" {
  node web "Web app" shape rounded
  node worker "Worker" shape server
}
node api "API" shape server
node visits "Visits" shape cylinder

edge web > api
edge worker > api
edge api > visits
```

Link the project id.

### A pipeline from a pasted note

The person pasted: “Nightly job reads the CSV export, writes rows to the warehouse, then the report job builds the PDF.”

```udl
title Nightly import
direction right

node csv "CSV export" shape parallelogram
node load "Nightly job" shape server
node warehouse "Warehouse" shape cylinder
node report "Report job" shape server
node pdf "PDF" shape document

edge csv > load
edge load > warehouse
edge warehouse > report
edge report > pdf
```

### A decision, kept small

Task: “If the PR has tests, merge. If not, request changes.”

```udl
title Review
direction down

node pr "Pull request" shape document
node tests "Has tests?" shape diamond
node merge "Merge" shape rectangle
node changes "Request changes" shape trapezoid

edge pr > tests
edge tests > merge : "yes"
edge tests > changes : "no"
```

### Editing without moving locked blocks

Existing text includes `node desk "Desk" shape rectangle locked` and a `layout` section that places `desk`. The person says “rename Desk to Front desk”.

Prefer `hub_edit_diagram` with one op: `{ "op": "rename_node", "id": "desk", "label": "Front desk" }`. The id stays `desk`. The lock and the layout line stay. Validate if you are unsure, then the write. Do not send a full text that omits `layout`.

### Adding a block without dropping locks

The diagram already has locked `node api "API" shape server`. The person says “add Redis, the API uses it.”

`hub_edit_diagram` ops:

- `{ "op": "add_node", "id": "cache", "label": "Redis", "shape": "cylinder" }`
- `{ "op": "add_edge", "from": "api", "to": "cache", "label": "uses" }`

The Apply preview lists the added block and the added arrow. `api` stays locked.

### Two diagrams instead of one crowded map

A pasted tree has 30 packages. Draw the top-level folders as one diagram (one block per folder, grouped if the paste groups them). Offer a second diagram only for the folder they ask about. Do not draw all 30 packages in one picture.
