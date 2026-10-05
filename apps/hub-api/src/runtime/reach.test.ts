/**
 * A host that never answers names the cause. A socket that connected and then
 * died before headers is still the drop notice. Neither is sent back as the model's reply.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { historyEntries, replyAfterStreamFailure } from "../assistant/cutoff.js";
import { ModelQuotaError } from "../lib/model-quota.js";
import { errorFromStreamFrame } from "../lib/model-turn.js";
import { ModelUnreachableError } from "../lib/model-reach.js";
import { CONNECTION_DROPPED_NOTICE, isTransportDrop } from "../lib/stream-drop.js";
import { setCredentialResolverForTests, type Credential } from "./credentials.js";
import { setRuntimeFetchForTests, streamWithTools } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";

const LEAK = "connect failed at /workspace/apps/hub-api/src/runtime/models.ts:124\n    at vendorFetch (models.ts:124:5)";

function coded(message: string, code: string): Error {
  const error = new Error(`${message}\n${LEAK}`);
  return Object.assign(error, { code });
}

function fetchFailed(cause: Error): TypeError {
  const error = new TypeError("fetch failed");
  error.cause = cause;
  return error;
}

function install(baseUrl: string | null, boom: () => never): void {
  resetBuckets();
  setRuntimeSleepForTests(async () => undefined);
  setCredentialResolverForTests(async (_userId, provider) => {
    const cred: Credential = { provider, secret: provider === "ollama" ? "" : "test-key", source: "you", baseUrl };
    return cred;
  });
  setRuntimeFetchForTests(async () => {
    boom();
  });
}

async function errorPayload(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frames: string[] = [];
  for await (const frame of streamWithTools(body)) frames.push(frame);
  const error = frames.find((frame) => frame.startsWith("event: error"));
  assert.ok(error, frames.join("\n"));
  const raw = error.slice(error.indexOf("data:") + "data:".length).trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

test.afterEach(() => {
  setRuntimeFetchForTests(null);
  setCredentialResolverForTests(null);
  setRuntimeSleepForTests(null);
});

test("connection refused names the provider and host", async () => {
  install(null, () => {
    throw fetchFailed(coded("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"));
  });
  const payload = await errorPayload({
    provider: "openai",
    model: "gpt-4.1",
    userId: "reach-user",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(payload.code, "model_unreachable");
  assert.equal(payload.provider, "openai");
  assert.equal(payload.model, "gpt-4.1");
  assert.equal(payload.host, "api.openai.com");
  assert.equal(payload.reason, "refused");
  assert.equal(payload.status, 503);
  assert.equal(payload.message, "Couldn't reach OpenAI at api.openai.com: connection refused");
  assert.equal(String(payload.message).includes("models.ts"), false);
  assert.equal(String(payload.message).includes("ECONNREFUSED"), false);
  assert.equal(JSON.stringify(payload).includes(LEAK), false);
});

test("an unknown host names the host from the model URL", async () => {
  install("https://no-such.example/v1", () => {
    throw fetchFailed(coded("getaddrinfo ENOTFOUND evil.internal", "ENOTFOUND"));
  });
  const payload = await errorPayload({
    provider: "openai",
    model: "gpt-4.1",
    userId: "reach-user",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(payload.code, "model_unreachable");
  assert.equal(payload.reason, "dns");
  assert.equal(payload.host, "no-such.example");
  assert.equal(payload.message, "no-such.example couldn't be found. Check the model URL.");
  assert.equal(String(payload.message).includes("evil.internal"), false);
  assert.equal(String(payload.message).includes("ENOTFOUND"), false);
  assert.equal(JSON.stringify(payload).includes("models.ts"), false);
});

test("ollama not running says so, with the address", async () => {
  install(null, () => {
    throw fetchFailed(coded("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED"));
  });
  const payload = await errorPayload({
    provider: "ollama",
    model: "llama3.2",
    userId: "reach-user",
    ollamaUrl: "http://localhost:11434",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(payload.code, "model_unreachable");
  assert.equal(payload.provider, "ollama");
  assert.equal(payload.model, "llama3.2");
  assert.equal(payload.reason, "down");
  assert.equal(payload.host, "http://localhost:11434");
  assert.equal(payload.message, "Couldn't reach Ollama at http://localhost:11434. Is it running?");
  assert.equal(JSON.stringify(payload).includes("ECONNREFUSED"), false);
  assert.equal(JSON.stringify(payload).includes("models.ts"), false);
});

test("a socket killed before headers is still a drop, and stays out of history", async () => {
  install(null, () => {
    throw fetchFailed(coded("closed before headers", "UND_ERR_SOCKET"));
  });
  const payload = await errorPayload({
    provider: "openai",
    model: "gpt-4.1",
    userId: "reach-user",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(payload.message, CONNECTION_DROPPED_NOTICE);
  assert.equal(payload.code, undefined);
  assert.equal(JSON.stringify(payload).includes("closed before headers"), false);
  assert.equal(JSON.stringify(payload).includes("UND_ERR"), false);
  assert.equal(JSON.stringify(payload).includes("models.ts"), false);

  const socket = fetchFailed(coded("closed before headers", "UND_ERR_SOCKET"));
  assert.equal(isTransportDrop(socket), true);
  const settled = replyAfterStreamFailure("", socket, false);
  assert.equal(settled.kind, "notice");
  assert.equal(settled.kind === "notice" ? settled.text : "", CONNECTION_DROPPED_NOTICE);

  const quota = new ModelQuotaError("gemini-3.5-flash", new Date("2026-10-05T07:00:00.000Z"), null);
  assert.equal(isTransportDrop(quota), false);
  assert.equal(replyAfterStreamFailure("", quota, false).kind, "error");
  const unreachable = new ModelUnreachableError({
    message: "Couldn't reach OpenAI at api.openai.com: connection refused",
    provider: "openai",
    model: "gpt-4.1",
    host: "api.openai.com",
    reason: "refused",
  });
  assert.equal(isTransportDrop(unreachable), false);
  assert.equal(replyAfterStreamFailure("", unreachable, false).kind, "error");

  const history = historyEntries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "Couldn't reach OpenAI at api.openai.com: connection refused" },
    { role: "assistant", content: "no-such.example couldn't be found. Check the model URL." },
    { role: "assistant", content: "Couldn't reach Ollama at http://localhost:11434. Is it running?" },
    { role: "assistant", content: CONNECTION_DROPPED_NOTICE },
    { role: "user", content: "again" },
  ]);
  assert.deepEqual(
    history.map((row) => row.content),
    ["hi", "again"],
  );

  const fromFrame = errorFromStreamFrame(
    {
      code: "model_unreachable",
      message: `Error: ${LEAK}`,
      provider: "openai",
      model: "gpt-4.1",
      host: "api.openai.com",
      reason: "refused",
      status: 503,
    },
    "gpt-4.1",
  );
  assert.ok(fromFrame instanceof ModelUnreachableError);
  assert.equal(fromFrame.message, "Couldn't reach OpenAI at api.openai.com: connection refused");
  assert.equal(fromFrame.message.includes("models.ts"), false);
});
