/**
 * Private X displays for desktop apps on Linux (ensemble-node design E§8.2): an Xvfb server per
 * capture session, with its own authority cookie so no other program on the computer can read it,
 * a minimal window manager when one is installed, and the app's window found by process id, by
 * title, or as the only window on that display. They never touch the owner's screen, and they work
 * the same under X11, Wayland, a locked screen or no screen at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureError } from "./media.js";
import type { LeaseRecord, LeaseTable } from "./leases.js";
import { findOnPath, isExecutable, runCommand, type ExecutableCheck, type RunResult } from "./system.js";

export const DEFAULT_SIZE = { width: 1920, height: 1080 };

/** Lightweight window managers, in order of preference, with the arguments that keep them quiet. */
export const WINDOW_MANAGERS: Array<{ name: string; args: string[] }> = [
  { name: "openbox", args: ["--sm-disable"] },
  { name: "matchbox-window-manager", args: ["-use_titlebar", "no"] },
  { name: "fluxbox", args: [] },
  { name: "icewm", args: [] },
  { name: "jwm", args: [] },
  { name: "xfwm4", args: ["--compositor=off"] },
  { name: "metacity", args: [] },
  { name: "twm", args: [] },
];

export type DisplayTools = {
  xvfb: string | null;
  windowManager: { name: string; path: string; args: string[] } | null;
  xdotool: string | null;
  xwininfo: string | null;
  xprop: string | null;
  wmctrl: string | null;
};

export function findDisplayTools(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, executable: ExecutableCheck = isExecutable): DisplayTools {
  const find = (name: string) => (platform === "linux" ? findOnPath(name, env, platform, executable) : null);
  const manager = WINDOW_MANAGERS.map((wm) => ({ ...wm, path: find(wm.name) })).find((wm) => wm.path);
  return {
    xvfb: find("Xvfb"),
    windowManager: manager?.path ? { name: manager.name, path: manager.path, args: manager.args } : null,
    xdotool: find("xdotool"),
    xwininfo: find("xwininfo"),
    xprop: find("xprop"),
    wmctrl: find("wmctrl"),
  };
}

/** Xvfb's arguments: it picks a free display and writes its number to fd 3; TCP is off; the cookie file guards it. */
export function xvfbArgs(input: { width: number; height: number; depth?: number; authFile: string }): string[] {
  return ["-displayfd", "3", "-screen", "0", `${input.width}x${input.height}x${input.depth ?? 24}`, "-nolisten", "tcp", "-auth", input.authFile, "-noreset", "-dpi", "96"];
}

/**
 * One Xauthority entry for any display (family FamilyWild, empty address and display number):
 * the server reads the cookie from it, and clients given the file present it.
 */
export function xauthorityEntry(cookie: Buffer): Buffer {
  const field = (data: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length);
    return Buffer.concat([length, data]);
  };
  const family = Buffer.from([0xff, 0xff]);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from("MIT-MAGIC-COOKIE-1", "latin1")), field(cookie)]);
}

export type WindowInfo = { id: string; title: string; x: number; y: number; width: number; height: number; pid?: number };
export type FoundWindow = WindowInfo & { how: "pid" | "title" | "only-window" | "display" };

/** Windows in `xwininfo -root -tree` output, at any depth, with absolute positions. */
export function parseXwininfoTree(text: string): WindowInfo[] {
  const windows: WindowInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s+(0x[0-9a-f]+)\s+(?:"((?:[^"\\]|\\.)*)"|\(has no name\)).*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)\s*$/i.exec(line);
    if (!match) continue;
    windows.push({ id: match[1]!, title: match[2] ?? "", width: Number(match[3]), height: Number(match[4]), x: Number(match[5]), y: Number(match[6]) });
  }
  return windows;
}

/** `_NET_WM_PID(CARDINAL) = 1234` from xprop. */
export function parseXpropPid(text: string): number | null {
  const match = /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** `xdotool getwindowgeometry --shell` output. */
export function parseXdotoolGeometry(text: string): { x: number; y: number; width: number; height: number } | null {
  const value = (key: string) => {
    const match = new RegExp(`^${key}=(-?\\d+)$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const [x, y, width, height] = [value("X"), value("Y"), value("WIDTH"), value("HEIGHT")];
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/** `wmctrl -lpG` lines: id, desktop, pid, x, y, width, height, host, title. */
export function parseWmctrl(text: string): WindowInfo[] {
  const windows: WindowInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^(0x[0-9a-f]+)\s+-?\d+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i.exec(line);
    if (match) windows.push({ id: match[1]!, pid: Number(match[2]), x: Number(match[3]), y: Number(match[4]), width: Number(match[5]), height: Number(match[6]), title: match[7] ?? "" });
  }
  return windows;
}

/** The process and all its descendants, from /proc (Linux). */
export function processTree(root: number, read: (path: string) => string = (path) => readFileSync(path, "utf8"), list: () => string[] = () => readdirSync("/proc")): Set<number> {
  const children = new Map<number, number[]>();
  for (const name of list()) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = read(`/proc/${name}/stat`);
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
    } catch {
      // The process ended while we looked.
    }
  }
  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) if (!found.has(child)) found.add(child), queue.push(child);
  return found;
}

type Runner = (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

const defaultRunner: Runner = (program, args, env) => runCommand(program, args, { env, timeoutMs: 5_000 });

const TINY = 4;

/**
 * The app's window on a private display: by process id (its own or a child's), else by title, else
 * the only real window there, else the whole display (one app per display makes that safe).
 */
export async function findWindow(input: { env: NodeJS.ProcessEnv; size: { width: number; height: number }; pids: Set<number>; title?: string; tools: DisplayTools; run?: Runner }): Promise<FoundWindow> {
  const run = input.run ?? defaultRunner;
  const { tools, env } = input;
  const title = input.title?.toLowerCase();
  const geometry = async (id: string): Promise<WindowInfo | null> => {
    if (!tools.xdotool) return null;
    const result = await run(tools.xdotool, ["getwindowgeometry", "--shell", String(Number(id))], env);
    const box = parseXdotoolGeometry(result.stdout);
    if (!box) return null;
    const name = await run(tools.xdotool, ["getwindowname", String(Number(id))], env);
    return { id, title: name.stdout.trim(), ...box };
  };
  if (tools.xdotool) {
    for (const pid of input.pids) {
      const result = await run(tools.xdotool, ["search", "--onlyvisible", "--pid", String(pid)], env);
      for (const id of result.stdout.split(/\s+/).filter(Boolean)) {
        const window = await geometry(`0x${Number(id).toString(16)}`);
        if (window && window.width > TINY && window.height > TINY && (!title || window.title.toLowerCase().includes(title))) return { ...window, pid, how: "pid" };
      }
    }
  }
  let windows: WindowInfo[] = [];
  if (tools.wmctrl) windows = parseWmctrl((await run(tools.wmctrl, ["-lpG"], env)).stdout);
  if (!windows.length && tools.xwininfo) {
    windows = parseXwininfoTree((await run(tools.xwininfo, ["-root", "-tree"], env)).stdout).filter((window) => window.title);
    if (tools.xprop) {
      for (const window of windows.slice(0, 50)) window.pid = parseXpropPid((await run(tools.xprop, ["-id", window.id, "_NET_WM_PID"], env)).stdout) ?? undefined;
    }
  }
  const real = windows.filter((window) => window.width > TINY && window.height > TINY);
  const byPid = real.find((window) => window.pid !== undefined && input.pids.has(window.pid) && (!title || window.title.toLowerCase().includes(title)));
  if (byPid) return { ...byPid, how: "pid" };
  if (title) {
    const byTitle = real.find((window) => window.title.toLowerCase().includes(title));
    if (byTitle) return { ...byTitle, how: "title" };
  }
  const titled = real.filter((window) => window.title);
  if (titled.length === 1) return { ...titled[0]!, how: "only-window" };
  return { id: "root", title: "", x: 0, y: 0, ...input.size, how: "display" };
}

/** A running virtual display: its X server, window manager and cookie, under a lease. */
export class VirtualDisplay {
  private constructor(
    readonly display: string,
    readonly size: { width: number; height: number },
    readonly env: { DISPLAY: string; XAUTHORITY: string },
    readonly lease: LeaseRecord,
    readonly windowManager: string | null,
    private readonly leases: LeaseTable,
    private readonly server: ChildProcess,
  ) {}

  static async start(input: { tools: DisplayTools; leases: LeaseTable; stateDir: string; size?: { width: number; height: number }; operation?: string; leaseMs: number; now?: () => number }): Promise<VirtualDisplay> {
    if (!input.tools.xvfb) throw new CaptureError("unavailable", "Desktop apps are captured on a private virtual display, which needs Xvfb. Run `ensemble capture setup` to see the command that installs it.");
    const size = input.size ?? DEFAULT_SIZE;
    const authDir = join(input.stateDir, "displays");
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const authFile = join(authDir, `xauth-${randomBytes(6).toString("hex")}`);
    writeFileSync(authFile, xauthorityEntry(randomBytes(16)), { mode: 0o600 });
    const server = spawn(input.tools.xvfb, xvfbArgs({ ...size, authFile }), { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"] });
    let stderr = "";
    server.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    const number = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new CaptureError("failed", `Xvfb did not start in time. ${stderr.trim()}`)), 15_000);
      const pipe = server.stdio[3] as NodeJS.ReadableStream | null;
      pipe?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        const line = /^(\d+)\s*$/m.exec(out);
        if (line) {
          clearTimeout(timer);
          resolve(line[1]!);
        }
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new CaptureError("failed", `Xvfb stopped at start (exit ${code}). ${stderr.trim()}`));
      });
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(new CaptureError("failed", `Xvfb did not start: ${error.message}`));
      });
    }).catch((error: unknown) => {
      server.kill("SIGKILL");
      throw error;
    });
    server.unref();
    const display = `:${number}`;
    const now = input.now?.() ?? Date.now();
    // Only the cookie is ours to delete: an X server clears a stale lock file and socket itself, and
    // by the time a crash is cleaned up another server may own that display number.
    const lease = input.leases.add({
      kind: "display",
      pid: server.pid!,
      label: `virtual display ${display}`,
      operation: input.operation,
      expiresAt: now + input.leaseMs,
      files: [authFile],
    });
    const env = { DISPLAY: display, XAUTHORITY: authFile };
    let windowManager: string | null = null;
    const wm = input.tools.windowManager;
    if (wm) {
      const manager = spawn(wm.path, wm.args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
      manager.on("error", () => undefined);
      if (manager.pid) {
        manager.unref();
        input.leases.add({ kind: "window-manager", pid: manager.pid, label: `${wm.name} on ${display}`, operation: input.operation, expiresAt: lease.expiresAt, parent: lease.id });
        windowManager = wm.name;
      }
    }
    return new VirtualDisplay(display, size, env, lease, windowManager, input.leases, server);
  }

  get alive(): boolean {
    return this.server.exitCode === null && this.server.signalCode === null;
  }

  async stop(reason = "released"): Promise<void> {
    await this.leases.end(this.lease.id, reason);
  }
}
