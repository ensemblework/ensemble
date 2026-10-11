/**
 * `ensemble sandbox`: this computer's OS sandbox, as the local runtime sees it.
 * The CLI and the desktop app share one runtime, so a sandbox set up from one
 * is the other's too.
 */
import { localJson, type Discovery } from "./sidecar.js";

export type SandboxCaps = {
  os: string;
  strength: "strong" | "reduced" | "advisory" | "ask";
  osSandbox: boolean;
  mechanism: string;
  reason: string;
  limits?: string[];
  networkOff?: boolean;
  setup?: { needed: boolean; how: string };
};

const NAMES: Record<string, string> = {
  seatbelt: "macOS sandbox (Seatbelt)",
  bubblewrap: "Linux sandbox (bubblewrap)",
  landlock: "Linux sandbox (Landlock)",
  windows: "Windows sandbox (sandbox account)",
};

export async function sandboxStatus(discovery: Discovery, refresh = false): Promise<SandboxCaps> {
  return (await localJson<{ sandbox: SandboxCaps }>(discovery, `/api/sandbox${refresh ? "?refresh=1" : ""}`)).sandbox;
}

export async function sandboxSetup(discovery: Discovery): Promise<{ ok: boolean; message: string; sandbox: SandboxCaps }> {
  try {
    return await localJson(discovery, "/api/sandbox/setup", { method: "POST", body: "{}" });
  } catch (error) {
    // 409: the step ran but the sandbox is still off (the person dismissed the Windows prompt, say).
    const body = (error as { body?: { ok?: boolean; message?: string; sandbox?: SandboxCaps } }).body;
    if (body?.sandbox) return { ok: false, message: body.message ?? "The sandbox is not on.", sandbox: body.sandbox };
    throw error;
  }
}

export function formatSandbox(caps: SandboxCaps): string[] {
  const lines = [`sandbox: ${caps.osSandbox ? (NAMES[caps.mechanism] ?? caps.mechanism) : "none"}`];
  lines.push(`  ${caps.reason}`);
  if (caps.osSandbox) lines.push(`  internet off is ${caps.networkOff ? "enforced" : "not enforced on this computer"}`);
  for (const limit of caps.limits ?? []) lines.push(`  not enforced: ${limit}`);
  if (!caps.osSandbox && caps.setup?.needed) lines.push(`  to turn it on: ${caps.setup.how}`);
  return lines;
}
