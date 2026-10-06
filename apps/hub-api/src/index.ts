import { env } from "./config.js";
import { buildApp } from "./app.js";
import { hubCorsPolicy } from "./lib/hub-cors.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startDocumentEnrichment } from "./context/enrich-documents.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { DEFAULT_INTERNAL_TOKEN } from "./bridge/auth.js";
import { assertProductionSafe } from "./lib/production.js";
import { startDeviceRevokeBus, stopDeviceRevokeBus } from "./devices/revoke-notify.js";
import { startAgentQueue } from "./workspace/worker.js";
import { startRemote } from "./remote/loop.js";
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
  const app = await buildApp();
  const desktop = hubCorsPolicy().desktop;
  if (desktop) await ensureDesktopUser();

  const stopScheduler = startScheduler(app);
  const stopEnrichment = startDocumentEnrichment(app);
  const stopQueue = process.env.ENSEMBLE_AGENT_QUEUE === "off" ? async () => {} : startAgentQueue(app);
  const stopRemote = desktop && process.env.ENSEMBLE_REMOTE_LOOP !== "off" ? startRemote(app) : async () => {};
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
