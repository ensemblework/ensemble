/**
 * The only place an agent command or a plot is started.
 *
 * `startSandboxed` is the sidecar stand-in for the Rust core. On macOS it
 * execs `/usr/bin/sandbox-exec` with the profile from `seatbelt.ts`. On Linux
 * and Windows there is no helper yet: a confined job is refused, and a caller
 * that passes `advisoryOk` runs unsandboxed and is told that this is not safe.
 * Step 4 replaces the Linux branch with `ensemble-sbx` without changing `SandboxPolicy`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { PlatformCaps, PreparedSpawn, SandboxPolicy, SpawnCommand } from "./policy.js";
import { scrubAgentEnv } from "./scrub.js";
import { compileSeatbeltProfile, nodeToolchainRead } from "./seatbelt.js";

export function capabilities(platform = process.platform): PlatformCaps {
  if (platform === "darwin") {
    return {
      os: "darwin",
      strength: "strong",
      osSandbox: true,
      mechanism: "seatbelt",
      reason: "macOS Seatbelt. $HOME, Unix sockets, LaunchServices, and the app-data folder are denied.",
    };
  }
  if (platform === "linux") {
    return {
      os: "linux",
      strength: "advisory",
      osSandbox: false,
      mechanism: "none",
      reason: "Linux has no OS sandbox yet (desktop step 4). Commands use the argv allow-list and the folder jail only. This is not safe.",
    };
  }
  return {
    os: platform,
    strength: "ask",
    osSandbox: false,
    mechanism: "none",
    reason: "This system has no OS sandbox yet. Windows v1 is Ask mode or WSL2, and neither is a filesystem sandbox.",
  };
}

export function prepareSpawn(policy: SandboxPolicy, cmd: SpawnCommand, platform = process.platform): PreparedSpawn {
  const caps = capabilities(platform);
  const env = scrubAgentEnv(policy.env, policy.who);
  if (platform === "darwin" && policy.confined) {
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
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", profile, cmd.program, ...cmd.args],
      env,
      sandboxed: true,
      caps,
    };
  }
  if (policy.confined && !policy.advisoryOk) {
    throw new Error(caps.reason);
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
  const child = spawn(prepared.command, prepared.args, {
    cwd: policy.cwd,
    env: prepared.env,
    detached: options.detached ?? true,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
  return { child, prepared };
}
