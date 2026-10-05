/**
 * POST /api/models/test makes one short completion through the in-process runtime.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "./test-env.js";
import Fastify from "fastify";
import { systemRoutes } from "../routes/system.js";
import "../types.js";
import { setCredentialResolverForTests } from "./credentials.js";
import { clearCatalogCache, setRuntimeFetchForTests } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";

test("POST /api/models/test reports the model that answered", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  resetBuckets();
  clearCatalogCache();
  setRuntimeSleepForTests(async () => undefined);
  setCredentialResolverForTests(async (_userId, provider) => ({
    provider,
    secret: "test-key-google",
    source: "you",
    baseUrl: null,
  }));
  const calls: string[] = [];
  setRuntimeFetchForTests(async (input, init) => {
    calls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key-google");
    assert.equal(String(input).includes("test-key-google"), false);
    return new Response(
      JSON.stringify({
        model: "gemini-3.5-flash-lite",
        choices: [{ message: { role: "assistant", content: "ready" } }],
        usage: { prompt_tokens: 6, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const app = Fastify();
  app.decorate("prisma", { preference: { findFirst: async () => null } } as never);
  app.addHook("onRequest", async (request) => {
    request.userId = "model-test-user";
  });
  await app.register(systemRoutes);
  try {
    const response = await app.inject({ method: "POST", url: "/api/models/test", payload: { tier: "easy" } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { ok: boolean; model: string; text: string; tokensIn: number; tokensOut: number; ms: number };
    assert.equal(body.ok, true);
    assert.equal(body.model, "gemini-3.5-flash-lite");
    assert.equal(body.text, "ready");
    assert.equal(body.tokensIn, 6);
    assert.equal(body.tokensOut, 1);
    assert.equal(typeof body.ms, "number");
    assert.ok(calls[0]?.startsWith("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"));
  } finally {
    await app.close();
    setRuntimeFetchForTests(null);
    setCredentialResolverForTests(null);
    setRuntimeSleepForTests(null);
  }
});
