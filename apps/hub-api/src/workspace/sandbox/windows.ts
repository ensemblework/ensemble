/**
 * Windows sandbox: Anthropic's sandbox-runtime (Apache-2.0, pinned), the
 * same building blocks Claude Code uses on Windows. No Docker, no VM, no
 * Hyper-V, so Windows Home works.
 *
 * Setup is one admin prompt per computer (`setupWindowsSandbox`). It creates
 * a hidden local account, `srt-sandbox`, and a Windows Filtering Platform
 * rule set that lets that account reach only a loopback proxy port range.
 * The CLI and the desktop app share it: it belongs to the computer, not to an
 * install, so whichever is installed second finds it already done.
 *
 * Each command then runs as that account with a restricted token inside a
 * job object. The account cannot read the person's profile at all; Ensemble
 * grants it the work folder and the cache (write) and the toolchain folders
 * on PATH (read). With the network on, traffic goes through a local proxy
 * that allows every public host; with it off there is no proxy, so the fence
 * blocks everything.
 *
 * Grants are added with an inheriting permission entry for the sandbox
 * account only, refcounted by sandbox-runtime, and removed when the runtime
 * exits. The person's own permissions are never changed.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, win32 } from "node:path";
import type { SandboxPolicy, SpawnCommand } from "./policy.js";

type Srt = typeof import("@anthropic-ai/sandbox-runtime");
// Not re-exported from the package index; the module is part of the pinned version's public files.
type SrtWrap = typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js");
type SrtWin = ReturnType<Srt["resolveSrtWin"]>;

export type WindowsState =
  | { ready: true; sid: string; srtWin: SrtWin }
  | { ready: false; reason: string; setupNeeded: boolean };

let srt: Srt | null = null;
let wrap: SrtWrap["wrapCommandWithSandboxWindows"] | null = null;
let srtWin: SrtWin | null = null;
let network: Promise<{ http?: number; socks?: number; token?: string }> | null = null;
let grantedHolder: string | null = null;

async function load(): Promise<{ mod: Srt; win: SrtWin }> {
  srt ??= await import("@anthropic-ai/sandbox-runtime");
  wrap ??= (await import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js")).wrapCommandWithSandboxWindows;
  srtWin ??= srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  return { mod: srt, win: srtWin };
}

export async function probeWindows(): Promise<WindowsState> {
  let loaded: { mod: Srt; win: SrtWin };
  try {
    loaded = await load();
  } catch (error) {
    return { ready: false, setupNeeded: false, reason: `The Windows sandbox component is missing from this install (${error instanceof Error ? error.message : String(error)}).` };
  }
  try {
    const status = loaded.mod.checkWindowsSandboxStatus({ srtWin: loaded.win });
    if (!status.user.provisioned || !status.user.sid || !status.user.credPresent || status.wfp.state === "absent") {
      return { ready: false, setupNeeded: true, reason: "The Windows sandbox is not set up on this computer yet. Setting it up asks Windows for permission once." };
    }
    return { ready: true, sid: status.user.sid, srtWin: loaded.win };
  } catch (error) {
    return { ready: false, setupNeeded: true, reason: `Could not check the Windows sandbox (${error instanceof Error ? error.message : String(error)}).` };
  }
}

/** One admin prompt. Idempotent; safe to run from the CLI or the app, whichever comes first. */
export async function setupWindowsSandbox(): Promise<{ ok: boolean; message: string }> {
  const { mod, win } = await load();
  const result = await mod.installWindowsSandboxAsync({ srtWin: win });
  if (result.cancelled) return { ok: false, message: "Windows did not get permission, so the sandbox is not set up. Try again when you can approve the prompt." };
  if (!result.user.provisioned) return { ok: false, message: "The sandbox account could not be created." };
  return { ok: true, message: "The Windows sandbox is set up for this computer." };
}

/**
 * The proxy for network-on commands: sandbox-runtime's own HTTP and SOCKS
 * proxy, listening inside the port range the fence allows. Every public host
 * is allowed (the run asked for the internet); the proxy itself still refuses
 * loopback, link-local and cloud-metadata addresses.
 */
export async function windowsNetwork(): Promise<{ http?: number; socks?: number; token?: string }> {
  network ??= (async () => {
    const { mod, win } = await load();
    await mod.SandboxManager.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        windows: { srtWin: { path: win.exe } },
      } as Parameters<Srt["SandboxManager"]["initialize"]>[0],
      async () => true,
    );
    return { http: mod.SandboxManager.getProxyPort(), socks: mod.SandboxManager.getSocksProxyPort(), token: mod.SandboxManager.getProxyAuthToken() };
  })().catch((error: unknown) => {
    network = null;
    throw error;
  });
  return network;
}

function covers(root: string, candidate: string): boolean {
  const rel = win32.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
}

/** Toolchain folders on PATH that live under the person's profile (nvm-windows, per-user Python, Scoop). Read only. */
export function windowsToolchainReads(path: string, home: string, denies: string[], exists: (path: string) => boolean = existsSync): string[] {
  const found: string[] = [];
  for (const dir of path.split(";")) {
    if (!dir || !win32.isAbsolute(dir) || !covers(home, dir) || dir === home) continue;
    const top = win32.relative(home, dir).split(/[\\/]/)[0] ?? "";
    if (top.startsWith(".") && ![".cargo", ".rustup", ".bun", ".deno", ".local"].includes(top)) continue;
    if (denies.some((deny) => covers(deny, dir) || covers(dir, deny))) continue;
    if (exists(dir) && !found.includes(dir)) found.push(dir);
  }
  return found;
}

/** MSVCRT quoting: what CreateProcess's command-line parser undoes. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(slashes) + char;
    }
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** cmd.exe line for a `.cmd`/`.bat` program, escaped the way cross-spawn does it. */
export function cmdLine(program: string, args: string[]): string {
  const require = createRequire(import.meta.url);
  const escape = require("cross-spawn/lib/util/escape.js") as { command: (value: string) => string; argument: (value: string, doubleEscape?: boolean) => string };
  // npm-installed shims (`node_modules/.bin/*.cmd`) pass arguments on through a second cmd.
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(program);
  return [escape.command(win32.normalize(program)), ...args.map((arg) => escape.argument(arg, shim))].join(" ");
}

export function windowsSpawn(
  policy: SandboxPolicy,
  cmd: SpawnCommand,
  env: NodeJS.ProcessEnv,
  state: { sid: string; srtWin: SrtWin },
  proxy: { http?: number; socks?: number; token?: string } | null,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!srt || !wrap) throw new Error("The Windows sandbox was not loaded. Call prepareSandbox() first.");
  const home = policy.home || homedir();
  const denies = [...policy.deny, policy.appDataDir, policy.ensembleSource];
  for (const grant of [...policy.readWrite, ...policy.readOnly]) {
    if (grant === home || covers(grant, home)) throw new Error(`The sandbox will not grant ${grant}: it contains the home folder.`);
    for (const deny of denies) if (covers(grant, deny)) throw new Error(`The sandbox will not grant ${grant}: it contains ${deny}.`);
  }
  const reads = [...policy.readOnly, ...windowsToolchainReads(env.PATH ?? env.Path ?? "", home, denies), ...(policy.toolchainReads ?? [])];
  if (isAbsolute(cmd.program) && covers(home, cmd.program) && !denies.some((deny) => covers(deny, cmd.program))) reads.push(dirname(cmd.program));
  srt.grantWindowsAcl({ write: policy.readWrite, read: [...new Set(reads)], sandboxUserSid: state.sid, srtWin: state.srtWin });
  grantedHolder = state.sid;
  const lower = basename(cmd.program).toLowerCase();
  const viaCmd = lower.endsWith(".cmd") || lower.endsWith(".bat") || cmd.args.length === 0;
  const binShell = viaCmd ? srt.parseWindowsBinShell("cmd") : { exe: win32.normalize(cmd.program), args: cmd.args.slice(0, -1) };
  const command = viaCmd ? cmdLine(cmd.program, cmd.args) : cmd.args[cmd.args.length - 1]!;
  const wrapped = wrap({
    command,
    cwd: policy.cwd,
    srtWin: state.srtWin,
    binShell,
    setEnvVars: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    allowWrite: policy.readWrite,
    quiet: true,
    ...(policy.network === "outbound" && proxy ? { httpProxyPort: proxy.http, socksProxyPort: proxy.socks, proxyAuthToken: proxy.token } : {}),
  });
  const [program, ...args] = wrapped.argv;
  return { command: program!, args, env: wrapped.env };
}

/** Removes this runtime's grants. Called when the runtime stops. */
export function releaseWindowsGrants(): void {
  if (!srt || !srtWin || !grantedHolder) return;
  try {
    srt.revokeWindowsAcl({ sandboxUserSid: grantedHolder, srtWin });
  } catch {
    // best effort: sandbox-runtime also drops holds whose process is gone
  }
  grantedHolder = null;
}
