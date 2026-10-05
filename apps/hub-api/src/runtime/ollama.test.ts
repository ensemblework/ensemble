/**
 * Ollama is a local provider. The default address is http://127.0.0.1:11434.
 * No API key is sent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setCredentialResolverForTests, type Credential } from "./credentials.js";
import { catalog, clearCatalogCache, completeWithTools, setRuntimeFetchForTests } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";

test("ollama chats and lists tags on 127.0.0.1:11434", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  resetBuckets();
  clearCatalogCache();
  setRuntimeSleepForTests(async () => undefined);
  const local: Credential = { provider: "ollama", secret: "", source: "none", baseUrl: null };
  setCredentialResolverForTests(async () => local);
  const calls: string[] = [];
  setRuntimeFetchForTests(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.2" }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        model: "llama3.2",
        choices: [{ message: { role: "assistant", content: "ready" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  try {
    const turn = await completeWithTools({
      userId: "ollama-user",
      provider: "ollama",
      model: "llama3.2",
      ollamaUrl: "http://127.0.0.1:11434",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(turn.text, "ready");
    assert.equal(turn.model, "llama3.2");
    assert.ok(calls.some((call) => call === "POST http://127.0.0.1:11434/v1/chat/completions"));

    clearCatalogCache();
    const rows = await catalog("ollama-user", "http://127.0.0.1:11434");
    const ollama = rows.find((row) => row.provider === "ollama");
    assert.deepEqual(ollama?.models, ["llama3.2"]);
    assert.equal(ollama?.available, true);
    assert.ok(calls.some((call) => call === "GET http://127.0.0.1:11434/api/tags"));
  } finally {
    setRuntimeFetchForTests(null);
    setCredentialResolverForTests(null);
    setRuntimeSleepForTests(null);
  }
});

test("a down ollama does not take the model catalog offline", async () => {
  clearCatalogCache();
  setCredentialResolverForTests(async (_userId, provider) => ({ provider, secret: "", source: "none", baseUrl: null }));
  setRuntimeFetchForTests(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  });
  try {
    const rows = await catalog("offline-user", "http://127.0.0.1:11434");
    assert.equal(rows.length, 10);
    const ollama = rows.find((row) => row.provider === "ollama");
    assert.equal(ollama?.available, false);
    assert.equal(ollama?.error, null);
  } finally {
    setRuntimeFetchForTests(null);
    setCredentialResolverForTests(null);
  }
});
