# Context Bridge

The Context Bridge is Ensemble's read-only MCP server. A coding agent in an editor uses it to read Ensemble: tasks, projects, repositories, skills, deliverables, calendar, people, Needs me, files, diagrams, plots and a cited brief for the current branch.

The server is `apps/context-bridge`. It calls hub-api's `/api/bridge` routes over HTTP. It never opens the database or holds model keys, and it has no tool that creates, updates, deletes, sends or approves anything. The editor runs its own model; Ensemble supplies reference material.

## 1. Three ways to reach it

| Way | For | How |
|---|---|---|
| **Ensemble CLI** | Hosted-site users on any OS | Install the CLI, `ensemble login`, then `ensemble mcp setup`. Editors run `ensemble mcp` (stdio), which calls `https://api.ensemblework.com/api/bridge/*` with the CLI's read-only key ([26](26_CLI.md)) |
| **Hosted URL** | Editors that accept a URL; nothing to install | `POST https://api.ensemblework.com/mcp` with `Authorization: Bearer ens_…` (a key from Connect your apps). Served by hub-api (`src/routes/mcp.ts`), stateless Streamable HTTP ([26 §5](26_CLI.md#5-mcp-local-cli-or-hosted-url)) |
| **From source** | Developers running this repository | `pnpm bridge:build`, then the editor launches `node apps/context-bridge/dist/index.js` (§3) |

All three use `buildServer` from `apps/context-bridge/src/server.ts` (exported as `@ensemble/context-bridge/server`, with `./hub` and `./config`), so the tools are the same. The hosted endpoint cannot see the editor's folder, so `ensemble_brief` needs `repo` and `branch` there; the CLI and the source build read them from the working directory (`git rev-parse` and `origin`).

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
| `apps/context-bridge/src/server.ts` | MCP tools and resources, read-only annotations |
| `apps/context-bridge/src/hub.ts` | HTTP client for hub-api, auth and errors |
| `apps/context-bridge/src/config.ts` | Environment, token rules, local runtime discovery |
| `apps/context-bridge/src/git.ts` | Repository and branch from the working directory |
| `apps/hub-api/src/bridge/routes.ts` | Read-only bridge routes |
| `apps/hub-api/src/bridge/service.ts` | Queries, reads, brief assembly, pagination |
| `apps/hub-api/src/bridge/resolve.ts` | Repository, branch and task resolution |
| `apps/hub-api/src/bridge/auth.ts` | Which credentials the bridge accepts |
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

The bridge calls `HUB_API_URL`, else the local desktop or CLI runtime from its `api.json` ([DESKTOP](DESKTOP.md) §3.2), else `http://$HUB_API_HOST:$HUB_API_PORT` (default `127.0.0.1:4000`).

## 4. Token

The Hub's **Connect your apps** page (`/connect`) creates a read-only key, fills in this computer's paths and offers one-click install for VS Code and Cursor.

1. **Connect your apps → Create a read-only key.** The value starts with `ens_` and is shown once. It can only read `/api/bridge`, call `/mcp` and revoke itself at `/api/cli/logout`. A key made under Settings → Connections → Editors & agents also works and can drive editor hooks.
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
| `ensemble_brief` | — | Current task from repo + branch, project, people, deliverables, files attached to the task, current skills (`howIWork`), cited excerpts |
| `ensemble_search` | — | Case-insensitive substring search across tasks, projects, people, skills, repos, artifacts, meeting notes and files (kind `document`, by name and text) |
| `ensemble_read` | `ensemble://items/{kind}/{id}` | One item in full, paginated with `offset` and `limit`. Kinds: task, project, repo, skill, deliverable, person, artifact, document, meeting_note, approval, decision, diagram, plot, page |
| `ensemble_tasks` | `ensemble://tasks`, `ensemble://tasks/{id}` | Tasks |
| `ensemble_projects` | `ensemble://projects`, `ensemble://projects/{id}` | Projects |
| `ensemble_repos` | `ensemble://repos`, `ensemble://repos/{id}` | Repositories |
| `ensemble_repo_overview`, `ensemble_repo_file` | — | Outline and source of a checkout the person already allowed; secrets and protected paths are skipped |
| `ensemble_diagrams`, `ensemble_plots` | — | Saved diagrams and plot context |
| `ensemble_skills` | `ensemble://skills`, `ensemble://skills/{id}` | Current enabled skills; one skill's current body |
| `ensemble_deliverables` | `ensemble://deliverables` | Deliverables |
| `ensemble_meetings` | `ensemble://meetings` | Upcoming calendar events (`Artifact` kind `event`) |
| `ensemble_people` | `ensemble://people`, `ensemble://people/{id}` | Engineer Graph people |
| `ensemble_decisions` | `ensemble://decisions` | Needs me: pending approvals and editor prompts (read only) |
| `ensemble_today` | `ensemble://today` | Focus, proposed todos, deliverables, meetings, Needs-me counts |
| `ensemble_gaps` | `ensemble://gaps` | What the bridge cannot see or refuses to expose |

A resource URI is an MCP identifier, not permission to open local files. Reads are scoped to the key's account and space ([28](28_ENSEMBLE_SPACES.md)), and module and sharing checks still apply.

- **Files.** A `document` is a file's name, format, size, page count and link in Ensemble; its extracted text and summary are not sent, and search excerpts for a file show its name ([32](32_FILES.md), `files/extracted-text-policy.ts`). A task or page also lists its files. Original bytes are never sent.
- **Pages.** `apps/hub-api/src/pages/agent-context.ts` adds the source of diagrams embedded in task and standalone pages, with space ownership checks. For the bridge, page bodies are bounded at 15,000 characters and diagram source at 20,000, then paginated. Converted source documents appear in the page's file citations (`files/attached.ts`).
- **Skills.** Only the current body is returned. Older `SkillVersion` bodies are not exposed, and disabled or deleted skills are left out of briefs ([04](04_MODULE_SKILL_FORGE.md)).
- **Trust labels.** Mail, chat, GitHub text, calendar invites, approval previews and editor tool inputs are labelled `trust: "untrusted"`; skills are `trusted`. The brief repeats that retrieved text is reference material, not instructions.
- **Resolution.** A branch that matches no task, or several, is reported as such; the bridge never picks a similarly named task.

## 6. Limits

- Search is bounded substring matching. `Artifact.searchVector` and `ArtifactChunk.embedding` exist in the schema but nothing fills or queries them; enabling an embedding provider does not change this.
- Excluded: private reminders, widget layouts, older skill bodies, and every write or approval.
- Files return supported extracted text only, not original bytes, OCR, audio or video.
- Connected-app copies can be stale until refreshed; bridge reads do not call vendor search.
- The bridge returns stored text without a new redaction pass; ingest and file paths have their own redaction.
- There is no OAuth authorization-server flow for external MCP clients. Use stdio or a static `Authorization` header.

The task-scoped `scripts/ensemble-ask-mcp.mjs` server used inside managed engine runs can ask questions for its run. It is not the Context Bridge and does not widen an editor's `ens_` key ([30](30_ENGINES.md)).

## 7. Known diagnostics limitation

`apps/hub-api/src/bridge/gaps.ts` still says the Outlook, Outlook calendar and Teams connectors and a secret-redaction helper are missing. Those strings are stale: `connectors/microsoft.ts` and `lib/redact.ts` exist ([03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md)). Do not treat `ensemble_gaps` as the connector inventory. Its semantic-retrieval, private-reminder, layout, skill-history and read-only entries are accurate.

## 8. Transports

- **stdio** (default). No port. Editors launch `node apps/context-bridge/dist/index.js`, or `ensemble mcp` from the CLI.
- **Hosted Streamable HTTP** at `https://api.ensemblework.com/mcp`. A `Bearer ens_` key (bridge or full scope) is required; cookies, device keys and missing keys are refused; `GET` and `DELETE` return 405.
- **Local Streamable HTTP** (`--http`) at `http://127.0.0.1:4010/mcp`. `CONTEXT_BRIDGE_PORT` changes the port; `CONTEXT_BRIDGE_HOST` must be `127.0.0.1`, `localhost` or `::1`, or the bridge refuses to start. Optional `CONTEXT_BRIDGE_HTTP_TOKEN` requires `Authorization: Bearer` on that endpoint. The Hub token stays in the bridge process.

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
pnpm --filter @ensemble/hub-api test:bridge    # resolution, auth, no write methods
pnpm --filter @ensemble/context-bridge test    # in-memory MCP client, stdio, Streamable HTTP, mocked hub-api
pnpm bridge:verify                             # both, plus typecheck, build and dist smoke
pnpm bridge:e2e                                # live Postgres, hub-api, both transports, security
```

The smoke script (`apps/context-bridge/scripts/smoke.ts`) speaks MCP to the built server against a mocked hub-api and checks `tools/list`, a tool call and resources.

`pnpm bridge:e2e` (`scripts/live-e2e.ts`) creates the `ensemble_pg` volume if needed, starts `infra/docker-compose.yml`, writes a gitignored `.env` when missing, runs `db:generate`, `db:push` and `db:seed`, builds the bridge, starts hub-api on `127.0.0.1:4000` with `ENSEMBLE_DEV_AUTH_BYPASS=true`, and mints a real `ens_` key through `POST /api/connect/token`. The seed covers every status, a task linked to `encode/httpx` on branch `docs/default-timeout`, two tasks on `retry-helper`, deliverables, calendar events in the next 14 days, meeting notes, a file and a document, and a pending editor decision; the script also uploads `latency-readout.md` and opens a Needs-me prompt.

It then connects with the MCP SDK over stdio (as the editor configs do) and over Streamable HTTP at `http://127.0.0.1:4010/mcp`, calls every tool, reads every resource and item template, and compares payloads with the database (counts, ids, titles, trust labels). Security checks cover bridge-key writes (403 elsewhere in hub-api, 405 on `/api/bridge`), key minting, refusal of `ENSEMBLE_DEV_AUTH_BYPASS` and `dev-internal-token` on bridge routes, loopback binds, refusal of a non-loopback host, missing and invalid tokens, hub-api down, and Postgres/Redis refusing non-loopback connections.

The script leaves hub-api and the HTTP bridge running, writes logs under `/tmp/ensemble-bridge-e2e/` and a JSON summary to `bridge-e2e-report.json` in the repo root, and never prints the token.

A passing handshake does not show that an editor picks the right tool or that a remote client supports bearer headers.
