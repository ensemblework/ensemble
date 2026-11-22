/**
 * One Ensemble for a whole eval run, run the way the hosted web and the desktop app run it: the real
 * API on an in-memory PGlite database (src/test/http.ts) with this computer's own agent CLIs for turns
 * on the owner's subscription (`ENSEMBLE_DESKTOP=1`), and the owner's computer as a second process
 * (computer-main.ts) with its own database, paired by the real remote loop, so device tools and coding
 * sessions act on this machine. Every folder Ensemble writes is inside the run's scratch folder; the
 * databases live in memory and disappear with the processes. Nothing the run starts can reach the
 * owner's screen: no display, a private runtime folder, and a session bus that only reaches the keyring.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HttpUser } from "../../../apps/hub-api/src/test/http.js";
import { startComputer } from "./computer.js";
import { startLink } from "./link.js";

export type Log = (line: string) => void;
export type Owner = { id: string; name: string; email: string; inject: HttpUser["inject"] };

/** Statuses of a workspace job that is not over (on the server or the computer). */
export const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval", "stopping"] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What could reach the owner's screen, sound, agents or desktop session from a process the run starts. */
const DESKTOP_SESSION = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "WAYLAND_SOCKET",
  "SWAYSOCK",
  "I3SOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "PIPEWIRE_REMOTE",
  "PULSE_SERVER",
  "SESSION_MANAGER",
  "DESKTOP_STARTUP_ID",
  "XDG_ACTIVATION_TOKEN",
  "GNOME_TERMINAL_SCREEN",
  "GNOME_TERMINAL_SERVICE",
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
];

/** The variables that could reach real data, keys or a screen, cleared or pointed into the scratch folder before Ensemble loads. */
export function hermetic(dirs: { state: string; workspace: string; app: string; data: string; tmp: string; run: string }): void {
  for (const key of Object.keys(process.env)) {
    if (/(_API_KEY|_API_TOKEN|_SECRET)$|^(AZURE|OPENAI|ANTHROPIC|GEMINI|XAI|MISTRAL|GOOGLE_API|STRIPE|RESEND)_/.test(key)) delete process.env[key];
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ENSEMBLE_TEST_DATABASE_URL", "ENSEMBLE_REMOTE_API", "ENSEMBLE_INSTALL_PATH", "ENSEMBLE_LOCAL_ONLY", "ENSEMBLE_DESKTOP_TOKEN", "ENSEMBLE_RUNTIME_MODE", "ENSEMBLE_DISCOVERY_FILE", "ENSEMBLE_SECRET_KEY_FILE", "ENSEMBLE_CHROMIUM", "HUB_API_PUBLIC_URL", "AZURE_STORAGE_CONNECTION_STRING", ...DESKTOP_SESSION]) {
    delete process.env[key];
  }
  // Wayland, PipeWire and PulseAudio find the desktop's sockets in XDG_RUNTIME_DIR by default.
  mkdirSync(dirs.run, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    XDG_RUNTIME_DIR: dirs.run,
    XDG_SESSION_TYPE: "tty",
    ENSEMBLE_REMOTE_STATE_DIR: dirs.state,
    ENSEMBLE_WORKSPACE_ROOT: dirs.workspace,
    ENSEMBLE_APP_DATA_DIR: dirs.app,
    ENSEMBLE_DATA_DIR: join(dirs.data, "pglite"),
    ENSEMBLE_BACKUP_DIR: join(dirs.data, "backups"),
    // A key for this run only, never written to disk.
    ENSEMBLE_SECRET_KEY: randomBytes(32).toString("base64"),
    ENSEMBLE_FILE_STORAGE: "database",
    // Included models are Ensemble's own: no agent runtime answers here, so those calls fail at once and cost nothing.
    ENSEMBLE_INPROCESS_RUNTIME: "0",
    AGENT_RUNTIME_URL: "http://127.0.0.1:9",
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    ENSEMBLE_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    // The GitHub CLI finds no account: an agent's `gh` reaches nothing of the owner's.
    GH_CONFIG_DIR: join(dirs.app, "gh"),
  });
}

/**
 * What the computer's desktop helper needs for its agent screen (a private headless GNOME Shell) and
 * nothing more of the desktop session: a link to this user's PipeWire socket in the computer's own
 * runtime folder, which the agent screen's frames go through, and a `systemd-run` that runs its command
 * here. The real one would reach this user's systemd manager, which starts units with the desktop
 * session's display variables.
 */
export function agentScreenRoom(root: string, run: string): { pipewire: boolean } {
  const real = join("/run/user", String(process.getuid?.() ?? ""), "pipewire-0");
  const link = join(run, "pipewire-0");
  let pipewire = false;
  try {
    if (statSync(real).isSocket()) {
      if (!lstatSyncSafe(link)) symlinkSync(real, link);
      pipewire = true;
    }
  } catch {
    pipewire = false;
  }
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemd-run"), SYSTEMD_RUN, { mode: 0o755 });
  process.env.PATH = [bin, ...(process.env.PATH ?? "/usr/bin:/bin").split(":").filter((entry) => entry && entry !== bin)].join(":");
  return { pipewire };
}

const lstatSyncSafe = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Runs the command that follows the end of `systemd-run`'s options, in place of a unit. */
const SYSTEMD_RUN = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    exec "$@"
  fi
  shift
done
echo "systemd-run: the eval's computer runs only a command given after the end of its options" >&2
exit 1
`;

/**
 * Points the session bus at a filtered copy (xdg-dbus-proxy) that reaches only the keyring
 * (`org.freedesktop.secrets`), where agent CLIs such as Copilot keep their sign-in: no desktop portal,
 * notification, screen cast or app activation gets through. Without the proxy, the bus is cut. Call it
 * before `hermetic` moves XDG_RUNTIME_DIR; the socket goes in `dir`.
 */
export async function keyringBus(dir: string, log: Log): Promise<{ filtered: boolean; stop: () => void }> {
  const real = process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!real || process.platform !== "linux") return { filtered: false, stop: () => undefined };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = join(dir, "keyring-bus");
  // `--fd=3`: the proxy ends when this process does and the pipe closes.
  const proxy = spawn("xdg-dbus-proxy", ["--fd=3", real, socket, "--filter", "--talk=org.freedesktop.secrets"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const failed = new Promise<boolean>((resolve) => proxy.once("error", () => resolve(true)));
  for (let waited = 0; waited < 5000 && !existsSync(socket); waited += 100) {
    if (await Promise.race([failed, sleep(100).then(() => false)])) break;
  }
  if (!existsSync(socket)) {
    proxy.kill();
    log("no xdg-dbus-proxy: the session bus is off, so an agent that keeps its sign-in in the keyring is signed out");
    return { filtered: false, stop: () => undefined };
  }
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socket}`;
  return { filtered: true, stop: () => void proxy.kill() };
}

/**
 * A Copilot home of the run's own (COPILOT_HOME): the signed-in accounts copied from this machine's
 * config.json (host and login; the token stays in the keyring) and nothing else. No MCP server, skill,
 * plugin, instruction or setting of this machine reaches a node turn, a coding session or the judge,
 * and every Copilot session the run makes stays in the scratch folder. False when no account was found.
 */
export function agentHome(dir: string): boolean {
  const real = process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  let accounts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(real, "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
    accounts = Object.fromEntries(["loggedInUsers", "lastLoggedInUser"].filter((key) => parsed[key] !== undefined).map((key) => [key, parsed[key]]));
  } catch {
    accounts = {};
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
  process.env.COPILOT_HOME = dir;
  return Object.keys(accounts).length > 0;
}

/**
 * `durableComputer`: the computer keeps its database on disk, for a run with a task that restarts it.
 * `listen`: where the API answers (default a free port on 127.0.0.1). Serve mode (serve.ts) listens on
 * `localhost` so a browser on another localhost port shares its host-only session cookie; links the API
 * makes then name `localhost` too. The owner's computer always pairs over 127.0.0.1.
 */
export async function bootWorld(options: { workDir: string; agent: string; model: string; log: Log; durableComputer?: boolean; listen?: { port: number; host: "127.0.0.1" | "localhost" } }) {
  // Chromium's singleton socket lives in the computer's TMPDIR, and a Unix socket path holds at most 107 bytes.
  if (Buffer.byteLength(join(options.workDir, "nv-XXXXXX", "pc", "tmp")) > 60) throw new Error(`The work folder ${options.workDir} is too deep for the computer's browser: pick one with a shorter path.`);
  mkdirSync(options.workDir, { recursive: true });
  const root = mkdtempSync(join(options.workDir, "nv-"));
  const dirs = { root, state: join(root, "state"), workspace: join(root, "workspace"), app: join(root, "app"), data: join(root, "data"), tmp: join(root, "tmp"), run: join(root, "run"), copilot: join(root, "copilot"), tasks: join(root, "tasks"), computer: join(root, "pc") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const bus = await keyringBus(dirs.run, options.log);
  hermetic(dirs);
  if (!agentHome(dirs.copilot)) options.log("no signed-in Copilot account found in this machine's Copilot config");
  const timeZone = process.env.ENSEMBLE_TIMEZONE!;

  const { createHttpHarness } = await import("../../../apps/hub-api/src/test/http.js");
  const harness = await createHttpHarness({
    logger: { level: "warn", file: join(root, "api.log"), redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" } },
  });
  const prisma = harness.prisma;
  if (process.env.ENSEMBLE_TEST_DATABASE_URL || (await prisma.user.count()) > 0) throw new Error("The eval runs only on a fresh in-memory database.");

  process.env.ENSEMBLE_DESKTOP = "1";
  const listen = options.listen ?? { port: 0, host: "127.0.0.1" };
  await harness.app.listen(listen);
  const port = (harness.app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const origin = `http://${listen.host}:${port}`;
  process.env.HUB_API_PUBLIC_URL = origin;
  const { setLocalPort } = await import("../../../apps/hub-api/src/workspace/engines/registry.js");
  setLocalPort(port);

  const { ensureDesktopUser } = await import("../../../apps/hub-api/src/lib/desktop-user.js");
  await ensureDesktopUser();
  const { stopJob } = await import("../../../apps/hub-api/src/workspace/worker.js");
  const { startNode } = await import("../../../apps/hub-api/src/node/runs.js");
  const stopNode = startNode(harness.app);
  const link = await startLink({ host: "127.0.0.1", port });
  const computer = await startComputer(dirs.computer, { durable: options.durableComputer === true }).catch(async (error: unknown) => {
    stopNode();
    await link.close().catch(() => undefined);
    await harness.app.close().catch(() => undefined);
    await harness.close().catch(() => undefined);
    bus.stop();
    throw error;
  });
  options.log(`computer: own process, sandbox ${computer.sandbox ?? "none"}, ${computer.pipewire ? "PipeWire for an agent screen" : "no PipeWire, so no agent screen"}`);

  /**
   * One answer Ensemble gives the computer, lost on its way: the next request to a matching address whose
   * answer matches gets its connection closed instead of the answer (what Ensemble did stays done), and
   * the link to the computer then stays down for `ms`. Only where the task pairs through the link.
   */
  let losing: { url: RegExp; answer: RegExp; ms: number } | null = null;
  const lost: Array<{ at: string; url: string }> = [];
  harness.app.server.prependListener("request", (request: IncomingMessage, response: ServerResponse) => {
    const armed = losing;
    if (!armed || !armed.url.test(request.url ?? "")) return;
    const write = response.write.bind(response) as (...args: unknown[]) => boolean;
    const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
    const swallowed = (chunk: unknown): boolean => {
      if (losing !== armed) return false;
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (!armed.answer.test(text)) return false;
      losing = null;
      lost.push({ at: new Date().toISOString(), url: (request.url ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id") });
      response.socket?.destroy();
      link.drop(armed.ms, "an answer lost on its way to the computer");
      return true;
    };
    response.write = ((...args: unknown[]) => (swallowed(args[0]) ? true : write(...args))) as ServerResponse["write"];
    response.end = ((...args: unknown[]) => (swallowed(args[0]) ? response : end(...args))) as ServerResponse["end"];
  });

  const { saveSettings } = await import("../../../apps/hub-api/src/lib/settings.js");
  const { deviceOnline } = await import("../../../apps/hub-api/src/devices/constants.js");
  const { RunProfile } = await import("../../../packages/shared-types/src/index.js");

  /** A new owner for one task: verified, named, in this computer's time zone. */
  async function newOwner(name: string): Promise<Owner> {
    const user = await harness.asUser(`owner-${randomUUID().slice(0, 8)}@example.test`);
    const now = new Date();
    await prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: now, onboardingCompletedAt: now, profileCompletedAt: now } });
    await saveSettings(prisma, user.id, { timezone: timeZone });
    return { id: user.id, name, email: user.email, inject: user.inject };
  }

  /**
   * Pairs this computer with the owner, as `ensemble login` does, and waits until it is online with the
   * agent signed in. The owner's default run profile then runs coding sessions there with that agent and
   * model. `viaLink`: the computer reaches Ensemble through the link a task can cut (lib/link.ts).
   */
  async function pair(owner: Owner, pairing: { viaLink?: boolean } = {}): Promise<{ id: string; name: string }> {
    const coded = await owner.inject({ method: "POST", url: "/api/devices/pair", payload: {} });
    if (coded.statusCode !== 201) throw new Error(`No pairing code: ${coded.statusCode} ${coded.body.slice(0, 200)}`);
    await computer.pair(pairing.viaLink ? link.base : base, (coded.json() as { code: string }).code, "Eval computer");
    const deadline = Date.now() + 120_000;
    for (;;) {
      const device = await prisma.device.findFirst({ where: { userId: owner.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
      const agents = ((device?.capabilities ?? {}) as { agents?: Array<{ id: string; signedIn?: boolean | null }> }).agents ?? [];
      const signedIn = agents.find((row) => row.id === options.agent);
      if (device && deviceOnline(device.lastSeenAt) && signedIn && signedIn.signedIn !== false) {
        await saveSettings(prisma, owner.id, {
          runProfiles: [RunProfile.parse({ id: "eval", name: "Eval", kind: "code", engine: options.agent, model: options.model, mode: "review", delivery: "local", deviceId: device.id, sandbox: false })],
          defaultRunProfileId: "eval",
        });
        return { id: device.id, name: device.name };
      }
      if (device && signedIn?.signedIn === false) throw new Error(`${options.agent} is not signed in on this computer.`);
      if (Date.now() > deadline) throw new Error(device ? `This computer did not come online with ${options.agent}.` : "This computer did not pair.");
      await sleep(500);
    }
  }

  /** Unpairs this computer (its runs stop, the owner's device is revoked), ready for the next owner. */
  async function unpair(): Promise<void> {
    await computer.unpair();
  }

  async function close(): Promise<void> {
    stopNode();
    await computer.close().catch(() => undefined);
    await link.close().catch(() => undefined);
    await harness.app.close().catch(() => undefined);
    await harness.close().catch(() => undefined);
    bus.stop();
  }

  return {
    harness,
    app: harness.app,
    prisma,
    base,
    /** The API's address for browsers (`localhost` in serve mode). */
    origin,
    dirs,
    agent: options.agent,
    model: options.model,
    timeZone,
    /** Whether the session bus reaches the keyring only (false: it is cut). */
    keyringOnly: bus.filtered,
    newOwner,
    pair,
    unpair,
    share: computer.share,
    unshare: computer.unshare,
    /** The computer's own process, its folders and its connection to Ensemble. */
    computer: {
      offline: computer.offline,
      online: computer.online,
      restart: computer.restart,
      inspect: computer.inspect,
      durable: options.durableComputer === true,
      dirs: { root: dirs.computer, state: join(dirs.computer, "state"), workspace: join(dirs.computer, "workspace"), tmp: join(dirs.computer, "tmp") },
    },
    link,
    loseAnswer: (match: { url: RegExp; answer: RegExp } | null, ms = 0) => void (losing = match ? { ...match, ms } : null),
    lostAnswers: () => [...lost],
    deviceOnline,
    stopJob,
    close,
  };
}

export type World = Awaited<ReturnType<typeof bootWorld>>;
