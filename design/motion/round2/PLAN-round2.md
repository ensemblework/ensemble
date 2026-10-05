# Ensemble motion: Round 2 addendum

Round 1 (`../PLAN.md`) set the grammar: the **Ensemble Glyph**, the status line, and the rule that *two strands (you and the agent) move as one*. Round 2 adds **17 new pieces** built on the same system for celebration, arrival, collaboration, touch, rest, recovery, native and brand moments. Nothing in round 1 was changed.

Review it in `index.html`: a single self-contained file that works offline. Each card has a Replay button and a light/dark toggle. The header has Replay all, Light cards and Reduce motion. You can also add `?light`, `?reduced` or `?tour=highlights` to the URL.

## Brand constants (unchanged)
Agent violet `#7c6af7` with tints `#9d8fff` and `#b4a9ff` · paper (you) `#f3eee6` · dark `#141210` / `#2b261f` · Figtree for UI, Fraunces for display, JetBrains Mono for data. The mark is icon **B "Two voices"**: an outer violet strand and an inner paper strand.

## Placement map
| # | Piece | Where it lives | Trigger | Budget |
|---|---|---|---|---|
| 00 | Brand loop: two ribbons | Landing hero, app launch, About, video bumper | page load; loops every 12 s | canvas 2D, about 1 ms/frame |
| 01 | Strand confetti | Mark done on Today, the Board and triage `d` | checkbox | < 900 ms, never blocks |
| 02 | Inbox zero tapestry | Needs me reaching 0; sidebar badge | last item cleared | about 4 s, once per day |
| 03 | Streak knot | Today header, weekly recap | first clear of the day | about 2.5 s |
| 04 | First meeting | Onboarding step 1, first launch | after sign-in | about 5 s, can be skipped |
| 05 | Connect a source | Onboarding, Settings → Connections | OAuth success | about 3 s, then a live counter |
| 06 | Morning briefing | First Today visit before about 11:00; the 09:00 fetch | route enter | about 3 s, stagger 90 ms |
| 07 | Co-editing threads | Docs and comments with `@ensemble` inline | agent edit session | continuous, low amplitude |
| 08 | Graph bloom and focus ripple | Context graph | load, filter, node select | bloom < 2 s, ripple 700 ms |
| 09 | Board handoff | Board: assign to agent (`a`), agent done, drag | action | spring-soft, about 1.2 s |
| 10 | Button · Toggle · Checkbox | Primary buttons, Settings toggles, checklists | hover/press/change | 120–480 ms |
| 11 | Tabs · Bell · Focus rim | View tabs, notifications, ask bar and inputs | change, new item, focus | 300–600 ms |
| 12 | Voice: in sync | Push-to-talk in the dock and on mobile | listening states | continuous, rAF |
| 13 | Ambient + theme morph | Idle sidebar logo; theme toggle ⌘⇧L | idle > 20 s, toggle | 6 s breath, 870 ms morph |
| 14 | Re-tie and reconnect | Retry on failed fetches and jobs; Offline → Online | error, retry, network | about 1.5 s |
| 15 | Menu-bar / tray states | macOS menu-bar extra; Windows/Linux tray | agent state | 16 and 22 px, 9 states |
| 16 | Logo reveals A/B/C | Launch, landing intro, bumpers | once | A Pull 1.8 s · B Woven 2.6 s · C Needle 3.2 s |

## Motion principles (round 2)
1. **Everything is a thread.** Progress is beads on a string, success is a knot, errors are a fray, collaboration is a tether and attention is a ripple.
2. **Springs, not curves.** All UI motion uses five physical springs (below), and interrupted motion keeps its velocity. Linear timing appears only in tiny tray loops, where a constant speed reads better at 16 px.
3. **Earned delight.** Big celebrations (tapestry, streak, first meeting) happen at most once per session or day. Everyday actions (confetti, tie) finish in under a second and never block input.
4. **Two voices, one motion.** When the agent and the user act together, their strands move in phase: in voice, in co-editing and in the handoff.
5. **Performance.** Animate transform, opacity and SVG stroke-dashoffset only. Canvas is used only for the brand loop and the wave. No layout thrash. Everything is paused offscreen (IntersectionObserver).
6. **Reduced motion.** Every piece has a static end state, or a crossfade of 200 ms or less (see the "Reduced" row on each card). `core.css` also has a safety net under `prefers-reduced-motion`.

## Spring tokens
`components/core/springs.css` exposes CSS `linear()` easings with matching durations. `springs.json` has the same values for SwiftUI and Reanimated.

| token | stiffness / damping | duration | SwiftUI | use |
|---|---|---|---|---|
| `--spring-gentle` | 120 / 20 | 710 ms | `.spring(response: 0.574, dampingFraction: 0.913)` | entrances, unfolding |
| `--spring-soft` | 170 / 18 | 872 ms | `.spring(response: 0.482, dampingFraction: 0.69)` | lifts, tabs, knobs |
| `--spring-bouncy` | 260 / 14 | 1068 ms | `.spring(response: 0.39, dampingFraction: 0.434)` | celebrations, beads |
| `--spring-snappy` | 420 / 30 | 483 ms | `.spring(response: 0.307, dampingFraction: 0.732)` | presses, toggles |
| `--spring-pluck` | 300 / 7 | 2043 ms | see json | thread tension, plucks |

Usage: `transition: transform var(--spring-soft-d) var(--spring-soft);`

## Porting notes
- **React / web:** each `components/<piece>/` folder is self-contained (`.html` markup, `.css`, `.js`) and depends only on `components/core/` (`core.js` provides `U2.scene`, `Spring`, `tie`, `burst`, `pointer`, `samplePath` and `catmull`). Wrap the mount function in a `useEffect` and return `dispose()`. The CSS-only micro-interactions (10 and 11) drop straight into CSS modules.
- **Native (SwiftUI / Compose / Reanimated):** use `springs.json` for the physics. Point and path timelines are exported as JSON: `brandloop/keyframes.json` (ribbon centrelines per phase), `ambient/sun-moon.json` (sun↔moon strand morph), `core/tie.json` (knot→check morph) and `meet/meet.json` (spiral and U growth).
- **Tray icons:** `components/tray/svg/ensemble-tray-<state>.svg` in colour, and `-template.svg` for macOS template images (black and alpha). Nine states: idle, working, syncing, needs, listening, paused, done, error and offline. The looping states use a constant speed at 1 to 1.6 s per cycle, and the frames are simple enough to render as 16/22 px @1x/@2x PNG sequences.
- **Lottie / After Effects:** the keyframe JSONs are point arrays at 60 fps and can be pasted into shape-layer paths.

## Files
```
round2/
  index.html                 self-contained gallery (fonts and code inlined, works offline)
  PLAN-round2.md             this file
  components/core/           springs.css/json, core.js/css, tie.json
  components/<piece>/        .html / .css / .js (+ exported .json)
  components/tray/svg/       18 standalone tray SVGs
  gallery/                   gallery.css / gallery.js (the review shell)
  media/                     tour and stills, not kept in the repo (tools/record.js, tools/stills.js)
  tools/                     build.py, cards.py, shot.js, record.js, gen_springs.py, gen_tray.py, export_keyframes.js
```
Rebuild the gallery with `python3 tools/build.py`. Re-record the tour with `node tools/record.js highlights` (then convert with ffmpeg).

## Open questions for review
- Reveal variant: A Pull (quick), B Woven (rich) or C Needle (wordmark)?
- Should the tapestry appear every day at inbox zero, or only on the first one each week?
- Tray: should the "needs" state show a violet dot, or only in colour mode?
