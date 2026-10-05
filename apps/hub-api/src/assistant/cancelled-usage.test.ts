/**
 * Stopping a turn still writes a model.call row. Google has already counted it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import "../runtime/test-env.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { runAssistantTurn } from "./agent.js";
import { setAskRuntimeStreamForTests } from "../lib/model-turn.js";

function appWith(metrics: Array<{ kind?: string; payload?: Record<string, unknown> }>): FastifyInstance {
  const row = () => ({
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    create: async () => ({}),
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "metricEvent") {
          return {
            create: async (args: { data: { kind?: string; payload?: Record<string, unknown> } }) => {
              metrics.push(args.data);
              return args.data;
            },
          };
        }
        return row();
      },
    },
  );
  return {
    prisma,
    redis: {
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
      sadd: async () => 1,
      srem: async () => 1,
    },
    log: { error() {}, info() {} },
  } as unknown as FastifyInstance;
}

async function stoppedTurn(error: unknown): Promise<Array<{ kind?: string; payload?: Record<string, unknown> }>> {
  const metrics: Array<{ kind?: string; payload?: Record<string, unknown> }> = [];
  setAskRuntimeStreamForTests(async () => {
    throw error;
  });
  try {
    await runAssistantTurn({
      app: appWith(metrics),
      userId: "user-1",
      conversationId: "conv-stop",
      message: "What is on tomorrow",
      settings: DEFAULT_SETTINGS,
      model: "gemini-2.5-flash",
      provider: "google",
      emit() {},
    });
  } catch {
    // The ledger uses the process Prisma client. The usage row is written before that.
  } finally {
    setAskRuntimeStreamForTests(null);
  }
  return metrics;
}

test("a cancelled turn records the model and null token counts", async () => {
  const metrics = await stoppedTurn(Object.assign(new DOMException("Stopped", "AbortError")));
  const call = metrics.find((row) => row.kind === "model.call");
  assert.ok(call, "model.call was written");
  assert.equal(call?.payload?.model, "gemini-2.5-flash");
  assert.equal(call?.payload?.cancelled, true);
  assert.equal(call?.payload?.tokensIn, null);
  assert.equal(call?.payload?.tokensOut, null);
  assert.equal(call?.payload?.provider, "google");
});

test("a cancelled turn keeps token counts that already arrived", async () => {
  const error = Object.assign(new DOMException("Stopped", "AbortError"), {
    model: "gemini-2.5-flash",
    tokensIn: 18,
    tokensOut: 6,
  });
  const metrics = await stoppedTurn(error);
  const call = metrics.find((row) => row.kind === "model.call");
  assert.equal(call?.payload?.tokensIn, 18);
  assert.equal(call?.payload?.tokensOut, 6);
  assert.notEqual(call?.payload?.tokensIn, null);
  assert.equal(call?.payload?.model, "gemini-2.5-flash");
});
