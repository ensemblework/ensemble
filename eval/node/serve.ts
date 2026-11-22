/**
 * Serve mode (README.md "Serve mode"): the eval's isolated world left running, so a person or a browser
 * test can use the real Ensemble Node website against it, on a phone-sized window or any other. It boots
 * the same world a suite run boots (lib/world.ts: the API on an in-memory PGlite database, the owner's
 * computer as a second process with the private agent screen, the agent with a home of the run's own, a
 * session bus filtered to the keyring, no display), makes one owner with one DM node on the computer, and
 * listens on `localhost` for the website's local origin (ENSEMBLE_NODE_WEB_ORIGIN, as node.ensemblework.com
 * is for production). Owner cards are left to the person; the cost fence still stops runs on another
 * engine or model. The addresses and the owner's session cookie go in `serve.json` (0600) in the scratch
 * folder. On SIGTERM or SIGINT it stops the node's work, deletes the node, unpairs, deletes every agent
 * session it made and removes the scratch folder.
 *
 *   pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/serve.ts --port 4100 --web http://localhost:3300 \
 *        --work-dir <dir> [--agent copilot-cli] [--model gpt-6-luna] [--template assistant] [--protect <ids>] [--keep]
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { endNodes, finalSessions, runCleanups, startDrive, stopEverything, tick, traceFile } from "./lib/drive.js";
import { localWebOrigin } from "./lib/local-web.js";
import { redactor } from "./lib/redact.js";
import { copilotSessionIds, copilotSessionsIn, deleteSessions, SessionLedger } from "./lib/sessions.js";
import type { Task } from "./lib/types.js";
import { bootWorld } from "./lib/world.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const POLL_MS = 1500;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Args = { port: number; web: string; agent: string; model: string; template: string; workDir: string; keep: boolean; protect: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4100, web: "http://localhost:3300", agent: "copilot-cli", model: "gpt-6-luna", template: "assistant", workDir: tmpdir(), keep: false, protect: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--port") args.port = Number(value());
    else if (flag === "--web") args.web = value();
    else if (flag === "--agent") args.agent = value();
    else if (flag === "--model") args.model = value();
    else if (flag === "--template") args.template = value();
    else if (flag === "--work-dir") args.workDir = resolve(value());
    else if (flag === "--keep") args.keep = true;
    else if (flag === "--protect") args.protect.push(...value().split(",").map((id) => id.trim()).filter(Boolean));
    else throw new Error(`Unknown argument ${flag}`);
  }
  args.protect.push(...(process.env.NODE_EVAL_PROTECT ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error("--port takes a port from 1024 to 65535.");
  return args;
}

/** Fails at once when another process holds the port, before anything starts. */
async function portFree(port: number): Promise<void> {
  await new Promise<void>((done, fail) => {
    const probe = createServer();
    probe.once("error", () => fail(new Error(`Port ${port} on localhost is taken: pick another with --port.`)));
    probe.listen({ port, host: "localhost", exclusive: true }, () => probe.close(() => done()));
  });
}

/** Removes a scratch folder, then again a moment later: agent processes still ending write their logs into it. */
async function removeScratch(root: string): Promise<void> {
  rmSync(root, { recursive: true, force: true });
  await sleep(3000);
  rmSync(root, { recursive: true, force: true });
}

const SERVE_TASK: Task = { id: "serve", suite: "core", category: "serve", title: "Serve mode: a person drives the node", setup: async () => undefined, steps: [], checks: () => [] };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(`[serve ${new Date().toISOString().slice(11, 19)}] ${line}`);
  const web = localWebOrigin(args.web);
  if (args.workDir === REPO || args.workDir.startsWith(`${REPO}/`)) throw new Error("--work-dir must be outside this repository: Ensemble refuses to work in its own source.");
  await portFree(args.port);
  // Sessions that exist before the world starts are never this run's to delete.
  const before = copilotSessionIds();
  process.env.ENSEMBLE_NODE_WEB_ORIGIN = web;
  const world = await bootWorld({ workDir: args.workDir, agent: args.agent, model: args.model, log, listen: { port: args.port, host: "localhost" } });
  const root = world.dirs.root;
  const ledger = new SessionLedger(join(root, "ledger.jsonl"), before, new Set(args.protect));
  let closing: Promise<void> | null = null;
  let watching: Promise<void> = Promise.resolve();
  let drive: Awaited<ReturnType<typeof startDrive>> | null = null;

  const shutdown = (why: string) => {
    closing ??= (async () => {
      log(`${why}: stopping the node's work`);
      await watching.catch(() => undefined);
      if (drive) {
        await stopEverything(drive).catch((error: unknown) => log(`stop: ${error instanceof Error ? error.message : String(error)}`));
        await runCleanups(drive);
        await endNodes(drive).catch((error: unknown) => log(`end nodes: ${error instanceof Error ? error.message : String(error)}`));
      }
      await world.unpair().catch((error: unknown) => log(`unpair: ${error instanceof Error ? error.message : String(error)}`));
      if (drive) await finalSessions(drive);
      for (const id of copilotSessionsIn(root)) ledger.record({ agent: "copilot-cli", id, kind: "found", task: SERVE_TASK.id, folder: null });
      const done = await deleteSessions(ledger, ledger.entries(), log);
      const left = ledger.entries().filter((row) => row.agent === "copilot-cli" && copilotSessionIds().has(row.id));
      await world.close();
      if (args.keep) log(`scratch folder kept: ${root}`);
      else await removeScratch(root);
      log(`agent sessions: ${done.filter((row) => row.deleted).length} of ${done.length} deleted${left.length ? `; still in Copilot's session-state: ${left.map((row) => row.id).join(", ")}` : ""}`);
      process.exit(left.length || done.some((row) => !row.deleted) ? 1 : 0);
    })();
    return closing;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  try {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR?.startsWith(root)) throw new Error("The serve process can reach a display: it does not start.");
    const owner = await world.newOwner("Mira Chen");
    const device = await world.pair(owner);
    const dir = join(world.dirs.tasks, SERVE_TASK.id);
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const redact = redactor({ [root]: "<work>", [REPO]: "<repo>", [hostname()]: "<computer>" });
    drive = await startDrive({ world, owner, task: SERVE_TASK, repeat: 0, dir, deviceId: device.id, trace: traceFile(join(root, "trace.jsonl"), redact), ledger, log, timeoutMs: 7 * 86_400_000, answer: false });
    const node = await drive.ctx.makeNode("main", args.template);
    // The website's own sign-in: a session of the owner's, as /api/auth/login makes, for the browser's cookie.
    const { sha256, SESSION_COOKIE } = await import("../../apps/hub-api/src/lib/auth.js");
    const token = randomBytes(32).toString("base64url");
    const user = await world.prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { moduleSet: true } });
    await world.prisma.session.create({ data: { id: sha256(token), userId: owner.id, expiresAt: new Date(Date.now() + 7 * 86_400_000), modules: user.moduleSet } });
    const file = join(root, "serve.json");
    const serve = {
      api: world.origin,
      web,
      room: `${web}/r/${node.roomId}`,
      cookie: { name: SESSION_COOKIE, value: token, path: "/", httpOnly: true, sameSite: "Lax" },
      owner: { id: owner.id, name: owner.name, email: owner.email },
      node: { id: node.id, slug: node.slug, roomId: node.roomId, provider: args.agent, model: args.model },
      computer: { id: device.id, name: device.name },
      folders: { scratch: root, elsewhere },
      pid: process.pid,
    };
    writeFileSync(file, `${JSON.stringify(serve, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    log(`API ${world.origin} for the website at ${web}`);
    log(`@${node.slug}'s chat: ${serve.room}`);
    log(`addresses and the owner's session cookie: ${file} (0600)`);
    log(`a folder outside the node's own: ${elsewhere}`);
    log("owner cards are yours to answer; stop with SIGTERM or Ctrl+C");
    watching = (async () => {
      while (!closing) {
        await tick(drive!);
        await sleep(POLL_MS);
      }
    })();
  } catch (error) {
    log(`could not start: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown("start failed");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
