/**
 * The desktop recordings a node has going (docs/35 §6.4): one it started with desktop_record is its own until
 * it saves or discards it, and a stop discards it (node/stop.ts). Kept per node in Redis, by computer and the
 * mission it was made for (node/device-tools.ts `missionOf`), which name it on the computer.
 */
export type Recording = { deviceId: string; mission: string };

type Sets = {
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
};

const key = (nodeId: string) => `ensemble:node:recordings:${nodeId}`;
const member = (where: Recording) => JSON.stringify({ deviceId: where.deviceId, mission: where.mission });

export async function recordingStarted(redis: Sets, nodeId: string, where: Recording): Promise<void> {
  await redis.sadd(key(nodeId), member(where));
}

export async function recordingEnded(redis: Sets, nodeId: string, where: Recording): Promise<void> {
  await redis.srem(key(nodeId), member(where));
}

export async function recordingsOf(redis: Sets, nodeId: string): Promise<Recording[]> {
  return (await redis.smembers(key(nodeId))).flatMap((raw) => {
    try {
      const row = JSON.parse(raw) as Partial<Recording>;
      return typeof row.deviceId === "string" && typeof row.mission === "string" ? [{ deviceId: row.deviceId, mission: row.mission }] : [];
    } catch {
      return [];
    }
  });
}
