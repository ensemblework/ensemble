/**
 * The assistant calls routes with the person's own cookie and Origin (`assistant/request.ts`), so the
 * terminal refuses its calls by the in-process mark (`lib/injected.ts`), which no real request can carry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "../config.js";
import type { ToolContext } from "../assistant/types.js";
// The workspace tools first, as the app loads them: `devices/code-routes` alone meets their import cycle.
import "../workspace/tools.js";
import { deviceCodeRoutes } from "../devices/code-routes.js";
import { memoryRedis } from "./memory-redis.js";
import { terminalRoutes } from "../routes/terminal.js";
import "../types.js";
import { dropForgedInjection, injectedHeaders, INJECTED_HEADER, isInjected } from "./injected.js";
import { humanOnlyRefusal, TERMINAL_ASSISTANT_REFUSAL } from "./terminal-human.js";

const PAGE = env.HUB_WEB_ORIGIN.replace(/\/$/, "");

/** The terminal routes behind a person's browser session, with the app's own hook that drops a forged mark. */
async function app(): Promise<FastifyInstance> {
  const server = Fastify();
  server.decorate("prisma", {} as never);
  server.decorate("redis", memoryRedis() as never);
  server.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
  });
  server.addHook("onRequest", async (request) => {
    dropForgedInjection(request.headers);
    request.userId = "person";
    request.accountId = "person";
    request.authVia = "session";
    request.modules = "code";
  });
  await server.register(terminalRoutes);
  await server.register(deviceCodeRoutes);
  return server;
}

test("only this process's own mark counts, and a forged one is dropped", () => {
  assert.equal(isInjected(injectedHeaders()), true);
  for (const value of ["1", "true", "", "x".repeat(48)]) {
    const headers: Record<string, string> = { [INJECTED_HEADER]: value };
    assert.equal(isInjected(headers), false, value);
    dropForgedInjection(headers);
    assert.equal(INJECTED_HEADER in headers, false, value);
  }
  const marked: Record<string, string> = injectedHeaders();
  dropForgedInjection(marked);
  assert.equal(isInjected(marked), true, "the real mark stays");
});

test("an injected call is refused before anything else is looked at", () => {
  assert.equal(humanOnlyRefusal({ authVia: "session", origin: PAGE, webOrigins: [PAGE], injected: true }), TERMINAL_ASSISTANT_REFUSAL);
  assert.equal(humanOnlyRefusal({ authVia: "session", origin: PAGE, webOrigins: [PAGE], injected: false }) === TERMINAL_ASSISTANT_REFUSAL, false);
});

test("the assistant's call with the person's cookie and Origin is refused by both terminals; the browser's is not", async () => {
  const server = await app();
  // Loaded after the routes, as in the app (the assistant's modules import each other).
  const { assistantRequest } = await import("../assistant/request.js");
  try {
    const ctx = { app: server, requestHeaders: { cookie: "ensemble_session=person", origin: PAGE } } as unknown as ToolContext;
    for (const [url, payload] of [
      ["/api/terminal/kill", {}],
      ["/api/terminal/run", { cwd: "/", line: "ls" }],
      ["/api/devices/some-computer/terminal", { op: "run", cwd: "/", line: "ls" }],
    ] as const) {
      await assert.rejects(assistantRequest(ctx, "POST", url, payload), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 403, url);
        assert.equal((error as Error).message, TERMINAL_ASSISTANT_REFUSAL, url);
        return true;
      });
    }
    // The same call from the browser itself (no mark), or with a mark it made up, goes through the guard.
    for (const headers of [{ origin: PAGE }, { origin: PAGE, [INJECTED_HEADER]: "guessed" }]) {
      const response = await server.inject({ method: "POST", url: "/api/terminal/kill", headers, payload: {} });
      if (new URL(PAGE).hostname === "localhost") assert.equal(response.statusCode, 200, response.body);
      else assert.notEqual(response.json<{ error?: string }>().error, TERMINAL_ASSISTANT_REFUSAL);
    }
  } finally {
    await server.close();
  }
});
