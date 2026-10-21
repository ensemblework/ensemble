# Brand and motion

Ensemble's identity is **Woven Chorus** in **Satin Gold**: two strands for humans and agents working from shared context. The implementation is `packages/brand`. Everything in the repo-root `design/` folder is generated from it; do not edit it by hand.

## Artwork and assets

The masters are `packages/brand/assets/woven-satin.svg`, `woven-white.svg` and `woven-ink.svg`, plus `woven-micro.svg`, the optical variant used at 20 px and below. `artwork.json` is generated from the masters by simplifying the sampled polylines within .025 px of the 320-unit viewBox; the masters stay unchanged. Callers scope gradient IDs (also during server rendering), so several inline logos never share a gradient.

| Strand | Gradient stops |
|---|---|
| A | 0 `#B58A46`, .30 `#F5DFA5`, .66 `#D7B56F`, 1 `#F8ECC8` |
| B | 0 `#E5CB95`, .36 `#BE944F`, .72 `#F3D899`, 1 `#D1AD67` |

`staticSVG` and `svgBody` render Satin Gold, white, ink, current-color and automatic treatments. Automatic Hub marks are gold on dark surfaces and ink on light ones. Launcher tiles and marketing use the gold identity regardless of the user's accent. Above 20 px the full mark keeps its over/under crossing gaps.

`pnpm brand:build` (`scripts/build-ensemble-brand.mjs`, Sharp and esbuild) generates favicons, web-app and maskable icons, Apple touch icons, social previews, PNG/ICO/ICNS native icons, Quick capture tray RGBA/PNG files, the standalone native motion bundles, error/offline HTML, and the `design/brand/` gallery and SVGs. `packages/brand/assets/generated.json` records source and output hashes; `pnpm brand:check` fails on changed sources or stale or missing outputs. `node scripts/check-icons.mjs` validates the ICO and ICNS containers.

Browser tab and Apple touch icons use content-hashed URLs from `@ensemble/brand/icons`, so a brand change fetches a fresh icon even when a browser caches site icons. `/favicon.ico` is a gold fallback in `apps/hub-web/public/`, outside Next's file-metadata convention; page metadata advertises the hashed PNG/ICO/SVG URLs. These paths load before sign-in.

Native launcher icons are static; macOS uses the inset tile in the ICNS. The Quick capture tray is a monochrome template on macOS and gold on dark or ink on light taskbars elsewhere ([20](20_QUICK_CAPTURE.md)). The main desktop app has no tray ([DESKTOP](DESKTOP.md)).

## Palettes

`apps/hub-web/lib/color-themes.ts` defines the interface palettes. The Ensemble default is Deep Petrol (dark: `#10282B` canvas, `#173236` panels); Smoked Aubergine (`#231B2A` canvas, `#2D2335` panels) is the second gold-oriented option. Both use warm paper in light mode. Graphite, Lagoon, Aurora, Juniper and Blueprint are also available.

Satin Gold is the default accent (`#D7B56F` dark, `#876324` light; `apps/hub-web/lib/accent.ts`); explicit preset or custom accents are kept. Marketplace template validation and desk previews offer the same option. `resolveAccent` checks text and button contrast against the palette's surfaces and adjusts lightness when needed. Status colours keep their meanings.

## Motion

One Expressive system; timings from `packages/brand/geometry.js`:

| Role | Timing | Used for |
|---|---|---|
| Unfurl | 720 ms once | Assistant opening, home navigation, completion |
| Infinity | 660 ms entrance, 3.4 s loop | Assistant pending/streaming, including the minimized launcher; desktop first connection |
| Relay | 620 ms entrance, 5.4 s loop | Running agent tasks and terminal work |
| Threadline | 500 ms entrance, 2.2 s loop | Pages, documents and narrow loading surfaces |
| Beacon | 560 ms entrance, 3.6 s loop | Top bar, refresh, compact controls, saves, imports, exports |

`packages/brand/motion.js` gathers the strands before larger moves and settles from the current pose in 340 ms; the rest frame is the approved artwork. One scheduler runs visible marks at up to 30 fps; intersection observers pause offscreen marks and hidden documents stop scheduling. Destroying a controller clears its pending delay, observers and completion promise.

`BrandMorph` is the React wrapper. Loaders wait 180 ms before appearing; finished results are not held. Queued, paused, cancelled, error, offline and needs-human states stay still. Text carries the actual status (frames are not announced), and real progress percentages are shown where available.

Reduced motion (the OS preference or `data-reduce-motion`) shows the still mark with no frame scheduling. Settings → Appearance → **Reduce motion** is independent of the OS. There is no motion-style picker; the settings schema maps old `minimal-quiet` and `minimal-dot` values to `expressive`. The native startup screen follows the OS preference only.

The landing hero arrives once (CSS, off under reduced motion); clicking it plays Infinity and settles. The sample board's agent rows use Relay. Empty states show a still mark.

## CLI

`packages/brand/cli.js` owns the four-cell braille infinity and the terminal policy; `apps/cli/src/tui/brand.tsx` redraws only its own Ink component at 8 fps while work runs. Idle shows `[e]` with no timer. Redirected output or `TERM=dumb` uses ASCII; `NO_COLOR` removes colour independently of motion; truecolor terminals get Satin Gold, others ANSI yellow; `ENSEMBLE_REDUCE_MOTION=1` stops the loop. The CLI bundle includes these assets.

## Agent mark

`packages/brand/agent.js` exports `agentSvgBody`, a small woven two-strand glyph with a central junction. `apps/hub-web/components/agent-icon.tsx` renders it at the surrounding icon size and colour. Agent ownership, assignment, run requests, editor agent blocks and notifications use it on the web and in the desktop export. Provider logos keep their own artwork.

## Checks

```bash
pnpm brand:build && pnpm brand:check
node scripts/check-icons.mjs
pnpm --filter @ensemble/brand test
```

Tests cover palette contrast, motion normalization, unique SVG IDs, reduced motion during a running loop, delayed-loader cancellation, every working pose, settling, and terminal fallbacks. A brand guard (`apps/hub-web/lib/brand-guard.test.ts`) scans shipping source, excluding build caches. The desktop startup screen is covered by the desktop Rust tests. Installed apps get a new identity only through a release.
