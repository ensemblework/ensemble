# 13 · Context Bridge architecture

The Context Bridge is Ensemble's **read-only MCP interface** for external editors and AI clients. The same server definition serves the source build, `ensemble mcp` and hosted `/mcp`. Code inspected **18 Oct 2026**. For installation/config snippets use [CONTEXT_BRIDGE](CONTEXT_BRIDGE.md); for CLI setup use [26](26_CLI.md).

## 1. Architecture

```text
Editor / MCP client
    → stdio bridge OR loopback HTTP bridge OR hosted /mcp
    → apps/context-bridge/src/server.ts (buildServer)
    → scoped hub-api /api/bridge routes
    → bridge/service.ts + existing saved workspace records
```

The bridge process does not open the database or hold model API keys. The host endpoint uses the same tool definitions with an HTTP Hub adapter. The external editor owns its model/tool loop; Ensemble supplies reference material.

## 2. Source map

| Path | Responsibility |
| --- | --- |
| `apps/context-bridge/src/server.ts` | MCP tools/resources/prompts and read-only annotations |
| `apps/context-bridge/src/hub.ts` | HTTP adapter, auth and returned errors |
| `apps/context-bridge/src/config.ts` | Config/environment and local runtime discovery |
| `apps/hub-api/src/bridge/routes.ts` | Read-only bridge HTTP routes |
| `apps/hub-api/src/bridge/service.ts` | Scoped queries, reads, brief assembly and pagination |
| `apps/hub-api/src/bridge/resolve.ts` | Repository/branch/task resolution |
| `apps/hub-api/src/bridge/auth.ts` | Bridge access boundary |
| `apps/hub-api/src/routes/mcp.ts` | Authenticated hosted Streamable HTTP |
| `apps/hub-api/src/bridge/gaps.ts` | Diagnostics/exclusion text; some old diagnostics need code cleanup (§7) |

## 3. Tools and resources

| Tool | Purpose |
| --- | --- |
| `ensemble_brief` | Resolve work from repo/branch/task and assemble cited task/project/people/skill/file excerpts |
| `ensemble_search` | Bounded substring search over supported stored entities/content |
| `ensemble_read` | One typed entity/text body, in bounded chunks |
| `ensemble_tasks`, `ensemble_projects`, `ensemble_repos` | Work/context lists |
| `ensemble_repo_overview`, `ensemble_repo_file` | Permitted repository outline/file reads, with path/secret restrictions |
| `ensemble_diagrams`, `ensemble_plots` | Saved diagrams and figures/spec context |
| `ensemble_skills` | Current enabled personal instructions; explicit current-body read |
| `ensemble_deliverables`, `ensemble_people`, `ensemble_meetings` | Saved context, including stored calendar events |
| `ensemble_decisions` | Read pending Needs me context; cannot answer/approve |
| `ensemble_today` | Bounded daily work summary |
| `ensemble_gaps` | Declared exclusions/missing paths, subject to the diagnostic caveat below |

Fixed `ensemble://` resources and typed resource templates expose the same scoped reads. A resource URI is an MCP identifier, not permission to open local files. Saved diagrams/files remain subject to their feature and account scope.

### Current skills

Only the current body is returned as instruction context; retained `SkillVersion` bodies are not exposed as current skills. Disabled/deleted skills are omitted from active briefs. Run signatures preserve historical version identity separately ([04](04_MODULE_SKILL_FORGE.md)).

## 4. Retrieval and resolution

Local stdio callers can detect repository and branch from their working directory. Hosted `/mcp` cannot inspect the editor's directory; pass repo/branch/task explicitly. Resolution returns ambiguity/missing context rather than selecting a similarly named task as fact.

Search is case-insensitive matching over stored fields, not an embedding ranker. Schema vector/tsvector fields are not populated/queried by this interface. The old seed → graph expansion → embeddings → compression/context-pack cache design is not built. Enabling an embedding provider does not activate it.

Briefs return bounded current writing, linked data, current skills and source citations. Original file bytes are not streamed through `ensemble_read`; supported extracted text is. Connected source copies can be stale until explicitly refreshed; bridge reads are not vendor live-search calls.

## 5. Authentication and transport

- Stdio has no listener; the process carries its Hub key.
- Optional standalone HTTP binds loopback and can require its own bearer credential. The underlying Hub key stays in that bridge process.
- Hosted `/mcp` is stateless Streamable HTTP with an `ens_` bearer key; browser cookies, device keys and missing keys are not substitutes. Unsupported methods return 405.
- Token creation/revocation remains a human account action. The bridge cannot mint broader credentials.

The external MCP authorization-server/OAuth login flow is not implemented. This is different from Ensemble acting as an OAuth **client** when connecting a vendor MCP server. Client products differ in whether they support static bearer headers or local stdio; use the actual editor guide rather than promising every remote-client login works.

## 6. Read-only boundary

No bridge tool creates tasks, edits pages, sends messages, changes layouts, approves runs or starts an agent. Private reminders and UI layout chrome are excluded. Other readers still apply resource/module/sharing checks; a read-only key is not a universal bypass.

The separate task-specific `ensemble-ask-mcp.mjs` server used inside managed engine runs can expose run-scoped question/chat actions. It is **not** this read-only Context Bridge and does not expand an external editor's `ens_` access. [30](30_ENGINES.md).

Returned third-party text is labeled reference material with provenance. The bridge reads stored text; do not promise a new anonymization/redaction pass at this boundary. The owning file/ingest paths have their own redaction helpers. Original secrets must never be intentionally saved as public context.

## 7. Known diagnostics limitation

`bridge/gaps.ts` still says Outlook/Teams and a redaction helper are missing. Those statements predate the current connector/redaction implementations. They are stale **runtime diagnostic strings**, not accurate current product limitations. This Markdown-only audit records the follow-up without changing code. The semantic-retrieval and read-only/private-reminder boundaries remain real.

## 8. Verification

`pnpm bridge:verify` runs the source package and Hub bridge checks; `pnpm bridge:e2e` is a separately configured live path. Tests cover tool registration/transport, scoped requests, resolution, current skill bodies, read-only auth and error behavior. No model inference is required to prove a bridge response shape.

A successful MCP handshake does not prove an editor will choose the right tool, that a remote client supports bearer headers, or that a source copy is current. Live editor/provider evidence should identify the actual version/commit and environment rather than remain an undated universal claim.
