# Ensemble Hub — UI and performance design

Measured on 2026-09-29 against a production build (`next build && next start` on port 3000, hub-api on port 4000, Postgres 16 + Redis 7, seeded local account). Numbers below are the baseline. The same script is re-run after the change; results live in the PR description.

## 1. Baseline

### How it was measured

- Web: production build, not `next dev`. Chrome headless via Playwright against `http://localhost:3000` (same-site with the API on `localhost:4000`, so the session cookie is actually sent).
- Lighthouse 12 default settings (simulated slow 4G, 4× CPU) on `/login`.
- API: 3 warmup requests then 20 samples, cookie session, loopback. p50/p95 are client round trips.
- SQL: `log_min_duration_statement = 0` for one request per route. Each Prisma statement is logged twice (bind + execute), so statement count is about half the line count. The agent queue’s `workspace_jobs` poll was excluded. Turning the log off changed `GET /api/tasks` by about 0.2 ms, so the log is not the story.
- No model keys and no connector tokens. Agent-runtime was not required for these pages. `GET /api/model-keys` returns 503 when the runtime is down; the UI must keep working.

### Route JavaScript (First Load JS)

Shared shell: **103 kB**.

| Route | Page JS | First Load JS |
|---|---:|---:|
| `/today` | 6.6 kB | 137 kB |
| `/board` | 21.8 kB | 142 kB |
| `/needs-me` | 5.8 kB | 129 kB |
| `/runs` | 3.7 kB | 124 kB |
| `/context` | 12.3 kB | 136 kB |
| `/skills` | 3.8 kB | 124 kB |
| `/workspace` | 5.2 kB | 136 kB |
| `/code` | 2.2 kB | 133 kB |
| `/code/review` | 240 kB | **371 kB** |
| `/metrics` | 3.6 kB | 124 kB |
| `/settings` | 9.7 kB | 139 kB |
| `/tasks/[id]` | 0.3 kB | **283 kB** |
| `/login`, `/signup` | 1.6 kB | 125 kB |

TipTap is pulled into the task page (and, through the peek panel, sits on the layout import graph). CodeMirror plus language packs dominate `/code/review`. The graph view is custom DOM, not a chart library.

### Web Vitals and navigation

| Surface | Result |
|---|---|
| Lighthouse `/login` | score 100, FCP 759 ms, **LCP 1.66 s**, TBT 42 ms, CLS 0 |
| Playwright `/login` (no throttle) | TTFB 3 ms, FCP 40 ms, load 66 ms |
| Click Sign in → task title visible | **262 ms** |
| Cold `/today` document load | TTFB 2 ms, load 77 ms, **14 API calls** before the page is filled |
| Warm client navigation (sidebar, data already cached or one fetch) | shell **28–43 ms**, data-ready **32–86 ms** |

Warm navigation is already quick on loopback because Next prefetches the route modules. The cost shows up on a cold Today load and on any real network: the shell waits for `GET /api/auth/me` before children mount, then the page opens a fan of requests. Chrome allows six HTTP/1.1 connections per host, so request 7 waits.

Cold Today calls: `me`, `tasks`, `settings`, `deliverables`, `reminders`, `calendar`, `projects`, `approvals`, `decisions`, `connections`, `agent/state`, `entities`, `events/ticket`, plus the SSE stream.

### API latency and queries

| Endpoint | p50 | p95 | Bytes | SQL log lines (≈ statements) | Why |
|---|---:|---:|---:|---:|---|
| `GET /api/auth/me` | 1.5 ms | 2.0 ms | 103 | 4 (≈2) | session + user |
| `GET /api/tasks` | 2.3 ms | 2.7 ms | 13 kB | 4 (≈2) | session + one `findMany` |
| `GET /api/approvals` | 1.6 ms | 1.9 ms | 952 | 4 | fine |
| `GET /api/decisions?status=pending` | 2.1 ms | 2.4 ms | 16 | 8 | fine at this size |
| `GET /api/deliverables` | 1.8 ms | 2.0 ms | 1.4 kB | 6 | fine |
| `GET /api/reminders` | 1.6 ms | 1.9 ms | 327 | 4 | fine |
| `GET /api/calendar` | 2.0 ms | 2.3 ms | 23 | 6 | fine |
| `GET /api/runs?take=20` | 2.8 ms | 3.7 ms | 2.2 kB | 10 | fine |
| `GET /api/people` | 1.9 ms | 2.4 ms | 1.2 kB | 8 | fine |
| `GET /api/projects` | 2.7 ms | 3.8 ms | 1.0 kB | 12 | includes counts |
| `GET /api/context/graph` | 2.9 ms | 3.2 ms | 7.2 kB | 22 (≈11) | already `Promise.all`, not N+1 |
| `GET /api/skills` | 1.9 ms | 2.1 ms | 3.1 kB | 6 | fine |
| `GET /api/workspace` | 2.9 ms | 3.7 ms | 3.9 kB | ~6 | fine |
| `GET /api/metrics/summary` | 2.8 ms | 5.3 ms | 2.2 kB | 26 (≈13) | parallel, small rows |
| `GET /api/entities` | 2.1 ms | 2.4 ms | 3.6 kB | ~15 | assistant mentions, fetched on every page |
| `GET /api/connections` | **50 ms** | **51 ms** | 3.9 kB | 12 | **`gh auth token` (~64 ms) on the miss path** |
| `GET /api/settings` | **49 ms** | **50 ms** | 1.9 kB | 10 | same `gh` spawn, and Today loads settings for the timezone |
| `GET /api/code/reviews` | **38 ms** | **40 ms** | 1.3 kB | ~12 | git status **per review**, and `roots()` inside the loop |

Responses were uncompressed (`content-encoding` null). Indexes on `userId` + status/due already exist for tasks; the slow routes are process spawns, not missing indexes. The graph and metrics queries are parallel and cheap at seed size. There is no N+1 on `GET /api/tasks`.

Every authenticated request also looks up the session row. On loopback that is ~0.05 ms. It is still on the critical path of every call.

### What the UI feels like

Flat dark gray (`#1f1f1f`), system sans, 30 px bold titles, a blue `#2f86e8` accent, and cards whose border flashes white on hover. That is Notion dark mode. The assistant is a sparkle orb. Loading states are a single spinner, including a full-screen spinner that blocks the shell until `/api/auth/me` returns. Keyboard triage on Today works; there is no command palette.

## 2. Visual and interaction system

Direction: a dense instrument, closer to Linear and Things than to a document tool or a chat app. Effects are opacity, transform, and one static radial wash. No animation library.

### Tokens

| Token | Dark | Light |
|---|---|---|
| Canvas `--bg` | `#0c0d11` | `#f4f1ea` |
| Sidebar | `#101218` | `#ebe6dc` |
| Panel | `#16181f` | `#fffcf7` |
| Raised | `#1c1f29` | `#f7f3ec` |
| Ink | `#eceae4` | `#1c1915` |
| Muted | `#a3a199` | `#6d675e` |
| Faint | `#8b877e` | `#8a8378` |
| Accent | `#7c6af7` | `#5346d6` |
| OK / warn / danger | `#3cba86` / `#e0a04a` / `#e36b64` | same hues, tuned for the paper background |
| Radius | 8 px controls, 12 px cards, pill for status | |
| Elevation | inset 1 px top hairline; popover `0 16px 40px rgba(0,0,0,.45)` | softer shadow on paper |
| Type | Inter via `next/font` (swap), 13.5 px body, **22 px / 600** page titles, tracking tight | JetBrains Mono for code |
| Motion | 120 ms hover, 180 ms overlays, `cubic-bezier(0.2, 0.8, 0.2, 1)` | |
| Focus | 2 px accent ring, 2 px offset, `:focus-visible` | |

The canvas carries one static radial gradient (accent at low alpha, top of the shell). It does not animate. `prefers-reduced-motion: reduce` and the existing Settings toggle both set `data-reduce-motion`, which already disables transitions and animations. The toggle forces reduction; when it is off, the OS preference is followed.

Light mode stays. It is warm paper, not Notion white. Contrast targets: muted text ≥ 4.5:1 on canvas, white on the accent button ≥ 4.5:1.

### UX, per surface

- **Shell.** Wordmark is a small three-bar mark, not a sparkle. Active nav is an accent wash plus a 2 px bar. Hover and focus prefetch that route’s data. `⌘K` opens a command palette (pages and tasks). `?` opens the shortcut sheet. Top bar is 44 px and slightly translucent.
- **Today.** Eyebrow with the date. Focus rows get a checkbox when the status can move to done (optimistic). Proposed cards triage optimistically. Skeletons instead of a spinner. Shortcuts stay (`J/K/M/A/L/D/O`).
- **Board.** Same optimistic drag as today. Skeleton columns while the first fetch is in flight. Drop target uses the accent wash.
- **Needs me.** Approving, rejecting, or answering removes the card immediately and rolls back if the request fails.
- **Runs, Skills, Workspace, Code, Metrics.** Shared page header, skeleton on first load, empty states with a dashed frame. No features removed.
- **Context.** Tabs become a segmented control. Panels are split so the graph chunk is not in the People tab’s first paint. Graph edges use a theme token (they were hard-coded white). Nodes keep drag, zoom, focus, and kind filters.
- **Task page.** The editor chunk loads when the page body loads, not with the hub shell.
- **Code review.** CodeMirror loads with the editor, not with the review chrome.
- **Settings.** Unchanged sections. The in-page nav already hides below `xl`, which is what we want at 900 px.
- **Login / signup.** Split panel: mark and one sentence, then the form. Errors stay inline. Narrow widths stack.
- **Assistant.** Stays a dock (`⌘J`). The launcher is an “Ask” pill, not an orb. Copy talks about actions on the board, not a persona. Model calls that fail because no key is configured still surface as an error in the dock; the rest of the app does not depend on them.
- **Empty, loading, error.** `Empty` is a dashed frame. Lists use skeletons. Query errors keep the existing toast path. 401 still redirects to `/login`.

Keyboard shortcuts already on Today, undo (`⌘Z`), and peek are unchanged. Focus rings are global.

## 3. Performance architecture

### What renders where

Pages stay client components. The session cookie is issued by hub-api; the HTML shell has no per-user data to render, and every page is interactive (drag, triage, editor). Server-rendering the lists would add a second fetch path and a second cache. The win is cutting the waterfall in front of the client fetch, not moving the fetch to the server.

The hub layout no longer blocks the tree on `GET /api/auth/me`. The shell and the page queries start together. A 401 still redirects. Middleware redirects a document request with no `ensemble_session` cookie, and also an HTML document whose cookie `/api/auth/me` rejects, before any hub HTML is sent. RSC payloads and prefetches skip that hop so a signed-in navigation is not held on it.

### Same-origin API

The browser calls `/api/...` on the web origin. `next.config.ts` rewrites that to hub-api. POST no longer pays a CORS preflight. SSE stays on `127.0.0.1:4000` with the one-use ticket, because a rewrite can buffer the stream. The ticket request itself goes through the rewrite and carries the cookie.

### TanStack Query

| Data | staleTime | Refetch | Notes |
|---|---|---|---|
| tasks, home, calendar, deliverables, reminders | 20 s | on mutation and SSE | optimistic for triage, complete, move, deliverable toggle |
| shell (badge counts + user) | 30 s | 60 s if SSE is up, 15 s if not | replaces approvals + decisions + connections + me on the sidebar |
| people, projects, repos, skills, preferences, entities, settings | 60 s | SSE / mutation | entities load when the assistant is open or a task page is open, not on every route |
| graph | 30 s | manual refresh + SSE | |
| agent state | 15 s | 2 s while the activity panel is open, 30 s while closed | SSE still invalidates |
| me | 5 min | | filled from the shell response so Settings does not repeat it |

`refetchOnWindowFocus` is off. SSE already invalidates the keys that change. Focus refetch was a burst of every mounted query for no new information.

Hovering a sidebar link prefetches that route’s query (20 s dedupe). Next still prefetches the route module.

### Today is one request

`GET /api/today/home?from&to` returns tasks, upcoming deliverables, reminders, the visible week of calendar events, sync status, and the timezone. The Today page, calendar (this week only), deliverables rail, and reminders rail share one in-flight promise, then write the slices into the existing query keys so optimistic updates and the board keep working. Other weeks still call `GET /api/calendar`. `GET /api/projects` waits until the deliverable dialog opens; the cards already include the project name.

`GET /api/shell` returns the user plus approval count, pending decision count, and connection attention. The sidebar badge uses that instead of three list endpoints.

Individual endpoints stay. The home query is the cold boot only (`staleTime: Infinity`) and seeds the slice caches when they are empty. Mutations and SSE invalidate the slice (`tasks`, `deliverables`, `reminders`, `calendar`) and `shell`, not `home`, so a task change refetches `GET /api/tasks` and does not download the whole today payload again.

### Caching we added

| Cache | TTL | Invalidation | Why |
|---|---|---|---|
| Session identity | none | every request reads the session row | a 15 s in-process cache saved well under a millisecond and let any revocation other than this browser's logout keep working until the TTL. Dropped. |
| `gh auth token` result | 60 s (including “no token”) | process restart | 64 ms spawn on settings, connections, and therefore Today |
| Review file stats (`changedFiles`) | 8 s, keyed by repo + tree | expires; list counts do not change when a hunk is decided | five git processes per list load |
| TanStack Query, as above | 20–300 s | mutation + SSE | the real client cache |
| HTTP compression (`@fastify/compress`, threshold 1 kB) | none (not a cache) | n/a | tasks are 13 kB raw |

`roots()` for the review list is hoisted out of the per-review loop so settings are not re-read five times.

### What we chose not to cache

- **Redis for tasks, graph, or settings.** Redis is the activity / pause / cancel store. A second copy of domain rows needs an invalidation scheme that SSE already solves on the client. The rows are small and indexed.
- **HTTP cache (`Cache-Control` max-age) on authenticated JSON.** A shared or even private browser cache can show another user’s or a stale board after a mutation. Responses stay uncacheable. Compression is not caching.
- **Server cache of `GET /api/tasks` or the graph.** Seed-sized graph is ~3 ms. Hiding it behind a TTL would make triage and drag lie.
- **Code file bodies, diffs under edit, assistant turns, terminal output.** Stale bytes there are wrong, not just slow.
- **A service worker.** It fights the session cookie and SSE for no gain on a single-user local app.
- **Long polling cuts that drop the activity kill switch.** The closed panel still refreshes slowly so “Idle / Working” stays true if an SSE frame is missed.

### Code splitting

- Peek panel and TipTap stay out of the first-load graph. They are plain `import()` calls, not nested `next/dynamic` boundaries. React 19 reveals a suspended subtree only after a few hundred milliseconds per boundary, which is what made the first peek and the first file tab wait ~830 ms while the main thread did ~175 ms of work.
- TipTap is not warmed from the hub layout. Today, Board, and Needs me call `requestIdleCallback` after the page is interactive (hover and focus of a task still warm immediately, and prefetch `GET /api/tasks/:id` plus the page body). Save-Data and 2G skip the idle download.
- CodeMirror waits for the same idle callback on the review page, and still starts on hover or focus of the file tab. It does not download when the review module evaluates.
- Context tabs are dynamic imports so the graph module is not in the People chunk.

No new UI framework. New runtime dependency: `@fastify/compress` (server only). Inter is loaded with `next/font` `display: "optional"`, `preload: false`, and a metric-adjusted fallback, so a cold Today does not swap fonts and redo layout. Playwright is a devDependency for the walkthrough.

### Database

No new indexes. The hot filters (`userId` + status, due, deletedAt) are already indexed. The graph’s ten reads are one round trip of parallel queries. Metrics is parallel. The review list was a process fan-out, fixed above, not a missing index.

## 4. Out of scope

Security notes in the codebase map (default internal token, no RLS) are untouched. Turbo is still not installed; `pnpm dev:api`, `dev:web`, and `dev:agent` stay the way to run the app. Live model calls are not exercised.

## 5. After (same production method, 2026-09-29)

### Route JavaScript

Shared shell stays **103 kB**. Heavy editors left the first load.

| Route | Before page / first load | After page / first load |
|---|---:|---:|
| `/today` | 6.6 / 137 kB | 9.3 / 139 kB |
| `/board` | 21.8 / 142 kB | 22.7 / 143 kB |
| `/needs-me` | 5.8 / 129 kB | 12.9 / 129 kB |
| `/runs` | 3.7 / 124 kB | 11.0 / 124 kB |
| `/context` | 12.3 / 136 kB | 7.2 / **110 kB** |
| `/code` | 2.2 / 133 kB | 7.8 / 133 kB |
| `/code/review` | 240 / **371 kB** | 7.5 / **140 kB** |
| `/tasks/[id]` | 0.3 / **283 kB** | 27.8 / **158 kB** |
| `/settings` | 9.7 / 139 kB | 9.7 / 140 kB |
| `/login` | 1.6 / 125 kB | 0.1 / 125 kB |

Page JS rose on a few routes because skeletons and optimistic updates live in the route chunk. First load did not. CodeMirror and TipTap are async chunks (~473 kB and ~227 kB raw on disk) and are not in the first load.

### Web Vitals (Lighthouse 12, simulated slow 4G, 4× CPU)

| Surface | Before | After |
|---|---|---|
| `/login` score | 100 | 99 |
| `/login` FCP | 759 ms | 757 ms |
| `/login` LCP | 1.66 s | 2.11 s |
| `/login` TBT | 42 ms | 33 ms |
| `/login` CLS | 0 | 0 |
| `/today` (signed in) | not measured | score 96, FCP 759 ms, LCP 2.80 s, TBT 61 ms, CLS 0 |

Unthrottled, a signed-in load of `/today` shows “Reply to Priya…” in **218 ms** and issues **7** API calls (`/api/shell`, `/api/today/home`, notifier `/api/settings` and `/api/reminders`, `/api/agent/state`, the events ticket, and the SSE stream). The baseline fan-out was **14**. Login click to that title was 262 ms before. Client navigations stay in the 40–60 ms band; warm Board and back-to-Today issue **0** extra API calls. Settings navigation went from 7 requests to 0 because the notifier already holds settings.

Throttled LCP on Today is still the cost of a client-rendered page under simulated mobile CPU. The document did not move Today to server rendering: the page is a live query surface, and a server render would duplicate the client fetch.

### API p50 / p95 (ms) and SQL log lines

Statement count is about half the log lines (Prisma bind + execute). Worker polls excluded.

| Endpoint | Before p50 / p95, lines | After p50 / p95, lines |
|---|---|---|
| `GET /api/connections` | 49.7 / 50.7, 12 | **3.4 / 5.0**, 8 |
| `GET /api/settings` | 49.3 / 50.2, 10 | **3.3 / 4.5**, 6 |
| `GET /api/code/reviews` | 37.8 / 40.4, 12 | **12.0 / 12.7**, 6 |
| `GET /api/auth/me` | 1.5 / 2.0, 4 | 1.4 / 1.9, 2 |
| `GET /api/shell` | — | 3.6 / 4.3, 15 |
| `GET /api/today/home` | — (five calls, settings-bound) | **4.5 / 10.3**, 16, gzip |
| `GET /api/tasks` | 2.3 / 2.7, 4 | 2.8 / 4.4, 2 |
| `GET /api/context/graph` | 2.9 / 3.2, 22 | 3.6 / 5.3, 20 |

Responses over 1 kB are gzip (`today/home` wire-compressed; decoded body 14.8 kB). Tasks p95 moved 2.7 → 4.4 ms from compression. That trade is kept. No new indexes.

### Follow-up, same box as `main` (3 cold runs, cache disabled)

Measured after the regressions above were fixed. `main` is `origin/main` built the same way and served on port 3000 against this API. Times are inside the page: navigation start to the first task title, pointerdown to `.ProseMirror`, pointerdown on the file tab to `.cm-editor`. Median of three fresh contexts.

| Action | `main` | this branch |
|---|---:|---:|
| Cold Today, first task visible | 177 ms (205, 177, 164) | **172 ms** (209, 162, 172) |
| First peek, editor ready | 54 ms (56, 54, 54) | **48 ms** (48, 48, 48) |
| Review file tab, editor ready | 33 ms (35, 32, 33) | **32 ms** (34, 32, 31) |
| Longest Today layout pass | — | 16 ms |

On the machine that first reported the regressions, `main` was 382 / 111 / 168 ms and this branch before the fix was 454 / 830 / 832 ms. The wait was nested Suspense reveal throttling, not main-thread work. Flattening those boundaries and prefetching the editor chunk and the page read on hover removed it. The cold-Today layout pass that had grown to ~200 ms (Inter swapping over a fallback) is 16 ms with `display: optional` and a metric fallback.

Those first-load figures are the production build after the editor-open follow-up. The build after the last batch is still a 103 kB shared shell (Today 9.4 / 140 kB, Board 22.8 / 144 kB, review 7.5 / 141 kB). Middleware validates the session cookie on HTML document loads and is 34 kB on the edge, not in the client graph. Below 768px the sidebar wrapper is `max-md:hidden`, so the first client render does not put it in the layout. The drawer is the same tree, shown only while open.

Inputs, textareas, and selects use a 2px rounded accent `:focus-visible` outline. TipTap still loads on Today, Board, and Needs me, but only from `requestIdleCallback` (and on hover or focus). A cold Today transferred **435 KB** of script after that idle warm, and Settings transferred **278 KB** with no editor chunk. A task change on Today issues one `GET /api/tasks`.

Lighthouse on signed-in `/today` (simulated slow 4G, 4× CPU), after the sidebar stopped shifting:

| | Score | CLS | LCP |
|---|---:|---:|---:|
| Mobile | **95** | **0.008** | **2.80 s** |
| Desktop | 99 | 0.067 | 612 ms |

The previous mobile run on this follow-up was score 67, CLS 0.268, LCP 4.2 s.

A missing model runtime or a missing model key is `503` with the runtime's message (`No key for …` when the runtime is up). The assistant panel shows that text, keeps the draft, and links to Settings → Models (`/settings#models`, which opens the Assistant tab). Light-mode priority, status, and Live updates pills measure between 7.3:1 and 8.1:1. Dark stays the default theme.

## 6. Round 2 — the constellation

Round 1 was a careful Linear-style recolor: near-black canvas, one violet accent, Inter, flat cards. It is fast and tidy, and it still reads as someone else's product. Ensemble sits between a planner and the work itself. The thing it has that Notion and Linear do not is the Context DB: people, projects, repos, and tasks tied together. The interface should look like that idea.

### Identity

**Ink and thread.** Dark mode is a warm ink (`#141210` and stepped browns), not Linear's blue-black. Light mode stays the warm paper from round 1 so it remains readable. Depth is a 1 px hairline and a 1 px lift on hover (`transform` only). No blur, no animated gradients.

**Type.** Figtree replaces Inter as the UI face. It uses `display: swap` and is preloaded, with a size-adjusted Arial fallback, so the first visit paints Figtree and the line box does not jump. Fraunces weight 500 is the only display face, also `swap`, with a size-adjusted fallback, and it is not preloaded: titles are few, so the face swaps in after Figtree. JetBrains Mono stays `display: optional` and is not preloaded. The font setting still overrides the UI face. "System" in that list is now Figtree, the Ensemble default.

**Color, more than one accent.** The accent is for actions, focus, selection, and the thread. Entity kinds have their own quiet hues (people coral, projects tide, repos sage, tasks amber, deliverables lilac, skills brass, notes stone). Those hues are dots, chips, and graph nodes. They are not stripes on cards, so a selected proposal no longer wears pink and violet at once.

**The thread.** The mark is three nodes on a curve, not three bars. The same curve shows up as the at-a-glance strip on Today, as edges in the graph, and as the line that ties deliverables. It is the signature: work is a set of connections.

**Motion.** 120–180 ms, opacity and transform, the existing ease. `prefers-reduced-motion` and the Settings toggle still set `data-reduce-motion` and now also cancel the hover lift. Nothing loops except the existing working dot.

**Iconography.** Lucide stays (already shipped). Board cards drop the Notion page icon. Kind is a dot. The graph draws circles, not database rows.

### Accent setting

Five presets, hand-checked for WCAG AA in both themes: indigo (default), tide, ember, rose, brass. Each preset has a dark-theme hex and a light-theme hex. A custom `#rrggbb` overrides the preset. The choice is written to `appearance.accent` / `appearance.accentCustom` in the user's server settings, and mirrored in `localStorage` under `ensemble.appearance` so the boot script can paint `--accent` before first paint.

Shades are derived, not stored: `--accent-fg` is white or `#14120f`, whichever clears 4.5:1 on the fill; if neither does, lightness is walked until one does (and the color still clears the canvas, so links and rings stay readable). `--accent-hover` mixes the fill 14% toward white in dark and toward black in light. Soft fills and the page wash are `color-mix` at 16% and 14%. Charts and `:focus-visible` rings read the same variables.

### What changes, per surface

- **Today.** An orbit of today's focus, proposals, deliverables due today or overdue, and the people and projects named on that work. Each bead is a control: focus, proposals, and deliverables scroll to that section; people and projects open Context filtered to those records. The row wraps, so a 390 px screen does not clip the last beads. The calendar collapses to a one-line week when nothing is saved. Deliverables sit on a thread. Completing one is a 24 px control; the check shows on hover. Opening a deliverable from the graph (`/today?deliverable=`) scrolls to that row and rings it.
- **Board.** Quieter column headers, "New task" instead of "New page", cards lift on hover and no longer wear a page icon.
- **Context.** People and projects become entity plates (name, a line of role, chips for links) instead of property tables. Repos keep a row, with a kind dot and project chips.
- **Graph.** A canvas constellation, lazy-loaded with the existing dynamic import (no graph library). Nodes sit in kind bands in one O(n) pass, so a few hundred stay cheap and the seed graph is readable instead of a hairball. Labels yield when they would collide, and sit on an opaque chip so a thread never cuts a word. Hover keeps every other label and draws non-neighbours at about 30% instead of hiding them. Drag pins a node, drag the background pans, the wheel or a pinch zooms. Arrow keys pan, plus and minus zoom, Escape leaves full screen, and the focused node wears an accent ring. Kind chips expose `aria-pressed`. Pointer moves are drawn once per frame. On a narrow screen the first fit stays large enough to read and aligns to the top left.
- **Settings.** Theme is a segmented control. Text size is a drawn slider. Fonts are selectable plates without a stock radio. Accent presets and a custom picker live in Appearance.
- **Shell.** The live-updates pill folds into the activity control. Undo and redo sit in one quiet group.
- **Assistant.** The empty state names the page you have open and offers prompts from the entities already in memory. It is not a blank chat.
- **Metrics.** Bars and the donut use the accent and two mixes, not a separate pastel set.
- **Login.** The left panel carries the constellation and a sentence about connections, instead of an empty field under the tagline.
- **Skills.** The "Improve skills from my work" heading and its explanation stack, so the title does not wrap into the sentence. The two columns stack under `lg`.

### Speed

No new runtime dependency. Figtree replaces Inter; Fraunces is an extra font file, loaded optional and not preloaded, outside the JS graph. The canvas graph ships only in the context graph chunk. Middleware now treats a failed or 5xx `/api/auth/me` as "unknown", not "logged out", so an API restart does not delete the session.

## 7. Round 2 measurements (production, same method)

Measured on this machine against `next build && next start` on port 3000, hub-api on 4000, the seeded baseline account. "Before" is the round-1 follow-up recorded in section 5 (`main`). Cold-today and peek times are the in-page medians of three fresh contexts with the cache disabled.

### Route JavaScript

Shared shell stays **103 kB**. The graph is a separate async chunk, **10.1 kB gzip** (27.5 kB raw), requested only when the Graph tab mounts. Context's first load stays 111 kB.

| Route | Before page / first load | After page / first load |
|---|---:|---:|
| `/today` | 9.4 / 140 kB | 10.1 / 143 kB |
| `/board` | 22.8 / 144 kB | 22.7 / 146 kB |
| `/needs-me` | 12.9 / 129 kB | 6.9 / 133 kB |
| `/runs` | 11.0 / 124 kB | 9.6 / 127 kB |
| `/context` | 7.2 / 110 kB | 3.9 / 111 kB |
| `/code` | 7.8 / 133 kB | 4.7 / 134 kB |
| `/code/review` | 7.5 / 141 kB | 7.5 / 143 kB |
| `/tasks/[id]` | 27.8 / 158 kB | 27.8 / 160 kB |
| `/settings` | 9.7 / 140 kB | 11.5 / 143 kB |
| `/metrics` | 3.6 / 124 kB | 7.8 / 125 kB |
| `/login` | 0.1 / 125 kB | 0.1 / 127 kB |

First load moved 1–3 kB. The shared shell did not. Settings' page chunk grew with the accent controls.

### Web vitals and navigation

| Surface | Before | After |
|---|---|---|
| Cold Today, first task visible | 177 ms (205, 177, 164) | **184 ms** (220, 182, 184) |
| First peek, editor ready | 48 ms | **49 ms** (49, 52, 49) |
| Client nav, shell | 40–60 ms | **44–67 ms** |
| Client nav, data ready | 40–60 ms | **48–73 ms** (Settings 99 ms) |
| Cold Today API calls | 7 | 7 |
| Lighthouse `/login` | 99, LCP 2.11 s, CLS 0 | **100**, FCP 1.06 s, LCP 1.81 s, TBT 35 ms, CLS 0 |
| Lighthouse `/today` mobile | 95, LCP 2.80 s, CLS 0.008 | **98**, FCP 761 ms, LCP 2.35 s, TBT 40 ms, **CLS 0** |
| Lighthouse `/today` desktop | 99, LCP 612 ms, CLS 0.067 | **100**, FCP 211 ms, LCP 515 ms, TBT 0, **CLS 0** |

The mobile CLS that first showed up (the proposed-card skeleton was shorter than the real cards) was fixed by matching the placeholder height. Weekday labels use the short form so a five-column week does not wrap and shift.

The review file-tab timing was not retaken here. Seeded review paths are `~/ensemble-workspace/...`, which `allowedRepo` rejects because they are not absolute, so the checkout never opens.

### Fonts (woff2, not in the JS graph)

Figtree latin subset 20.2 kB (latin-ext 10.2 kB), one variable file, `display: swap`, preloaded, metric fallback (`size-adjust: 100.72%`). Fraunces is weight 500 only; the preloaded latin subset is 18.0 kB, `display: swap`, metric fallback (`size-adjust: 115.45%`). JetBrains Mono stays optional and is not preloaded.

### API

`GET /api/today/home` p50 / p95 **4.0 / 5.2 ms** (was 4.5 / 10.3). `GET /api/settings` 4.0 / 4.3 ms. `GET /api/context/graph` 3.8 / 4.9 ms. No new queries on the accent write beyond the existing settings patch.

## 8. Follow-up (verification of PR #2)

Same production method as section 7, on this machine, after the verification fixes.

| Surface | Section 7 | Now |
|---|---|---|
| Cold Today, first task visible | 184 ms (220, 182, 184) | **212 ms** (215, 212, 194) |
| First visit, cache disabled | fallback faces (`display: optional`) | **Fraunces 500** on the title, **Figtree** on the body, both `loaded` |
| `/today` page / first load | 10.1 / 143 kB | **11.6 / 143 kB** |
| Shared shell | 103 kB | **103 kB** |
| Graph chunk | 10.1 kB gzip | **6.3 kB gzip** (16.5 kB raw) |
| Lighthouse `/today` mobile | 98, FCP 761 ms, LCP 2.35 s, TBT 40 ms, CLS 0 | **97**, FCP 1.06 s, LCP 2.64 s, TBT 59 ms, **CLS 0.001** |
| Lighthouse `/today` desktop | 100, FCP 211 ms, LCP 515 ms, TBT 0, CLS 0 | **100**, FCP 179 ms, LCP 204 ms, TBT 0, **CLS 0.004** |

The cold-Today median on this box is about 28 ms above the section 7 run. That run never swapped in the real faces. This one preloads Figtree (20 kB) and Fraunces 500 (18 kB) with `display: swap`, so the first paint is the real type and the task text does not wait on the font. Documented `main` on the other machine was 177 ms. The earlier same-box gap of ~80 ms was the `optional` block period; swap removes that wait.

An API outage shows “Reconnecting to Ensemble…”, “Waiting for Ensemble to reconnect.”, dashes instead of zero counts, and “Can't check sources right now.” Bringing the API back refilled Today in about 1.8 s with no reload. Light-mode faint text is `#6f685d` (about 4.9:1 on the paper, 5.4:1 on a panel). The saved accent is also a `ensemble_accent` cookie, painted from the document and from the boot script.

## 9. Static routes (re-verification)

`cookies()` in the root layout had forced every route to render dynamically. It is gone. The build marks the same routes static as `main` (`○`), and only `/projects/[id]` and `/tasks/[id]` stay dynamic (`ƒ`). The boot script reads `ensemble_accent` from `document.cookie` before paint and prefers whichever of the cookie and `localStorage` is newer. A custom hex is stored as `c:#rrggbb`. Settings and the theme toggle call `publishAppearance`, so the cookie moves on the same click.

Figtree stays preloaded. Fraunces 500 stays `display: swap` with a metric fallback and is not preloaded. A cold visit with the cache disabled still ends on Fraunces for the title and Figtree for the body, with CLS about 0.003.

Measured on this machine the same way as section 5, production builds, cache disabled, three fresh contexts. `main` is `59dd7d1` on port 3010. This branch is on port 3000. Times are inside the page.

| Surface | `main` | This branch |
|---|---:|---:|
| Cold Today, first task | **177 ms** (212, 177, 163) | **183 ms** (183, 186, 175) |
| Server response | 5–8 ms | 5–8 ms |
| Page switch, Board / Code / Settings / Today | 23 / 13 / 16 / 14 ms | 21 / 13 / 19 / 16 ms |
| Editor open, immediate (no hover warm) | 61 ms median of five | 47 ms median of five |
| Editor open, settled | 26–29 ms | 26–28 ms |
| `/today` page / first load | 9.4 / 140 kB | 11.8 / 144 kB |
| Shared shell | 102 kB | 103 kB |
| `/code/review` page / first load | 7.5 / 140 kB | 8.3 / 143 kB |
| Lighthouse `/today` mobile | — | **95**, FCP 1.4 s, LCP 2.8 s, TBT 100 ms, **CLS 0.002** (another sample 93, LCP 3.1 s, CLS 0.004) |
| Lighthouse `/today` desktop | — | **100**, FCP 0.2 s, LCP 0.3 s, TBT 0, **CLS 0.013** |

Cold Today is 6 ms above `main` on this box, inside the 15 ms budget. The earlier gap (about +34 ms, and +17 ms even without the server cookie read) was dynamic rendering plus a preloaded Fraunces file on the critical path.

A fresh browser with Ember saved on the account paints `#f0a36a` on the first frame and keeps it. During an outage the sidebar stops claiming sources are healthy within about 100 ms of the stream dropping, proposed todos show an em dash, and the account row stays. Light faint text is `#625b51` (about 5.4:1 on the sidebar, 4.7:1 on an accent-soft skill tile). Light `+N` is `#18724b` (about 5.3:1 on the paper).

A 5xx is the offline sentence only when the request never reached a JSON error: the fetch threw, the rewrite proxy returned its plain `Internal Server Error`, or a 502–504 arrived without a JSON message. A JSON `error` (or `message` / `detail`) is shown as written, so a missing model key still reads “No key for …” and the Ask error keeps its Settings → Models link.

## 10. Connect your apps (2026-09-29)

Same production method: `next build` on this branch, signed-in Chrome against `http://127.0.0.1:3000`. No motion library. Each app’s walkthrough is a dynamic import, so the grid does not download it.

| Route | Page JS | First Load JS |
|---|---:|---:|
| `/connect` | 11.3 kB | 132 kB |
| `/connect/[app]` | 407 B | 110 kB |

Shared shell stays **103 kB**. The walkthrough chunk is 32.3 kB raw / 9.9 kB gzip and loads only after a guide opens.

Unthrottled, a signed-in `/connect` load was TTFB 21 ms, DOMContentLoaded 56 ms, load 140 ms, 17 scripts, 166 kB of script transferred. `curl` TTFB against the same document was about 5 ms.

Lighthouse 12, performance only, session cookie, simulated slow 4G and 4× CPU unless noted:

| Surface | Score | FCP | LCP | TBT | CLS |
|---|---:|---:|---:|---:|---:|
| `/connect` mobile | 85 | 1.4 s | 2.9 s | 390 ms | 0 |
| `/connect` desktop | 100 | 0.4 s | 0.7 s | 0 ms | 0 |
| `/connect/vscode` mobile | 94 | 1.4 s | 2.7 s | 180 ms | 0 |

The mobile blocking time is the shared client shell hydrating under simulated CPU, the same shape as other Hub pages. The Connect route does not add an editor, a chart, or a video.
