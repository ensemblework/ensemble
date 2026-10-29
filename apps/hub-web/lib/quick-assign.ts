import type { RunProfile } from "@ensemble/shared-types";
import { api, type AssignInput } from "./api";
import { engineAssign } from "./engine-models";
import { defaultProfile, quickProfile } from "./run-profiles";

export function quickAssignInput(taskId: string, profile: RunProfile): AssignInput {
  const engine = profile.engine;
  const model = profile.model?.trim();
  const [provider, modelId] = model?.includes("::") ? model.split("::", 2) : [undefined, model];
  return {
    taskId,
    ...(engine === "ensemble"
      ? { engine, ...(model ? { ...(provider ? { provider } : {}), model: modelId } : {}), ...(model && profile.effort !== "default" ? { reasoningEffort: profile.effort } : {}) }
      : engineAssign(engine, { model: model ?? "", effort: profile.effort, context: profile.context, fast: profile.fast })),
    instructions: profile.instructions, markDone: profile.markDone, network: profile.network,
    ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
    ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
    ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    branchMode: profile.branchMode,
    ...(profile.branchMode === "new" ? { branch: `ensemble/task-${taskId.slice(0, 8)}-${Date.now().toString(36)}` } : {}),
    delivery: profile.delivery, askBeforePublish: profile.askBeforePublish,
    mode: profile.mode, sandbox: profile.sandbox, useCredentials: profile.useCredentials,
    // The saved secrets the profile names: the run gets only those on the computer.
    ...(profile.secrets?.length ? { secrets: profile.secrets } : {}),
    // The server makes the rest consistent: commits allowed, the internet on.
    ...(profile.pullRequest ? { pullRequest: { base: profile.pullRequest.base, merge: profile.pullRequest.merge }, delivery: "commit" as const, network: true } : {}),
  };
}

/**
 * Read the saved default each time, then use the same assignment endpoint and checks as the full
 * dialog. Where it runs: the profile's computer, else this server when it runs code, else a paired
 * computer; Ensemble's agent with no computer anywhere researches and writes on the server.
 */
export async function quickAssignTask(taskId: string): Promise<{ jobId: string; profile: string }> {
  const [{ settings }, computers] = await Promise.all([api.settings(), api.devices()]);
  const profile = defaultProfile(settings.runProfiles, settings.defaultRunProfileId, quickProfile(settings.orchestration));
  const input = quickAssignInput(taskId, profile);
  if (input.deviceId && !computers.devices.some((device) => device.id === input.deviceId)) throw new Error("This profile's computer is no longer paired. Choose another in Assign.");
  if (!input.deviceId && (!computers.serverRunner || input.engine !== "ensemble")) {
    const device = computers.devices.find((row) => row.online) ?? computers.devices[0];
    if (device) {
      input.deviceId = device.id;
      input.useCredentials = false;
    } else if (input.engine !== "ensemble") {
      throw new Error("Pair a computer to run your own coding agent: Settings → Devices.");
    }
  }
  const result = await api.assign(input);
  return { ...result, profile: profile.name };
}
