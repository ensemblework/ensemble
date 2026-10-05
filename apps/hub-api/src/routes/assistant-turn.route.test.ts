/**
 * A new chat's first SSE frame carries the conversation id, before the model
 * is called, and Stop on that turn saves the stop note instead of a reply.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { env } from "../config.js";
import { memoryRedis } from "../lib/memory-redis.js";
import { setCredentialResolverForTests } from "../runtime/credentials.js";
import { assistantRoutes } from "./assistant.js";

const USER = "new-chat-stop-user";

type Saved = { id: string; role: string; content: string; conversationId: string };

function stubPrisma(ollamaUrl: string) {
  const saved: Saved[] = [];
  const conversations = new Map<string, { id: string; title: string; userId: string }>();
  const emptyModel = {
    count: async () => 0,
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: randomUUID() }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "preference") {
          return {
            findFirst: async () => ({
              value: {
                assistant: { defaultTier: "medium" },
                models: { medium: { provider: "ollama", model: "llama3.2" }, ollamaUrl },
              },
            }),
          };
        }
        if (prop === "assistantConversation") {
          return {
            create: async ({ data }: { data: { title: string; userId: string } }) => {
              const row = { id: randomUUID(), title: data.title, userId: data.userId };
              conversations.set(row.id, row);
              return row;
            },
            findFirst: async ({ where }: { where: { id?: string } }) => (where.id ? conversations.get(where.id) ?? null : null),
            update: async ({ where, data }: { where: { id: string }; data: { title?: string } }) => {
              const row = conversations.get(where.id);
              if (row && data.title) row.title = data.title;
              return row;
            },
          };
        }
        if (prop === "assistantMessage") {
          return {
            create: async ({ data }: { data: Saved }) => {
              const row = { id: randomUUID(), role: data.role, content: data.content, conversationId: data.conversationId };
              saved.push(row);
              return { ...row, toolCalls: [], model: null, createdAt: new Date() };
            },
            findMany: async () => [],
          };
        }
        if (typeof prop === "symbol") return undefined;
        return emptyModel;
      },
    },
  );
  return { prisma, saved };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function holdConnections(): Promise<{ port: number; connected: () => boolean; close: () => Promise<void> }> {
  let seen = false;
  const server = net.createServer((socket) => {
    seen = true;
    socket.unref();
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        connected: () => seen,
        close: () => closeServer(server),
      });
    });
  });
}

function holdHttp(): Promise<{ port: number; connected: () => boolean; close: () => Promise<void> }> {
  let seen = false;
  const server = http.createServer((request) => {
    seen = true;
    request.socket.unref();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        connected: () => seen,
        close: () => closeServer(server),
      });
    });
  });
}

function firstEvent(body: string): { event: string; data: { conversationId?: string; text?: string } } {
  const block = body.split("\n\n").find((part) => part.includes("event:"));
  assert.ok(block, body);
  const event = /event: ([^\n]+)/.exec(block)?.[1]?.trim() ?? "";
  const dataLine = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return { event, data: JSON.parse(dataLine) as { conversationId?: string; text?: string } };
}

async function postTurn(port: number): Promise<{ status: number; body: () => string; until: (needle: string) => Promise<void>; finished: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/assistant/turn",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        const waiters: Array<() => void> = [];
        response.on("data", (chunk) => {
          body += chunk.toString();
          const pending = waiters.splice(0);
          for (const wake of pending) wake();
        });
        const finished = new Promise<void>((done) => {
          response.on("end", () => done());
        });
        resolve({
          status: response.statusCode ?? 0,
          body: () => body,
          until: async (needle: string) => {
            const deadline = Date.now() + 8_000;
            while (!body.includes(needle)) {
              if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}: ${body.slice(0, 400)}`);
              await new Promise<void>((wake) => {
                const timer = setTimeout(wake, 40);
                waiters.push(() => {
                  clearTimeout(timer);
                  wake();
                });
              });
            }
          },
          finished,
        });
      },
    );
    request.on("error", reject);
    request.write(JSON.stringify({ message: "Hello from a new chat" }));
    request.end();
  });
}

async function stopTurn(port: number, conversationId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/conversations/${conversationId}/stop`, { method: "POST" });
  return response.status;
}

async function stoppedNewChat(mode: "process" | "python"): Promise<void> {
  const previousFlag = process.env.ENSEMBLE_INPROCESS_RUNTIME;
  const previousUrl = env.AGENT_RUNTIME_URL;
  const hang = mode === "python" ? await holdHttp() : await holdConnections();
  process.env.ENSEMBLE_INPROCESS_RUNTIME = mode === "process" ? "1" : "0";
  if (mode === "python") (env as { AGENT_RUNTIME_URL: string }).AGENT_RUNTIME_URL = `http://127.0.0.1:${hang.port}`;
  const ollamaUrl = mode === "process" ? `http://127.0.0.1:${hang.port}` : "http://127.0.0.1:9";
  const { prisma, saved } = stubPrisma(ollamaUrl);
  setCredentialResolverForTests(async (_userId, provider) => ({ provider, secret: "", source: "none", baseUrl: null }));
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma as never);
  app.decorate("redis", memoryRedis() as never);
  app.addHook("onRequest", async (request) => {
    request.userId = USER;
    request.modules = null;
  });
  await app.register(assistantRoutes);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  try {
    const turn = await postTurn(port);
    assert.equal(turn.status, 200);
    await turn.until("conversationId");
    const first = firstEvent(turn.body());
    assert.equal(first.event, "status");
    assert.match(first.data.conversationId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(first.data.text, undefined);
    assert.equal(turn.body().split("\n\n")[0]?.includes("Thinking"), false);
    const conversationId = first.data.conversationId!;
    const connected = Date.now() + 8_000;
    while (!hang.connected()) {
      if (Date.now() > connected) throw new Error("the model call never started");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await stopTurn(port, conversationId), 204);
    const done = Date.now() + 8_000;
    while (Date.now() < done) {
      const assistant = saved.filter((row) => row.role === "assistant");
      if (assistant.length > 0) {
        assert.equal(assistant.length, 1);
        assert.match(assistant[0]!.content, /Stopped before finishing\./);
        assert.equal(assistant[0]!.content.includes("All connection attempts failed"), false);
        assert.equal(assistant[0]!.conversationId, conversationId);
        await turn.finished;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`stop did not save a note: ${JSON.stringify(saved)}`);
  } finally {
    setCredentialResolverForTests(null);
    (env as { AGENT_RUNTIME_URL: string }).AGENT_RUNTIME_URL = previousUrl;
    if (previousFlag === undefined) delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
    else process.env.ENSEMBLE_INPROCESS_RUNTIME = previousFlag;
    await hang.close();
    app.server.closeAllConnections?.();
    await app.close();
  }
}

test("the first frame of a new chat carries the conversation id, and Stop saves the note", { timeout: 20_000 }, async () => {
  await stoppedNewChat("process");
});

test("Stop on a new chat cancels the Python runtime turn and saves the note", { timeout: 20_000 }, async () => {
  await stoppedNewChat("python");
});
