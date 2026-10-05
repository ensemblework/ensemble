# Context Bridge

Read-only MCP server so a coding agent can read Ensemble (tasks, projects, repositories, skills, deliverables, calendar, people, Needs me, and a cited brief for the current branch).

The server is `apps/context-bridge`. It speaks MCP and calls `hub-api` over HTTP. It does not open Postgres. There are no tools that create, update, delete, or send anything.

`docs/13_MODULE_CONTEXT_BRIDGE.md` is the original design. This page is what this tree actually runs. Where the design names modules that were not rebuilt (`retrieval.ts`, `context/pack.ts`, embeddings), the bridge reads the tables that exist and says so in `ensemble_gaps`.

## Run it

```bash
pnpm bridge:build          # tsc → apps/context-bridge/dist
pnpm bridge:start          # stdio (what editors launch)
pnpm bridge:http           # Streamable HTTP on 127.0.0.1:4010
pnpm bridge:verify         # typecheck, MCP client tests, smoke
```

`hub-api` has to be up (`pnpm dev`) or every tool returns: `Ensemble is not running. Start it with `pnpm dev`.`

## Token

The guided setup for every app is in the Hub at **Connect your apps** (`/connect`). That page creates a read-only key, fills in this computer’s paths, and offers one-click install where the app supports it (VS Code and Cursor). The samples below are the same configuration.

1. In the Hub: **Connect your apps → Create a read-only key**. The value starts with `ens_` and is shown once. It can only read `/api/bridge`. A key made under **Settings → Editors & agents** still works, and that one can also drive editor hooks.
2. If creating a key fails on an older database, run `pnpm db:push` once so the read-only scope can be stored.
3. Export it where the editor can see it:

```bash
export ENSEMBLE_BRIDGE_TOKEN=ens_...
```

The bridge does not use `ENSEMBLE_INTERNAL_TOKEN`. That value defaults to `dev-internal-token`, which hub-api warns about at startup and which the bridge rejects. It is the service credential for agent-runtime. Set a private one (`openssl rand -hex 32`) if anything besides this machine can reach port 4000.

`ENSEMBLE_DEV_AUTH_BYPASS` is also rejected on `/api/bridge/*`.

A local demo can opt into the default internal token with both:

```bash
export ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN=true
export ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true
```

Do not do that on a shared network.

## What a model can read

| Tool | Resource | Data |
|---|---|---|
| `ensemble_brief` | — | Current task from repo + branch, project, people, deliverables, your skills (`howIWork`), cited excerpts |
| `ensemble_search` | — | Substring search across tasks, projects, people, skills, repos, artifacts, meeting notes |
| `ensemble_read` | `ensemble://items/{kind}/{id}` | One item in full (paginated) |
| `ensemble_tasks` | `ensemble://tasks`, `ensemble://tasks/{id}` | Tasks |
| `ensemble_projects` | `ensemble://projects`, `ensemble://projects/{id}` | Projects |
| `ensemble_repos` | `ensemble://repos`, `ensemble://repos/{id}` | Repositories |
| `ensemble_skills` | `ensemble://skills`, `ensemble://skills/{id}` | Current skill only |
| `ensemble_deliverables` | `ensemble://deliverables` | Deliverables |
| `ensemble_meetings` | `ensemble://meetings` | Upcoming calendar events (`Artifact` kind `event`) |
| `ensemble_people` | `ensemble://people`, `ensemble://people/{id}` | Engineer Graph people |
| `ensemble_decisions` | `ensemble://decisions` | Needs me: pending approvals and editor prompts |
| `ensemble_today` | `ensemble://today` | Focus, proposed todos, deliverables, meetings, Needs-me counts |
| `ensemble_gaps` | `ensemble://gaps` | What this build does not have |

`ensemble_brief` reads `repo` and `branch` from the process working directory when the caller omits them (`git rev-parse` and `origin`).

Mail, chat, GitHub text, calendar invites, approval previews, and editor tool inputs are labelled `trust: "untrusted"`. Skills are `trusted`. The brief repeats that retrieved text is not instructions.

### Not in this build

Reported by `ensemble_gaps` instead of being invented:

- Semantic / embedding search and the context-pack ranker designed in [docs/13](13_MODULE_CONTEXT_BRIDGE.md). `searchVector` and `embedding` columns exist and are unused. Search is a case-insensitive substring match.
- Outlook, Outlook calendar, and Teams.
- Saved M365 answers. Meeting notes are `MeetingNote` rows.
- A `redactSecrets` helper. Stored text is returned as stored, and labelled.
- Private reminders. They exist on Today and are excluded here.
- Skill version history. Only the current body is returned.
- Any write.

## Transports

- **stdio** (default). No port. Editors launch `node apps/context-bridge/dist/index.js`.
- **Streamable HTTP** on `127.0.0.1` only (`--http`, port `4010`, `CONTEXT_BRIDGE_PORT` to change it). `CONTEXT_BRIDGE_HOST` must be `127.0.0.1`, `localhost`, or `::1`. Endpoint: `http://127.0.0.1:4010/mcp`. Optional `CONTEXT_BRIDGE_HTTP_TOKEN` requires `Authorization: Bearer` on that endpoint. The Hub token stays in the bridge process.

`hub-api` listens on `HUB_API_HOST` (default `127.0.0.1`, not `0.0.0.0`). Postgres and Redis from `infra/docker-compose.yml` are the same idea: host ports `5432` and `6379` are bound to `127.0.0.1` and `::1`, not every interface. `localhost` in `DATABASE_URL` and `REDIS_URL` still reaches them.

## Client setup

Prefer **Connect your apps** in the Hub. It uses the commands and files on this page, with your key and paths filled in.

Build first (`pnpm bridge:build`). Replace `ens_PASTE_TOKEN` and absolute paths. Do not commit a real token. Project files that are already in the repo use `${env:ENSEMBLE_BRIDGE_TOKEN}` or `${ENSEMBLE_BRIDGE_TOKEN}` so the token stays in the environment. `${input:…}` is avoided because it drops the server from VS Code's Agent Host. One-click install links (`vscode:mcp/install` and `cursor://anysphere.cursor-deeplink/mcp/install`) also keep the key in the environment and do not put it in the URL.

Samples also live in `apps/context-bridge/clients/`.

### VS Code (GitHub Copilot agent mode)

Committed: `.vscode/mcp.json` (`servers`). Same file: `apps/context-bridge/clients/vscode.mcp.json`.

User-level (every folder): VS Code profile `mcp.json`, same `servers` shape, with an absolute `args` path.

Reload the window. In the Chat tools list, enable the Ensemble server. Agent mode can call the tools.

### GitHub Copilot CLI

`~/.copilot/mcp-config.json` uses `mcpServers`, not `servers`. `.vscode/mcp.json` is not read. Paste `apps/context-bridge/clients/copilot-cli.mcp.json`.

```bash
copilot mcp add ensemble -- node "$PWD/apps/context-bridge/dist/index.js"
```

Then confirm the token is in that file's `env`. In a session: `/mcp`.

### Cursor

`.cursor/mcp.json` is committed (`mcpServers`). Cursor also reads `~/.cursor/mcp.json`. Sample: `apps/context-bridge/clients/cursor.mcp.json`.

### Claude Code

Committed: `.mcp.json`. Or:

```bash
claude mcp add --transport stdio \
  --env ENSEMBLE_BRIDGE_TOKEN="$ENSEMBLE_BRIDGE_TOKEN" \
  --env HUB_API_URL=http://127.0.0.1:4000 \
  ensemble -- node "$PWD/apps/context-bridge/dist/index.js"
```

Sample: `apps/context-bridge/clients/claude-code.mcp.json`.

### Claude Desktop

Paste `mcpServers` from `apps/context-bridge/clients/claude-desktop.mcp.json` into `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use an absolute path to `dist/index.js`. Restart Claude Desktop.

### OpenAI Codex CLI

Add `apps/context-bridge/clients/codex.config.toml` to `~/.codex/config.toml` (merge, do not replace the rest of the file).

### Windsurf

Paste `apps/context-bridge/clients/windsurf.mcp.json` into `~/.codeium/windsurf/mcp_config.json`.

### Streamable HTTP

Start `pnpm bridge:http`, then use `type: "http"` and `url: "http://127.0.0.1:4010/mcp"`. Shapes for VS Code (`servers`) and for everyone else (`mcpServers`) are in `apps/context-bridge/clients/http.mcp.json`.

## Packaging the model already has

- `.github/agents/ensemble.md` — custom agent. Ask it to call `ensemble_brief` and cite sources.
- `.github/skills/ensemble-context/SKILL.md` — project skill. Copy the folder to `~/.copilot/skills/ensemble-context/` if you want Copilot CLI to load it from the user profile as well.

## Failure behaviour

| Situation | What you get |
|---|---|
| hub-api down | `Ensemble is not running. Start it with `pnpm dev`.` |
| Token missing or still the default internal token | A configuration error. No empty brief. |
| Repo not tracked | Says so, and searches only if you passed a query. |
| Branch matches no open task | Repo and project context, no guessed task. |
| Branch matches several tasks | The candidates. None is chosen. |
| Nothing relevant | Says so. |
| Long body | Excerpt plus `ensemble_read`. |

## Tests

```bash
pnpm --filter @ensemble/hub-api test:bridge    # resolution, auth, no write methods
pnpm --filter @ensemble/context-bridge test    # in-memory MCP client, stdio, streamable HTTP, mocked hub-api
pnpm bridge:verify                           # typecheck + those tests + dist smoke
pnpm bridge:e2e                              # live Postgres, hub-api, both transports, security
```

The smoke script is the stand-in for MCP Inspector: it speaks MCP to the built server and checks `tools/list`, a tool call, and resources. It uses a mocked hub-api.

`pnpm bridge:e2e` is the live test. It creates the external `ensemble_pg` volume if needed, starts `infra/docker-compose.yml` (Postgres with pgvector, and Redis), writes a gitignored `.env` when one is missing, runs `db:generate`, `db:push`, and `db:seed`, builds the bridge, starts hub-api on `127.0.0.1:4000` with `ENSEMBLE_DEV_AUTH_BYPASS=true`, and mints a real `ens_` key through `POST /api/connect/token`. `pnpm db:push` loads that `.env` (the Prisma CLI does not, on its own). Seed data covers every status, a task linked to `encode/httpx` on branch `docs/default-timeout`, two tasks on `retry-helper`, upcoming deliverables, calendar events in the next 14 days, meeting notes, a file and a document, and a pending editor decision. The script also uploads `latency-readout.md` and opens one Needs-me prompt through the Hub APIs.

It then connects with the official MCP SDK the way the editor configs do (`node apps/context-bridge/dist/index.js` over stdio, with `HUB_API_URL` and `ENSEMBLE_BRIDGE_TOKEN`) and over Streamable HTTP at `http://127.0.0.1:4010/mcp`. Every tool is called, every fixed resource is read, and every item template is read with a real id. Payloads are compared to the live database (counts, ids, titles, trust labels). Security checks cover bridge-token writes (403 on the rest of hub-api, 405 on `/api/bridge`), token minting, rejection of `ENSEMBLE_DEV_AUTH_BYPASS` and `dev-internal-token` on bridge routes, loopback binds, a non-loopback host refusal, missing and invalid tokens, hub-api down, and Postgres/Redis not accepting connections on non-loopback addresses.

The script leaves hub-api and the HTTP bridge running. Logs are under `/tmp/ensemble-bridge-e2e/`. A JSON summary is written to `bridge-e2e-report.json`. The token is not printed.
