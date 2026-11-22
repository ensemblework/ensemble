/**
 * The owner's computer during an eval run: a second process with its own database, the way the desktop
 * app runs beside the hosted web. It pairs with the eval's API, then its real remote loop, agent queue and
 * capture runtime answer device tools and run coding sessions on this machine. Its own database matters:
 * a file the computer keeps and the web's copy of it share an id, so one database for both would refuse
 * every shared file. The run talks to it over IPC (computer.ts).
 *
 * The database is in memory, or on disk in the computer's folder when the run may restart the computer
 * (`NODE_EVAL_COMPUTER_DB=disk`): a restarted computer then has what it had, as a real one does, and its
 * device token opens with the run's key (`NODE_EVAL_COMPUTER_KEY`).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { agentScreenRoom, hermetic, LIVE_JOB } from "./world.js";

type Request = { id: number; op: string; apiBase?: string; code?: string; name?: string; label?: string; path?: string; access?: "read-write" | "review" };

const root = process.argv[2];
const restarted = process.argv[3] === "restart";
if (!root || !process.send) throw new Error("Started only by the eval run (lib/computer.ts).");
const send = (message: unknown) => process.send?.(message);
const dirs = { state: join(root, "state"), workspace: join(root, "workspace"), app: join(root, "app"), data: join(root, "data"), tmp: join(root, "tmp"), run: join(root, "run") };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const disk = process.env.NODE_EVAL_COMPUTER_DB === "disk";
const key = process.env.NODE_EVAL_COMPUTER_KEY;
delete process.env.NODE_EVAL_COMPUTER_KEY;
hermetic(dirs);
if (key) process.env.ENSEMBLE_SECRET_KEY = key;
const room = agentScreenRoom(root, dirs.run);

/** The API on a database kept in the computer's folder, set up as the HTTP test harness sets up its own. */
async function onDisk() {
  Object.assign(process.env, {
    ENSEMBLE_DEV_AUTH_BYPASS: "false",
    ENSEMBLE_DESKTOP: "0",
    REDIS_URL: "memory://eval-computer",
    ENSEMBLE_INTERNAL_TOKEN: randomBytes(24).toString("hex"),
    ENSEMBLE_LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://eval_computer:eval_computer@127.0.0.1:1/ensemble_eval_computer",
  });
  process.env.ENSEMBLE_NODE_CHECKLIST_MODEL ??= "off";
  for (const bucket of ["LOGIN", "SIGNUP", "EMAIL", "MODEL", "TOKEN", "DEVICE", "CLI_START", "CLI_TOKEN", "MCP", "LINK_READ", "LINK_WRITE"]) process.env[`ENSEMBLE_RATE_${bucket}_LIMIT`] = "0";
  delete process.env.ENSEMBLE_DESKTOP_TOKEN;
  const { openDesktopDatabase, closeDesktopDatabase } = await import("../../../apps/hub-api/src/lib/pglite-engine.js");
  await openDesktopDatabase(join(dirs.data, "pglite"));
  const { buildApp } = await import("../../../apps/hub-api/src/app.js");
  const { prisma } = await import("../../../apps/hub-api/src/lib/prisma.js");
  const app = await buildApp({ logger: { level: "info", file: join(root, "computer.log") } });
  await app.ready();
  return {
    app,
    prisma,
    close: async () => {
      await prisma.$disconnect().catch(() => undefined);
      await closeDesktopDatabase();
    },
  };
}

const harness = disk ? await onDisk() : await (await import("../../../apps/hub-api/src/test/http.js")).createHttpHarness({ logger: { level: "info", file: join(root, "computer.log") } });
if (!restarted && (await harness.prisma.user.count()) > 0) throw new Error("The computer starts only on a fresh database.");
process.env.ENSEMBLE_DESKTOP = "1";
await harness.app.listen({ port: 0, host: "127.0.0.1" });
const port = (harness.app.server.address() as AddressInfo).port;
process.env.HUB_API_PUBLIC_URL = `http://127.0.0.1:${port}`;
const { setLocalPort } = await import("../../../apps/hub-api/src/workspace/engines/registry.js");
setLocalPort(port);

const { ensureDesktopUser } = await import("../../../apps/hub-api/src/lib/desktop-user.js");
await ensureDesktopUser();
const { prepareSandbox, releaseSandbox } = await import("../../../apps/hub-api/src/workspace/sandbox/spawn.js");
const sandbox = await prepareSandbox().catch(() => null);
const { startAgentQueue } = await import("../../../apps/hub-api/src/workspace/worker.js");
const { startCaptureRuntime } = await import("../../../apps/hub-api/src/capture/runtime.js");
const { startRemote, wakeRemote } = await import("../../../apps/hub-api/src/remote/loop.js");
const { pairComputer, enableRemote, unpairComputer } = await import("../../../apps/hub-api/src/remote/routes.js");
const { loadSettings, updateSettings } = await import("../../../apps/hub-api/src/remote/store.js");
const { resolveWorkFolder } = await import("../../../apps/hub-api/src/workspace/guard.js");
const stopQueue = startAgentQueue(harness.app);
const stopCapture = startCaptureRuntime(harness.app);
let stopRemote: (() => Promise<void>) | null = startRemote(harness.app);
const quiet = { warn: () => undefined };

let closing: Promise<void> | null = null;
function shutdown(): Promise<void> {
  closing ??= (async () => {
    await stopRemote?.().catch(() => undefined);
    await stopQueue().catch(() => undefined);
    await stopCapture().catch(() => undefined);
    await releaseSandbox().catch(() => undefined);
    await harness.app.close().catch(() => undefined);
    await harness.close().catch(() => undefined);
  })();
  return closing;
}

async function handle(request: Request): Promise<unknown> {
  if (request.op === "pair") {
    await pairComputer(harness.app, { apiBase: request.apiBase!, code: request.code!, name: request.name ?? "Eval computer" });
    enableRemote();
    return null;
  }
  if (request.op === "unpair") {
    updateSettings({ folders: [] });
    await unpairComputer(harness.app, quiet);
    return null;
  }
  if (request.op === "share") {
    const real = await resolveWorkFolder(request.path!);
    updateSettings({ folders: [...loadSettings().folders.filter((row) => row.label !== request.label), { label: request.label!, path: real, kind: "folder", access: request.access ?? "read-write" }] });
    wakeRemote();
    return real;
  }
  if (request.op === "unshare") {
    updateSettings({ folders: loadSettings().folders.filter((row) => row.label !== request.label) });
    wakeRemote();
    return null;
  }
  // The computer's connection to Ensemble stops (as when it sleeps or is cut off for good) and starts again.
  if (request.op === "remote-stop") {
    const stop = stopRemote;
    stopRemote = null;
    await stop?.();
    return null;
  }
  if (request.op === "remote-start") {
    if (!stopRemote) {
      stopRemote = startRemote(harness.app);
      wakeRemote();
    }
    return null;
  }
  // What the computer still holds once its work should be over: runs not ended, resource claims, leases.
  if (request.op === "inspect") {
    const [liveJobs, claims, leases] = await Promise.all([
      harness.prisma.workspaceJob.count({ where: { status: { in: [...LIVE_JOB] } } }),
      harness.prisma.resourceClaim.count(),
      harness.prisma.workspaceJob.count({ where: { leaseUntil: { gt: new Date() }, status: { notIn: [...LIVE_JOB] } } }),
    ]);
    return { liveJobs, claims, leases };
  }
  if (request.op === "close") {
    await shutdown();
    setTimeout(() => process.exit(0), 50);
    return null;
  }
  throw new Error(`Unknown request ${request.op}.`);
}

process.on("message", (raw) => {
  const request = raw as Request;
  handle(request).then(
    (result) => send({ id: request.id, ok: true, result }),
    (error: unknown) => send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});
process.on("disconnect", () => void shutdown().finally(() => process.exit(0)));
send({ ready: true, sandbox: sandbox ? `${sandbox.mechanism} (${sandbox.strength})` : null, pipewire: room.pipewire });
