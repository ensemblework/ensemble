import Fastify from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { env } from "./config.js";
import "./types.js";
import { BadPathError, MODULE_DENIED, moduleDenied, normalizePath } from "@ensemble/shared-types";
import { enforceRouteModule } from "./lib/module-gate.js";
import { identify } from "./lib/auth.js";
import { corsPluginOptions } from "./lib/cors-origin.js";
import { hubCorsPolicy } from "./lib/hub-cors.js";
import { consumeRateLimit, rateLimiter, rateLimitConfig } from "./lib/rate-limit.js";
import { redactRequestUrl, redactText } from "./lib/redact.js";
import { authRoutes } from "./routes/auth.js";
import { connectorRoutes } from "./routes/connectors.js";
import { decisionRoutes } from "./routes/decisions.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startDocumentEnrichment } from "./context/enrich-documents.js";

const PUBLIC_PATHS = new Set(["/health", "/health/ready", "/api/auth/status", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/events", "/api/devices/register"]);
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
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
import { DEFAULT_INTERNAL_TOKEN, bridgeMethodRejected, deviceTokenRejected, readOnlyTokenRejected } from "./bridge/auth.js";
import { assertProductionSafe } from "./lib/production.js";
import { deviceRoutes } from "./devices/routes.js";
import { startDeviceRevokeBus, stopDeviceRevokeBus } from "./devices/revoke-notify.js";
import { startAgentQueue } from "./workspace/worker.js";
import { remoteRoutes } from "./remote/routes.js";
import { startRemote } from "./remote/loop.js";
import { desktopHostAllowed } from "./lib/desktop-guard.js";
import { ensureDesktopUser } from "./lib/desktop-user.js";
import { upgradeCodeFolders } from "./lib/code-folders.js";
import { writeDiscoveryFile } from "./lib/desktop-discovery-file.js";
import { startPageSearchBackfill } from "./pages/search-backfill.js";

export type HubServer = {
  port: number;
  close: () => Promise<void>;
};

export async function startHub(): Promise<HubServer> {
  assertProductionSafe(process.env);
  // Open event streams would otherwise hold close() past tsx's restart timeout.
  const app = Fastify({
    logger: {
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

  // Desktop mode and the allowlist are worked out once, here. The plugin and
  // every hijacked response (SSE, streamed replies, terminal) read this one value.
  const policy = hubCorsPolicy();
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
      return;
    }
    if (PUBLIC_PATHS.has(path) || /^\/api\/connectors\/[a-z_]+\/callback$/.test(path)) return;
    return reply.code(401).send({ error: "Sign in to Ensemble first." });
  });

  // The router has already decoded the URL. Check the route pattern too.
  app.addHook("preHandler", enforceRouteModule);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      });
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
  ]) {
    await app.register(routes);
  }

  if (desktop) {
    await ensureDesktopUser();
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

  const stopScheduler = startScheduler(app);
  const stopEnrichment = startDocumentEnrichment(app);
  const stopQueue = startAgentQueue(app);
  const stopRemote = desktop ? startRemote(app) : async () => {};
  const deviceRevokeBus = await startDeviceRevokeBus();
  if (!deviceRevokeBus) {
    app.log.warn("Redis pub/sub is down, so a revoked computer is disconnected only on this API process");
  }

  let stopPageSearchBackfill = () => {};
  let exiting = false;
  const close = async (exit: boolean) => {
    if (exiting) return;
    exiting = true;
    stopPageSearchBackfill();
    stopScheduler();
    stopEnrichment();
    await stopRemote();
    await stopQueue();
    await stopDeviceRevokeBus();
    await app.close();
    await prisma.$disconnect();
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    if (process.env.ENSEMBLE_DESKTOP === "1") {
      // PGlite keeps writes in memory until it is closed; exiting first can lose the last ones.
      const { closeDesktopDatabase } = await import("./lib/pglite-engine.js");
      await closeDesktopDatabase().catch((error: unknown) => app.log.error({ err: error }, "could not close the local database"));
    }
    if (exit) process.exit(0);
  };
  process.on("SIGINT", () => void close(true));
  process.on("SIGTERM", () => void close(true));

  if (env.ENSEMBLE_INTERNAL_TOKEN === DEFAULT_INTERNAL_TOKEN) {
    app.log.warn(
      'ENSEMBLE_INTERNAL_TOKEN is the insecure default "dev-internal-token". Set a private value before anything other than this machine can reach the API. The Context Bridge refuses this default unless ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true.',
    );
  }
  // Before the saved folders list was split, Code read the terminal's folders.
  // Copy them into the Code list once, so Code keeps working. Idempotent; a
  // failure is logged and the Hub still starts (Code then starts with no folders).
  try {
    const upgraded = await upgradeCodeFolders(prisma);
    if (upgraded > 0) app.log.info({ upgraded }, "copied saved folders into the Code folders list");
  } catch (error) {
    app.log.error({ err: error }, "could not copy saved folders into the Code folders list");
  }

  const host = env.HUB_API_HOST;
  if (host === "0.0.0.0" || host === "::" || host === "::0") {
    app.log.warn({ host }, "hub-api is bound to every network interface");
  }
  await app.listen({ host, port: env.HUB_API_PORT });
  // After listen, so /health/ready does not wait. update.sh and the desktop sidecar both reach this.
  stopPageSearchBackfill = startPageSearchBackfill(prisma, app.log).stop;
  const bound = app.server.address();
  const port = bound && typeof bound === "object" ? bound.port : env.HUB_API_PORT;
  const token = process.env.ENSEMBLE_DESKTOP_TOKEN;
  if (desktop && token) {
    const file = writeDiscoveryFile(port, token);
    app.log.info({ port, discovery: file }, "desktop discovery file written");
  }
  app.log.info({ port }, `hub-api listening on ${host}:${port}`);
  return { port, close: () => close(false) };
}

if (process.env.ENSEMBLE_DESKTOP_EMBED !== "1") {
  startHub().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
