# 40 · Public documentation

Read Ensemble's product guides without signing in. Choose a focused topic, search for a question, or open **Ask the docs** for an answer with links to the published guides.

## Read a guide

Choose a guide from **All guides**, then open the topic you need. Each topic has its own page. The guide link above the title takes you back to its topic list.

Reading and navigation work without JavaScript. The site follows your system's light or dark theme. Use the theme button to choose a different appearance.

The public site contains product guidance. It does not publish Ensemble's source code or link to its repository implementation.

## Search the docs

Enter the words you want to find in **Search docs**, then choose **Search**. Results show a short passage and a link to its topic.

If nothing matches, try fewer words or browse the guide's topics. Search needs JavaScript and works locally in your browser once the index loads.

## Ask a question

1. Open the round woven button at the bottom corner of any page.
2. Enter a question about using Ensemble and choose **Ask**.
3. Read the answer and follow its source links to verify it.
4. Choose **Close docs helper**, or press Escape, to return to the button.

The helper uses only published documentation. It cannot read your Ensemble account, tasks, files or source code, and it does not open an Ensemble chat. It will not show implementation code or repository links. No sign-in or API key is needed.

If the guides do not answer the question, the helper says **That is not in the docs** and suggests the closest topic. The panel reminds you: **AI can make mistakes, please verify**.

## When the helper cannot answer

The helper limits requests so everyone can use it within a bounded service allowance. If you reach a limit, try later or use search. A service failure also leaves search and the guides available.

Questions can contain up to 500 characters. Answers stay short and include only links to published topics. Questions and answers are not saved by the helper.

## In the code

The following build, API and operating references remain in the repository documentation. They are not published to readers or used as helper grounding.

## 1. Source, URLs and search

Choose a guide from the navigation, follow its section links, or search for words from a topic. Reading and navigation work without JavaScript. Search and the helper need JavaScript. An unmatched search says that it found no documentation.

The site publishes only tracked Markdown under `docs/`. The build rejects symbolic links and does not copy git-ignored files, credentials, runbooks or `private/`. The public build splits product headings into focused topic pages. Repository guides retain the detailed technical facts and implementation paths after **In the code**; that material and maintenance-only guides are excluded from publication. The home page is `docs/README.md`.

Pages use the lowercase source path without `.md`, followed by `/`: `docs/CONTEXT_BRIDGE.md` becomes `/context_bridge/`, and `docs/desktop/MAC_CHECKLIST.md` becomes `/desktop/mac_checklist/`. Original `.md` URLs redirect to those pages. Reference heading anchors are generated from heading text, with numbered suffixes for duplicates. Links between published guides stay on the site; repository source links are removed from public output. Each public heading gets a focused child URL. Existing guide URLs remain topic indexes; old heading fragments offer a link to the topic without JavaScript and redirect to it with JavaScript.

The interface uses the Hub's dark Deep Petrol and light warm-paper tokens, Figtree text, Fraunces titles and JetBrains Mono code. Fonts are served from the site. It follows the system theme unless the reader chooses Light theme or Dark theme; only that preference is kept in local storage. The header uses the shared 32px woven mark. The helper launcher uses the Hub's 44px button and the same 32px BrandMorph artwork and motion engine. Reduced motion keeps the mark still.

`search-index.json` contains the rendered pages' titles, section URLs and plain text. Local search matches every query word, ranks headings and titles above body text, and returns at most eight passages by default. `sitemap.xml`, `robots.txt` and `llms.txt` expose the public page list. The build writes plain HTML, CSS and JavaScript, with no account cookies or embedded credentials.

## 2. Build and hosting

From the repository root, run:

```bash
pnpm --filter @ensemble/docs build
pnpm --filter @ensemble/docs test
```

The output is `apps/docs/out`. Use Node 22 or later and the pnpm version in `package.json`. The build supplies Cloudflare headers and redirects. Its content policy permits scripts, styles and fonts from the site, and connections to the site and `https://api.ensemblework.com`. The search index has a 60-second cache lifetime.

Cloudflare Worker **ensemble-docs** serves the static assets at **docs.ensemblework.com**, outside Cloudflare Access or any login gate. Workers Builds is connected to this repository and publishes every push to `main`. Preview builds are off. A pull request into `testing`, or a push to `testing`, does not update this hostname. Testing's API receives the helper route through the normal test deployment, but there is no separate test docs site.

The Worker build installs the docs package and its dependencies. `SKIP_DEPENDENCY_INSTALL=1` disables the automatic full-monorepo install:

```bash
corepack pnpm install --frozen-lockfile --filter @ensemble/docs && corepack pnpm --filter @ensemble/docs build
npx wrangler deploy --name ensemble-docs --assets apps/docs/out --compatibility-date 2026-11-01
```

The [fast checks](37_PAUSED_CHECKS.md#what-runs-now) build and test the site, the helper and the existing lookup. GitHub Actions does not publish the docs Worker. Operator account values stay in `private/`.

## 3. Lookup through the Context Bridge

Editors can search the published guides through `ensemble_docs`, a read tool on the existing Context Bridge. Its title is **Search Ensemble documentation**. It is read-only, non-destructive and idempotent. Legacy metadata marks it closed-world; the hosted named catalog marks the public-site lookup open-world. Try `{query: "Three ways to reach it", limit: 1}` to find bridge setup.

The tool calls authenticated `GET /api/bridge/docs?q=...&limit=...`. Hosted MCP requires a static key or OAuth access token in `Authorization: Bearer ens_…`. The tool needs no changes or connected-app grant, does not widen a key, and keeps the bridge's owner-only sharing class and credential checks. It reads no private workspace records.

Lookup fetches only `https://docs.ensemblework.com/search-index.json`, without forwarding the caller's key. It validates the index and URL origin, uses the site's shared search code, and caches a successful index for 60 seconds per API process. Queries accept 1 to 200 characters of search words. The result limit is 1 to 20, default 8.

The response has `found`, `results` (`title`, `heading`, `url`, `excerpt`), `message` and `home`. Extracts are substrings of published section text. A miss returns `found: false`, an empty result list and the docs home. An unavailable or invalid publication returns 503 and is not cached as a miss; MCP reports a tool error. The [Context Bridge](CONTEXT_BRIDGE.md#5-tools-and-resources) and [CLI](26_CLI.md#5-mcp-local-cli-or-hosted-url) guides cover connection setup. The website helper below is separate from this tool.

## 4. Ask the docs

Open the round button, enter a question and choose **Ask**. The answer includes source links. Close or Escape returns to the button. The panel says **AI can make mistakes, please verify**. It has no model picker, provider label, account controls or settings.

The browser sends only `{question}` to public `POST /api/docs/ask` on the existing API, with credentials omitted. Questions accept 1 to 500 characters; the body limit is 2 KB. The route bypasses identity resolution, so even an attached cookie or key cannot add account context. It creates no chat and reads no tasks, files, accounts or private source code. It runs on hosted APIs, not desktop runtimes. Its CORS permission applies only to this route and does not permit cookies.

The API fetches and validates the public-only search index (`audience: "public"`), with a 60-second cache, at most 2,000 pages and an 8 MB limit. It rejects older indexes that include implementation references. It normalizes question words and ranks overlapping published chunks using term frequency, document frequency, length and exact heading matches. It retrieves at most four distinct sections, each passage at most 2,200 characters. Only the question, those passages and their published URLs enter the model input. There are no tools, repository clones, GitHub reads or code-link fetches. A retrieval miss makes no model call. When related passages do not support an answer, the model must report that it is not in the docs. Misses return an ordinary answer with the closest matching guide, or the docs home if nothing matches.

The deployment is fixed to `gpt-5-mini` with `reasoning.effort: "medium"`, `store: false` and a maximum of 4,096 output tokens, including reasoning, further bounded by `ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS`. The prompt asks for at most 120 words. The server resolves citations only to retrieved passages; invalid citations, answers over 120 words, and answers containing URLs, source paths, source filenames or fenced code are refused as misses. The API uses the existing included-AI configuration, `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_API_KEY` and `ENSEMBLE_INCLUDED_*`. No new provider, key or Azure resource is needed. If included AI is off or the deployment is unavailable, the helper cannot call it.

Anonymous use has separate service limits: six requests per minute and 30 per day per address, plus 100 per day and 1,000 per 31 days across the service. These are fixed windows starting at first use. Redis admits all four windows atomically across API processes; failed calls still consume their slot and model calls are not retried. Counters survive API restarts but reset if the transient Redis store restarts. An unavailable limiter fails closed. IPv6 addresses share a /64 allowance; forwarded addresses are accepted only from the hosted loopback tunnel's Cloudflare header. Keys keep a hash of the address, with expiring counters, not the readable address or question.

Limits return 429 with `Retry-After`; service failures return a short 503 message and search remains available. Model requests time out after 60 seconds. This anonymous allowance is separate from account credits and their monthly ledger ([Included AI](33_INCLUDED_AI.md)); it is paid through the same configured resource. Questions and answers are not stored by the helper or logged by its handler. API responses use `Cache-Control: no-store`.

### Implementation files

- `apps/docs/scripts/build.mjs`: tracked-source build, Hub tokens, self-hosted fonts and brand assets, publication headers.
- `apps/docs/src/publication.mjs`, `render.mjs`, `site.css`: public reader layer and page layout.
- `apps/docs/src/search.js`, `site.js`: local search and navigation.
- `apps/docs/src/helper.js`: the standalone panel, credential-free request and citation rendering.
- `apps/hub-api/src/docs-helper/`: public route, publication-only retrieval, fixed model request and limits.
- `apps/hub-api/src/bridge/docs.ts`, `apps/hub-api/src/bridge/routes.ts`: the existing authenticated lookup.
- `packages/brand`, `apps/hub-web/app/globals.css`, `apps/hub-web/components/assistant/ask-launcher.tsx`: shared identity, theme and launcher reference.
