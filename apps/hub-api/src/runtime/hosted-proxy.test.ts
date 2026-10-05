/**
 * With both switches unset, hub-api still posts to the Python runtime on 5055.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "./hosted-env.js";
import { env } from "../config.js";
import { runtime } from "../lib/runtime.js";

test("an unset desktop flag still proxies model calls to port 5055", async () => {
  assert.equal(process.env.ENSEMBLE_INPROCESS_RUNTIME, undefined);
  assert.equal(process.env.ENSEMBLE_DESKTOP, undefined);
  assert.equal(env.AGENT_RUNTIME_URL, "http://127.0.0.1:5055");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ text: "ready", model: "gemini-test", tokensIn: 1, tokensOut: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await runtime<{ text: string }>("/api/complete", {
      method: "POST",
      json: { prompt: "Reply with the single word: ready", provider: "google", model: "gemini-test" },
    });
    assert.equal(result.text, "ready");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:5055/api/complete");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("x-ensemble-internal"), env.ENSEMBLE_INTERNAL_TOKEN);
    assert.equal(calls[0]?.init?.method, "POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as { prompt: string };
    assert.equal(body.prompt, "Reply with the single word: ready");
  } finally {
    globalThis.fetch = original;
  }
});
