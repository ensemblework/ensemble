/**
 * Starting the desktop apps capture looks at: any GUI program on a private virtual display, or an
 * Electron app through Playwright (which also gives its windows' pages). On Linux both get an
 * environment that points only at the virtual display: no Wayland socket and no session bus, so
 * the app cannot open on, or hand off to, the owner's screen.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { redactKeys } from "../lib/redact.js";
import { LEASE_ENV, newLeaseId, type LeaseRecord, type LeaseTable } from "./leases.js";
import { CaptureError } from "./media.js";

/** The environment for a program on a virtual display: X11 only, and nothing that reaches the owner's desktop session. */
export function virtualDisplayEnv(base: NodeJS.ProcessEnv, display: { DISPLAY: string; XAUTHORITY: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...display };
  for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "SESSION_MANAGER", "DESKTOP_STARTUP_ID", "XDG_ACTIVATION_TOKEN"]) delete env[key];
  return {
    ...env,
    XDG_SESSION_TYPE: "x11",
    GDK_BACKEND: "x11",
    QT_QPA_PLATFORM: "xcb",
    SDL_VIDEODRIVER: "x11",
    CLUTTER_BACKEND: "x11",
    MOZ_ENABLE_WAYLAND: "0",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    NO_AT_BRIDGE: "1",
  };
}

export type ElectronInstall = { executablePath: string; version: string | null; packageDir: string };

/**
 * The Electron an app would run with: `node_modules/electron` in its folder or a parent, read from
 * the package's own files (`path.txt` names the binary). Nothing from the app is executed.
 */
export function findElectron(appDir: string, exists: (path: string) => boolean = existsSync, read: (path: string) => string = (path) => readFileSync(path, "utf8")): ElectronInstall | null {
  let dir = resolve(appDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const packageDir = join(dir, "node_modules", "electron");
    if (exists(join(packageDir, "package.json"))) {
      try {
        const binary = read(join(packageDir, "path.txt")).trim();
        const executablePath = join(packageDir, "dist", binary);
        if (binary && exists(executablePath)) {
          const version = (JSON.parse(read(join(packageDir, "package.json"))) as { version?: string }).version ?? null;
          return { executablePath, version, packageDir };
        }
      } catch {
        // An electron package that never finished installing its binary.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The last lines a program printed, with key shapes hidden. */
export class OutputTail {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(private readonly limit = 200) {}

  push(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString();
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.add(line);
    if (this.partial.length > 4_000) {
      this.add(this.partial);
      this.partial = "";
    }
  }

  private add(line: string): void {
    this.lines.push(redactKeys(line).slice(0, 2_000));
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }

  text(last = this.limit): string {
    return [...this.lines, ...(this.partial ? [redactKeys(this.partial)] : [])].slice(-last).join("\n");
  }
}

/**
 * Puts a program inside the OS sandbox: given the program, its arguments, folder and environment
 * (with DISPLAY and XAUTHORITY for its virtual display), returns the command that runs it confined,
 * as `prepareSpawn` in workspace/sandbox/spawn.ts does. Arguments added after the returned ones
 * must reach the program (an Electron launch appends its own).
 */
export type CommandWrapper = (input: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ program: string; args: string[]; env?: NodeJS.ProcessEnv }>;

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** A launcher script that runs the wrapped program with the arguments it is given. */
export async function wrappedLauncher(path: string, wrapped: { program: string; args: string[] }): Promise<string> {
  await writeFile(path, `#!/bin/sh\nexec ${[wrapped.program, ...wrapped.args].map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700 });
  return path;
}

export type StartedProcess = { child: ChildProcess; lease: LeaseRecord; output: OutputTail };

/** Starts a shell command as its own process group, under a lease. */
export async function startCommand(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leases: LeaseTable;
  operation?: string;
  leaseMs: number;
  parent?: string;
  label: string;
  wrap?: CommandWrapper;
  now?: () => number;
}): Promise<StartedProcess> {
  if (!existsSync(input.cwd)) throw new CaptureError("bad_input", `The folder ${input.cwd} does not exist.`);
  const shell = process.platform === "win32" ? { program: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", input.command] } : { program: "/bin/sh", args: ["-c", input.command] };
  const leaseId = newLeaseId("app");
  const env = { ...input.env, [LEASE_ENV]: leaseId };
  const wrapped: { program: string; args: string[]; env?: NodeJS.ProcessEnv } = input.wrap ? await input.wrap({ ...shell, cwd: input.cwd, env }) : shell;
  const output = new OutputTail();
  const child = spawn(wrapped.program, wrapped.args, { cwd: input.cwd, env: wrapped.env ?? env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolveStart, reject) => {
    child.once("spawn", () => resolveStart());
    child.once("error", (error) => reject(new CaptureError("failed", `Could not start the app: ${error.message}`)));
  });
  const lease = input.leases.add({ id: leaseId, kind: "app", pid: child.pid!, label: input.label, operation: input.operation, expiresAt: (input.now?.() ?? Date.now()) + input.leaseMs, parent: input.parent });
  return { child, lease, output };
}

export type StartedElectron = { app: ElectronApplication; window: Page; lease: LeaseRecord; output: OutputTail; electron: ElectronInstall };

/** Launches an Electron app with Playwright and waits for its first window. */
export async function startElectron(input: {
  appDir: string;
  entry?: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  leases: LeaseTable;
  operation?: string;
  leaseMs: number;
  parent?: string;
  linux: boolean;
  now?: () => number;
  timeoutMs?: number;
  wrap?: CommandWrapper;
  /** A private folder for the sandbox launcher script; `removeScratch` deletes it with the app's lease. */
  scratchDir?: string;
  removeScratch?: boolean;
}): Promise<StartedElectron> {
  const electron = findElectron(input.appDir);
  if (!electron) throw new CaptureError("unavailable", `No Electron in ${input.appDir}: install the app's dependencies first (npm install), so node_modules/electron is there.`);
  const args = [input.entry ?? ".", ...(input.args ?? [])];
  if (input.linux) args.unshift("--ozone-platform=x11");
  const leaseId = newLeaseId("app");
  let executablePath = electron.executablePath;
  let launchEnv: NodeJS.ProcessEnv = { ...input.env, [LEASE_ENV]: leaseId };
  if (input.wrap) {
    if (!input.scratchDir) throw new CaptureError("failed", "No folder for the sandbox launcher.");
    const wrapped = await input.wrap({ program: electron.executablePath, args: [], cwd: input.appDir, env: launchEnv });
    executablePath = await wrappedLauncher(join(input.scratchDir, "electron"), wrapped);
    launchEnv = wrapped.env ?? launchEnv;
  }
  const env = Object.fromEntries(Object.entries(launchEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  let app: ElectronApplication;
  try {
    app = await _electron.launch({ executablePath, args, cwd: input.appDir, env, timeout: input.timeoutMs ?? 30_000 });
  } catch (error) {
    throw new CaptureError("failed", `The Electron app did not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const child = app.process();
  const output = new OutputTail();
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const lease = input.leases.add({
    id: leaseId,
    kind: "app",
    pid: child.pid!,
    label: `Electron app in ${input.appDir}`,
    operation: input.operation,
    expiresAt: (input.now?.() ?? Date.now()) + input.leaseMs,
    parent: input.parent,
    ...(input.removeScratch && input.scratchDir ? { files: [input.scratchDir] } : {}),
  });
  let window: Page;
  try {
    window = await app.firstWindow({ timeout: input.timeoutMs ?? 30_000 });
    await window.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  } catch (error) {
    await input.leases.end(lease.id, "no window");
    throw new CaptureError("failed", `The Electron app opened no window: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n${output.text(20)}`);
  }
  return { app, window, lease, output, electron };
}
