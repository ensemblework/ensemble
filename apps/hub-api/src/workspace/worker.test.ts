/**
 * The agent queue recovers interrupted jobs on startup. That query used to be
 * an unhandled rejection, which kills Node, and the website then reports
 * ECONNREFUSED for every proxy to :4000.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { recoverServerJobs, startAgentQueue, tickServerQueue } from "./worker.js";

test("a database miss while recovering the agent queue does not crash the process", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);

  let finds = 0;
  let errors = 0;
  const app = {
    log: {
      error() {
        errors += 1;
      },
      info() {},
    },
    prisma: {
      workspaceJob: {
        findMany: async () => {
          finds += 1;
          if (finds === 1) throw new Error("Can't reach database server at 127.0.0.1:5432");
          return [];
        },
      },
    },
  } as unknown as FastifyInstance;

  const stop = startAgentQueue(app);
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(unhandled.length, 0);
    assert.equal(errors, 1);
    assert.ok(finds >= 2, "recover retries after the database miss");
  } finally {
    await stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the server queue does not claim or recover a device job", async () => {
  const calls: Array<{ op: string; where: unknown }> = [];
  const deviceJob = {
    id: "job-device",
    userId: "user-1",
    deviceId: "device-1",
    status: "queued",
    resourceKeys: [] as string[],
    continueFromJobId: null,
  };
  const app = {
    log: { error() {}, info() {} },
    prisma: {
      workspaceJob: {
        findMany: async (args: { where?: unknown }) => {
          calls.push({ op: "findMany", where: args.where });
          return [deviceJob];
        },
        update: async () => {
          calls.push({ op: "update", where: null });
          return deviceJob;
        },
        updateMany: async (args: { where?: unknown }) => {
          calls.push({ op: "updateMany", where: args.where });
          return { count: 1 };
        },
      },
    },
    redis: {},
  } as unknown as FastifyInstance;

  await recoverServerJobs(app);
  assert.equal(calls.some((call) => call.op === "update"), false);
  assert.equal((calls.find((call) => call.op === "findMany")?.where as { deviceId?: unknown }).deviceId, null);

  calls.length = 0;
  const stop = startAgentQueue(app);
  stop();
  await tickServerQueue();
  const wheres = calls.filter((call) => call.op === "findMany").map((call) => call.where as { deviceId?: unknown; status?: string });
  assert.ok(wheres.length >= 1);
  assert.ok(wheres.every((where) => where.deviceId === null));
  assert.ok(wheres.some((where) => where.status === "queued"));
  assert.equal(calls.some((call) => call.op === "updateMany" || call.op === "update"), false);
});
