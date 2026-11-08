# Context Bridge

The Context Bridge is Ensemble's MCP server for editors and agents. An agent uses it to read Ensemble: a brief for its task (where the task came from, who asked, the people and their roles, related work), any record and what it links to (the context graph, [03 §5](03_MODULE_CONTEXT_ENGINE.md#5-shared-retrieval-and-briefs)), ranked search, tasks, projects, repositories, skills, deliverables, calendar, people, Needs me, files, diagrams and plots. A key made with changes allowed also runs Ensemble's everyday writes (tasks, pages, boards, diagrams, plots, files, projects, people, deliverables, meeting notes, comments; §5.1), and a key made with apps allowed uses the apps the person connected to Ensemble (§5.2).

The server is `apps/context-bridge`. It calls hub-api's `/api/bridge` routes over HTTP. It never opens the database or holds model or app keys. The editor runs its own model; Ensemble supplies the records, runs the actions with the assistant's own tools, and calls the apps with the person's connections.

## 1. Three ways to reach it

| Way | For | How |
|---|---|---|
| **Ensemble CLI** | Hosted-site users on any OS | Install the CLI, `ensemble login`, then `ensemble mcp setup`. Editors run `ensemble mcp` (stdio), which calls `https://api.ensemblework.com/api/bridge/*` with the CLI's key: read-only unless task updates were allowed at `ensemble login` (§4, [26](26_CLI.md)) |
| **Hosted URL** | Editors that accept a URL; nothing to install | `POST https://api.ensemblework.com/mcp` with `Authorization: Bearer ens_…` (a key from Connect your apps). Served by hub-api (`src/routes/mcp.ts`), stateless Streamable HTTP ([26 §5](26_CLI.md#5-mcp-local-cli-or-hosted-url)) |
| **From source** | Developers running this repository | `pnpm bridge:build`, then the editor launches `node apps/context-bridge/dist/index.js` (§3) |

All three use `buildServer` from `apps/context-bridge/src/server.ts` (exported as `@ensemble/context-bridge/server`, with `./hub` and `./config`), so the tools are the same. The write tools are registered when the key may make changes and the app tools when it may use apps: the hosted endpoint reads that from the request's key, the CLI and the source build ask `GET /api/bridge/whoami` once at start (`buildServerForKey`). The hosted endpoint cannot see the editor's folder or disk, so `ensemble_brief` needs `task`, or `repo` and `branch`, there, and `ensemble_upload_file` takes the file's bytes (`dataBase64`) rather than a path; the CLI and the source build read the repository and branch from the working directory (`git rev-parse` and `origin`) and read a file from its `path`. Everything else (actions, connected apps) runs on Ensemble's side, so both ways have it.

## 2. Architecture

```text
Editor / MCP client
    → stdio bridge | loopback HTTP bridge | hosted /mcp
    → apps/context-bridge/src/server.ts (buildServer)
    → hub-api /api/bridge routes, scoped to the key's account and space
    → bridge/service.ts over saved workspace records
```

| Path | Responsibility |
| --- | --- |
| `apps/context-bridge/src/server.ts` | MCP tools and resources, their annotations; the write tools only for a key that may make changes, the app tools only for one that may use apps |
| `apps/context-bridge/src/hub.ts` | HTTP client for hub-api, auth and errors |
| `apps/context-bridge/src/config.ts` | Environment, token rules, local runtime discovery |
| `apps/context-bridge/src/git.ts` | Repository and branch from the working directory |
| `apps/hub-api/src/bridge/routes.ts` | Read routes |
| `apps/hub-api/src/bridge/write-routes.ts` | `whoami`, the task writes and file uploads (§5.1) |
| `apps/hub-api/src/bridge/actions.ts`, `action-routes.ts` | The actions allowlist, listing and running actions and app tools (§5.1, §5.2) |
| `apps/hub-api/src/bridge/service.ts` | Queries, reads, brief assembly, pagination; context and search over `context/graph/` |
| `apps/hub-api/src/bridge/resolve.ts` | Repository, branch and task resolution |
| `apps/hub-api/src/bridge/auth.ts` | Which credentials the bridge accepts, and which may write |
| `apps/hub-api/src/bridge/gaps.ts` | Exclusion and missing-data text for `ensemble_gaps` (§7) |
| `apps/hub-api/src/routes/mcp.ts` | Hosted Streamable HTTP |

MCP server-info reports the release version from `@ensemble/shared-types/version`.

## 3. Run it from source

```bash
pnpm bridge:build          # tsc → apps/context-bridge/dist
pnpm bridge:start          # stdio (what editors launch)
pnpm bridge:http           # Streamable HTTP on 127.0.0.1:4010
pnpm bridge:verify         # hub-api bridge tests, then typecheck, MCP tests, build, smoke
```

hub-api has to be up (`pnpm dev`), or every tool returns: ``Ensemble is not running. Start it with `pnpm dev`.``

The bridge calls `HUB_API_URL`, else the local desktop or CLI runtime from its `api.json` ([DESKTOP](DESKTOP.md) §3.2), else `http://$HUB_API_HOST:$HUB_API_PORT` (default `127.0.0.1:4000`). Found through `api.json`, it uses that file's launch token and reads the file again before each call, so a restarted app (new port and token) keeps working; tools then say *The Ensemble app is not running on this computer* when it is closed. This is how editors use a local-only desktop app without the CLI: Connect your apps there shows the command (`GET /api/desktop/mcp`, [DESKTOP](DESKTOP.md) §1.2).

## 4. Token

The Hub's **Connect your apps** page (`/connect`) creates a key, fills in this computer's paths and offers one-click install for VS Code and Cursor.

1. **Connect your apps → Create a key.** The value starts with `ens_` and is shown once. It can read `/api/bridge`, call `/mcp`, run the read actions and revoke itself at `/api/cli/logout`. Two grants, both ticked by default (`POST /api/connect/token`):
   - **Let editors and agents make changes** (`canWrite`, `api_tokens.can_write`): the task writes, file uploads and every write action on the allowlist (§5.1).
   - **Let editors and agents use your connected apps** (`canUseApps`, `api_tokens.can_use_apps`): the apps' tools through Ensemble (§5.2); changing something in an app also needs the first grant.

   The key list shows each key's grants. Keys made before 0.7.1 only read (their task-update grant was narrower and was reset): make a new key, or run `ensemble login` again (the `/link` page asks the same two questions). A key made under Settings → Connections → Editors & agents is a full key: it has both and can drive editor hooks.
2. Export it where the editor can see it:

```bash
export ENSEMBLE_BRIDGE_TOKEN=ens_...
```

`ENSEMBLE_BRIDGE_TOKEN` must start with `ens_`. With no token and no `HUB_API_URL`, the bridge uses a running desktop or CLI runtime's launch token from `api.json`. Otherwise every tool returns a configuration error; the bridge never falls back to the default internal token.

hub-api's `ENSEMBLE_INTERNAL_TOKEN` is the agent-runtime service credential and defaults to `dev-internal-token`, which hub-api warns about at startup. The bridge uses it only with `ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN=true`, and refuses the default value unless `ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true` is also set (local demos only, never on a shared network). Set a private one (`openssl rand -hex 32`) if anything besides this machine can reach port 4000. `ENSEMBLE_DEV_AUTH_BYPASS` is refused on `/api/bridge/*`.

Creating and revoking keys is a signed-in account action; a bridge key cannot mint another key.

## 5. Tools and resources

| Tool | Resource | Data |
|---|---|---|
| `ensemble_brief` | — | The task: `task` (an `ensemble://task/<id>` handle, a Hub link, its id or its exact open title), else repository + branch. `workContext` is the task's context packet (`context/graph/packet.ts`, at most 7,000 characters: where it came from with the words asked, project, people with roles and relationship, dependencies, related open work, done before, each with a handle) and `contextRef` its handle; plus project, people, deliverables, files attached to the task, current skills (`howIWork`) and cited excerpts (`context`) |
| `ensemble_context` | — | One record and what it links to (`GET /api/bridge/context`): `item` is a handle, a Hub link, or an id with `kind` (task, project, person, repo, deliverable, meeting, file, page, event). Returns the record and its relations, 6 each, every card with a `ref` to call again; `rel` lists one relation in full, paged with `offset` and `limit` (≤50); `format=packet` returns the Markdown packet (8,000 characters) |
| `ensemble_search` | — | Ranked word search (`context/graph/search.ts`) across tasks, projects, people, repositories, deliverables, meeting notes with transcripts, standalone pages, files (by name, kind `document`), saved app items, skills, diagrams and plots; `kinds` filters, `near` (a handle) ranks what links to it first. Up to `limit` × 3 hits (at most 40), each with `ref`, `score` and `why` |
| `ensemble_read` | `ensemble://items/{kind}/{id}` | One item in full, paginated with `offset` and `limit`. Kinds: task (with its meeting, dependencies, labels and deliverable), project, repo, skill, deliverable, person, artifact, document, meeting_note or meeting (the whole transcript, its people and the tasks made from it; a notes session's id reads its notes), approval, decision, diagram, plot, page |
| `ensemble_tasks` | `ensemble://tasks`, `ensemble://tasks/{id}` | Tasks |
| `ensemble_projects` | `ensemble://projects`, `ensemble://projects/{id}` | Projects |
| `ensemble_repos` | `ensemble://repos`, `ensemble://repos/{id}` | Repositories |
| `ensemble_repo_overview`, `ensemble_repo_file` | — | Outline and source of a checkout the person already allowed; secrets and protected paths are skipped |
| `ensemble_diagrams`, `ensemble_plots` | — | Saved diagrams and plot context |
| `ensemble_skills` | `ensemble://skills`, `ensemble://skills/{id}` | Current enabled skills; one skill's current body |
| `ensemble_deliverables` | `ensemble://deliverables` | Deliverables |
| `ensemble_meetings` | `ensemble://meetings` | Upcoming calendar events (`Artifact` kind `event`) from Google Calendar, Outlook and calendar links, one row per event ([03 §2.5](03_MODULE_CONTEXT_ENGINE.md#25-the-today-calendar)), each with `previous`: the latest earlier meeting of its series ([03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context)) |
| `ensemble_people` | `ensemble://people`, `ensemble://people/{id}` | Engineer Graph people |
| `ensemble_decisions` | `ensemble://decisions` | Needs me: pending approvals and editor prompts (read only) |
| `ensemble_today` | `ensemble://today` | In the person's time zone: focus, proposed todos, tasks ready for review (`waiting_approval`), what others owe (open tasks labelled `waiting-on`), deliverables, meetings, Needs-me counts |
| `ensemble_gaps` | `ensemble://gaps` | What the bridge cannot see or refuses to expose |

### 5.1 Changes in Ensemble

`ensemble_actions` and `ensemble_act` are offered to every key; the other write tools only to a key that may make changes (§4). `read-only.ts` refuses to start with a write-named tool outside `ensemble_create_task`, `ensemble_update_task` and `ensemble_upload_file`.

| Tool | Route | What it does |
|---|---|---|
| `ensemble_actions` | `GET /api/bridge/actions` (`groups`, `names`, `schema`) | The actions this key may run, by group (`tasks`, `pages`, `boards`, `diagrams`, `plots`, `files`, `projects`, `people`, `meetings`, `comments`, `guides`), each with `write` and `allowed` (and `refusal` when not). With `names`, their full descriptions and `inputSchema` |
| `ensemble_act` | `POST /api/bridge/act/:name` `{input}` | Runs one action: the assistant's own Hub tool of that name (`bridge/actions.ts` `BRIDGE_ACTIONS`), with its validation, access checks, Undo entry and live refresh, at once (no Apply). A wrong input is a 400 with the action's `inputSchema`. Writes need changes allowed, are ledgered as `bridge.<tool>` with the key's name and answer `undoable` |
| `ensemble_create_task` | `POST /api/bridge/write/tasks` | `{title, page?, projectId? \| projectName?, due? (YYYY-MM-DD), people? (names or ids), status? (proposed, default, or todo), from? (a handle)}`. Adds a task through `createTask` with actor `agent`: `page` becomes its page, `from` adds a `Related:` link to that record, names become person ids where one person has that name |
| `ensemble_update_task` | `PATCH /api/bridge/write/tasks/:id` | `{status? (in_progress, waiting_approval, done, blocked, todo), note?, matchTitle?}`. A status follows the task state machine (a refused move lists the allowed ones); `note` is added to the task's page as an agent block titled "Update from <key name>"; a `matchTitle` that differs is a 409 |
| `ensemble_upload_file` | `POST /api/bridge/write/files` | `{filename, dataBase64, mediaType?, attachTo?, summarize?}`; through the CLI or a source build, `path` (a file on the editor's computer) instead. Saved through `POST /api/documents` (the same checks, caps and text extraction as an upload in Files); `attachTo` (a task, page, project, person or repository handle) tags the file, and for a task or page adds `[@file](ensemble://file/<id>)` to the end of its page. Ledgered as `bridge.file.upload` |

The allowlist (each name is the assistant's tool, [34](34_ASSISTANT_ACTIONS.md)):

| Group | Reads | Changes |
|---|---|---|
| guides | `hub_how_to` (the assistant's playbooks: boards, diagrams, plots…) | — |
| tasks | `hub_list_tasks`, `hub_get_task`, `hub_read_task_page`, `hub_list_due` | `hub_create_tasks`, `hub_update_task` (title, status, owner, priority, due, labels, people, project, repository, deliverable, page), `hub_delete_task` (one, to Trash) |
| pages | `hub_list_pages`, `hub_read_page`, `hub_read_page_blocks` | `hub_create_page`, `hub_update_page`, `hub_edit_page`, `hub_move_page`, `hub_delete_page` (one, to Trash). People and records are linked in a page as `[@Name](ensemble://person/<id>)` |
| boards | `hub_list_boards`, `hub_read_board` | `hub_create_board`, `hub_update_board`, `hub_move_to_board` (a task or page into a column), `hub_remove_from_board`. Task status columns on the Ensemble board move with `hub_update_task` |
| diagrams | `hub_list_diagrams`, `hub_get_diagram`, `hub_validate_diagram`, `hub_explain_diagram`, `hub_diagram_context` | `hub_create_diagram`, `hub_update_diagram`, `hub_edit_diagram` |
| plots | `hub_list_plots`, `hub_get_plot`, `hub_list_datasets`, `hub_get_dataset` | `hub_import_dataset`, `hub_create_plot`, `hub_update_plot` |
| files | `hub_list_files` (a file's bytes and Ensemble's extracted text are never sent, §5) | `hub_file_to_page`, `hub_export_page_file` (a new file only), and with apps allowed `hub_save_app_item_as_page`, `hub_import_app_file` |
| projects | `hub_list_projects`, `hub_list_deliverables` | `hub_create_project`, `hub_update_project` (name, summary, notes, status, people, repositories), `hub_create_deliverable`, `hub_update_deliverable`, `hub_complete_deliverable` |
| people | `hub_list_people`, `hub_list_repos` | `hub_create_person`, `hub_update_person` (role, team, relationship to the person), `hub_link_repo`, `hub_unlink_repo`, `hub_update_repo` |
| meetings | `hub_list_meeting_notes`, `hub_read_meeting_note` | `hub_create_meeting_note`, `hub_update_meeting_note`, `hub_suggest_meeting_tasks` |
| comments | `hub_read_record_details` | `hub_manage_record`: comments, restore from Trash, a page into a task (`convert_page`), file tags, copying or deleting a plot or diagram, a diagram's earlier version (not deleting a dataset) |

An action runs in the key's own space as the person (route-backed tools call the API with the internal credential and `x-ensemble-user`), with the space's modules. A name the assistant has but the list does not (settings, skills, reminders, routines, imports, layouts, desk items, workflows, bulk deletes, deleting a board, person or deliverable, assigning to an agent, stopping runs) answers 404 naming the assistant and Ensemble Node.

`GET /api/bridge/whoami` answers `{canWrite, canUseApps, apps (connected app names), spaceName, keyName}`. Writes are refused (403) for a key without changes allowed, device and hook keys, and every other route; a signed-in page and a full key may use them. Each write refreshes open pages (`task`, `page`, `documents` or `assistant.acted` events). `POST /api/bridge/act/*` and `/api/bridge/write/*` share the hosted MCP rate limit (`mcp`, 240 a minute).

### 5.2 Connected apps

| Tool | Route | What it does |
|---|---|---|
| `ensemble_apps` | `GET /api/bridge/apps` (`app`, `names`, `schema`) | The apps connected in the key's space (`assistant/connections.ts`), what Ensemble can do in each, apps that are connected but broken, and their tools (with `inputSchema` for one `app` or named tools). A key without apps allowed gets `{allowed: false, refusal}` |
| `ensemble_app_call` | `POST /api/bridge/act/:tool` `{input}` | Calls one app tool with the person's own connection: the built-in Google Workspace, Microsoft 365, Zoom, DocuSign and Jira tools, `apps_search`/`apps_read`/`apps_post_update` across the apps Ensemble can search (Notion, GitHub, Linear, Slack, Figma, Vercel, Zotero, Hugging Face…, [31](31_CONNECTORS_IN_USE.md)), and each connected MCP server's own tools (`mcp_<server>_<tool>`) |

Both tools exist only for a key with apps allowed. App tools are offered and checked as for the assistant (`assistant/apps.ts`): the suite connected, the product switched on, the scopes granted; app writes are left out when Settings → Assistant turns connected-app writes off. A change in an app also needs changes allowed, runs at once through `runOutsideWrite` (ledgered as `apps.<tool>`), and cannot be undone from Ensemble. Calls run on Ensemble's server, so the hosted URL and the CLI reach the same apps and the editor needs no app keys.

### 5.3 What each way in can do

| | MCP (editors, agents, a run's server) | Hub assistant | Ensemble Node |
|---|---|---|---|
| Read Ensemble, context graph | Yes | Yes | Yes, in every space its owner can open |
| Everyday changes (§5.1) | With changes allowed; at once, Undo | Yes; Apply or at once, by write policy | Yes |
| Connected apps | With apps allowed | Yes | Yes |
| Settings, model choice, skills, reminders, routines, watchers, imports, layouts | — | Yes (settings and skills wait for Apply) | Yes |
| Bulk deletes; deleting boards, people, deliverables | — | Yes | Yes |
| Assigning work to agents, runs, Needs me | Reads Needs me | Yes | Yes, plus its own sessions, computers and crews |

A coding agent that Ensemble starts on a paired computer has `ensemble_actions` and `ensemble_act` in its run's own MCP server, under the job's lease, without the apps and only in its owner's own space ([30 §9](30_ENGINES.md)).

A resource URI is an MCP identifier, not permission to open local files. Reads are scoped to the key's account and space ([28](28_ENSEMBLE_SPACES.md)), and module and sharing checks still apply.

- **Files.** A `document` is a file's name, format, size, page count and link in Ensemble; its extracted text and summary are not sent, and search excerpts for a file show its name ([32](32_FILES.md), `files/extracted-text-policy.ts`). A task or page also lists its files. Original bytes are never sent.
- **Pages.** `apps/hub-api/src/pages/agent-context.ts` adds the source of diagrams embedded in task and standalone pages, with space ownership checks. For the bridge, page bodies are bounded at 15,000 characters and diagram source at 20,000, then paginated. Converted source documents appear in the page's file citations (`files/attached.ts`).
- **Skills.** Only the current body is returned. Older `SkillVersion` bodies are not exposed, and disabled or deleted skills are left out of briefs ([04](04_MODULE_SKILL_FORGE.md)).
- **Trust labels.** Mail, chat, GitHub text, calendar invites, approval previews and editor tool inputs are labelled `trust: "untrusted"`; skills are `trusted`. The brief repeats that retrieved text is reference material, not instructions.
- **Resolution.** A branch that matches no task, or several, is reported as such; the bridge never picks a similarly named task.

## 6. Limits

- Search is ranked word matching plus graph links, not semantic: `Artifact.searchVector` and `ArtifactChunk.embedding` exist in the schema but nothing fills or queries them; enabling an embedding provider does not change this.
- Excluded: private reminders, widget layouts, older skill bodies, approvals, and every change not on §5.1's list.
- Files return supported extracted text only, not original bytes, OCR, audio or video.
- Connected-app copies can be stale until refreshed; bridge reads do not call vendor search.
- The bridge returns stored text without a new redaction pass; ingest and file paths have their own redaction.
- There is no OAuth authorization-server flow for external MCP clients. Use stdio or a static `Authorization` header.

The task-scoped `scripts/ensemble-ask-mcp.mjs` server used inside managed engine runs asks questions for its run and runs the same actions under the job's lease. It is not the Context Bridge and does not widen an editor's `ens_` key ([30](30_ENGINES.md)).

## 7. What `ensemble_gaps` says

`apps/hub-api/src/bridge/gaps.ts` lists what the bridge does not have or will not give, so a model does not invent it: no embedding search (retrieval is ranked words plus graph links), no redaction pass on bridge reads (ingest and file paths redact), mail, chats and transcripts only when the person saved or imported them, no layouts, private reminders or older skill bodies, which changes a key may make (§5.1) and how the connected apps are reached (§5.2). It is not the connector inventory ([31](31_CONNECTORS_IN_USE.md)).

## 8. Transports

- **stdio** (default). No port. Editors launch `node apps/context-bridge/dist/index.js`, or `ensemble mcp` from the CLI.
- **Hosted Streamable HTTP** at `https://api.ensemblework.com/mcp`. A `Bearer ens_` key (bridge or full scope) is required; cookies, device keys and missing keys are refused; `GET` and `DELETE` return 405.
- **Local Streamable HTTP** (`--http`) at `http://127.0.0.1:4010/mcp`. `CONTEXT_BRIDGE_PORT` changes the port; `CONTEXT_BRIDGE_HOST` must be `127.0.0.1`, `localhost` or `::1`, or the bridge refuses to start. Optional `CONTEXT_BRIDGE_HTTP_TOKEN` requires `Authorization: Bearer` on that endpoint; without it, `ensemble_upload_file` does not read a `path` (any process on the computer can reach a loopback port). The Hub token stays in the bridge process.

hub-api listens on `HUB_API_HOST` (default `127.0.0.1`). `infra/docker-compose.yml` publishes Postgres (`5432`) and Redis (`6379`) on `127.0.0.1` only, so use `127.0.0.1`, not `localhost`, in `DATABASE_URL` and `REDIS_URL`.

## 9. Client setup

Prefer **Connect your apps** in the Hub or `ensemble mcp setup`. Connect your apps has CLI, hosted-URL and from-source guides for VS Code, Cursor, Windsurf, Claude Code, Claude Desktop, Codex, Gemini CLI, GitHub Copilot CLI, Zed, Visual Studio, JetBrains, Cline, Continue and opencode on macOS, Windows and Linux (`apps/hub-web/lib/connect/configs.ts`).

The from-source samples are in `apps/context-bridge/clients/`. Build first (`pnpm bridge:build`), use absolute paths and never commit a real token. Committed project files use `${env:ENSEMBLE_BRIDGE_TOKEN}` or `${ENSEMBLE_BRIDGE_TOKEN}`. `${input:…}` is avoided because it drops the server from VS Code's Agent Host. One-click links (`vscode:mcp/install`, `cursor://anysphere.cursor-deeplink/mcp/install`) keep the key in the environment, not the URL.

| Client | Config | Sample |
|---|---|---|
| VS Code (Copilot agent mode) | Committed `.vscode/mcp.json` (`servers`); or the profile `mcp.json` with an absolute path. Reload, then enable the server in the Chat tools list | `vscode.mcp.json` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` (`mcpServers`; it does not read `.vscode/mcp.json`). Or `copilot mcp add ensemble -- node "$PWD/apps/context-bridge/dist/index.js"`, then put the token in that file's `env`. `/mcp` in a session lists it | `copilot-cli.mcp.json` |
| Cursor | Committed `.cursor/mcp.json`, or `~/.cursor/mcp.json` (`mcpServers`) | `cursor.mcp.json` |
| Claude Code | Committed `.mcp.json`, or the command below | `claude-code.mcp.json` |
| Claude Desktop | `mcpServers` in `claude_desktop_config.json`: `~/Library/Application Support/Claude/` (macOS), `~/.config/Claude/` (Linux), `%APPDATA%\Claude\` (Windows). Absolute path; restart the app | `claude-desktop.mcp.json` |
| Codex CLI | Merge into `~/.codex/config.toml` | `codex.config.toml` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `windsurf.mcp.json` |
| Any client, local HTTP | Run `pnpm bridge:http`; `type: "http"`, `url: "http://127.0.0.1:4010/mcp"` (`servers` for VS Code, `mcpServers` elsewhere) | `http.mcp.json` |

```bash
claude mcp add --transport stdio \
  --env ENSEMBLE_BRIDGE_TOKEN="$ENSEMBLE_BRIDGE_TOKEN" \
  --env HUB_API_URL=http://127.0.0.1:4000 \
  ensemble -- node "$PWD/apps/context-bridge/dist/index.js"
```

The repo also ships `.github/agents/ensemble.md` (a custom agent that calls `ensemble_brief` and cites sources) and `.github/skills/ensemble-context/SKILL.md` (copy the folder to `~/.copilot/skills/ensemble-context/` to load it in Copilot CLI everywhere).

## 10. Failure behaviour

| Situation | Result |
|---|---|
| hub-api down | ``Ensemble is not running. Start it with `pnpm dev`.`` |
| Token missing, not `ens_`, or the default internal token | A configuration error, never an empty brief |
| Repo not tracked | Says so; searches only if a query was passed |
| Branch matches no open task | Repo and project context, no guessed task |
| Branch matches several tasks | The candidates; none is chosen |
| Nothing relevant | Says so |
| Long body | Excerpt plus `ensemble_read` |

## 11. Tests

```bash
pnpm --filter @ensemble/hub-api test:bridge    # resolution, auth, write gating; context, brief by task, ranked search, task writes, actions, uploads and apps on PGlite
pnpm --filter @ensemble/context-bridge test    # in-memory MCP client, stdio, Streamable HTTP, mocked hub-api
pnpm bridge:verify                             # both, plus typecheck, build and dist smoke
pnpm bridge:e2e                                # live Postgres, hub-api, both transports, security
```

The smoke script (`apps/context-bridge/scripts/smoke.ts`) speaks MCP to the built server against a mocked hub-api and checks `tools/list`, a tool call and resources.

`pnpm bridge:e2e` (`scripts/live-e2e.ts`) creates the `ensemble_pg` volume if needed, starts `infra/docker-compose.yml`, writes a gitignored `.env` when missing, runs `db:generate`, `db:push` and `db:seed`, builds the bridge, starts hub-api on `127.0.0.1:4000` with `ENSEMBLE_DEV_AUTH_BYPASS=true`, and mints a real `ens_` key through `POST /api/connect/token`. The seed covers every status, a task linked to `encode/httpx` on branch `docs/default-timeout`, two tasks on `retry-helper`, deliverables, calendar events in the next 14 days, meeting notes, a file and a document, and a pending editor decision; the script also uploads `latency-readout.md` and opens a Needs-me prompt.

It then connects with the MCP SDK over stdio (as the editor configs do) and over Streamable HTTP at `http://127.0.0.1:4010/mcp`, calls every tool, reads every resource and item template, and compares payloads with the database (counts, ids, titles, trust labels). Security checks cover bridge-key writes (403 elsewhere in hub-api, 405 on `/api/bridge`), key minting, refusal of `ENSEMBLE_DEV_AUTH_BYPASS` and `dev-internal-token` on bridge routes, loopback binds, refusal of a non-loopback host, missing and invalid tokens, hub-api down, and Postgres/Redis refusing non-loopback connections.

The script leaves hub-api and the HTTP bridge running, writes logs under `/tmp/ensemble-bridge-e2e/` and a JSON summary to `bridge-e2e-report.json` in the repo root, and never prints the token.

A passing handshake does not show that an editor picks the right tool or that a remote client supports bearer headers.
