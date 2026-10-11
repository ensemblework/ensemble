/**
 * The only place an agent command or a plot is started.
 *
 * `prepareSandbox()` runs once when the runtime starts: it finds which
 * OS-native sandbox works on this computer (Seatbelt on macOS; bubblewrap or
 * Landlock on Linux; the sandbox account on Windows). `capabilities()` then
 * answers synchronously, and `startSandboxed` applies that backend to every
 * confined spawn. When this computer has no working sandbox, a confined spawn
 * is refused with the reason; a caller that passes `advisoryOk` (plots) runs
 * unsandboxed and is told that this is not safe. Nothing falls back silently.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { bubblewrapArgs, landrunArgs, probeLinux, type LinuxBackend } from "./linux.js";
import type { PlatformCaps, PreparedSpawn, SandboxPolicy, SpawnCommand } from "./policy.js";
import { scrubAgentEnv } from "./scrub.js";
import { compileSeatbeltProfile, nodeToolchainRead } from "./seatbelt.js";
import { cmdLine, probeWindows, releaseWindowsGrants, setupWindowsSandbox, windowsNetwork, windowsSpawn, type WindowsState } from "./windows.js";

let linux: LinuxBackend | null = null;
// windows.ts loads sandbox-runtime itself, on Windows only.
let windows: WindowsState | null = null;
let windowsProxy: { http?: number; socks?: number; token?: string } | null = null;
let preparing: Promise<PlatformCaps> | null = null;

const MAC: PlatformCaps = {
  os: "darwin",
  strength: "strong",
  osSandbox: true,
  mechanism: "seatbelt",
  networkOff: true,
  reason: "macOS sandbox (Seatbelt). Writes stay in the work folder; the home folder, keys, Unix sockets, LaunchServices and Ensemble's data are denied.",
};

function linuxCaps(state: LinuxBackend | null): PlatformCaps {
  if (!state) {
    return { os: "linux", strength: "advisory", osSandbox: false, mechanism: "none", reason: "Checking which Linux sandbox works on this computer." };
  }
  if (state.backend === "bubblewrap") {
    return {
      os: "linux",
      strength: "strong",
      osSandbox: true,
      mechanism: "bubblewrap",
      networkOff: true,
      reason: "Linux sandbox (bubblewrap). The system is read-only, the home folder is hidden except the work folder and toolchains, /tmp is private, and the network can be cut off.",
    };
  }
  if (state.backend === "landlock") {
    const limits = ["Unix sockets (for example ssh-agent) are not hidden"];
    if (!state.networkOff) limits.unshift("this kernel cannot turn the network off (needs Linux 6.7 or later)");
    return {
      os: "linux",
      strength: "reduced",
      osSandbox: true,
      mechanism: "landlock",
      networkOff: state.networkOff,
      limits,
      reason: `Linux sandbox (Landlock). Writes stay in the work folder; the home folder, keys and Ensemble's data are unreadable. Not enforced here: ${limits.join("; ")}.`,
    };
  }
  return { os: "linux", strength: "advisory", osSandbox: false, mechanism: "none", reason: state.reason };
}

function windowsCaps(state: WindowsState | null): PlatformCaps {
  if (state?.ready) {
    return {
      os: "win32",
      strength: "strong",
      osSandbox: true,
      mechanism: "windows",
      networkOff: true,
      limits: ["programs installed only for your account must be on PATH to be found", "the work folder must be on a local drive"],
      reason: "Windows sandbox. Commands run as a separate sandbox account that can't read your profile, write only in the work folder, and reach the internet only when the run allows it.",
    };
  }
  return {
    os: "win32",
    strength: "advisory",
    osSandbox: false,
    mechanism: "none",
    reason: state?.reason ?? "Checking the Windows sandbox on this computer.",
    setup: { needed: state ? state.setupNeeded : true, how: "Run `ensemble sandbox setup`, or press Set up in Ensemble → Settings → This computer. Windows asks for permission once." },
  };
}

export function capabilities(platform: string = process.platform): PlatformCaps {
  if (platform === "darwin") return MAC;
  if (platform === "linux") return linuxCaps(linux);
  if (platform === "win32") return windowsCaps(windows);
  return { os: platform, strength: "advisory", osSandbox: false, mechanism: "none", reason: `This system (${platform}) has no supported sandbox.` };
}

/** Find this computer's sandbox. Cached; `refresh` re-runs the check (after setup, say). */
export function prepareSandbox(options: { refresh?: boolean } = {}): Promise<PlatformCaps> {
  if (preparing && !options.refresh) return preparing;
  preparing = (async () => {
    if (process.platform === "linux") linux = probeLinux();
    if (process.platform === "win32") windows = await probeWindows();
    return capabilities();
  })();
  return preparing;
}

/** Turns the sandbox on where one step is needed: Windows asks for admin permission once. */
export async function setupSandbox(): Promise<{ ok: boolean; message: string; caps: PlatformCaps }> {
  if (process.platform === "win32") {
    const result = await setupWindowsSandbox();
    const caps = await prepareSandbox({ refresh: true });
    return { ...result, caps };
  }
  const caps = await prepareSandbox({ refresh: true });
  return { ok: caps.osSandbox, message: caps.reason, caps };
}

/** Network-on commands on Windows go through sandbox-runtime's proxy. Start it before such a run. */
export async function prepareNetwork(): Promise<void> {
  if (process.platform !== "win32" || !windows?.ready || windowsProxy) return;
  windowsProxy = await windowsNetwork();
}

export function prepareSpawn(policy: SandboxPolicy, cmd: SpawnCommand, platform = process.platform): PreparedSpawn {
  const caps = capabilities(platform);
  const env = scrubAgentEnv(policy.env, policy.who);
  if (policy.confined && caps.osSandbox) {
    if (platform === "darwin") {
      const toolchain = nodeToolchainRead(policy.home);
      const profile = compileSeatbeltProfile({
        home: policy.home,
        readWrite: policy.readWrite,
        readOnly: policy.readOnly,
        deny: [...policy.deny, policy.appDataDir],
        network: policy.network,
        who: policy.who,
        ensembleSource: policy.ensembleSource,
        askpassPath: policy.askpassPath,
        toolchainReads: [...(policy.toolchainReads ?? []), ...(toolchain ? [toolchain] : [])],
        extraExecDeny: policy.extraExecDeny,
      });
      return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, cmd.program, ...cmd.args], env, sandboxed: true, caps };
    }
    if (platform === "linux" && linux?.backend === "bubblewrap") {
      return { command: linux.bwrap, args: bubblewrapArgs(policy, cmd), env, sandboxed: true, caps };
    }
    if (platform === "linux" && linux?.backend === "landlock") {
      if (policy.network !== "outbound" && !linux.networkOff && !policy.advisoryOk) {
        throw new Error("This run has the internet off, and this Linux kernel cannot enforce that inside the sandbox (needs Linux 6.7 or later). Turn the internet on for the run, or turn the sandbox off.");
      }
      return { command: linux.landrun, args: landrunArgs(policy, cmd, env), env, sandboxed: true, caps };
    }
    if (platform === "win32" && windows?.ready) {
      if (policy.network === "outbound" && !windowsProxy) throw new Error("The Windows sandbox's internet proxy is not running yet. Start the run again.");
      const prepared = windowsSpawn(policy, cmd, env, windows, windowsProxy);
      return { ...prepared, sandboxed: true, caps };
    }
  }
  if (policy.confined && !policy.advisoryOk) {
    throw new Error(caps.setup?.needed ? `${caps.reason} ${caps.setup.how}` : caps.reason);
  }
  // Windows cannot start a .cmd or .bat directly (npm, npx, pnpm are shims): go through cmd.exe, escaped like cross-spawn.
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cmd.program)) {
    const comspec = process.env.ComSpec || `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`;
    return { command: comspec, args: ["/d", "/s", "/c", `"${cmdLine(cmd.program, cmd.args)}"`], env, sandboxed: false, caps, windowsVerbatimArguments: true };
  }
  return { command: cmd.program, args: cmd.args, env, sandboxed: false, caps };
}

/** Apply the policy and start the process. This is the choke point. */
export function startSandboxed(
  policy: SandboxPolicy,
  cmd: SpawnCommand,
  options: { detached?: boolean; stdin?: "ignore" | "pipe" } = {},
): { child: ChildProcess; prepared: PreparedSpawn } {
  const prepared = prepareSpawn(policy, cmd);
  const windows = process.platform === "win32";
  const child = spawn(prepared.command, prepared.args, {
    cwd: policy.cwd,
    env: prepared.env,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    // Windows has no process groups: a detached child would get its own console window.
    detached: windows ? false : (options.detached ?? true),
    windowsHide: true,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
  return { child, prepared };
}

/** Removes per-runtime grants (Windows folder permissions for the sandbox account). */
export async function releaseSandbox(): Promise<void> {
  if (process.platform === "win32") releaseWindowsGrants();
}
