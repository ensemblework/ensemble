# Brand and motion

Ensemble's implemented identity is **Woven Chorus**, in **Satin Gold**. It represents humans and agents working from shared context. The shared implementation lives in `packages/brand`; the historical galleries in `design/` are exploration archives, not production inputs.

## Artwork and assets

The approved masters are `packages/brand/assets/woven-satin.svg`, `woven-white.svg` and `woven-ink.svg`. The optical micro variant is used at 20 px and below. `artwork.json` is generated from the masters with polyline simplification bounded to .025 pixels in the 320-unit viewBox. The master files remain unchanged. Callers scope gradient IDs, including during server rendering, so multiple inline logos cannot pick up one another's gradients.

`staticSVG` and `svgBody` support Satin Gold, white, ink, current-color and automatic treatments. Automatic Hub marks use Satin Gold on dark surfaces and ink on light surfaces. Native launcher tiles and marketing identity use the stable gold identity, independent of the user's interface accent. The full mark is used above 20 px, with deliberate over/under crossing gaps. Browser tab and Apple touch icons use generated content-hashed URLs from `@ensemble/brand/icons`, so a brand change requests a fresh icon even when a browser retains a site icon across sessions. The conventional `/favicon.ico` remains a gold fallback in `public/`, outside Next’s file-metadata convention; page metadata advertises the hashed PNG/ICO/SVG URLs. These paths are available before login.

The gradient stops are:

| Strand | Stops |
|---|---|
| A | 0 `#B58A46`, .30 `#F5DFA5`, .66 `#D7B56F`, 1 `#F8ECC8` |
| B | 0 `#E5CB95`, .36 `#BE944F`, .72 `#F3D899`, 1 `#D1AD67` |

`pnpm brand:build` runs `scripts/build-ensemble-brand.mjs` with Sharp and esbuild. It also refreshes the self-contained `design/brand/index.html` gallery and its SVGs. It generates favicons, web-app and maskable icons, Apple touch icons, social previews, PNG/ICO/ICNS native icons, Quick capture tray RGBA/PNG files, standalone native motion bundles and error/offline HTML. `packages/brand/assets/generated.json` records source/output hashes. `pnpm brand:check` rejects changed sources or stale/missing generated assets. `node scripts/check-icons.mjs` validates ICO and ICNS containers.

The native dock/launcher icon is static. macOS uses the inset tile through ICNS. The Quick capture tray uses the monochrome OS template on macOS, gold on dark taskbars and ink on light taskbars elsewhere. Main desktop has no tray.

## Palettes

`apps/hub-web/lib/color-themes.ts` owns the named interface palettes. Ensemble's dark palette is Deep Petrol (`#10282B` canvas, `#173236` panels); Smoked Aubergine (`#231B2A` canvas, `#2D2335` panels) is the second gold-oriented option. Both retain warm paper in light mode. Existing Graphite, Lagoon, Aurora, Juniper and Blueprint choices remain.

Satin Gold is the default interface accent (`#D7B56F` dark / `#876324` light). Existing explicit preset/custom choices remain. Marketplace template validation and desk previews use the same Satin Gold option. `resolveAccent` checks text/button contrast against all five surfaces, adjusting lightness if needed. Status colours keep their semantic meanings.

## One Expressive system

| Role | Timing | Real use |
|---|---|---|
| Unfurl | 720 ms once | Assistant opening, home navigation, completion celebration |
| Infinity | 660 ms entrance, 3.4 s flow | Assistant pending/streaming, including minimized launcher |
| Relay | 620 ms entrance, 5.4 s flow | Running agent tasks and terminal work |
| Threadline | 500 ms entrance, 2.2 s flow | Page/document and narrow loading surfaces |
| Beacon | 560 ms entrance, 3.6 s flow | Top bar, refresh, compact controls, saves/imports/exports |

`packages/brand/motion.js` gathers the strands before larger transformations and settles from the current pose in 340 ms. The rest frame restores the approved artwork. A single scheduler runs active visible marks at up to 30 fps. Intersection observers suspend offscreen work; hidden documents stop scheduling. Destroying a controller clears its pending delay, observers and completion promise. Reduced motion is checked both from the OS and `data-reduce-motion`; it displays the still mark without frame scheduling.

`BrandMorph` is the React wrapper. Loaders wait 180 ms before appearing. Completed results have no artificial minimum hold. Queued, paused, cancelled, error, offline and needs-human states remain still. Text communicates actual status; animation frames are not live announcements. Explicit progress percentages are retained where available.

The Appearance motion-style picker and alternate suites are removed. The shared settings schema normalizes old Quiet/Dot values to Expressive. **Reduce motion** remains independently configurable. The native startup shell follows the OS preference; it does not copy the browser's Reduce motion toggle across origins.

The landing hero performs a finite entrance; its accessible replay button runs Infinity and settles. The context-thread illustration and sample board story are finite as well; its agent rows use the same Relay motion. Empty states keep a still Woven Chorus mark. Reduced motion disables the entrance and shows the static brand mark.

## CLI

`packages/brand/cli.js` owns the four-cell braille infinity and capability policy. `apps/cli/src/tui/brand.tsx` updates only its own Ink component at 8 fps while work runs. Idle uses `[e]`, with no timer. Redirected output or `TERM=dumb` uses ASCII; `NO_COLOR` removes brand colour independently of motion. Truecolor uses Satin Gold; limited-colour terminals use ANSI yellow. `ENSEMBLE_REDUCE_MOTION=1` suppresses the loop. The CLI bundle includes these assets and requires no separately published brand package.

## Verification

Checks cover palette contrast, legacy motion normalization, no obsolete picker destination, unique SVG IDs, reduced motion during an active loop, delayed-loader cancellation, all working poses, prompt settling, and terminal fallbacks. The brand guard scans shipping source while excluding build caches and historical design explorations. Native startup logic is covered by the desktop Rust tests.

Builds and browser checks are reported with the implementation change. Generating source assets does not publish a website or release a native/CLI binary; installed apps receive the identity through the usual release/update process.

Checked 14 Oct 2026: 422 Hub tests, all-package TypeScript checks, 53 shared-type tests, 57 CLI/package tests, the shared brand/controller and catalogue checks, landing static build, desktop static export, 15 desktop Rust tests, Quick capture `cargo check`, and all 90 generated asset hashes/ICO/ICNS containers. Subsequent small UI changes passed their focused checks. Browser inspection used an isolated in-memory test workspace to verify Deep Petrol, Aubergine, light-mode ink marks, the removed motion picker, assistant opening and reduced motion. The production-controller gallery and landing replay were checked through completion and settling. Native installers were not launched on all three operating systems, before release. CLI 0.3.6 and desktop 0.3.3 carry this identity; production deployment runs after main CI succeeds.

The favicon follow-up was checked with the production landing build: rendered metadata advertises content-hashed PNG/ICO/SVG URLs and no unversioned `/favicon.ico` link. Anonymous asset tests verify these URLs work before sign-in.
