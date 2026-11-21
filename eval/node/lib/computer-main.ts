/**
 * The owner's computer during an eval run: a second process with its own in-memory database, the
 * way the desktop app runs beside the hosted web. It pairs with the eval's API, then its real remote
 * loop, agent queue and capture runtime answer device tools and run coding sessions on this machine.
 * Its own database matters: a file the computer keeps and the web's copy of it share an id, so one
 * database for both would refuse every shared file. The run talks to it over IPC (computer.ts).
 */
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { agentScreenRoom, hermetic } from "./world.js";

type Request = { id: number; op: string; apiBase?: string; code?: string; name?: string; label?: string; path?: string; access?: "read-write" | "review" };

const root = process.argv[2];
if (!root || !process.send) throw new Error("Started only by the eval run (lib/computer.ts).");
const send = (message: unknown) => process.send?.(message);
const dirs = { state: join(root, "state"), workspace: join(root, "workspace"), app: join(root, "app"), data: join(root, "data"), tmp: join(root, "tmp"), run: join(root, "run") };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
hermetic(dirs);
const room = agentScreenRoom(root, dirs.run);

const { createHttpHarness } = await import("../../../apps/hub-api/src/test/http.js");
const harness = await createHttpHarness({ logger: { level: "info", file: join(root, "computer.log") } });
if ((await harness.prisma.user.count()) > 0) throw new Error("The computer runs only on a fresh in-memory database.");
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
const stopRemote = startRemote(harness.app);
const quiet = { warn: () => undefined };

let closing: Promise<void> | null = null;
function shutdown(): Promise<void> {
  closing ??= (async () => {
    await stopRemote().catch(() => undefined);
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
