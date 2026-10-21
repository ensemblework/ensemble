# Caching and UI performance

Domain records are authoritative in the database; every cache below is bounded and short-lived. Authenticated content is never treated as public CDN data.

## 1. Cache map

| Area | Where and how long | Invalidation or boundary |
| --- | --- | --- |
| UI queries | React Query (`apps/hub-web/app/providers.tsx`): fresh for 20 s by default; people, projects, repos, skills, preferences, entities and settings 60 s; `me` 5 min; graph and shell 30 s | Scoped query keys; mutations and SSE invalidate. Not offline sync |
| Navigation prefetch | `lib/prefetch.ts` remembers the 32 most recently prefetched paths and requests fixed API paths per route | Dedupe only |
| Provider discovery | `model_catalogs` table (`lib/model-catalog.ts`); 15 s per-user response cache in `routes/system.ts`; 60 s model metadata (`lib/model-meta.ts`) | Refreshed after a week, sooner after a failed fetch, on key change, or by `POST /api/models/refresh`. Metadata only |
| Repository lists and changed files | `lib/git.ts` repo list 20 s; `routes/code.ts` changed-file stats 8 s, 200 entries | Short TTLs; edits show on the next miss |
| GitHub CLI token | `connectors/accounts.ts` remembers `gh auth token` for 60 s | Local lookup only |
| Repository mirrors | `repo/mirror.ts`: shallow partial clone in the app cache, at most 200 MB; concurrent fetches share one promise | Refreshed after 6 hours or when HEAD moves. Tokens never enter the remote URL |
| Context suppressions | `connectors/ingest.ts`: per space and kind, 64 entries, 60 s | Rebuilt from `ContextSuppression` rows |
| Import previews | `imports/previews.ts`: in memory, one per person, 30 min after last use | Never written to the database or logged |
| OAuth state, SSE tickets, passkey challenges | MCP OAuth state 10 min (`connectors/mcp/provider.ts`); one-use SSE tickets (`routes/misc.ts`); terminal passkey challenges 120 s (unlock) or 300 s (register) (`routes/terminal.ts`, `devices/web-unlock.ts`) | Single-use authorization state, not content |
| Remote file, code and subscription relays | Redis keys with expiry (`devices/file-relay.ts`, `devices/code-routes.ts`) | Timeouts and ownership/token checks; not a file backup |
| Included models on a paired computer | `included/device.ts` holds the account's catalog and credits from the server for 60 s | The server stays authoritative for every reservation and call |
| Version and update check | `lib/release-info.ts`: 5 min, 30 s after a failure | Signed packages and manifests are still validated |
| Plot tables | `plots/cache.ts`: LRU of parsed tables keyed by dataset id and content hash; 8 entries, 64 MB, 10 min | [20 §6](20_PLOTS_DESIGN.md#6-caching) |

Pause flags do not expire into Resume. Device leases, login sessions and terminal unlocks have their own expiry; none is a data cache.

## 2. Assistant prompts and cached tokens

`assistant/skills/index.ts` routes each request to a small set of playbooks and tools, and `assistant/state.ts` puts stable instructions before live data. Personal skill bodies are read on demand. This helps provider prefix caching, but hits depend on the provider, prompt and timing. Usage records the provider's reported cached tokens; no discount is assumed.

Tool results are never shared across accounts. Tool visibility, input schema and authorization are checked on every call. Included-model reservations stay conservative even when the provider may hit its prompt cache ([33](33_INCLUDED_AI.md)).

## 3. UI performance

- The Hub shell persists across client navigation. Data comes from scoped React Query reads; page co-editing uses its own version protocol.
- Heavy views load through `next/dynamic`: the diagram editor, plot studio and workspace, task and note pages, comments, context graph and tabs, settings tabs, widget lenses and the guided tour. Check the import graph before adding a dependency to shell or card code.
- `GET /api/tasks` returns task rows only; page documents and file originals load from their own routes. Detail readers and model tools are bounded or chunked.
- File extraction, Office and plot work have explicit resource limits and run in workers or the browser. Hosted plotting downloads its browser runtime on first use.
- The desktop app loads route bundles from its static export and calls the loopback API; there is no Next server in the webview.

## 4. Measuring

Use a production build (`next build`), never `next dev`. Record the commit, OS and browser, viewport, network and CPU throttling, account size, warm or cold state and provider mode. Measure separately: shell paint, data ready, editor interactive, remote or model wait. Record route JavaScript, critical requests, payload sizes, input-to-paint and long tasks, and API p50/p95 with sample counts. For files and plots, give format and size, runtime start-up and warm export separately. For assistant changes, give input, output and cached tokens and whether the action succeeded.

Starting points: `scripts/measure-diagrams.mjs`, `measure-nav.mjs`, `measure-open.mjs`, `measure-ui.mjs`, `ui-walk.mjs`, `verify-followup.mjs` and `apps/hub-web/e2e/*.mjs` (Playwright, run by hand; read each script's environment and fixture assumptions first). Put results, screenshots and recordings in the PR. Never use real accounts, tokens or production data as fixtures.

`pnpm --filter @ensemble/hub-web test` checks UI contracts, not rendering speed. A loopback measurement does not predict hosted latency.
