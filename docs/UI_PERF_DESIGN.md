# UI performance and measurement

This guide covers current performance ownership and verification, inspected **18 Oct 2026**. The [September investigation](design/ui-performance-2026-09.md) is retained as historical design evidence, not a claim about current bundle size, API latency or production throughput.

## Current architecture

- The Hub shell persists across client navigation. Data comes from scoped React Query reads; mutations/SSE invalidate it. Page collaboration uses its own version protocol.
- Heavy editors, preview/rendering libraries and settings sections have feature-level lazy-loading boundaries. Check the actual import graph before adding a dependency to shared shell/card code.
- Board/list responses avoid including every rich document and original file. Detail readers and model tools are bounded/chunked.
- File extraction/Office/plot work has explicit resource limits and separate worker/browser paths. Hosted plotting can download its browser runtime; first-use cost is not a normal API-response cache miss.
- Desktop's static export uses route bundles and the loopback API. It is not a hosted Next server running in the webview.
- Assistant routing keeps initial playbooks/tool schemas and skill bodies bounded. Provider prompt caching is conditional; [CACHING](CACHING.md) documents current caches/state.

## What to measure

Use a production build and identify commit, OS/browser, viewport, network/CPU settings, account size, warm/cold state and provider mode. Separate shell paint, data-ready time, editor interactivity and remote/model wait. Do not compare `next dev` compilation time with production navigation.

Record route JavaScript, critical requests, payloads, input-to-paint/long tasks and relevant API p50/p95 with sample counts. For files/plots, include format/size, runtime startup and warm export separately. For assistant changes, include input/output/cached tokens and success of the actual action, not only prose quality.

The scripts under `scripts/measure-*`, `scripts/ui-walk.mjs`, web `e2e` and feature-specific verification scripts are available starting points; inspect their environment/fixture assumptions before running. Keep screenshots/recordings and results in the PR. Do not commit real accounts, tokens or production data as a benchmark fixture.

## Verification boundaries

`pnpm --filter @ensemble/hub-web test` checks UI contracts, including generated assistant tile metadata. Production Hub/static exports, API tests, browser walkthroughs and native installer checks cover different risks. A DOM test is not a browser-rendering benchmark; a loopback measurement is not a hosted latency promise. No new numerical performance claim is made by this documentation-only change.
