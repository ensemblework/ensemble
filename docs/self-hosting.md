# Self-hosting the Hub

The Hub (`apps/hub-web`) can run on the same home server as hub-api, Postgres and Redis. Public traffic reaches it through the existing Cloudflare Tunnel. Admin SSH uses Tailscale. `deploy.yml` still publishes the Hub and the landing page on Vercel. Nothing in this guide turns that off.

`SELF_HOST_WEB_ENABLED` and `HUB_WEB_TUNNEL` both stay unset until the cutover checklist below.

## 1. Which apps are Next.js

| App | What it is | Where it is published today |
| --- | --- | --- |
| `apps/hub-web` | Next.js 15 server: middleware, rewrites, server renders. Dev and `next start` use port 3000 | Vercel project `VERCEL_PROJECT_ID_APP`, job `app` in `.github/workflows/deploy.yml` |
| `apps/landing` | Next.js 15 static export (`output: "export"` to `apps/landing/out`). No server | Vercel project `VERCEL_PROJECT_ID_LANDING`, job `landing`. `apps/landing/vercel.json` is the only `vercel.json` |
| `apps/docs` | Not Next.js. `apps/docs/scripts/build.mjs` writes `apps/docs/out` | Cloudflare Worker `ensemble-docs` ([40](40_PUBLIC_DOCUMENTATION.md)) |

`apps/hub-api` is Fastify. `apps/agent-runtime` is Python. The CLI, desktop app, quick capture and Context Bridge are not Next.js apps. The Ensemble Node website is the separate `ensemblework/ensemble-node` repository and stays on Vercel.

`.vercelignore` exists so the Vercel CLI does not upload `.env`. Leave it in place. `deploy.yml` and `.github/actions/vercel-deploy` are unchanged.

## 2. Vercel-specific behaviour

| Found | Where | On the home server |
| --- | --- | --- |
| No `@vercel/analytics`, `@vercel/speed-insights`, `@vercel/blob`, `@vercel/kv`, `@vercel/postgres`, `@vercel/og`, `@vercel/edge-config` or `@vercel/functions` | No import in the repo | Nothing to replace |
| `vercel.json` redirects for `ensemblework.app` and `www.ensemblework.app`, and `Content-Type` / `Cache-Control` on `/install.sh` and `/install.ps1` | `apps/landing/vercel.json` | The landing page stays on Vercel. Those rules are not Hub routes. A later static host would repeat them in its own config. There is no cron key |
| No Vercel cron | `vercel.json` has no `crons` | No crontab or systemd timer is added for the Hub. Scheduled work already runs inside hub-api (`ENSEMBLE_SCHEDULER=on`) on this machine |
| Middleware | `apps/hub-web/middleware.ts` | Runs inside the standalone Node server. It uses cookies and `fetch`. It does not call a Vercel geo, edge-config or KV API |
| No route sets `runtime = "edge"` or `maxDuration` | `apps/hub-web` | No serverless time limit to recreate |
| Rewrite proxy timeout of 310 seconds | `experimental.proxyTimeout` in `apps/hub-web/next.config.ts` | Still applies to the Node server's `/api` rewrite |
| No `revalidate`, no on-demand revalidation, no custom cache handler. `app/manifest.ts` and `app/robots.ts` are `force-static` | `apps/hub-web` | Redis is not wired up as a Next cache. Pages are rendered by the Node process. Redis on this machine stays the API's cache and queue |
| `next/image` is not imported. The landing site and the desktop export set `images.unoptimized` | `apps/hub-web`, `apps/landing` | `sharp` is not installed for the Hub. The image optimizer is unused. Add `sharp` to `apps/hub-web` before a page starts using `next/image` |
| The app does not read `VERCEL_URL`, `VERCEL_ENV` or any other `VERCEL_*` variable | Hub source | Those names exist only in `deploy.yml`, `test-web.yml` and the Vercel action. Leave them so Vercel deploys keep working |
| Live events go straight to `NEXT_PUBLIC_HUB_API` | `apps/hub-web/components/live.tsx`, `lib/events.ts` | Unchanged. The browser opens the public API so a rewritten stream is not required. That also keeps one connection per tab off the Hub's host |
| hub-api counts a request as `via="vercel"` when any `x-vercel-*` header is present | `apps/hub-api/src/analytics/prometheus.ts` | After cutover, Hub-proxied calls no longer carry those headers, so they count as `direct`. The Grafana panel that sums `via="vercel"` drops. That is the metric working, not a failure |
| A queued plot export gives up after 110 seconds | `apps/hub-api/src/runtime/plot-run.ts` | Left as-is. Raising it would change the API's reply, including for clients that are still on Vercel |

`output: "standalone"` in `apps/hub-web/next.config.ts` writes `.next/standalone` for the image. The desktop export (`ENSEMBLE_DESKTOP_EXPORT=1`) still uses `output: "export"`. Vercel's builder ignores the standalone folder and publishes the site the way it does today.

`/health` on the Hub is still a rewrite to hub-api. `/healthz` is answered by this Next process (`apps/hub-web/app/healthz/route.ts`) and is what the container healthcheck calls.

## 3. Environment

`.env.example` is local development. `infra/deploy/ensemble.env.example` is the server file, copied to `~/ensemble-host/ensemble.env`. The Hub process does not open Postgres or Redis.

Values the Hub image needs:

| Variable | When it is read | Home server |
| --- | --- | --- |
| `NEXT_PUBLIC_HUB_API` | `next build`. Baked into the browser for SSE and OAuth links | The public API origin, `https://api.ensemblework.com`. It does not become localhost: the browser cannot reach the server's loopback |
| `NEXT_PUBLIC_SITE_URL` | `next build`, for Open Graph and Twitter URLs | The public Hub origin, `https://app.ensemblework.com` |
| `ENSEMBLE_COOKIE_DOMAIN` | Build (middleware) and process start (server renders) | Same parent as the API, `ensemblework.com`. Must match hub-api |
| `ENSEMBLE_COOKIE_NAMESPACE` | Same | Unset in production. Set only when the API sets it (testing uses `testing`) |
| `HUB_API_INTERNAL_URL` | Build (rewrites and middleware) and process start (server renders) | `http://127.0.0.1:14000` when hub-api listens on `HUB_API_PORT`. Unset on Vercel, so those builds keep proxying to `NEXT_PUBLIC_HUB_API` |
| `PORT` | Process start | `3000`, or `HUB_WEB_PORT` if `pnpm dev` is also using 3000 on this machine |
| `ENSEMBLE_TRUST_HOST` | `next build`, self-hosted only | Set to `1` for the image and for a non-Docker build. It turns on `skipMiddlewareUrlNormalize`. Vercel builds leave it unset |
| `ENSEMBLE_PUBLIC_HOST` | Process start, self-hosted only | Set to `1`. The process listens on every interface, and a login redirect is a path on the requesting host (`/login`) instead of `https://localhost:3000`. Nothing forwards that port; the tunnel dials `127.0.0.1` |

`DATABASE_URL` and `REDIS_URL` are hub-api settings. On this server they are already loopback, and the ports differ from `pnpm dev`:

| Variable | Local `.env.example` | Home server |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble` | `postgresql://ensemble:ensemble@127.0.0.1:15432/ensemble` |
| `REDIS_URL` | `redis://127.0.0.1:6379` | `redis://:PASSWORD@127.0.0.1:16379` |
| `HUB_API_PORT` | `4000` | `14000` |
| `AGENT_RUNTIME_URL` | `http://127.0.0.1:5055` | `http://127.0.0.1:15055` |

Moving the Hub does not change those four. The container uses host networking so a future server-side call to `127.0.0.1` reaches the host's Postgres, Redis and API. The web container is not given `DATABASE_URL` or `REDIS_URL`.

`HUB_WEB_ORIGIN` on the API stays the public Hub origin. CORS compares it exactly, with no trailing slash.

## 4. Image

From the repository root, with the public values set:

```bash
docker build -f apps/hub-web/Dockerfile \
  --build-arg NEXT_PUBLIC_HUB_API=https://api.ensemblework.com \
  --build-arg NEXT_PUBLIC_SITE_URL=https://app.ensemblework.com \
  --build-arg ENSEMBLE_COOKIE_DOMAIN=ensemblework.com \
  --build-arg HUB_API_INTERNAL_URL=http://127.0.0.1:14000 \
  -t ensemble-hub-web .
```

The Dockerfile is multi-stage: `turbo prune @ensemble/hub-web --docker` (turbo 2.11.11), then `pnpm install --frozen-lockfile` in the pruned workspace, then `pnpm --filter @ensemble/hub-web build` with `ENSEMBLE_TRUST_HOST=1`. After the build, `infra/deploy/home/web/trust-host.mjs` sets the standalone server's `trustHostHeader` flag, which Next's config schema rejects, and makes `ENSEMBLE_PUBLIC_HOST=1` listen on every interface so a redirect uses the tunnel's `Host` header instead of `https://localhost:3000`. The runner is `node apps/hub-web/server.js`, including `.next/static` and `public`. The build needs outbound HTTPS to download fonts, the same fetch the Vercel build does.

`outputFileTracingRoot` is the repository root so the standalone trace includes the workspace packages.

### Compose

`infra/deploy/home/web-compose.yml` is separate from `infra/deploy/home/compose.yml`. The watchdog's `docker compose up` does not start the Hub, and an image that is not pulled yet does not block Postgres or the API.

```bash
export HUB_WEB_IMAGE=ensemble-hub-web:live
export HUB_WEB_PORT=3000
export ENSEMBLE_COOKIE_DOMAIN=ensemblework.com
docker compose -f infra/deploy/home/web-compose.yml up -d
curl -fsS http://127.0.0.1:3000/healthz
```

Host networking means there is no `ports:` mapping. `PORT` is the port on the host.

### Restart, rollback, logs

`infra/deploy/home/web/rollout.sh` pulls an image, starts it on `HUB_WEB_CANARY_PORT` (default 3001), and waits for `/healthz`. The container already on `HUB_WEB_PORT` keeps serving during that wait. It then stops the old container and starts the new one on `HUB_WEB_PORT`. That swap is a short gap, long enough to bind the port. If the new process fails `/healthz`, the script tags `ensemble-hub-web:previous` back to `ensemble-hub-web:live` and starts that.

```bash
bash infra/deploy/home/web/rollout.sh ghcr.io/OWNER/REPO/hub-web:SHA
bash infra/deploy/home/web/rollout.sh --rollback
docker logs ensemble-hub-web
tail -f ~/ensemble-host/logs/web-deploy.log
```

`docker compose up -d` on the web compose file also replaces the container, with the same short gap and without the canary.

### Without Docker

On the server, from a checkout, with the same build variables exported:

```bash
pnpm install --frozen-lockfile
ENSEMBLE_TRUST_HOST=1 pnpm --filter @ensemble/hub-web build
rm -rf ~/ensemble-host/hub-web
mkdir -p ~/ensemble-host/hub-web
cp -a apps/hub-web/.next/standalone/. ~/ensemble-host/hub-web/
mkdir -p ~/ensemble-host/hub-web/apps/hub-web/.next
cp -a apps/hub-web/.next/static ~/ensemble-host/hub-web/apps/hub-web/.next/static
cp -a apps/hub-web/public ~/ensemble-host/hub-web/apps/hub-web/public
node infra/deploy/home/web/trust-host.mjs ~/ensemble-host/hub-web/apps/hub-web/server.js
```

systemd user unit (`~/.config/systemd/user/ensemble-web.service`). `setup.sh` does not install this file; it only installs the units in `infra/deploy/home/systemd/`.

```ini
[Unit]
Description=Ensemble Hub (home server)
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h/ensemble-host/hub-web
Environment=NODE_ENV=production
Environment=ENSEMBLE_PUBLIC_HOST=1
Environment=PORT=3000
Environment=NEXT_PUBLIC_HUB_API=https://api.ensemblework.com
Environment=HUB_API_INTERNAL_URL=http://127.0.0.1:14000
Environment=ENSEMBLE_COOKIE_DOMAIN=ensemblework.com
ExecStart=%h/ensemble-host/node/bin/node apps/hub-web/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

`NEXT_PUBLIC_*` and `HUB_API_INTERNAL_URL` are fixed at `next build`. Repeating them in the unit keeps server renders on the same origins. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ensemble-web.service
journalctl --user -u ensemble-web -n 100 --no-pager
```

pm2, from `~/ensemble-host/hub-web`, with `ENSEMBLE_PUBLIC_HOST=1` and the same cookie variables exported:

```bash
pm2 start apps/hub-web/server.js --name ensemble-hub-web
pm2 logs ensemble-hub-web
```

A zero-downtime-ish restart without the Docker canary is: build into a second directory, start it on port 3001, confirm `/healthz`, stop the old process, start the new directory on port 3000.

## 5. Cloudflare Tunnel

The API tunnel is `infra/deploy/home/compose.yml` service `cloudflared`, host networking, config `~/ensemble-host/cloudflared/config.yml`. `setup.sh` rewrites that file. With `HUB_WEB_TUNNEL` unset the rewrite is the API-only file it writes today. With `HUB_WEB_TUNNEL=on` it adds `HUB_WEB_ORIGIN`'s host on `HUB_WEB_PORT`.

Example once both hosts are on the tunnel. The API port is the home-server `HUB_API_PORT`:

```yaml
tunnel: TUNNEL_ID
credentials-file: /etc/cloudflared/TUNNEL_ID.json
ingress:
  - hostname: api.ensemblework.com
    service: http://127.0.0.1:14000
  - hostname: app.ensemblework.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Apply a hand edit with `docker restart ensemble-home-cloudflared`. A later `setup.sh` overwrites the file from the env switches, so set `HUB_WEB_TUNNEL=on` before that rerun if the Hub host should stay.

No router port is opened. The tunnel dials out. Tailscale is the admin path, not the public path.

## 6. GitHub Actions

`.github/workflows/self-host-web.yml` runs on a push to `main` that changes the Hub (and the packages it is built from), and from Actions, self-host-web, Run workflow. The deploy job runs only when the repository variable `SELF_HOST_WEB_ENABLED` is `true`. Until then the run is skipped.

The job builds `apps/hub-web/Dockerfile`, pushes `ghcr.io/<owner>/<repo>/hub-web:<git sha>` and `:current`, joins the tailnet with `tailscale/github-action@v4`, and SSH-es the image reference to `infra/deploy/home/web/rollout.sh`.

### Repository variable

| Name | Value |
| --- | --- |
| `SELF_HOST_WEB_ENABLED` | `true` when the secrets below exist and a push should deploy. Leave it unset until then |

### Repository secrets

| Secret | Value |
| --- | --- |
| `NEXT_PUBLIC_HUB_API` | Public API origin, no trailing slash |
| `NEXT_PUBLIC_SITE_URL` | Public Hub origin, no trailing slash |
| `ENSEMBLE_COOKIE_DOMAIN` | Parent domain shared with hub-api |
| `ENSEMBLE_COOKIE_NAMESPACE` | Optional. Empty in production |
| `HUB_API_INTERNAL_URL` | Optional. `http://127.0.0.1:14000` on this server. Empty proxies `/api` to the public API origin |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client id. The client needs the `auth_keys` scope and the tag `tag:ci` |
| `TS_OAUTH_SECRET` | That client's secret |
| `SELF_HOST_TAILSCALE_HOST` | MagicDNS name of the server |
| `SELF_HOST_SSH_USER` | Linux user that owns `~/ensemble-host` and can run Docker |
| `SELF_HOST_SSH_PRIVATE_KEY` | Unencrypted private key whose public key is in that user's `authorized_keys` |

`GITHUB_TOKEN` pushes the image. No extra token is stored in GitHub for the registry.

### On the server

| File or line | Purpose |
| --- | --- |
| `~/ensemble-host/ghcr.token` | GitHub personal access token with `read:packages`, mode `0600`. Not in `ensemble.env`, because hub-api loads that file |
| `GHCR_USERNAME` in `~/ensemble-host/ensemble.env` | Account that owns the token |
| `ENSEMBLE_COOKIE_DOMAIN` in that same file | Must match the secret baked into the image |
| sshd | Listening, reachable on the Tailscale address. The firewall allows port 22 on the tailnet interface and not from the public internet |

Tailscale ACL, so the CI tag can SSH to the server and nothing else:

```json
{
  "tagOwners": { "tag:ci": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["tcp:22"] }
  ]
}
```

Tag the server `tag:server`. The OAuth client is allowed to create `tag:ci` nodes. The action's nodes are ephemeral.

Make the GHCR package private. The first push creates `ghcr.io/<owner>/<repo>/hub-web`.

## 7. Cutover

Keep Vercel publishing until the tunnel has served real traffic for a week.

1. Build or let the workflow push an image with the production `NEXT_PUBLIC_*` values and `HUB_API_INTERNAL_URL=http://127.0.0.1:14000`.
2. On the server, `curl -fsS http://127.0.0.1:3000/healthz` returns `{"ok":true,"service":"hub-web"}`. Sign in through an SSH tunnel or `tailscale serve` and confirm a page, an `/api` call and the live stream. The stream still opens `NEXT_PUBLIC_HUB_API`.
3. Set `HUB_WEB_TUNNEL=on` and `HUB_WEB_PORT=3000` in `~/ensemble-host/ensemble.env`. Rerun `bash infra/deploy/home/setup.sh`, or write the ingress in §5 and `docker restart ensemble-home-cloudflared`.
4. In Cloudflare, point `app.ensemblework.com` at this tunnel (the same CNAME form the API host already uses). Leave the Vercel project and its DNS record recoverable.
5. Watch `docker logs ensemble-hub-web`, `~/ensemble-host/logs/web-deploy.log`, and hub-api's log. Requests that used to arrive with `x-vercel-*` now count as `direct`.
6. For a week, Vercel remains a fallback: put the previous DNS target back, or turn `HUB_WEB_TUNNEL` off and restart `ensemble-home-cloudflared`. `deploy.yml` is still publishing that fallback.
7. Roll back a bad image with `bash infra/deploy/home/web/rollout.sh --rollback` without moving DNS.

After that week, `SELF_HOST_WEB_ENABLED` can stay `true` so later Hub commits deploy here. Removing the Vercel project, `vercel.json` or `.vercelignore` is a separate change. This one does not do it.

## 8. What still uses Vercel

The Hub's code does not require Vercel. These publishes are separate and stay where they are:

| Publish | Why it is still on Vercel |
| --- | --- |
| This Hub, until the DNS step above | `deploy.yml` is unchanged on purpose |
| Landing page, `ensemblework.com` | Static export plus `apps/landing/vercel.json` |
| Testing Hub, `test.ensemblework.com` | `.github/workflows/test-web.yml` |
| Ensemble Node website | Other repository |

Nothing in the Hub needs Vercel KV, Blob, Postgres, cron or edge config. File originals stay in Postgres or Azure Blob via hub-api ([32](32_FILES.md)).
