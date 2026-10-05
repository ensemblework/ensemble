import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { beginActivity, endActivity, listActivities } from "./activity.js";

function fakeRedis() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const commands: string[] = [];
  const redis = {
    commands,
    async set(key: string, value: string) {
      commands.push("SET");
      values.set(key, value);
      return "OK";
    },
    async get(key: string) {
      commands.push("GET");
      return values.get(key) ?? null;
    },
    async del(key: string) {
      commands.push("DEL");
      values.delete(key);
      return 1;
    },
    async sadd(key: string, member: string) {
      commands.push("SADD");
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    },
    async srem(key: string, ...members: string[]) {
      commands.push("SREM");
      const set = sets.get(key);
      for (const member of members) set?.delete(member);
      return members.length;
    },
    async smembers(key: string) {
      commands.push("SMEMBERS");
      return [...(sets.get(key) ?? [])];
    },
    async mget(...keys: string[]) {
      commands.push("MGET");
      return keys.map((key) => values.get(key) ?? null);
    },
    keys() {
      throw new Error("KEYS scans the whole database");
    },
  };
  return redis;
}

test("activity listing uses the id set and never KEYS", async () => {
  const redis = fakeRedis();
  const client = redis as unknown as Redis;
  await beginActivity(client, "user-1", { id: "turn-1", kind: "assistant", label: "Draft" });
  await beginActivity(client, "user-1", { id: "turn-2", kind: "assistant", label: "Gone" });
  await endActivity(client, "user-1", "turn-2");
  redis.commands.length = 0;
  const rows = await listActivities(client, "user-1");
  assert.deepEqual(rows.map((row) => row.id), ["turn-1"]);
  assert.deepEqual(redis.commands, ["SMEMBERS", "MGET"]);
  assert.equal(redis.commands.includes("KEYS"), false);
});

test("an expired value is removed from the index", async () => {
  const redis = fakeRedis();
  const client = redis as unknown as Redis;
  await beginActivity(client, "user-1", { id: "turn-1", kind: "fetch", label: "Mail" });
  await redis.del("ensemble:activity:user-1:turn-1");
  const rows = await listActivities(client, "user-1");
  assert.deepEqual(rows, []);
  assert.deepEqual(await redis.smembers("ensemble:activity-ids:user-1"), []);
});
