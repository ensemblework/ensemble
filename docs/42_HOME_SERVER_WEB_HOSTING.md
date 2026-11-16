# 42 · Hosting the websites on the home server (plan)

**Status: a plan for work not built yet.** This guide is listed in `INTERNAL_GUIDES` (`apps/docs/src/publication.mjs`), so docs.ensemblework.com never publishes it. [AGENTS.md](../AGENTS.md) keeps plans out of `docs/` once merged. Before this lands, rewrite it to describe the running setup, in the same PR as the implementation.

## 1. Goal

Serve every Ensemble website from the home server that already runs the API, Postgres, Redis, the agent runtime, the timers and the observability stack. Vercel is then no longer needed:

- `app.ensemblework.com`: the Hub, a Next.js server.
- `ensemblework.com` and `www.ensemblework.com`: the landing site, a static export.
- `ensemblework.app` and `www.ensemblework.app`: redirect to `ensemblework.com`.
- `test.ensemblework.com`: the testing Hub.

Two outside services remain by design: Azure Blob Storage for people's files, and Azure AI Foundry for models.

These outside services stay too, and this plan does not replace them:

| Service | Used for |
| --- | --- |
| Cloudflare | DNS, the tunnel, edge TLS and cache. The API already uses it. |
| Cloudflare Worker `ensemble-docs` | docs.ensemblework.com ([40 §2](40_PUBLIC_DOCUMENTATION.md#2-build-and-hosting)) |
| GitHub | Code, Actions, and Releases for the CLI and desktop downloads |
| Package registries | Homebrew tap, Scoop, winget, npm, AUR |
| Platform signing | Apple and Microsoft code signing |

## 2. What runs where today

| Host | Runs on | Published by |
| --- | --- | --- |
| `app.ensemblework.com` | Vercel project (`VERCEL_PROJECT_ID_APP`) | `deploy.yml` → "Publish the Hub (Vercel)" (`.github/actions/vercel-deploy`) |
| `ensemblework.com` | Vercel project (`VERCEL_PROJECT_ID_LANDING`). `apps/landing/vercel.json` holds the `ensemblework.app` redirects and the `install.sh`/`install.ps1` headers | `deploy.yml` → "Publish the landing page (Vercel)", then IndexNow |
| `test.ensemblework.com` | Vercel project (`VERCEL_PROJECT_ID_TEST`) | `test-web.yml` → "Publish testing web app"; "Publish matching testing CLI" waits for it |
| `api.ensemblework.com` | Home server: Cloudflare tunnel → hub-api on `127.0.0.1:$HUB_API_PORT` (14000 in the home block of `infra/deploy/ensemble.env.example`; `infra/deploy/home`) | `ensemble-autodeploy.timer` pulls the `production` branch (`update.sh`) |
| `api-test.ensemblework.com` | Home server, testing stack (`infra/deploy/testing`) | `ensemble-test-deploy.timer` (`deploy.mjs`) |
| `docs.ensemblework.com` | Cloudflare Worker `ensemble-docs` | Workers Builds on every push to `main` |
| `node.ensemblework.com` | The separate `ensemblework/ensemble-node` repository | Check its host. A project in the same Vercel account shares the upload limit below |
| CLI and desktop downloads | GitHub Releases (`cli-v*`, `desktop-v*`, `cli-testing-latest`) | `cli-release.yml`, `desktop.yml` |

The three Vercel projects share one account, `VERCEL_TOKEN` and `VERCEL_ORG_ID`. The account is on the free plan, which allows 5,000 file uploads in 24 hours. Past that, every publish to any of the three fails with `api-upload-free`.

Each publish job builds the site on a GitHub runner (`vercel build`) and uploads the output (`vercel deploy --prebuilt`). Uploaded files are JS and CSS chunks, server bundles, prerendered pages and assets; only files whose content Vercel doesn't already hold are sent. Most chunks get new names when the code changes, so one publish sends hundreds of files. Every push to `testing` publishes the test site, and every release publishes two projects.

## 3. Target architecture

```
Browser ─▶ Cloudflare (DNS, TLS, cache, WAF)
             │  outbound tunnel from the home server (no open ports, no fixed IP)
             ▼
          cloudflared ─▶ Caddy 127.0.0.1:8080 (routes by host; static files, compression, cache headers)
                           ├─ app.ensemblework.com   /api/*, /health ─▶ hub-api 127.0.0.1:$HUB_API_PORT (14000)
                           │                         /_next/static/* ─▶ files on disk (last N builds)
                           │                         everything else ─▶ hub-web  127.0.0.1:3000 (next start)
                           ├─ ensemblework.com, www  ─▶ landing files (apps/landing/out of the live release)
                           ├─ ensemblework.app, www  ─▶ 301 to ensemblework.com (/ → /download)
                           └─ test.ensemblework.com  /api/*, /health ─▶ testing hub-api (its HUB_API_PORT, ~/ensemble-test/ensemble.env)
                                                     everything else ─▶ testing hub-web 127.0.0.1:3001
```

- **The tunnel stays the only way in.** Add the web hosts to the tunnel's ingress rules, pointing at Caddy, with `http_status:404` last. Caddy, hub-web and the APIs listen on loopback only.
- **Caddy holds what Vercel held:** host routing, redirects, headers and static files. TLS stays at Cloudflare's edge, so Caddy serves plain HTTP on loopback (`auto_https off` for these sites).
- **`api.ensemblework.com` and `api-test.ensemblework.com` keep their direct tunnel routes.** Moving them behind Caddy is optional and not needed.
- **`/api/*` goes from Caddy straight to hub-api** (`HUB_API_PORT`), with the streaming settings of `infra/deploy/Caddyfile` (`flush_interval -1`, the stream timeouts, no compression). Today Next's `rewrites()` in `apps/hub-web/next.config.ts` would sit in the middle of SSE streams. Keep those rewrites for development.

## 4. Each site

### 4.1 Landing (static)

- **Build:** `pnpm --filter @ensemble/landing build` writes `apps/landing/out` (`output: "export"`). The Open Graph image (`app/opengraph-image.tsx`) is rendered at build time, so nothing runs at request time.
- **Serve:** Caddy `file_server` from the live release's `out`, with `try_files {path} {path}.html {path}/index.html` and `handle_errors` → `404.html`.
- **Port `vercel.json` into the Caddyfile:**
  - the `ensemblework.app` and `www.ensemblework.app` redirects
  - `Content-Type: text/plain; charset=utf-8` and `Cache-Control: public, max-age=300` on `/install.sh` and `/install.ps1`
  - then delete `vercel.json`
- **Cache:**
  - `/_next/static/*` and other hashed files: `public, max-age=31536000, immutable`
  - HTML: `no-cache`, so a release shows at once
  - a Cloudflare cache rule keeps the static files at the edge, so most requests never reach the house
- **IndexNow:** keep it in `deploy.yml`, after the new release check (§5).

### 4.2 Hub (Next.js server)

- **Build on the server.** `update.sh` already runs `pnpm install`. After it, build with `NEXT_DIST_DIR=.next-<commit> NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @ensemble/hub-web build`, under `nice`/`ionice` so the API stays responsive. `next.config.ts` already honours `NEXT_DIST_DIR`, so a build never touches the running version. `NEXT_PUBLIC_*` values are fixed at build time and come from the web env file (§6).
- **Run** as a systemd user unit, `ensemble-web.service`, beside `ensemble-api.service`: `next start --hostname 127.0.0.1 --port 3000`, `NODE_ENV=production`, `NEXT_DIST_DIR` of the live build, `Restart=always`. Middleware runs in the Node server unchanged. The Hub doesn't use `next/image`, so `sharp` isn't needed.
- **Switch:**
  1. Point the unit at the new build and restart it.
  2. Wait for the new commit in `/version.json` (§5).
  3. If it doesn't appear, switch back to the previous build.

  Keep the last three builds. Caddy's `lb_try_duration 10s` holds requests during the seconds of a restart. Two instances (blue/green) are optional, for later.
- **Keep old assets for open tabs.** A tab opened before a release asks for the previous build's chunks. Copy each build's `static/` into one shared folder that Caddy serves at `/_next/static/*`, and prune files older than 7 days. Names are content hashes, so builds never collide. Vercel did this itself (skew protection).
- **Cookies and origins don't change.** The host stays `app.ensemblework.com`, so `ENSEMBLE_COOKIE_DOMAIN`, `HUB_WEB_ORIGIN` and every OAuth redirect URI registered with Google or Microsoft stay valid.

### 4.3 Testing Hub

- **Same as §4.2, with the testing values:**
  - the testing API's `NEXT_PUBLIC_HUB_API`
  - the testing `ENSEMBLE_COOKIE_NAMESPACE`
  - port 3001
  - its own unit, `ensemble-test-web.service`
- **Built by `infra/deploy/testing/deploy.mjs`** when it promotes the testing API, so the test site and the testing API always move together.
- **`test-web.yml`:** replace "Publish testing web app" with a wait for `https://test.ensemblework.com/version.json` to report the commit. "Publish matching testing CLI" then depends on that wait.

### 4.4 Docs (optional)

docs.ensemblework.com is a Cloudflare Worker and is not affected by the Vercel limit; keeping it there is fine. To bring it home as well, serve `apps/docs/out` from Caddy like the landing site, and carry over the headers and redirects the build writes for Cloudflare.

## 5. Publishing stays pull-based

- **Nothing connects in, and GitHub holds no credentials for the server.** This is the model `autodeploy.sh` already follows.
- **Production:**
  - `deploy.yml` keeps "Move production to this commit" and "Wait for the API server".
  - The home server's `update.sh` builds the landing site and the Hub from that same commit and switches them.
  - `deploy.yml` drops the two Vercel jobs. It waits instead until `https://app.ensemblework.com/version.json` and `https://ensemblework.com/version.json` report the commit, then runs IndexNow.
- **Release marker:** both apps write `public/version.json` (`{ "version", "commit" }`) at build time, as hub-api's `/health` reports its own.
- **A failed web build** leaves the running release in place. `update.sh` records it as `autodeploy.sh` records a failed commit (`~/ensemble-host/state`), and the dashboards alert on it.
- **Alternative, for later:** build in GitHub Actions and publish an artifact (a GHCR image or a release asset) that the server pulls by commit. That removes build load from the server but adds artifact plumbing. Start with server builds, which match the API, and move only if build time or memory becomes a problem.

## 6. Configuration

- **Inventory first.** Before changing anything:
  - export every environment variable of the three Vercel projects (`vercel env pull` for each, production values) and their settings (root directory, build command, Node version)
  - list the current DNS records of `ensemblework.com` and `ensemblework.app`
- **Web env files on the server, never in git, mode 0600:**
  - `~/ensemble-host/web.env` holds `NEXT_PUBLIC_HUB_API`, `ENSEMBLE_COOKIE_NAMESPACE` and anything else the Hub reads.
  - The testing stack gets its own file, `~/ensemble-test/web.env`, beside its `ensemble.env`.
  - `NEXT_PUBLIC_*` values are public by design. Server-only values stay out of client code.
- **Caddy:** a web Caddyfile in `infra/deploy/home`. Install it the way `install_caddyfile` (`infra/deploy/lib.sh`) installs the API one, with hosts from env. Caddy runs as a container in `infra/deploy/home/compose.yml` or as the Ubuntu package; either way, loopback only.
- **Tunnel:** add one ingress entry per web host to the tunnel config that `setup.sh` writes, and one `cloudflared tunnel route dns <tunnel> <host>` per host. That command replaces the Vercel record with a CNAME to the tunnel.

## 7. Cutover and rollback

Move one host at a time, lowest risk first:

1. `test.ensemblework.com`, then watch it for a few days.
2. `ensemblework.com`, `www`, and the `ensemblework.app` names.
3. `app.ensemblework.com`.

For each host:

- Compare `curl -sI` and a page load before and after: status codes, `Content-Type`, `Cache-Control`, security headers, redirects and cookies.
- Then check on an emulated phone (touch) and a desktop browser: sign-in, a chat with live streaming, a board, a file upload, and a plot (Pyodide through `/pyodide/*`).

**Rollback:** point the host's DNS record back at its Vercel project. Leave the Vercel projects untouched until two quiet weeks after the last cutover, then delete them. Once nothing reads them, also remove `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID_*` from the repository secrets.

## 8. What Vercel did that the server must do now

| Vercel | Home server |
| --- | --- |
| TLS certificates | Cloudflare's edge, through the tunnel |
| Global CDN | Cloudflare cache rules for `/_next/static/*` and landing assets |
| Old chunks for open tabs | Shared `static/` folder holding the last builds (§4.2) |
| Instant rollback | Previous builds kept; switch back and restart |
| Build-time environment | `web.env` files on the server |
| `vercel.json` redirects and headers | The web Caddyfile |
| DDoS absorption | Cloudflare proxy, WAF managed rules, a rate limit on sign-in routes |
| Uptime | An outside uptime check, plus `watchdog.sh` extended to the web units |

## 9. Operations and security

- **Access:**
  - The only ingress is the tunnel: no router port forwarding, and nothing listening beyond loopback.
  - Services run as the machine's user (systemd user units, lingering already on), never root.
- **Watching:**
  - Prometheus blackbox probes on the web hosts.
  - Caddy's metrics on loopback.
  - Unit state and journald logs, with Grafana panels and alerts in `infra/deploy/home/observability`.
  - An uptime check from outside the house, so a power or internet cut is noticed.
- **Capacity:**
  - Each `next start` uses about 150–300 MB of memory. A Hub build needs 2–4 GB and a few minutes of CPU, one build at a time; `autodeploy.sh` already runs updates one after another.
  - Prune old builds, Next caches and the pnpm store, and alert on free disk space.
- **Machine:** unattended security upgrades, a UPS, and a reboot test: after a reboot, every unit and container must come back with no manual step.
- **Backups:** web builds come from git. Only the env files and the Caddy and tunnel configuration need backing up, next to the existing Postgres backups.

## 10. Repository changes

- `infra/deploy/home`:
  - the web Caddyfile
  - tunnel ingress entries in `setup.sh`
  - units `ensemble-web.service` and `ensemble-test-web.service`
  - build, switch and prune in `update.sh`
  - web units in `watchdog.sh`
  - Caddy in `compose.yml` or `setup.sh`
- `infra/deploy/testing/deploy.mjs`: build and switch the test site.
- `apps/hub-web`, `apps/landing`: write `public/version.json` at build time.
- `.github/workflows/deploy.yml` and `test-web.yml`: replace the Vercel jobs with release checks. Then delete `.github/actions/vercel-deploy` and `apps/landing/vercel.json`.
- Docs:
  - `README.md` (CI and deploys)
  - [01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)
  - [36](36_WEB_TESTING.md)
  - the "The website stays on Vercel" comments in `infra/deploy` (`Caddyfile`, `home/setup.sh`)
  - this guide, rewritten to describe the result

## 11. Phases

| Phase | Work | Done when |
| --- | --- | --- |
| 0 | Inventory: Vercel env and settings, DNS, response headers | Every value is in `web.env`, and the current headers are saved |
| 1 | Server side behind `ENSEMBLE_WEB_HOSTING=on` in the env file: Caddy, units, `update.sh`, `version.json` | All three sites run on the server under a temporary host |
| 2 | `test.ensemblework.com` cutover and `test-web.yml` | A push to `testing` updates the test site without Vercel |
| 3 | Landing cutover | `ensemblework.com` and the redirects are served at home; IndexNow still runs |
| 4 | Hub cutover and `deploy.yml` | A release updates the API and both sites; open tabs keep working |
| 5 | Clean-up | Vercel jobs, action, secrets and projects are gone; docs describe the result |

## 12. Open decisions

- Build on the server (recommended first) or in CI with pulled artifacts.
- One Hub instance with a short restart (recommended first) or blue/green.
- Keep docs on Cloudflare Workers or serve them from home.
- Where `node.ensemblework.com` lives, and whether it moves too.
- A fallback copy of the landing site elsewhere (for example a Cloudflare Worker, like the docs) for when the house is offline.
