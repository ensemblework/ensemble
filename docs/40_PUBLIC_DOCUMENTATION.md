# 40 · Public documentation

`apps/docs` (`@ensemble/docs`) exports the repository's tracked `docs/**/*.md` to a static site for `https://docs.ensemblework.com`. People and agents can read the pages without signing in or supplying a key. `docs/README.md` is the home page and table of contents. Product guides keep their internal code maps and source links.

## 1. Source, URLs and search

`apps/docs/scripts/build.mjs` reads only Markdown files tracked under `docs/`, rejects symbolic links, and writes `apps/docs/out`. Git-ignored files, `private/`, credentials and runbooks are not copied. The output is plain HTML, CSS and JavaScript, with no server, account cookies or model calls.

Pages use the lowercase source path without `.md`, followed by `/`: `docs/CONTEXT_BRIDGE.md` is `/context_bridge/`, and `docs/desktop/MAC_CHECKLIST.md` is `/desktop/mac_checklist/`. Heading anchors are generated from the heading text, with numbered suffixes for duplicates. Markdown links to published docs become site links; links to repository code open GitHub at the build's source commit. Original `.md` URLs redirect to the matching page.

Each page has the full guide list, its section links and a search form. The site remains readable without JavaScript; search needs it. `search-index.json` contains the rendered pages' titles, section URLs and plain text. `apps/docs/src/search.js` matches every query word, ranks headings and titles ahead of body text, and returns at most eight passages by default. An unmatched query says so. `sitemap.xml`, `robots.txt` and `llms.txt` expose the public page list.

## 2. Build and hosting

```bash
pnpm --filter @ensemble/docs build
pnpm --filter @ensemble/docs test
```

The static publish directory is `apps/docs/out`, built from the repository root with Node 22+ and the pnpm version in `package.json`. The build supplies Cloudflare `_headers` and `_redirects`, including a same-origin content policy and a 60-second cache lifetime for the search index.

The site is the Cloudflare Worker `ensemble-docs`, serving `apps/docs/out` as static assets at the custom domain **`docs.ensemblework.com`**, outside Cloudflare Access or any login gate. Workers Builds, connected to this repository, builds every push to `main` and deploys it; preview builds are off, so `testing` and other branches publish nothing. Its build installs only this package (the variable `SKIP_DEPENDENCY_INSTALL=1` stops the full monorepo install):

```bash
corepack pnpm install --frozen-lockfile --filter @ensemble/docs && corepack pnpm --filter @ensemble/docs build
npx wrangler deploy --name ensemble-docs --assets apps/docs/out --compatibility-date 2026-11-01
```

The fast checks build the site and test lookup ([37](37_PAUSED_CHECKS.md#what-runs-now)); GitHub Actions does not publish it. Operator account values stay in `private/`.

## 3. Lookup through the Context Bridge

`ensemble_docs` is a read tool on the existing Context Bridge, not a second MCP. Its `title` is **Search Ensemble documentation** and its annotations include `readOnlyHint: true`, `destructiveHint: false` and `idempotentHint: true`. Legacy metadata has `openWorldHint: false`; the hosted named catalog marks the public-site lookup open-world. Use `{query: "Three ways to reach it", limit: 1}` to look up the bridge setup heading.

The tool calls authenticated `GET /api/bridge/docs?q=...&limit=...` (`apps/hub-api/src/bridge/routes.ts`). Hosted MCP requires a static key or OAuth access token in `Authorization: Bearer ens_…`; the tool needs neither changes nor connected-app grants and does not widen a key. The route keeps the bridge's owner-only sharing class and credential checks. It reads no private workspace records.

`apps/hub-api/src/bridge/docs.ts` fetches only `https://docs.ensemblework.com/search-index.json`, without forwarding the caller's key. It validates the index and its URL origin, uses the site's shared search code, and caches a successful index for 60 seconds per API process. Queries take 1 to 200 characters of search words and `limit` is 1 to 20, default 8.

The response has `found`, `results` (`title`, `heading`, `url`, `excerpt`), `message` and `home`. Extracts are substrings of published section text. A miss has `found: false`, an empty result list and the docs home, not a guessed procedure. An unavailable or invalid publication returns an explicit 503 error and is not cached as a miss. The MCP client reports that failure as a tool error. [Context Bridge](CONTEXT_BRIDGE.md#5-tools-and-resources) and [CLI §5](26_CLI.md#5-mcp-local-cli-or-hosted-url) describe the connection.
