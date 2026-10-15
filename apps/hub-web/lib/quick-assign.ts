import type { RunProfile } from "@ensemble/shared-types";
import { api, type AssignInput } from "./api";
import { defaultProfile, quickProfile } from "./run-profiles";

export function quickAssignInput(taskId: string, profile: RunProfile): AssignInput {
  const engine = profile.kind === "research" ? "ensemble" : profile.engine;
  const model = profile.model?.trim();
  const [provider, modelId] = model?.includes("::") ? model.split("::", 2) : [undefined, model];
  return {
    taskId, kind: profile.kind, engine,
    ...(model ? engine === "ensemble" ? { ...(provider ? { provider } : {}), model: modelId } : { model } : {}),
    ...(engine === "ensemble" && profile.effort !== "default" ? { reasoningEffort: profile.effort } : {}),
    instructions: profile.instructions, markDone: profile.markDone, network: profile.network,
    ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
    ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
    ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    ...(profile.kind === "code" ? {
      branchMode: profile.branchMode,
      ...(profile.branchMode === "new" ? { branch: `ensemble/task-${taskId.slice(0, 8)}-${Date.now().toString(36)}` } : {}),
      delivery: profile.delivery, askBeforePublish: profile.askBeforePublish,
      mode: profile.mode, sandbox: profile.sandbox, useCredentials: profile.useCredentials,
    } : {}),
  };
}

/** Read the saved default each time, then use the same assignment endpoint and trust checks as the full dialog. */
export async function quickAssignTask(taskId: string): Promise<{ jobId: string; profile: string }> {
  const [{ settings }, computers] = await Promise.all([api.settings(), api.devices()]);
  const profile = defaultProfile(settings.runProfiles, settings.defaultRunProfileId, quickProfile(settings.orchestration));
  const input = quickAssignInput(taskId, profile);
  if (input.deviceId && !computers.devices.some((device) => device.id === input.deviceId)) throw new Error("This profile's computer is no longer paired. Choose another in Assign.");
  if (!input.deviceId && (!computers.serverRunner || input.engine !== "ensemble")) {
    const device = computers.devices.find((row) => row.online) ?? computers.devices[0];
    if (!device) throw new Error("Pair a computer or choose where this task should run.");
    input.deviceId = device.id;
    input.useCredentials = false;
  }
  const result = await api.assign(input);
  return { ...result, profile: profile.name };
}
