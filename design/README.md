# Ensemble design

Design work for Ensemble: the app icon and the motion system. Nothing here is app code, and nothing in the app imports from this folder.

```
design/
  icons/                 app icon explorations and the chosen icon (B "Two voices"), UI icons, sheets and source
  motion/                motion system
    index.html           round 1: loaders and working animations (Ensemble Glyph, status line, streaming, tools, loom…)
    PLAN.md              round 1 placement map and motion principles
    components/          round 1 standalone CSS/SVG/JS components (tokens.css, glyph, status-line, …)
    media/               round 1 tour video and screenshots
    round2/index.html    round 2: 17 expressive moments (celebrations, onboarding, collaboration, micro-interactions, tray, logo reveals)
    round2/PLAN-round2.md, round2/components/, round2/media/
    round3-minimal/index.html   round 3: the Minimal style (Quiet + Dot) for all 16 motion slots, plus a switcher comparing styles side by side
    round3-minimal/SUITE.md     motion-suite architecture: slots, data-motion-theme, --m-* tokens, React and native notes
    round3-minimal/components/, round3-minimal/media/
    */tools/             the build and capture scripts used to make the galleries and videos (not needed to view them)
```

## Viewing the galleries
Open any `index.html` directly in a browser (double-click it, or use `open design/motion/round2/index.html` on macOS). No server and no install are needed. Each gallery is a single self-contained file with its fonts, CSS and JS inlined, so it works offline.

- Round 1: `design/motion/index.html`
- Round 2: `design/motion/round2/index.html` (add `?light` or `?reduced` to the URL to preview light mode or reduced motion)
- Round 3: `design/motion/round3-minimal/index.html` (its style switcher embeds rounds 1 and 2 from `round3-minimal/compare/`)

Round 2's Needle reveal threads the Ensemble wordmark and finishes with a knot beside it. Regenerate the self-contained galleries with `python3 design/motion/round2/tools/build.py`, then `python3 design/motion/round3-minimal/tools/build.py`.

Tour videos, stills and screenshots are not kept in the repo. Each round's `tools/` scripts regenerate them.
