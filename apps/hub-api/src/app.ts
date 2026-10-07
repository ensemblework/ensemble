import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions, type RouteOptions } from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { BadPathError, MODULE_DENIED, moduleDenied, normalizePath } from "@ensemble/shared-types";
import { env } from "./config.js";
import "./types.js";
import { enforceRouteModule } from "./lib/module-gate.js";
import { identify } from "./lib/auth.js";
import { enforceHostedRequest, requireVerifiedUser } from "./lib/hosted-access.js";
import { isPublicAuthPath } from "./lib/auth-public.js";
import { corsPluginOptions, type CorsPolicy } from "./lib/cors-origin.js";
import { hubCorsPolicy } from "./lib/hub-cors.js";
import { consumeRateLimit, rateLimiter, rateLimitConfig } from "./lib/rate-limit.js";
import { redactRequestUrl, redactText } from "./lib/redact.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { authRoutes } from "./routes/auth.js";
import { authOAuthRoutes } from "./routes/auth-oauth.js";
import { ensureLocalPlaceholder } from "./lib/local-placeholder.js";
import { connectorRoutes } from "./routes/connectors.js";
import { decisionRoutes } from "./routes/decisions.js";
import { taskRoutes } from "./routes/tasks.js";
import { pageRoutes } from "./routes/pages.js";
import { miscRoutes } from "./routes/misc.js";
import { assistantRoutes } from "./routes/assistant.js";
import { internalRoutes } from "./routes/internal.js";
import { settingsRoutes } from "./routes/settings.js";
import { contextRoutes } from "./routes/context.js";
import { boardRoutes } from "./routes/board.js";
import { skillRoutes } from "./routes/skills.js";
import { runRoutes } from "./routes/runs.js";
import { systemRoutes } from "./routes/system.js";
import { codeRoutes } from "./routes/code.js";
import { agentRoutes } from "./routes/agents.js";
import { terminalRoutes } from "./routes/terminal.js";
import { viewRoutes } from "./routes/views.js";
import { commentRoutes } from "./routes/comments.js";
import { completedRoutes } from "./routes/completed.js";
import { ensembleRoutes } from "./routes/ensemble.js";
import { bridgeRoutes } from "./bridge/routes.js";
import { connectRoutes } from "./routes/connect.js";
import { coworkRoutes } from "./routes/cowork.js";
import { themeRoutes } from "./routes/themes.js";
import { diagramRoutes } from "./routes/diagrams.js";
import { plotRoutes } from "./routes/plots.js";
import { layoutsRoutes } from "./routes/layouts.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { widgetRoutes } from "./routes/widgets.js";
import { deskRoutes } from "./routes/desk.js";
import { cliAuthRoutes } from "./routes/cli-auth.js";
import { mcpRoutes } from "./routes/mcp.js";
import { mcpConnectionRoutes } from "./routes/mcp-connections.js";
import { importRoutes } from "./routes/imports.js";
import { peopleIdentityRoutes } from "./routes/people-identity.js";
import { projectLinkRoutes } from "./routes/project-links.js";
import { meetingNoteRoutes } from "./routes/meeting-notes.js";
import { bridgeMethodRejected, deviceTokenRejected, readOnlyTokenRejected } from "./bridge/auth.js";
import { deviceRoutes } from "./devices/routes.js";
import { remoteRoutes } from "./remote/routes.js";
import { desktopHostAllowed } from "./lib/desktop-guard.js";

const PUBLIC_PATHS = new Set(["/health", "/health/ready", "/api/events", "/api/devices/register"]);
const ADDITIONAL_MODEL_STREAM_ROUTES = new Set(["/api/pages/:kind/:id/ensemble", "/api/ensemble/invoke"]);

export function bypassesGlobalAuth(path: string): boolean {
  return PUBLIC_PATHS.has(path) || isPublicAuthPath(path) || /^\/api\/connectors\/[a-z_]+\/callback$/.test(path);
}

export type BuildAppOptions = {
  logger?: FastifyServerOptions["logger"];
  onRoute?: (route: RouteOptions) => void;
  onResponse?: (request: FastifyRequest, reply: FastifyReply) => void;
  corsPolicy?: CorsPolicy;
  authOAuth?: Parameters<typeof authOAuthRoutes>[1];
};

/** Registers the production HTTP stack without starting any process-lifetime services. */
export async function buildApp(options: BuildAppOptions = {}) {
  if (env.ENSEMBLE_DEV_AUTH_BYPASS) await ensureLocalPlaceholder(prisma, env.ENSEMBLE_DEV_USER_ID);
  const app = Fastify({
    logger: options.logger ?? {
      level: env.ENSEMBLE_LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-ensemble-internal']", "req.headers.x-ensemble-internal"],
        censor: "[redacted]",
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactRequestUrl(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    bodyLimit: 4 * 1024 * 1024,
    forceCloseConnections: true,
  });
  app.decorate("prisma", prisma);
  app.decorate("redis", redis);
  if (options.onRoute) app.addHook("onRoute", options.onRoute);
  const onResponse = options.onResponse;
  if (onResponse) app.addHook("onResponse", async (request, reply) => onResponse(request, reply));

  const policy = options.corsPolicy ?? hubCorsPolicy();
  const desktop = policy.desktop;
  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(cors, corsPluginOptions(policy));

  app.addHook("onRequest", async (request, reply) => {
    if (desktop && !desktopHostAllowed(request.headers.host)) {
      return reply.code(403).send({ error: "This local API only answers on loopback." });
    }
    if (request.method === "OPTIONS") return;
    let path: string;
    try {
      path = normalizePath(request.url);
    } catch (error) {
      if (error instanceof BadPathError) return reply.code(400).send({ error: "Malformed path." });
      throw error;
    }
    if (bridgeMethodRejected(request.method, path)) {
      return reply.code(405).send({ error: "The Context Bridge is read-only." });
    }
    const who = await identify(request);
    if (who) {
      request.userId = who.userId;
      request.tokenId = who.tokenId;
    }
    const limited = consumeRateLimit(rateLimiter, request, path, rateLimitConfig());
    if (limited) {
      reply.header("Retry-After", String(limited.retryAfterSeconds));
      return reply.code(429).send({ error: limited.error });
    }
    if (who) {
      request.userId = who.userId;
      request.authVia = who.via;
      request.tokenScope = who.tokenScope;
      request.tokenId = who.tokenId;
      request.modules = who.modules;
      const denied = readOnlyTokenRejected(who.tokenScope, request.method, path) ?? deviceTokenRejected(who.tokenScope, request.method, path);
      if (denied) return reply.code(403).send({ error: denied });
      if (moduleDenied(path, who.modules)) return reply.code(404).send({ error: MODULE_DENIED });
      await enforceHostedRequest(request, path);
      return;
    }
    if (bypassesGlobalAuth(path)) return;
    if (path === "/mcp" && request.method === "POST") {
      reply.header("WWW-Authenticate", 'Bearer realm="Ensemble"');
      return reply.code(401).send({ error: "Bearer token required." });
    }
    return reply.code(401).send({ error: "Sign in to Ensemble first." });
  });

  app.addHook("preHandler", enforceRouteModule);
  app.addHook("preHandler", async (request) => {
    if (request.method === "POST" && ADDITIONAL_MODEL_STREAM_ROUTES.has(request.routeOptions.url ?? "")) {
      await requireVerifiedUser(request.userId);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return reply.code(404).send({ error: "That item is no longer available." });
      if (error.code === "P2002") return reply.code(409).send({ error: "That item already exists." });
      if (error.code === "P2003") return reply.code(400).send({ error: "A referenced account or item is no longer available." });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = redactText(error instanceof Error ? error.message : String(error));
    if (statusCode >= 500) {
      const safe = error instanceof Error ? error : new Error(message);
      safe.message = message;
      if (safe.stack) safe.stack = redactText(safe.stack);
      request.log.error({ err: safe }, "request failed");
    }
    const expose = statusCode < 500 || (error as { expose?: boolean }).expose === true;
    const code = (error as { code?: string }).code;
    return reply.code(statusCode).send({ error: expose ? message : "Something went wrong on the Hub.", ...(code ? { code } : {}) });
  });

  for (const routes of [
    authRoutes,
    authOAuthRoutes,
    connectorRoutes,
    decisionRoutes,
    miscRoutes,
    taskRoutes,
    pageRoutes,
    boardRoutes,
    assistantRoutes,
    internalRoutes,
    settingsRoutes,
    contextRoutes,
    skillRoutes,
    runRoutes,
    systemRoutes,
    codeRoutes,
    agentRoutes,
    deviceRoutes,
    terminalRoutes,
    viewRoutes,
    commentRoutes,
    completedRoutes,
    ensembleRoutes,
    bridgeRoutes,
    connectRoutes,
    coworkRoutes,
    themeRoutes,
    diagramRoutes,
    plotRoutes,
    layoutsRoutes,
    marketplaceRoutes,
    widgetRoutes,
    deskRoutes,
    cliAuthRoutes,
    mcpRoutes,
    mcpConnectionRoutes,
    importRoutes,
    peopleIdentityRoutes,
    projectLinkRoutes,
    meetingNoteRoutes,
  ]) {
    if (routes === authOAuthRoutes) await app.register(authOAuthRoutes, options.authOAuth ?? {});
    else await app.register(routes);
  }

  if (desktop) {
    await app.register(remoteRoutes);
    app.get("/api/desktop/status", async () => {
      const runningJobs = await prisma.workspaceJob
        .count({ where: { status: { in: ["queued", "running", "stopping", "waiting_approval"] } } })
        .catch(() => 0);
      const migrations = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name
      `.catch(() => []);
      return {
        ok: true,
        runningJobs,
        migrations: migrations.map((row) => row.migration_name),
        version: process.env.ENSEMBLE_APP_VERSION ?? "0.1.0",
      };
    });
  }
  return app;
}
