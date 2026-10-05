# Ensemble motion suite: architecture (round 3)

Ensemble offers **motion styles** that users can choose from. Each style covers the same set of named **slots**, the moments where the app moves. Switching styles changes **one attribute** and never changes product code.

| Style | Id | Who it's for | Source |
|---|---|---|---|
| **Expressive** (default) | `expressive` | Most people. Springs, braids, sparks, confetti, the Ensemble Glyph. | rounds 1–2 (`../index.html`, `../round2/`) |
| **Minimal · Quiet** | `minimal-quiet` | People who want calm. Hairline strokes, one violet accent, slow sine drift, no overshoot. | round 3 (this folder) |
| **Minimal · Dot** | `minimal-dot` | People who want as little as possible. Only the two dots (you + agent) and at most one line. | round 3 |
| *Reduce motion* (overlay) | `data-reduce-motion="true"` or OS `prefers-reduced-motion` | Anyone who needs it. It applies on top of **any** style: loops stop, and everything else is a crossfade of 150 ms or less. | all rounds |

Why two Minimal flavours? They really are different. **Quiet** keeps the icon's *line* (the mark and its two strands) and suits people who like calm but want some character. **Dot** keeps only the in-app Mark's *two dots* and suits people who find any line movement distracting. Both share the same tokens and principles, so they differ in form, not in behaviour.

## 1. Slots
A slot is a stable id for a moment, plus the states it can be in. Product code only ever renders a slot and sets its state:

```html
<div data-motion-slot="agent.thinking" data-state="status">Reading 3 threads from Priya</div>
```

| Slot | States | Expressive implementation | Minimal card in gallery |
|---|---|---|---|
| `agent.thinking` | thinking, status, idle | r1 Ensemble Glyph + status line | 01 Thinking + status |
| `reply.stream` | streaming, done | r1 Ink-in stream | 02 Streaming reply |
| `tool.call` | running, done, pending, failed | r1 Marching stitches | 03 Tool calls |
| `run.progress` | queued, running, done | r1 Loom + bead timeline | 04 Run progress |
| `page.progress` | loading, done | r1 Thread progress + page enter | 05 Page progress |
| `content.skeleton` | loading, ready | r1 Violet sweep skeleton | 06 Skeleton |
| `fetch.refresh` | fetching, done | r1 Two reels | 07 Fetch now |
| `connector.sync` | syncing, synced | r1 Inflow beads | 08 Connector sync |
| `needs.waiting` | waiting, timeout | r1 Your turn heartbeat | 09 Needs you |
| `action.approve` | idle, pressed, approved | r1 Tie the knot + sparks | 10 Approve |
| `moment.celebrate` | cleared, streak | r2 Strand confetti / Inbox zero tapestry | 11 All clear (subtle celebration) |
| `state.error` | error, retrying, ok | r1 Glyph fray + stitch tear | 12 Error + retry |
| `net.connection` | offline, reconnecting, online | r2 Re-tie & reconnect | 13 Offline → online |
| `brand.splash` | reveal, rest | r1 Splash / r2 Logo reveals | 14 Splash |
| `control.*` | hover, press, on, off, focus | r2 Button · Toggle · Checkbox, Tabs · Bell · Focus rim | 15 Button · Toggle · Checkbox · Tabs · Focus |
| `native.tray` | idle, working, syncing, needs, paused, done, error, offline | r2 Menu-bar / tray states | 16 Menu-bar / tray states |

The rules for slots:
1. **Text and ARIA belong to the slot, not the style.** Every style shows the same status text (`aria-live="polite"` for real statuses only), and loops are `aria-hidden`.
2. **States are the contract.** A style may draw a state any way it likes, but it must draw **every** state, and each must have a still pose for reduced motion.
3. **Timing belongs to the product.** Show loaders only after 150–200 ms, and let toasts and timeouts own their durations. A style only decides how a state *looks* while it lasts.

## 2. Theme selection
```html
<html data-motion-theme="minimal-quiet">   <!-- expressive | minimal-quiet | minimal-dot -->
```
- The nearest `[data-motion-theme]` wins, so one subtree can preview another style (the gallery's suite switcher does exactly this).
- `data-reduce-motion="true"` on `<html>` (the app's setting), or the OS media query, applies the reduced overlay on top of whatever style is chosen.
- **Fallback chain:** `minimal-dot → minimal-quiet → expressive`. A new slot can ship in Expressive first, and the Minimal styles fall back until they implement it. `UM.resolve()` handles this.

## 3. Token contract (`--m-*`)
Every style defines **the same tokens**. They are generated from one source (`tools/gen_tokens.py`) into `components/core/suite.css` and `components/core/motion-themes.json`. Components read tokens and never check theme names.

| Token | expressive | minimal-quiet | minimal-dot | reduced overlay |
|---|---|---|---|---|
| `--m-ease-enter` | cubic-bezier(.22,1,.36,1) | cubic-bezier(.25,.1,.25,1) | cubic-bezier(.25,.1,.25,1) | linear |
| `--m-ease-move` | cubic-bezier(.34,1.3,.64,1) | cubic-bezier(.33,0,.2,1) | cubic-bezier(.33,0,.2,1) | linear |
| `--m-ease-exit` | cubic-bezier(.4,0,1,1) | cubic-bezier(.4,0,.6,1) | cubic-bezier(.4,0,.6,1) | linear |
| `--m-ease-loop` | cubic-bezier(.65,0,.35,1) | cubic-bezier(.45,0,.55,1) | cubic-bezier(.45,0,.55,1) | linear |
| `--m-spring` | soft | none | none | none |
| `--m-dur-micro` | 160 | 200 | 200 | 0 |
| `--m-dur-ui` | 320 | 420 | 480 | 150 |
| `--m-dur-move` | 870 | 640 | 720 | 0 |
| `--m-dur-loop` | 4800 | 3200 | 2800 | 0 |
| `--m-amp` | 12 | 4 | 3 | 0 |
| `--m-scale-press` | 0.96 | 0.985 | 0.99 | 1 |
| `--m-overshoot` | 1 | 0 | 0 | 0 |
| `--m-stroke` | 2.5 | 1.5 | 1 | 1.5 |
| `--m-ornament` | 1 | 0 | 0 | 0 |
| `--m-particles` | 1 | 0 | 0 | 0 |
| `--m-color-mode` | duo | mono+accent | mono+accent | inherit |

Expressive's real curves are the spring `linear()` easings in `../round2/components/core/springs.css`. The cubic-beziers above are its fallbacks for the contract. `ornament` and `particles` are 0/1 switches. Minimal sets both to 0, which means no confetti, sparks, glows or trails.

## 4. Runtime (`components/core/motion.js`)
```js
UM.register('minimal-quiet', 'agent.thinking', (scene, el) => { /* ... */ });
UM.mount(el);            // reads data-motion-slot + nearest data-motion-theme, resolves the fallback, runs the impl
UM.resolve(theme, slot); // impl or null
UM.calm / UM.enter / UM.drift // JS versions of --m-ease-move / -enter / -loop, so JS and CSS motion match
```
`scene` (from `u2-core.js`) owns every rAF loop, timer and tween, so switching style or replaying disposes cleanly. Under reduced motion, `scene.wait()` and `scene.tween()` jump straight to the end.

## 5. React
```tsx
type MotionTheme = 'expressive' | 'minimal-quiet' | 'minimal-dot';
type SlotId = 'agent.thinking' | 'reply.stream' | 'page.progress' | 'content.skeleton' | 'tool.call' | 'run.progress'
  | 'needs.waiting' | 'action.approve' | 'connector.sync' | 'fetch.refresh' | 'state.error' | 'net.connection'
  | 'brand.splash' | 'control.*' | 'moment.celebrate' | 'native.tray';

// 1. Provider: sets the attribute once (user setting, synced to the account)
export function MotionProvider({ theme, reduce, children }: { theme: MotionTheme; reduce: boolean; children: React.ReactNode }) {
  useEffect(() => { const h = document.documentElement; h.dataset.motionTheme = theme; h.dataset.reduceMotion = String(reduce); }, [theme, reduce]);
  return <MotionCtx.Provider value={{ theme, reduce }}>{children}</MotionCtx.Provider>;
}
// 2. Theme packs are lazy, so Minimal users never download Expressive's glyph engine
const packs: Record<MotionTheme, () => Promise<Pack>> = {
  expressive: () => import('@/motion/expressive'), 'minimal-quiet': () => import('@/motion/minimal-quiet'), 'minimal-dot': () => import('@/motion/minimal-dot') };
// 3. One component per slot; product code never branches on theme
<MotionSlot name="agent.thinking" state={status ? 'status' : 'thinking'}>{status ?? 'Thinking'}</MotionSlot>
```
- Pure-CSS slots (controls, skeleton, progress) need no JS pack. They respond to the tokens and the attribute, so they switch instantly.
- `ToolCall`, `JobCard`, `AssistantDock`, `ActivityPill` and the sidebar status replace their current spinners with `<MotionSlot>`.

## 6. Native (SwiftUI / Compose / tray)
- `motion-themes.json` becomes a `MotionTheme` struct (durations, curves, amplitude, stroke, and the `ornament`/`particles` switches) injected as an environment value (`@Environment(\.motionTheme)` or `LocalMotionTheme`).
- Each slot is a protocol or interface (`ThinkingIndicator`, `ToolCallIcon`, ...) with one implementation per style. Unknown slots follow the same fallback chain.
- Curves: `--m-ease-move cubic-bezier(.33,0,.2,1)` → `Animation.timingCurve(0.33, 0, 0.2, 1, duration: 0.64)` (SwiftUI), or `CubicBezierEasing(0.33f, 0f, 0.2f, 1f)` (Compose). Minimal uses no springs.
- Tray: the static SVGs in `components/tray/svg/` (`-template` is black with alpha for macOS template images, `-accent` is for Windows and Linux) convert to PDF/PNG at @1x/@2x. The animated states (working, syncing, needs) loop 4 to 8 frames at a steady speed.
- Reduced motion: honour `UIAccessibility.isReduceMotionEnabled` / `Settings.Global.ANIMATOR_DURATION_SCALE` exactly as the web does.

## 7. Settings UX
**Settings → Appearance → Motion**, with radio cards (mocked in the gallery):
- *Expressive* (default) · *Minimal · Quiet* · *Minimal · Dot*
- *Reduce motion* checkbox, labelled "Match system" by default.
- If the OS asks for reduced motion on first run, preselect *Minimal · Dot* with the overlay on, and show a one-line note that it can be changed.
- The choice syncs to the account (web, desktop and mobile) and applies live, with no reload. The tray icon follows it too.

## 8. Minimal principles (round 3)
1. **Monochrome plus one accent.** Ink or paper lines, and violet for the agent only. Status colours (amber, red) appear only in text or a single mark.
2. **Thin and few.** 1–1.5 px lines, and at most 2–3 moving elements in any slot.
3. **Small amplitude.** Movement travels 4 px or less (3 px for Dot), and presses scale by 1.5% or less.
4. **Slow, calm easing.** `cubic-bezier(.33,0,.2,1)` for movement and a sine in-out for loops (2.8–3.2 s). No overshoot and no bounce.
5. **Nothing celebrates loudly.** At most one faint ring (opacity 0.35 or less), once.
6. **Still unmistakably Ensemble.** The mark, the two strands, the two dots and the thread are all there, just in their simplest form.

## 9. Adding a style (checklist)
1. Add the theme to `tools/gen_tokens.py` and fill **every** token.
2. Register implementations for the slots you change. The rest fall back.
3. Give every state a still pose, and make sure the ARIA text is unchanged.
4. Preview it in the gallery's suite switcher (with `?reduced` and `?light`), then add it to Settings.

## Files
```
round3-minimal/
  index.html                  review gallery (self-contained, offline), with the suite switcher at the top
  SUITE.md                    this file
  components/core/            suite.css (generated tokens), motion-themes.json, motion.js (registry), minimal.css, tokens.css, u2-core.js
  components/<slot>/          <slot>.html (Quiet markup <!--dot--> Dot markup), .css, .js (registers both flavours)
  components/tray/svg/        32 static tray SVGs: ensemble-minimal-<quiet|dot>-<state>-<template|accent>.svg
  compare/                    expressive-r1.html / expressive-r2.html: copies of rounds 1–2 with a solo view for the switcher
  media/                      tour mp4 (38 s) + stills
  tools/                      gen_tokens.py, build.py, cards.py, gen_tray.js, shot.js, check.js, record.js
```
Rebuild with `python3 tools/gen_tokens.py && node tools/gen_tray.js && python3 tools/build.py`. Check with `node tools/check.js`.
