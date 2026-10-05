/**
 * A socket that dies before response headers is the dropped-connection notice.
 * Reverting the catch in agent.ts that maps that failure must fail this test:
 * "fetch failed" and the raw socket text must not be saved, streamed, or sent back.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import "../runtime/test-env.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { prisma } from "../lib/prisma.js";
import { setAskRuntimeStreamForTests, type ModelMessage } from "../lib/model-turn.js";
import { setCredentialResolverForTests } from "../runtime/credentials.js";
import { resetBuckets, setPaceRedisForTests, setRuntimeSleepForTests } from "../runtime/pace.js";
import { runAssistantTurn } from "./agent.js";
import { CONNECTION_DROPPED_NOTICE } from "./cutoff.js";

const RAW = ["fetch failed", "Server disconnected", "ECONNRESET", "socket hang up", "other side closed", "terminated", "und_err_socket"];

function containsRaw(text: string): string | null {
  const lower = text.toLowerCase();
  return RAW.find((needle) => lower.includes(needle.toLowerCase())) ?? null;
}

function dropBeforeHeaders(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.resume();
    socket.on("data", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("drop server has no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function appWith(saved: Array<{ role: string; content: string; toolCalls: unknown[] }>): FastifyInstance {
  const empty = () => ({
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    create: async () => ({}),
  });
  const prismaProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "assistantMessage") {
          return {
            findMany: async () => [...saved].reverse(),
            findFirst: async () => null,
            create: async () => ({}),
          };
        }
        if (prop === "metricEvent") return { create: async () => ({}) };
        return empty();
      },
    },
  );
  return {
    prisma: prismaProxy,
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

function stubLedger(): () => void {
  const audit = prisma.auditLedger as unknown as {
    findFirst: (...args: unknown[]) => Promise<unknown>;
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const findFirst = audit.findFirst;
  const create = audit.create;
  audit.findFirst = async () => null;
  audit.create = async () => ({ id: "test-ledger" });
  return () => {
    audit.findFirst = findFirst;
    audit.create = create;
  };
}

test("a socket closed before response headers is not saved, streamed, or sent next turn", async () => {
  const drop = await dropBeforeHeaders();
  const saved: Array<{ role: string; content: string; toolCalls: unknown[] }> = [];
  const frames: string[] = [];
  const restoreLedger = stubLedger();
  resetBuckets();
  setPaceRedisForTests(null);
  setRuntimeSleepForTests(async () => undefined);
  setCredentialResolverForTests(async (_userId, provider) => ({
    provider,
    secret: "test-key",
    source: "you",
    baseUrl: `http://127.0.0.1:${drop.port}/v1`,
  }));
  const app = appWith(saved);
  try {
    let result;
    try {
      result = await runAssistantTurn({
        app,
        userId: "drop-user",
        conversationId: "conv-drop",
        message: "hello",
        settings: DEFAULT_SETTINGS,
        model: "gpt-4.1-mini",
        provider: "openai",
        emit(frame) {
          frames.push(JSON.stringify(frame));
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`the turn saved the transport failure instead of the notice: ${message}`);
    }
    assert.equal(result.content, CONNECTION_DROPPED_NOTICE);
    const streamed = frames.join("\n");
    assert.equal(containsRaw(result.content), null);
    assert.equal(containsRaw(streamed), null, streamed);

    saved.push({ role: "user", content: "hello", toolCalls: [] });
    saved.push({ role: "assistant", content: result.content, toolCalls: [] });
    const sent: ModelMessage[][] = [];
    setAskRuntimeStreamForTests(async (args) => {
      sent.push(args.messages);
      return {
        text: "ok",
        toolCalls: [],
        model: "gpt-4.1-mini",
        credits: null,
        tokensIn: 1,
        tokensOut: 1,
        reasoning: "",
        raw: {},
        finishReason: "stop",
        cutOff: false,
      };
    });
    await runAssistantTurn({
      app,
      userId: "drop-user",
      conversationId: "conv-drop",
      message: "try again",
      settings: DEFAULT_SETTINGS,
      model: "gpt-4.1-mini",
      provider: "openai",
      emit() {},
    });
    const history = JSON.stringify(sent);
    assert.equal(containsRaw(history), null, history);
    assert.equal(history.includes(CONNECTION_DROPPED_NOTICE), false);
    assert.equal(history.includes("fetch failed"), false);
  } finally {
    setAskRuntimeStreamForTests(null);
    setCredentialResolverForTests(null);
    setRuntimeSleepForTests(null);
    setPaceRedisForTests(undefined);
    restoreLedger();
    await drop.close();
  }
});
