/**
 * The model call limit: the setting, a caller's shorter limit, the runtime's margin, the message the
 * chat shows, and hub-api closing its request to the Python runtime when the limit passes.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { callLimitMs, durationWords, modelCallTimeoutMs, modelTimeoutMessage, runtimeCallTimeoutMs } from "./model-timeout.js";

test("ENSEMBLE_MODEL_CALL_TIMEOUT_MS is 15 minutes by default, between 30 seconds and 30 minutes", () => {
  assert.equal(modelCallTimeoutMs({}), 900_000);
  assert.equal(modelCallTimeoutMs({ ENSEMBLE_MODEL_CALL_TIMEOUT_MS: " " }), 900_000);
  assert.equal(modelCallTimeoutMs({ ENSEMBLE_MODEL_CALL_TIMEOUT_MS: "lots" }), 900_000);
  assert.equal(modelCallTimeoutMs({ ENSEMBLE_MODEL_CALL_TIMEOUT_MS: "1200000" }), 1_200_000);
  assert.equal(modelCallTimeoutMs({ ENSEMBLE_MODEL_CALL_TIMEOUT_MS: "1000" }), 30_000);
  assert.equal(modelCallTimeoutMs({ ENSEMBLE_MODEL_CALL_TIMEOUT_MS: "99999999" }), 1_800_000);
});

test("a caller's shorter limit stands; the runtime waits hub-api's limit and a margin", () => {
  const env = { ENSEMBLE_MODEL_CALL_TIMEOUT_MS: "600000" };
  assert.equal(callLimitMs(undefined, env), 600_000);
  assert.equal(callLimitMs(120_000, env), 120_000, "vision checks keep their 2 minutes");
  assert.equal(callLimitMs(20_000, env), 20_000);
  assert.equal(callLimitMs(3_600_000, env), 600_000, "never past the setting");
  assert.equal(runtimeCallTimeoutMs({ timeoutMs: 120_000 }, env), 130_000);
  assert.equal(runtimeCallTimeoutMs({}, env), 600_000, "an older hub-api sends none");
  assert.equal(runtimeCallTimeoutMs({ timeoutMs: "soon" }, env), 600_000);
});

test("the message names the model and the limit in words", () => {
  assert.equal(modelTimeoutMessage("gpt-6.1-sol", 900_000), "GPT-6.1 Sol did not answer within 15 minutes, so I stopped waiting. Ask again, or try a narrower question.");
  assert.equal(modelTimeoutMessage("claude-sonnet-5", 60_000), "claude-sonnet-5 did not answer within 1 minute, so I stopped waiting. Ask again, or try a narrower question.");
  assert.equal(durationWords(45_000), "45 seconds");
  assert.equal(durationWords(1_000), "1 second");
  assert.equal(durationWords(1_800_000), "30 minutes");
  assert.ok(!modelTimeoutMessage("gpt-6-luna", 900_000).includes("—"));
});

test("hub-api sends the Python runtime its limit and closes the request when it passes", async () => {
  let received: Record<string, unknown> | null = null;
  let closed!: () => void;
  const requestClosed = new Promise<void>((resolve) => (closed = resolve));
  const server = createServer((request: IncomingMessage, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      received = JSON.parse(raw) as Record<string, unknown>;
      // A model that thinks for ever: the runtime has started streaming and sends nothing more.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": started\n\n");
    });
    response.on("close", () => closed());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DATABASE_URL ??= "postgresql://localhost/unused";
  process.env.REDIS_URL ??= "memory://model-timeout-tests";
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "0";
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { askRuntimeStream } = await import("./model-turn.js");
  const { ModelTimeoutError } = await import("./model-timeout.js");
  try {
    const started = Date.now();
    await assert.rejects(
      askRuntimeStream({ messages: [{ role: "user", content: "Find papers." }], model: "gpt-6.1-sol", provider: "ensemble", userId: "u1", activityId: "a1", chatTools: [], responsesTools: [], timeoutMs: 1_500 }),
      (error) => error instanceof ModelTimeoutError && error.message.startsWith("GPT-6.1 Sol did not answer within 2 seconds"),
    );
    assert.ok(Date.now() - started < 4_000);
    assert.equal(received!.timeoutMs, 1_500, "the runtime is told what hub-api allows");
    await Promise.race([requestClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("the request stayed open")), 2_000))]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
