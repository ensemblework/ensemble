# Ensemble motion system: placement map and plan

The core metaphor is that **two strands move in sync**. Violet `#7c6af7` is the agent and paper `#f3eee6` is you, set on warm dark `#141210` / `#2b261f`. Every loader is a thread doing something: weaving, braiding, stitching, tying, fraying or waiting. No plain spinners.
Demo: `index.html` (open it directly; `?tour` auto-scrolls, `?reduced` forces reduced motion). Parts: `components/`. Video and stills: `media/`.

## 1. Placement map

The audit covered `ensemblework/ensemble`: components/ui.tsx, (hub)/layout.tsx, live.tsx, assistant-dock.tsx, job-card.tsx, activity-panel.tsx, topbar.tsx, ask-bar.tsx and globals.css.

| # | Where in the app (today's code) | Animation | Why | Reduced-motion fallback |
|---|---|---|---|---|
| 1 | App boot / first paint, AuthGate before a session exists | **Splash**: the mark draws in stroke by stroke (violet, then paper), a bead runs the curve, then it breathes | The brand's first impression, and it hides the auth round-trip | Static full icon; the text "Loading Ensemble" fades in |
| 2 | AuthGate "Reconnecting to Ensemble…" pill, SSE drop in live.tsx | **Tether**: a thread slackens and re-tautens between two dots | The connection is literally a line | Static dashed line + text |
| 3 | Route change (Today, Board, Context, Runs, Needs me, Docs, Settings) | **Thread progress** top bar: two strands braid across and then tie off. **Page enter**: the title's underline thread draws in and content rises in a stagger | Replaces the blank `Suspense fallback={null}` gap; a sense of continuity | Plain 2px bar; instant content |
| 4 | Skeletons: Today list, Board columns, Runs list, peek panel, Context graph | **Violet sweep** skeleton (staggered per row). The Context graph gets a **node-and-edge skeleton** whose edges draw in | Replaces the flat `skeleton-pulse`; its shape matches the real layout | Static tinted blocks |
| 5 | Agent **thinking** (assistant dock before the first `delta`, `setWorking("Assistant is thinking…")`, `@ensemble` in docs, comment replies) | **Ensemble Glyph** morph loop + **status line** of rotating whimsical verbs, with meta "(12s · ↓ tokens · esc to stop)" ★ SIGNATURE | The Claude-spark equivalent, rooted in the icon | Static glyph; the verb swaps without animation (real statuses only) |
| 6 | Real `status` SSE frames ("Reading Gmail…") | The same status line via `setReal()`: it shows the real text, and only this is `aria-live` | Honest progress beats whimsy when we have it | Text swap |
| 7 | Agent **streaming** a response (`delta`) | **Ink-in stream**: tokens arrive violet and settle to paper, a needle caret leads, and a bead travels down the `.ensemble-reply` rule | "The agent is writing with a thread" | Tokens appear in plain; caret is static |
| 8 | Agent **running a tool** (`tool` event, ToolCall rows) | **Marching stitches** border (running), which then closes to a solid seam (applied), holds amber dashes (pending/Apply), or tears red (failed) | Each tool call is one stitch in the work | Static dashed/solid border by state |
| 9 | Code tab terminal / CLI | **Terminal glyph**: text frames `· ∘ ◡ ∪ ⋃ ≀ ⋈ ✢ ✣ ✳` and back, plus verbs | Direct homage to Claude Code, done in Ensemble's own glyph language | Static `∪` |
| 10 | Job card `running` (replaces `Spinner size={11}`), TaskAgentPanel, Runs timeline | **Loom**: finished steps are woven cloth and a shuttle carries the thread across the current step. Timeline steps are beads on a thread | Progress you can read at a glance | Static filled bar + step label |
| 11 | `queued` / `stopping` / `blocked` | Glyph `idle` (slow breathe) / loom slows / glyph `pause` (strands parted) | The state stays readable from motion alone | Static glyph pose |
| 12 | `waiting_approval` "Needs you", the Needs me page, editor-hook decision cards | **Your turn**: the agent strand holds while your strand breathes; a heartbeat runs down the card edge; a **timeout thread** drains toward the 10-minute fallback; the sidebar badge pings | Makes it obvious who has to act | Static accent edge + countdown text |
| 13 | Approve / Allow / Apply / Mark done | **Tie the knot**: a check draws in, 6 sparks fly out, and the card gathers away | Satisfying closure | Instant check, no sparks |
| 14 | Syncing connectors (Gmail, Calendar, GitHub, Slack, Linear), Settings → Connections | **Inflow**: beads in each source's colour flow along threads into the mark, which swells as it takes them in. Per-source rows show a small sync thread | Makes the "context in" story visible | Static icons + "Syncing…" |
| 15 | Topbar **Fetch now** (`RefreshCw animate-spin`), 09:00/16:00 scheduled fetch | **Two reels** turn at different speeds and line up every few turns, then close into a ring and the new-item count pops | The brand's two voices in a refresh icon | Icon static; the count simply updates |
| 16 | Ask bar submit ("Looking through your data…" + sources) | **Conic rim chase** around the input (`@property`), then source chips cascade in | Signals the search is happening *across* your data | Static violet rim |
| 17 | Generic small `Spinner` (buttons, "What it did" loading, inline) | **Duet**: two dots merge into one and split again | The in-app Mark's dots, in sync | Two static dots at 60% |
| 18 | Kill switch: Pause all / Stop everything (`OctagonX`), job Stop | **Cut**: the loom thread snaps, the shuttle drops and both ends recoil. The glyph turns `error` (frays, red). Pause goes to glyph `pause` | Stopping should feel physical and final | Instant state change to red/paused |
| 19 | Error states (failed job, SSE `error`, token expired) | Glyph `error` fray + stitched border tear | Consistent failure language | Static red glyph |
| 20 | Toasts, undo/redo | Toast threads in from the edge; its underline drains as a timer | Timed toasts need a visible clock | Static toast |
| 21 | Document autosave (and 409 conflict) | Stitches run along the doc title and close into a check; a conflict turns the stitches amber | Saving = sewing it in | "Saved" text |
| 22 | Owner handoff (Assign to agent, triage `a`) | The avatar dot hands over to the violet dot along a curve | Shows the ownership change | Instant swap |
| 23 | Empty states (`.empty-state`: nothing needs you, no runs) | **Loose thread**: a gently swaying loose end with a small bead | Calm and friendly, not dead | Static drawing |
| 24 | Activity panel pill: Idle / Working·n / Needs you / Queued / Paused / Offline | Small glyph in the matching state (replaces `pulse-dot`) | One indicator speaks the whole vocabulary | Static poses |

Notes:
- The app's own `[data-reduce-motion="true"]` setting and the OS `prefers-reduced-motion: reduce` setting are both honoured everywhere.
- Loaders appear only after 150–200 ms, so fast loads never flash.

## 2. Motion principles and tokens (`components/tokens.css`)

- **Two voices**: anything that moves has a violet part (agent) and a paper part (you). They move together, never mirrored.
- **Easing**: `--ease-weave: cubic-bezier(.65,0,.35,1)` for morphs, `--ease-out-soft` for entrances and `--ease-snap` for knots.
- **Durations**: micro 160 ms, UI 240–380 ms, loops 2.4–4.8 s.
- **Colour**: working = violet, you = paper, needs-you = amber `#e0a458`, done = green `#6fcf97`, error = red `#e5645d`. Light theme swaps paper → ink `#1c1915`.
- **Accessibility**: loops are `aria-hidden`; only real statuses go to `aria-live="polite"`; every animation has a still pose.

## 3. The signature: Ensemble Glyph + status line

`components/glyph/`: two strands (41 points each, Catmull-Rom). The loop is **mark → braid → rings → spark → merge → mark**, about 4.8 s:
- **Braid** has a travelling weave phase.
- **Spark** is the Claude-like asterisk. It rotates 90°, and its strokes thin.
- **Merge** pulses as the strands become one.

State poses: `working`, `idle`, `wait`, `pause`, `success` (check + blooming ring) and `error` (fray). JS engine (`ensemble-glyph.js`) plus a SMIL-only `ensemble-glyph.svg` that also works as `<img>`. Keyframes are exported as `keyframes.json` for native.

Status verbs (rotate every 2.6 s; the letters drop in with a highlight sweep): Harmonizing… Weaving context… Finding the thread… Syncing up… Tuning in… Braiding… Composing… Counterpointing… Keeping time… Stitching it together… Cross-referencing… Conducting… Humming along… Falling in step… Resolving the chord… Listening in… Threading the needle… Rehearsing… Riffing… Warming up…

## 4. Porting

- **React now**:
  - Drop each `components/*/x.css` into globals.css and swap `Spinner` → `<Duet/>`. Replace `.skeleton` with the sweep, and the `.shimmer`/`pulse-dot` in assistant-dock with `<EnsembleGlyph state/>` + `<StatusLine/>`.
  - The glyph/status/stream/thread-progress JS files are small vanilla classes; wrap each in a `useEffect`.
- **Native later**:
  - `keyframes.json` gives the glyph points per pose, for Reanimated/SwiftUI path interpolation.
  - The SMIL SVGs cover static contexts.
  - The docs' plan for Lottie waiting animations can be generated from the same keyframes.

## 5. Files

- `index.html`: self-contained demo (built by `tools/build.py` from `components/` + `demo/`).
- `components/`: tokens.css, glyph/, status-line/, stream/, stitch/, loom/, needs-me/, approve/, inflow/, fetch/, ask/, duet/, skeleton/, thread-progress/, page-enter/, splash/, reconnect/, empty/, small/, terminal-glyph/.
- `media/`: not kept in the repo. `tools/` records the tour and screenshots again.
- `tools/`: generators, build and QA scripts (playwright-core + system Chrome).
