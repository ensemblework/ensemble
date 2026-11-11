import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { beginActivity, endActivity, listActivities, updateActivity } from "./activity.js";
import { sseHub, type Listener } from "./sse.js";
import { runInScope } from "../sharing/context.js";

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

test("the activity status read distinguishes an unavailable store from confirmed idle", async () => {
  const redis = fakeRedis();
  const client = redis as unknown as Redis;
  redis.smembers = async () => { throw new Error("connection failed"); };
  await assert.rejects(listActivities(client, "user-1", true), /Activity could not be checked/);
  redis.smembers = async () => ["turn-1"];
  redis.mget = async () => { throw new Error("connection failed"); };
  await assert.rejects(listActivities(client, "user-1", true), /Activity could not be checked/);
});

function listen(channel: string, listener: Listener) {
  const messages: string[] = [];
  const raw = Object.assign(new EventEmitter(), { write: (text: string) => { messages.push(text); return true; } });
  const reply = { raw } as unknown as FastifyReply;
  sseHub.subscribe(channel, reply, listener);
  return { messages, close: () => raw.emit("close") };
}

test("activity starts, updates and ends reach only their owner and preserve another running turn", async () => {
  const redis = fakeRedis() as unknown as Redis;
  const owner = listen("activity-owner", { accountId: "activity-owner", owner: true });
  const member = listen("activity-owner", { accountId: "activity-member", owner: false });
  try {
    await beginActivity(redis, "activity-owner", { id: "first", kind: "assistant", label: "Private request" });
    await beginActivity(redis, "activity-owner", { id: "second", kind: "assistant", label: "Another request" });
    await updateActivity(redis, "activity-owner", "first", { detail: "Private tool result" });
    await endActivity(redis, "activity-owner", "first");
    assert.deepEqual((await listActivities(redis, "activity-owner")).map(row => row.id), ["second"]);
    assert.deepEqual(owner.messages.map(message => JSON.parse(message.split("data: ")[1]!.trim())), [
      { id: "first", phase: "started" }, { id: "second", phase: "started" },
      { id: "first", phase: "updated" }, { id: "first", phase: "ended" },
    ]);
    assert.ok(owner.messages.every(message => message.startsWith("event: activity.changed\n")));
    assert.equal(member.messages.length, 0);
    assert.equal(owner.messages.join("").includes("Private"), false, "invalidation frames contain no request or tool content");
  } finally { owner.close(); member.close(); }
});

test("a guest's activity reaches their personal stream, not the shared space's owner or peers", async () => {
  const redis = fakeRedis() as unknown as Redis;
  const guest = listen("activity-guest", { accountId: "activity-guest", personalOnly: true });
  const other = listen("activity-guest", { accountId: "activity-other", personalOnly: true });
  const owner = listen("activity-space", { accountId: "activity-owner", owner: true });
  const peer = listen("activity-space", { accountId: "activity-peer", owner: false });
  try {
    await runInScope({ spaceId: "activity-space", accountId: "activity-guest", access: { kind: "member", role: "editor", ownerId: "activity-owner" } }, async () => {
      await beginActivity(redis, "activity-space", { id: "guest-turn", kind: "assistant", label: "Private guest request" });
      await endActivity(redis, "activity-space", "guest-turn");
    });
    assert.equal(guest.messages.length, 2);
    assert.equal(other.messages.length, 0);
    assert.equal(owner.messages.length, 0);
    assert.equal(peer.messages.length, 0);
  } finally { guest.close(); other.close(); owner.close(); peer.close(); }
});

test("an owner's additional space addresses the account rather than the space id", async () => {
  const redis = fakeRedis() as unknown as Redis;
  const owner = listen("activity-extra-space", { accountId: "activity-account", owner: true });
  const member = listen("activity-extra-space", { accountId: "activity-member", owner: false });
  try {
    await runInScope({ spaceId: "activity-extra-space", accountId: "activity-account", access: { kind: "owner" } }, async () => {
      await beginActivity(redis, "activity-extra-space", { id: "owner-turn", kind: "assistant", label: "Private request" });
      await endActivity(redis, "activity-extra-space", "owner-turn");
    });
    assert.equal(owner.messages.length, 2);
    assert.equal(member.messages.length, 0);
  } finally { owner.close(); member.close(); }
});
