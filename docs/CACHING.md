# Caching

Ensemble does not keep a second copy of tasks, pages, or diagrams in Redis, and authenticated JSON is not given a `Cache-Control` max-age. Those choices are in `docs/UI_PERF_DESIGN.md`. The caches that do exist are process-local maps with a bound.

## What is cached

| Cache | Where | Bound | TTL | Invalidation |
|---|---|---|---|---|
| Git changed-file stats | `apps/hub-api/src/routes/code.ts` | 200 entries, least recently used | 8 seconds | A miss after the TTL re-reads git. Editing a file is visible on the next miss. |
| Discovered repo lists | `apps/hub-api/src/lib/git.ts` | 32 keys, least recently used | 20 seconds | Expired keys are dropped on the next lookup. |
| Suppressed context keys | `apps/hub-api/src/connectors/ingest.ts` | 64 keys, least recently used | 60 seconds | The timer deletes the key. A full suppression set is at most one entry per user and kind. |
| Sidebar prefetch dedupe | `apps/hub-web/lib/prefetch.ts` | 32 hrefs, least recently used | 20 seconds | The next hover after the window refetches. |
| OAuth `state` values | `apps/hub-api/src/connectors/oauth.ts` | 64 in flight | 10 minutes | Expired states are deleted when a new sign-in starts. The state is single use. |
| SSE tickets | `apps/hub-api/src/routes/misc.ts` | 200 | 60 seconds | Deleted when the stream connects, and expired tickets are swept when a new one is issued. |
| Terminal sessions and passkey challenges | `apps/hub-api/src/routes/terminal.ts` | 100 sessions, 100 challenges | idle 30 minutes, max 8 hours, challenges 2–5 minutes | Expired rows are removed when a new session or challenge is created. |
| Repo mirror checkouts | `apps/hub-api/src/repo/mirror.ts` | one in-flight promise per checkout | the promise is removed when it settles | Not a result cache. |
| React Query | hub-web | the library's garbage collection | per-query `staleTime` | Mutations call `invalidateQueries` for the keys they change. |

The pause flag `ensemble:paused:<userId>` in Redis has no TTL on purpose. Expiring it would resume model calls the person had stopped. It is one key per user and it is deleted on resume.

## What was not added

Diagram clicks were slow because the list imported the diagram package barrel (which loads the layout engine) and the editor statically imported both the canvas and CodeMirror. In development that route compiled elk, xyflow, and CodeMirror before the page could paint. The list now imports `@ensemble/block-diagrams/templates`. CodeMirror loads in its own chunk after the canvas is up. The canvas stays in the editor chunk: a separate canvas chunk added a round trip and made a production open slower (392 ms, 251 KB, against 224 ms and 226 KB before the split). No diagram payload cache was added: the wait was script and compile, not a repeated API read.

Page width is one integer on the account settings document, plus one localStorage key so the first paint can use it. It is not a cache of page contents.
