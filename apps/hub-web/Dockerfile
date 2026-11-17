# Production image for the Hub (apps/hub-web).
# Build from the repository root:
#   docker build -f apps/hub-web/Dockerfile \
#     --build-arg NEXT_PUBLIC_HUB_API=https://api.example.com \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://app.example.com \
#     --build-arg ENSEMBLE_COOKIE_DOMAIN=example.com \
#     --build-arg HUB_API_INTERNAL_URL=http://127.0.0.1:14000 \
#     -t ensemble-hub-web .
# Vercel does not use this file. deploy.yml still publishes with the Vercel builder.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

FROM base AS prepare
WORKDIR /app
RUN npm install -g turbo@2.11.11
COPY . .
RUN turbo prune @ensemble/hub-web --docker

FROM base AS builder
WORKDIR /app
COPY .npmrc .npmrc
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prepare /app/out/full/ .
# prebuild walks release.json and a few files outside the pruned workspace.
COPY release.json ./release.json
COPY tsconfig.base.json ./tsconfig.base.json
COPY scripts/release-version.mjs ./scripts/release-version.mjs
COPY apps/desktop/src-tauri/Cargo.toml ./apps/desktop/src-tauri/Cargo.toml
COPY apps/quick-capture/src-tauri/Cargo.toml ./apps/quick-capture/src-tauri/Cargo.toml
COPY apps/agent-runtime/ensemble_agent/version.py ./apps/agent-runtime/ensemble_agent/version.py
COPY infra/deploy/home/web/trust-host.mjs ./infra/deploy/home/web/trust-host.mjs
ARG NEXT_PUBLIC_HUB_API
ARG NEXT_PUBLIC_SITE_URL
ARG ENSEMBLE_COOKIE_DOMAIN
ARG ENSEMBLE_COOKIE_NAMESPACE
ARG HUB_API_INTERNAL_URL
ENV NEXT_PUBLIC_HUB_API=$NEXT_PUBLIC_HUB_API \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    ENSEMBLE_COOKIE_DOMAIN=$ENSEMBLE_COOKIE_DOMAIN \
    ENSEMBLE_COOKIE_NAMESPACE=$ENSEMBLE_COOKIE_NAMESPACE \
    HUB_API_INTERNAL_URL=$HUB_API_INTERNAL_URL \
    ENSEMBLE_TRUST_HOST=1
RUN pnpm --filter @ensemble/hub-web build \
  && node infra/deploy/home/web/trust-host.mjs apps/hub-web/.next/standalone/apps/hub-web/server.js

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    ENSEMBLE_PUBLIC_HOST=1 \
    PORT=3000
ARG ENSEMBLE_COOKIE_DOMAIN
ARG ENSEMBLE_COOKIE_NAMESPACE
ENV ENSEMBLE_COOKIE_DOMAIN=$ENSEMBLE_COOKIE_DOMAIN \
    ENSEMBLE_COOKIE_NAMESPACE=$ENSEMBLE_COOKIE_NAMESPACE
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/hub-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/hub-web/.next/static ./apps/hub-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/hub-web/public ./apps/hub-web/public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/hub-web/server.js"]
