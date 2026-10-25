/**
 * What an ACP agent offers on this computer, asked the way a run asks it: start the agent, open a
 * session in an empty folder, and read its session options (the models it offers on this account,
 * with the thinking levels of the current one). A session that cannot start for want of a sign-in
 * means signed out. Nothing is sent to a model.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { orderLevels, type AcpEngine, type SubscriptionModel } from "@ensemble/shared-types";
import { ACP_AGENTS, configChoices, type ConfigOption, stopProcess } from "../workspace/engines/acp.js";
import { RpcConnection } from "../workspace/engines/rpc.js";
import { SIGNED_OUT } from "../workspace/engines/registry.js";

export type AcpProbe = { signedIn: boolean | null; models: SubscriptionModel[]; problem: string | null };

type Choice = { value?: string; name?: string; description?: string; options?: Choice[] };

/** The models an agent's session options list, the current one marked default, each with the levels it lists. */
export function acpModels(config: ConfigOption[], legacy?: { availableModels?: Array<{ modelId?: string; name?: string; description?: string }>; currentModelId?: string }): SubscriptionModel[] {
  const { model, thought } = configChoices(config);
  const efforts = orderLevels(((thought?.options ?? []) as Choice[]).flatMap((choice) => (choice.options ?? [choice])).map((choice) => choice.value ?? "").filter(Boolean));
  const fromConfig = ((model?.options ?? []) as Choice[]).flatMap((choice) => (choice.options ?? [choice])).filter((choice): choice is Choice & { value: string } => typeof choice.value === "string" && Boolean(choice.value));
  const rows = fromConfig.length
    ? fromConfig.map((choice) => ({ id: choice.value, label: choice.name || choice.value, description: choice.description, current: choice.value === model?.currentValue }))
    : (legacy?.availableModels ?? []).filter((row) => row.modelId).map((row) => ({ id: row.modelId!, label: row.name || row.modelId!, description: row.description, current: row.modelId === legacy?.currentModelId }));
  return rows.slice(0, 120).map((row) => ({
    id: row.id.slice(0, 120),
    label: row.label.slice(0, 120),
    ...(row.current ? { isDefault: true } : {}),
    // ACP lists the levels of the session's current model only.
    ...(row.current && efforts.length ? { efforts: efforts.slice(0, 10) } : {}),
    ...(row.description ? { description: row.description.slice(0, 240) } : {}),
  }));
}

export async function acpProbe(id: AcpEngine, timeoutMs = 25_000): Promise<AcpProbe | null> {
  const folder = await mkdtemp(join(tmpdir(), "ensemble-probe-"));
  try {
    const launch = await ACP_AGENTS[id].launch({ root: folder, sandboxed: false, trusted: false });
    if (!launch) return null;
    const child = spawn(launch.program, launch.args, { cwd: folder, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    child.stdin.on("error", () => undefined);
    child.on("error", () => undefined);
    const rpc = new RpcConnection((line) => child.stdin.writable && void child.stdin.write(line), { jsonrpc: true });
    rpc.onRequest = async () => {
      throw new Error("Not during a check.");
    };
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => void rpc.receive(line));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.once("close", () => rpc.close(`It stopped. ${stderr.trim().split("\n").slice(-2).join(" ")}`.trim()));
    const timer = setTimeout(() => rpc.close("It did not answer in time."), timeoutMs);
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ensemble", version: "1" }, ...(launch.initializeMeta ? { _meta: launch.initializeMeta } : {}) });
      if (launch.authMethod) await rpc.request("authenticate", { methodId: launch.authMethod });
      const session = await rpc.request("session/new", { cwd: folder, mcpServers: [] });
      const config = Array.isArray(session.configOptions) ? (session.configOptions as ConfigOption[]) : [];
      return { signedIn: true, models: acpModels(config, session.models as Parameters<typeof acpModels>[1]), problem: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (SIGNED_OUT.test(message) || /auth/i.test(message)) return { signedIn: false, models: [], problem: null };
      return { signedIn: null, models: [], problem: `It did not answer: ${message.slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
      stopProcess(child);
    }
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
