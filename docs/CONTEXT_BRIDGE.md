# Context Bridge

The Context Bridge is Ensemble's MCP server for editors and agents. An agent uses it to read Ensemble: a brief for its task (where the task came from, who asked, the people and their roles, related work), any record and what it links to (the context graph, [03 §5](03_MODULE_CONTEXT_ENGINE.md#5-shared-retrieval-and-briefs)), ranked search, tasks, projects, repositories, skills, deliverables, calendar, people, Needs me, files and their contents, diagrams and plots, and through the read actions everything else the assistant reads. A key made with changes allowed also runs Ensemble's writes (tasks, pages, boards, diagrams, plots, new files, projects, people, deliverables, meeting notes, comments, skills, routines, reminders, desk lists, imports; §5.1), and a key made with apps allowed uses the apps the person connected to Ensemble (§5.2). A key works in its own space and in every other space its account owns (§4).

The server is `apps/context-bridge`. It calls hub-api's `/api/bridge` routes over HTTP. It never opens the database or holds model or app keys. The editor runs its own model; Ensemble supplies the records, runs the actions with the assistant's own tools, and calls the apps with the person's connections.

## 1. Three ways to reach it

| Way | For | How |
|---|---|---|
| **Ensemble CLI** | Hosted-site users on any OS | Install the CLI, `ensemble login`, then `ensemble mcp setup`. Editors run `ensemble mcp` (stdio), which calls `https://api.ensemblework.com/api/bridge/*` with the CLI's key and the grants approved at `ensemble login` (§4, [26](26_CLI.md)) |
| **Hosted URL** | AI apps, automation clients and editors; nothing to install | `POST https://api.ensemblework.com/mcp` with an OAuth access token or a static `Authorization: Bearer ens_…` key, and optionally `x-ensemble-space: <space id>` (§4). Served by hub-api (`src/routes/mcp.ts`), stateless Streamable HTTP ([26 §5](26_CLI.md#5-mcp-local-cli-or-hosted-url)) |
| **From source** | Developers running this repository | `pnpm bridge:build`, then the editor launches `node apps/context-bridge/dist/index.js` (§3) |

All ways use the same Context Bridge and `/api/bridge` checks. Stdio and ordinary static keys use `buildServer` (`apps/context-bridge/src/server.ts`). Hosted OAuth uses `buildCatalogServer` (`src/catalog.ts`, exported as `@ensemble/context-bridge/catalog`): the core tools and resources plus named operations instead of catch-alls (§5.4). `x-ensemble-tools: catalog` selects that profile for a static key; `legacy` selects the existing tool names. This changes metadata, not grants.

Write tools require changes allowed and app tools require apps allowed. Hosted requests read the grants from the token; CLI and source builds ask `GET /api/bridge/whoami` at start (`buildServerForKey`). The hosted endpoint cannot see the editor's disk: `ensemble_brief` needs `task` or `repo` and `branch`, `ensemble_upload_file` takes `dataBase64`, and `ensemble_get_file` cannot use `saveTo`. Local bridges detect the repository, read a `path` and save into the working folder. Actions and connected apps run on Ensemble's server in either profile.

## 2. Architecture

```text
Editor / MCP client
    → stdio bridge | loopback HTTP bridge | hosted /mcp
    → apps/context-bridge/src/server.ts (buildServer)
    → hub-api /api/bridge routes, scoped to the key's space or another its account owns
    → bridge/service.ts over saved workspace records
```

| Path | Responsibility |
| --- | --- |
| `apps/context-bridge/src/server.ts` | MCP tools and resources, their annotations; the write tools only for a key that may make changes, the app tools only for one that may use apps |
| `apps/context-bridge/src/catalog.ts` | Core tool reuse, named action/app schemas, fixed operation variants, OAuth tool schemes and input validation |
| `apps/context-bridge/src/hub.ts` | HTTP client for hub-api, auth and errors; the space a call names (`x-ensemble-space`) and file downloads |
| `apps/context-bridge/src/spaces.ts` | The `space` argument every tool takes: an id or exact name, resolved from `GET /api/bridge/spaces` |
| `apps/context-bridge/src/files.ts` | A file as MCP content (image, text, embedded resource) and where `saveTo` may write |
| `apps/context-bridge/src/config.ts` | Environment, token rules, local runtime discovery |
| `apps/context-bridge/src/git.ts` | Repository and branch from the working directory |
| `apps/hub-api/src/bridge/routes.ts` | Read routes |
| `apps/hub-api/src/bridge/docs.ts`, `apps/docs/src/search.js` | Public documentation index and shared word search, without private workspace records ([40](40_PUBLIC_DOCUMENTATION.md)) |
| `apps/hub-api/src/bridge/write-routes.ts` | `whoami`, the task writes and file uploads (§5.1) |
| `apps/hub-api/src/bridge/actions.ts`, `action-routes.ts` | The actions allowlist, listing and running actions and app tools (§5.1, §5.2) |
| `apps/hub-api/src/bridge/service.ts` | Queries, reads, brief assembly, pagination; context and search over `context/graph/` |
| `apps/hub-api/src/bridge/files.ts` | Files: details, summary and tags, Ensemble's text in parts, the original (§5) |
| `apps/hub-api/src/bridge/spaces.ts` | The spaces a key's account can open and which of them the key may act in (§4) |
| `apps/hub-api/src/bridge/resolve.ts` | Repository, branch and task resolution |
| `apps/hub-api/src/bridge/auth.ts` | Which credentials the bridge accepts, and which may write |
| `apps/hub-api/src/lib/auth.ts` (`keyIdentity`) | The space a key acts in: its own, or another its account owns named by `x-ensemble-space` (§4) |
| `apps/hub-api/src/bridge/gaps.ts` | Exclusion and missing-data text for `ensemble_gaps` (§7) |
| `apps/hub-api/src/routes/mcp.ts` | Hosted Streamable HTTP |
| `apps/hub-api/src/routes/mcp-oauth.ts`, `src/mcp-oauth/` | OAuth discovery, DCR/CIMD, browser consent, PKCE, rotating credentials and revocation |

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

1. **Connect your apps → Create a key.** The value starts with `ens_` and is shown once. It can read `/api/bridge` (files included, §5), call `/mcp`, run the read actions and revoke itself at `/api/cli/logout`. Two grants, both ticked by default (`POST /api/connect/token`):
   - **Let editors and agents make changes** (`canWrite`, `api_tokens.can_write`): the task writes, file uploads and every write action on the allowlist (§5.1).
   - **Let editors and agents use your connected apps** (`canUseApps`, `api_tokens.can_use_apps`): the apps' tools through Ensemble (§5.2); changing something in an app also needs the first grant.

   The key list shows each key's grants. Keys made before 0.7.1 only read (their task-update grant was narrower and was reset): make a new key, or run `ensemble login` again (the `/link` page asks the same two questions). A key made under Settings → Connections → Editors & agents is a full key: it has both and can drive editor hooks.
2. Export it where the editor can see it:

```bash
export ENSEMBLE_BRIDGE_TOKEN=ens_...
```

`ENSEMBLE_BRIDGE_TOKEN` must start with `ens_`. With no token and no `HUB_API_URL`, the bridge uses a running desktop or CLI runtime's launch token from `api.json`. Otherwise every tool returns a configuration error; the bridge never falls back to the default internal token.

hub-api's `ENSEMBLE_INTERNAL_TOKEN` is the agent-runtime service credential and defaults to `dev-internal-token`, which hub-api warns about at startup. The bridge uses it only with `ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN=true`, and refuses the default value unless `ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true` is also set (local demos only, never on a shared network). Set a private one (`openssl rand -hex 32`) if anything besides this machine can reach port 4000. `ENSEMBLE_DEV_AUTH_BYPASS` is refused on `/api/bridge/*`.

**Spaces.** A `bridge` or `full` key acts in the space it was made in (its default). A request that names another space with `x-ensemble-space: <space id>` acts there when the key's account owns it (`keyIdentity` in `apps/hub-api/src/lib/auth.ts`, checked with `openedSpace()` on every request): the account's own space and the spaces it created ([28](28_ENSEMBLE_SPACES.md)). The account is `api_tokens.account_id`, set when Connect your apps, Settings or `ensemble login` makes the key (migration `20261126100000_api_token_account`; `ensemble login` keeps the approving account on `cli_auth_requests.account_id` until the exchange). A key with no `account_id` acts for its own row's account when it was made in an account's own space, and stays in its space when it was made inside another. Refusals are one sentence and nothing falls back to another space:

| Request names | Answer |
|---|---|
| A space the account cannot open | 404 "This key's account cannot open that space." |
| A space shared with the account (a member's) | 403 "“‹space›” is shared with you, and keys act only in your own spaces: work there in Ensemble." The bridge's reads and actions act as a space's owner, and its routes are owner-only in the sharing policy ([29](29_SHARING.md)) |
| Another space, with a key that has no `account_id` and was made inside a space | 404 "This key works only in “‹space›”: make a new key in Ensemble to reach your other spaces." |

The MCP tools take the space as `space` (§5), `GET /api/bridge/spaces` lists the spaces, and `GET /api/bridge/whoami` says whether the key may name one. Device, hook and transfer keys and signed-in pages ignore the header; Ensemble Node's delegated requests use it with their own checks ([29 §2](29_SHARING.md#2-how-access-works)).

Creating and revoking keys is a signed-in account action; a bridge key cannot mint another key.

### 4.1 OAuth for AI apps

An app adds the same `/mcp` URL and discovers `/.well-known/oauth-protected-resource/mcp` (also served at `/.well-known/oauth-protected-resource`) and `/.well-known/oauth-authorization-server`. Unauthenticated MCP gets a 401 Bearer challenge with `resource_metadata`. `HUB_API_PUBLIC_URL` is the issuer's HTTPS origin; HTTP loopback is allowed only in development. Metadata endpoints do not inherit cookies, keys or space headers.

`POST /oauth/register` supports public clients (`none`) and confidential `client_secret_basic` or `client_secret_post` clients. HTTPS client IDs can use CIMD; the public document must match its URL, include its name and redirects, and support `none`. Fetches are public-only, DNS-pinned, without user credentials or redirects, bounded to 5 seconds and 32 KB. Registered redirects match exactly; an HTTP loopback callback may vary only its port.

`GET /oauth/authorize` requires authorization-code flow and PKCE S256. The standalone web `/oauth` page is public, but its consent API requires the signed-in browser session. It preserves the request rather than detouring through onboarding. The person checks the app's name and domains, and approves its requested read/write/app grants and default owned space. Consent is bound to that browser session and expires after 10 minutes. Email signup and Google/GitHub/Microsoft sign-in retain the consent return. All the account's owned spaces remain reachable; shared spaces do not.

| Scope | Permission |
|---|---|
| `ensemble:read` | Required; existing bridge reads |
| `ensemble:write` | Existing `canWrite` actions and uploads |
| `ensemble:apps` | Existing `canUseApps`; app writes also need write |
| `offline_access` | Refresh after access expires; rotation by default |

`POST /oauth/token` exchanges a single-use code or refresh token. Explicit `resource` values must equal this server's `/mcp` URL; clients omitting it get that sole resource. Access tokens are hashed `ens_` bridge keys expiring in one hour. Refresh tokens expire after 30 days and rotate on use; narrowing persists, and replay revokes the entire connection. Issuer identification is returned on success and error callbacks. There is no `client_credentials`, implicit grant, no-auth or mixed-auth mode.

Confidential registrations may explicitly request `ensemble_refresh_token_mode: "persistent"` for clients such as Google's Connected Apps persistent-linking flow. Every refresh must authenticate with the client secret; the same refresh credential is returned and its 30-day expiry extends. Narrowed permissions stay narrowed. Public and CIMD clients cannot select this mode and keep rotation/replay detection. Client publishing requirements are vendor-specific; standard public-client security is not weakened.

`GET /.well-known/openai-apps-challenge` serves the exact plaintext `OPENAI_APPS_CHALLENGE` value for OpenAI plugin domain verification. It returns 404 when unset, has no identity or workspace context, and is not cached. The operator supplies the portal-generated token for this API hostname; no challenge value or vendor approval is bundled with the code.

`POST /oauth/revoke`, **Connect your apps → Disconnect**, and self-logout revoke the whole token family. `GET /api/mcp-oauth/connections` lists only the signed-in account's connections; consent and disconnect mutations require the browser's origin and CSRF proof. Ephemeral access keys are excluded from manual key lists. Grant metadata is exported with the account; secrets are not. Account or default-space deletion cascades through grants and tokens ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)).

## 5. Tools and resources

| Tool | Resource | Data |
|---|---|---|
| `ensemble_brief` | — | The task: `task` (an `ensemble://task/<id>` handle, a Hub link, its id or its exact open title), else repository + branch. `workContext` is the task's context packet (`context/graph/packet.ts`, at most 7,000 characters: where it came from with the words asked, project, people with roles and relationship, dependencies, related open work, done before, each with a handle) and `contextRef` its handle; plus project, people, deliverables, files attached to the task, current skills (`howIWork`) and cited excerpts (`context`) |
| `ensemble_context` | — | One record and what it links to (`GET /api/bridge/context`): `item` is a handle, a Hub link, or an id with `kind` (task, project, person, repo, deliverable, meeting, file, page, event). Returns the record and its relations, 6 each, every card with a `ref` to call again; `rel` lists one relation in full, paged with `offset` and `limit` (≤50); `format=packet` returns the Markdown packet (8,000 characters) |
| `ensemble_search` | — | Ranked word search (`context/graph/search.ts`) across tasks, projects, people, repositories, deliverables, meeting notes with transcripts, standalone pages, files (by name and summary, kind `document`), saved app items, skills, diagrams and plots; `kinds` filters, `near` (a handle) ranks what links to it first. Up to `limit` × 3 hits (at most 40), each with `ref`, `score` and `why` |
| `ensemble_docs` | None | Published product documentation, not workspace records (`GET /api/bridge/docs`): `query` (1 to 200 characters of search words), `limit` (1 to 20, default 8). Returns `found`, matching `title`, `heading`, public `url` and a short `excerpt` from the same pages as `https://docs.ensemblework.com`; a miss explicitly says so and returns the docs home. Title: `Search Ensemble documentation`; annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Neither changes nor app grants are needed. Public site and index: [40](40_PUBLIC_DOCUMENTATION.md) |
| `ensemble_read` | `ensemble://items/{kind}/{id}` | One item in full, paginated with `offset` and `limit`. Kinds: task (with its meeting, dependencies, labels and deliverable), project, repo, skill, deliverable, person, artifact, document (details and summary; its text and the file itself come from `ensemble_get_file`), meeting_note or meeting (the whole transcript, its people and the tasks made from it; a notes session's id reads its notes), approval, decision, diagram, plot, page |
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
| `ensemble_files` | None | The person's files, newest first (`GET /api/bridge/files`): name, format, media type, size, pages, summary, source app and handle. `query` matches the name, summary or text; `on` (a task, page, project, person or repository handle) lists the files on that record, as its page shows them; `limit` (≤50) and `offset` |
| `ensemble_get_file` | None | One file (`GET /api/bridge/files/:id`, `bridge/files.ts`): its details (id, name, format, media type, size, pages, tags by name, created, link in Ensemble) and summary as JSON; `text: true` adds Ensemble's text of it in parts (`offset`, `limit` ≤20,000 characters); and the file itself unless `content: false`: a PNG, JPEG, GIF or WebP picture up to 5 MB as an `image` block, a text or code file as text (up to 200,000 characters), anything else (PDF, Office…) as an embedded `resource` with `blob` and media type. One answer carries a file up to 20 MB; a larger one is named with what to do. Through the CLI or a source build, `saveTo` writes the original into the working folder instead, any size (`GET /api/bridge/files/:id/original`): a path inside the folder, relative or absolute, never with `..`, never through or onto a symbolic link, and onto an existing file only with `overwrite: true` (`apps/context-bridge/src/files.ts`) |
| `ensemble_spaces` | None | The spaces the key's account can open (`GET /api/bridge/spaces`): id, name, `access` (`own` or `member`) and `role`, the key's `default`, the request's `current`, and `usable` (false, with `refusal`, for a space shared with the account) |

Every tool but `ensemble_spaces` takes an optional `space`: a space's id or exact name (compared as the space switcher compares names). `apps/context-bridge/src/spaces.ts` resolves it from `GET /api/bridge/spaces` (kept 30 seconds) and sends it as `x-ensemble-space` with each request of that call; hub-api checks it again (§4). A space shared with the account is refused before any call. Resources read the key's default space.

### 5.1 Changes in Ensemble

`ensemble_actions` and `ensemble_act` are offered to every key; the other write tools only to a key that may make changes (§4). `read-only.ts` refuses to start with a write-named tool outside `ensemble_create_task`, `ensemble_update_task` and `ensemble_upload_file`.

| Tool | Route | What it does |
|---|---|---|
| `ensemble_actions` | `GET /api/bridge/actions` (`groups`, `names`, `schema`) | The actions this key may run, by group (below), each with `write` and `allowed` (and `refusal` when not), and `limit` when a guard refuses some inputs; `notOffered` says what stays with the person. With `names`, their full descriptions and `inputSchema` |
| `ensemble_act` | `POST /api/bridge/act/:name` `{input}` | Runs one action: the assistant's own Hub tool of that name (`bridge/actions.ts` `BRIDGE_ACTIONS`), with its validation, access checks, Undo entry and live refresh, at once (no Apply). A wrong input is a 400 with the action's `inputSchema`. Writes need changes allowed, are ledgered as `bridge.<tool>` with the key's name and answer `undoable` |
| `ensemble_create_task` | `POST /api/bridge/write/tasks` | `{title, page?, projectId? \| projectName?, due? (YYYY-MM-DD), people? (names or ids), status? (proposed, default, or todo), from? (a handle)}`. Adds a task through `createTask` with actor `agent`: `page` becomes its page, `from` adds a `Related:` link to that record, names become person ids where one person has that name |
| `ensemble_update_task` | `PATCH /api/bridge/write/tasks/:id` | `{status? (in_progress, waiting_approval, done, blocked, todo), note?, matchTitle?}`. A status follows the task state machine (a refused move lists the allowed ones); `note` is added to the task's page as an agent block titled "Update from <key name>"; a `matchTitle` that differs is a 409 |
| `ensemble_upload_file` | `POST /api/bridge/write/files` | `{filename, dataBase64, mediaType?, attachTo?, summarize?}`; through the CLI or a source build, `path` (a file on the editor's computer) instead. Saved through `POST /api/documents` (the same checks, caps and text extraction as an upload in Files); `attachTo` (a task, page, project, person or repository handle) tags the file, and for a task or page adds `[@file](ensemble://file/<id>)` to the end of its page. Ledgered as `bridge.file.upload` |

The allowlist (each name is the assistant's tool, [34](34_ASSISTANT_ACTIONS.md)). Reads run for every key; changes need changes allowed, and those marked *apps* also need apps allowed:

| Group | Reads | Changes |
|---|---|---|
| guides | `hub_how_to` (the assistant's playbooks: boards, diagrams, plots…) | — |
| tasks | `hub_list_tasks`, `hub_get_task`, `hub_read_task_page`, `hub_list_due` | `hub_create_tasks`, `hub_update_task` (title, status, owner, priority, due, labels, people, project, repository, deliverable, page), `hub_delete_task`, `hub_delete_tasks` (many, to Trash) |
| pages | `hub_list_pages`, `hub_read_page`, `hub_read_page_blocks` | `hub_create_page`, `hub_update_page`, `hub_edit_page`, `hub_move_page`, `hub_delete_page`, `hub_delete_pages`. People and records are linked in a page as `[@Name](ensemble://person/<id>)` |
| boards | `hub_list_boards`, `hub_read_board` | `hub_create_board`, `hub_update_board`, `hub_move_to_board` (a task or page into a column), `hub_remove_from_board`, `hub_delete_board` (keeps its cards). Task status columns on the Ensemble board move with `hub_update_task` |
| diagrams | `hub_list_diagrams`, `hub_get_diagram`, `hub_validate_diagram`, `hub_explain_diagram`, `hub_diagram_context` | `hub_create_diagram`, `hub_update_diagram`, `hub_edit_diagram` |
| plots | `hub_list_plots`, `hub_get_plot`, `hub_list_datasets`, `hub_get_dataset` | `hub_import_dataset`, `hub_create_plot`, `hub_update_plot` |
| files | `hub_list_files`, `hub_file_edit_info` (the files themselves: `ensemble_get_file`, §5) | New files only: `hub_file_to_page`, `hub_export_page_file` (refuses `replaceFileId`), `hub_save_file` (from a web link), and *apps* `hub_save_app_item_as_page`, `hub_import_app_file` |
| projects | `hub_list_projects`, `hub_list_deliverables` | `hub_create_project`, `hub_update_project` (name, summary, notes, status, people, repositories), `hub_create_deliverable`, `hub_update_deliverable`, `hub_complete_deliverable`, `hub_delete_deliverable` |
| people | `hub_list_people`, `hub_list_repos` | `hub_create_person`, `hub_update_person` (role, team, relationship to the person), `hub_delete_person`, `hub_link_repo`, `hub_unlink_repo`, `hub_update_repo` |
| meetings | `hub_list_meeting_notes`, `hub_read_meeting_note` | `hub_create_meeting_note`, `hub_update_meeting_note`, `hub_delete_meeting_note`, `hub_suggest_meeting_tasks`, *apps* `hub_import_meeting_notes` |
| comments | `hub_read_record_details` | `hub_manage_record`: comments, restore any record from Trash, a page into a task (`convert_page`), file tags, copying or deleting a plot or diagram, renaming or deleting a dataset, a diagram's earlier version |
| context | `hub_item_context`, `hub_search_work`, `hub_search_context`, `hub_read_context`, `hub_read_surface` (Today, Board, Context and the other screens), `hub_list_approvals` (Needs me) | `hub_delete_entity` (a project, repository or skill to Trash; refuses `document`), `hub_restore_entity` |
| skills | `hub_list_skills`, `hub_read_skill` | `hub_manage_skill` (create, update, restore a version, delete) |
| routines | `hub_list_routines` | `hub_create_routine`, `hub_update_routine` (edit, pause, resume; refuses `delete`) |
| reminders | `hub_list_reminders`, `hub_list_watchers` | `hub_create_reminder`, `hub_update_reminder`, `hub_dismiss_reminder`, `hub_delete_reminder` |
| desk | `hub_list_desk_items` | `hub_add_desk_item`, `hub_update_desk_item`, `hub_remove_desk_item` |
| calendar | `hub_list_events`, `hub_weekly_recap` | None |
| runs | `hub_list_activity`, `hub_list_runs`, `hub_get_run` | None |
| agents | `hub_list_agent_sessions`, `hub_list_agent_options` | None |
| code | `hub_repo_overview`, `hub_repo_read_file`, `hub_list_code_folders`, `hub_list_agent_changes` | None |
| settings | `hub_find_setting`, `hub_get_settings`, `hub_list_model_choices` | None |
| layouts | `hub_read_layout` | None |
| imports | `hub_read_import`, *apps* `hub_preview_board_import` | *apps* `hub_start_board_import`, `hub_manage_import` (cancel, undo) |
| relationships | `hub_list_connections`, `hub_list_app_relationships` | *apps* `hub_manage_app_relationship`, *apps* `hub_fetch_now` |

An action runs in the request's space (the key's own, or one it named, §4) as the person (route-backed tools call the API with the internal credential and `x-ensemble-user`), with the space's modules. What changes how Ensemble behaves or starts work stays with the person in Ensemble: a name the assistant has but the list does not answers 404 saying so (`hub_update_settings`, `hub_choose_model`, `hub_edit_layout`, `hub_stop_activity`, `hub_assign_to_agent`, `hub_run_workflow`, `hub_create_watcher`, `hub_cancel_watcher`, `hub_edit_file`; `hub_view_file` points to `ensemble_get_file`, and `hub_web_search` and `hub_read_web_page` are the assistant's own). Guards refuse deleting a file (`hub_delete_entity` kind `document`: "Files cannot be deleted from editors and agents; delete it in Ensemble."), deleting a routine and replacing a file's original (403). No action stops or deletes a run or starts the assistant.

A coding agent Ensemble started keeps the everyday part of the list (`runActionCaller` in `workspace/context-tools.ts`): the entries not marked `keyOnly` in `BRIDGE_ACTIONS`, without deleting a dataset or restoring a skill or reminder; anything else answers "Agent runs cannot use ‹name›…" ([30 §9](30_ENGINES.md)).

`GET /api/bridge/whoami` answers `{canWrite, canUseApps, apps (connected app names), spaceId, spaceName (the request's space), defaultSpace {id, name} (the key's own), crossSpace, crossSpaceNote?, keyName}`. Writes are refused (403) for a key without changes allowed, device and hook keys, and every other route; a signed-in page and a full key may use them. Each write refreshes open pages (`task`, `page`, `documents` or `assistant.acted` events). `POST /api/bridge/act/*` and `/api/bridge/write/*` share the hosted MCP rate limit (`mcp`, 240 a minute per space).

### 5.2 Connected apps

| Tool | Route | What it does |
|---|---|---|
| `ensemble_apps` | `GET /api/bridge/apps` (`app`, `names`, `schema`) | The apps connected in the request's space (`assistant/connections.ts`), what Ensemble can do in each, apps that are connected but broken, and their tools, each with its first sentence (all of an MCP server's switched-on tools, not one assistant turn's share: `appCatalog`); `app` narrows it to one app, and named tools come with their full description and `inputSchema`. A key without apps allowed gets `{allowed: false, refusal}` |
| `ensemble_app_call` | `POST /api/bridge/act/:tool` `{input}` | Calls one app tool with the person's own connection: the built-in Google Workspace, Microsoft 365, Zoom, DocuSign and Jira tools, `apps_search`/`apps_read`/`apps_post_update` across the apps Ensemble can search (Notion, GitHub, Linear, Slack, Figma, Vercel, Zotero, Hugging Face…, [31](31_CONNECTORS_IN_USE.md)), and each connected MCP server's own tools (`mcp_<server>_<tool>`) |

Both tools exist only for a key with apps allowed. App tools are offered and checked as for the assistant (`assistant/apps.ts`): the suite connected, the product switched on, the scopes granted; app writes are left out when Settings → Assistant turns connected-app writes off. A change in an app also needs changes allowed, runs at once through `runOutsideWrite` (ledgered as `apps.<tool>`), and cannot be undone from Ensemble. Calls run on Ensemble's server, so the hosted URL and the CLI reach the same apps and the editor needs no app keys.

### 5.3 What each way in can do

| | MCP key (editors, agents) | Hub assistant | Ensemble Node |
|---|---|---|---|
| Read Ensemble, context graph, files and their contents | Yes, in every space the key's account owns | Yes | Yes, in every space its owner can open |
| Read settings, layouts, runs, agent sessions, Needs me | Yes | Yes | Yes |
| Changes to records (§5.1): tasks, pages, boards, diagrams, plots, projects, people, deliverables, meeting notes, comments, skills, routines, reminders, desk lists, imports, bulk deletes | With changes allowed; at once, Undo | Yes; Apply or at once, by write policy | Yes |
| New files | With changes allowed | Yes | Yes |
| Connected apps | With apps allowed | Yes | Yes |
| Settings, model choice, layouts | Read only | Yes (wait for Apply) | Yes |
| Deleting a routine or a file; editing a file's original | No | Yes | Yes |
| Assigning work to agents, workflows, watchers, stopping runs | No | Yes | Yes, plus its own sessions, computers and crews |

A coding agent that Ensemble starts on a paired computer has `ensemble_actions` and `ensemble_act` in its run's own MCP server, under the job's lease, with the everyday part of the list (§5.1), and `ensemble_apps` and `ensemble_app_call` with the connected apps as above (§5.2; the person's own agent in Chat has the apps too), only in its owner's own space ([30 §9](30_ENGINES.md)). So every way an agent reaches Ensemble (a key in an editor, a run Ensemble starts, the assistant, a node) reaches the person's connected apps through it.

A resource URI is an MCP identifier, not permission to open local files. Reads are scoped to the request's space: the key's own, or another its account owns (§4, [28](28_ENSEMBLE_SPACES.md)); module checks still apply.

### 5.4 Named catalog profile

The hosted catalog keeps the existing core reads, resources and dedicated task/file writes. `ensemble_actions`, `ensemble_act`, `ensemble_apps` and `ensemble_app_call` are replaced by `ensemble_action_<name>` and `ensemble_app_<name>` tools built from the same allowed action and connected-app schemas. Names stay within 64 characters; changed or shortened names get a deterministic hash suffix. Enum-based action, operation or method choices become separate fixed-operation tools. No call can select a different underlying action.

Each tool has a title and explicit read-only, destructive, idempotent and open-world hints, plus its required OAuth scopes. Only allowed tools are listed; original API validation, module checks, ownership, grants, Undo and app-write policy still apply. Every tool takes optional `space`; a provider tool whose own schema has `space` keeps its arguments under `input`. Inputs are validated against the published schema before dispatch. Tool errors are MCP errors, not empty results.

- **Files.** `ensemble_read` of a `document` gives a file's name, format, size, page count, summary and link in Ensemble, and search matches a file's name and summary. `ensemble_get_file` gives Ensemble's text of it when asked and the file itself (§5); the extracted text stays out of search, briefs and `ensemble_read` ([32](32_FILES.md), `files/extracted-text-policy.ts`). A task or page also lists its files. A key adds files (`ensemble_upload_file`, `hub_save_file`, page exports) and never edits an original or deletes a file.
- **Pages.** `apps/hub-api/src/pages/agent-context.ts` adds the source of diagrams embedded in task and standalone pages, with space ownership checks. For the bridge, page bodies are bounded at 15,000 characters and diagram source at 20,000, then paginated. Converted source documents appear in the page's file citations (`files/attached.ts`).
- **Skills.** Only the current body is returned. Older `SkillVersion` bodies are not exposed (`hub_read_skill` lists recent versions without them), and disabled or deleted skills are left out of briefs ([04](04_MODULE_SKILL_FORGE.md)).
- **Trust labels.** Mail, chat, GitHub text, calendar invites, approval previews and editor tool inputs are labelled `trust: "untrusted"`; skills are `trusted`. The brief repeats that retrieved text is reference material, not instructions.
- **Resolution.** A branch that matches no task, or several, is reported as such; the bridge never picks a similarly named task.

## 6. Limits

- Search is ranked word matching plus graph links, not semantic: `Artifact.searchVector` and `ArtifactChunk.embedding` exist in the schema but nothing fills or queries them; enabling an embedding provider does not change this.
- Not given: older skill bodies; reminders and layouts only through the read actions. Not changed: anything off §5.1's list, and Needs-me answers.
- Files: one answer carries an original up to 20 MB (`FILE_ANSWER_MAX_BYTES` in `bridge/files.ts`); a larger one comes through `saveTo` in the CLI or a source build, or `GET /api/bridge/files/:id/original`. Ensemble's text of a file is its extracted text: no OCR, audio or video.
- Spaces: a key reaches the spaces its account owns. Spaces shared with the account are refused, and a key with no `account_id` made inside a space stays in that space (§4).
- Connected-app copies can be stale until refreshed; bridge reads do not call vendor search.
- The bridge returns stored text without a new redaction pass; ingest and file paths have their own redaction.
- OAuth is authorization-code/PKCE only. A static key or stdio remains available; anonymous access to workspace tools is not offered.

The task-scoped `scripts/ensemble-ask-mcp.mjs` server used inside managed engine runs asks questions for its run and runs the everyday actions under the job's lease. It is not the Context Bridge and does not widen an editor's `ens_` key ([30](30_ENGINES.md)).

## 7. What `ensemble_gaps` says

`apps/hub-api/src/bridge/gaps.ts` lists what the bridge does not have or will not give, so a model does not invent it: no embedding search (retrieval is ranked words plus graph links), no redaction pass on bridge reads (ingest and file paths redact), mail, chats and transcripts only when the person saved or imported them, layouts and reminders only through the read actions, no older skill bodies, files (the 20 MB answer and `saveTo`), other spaces (§4), which changes a key may make (§5.1) and how the connected apps are reached (§5.2). It is not the connector inventory ([31](31_CONNECTORS_IN_USE.md)).

## 8. Transports

- **stdio** (default). No port. Editors launch `node apps/context-bridge/dist/index.js`, or `ensemble mcp` from the CLI.
- **Hosted Streamable HTTP** at `https://api.ensemblework.com/mcp`. An OAuth access token or static `Bearer ens_` key is required; cookies and device keys are refused. Unauthenticated requests receive discovery challenges. Authenticated `GET` and `DELETE` return 405. `x-ensemble-space` goes with every call unless a tool names its own `space` (§4).
- **Local Streamable HTTP** (`--http`) at `http://127.0.0.1:4010/mcp`. `CONTEXT_BRIDGE_PORT` changes the port; `CONTEXT_BRIDGE_HOST` must be `127.0.0.1`, `localhost` or `::1`, or the bridge refuses to start. Optional `CONTEXT_BRIDGE_HTTP_TOKEN` requires `Authorization: Bearer` on that endpoint; without it, `ensemble_upload_file` does not read a `path` (any process on the computer can reach a loopback port). The Hub token stays in the bridge process.

hub-api listens on `HUB_API_HOST` (default `127.0.0.1`). `infra/docker-compose.yml` publishes Postgres (`5432`) and Redis (`6379`) on `127.0.0.1` only, so use `127.0.0.1`, not `localhost`, in `DATABASE_URL` and `REDIS_URL`.

## 9. Client setup

Prefer **Connect your apps** in the Hub or `ensemble mcp setup`. Connect your apps has CLI, hosted-URL and from-source guides for VS Code, Cursor, Windsurf, Claude Code, Claude Desktop, Codex, Gemini CLI, GitHub Copilot CLI, Zed, Visual Studio, JetBrains, Cline, Continue, opencode, Qwen Code, Kimi Code and Mistral Vibe (through `vibe mcp add`) on macOS, Windows and Linux (`apps/hub-web/lib/connect/configs.ts`).

`ensemble mcp setup grok` uses Grok Build's own `grok mcp add` command for stdio or a bearer URL. AI apps and native MCP automation clients use the hosted URL with OAuth or their documented bearer-header option. Claude/Duet, ChatGPT/dots, Cursor, Grok/Grok Bot, Gemini, Muse, Copilot Studio, n8n, Zapier and Make share that server; each vendor controls client availability and approvals. Open-source plugin packages, client helpers and automation templates live in [ensemblework/ensemble-integrations](https://github.com/ensemblework/ensemble-integrations). A package or registry entry is not vendor approval or curated placement.
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
| Published docs cannot be loaded or validated | `ensemble_docs` reports a tool error with the docs home, not an empty match or guessed answer |
| A space the key cannot act in | One sentence saying why (§4); nothing falls back to another space |
| Long body | Excerpt plus `ensemble_read` |

## 11. Tests

`pnpm --filter @ensemble/hub-api test:mcp-oauth` exercises the hosted OAuth routes and an MCP SDK client against in-memory PGlite: metadata, DCR/CIMD, consent, PKCE, ownership, client/resource binding, single-use codes, rotating refresh/replay, confidential persistent refresh, disconnect, domain proof and legacy keys. `test/catalog.test.ts` checks named dispatch and schema/space isolation; web `mcp-consent.test.tsx` and provider sign-in tests cover grants and returns. These are protocol/component tests, not a claim of live approval by a vendor directory.

```bash
pnpm --filter @ensemble/hub-api test:bridge    # resolution, auth, write gating; context, brief by task, ranked search, task writes, actions, uploads, files, spaces and apps on PGlite
pnpm --filter @ensemble/context-bridge test    # in-memory MCP client, stdio, Streamable HTTP, mocked hub-api, file content, saveTo rules, space
pnpm bridge:verify                             # both, plus typecheck, build and dist smoke
pnpm bridge:e2e                                # live Postgres, hub-api, both transports, security
```

The smoke script (`apps/context-bridge/scripts/smoke.ts`) speaks MCP to the built server against a mocked hub-api and checks `tools/list`, a tool call and resources.

`pnpm bridge:e2e` (`scripts/live-e2e.ts`) creates the `ensemble_pg` volume if needed, starts `infra/docker-compose.yml`, writes a gitignored `.env` when missing, runs `db:generate`, `db:push` and `db:seed`, builds the bridge, starts hub-api on `127.0.0.1:4000` with `ENSEMBLE_DEV_AUTH_BYPASS=true`, and mints a real `ens_` key through `POST /api/connect/token`. The seed covers every status, a task linked to `encode/httpx` on branch `docs/default-timeout`, two tasks on `retry-helper`, deliverables, calendar events in the next 14 days, meeting notes, a file and a document, and a pending editor decision; the script also uploads `latency-readout.md` and opens a Needs-me prompt.

It then connects with the MCP SDK over stdio (as the editor configs do) and over Streamable HTTP at `http://127.0.0.1:4010/mcp`, calls every tool, reads every resource and item template, and compares payloads with the database (counts, ids, titles, trust labels). Security checks cover bridge-key writes (403 elsewhere in hub-api, 405 on `/api/bridge`), key minting, refusal of `ENSEMBLE_DEV_AUTH_BYPASS` and `dev-internal-token` on bridge routes, loopback binds, refusal of a non-loopback host, missing and invalid tokens, hub-api down, and Postgres/Redis refusing non-loopback connections.

The script leaves hub-api and the HTTP bridge running, writes logs under `/tmp/ensemble-bridge-e2e/` and a JSON summary to `bridge-e2e-report.json` in the repo root, and never prints the token.

A passing handshake does not show that an editor picks the right tool or that a remote client supports bearer headers.
