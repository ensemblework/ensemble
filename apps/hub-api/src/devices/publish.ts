import { sseHub } from "../lib/sse.js";

export type DeviceFrame = "job.queued" | "job.cancel" | "decision.answered";

/**
 * The answer the computer already reads on the decision poll.
 * `reason` is the chosen option for a question, and null for a permission.
 */
export type DeviceAnswer = {
  decision: "allow" | "deny";
  scope: string;
  reason: string | null;
};

/**
 * Wake-up on the device stream. The computer still calls claim or the long-poll.
 * `job.queued` and `job.cancel` stay `{id}`. `decision.answered` also carries the
 * poll fields, including `reason`.
 */
export function publishDevice(deviceId: string, event: DeviceFrame, id: string, answer?: DeviceAnswer): void {
  const data =
    event === "decision.answered"
      ? { id, status: "decided" as const, decision: answer?.decision ?? null, scope: answer?.scope ?? "once", reason: answer?.reason ?? null }
      : { id };
  sseHub.publish(`device:${deviceId}`, { event, data });
}

/** Browser invalidation. `device` refreshes the device list and the workspace. */
export function publishBrowserDevice(userId: string, deviceId: string): void {
  sseHub.publish(userId, { event: "device", data: { id: deviceId } });
}
