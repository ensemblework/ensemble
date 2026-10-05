# Ensemble motion · round 4 slots

Three more slots for the `animation-integration` branch (draft PR #13): **`search.query`**, **`terminal.working`** and the
**tray PNG set**. They follow the round-3 `SUITE.md` contract:

- **Style** comes from the nearest `[data-motion-theme="expressive|minimal-quiet|minimal-dot"]`.
- **State** is a `data-state` attribute on the slot element.
- **Timing** reads only `--m-*` tokens (plus the round-2 `--spring-*` easings for Expressive).
- **Reduced motion** is handled by the reduce overlay, either `prefers-reduced-motion` or `[data-reduce-motion="true"]` on any ancestor.
- **Stack:** pure CSS/SVG. The only JS is a small vanilla text-frame driver (~1.5 KB minified plus the frames JSON).
- **No delay logic.** The app's shared loader delay (180 ms before showing, at least 300 ms once shown) decides *when* `data-state` changes. The slots respond immediately.

Open `index.html` to see the gallery. Each slot has a card with style, state and light/dark switches, and the bar at the top sets every card at once and toggles reduce motion.

```
round4-slots/
  index.html                         gallery (links the real slot files; nothing is inlined)
  README.md                          this file
  core/                              tokens.css, suite.css, motion-themes.json (round 3) + springs.css (round 2), copied unchanged
  search-query/
    search-query.css                 the slot
    search-query.html                markup contract
  terminal-working/
    terminal-working.css             both renderings + @font-face for Ensemble Frames
    terminal-working.js              text-frame driver (frames JSON inlined; built from .src.js)
    terminal-working.src.js          driver source (/*FRAMES*/ placeholder)
    terminal-frames.json             characters + per-frame ms, per set / style / state
    terminal-working.html            markup contract (text + SVG)
    fonts/ensemble-frames.woff2 (.ttf) 2 KB fallback face for the frame glyphs + LICENSE-ensemble-frames.txt
  tray/
    png/                             24 PNGs + 2 .ico (see below)
    src/                             hinted per-pixel-size SVGs (tray-<colour>-<N>px.svg), tray-master.svg, hinting.json
    states/expressive-round2/        18 state SVGs from round 2 (colour + template)
    states/minimal-round3/           32 state SVGs from round 3 (quiet / dot × accent / template)
  gallery/                           gallery.css, gallery.js, shots/ (headless renders + fonts-report.json)
  assets/fonts/                      gallery-only Figtree / Fraunces / JetBrains Mono subsets (+ FONTS-LICENSES.txt)
  tools/                             gen_font.py, gen_tray.py, raster_tray.js, finish_tray.py, check.js
```

## Dropping it into the app

1. **Copy the files.** Copy `search-query/search-query.css`, `terminal-working/terminal-working.css`, `terminal-working/terminal-working.js` and `terminal-working/fonts/ensemble-frames.woff2` (keep the `fonts/` folder next to the CSS, or change the `url()` in the `@font-face`). The app already has `tokens.css`, `suite.css` and `springs.css` from rounds 2 and 3. If not, copy `core/` too, loading `tokens.css`, then `suite.css`, then `springs.css`, then the slot CSS.
2. **Map the palette.** Each slot reads local hooks that fall back to the round-3 token names, so set them if the app names its colours differently:
   - `search.query`:
     - `--sq-bg` (raise)
     - `--sq-ink`
     - `--sq-muted`
     - `--sq-faint`
     - `--sq-line`
     - `--sq-hair`
     - `--sq-accent` (#9d8fff dark)
     - `--sq-agent` (#7c6af7)
     - `--sq-you` (paper / ink)
     - `--sq-soft` (accent-soft)
     - geometry: `--sq-h` (40px) and `--sq-radius` (12px; use `999px` for the pill Ask bar)
   - `terminal.working`:
     - `--tw-size` (14px)
     - `--tw-accent`
     - `--tw-ink`
     - `--tw-you`
     - `--tw-muted`
     - `--tw-faint`
     - `--tw-ok`
     - `--tw-err`
     - `--tw-font`
3. **Set the theme once.** Put `data-motion-theme` on `<html>` or any wrapper (the slot reads its nearest ancestor). For reduced motion, the OS setting works on its own; to force it in-app, set `data-reduce-motion="true"` on an ancestor.
4. **Load the driver once** for the text frames: `<script src="terminal-working.js">` or `import './terminal-working.js'`. It auto-mounts every `.tw-text[data-motion-slot="terminal.working"]` present at load and watches attributes from then on. For elements rendered later (React), call `EnsembleTerminal.mount(el)` in a ref/effect and `el._tw.destroy()` on unmount. Detached nodes are also cleaned up automatically.

```jsx
// React sketch
const ref = useRef(null);
useEffect(() => { const c = window.EnsembleTerminal.mount(ref.current); return () => c.destroy(); }, []);
return <span ref={ref} className="tw tw-text" data-motion-slot="terminal.working" data-state={state} aria-hidden="true" />;
```

---

## 1 · `search.query` (Ask bar and ⌘K)

```html
<div class="sq" data-motion-slot="search.query" data-state="typing">
  <label class="sq-field">
    <svg class="sq-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L13.5 13.5"/></svg>
    <input class="sq-input" type="search" placeholder="Ask Ensemble or search…" aria-label="Ask Ensemble or search">
    <span class="sq-pip" aria-hidden="true"></span>              <!-- Dot style: "listening" pip -->
    <span class="sq-trk" aria-hidden="true"><i></i></span>       <!-- Dot style: searching tracker -->
    <kbd class="sq-kbd">⌘K</kbd>                                 <!-- hides itself once the input has text -->
  </label>
  <div class="sq-meta" aria-live="polite"><span data-copy="status"></span></div>
  <ul class="sq-results" role="listbox">
    <li class="sq-item" role="option" aria-selected="true" style="--i:0">…</li>   <!-- --i = index, cascade caps at 7 -->
  </ul>
  <div class="sq-empty" role="status">
    <span class="sq-empty-mark" aria-hidden="true"><svg>… em-x / em-q / em-d groups, see search-query.html …</svg></span>
    <p data-copy="empty-title">No matches for “…”</p>
    <p data-copy="empty-hint">Try fewer words, or ask Ensemble to look across Gmail, Slack and your docs.</p>
    <div class="sq-empty-actions" data-copy="empty-actions"><button>Search all sources</button><button>Ask Ensemble</button></div>
  </div>
</div>
```

The slot wraps a full-width input about 40 px tall (`--sq-h`). The app owns the input's value, the result rows and all copy. The slot only styles and animates them.

| state | when the app sets it | Expressive | Minimal · Quiet | Minimal · Dot |
|---|---|---|---|---|
| `typing` | input focused / has text | accent border plus a 3 px soft focus ring; icon tints; ⌘K fades out once there is text | 1 px accent border only | hairline border; small agent-dot pip on the icon ("listening") |
| `searching` | after the shared loader delay | **Rim chase** (round 1): a conic violet strand and paper strand circle the border, 1.6 s/lap | one narrow accent arc on a hairline rim, 2.8 s/lap | the agent dot glides along the bottom edge and back, 1.4 s ease-in-out |
| `results` | results ready | rows rise 6 px with `--spring-snappy`, 40 ms stagger; selected row gets a 2 px agent bar that springs in | fade + 4 px rise, `--m-ease-move`, 35 ms stagger | opacity only, 25 ms stagger; selected row is marked by a dot instead of a fill |
| `empty` | zero results | the inner strand comes loose and sways gently (4.8 s); copy fades in at 60 ms steps | static hairline mark; copy fades | two still dots (you · agent); copy fades |

- **Typing never shows a loader.** It only changes focus and tint. `:focus-within` gives the same look, so focusing without setting a state is fine too.
- **Cascade:** the delay is `min(--i, 7) × stagger`, so long lists never wait more than about 300 ms.
- **Copy hooks:** `data-copy="status"` (e.g. "Searching 4 sources…", "5 results · ↑↓ move · ↵ open"), `empty-title`, `empty-hint` and `empty-actions`. Each one is plain DOM, so localise freely.
- **Reduce:** the rim, tracker and sway stop. `searching` becomes a static accent border, and the cascade and empty become a 150 ms fade with no stagger.

## 2 · `terminal.working` (Code tab, ~14 px inline)

There are two interchangeable renderings with the same attributes. Use one or the other.

```html
<!-- text frames: the driver writes one character per frame -->
<span class="tw tw-text" data-motion-slot="terminal.working" data-state="working" aria-hidden="true"></span>
<!-- SVG: pure CSS -->
<span class="tw tw-svg" data-motion-slot="terminal.working" data-state="working" aria-hidden="true"><svg viewBox="0 0 14 14">…see terminal-working.html…</svg></span>
<span aria-live="polite">Running tests…</span>   <!-- status words are the app's -->
```

States are `working`, `idle`, `done` and `error`. The text version also takes an optional `data-set="glyph|safe|ascii"` (default `glyph`).

**Text frames** (`terminal-frames.json`): `sets.<set>.<style>.<state>` gives `{frames[], ms[], loop, tone, still}`.

- `ms[i]` is how long frame *i* shows.
- `loop:false` holds the last frame.
- `still` is the reduced-motion pose.
- `tone` becomes `data-tone` (accent / ink / muted / faint / ok / err), which the CSS colours.
- Non-DOM renderers (a PTY, a canvas) can use `EnsembleTerminal.spec(style, state, set)`.

| set · style | working | idle | done | error |
|---|---|---|---|---|
| glyph · Expressive | round-1 loop `· ∘ ◡ ∪ ⋃ ≀ ⋈ ✢ ✣ ✳` and back, 80–90 ms per frame, holds 240 ms on ∪ and 260 ms on ✳ (2.1 s cycle) | `∪` faint | `∪ ⋃ ✓` (ok green) | `⋈ ≀ ✕` (err) |
| glyph · Quiet | `◡ ∪ ⋃ ∪`, 360/520 ms, muted | `∪` | `✓` muted | `≀` muted red |
| glyph · Dot | `· • ● •` breathing, 520/260 ms, agent | `·` | `•` ink | `∘` err |
| safe · * | JetBrains-Mono-only rings `· ∘ ◌ ◯ ◎ ● …` (Quiet `◌ ◯ ◌ ∘`, Dot `· •`) | `∘` / `·` | `●` / `•` | `✕` / `×` / `∘` |
| ascii · * | `. o O o` (Dot `. :`) | `.` | `*` | `x` |

**Fonts.** The family is `"JetBrains Mono", "Ensemble Frames", ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace`.

- JetBrains Mono has `· ∘ • ● ✕` but **not** `◡ ∪ ⋃ ≀ ⋈ ✢ ✣ ✳ ✓`. Those come from **Ensemble Frames**, a 14-glyph, 2 KB woff2 built from DejaVu Sans.
- Ensemble Frames is re-spaced to JetBrains Mono's 0.6 em advance and uses JetBrains Mono's vertical metrics. Its `unicode-range` restricts it to those code points, so it never touches other text.
- The headless check measures every frame character at exactly `1ch` (8.41 px at 14 px). Chrome's own font report confirms each glyph comes from JetBrains Mono or Ensemble Frames (`gallery/shots/fonts-report.json`).
- `✳` is stored as `✳︎` (U+FE0E) and the CSS sets `font-variant-emoji: text`, so Apple/Windows never swap in the emoji.
- The cell is a fixed `1ch` inline-block, so a missing glyph or a slow font can't make the line jitter.
- If the app can't ship the woff2, use `data-set="safe"`, which needs only JetBrains Mono.
- Licence: DejaVu/Bitstream Vera allows modified copies under a new name. The licence text is in `fonts/LICENSE-ensemble-frames.txt`.

**SVG** (14 × 14, one markup for all styles; CSS shows the parts each style needs):

- **Expressive:** the two strands counter-flow, the outer dashes running one way and the inner the other (a weave), 1.2 s. On `done` the mark shrinks away and a check draws with a snappy-spring pop, in ok green. On `error` the two outer halves spring apart (±9°) in err red.
- **Quiet:** a hairline mark with one short accent segment that travels the mark and comes back, 1.8 s. On `done` the check draws without the pop. On `error` the halves part by 4° in muted red.
- **Dot:** you · agent dots. On `working` the agent dot breathes, 1.4 s. On `done` the dots meet and become one. On `error` the agent dot turns hollow red.
- **Reduce:** still poses with no loops and no pop. The text driver shows the `still` frame and re-evaluates live when the OS setting or attribute changes.

## 3 · Tray PNG set

All PNGs are single-colour: every pixel has the same RGB and the anti-aliasing is in alpha only. The script checks this after rasterising.

| file | what | use |
|---|---|---|
| `trayTemplate.png` / `trayTemplate@2x.png` | 16 pt template, pure black + alpha | **macOS default** (Electron marks `…Template` files as template images and loads `@2x` on Retina) |
| `tray18Template.png` / `@2x`, `tray22Template`, `tray32Template` | the same at 18 / 22 / 32 pt | macOS alternatives (18 pt matches most third-party menu-bar icons) |
| `tray-accent-<16/18/22/32>.png` / `@2x` | #7c6af7 | Windows light taskbar, light Linux panels |
| `tray-accent-light-<16/18/22/32>.png` / `@2x` | #9d8fff (the icon's gradient top) | dark taskbars and panels |
| `tray-accent.ico`, `tray-accent-light.ico` | PNG-in-ICO with 16, 18, 22, 32, 36, 44, 64 px, each frame the hinted raster (no resampling) | Windows (`new Tray('tray-accent-light.ico')`) |

**Why there's a light variant (WCAG non-text contrast, 3:1).** #7c6af7 gets 3.6 on #f3f3f3 (Windows light), 4.1 on #202020 (Windows dark), but only 3.55 on #2b2b2b and 2.76 on #3c3c3c (lighter dark panels). #9d8fff gets 6.1 on #202020, 5.3 on #2b2b2b and 4.1 on #3c3c3c, but only 2.4 on light. So use accent on light and accent-light on dark.

```js
// Electron sketch
const { Tray, nativeImage, nativeTheme } = require('electron');
const P = (f) => path.join(__dirname, 'tray', f);
const icon = () => process.platform === 'darwin' ? P('trayTemplate.png')                      // @2x picked up automatically
  : process.platform === 'win32' ? P(nativeTheme.shouldUseDarkColors ? 'tray-accent-light.ico' : 'tray-accent.ico')
  : P(nativeTheme.shouldUseDarkColors ? 'tray-accent-light-22.png' : 'tray-accent-22.png');    // most Linux panels are 22–24 px
const tray = new Tray(nativeImage.createFromPath(icon()));
nativeTheme.on('updated', () => tray.setImage(icon()));
```

**Hand-hinting.** `tools/gen_tray.py` re-derives the mark for every device-pixel canvas instead of downscaling.

- It picks whole-pixel outer width, gap, inner width and opening closest to the master's proportions (84 : 36 : 64 : 108 of 476).
- The total width is kept even and centred, so both arms land exactly on pixel columns.
- The arc centre sits on a whole pixel, so the two curves stay concentric.
- Caps are flat (butt) below 32 px, where a 1 px round cap would just blur, and round at 32 px and above, like the master.

| canvas | glyph W×H | outer | gap | inner | opening | caps |
|---|---|---|---|---|---|---|
| 16 px | 12×13 | 2 | 1 | 2 | 2 | butt |
| 18 px | 14×15 | 2 | 1 | 2 | 4 | butt |
| 22 px | 16×17 | 3 | 1 | 2 | 4 | butt |
| 32 px | 24×26 | 4 | 2 | 3 | 6 | round |
| 36 px | 28×31 | 5 | 2 | 4 | 6 | round |
| 44 px | 36×39 | 6 | 3 | 5 | 8 | round |
| 64 px | 52×57 | 9 | 4 | 7 | 12 | round |

The results are written to `tray/src/tray-<template|accent|accent-light>-<N>px.svg` (filled paths, so they also serve as clean vector sources at those sizes) and `tray/src/hinting.json`. `tray/src/tray-master.svg` is the full-resolution single-colour mark.

**State SVGs.** The animated and extra tray states from round 2 (Expressive) and round 3 (Quiet / Dot) are in `tray/states/`: idle, working, syncing, needs, done, error, paused, offline, plus listening for round 2, each as colour/accent and template. They're SVGs with CSS animation. A native tray can't play them, so either rasterise frames at runtime (an offscreen `BrowserWindow`/canvas, then `tray.setImage` per frame) or use them in menus and windows. The PNG set is the static idle mark.

## Rebuilding and checking

```
python3 tools/gen_font.py      # Ensemble Frames + gallery JetBrains Mono subset
python3 tools/build_driver.py  # terminal-working.js = .src.js + terminal-frames.json
python3 tools/gen_tray.py      # hinted SVGs per pixel size
node tools/raster_tray.js      # Chrome → exact-size transparent PNGs
python3 tools/finish_tray.py   # single-colour pass, .ico, contact sheet
node tools/check.js            # every style × theme × state; console errors, failed requests, fonts used, 1ch widths, reduce; shots in gallery/shots/
```
Edit `terminal-frames.json`, then run `build_driver.py`. The driver carries the JSON inline, so it works from `file://` and needs no fetch.
