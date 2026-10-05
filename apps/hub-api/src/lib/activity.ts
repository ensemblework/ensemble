/**
 * Activity panel keys (docs/11).
 *
 * An assistant turn is the longest-running model work in hub-api. It appears
 * in the activity panel from the first millisecond and is checked for
 * cancellation at every step boundary.
 */
import { Redis } from "ioredis";

export type ActivityKind = "assistant" | "run" | "fetch" | "workspace";

export interface Activity {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  model?: string;
  conversationId?: string;
  startedAt: string;
}

const ttlSeconds = 60 * 30;

function activityKey(userId: string, activityId: string): string {
  return `ensemble:activity:${userId}:${activityId}`;
}

function cancelKey(userId: string, activityId: string): string {
  return `ensemble:cancel:${userId}:${activityId}`;
}

function pausedKey(userId: string): string {
  return `ensemble:paused:${userId}`;
}

/** Ids for this user. Listing is SMEMBERS, not KEYS. */
function indexKey(userId: string): string {
  return `ensemble:activity-ids:${userId}`;
}

async function safeGet(redis: Redis, key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function safeSet(redis: Redis, key: string, value: string, ttl = ttlSeconds): Promise<void> {
  try {
    await redis.set(key, value, "EX", ttl);
  } catch {
    // Activity is best-effort when Redis is down.
  }
}

async function safeDel(redis: Redis, key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    // ignore
  }
}

export async function beginActivity(
  redis: Redis,
  userId: string,
  activity: Omit<Activity, "startedAt">,
): Promise<void> {
  await safeSet(redis, activityKey(userId, activity.id), JSON.stringify({ ...activity, startedAt: new Date().toISOString() }));
  try {
    await redis.sadd(indexKey(userId), activity.id);
  } catch {
    // The value still expires on its own. The index is only a lookup.
  }
}

export async function updateActivity(
  redis: Redis,
  userId: string,
  activityId: string,
  patch: Partial<Pick<Activity, "label" | "detail">>,
): Promise<void> {
  const raw = await safeGet(redis, activityKey(userId, activityId));
  if (!raw) return;
  const current = JSON.parse(raw) as Activity;
  await safeSet(redis, activityKey(userId, activityId), JSON.stringify({ ...current, ...patch }));
}

export async function heartbeat(redis: Redis, userId: string, activityId: string): Promise<void> {
  const raw = await safeGet(redis, activityKey(userId, activityId));
  if (!raw) return;
  await safeSet(redis, activityKey(userId, activityId), raw);
}

export async function endActivity(redis: Redis, userId: string, activityId: string): Promise<void> {
  await safeDel(redis, activityKey(userId, activityId));
  await safeDel(redis, cancelKey(userId, activityId));
  try {
    await redis.srem(indexKey(userId), activityId);
  } catch {
    // ignore
  }
}

export async function activityIds(redis: Redis, userId: string): Promise<string[]> {
  try {
    return await redis.smembers(indexKey(userId));
  } catch {
    return [];
  }
}

/** Live rows. Expired values are dropped from the index so it does not grow. */
export async function listActivities(redis: Redis, userId: string): Promise<Activity[]> {
  const ids = await activityIds(redis, userId);
  if (ids.length === 0) return [];
  let values: Array<string | null>;
  try {
    values = await redis.mget(...ids.map((id) => activityKey(userId, id)));
  } catch {
    return [];
  }
  const stale: string[] = [];
  const activities: Activity[] = [];
  ids.forEach((id, index) => {
    const raw = values[index];
    if (!raw) {
      stale.push(id);
      return;
    }
    try {
      activities.push(JSON.parse(raw) as Activity);
    } catch {
      stale.push(id);
    }
  });
  if (stale.length > 0) {
    try {
      await redis.srem(indexKey(userId), ...stale);
    } catch {
      // The next list tries again.
    }
  }
  return activities;
}

export async function isCancelled(redis: Redis, userId: string, activityId: string): Promise<boolean> {
  return Boolean(await safeGet(redis, cancelKey(userId, activityId)));
}

export async function isPaused(redis: Redis, userId: string): Promise<boolean> {
  return Boolean(await safeGet(redis, pausedKey(userId)));
}

export async function requestCancel(redis: Redis, userId: string, activityId: string): Promise<void> {
  await safeSet(redis, cancelKey(userId, activityId), "1", 60);
}

/** The kill switch holds until someone presses Resume; it never times out on its own. */
export async function setPaused(redis: Redis, userId: string, paused: boolean): Promise<void> {
  if (!paused) return safeDel(redis, pausedKey(userId));
  try {
    await redis.set(pausedKey(userId), "1");
  } catch {
    // Redis down: the queue also checks in-process state.
  }
}
