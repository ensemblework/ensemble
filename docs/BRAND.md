# Brand and motion

Use Ensemble’s **Woven Chorus** mark in **Satin Gold**. Its two strands represent humans and agents working from shared context. Choose the artwork size and treatment for its surface, and use motion only while it communicates activity.

## Palettes

`apps/hub-web/lib/color-themes.ts` defines the interface palettes. The Ensemble default is Deep Petrol (dark: `#10282B` canvas, `#173236` panels); Smoked Aubergine (`#231B2A` canvas, `#2D2335` panels) is the second gold-oriented option. Both use warm paper in light mode. Graphite, Lagoon, Aurora, Juniper and Blueprint are also available.

Satin Gold is the default accent (`#D7B56F` dark, `#876324` light; `apps/hub-web/lib/accent.ts`); explicit preset or custom accents are kept. Marketplace template validation and desk previews offer the same option. `resolveAccent` checks text and button contrast against the palette's surfaces and adjusts lightness when needed. Status colours keep their meanings.

## Artwork and assets

The masters are `packages/brand/assets/woven-satin.svg`, `woven-white.svg` and `woven-ink.svg`, plus `woven-micro.svg`, the optical variant used at 20 px and below. `artwork.json` is generated from the masters by simplifying the sampled polylines within .025 px of the 320-unit viewBox; the masters stay unchanged.

Callers scope gradient IDs (also during server rendering), so several inline logos never share a gradient.

| Strand | Gradient stops |
|---|---|
| A | 0 `#B58A46`, .30 `#F5DFA5`, .66 `#D7B56F`, 1 `#F8ECC8` |
| B | 0 `#E5CB95`, .36 `#BE944F`, .72 `#F3D899`, 1 `#D1AD67` |

`staticSVG` and `svgBody` render Satin Gold, white, ink, current-color and automatic treatments. Automatic Hub marks are gold on dark surfaces and ink on light ones. Launcher tiles and marketing use the gold identity regardless of the user's accent. Above 20 px the full mark keeps its over/under crossing gaps.

`pnpm brand:build` (`scripts/build-ensemble-brand.mjs`, Sharp and esbuild) generates favicons, web-app and maskable icons, Apple touch icons, social previews, PNG/ICO/ICNS native icons, Quick capture tray RGBA/PNG files, the standalone native motion bundles, error/offline HTML, and the `design/brand/` gallery and SVGs.

`packages/brand/assets/generated.json` records source and output hashes; `pnpm brand:check` fails on changed sources or stale or missing outputs. `node scripts/check-icons.mjs` validates the ICO and ICNS containers.

Browser tab and Apple touch icons use content-hashed URLs from `@ensemble/brand/icons`, so a brand change fetches a fresh icon even when a browser caches site icons. `/favicon.ico` is a gold fallback in `apps/hub-web/public/`, outside Next's file-metadata convention; page metadata advertises the hashed PNG/ICO/SVG URLs. These paths load before sign-in.

Native launcher icons are static; macOS uses the inset tile in the ICNS. The Quick capture tray is a monochrome template on macOS and gold on dark or ink on light taskbars elsewhere ([20](20_QUICK_CAPTURE.md)). The main desktop app has no tray ([DESKTOP](DESKTOP.md)).

## Motion

Web agent requests use three treatments from `packages/brand/web-activity/`. They start and end at the Woven Chorus mark.

| Treatment | Where it appears | Working motion |
|---|---|---|
| Open infinity | Code thread sidebar (20 × 18 px), activity pill (24 px), minimized assistant (32 px) | One moving opening covers 28% of the figure-eight's path, including the space reclaimed by the rounded ends. A lap takes about 1.9 s. |
| Loop exchange | Waiting for the first reply in the Hub, inline Ask, comments and docs helper; a Code turn thinking before output | Two loops exchange places inside a 38 × 23 px slot. |
| Open weave | A live assistant reply or tools, focused assigned-task and run detail, meeting reads and preparation | The two strands open into a traveling wave beside the text, in the same 38 × 23 px slot. |

`AgentActivityMark` (`apps/hub-web/components/motion/agent-activity-mark.tsx`) takes the current kind or no activity. A short wait can finish without drawing a loader. A sustained request stays in its working shape until the underlying state changes, without periodic returns to idle. Finishing or stopping folds the current pose back into the logo. Restarting during that return preserves the current position and velocity. Labels, replies, errors and controls do not wait for the return. Visible moving marks share a frame clock capped at 30 fps; idle marks need no clock.

AI-only loading marks wait 350 ms before appearing. Ordinary controls use `LocalSpinner` (minimum 14 px) and a 250 ms delay. Structural skeletons and IDE loading strips also wait 250 ms. Results are never held to finish an animation. Route feedback follows Suspense loading boundaries, including the general Hub fallback, rather than a click-triggered global logo.

Queued, starting, stopping, paused, cancelled, failed, offline and needs-human states stay still. Run queues and dashboard lists keep static status cues. Code gives the visible running thread row the motion; when the selected row is out of view, its turn header takes over. Saved replies are still. Status text carries meaning; elapsed seconds and graphic frames are not live announcements. Only measured bytes or items have percentages.

Choose **Settings → Appearance → Reduce motion** to keep marks still. This setting is independent of the OS preference. Either the OS preference or `data-reduce-motion` suppresses frame scheduling. There is no motion-style picker; the settings schema maps old `minimal-quiet` and `minimal-dot` values to `expressive`. The native startup screen follows the OS preference only.

`packages/brand/geometry.js` and `motion.js` own the separate navigation, celebration, showcase and native startup gestures. The landing hero arrives once (CSS, off under reduced motion); clicking it plays Infinity and settles. The sample board's agent rows use Relay. Empty states show a still mark.

## Profile avatars

People use the circular pixel collection from `packages/shared-types/src/avatars.ts`, rendered by `apps/hub-web/components/avatars/persona.tsx`. Every account can choose any of the twelve characters, six palettes and five scenery options. The avatar uses two related inks, one accent pixel and a pale neutral field, independent of the UI theme.

Foreground and scenery preserve intentional silhouette gaps. A real circle clip applies to every size, including account menus, comments, presence and the Settings picker. Account initials remain optional. Profile avatars are static; the agent mark below retains its own identity. Selection, compatibility and stored-account migration: [Sharing](29_SHARING.md).

## Agent mark

`packages/brand/agent.js` exports `agentSvgBody`, a small woven two-strand glyph with a central junction. `apps/hub-web/components/agent-icon.tsx` renders it at the surrounding icon size and colour. Agent ownership, assignment, run requests, editor agent blocks and notifications use it on the web and in the desktop export. Provider logos keep their own artwork.

## CLI

`packages/brand/cli.js` owns the four-cell braille infinity and the terminal policy; `apps/cli/src/tui/brand.tsx` redraws only its own Ink component at 8 fps for one working phrase, then keeps the still mark for 5.95 s before repeating. Idle shows `[e]` with no timer.

Redirected output or `TERM=dumb` uses ASCII; `NO_COLOR` removes colour independently of motion; truecolor terminals get Satin Gold, others ANSI yellow; `ENSEMBLE_REDUCE_MOTION=1` stops the loop. The CLI bundle includes these assets.

## In the code

`packages/brand` implements the identity. Everything in the repo-root `design/` folder is generated from it; do not edit those files by hand.

### Checks

```bash
pnpm brand:build && pnpm brand:check
node scripts/check-icons.mjs
pnpm --filter @ensemble/brand test
```

Tests cover palette contrast, motion normalization, unique SVG IDs, reduced motion during a running loop, delayed-loader cancellation, every working pose, settling, and terminal fallbacks. A brand guard (`apps/hub-web/lib/brand-guard.test.ts`) scans shipping source, excluding build caches. The desktop startup screen is covered by the desktop Rust tests.

Installed apps get a new identity only through a release.

The docs helper shares launcher and resize geometry through `packages/brand/assistant.js`; the Hub component entry points re-export those functions. Its build copies the Hub assistant styles and uses the shared web activity player for its launcher and non-streaming reply wait.
