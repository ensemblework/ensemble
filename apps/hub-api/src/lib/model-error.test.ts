import assert from "node:assert/strict";
import test from "node:test";
import { friendlyModelError, parseRuntimeBody } from "./model-error.js";

test("nested Google error.message is the sentence people see", () => {
  const raw = JSON.stringify({ error: { message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" } });
  const parsed = parseRuntimeBody(429, raw);
  assert.match(parsed.message, /Resource exhausted/);
});

test("FastAPI detail object keeps kind and retry-after", () => {
  const raw = JSON.stringify({ detail: { message: "slow down", kind: "rate_limit", retryAfterSeconds: 12, quotaId: "flash-lite" } });
  const parsed = parseRuntimeBody(429, raw);
  assert.equal(parsed.kind, "rate_limit");
  assert.equal(parsed.retryAfterSeconds, 12);
  assert.equal(parsed.quotaId, "flash-lite");
  assert.match(friendlyModelError(parsed), /12s/);
  assert.match(friendlyModelError(parsed), /flash-lite/);
});

test("quota is not described as a per-minute wait", () => {
  const parsed = parseRuntimeBody(429, "status=429 kind=quota quotaId=gemini-pro daily limit");
  assert.equal(parsed.kind, "quota");
  assert.match(friendlyModelError(parsed), /out of quota/);
});

test("a raw invalid-argument body is one sentence", () => {
  const raw = JSON.stringify({
    error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" },
  });
  const parsed = parseRuntimeBody(400, raw);
  const sentence = friendlyModelError({ ...parsed, kind: "invalid", status: 400 });
  assert.match(sentence, /Nothing was changed/);
  assert.equal(sentence.includes("{"), false);
});

test("503 high demand stays unavailable", () => {
  const parsed = parseRuntimeBody(503, JSON.stringify({ detail: { message: "high demand", kind: "unavailable" } }));
  assert.equal(parsed.kind, "unavailable");
  assert.match(friendlyModelError(parsed), /high demand/i);
});

test("a Cursor chat refusal is not rewritten as Gemini being busy", () => {
  const parsed = parseRuntimeBody(503, JSON.stringify({ detail: "Cursor runs delegated agent work, not the chat." }));
  assert.match(friendlyModelError(parsed), /Cursor runs delegated/);
  assert.equal(friendlyModelError(parsed).includes("Gemini"), false);
});

test("the sentence names the provider that was called, never one guessed from the model's name", () => {
  const busy = parseRuntimeBody(503, JSON.stringify({ detail: { message: "busy", kind: "unavailable" } }));
  assert.equal(friendlyModelError(busy, "mai-code-1.1-flash", "copilot"), "GitHub Copilot is under high demand for this model. Try again, or switch the tier to a model this key can use.");
  assert.match(friendlyModelError(busy, "mai-code-1.1-flash"), /^The provider is under high demand/, "an unknown id is not Gemini");
  assert.match(friendlyModelError(busy, "gpt-4.1", "copilot"), /^GitHub Copilot/, "a Copilot gpt model is Copilot, not OpenAI");
  assert.match(friendlyModelError(busy, "gemini-3.5-flash"), /^Gemini/, "an id with a vendor prefix still names it");
  const key = parseRuntimeBody(503, JSON.stringify({ detail: { message: "This is a classic GitHub token. Use a fine-grained token.", kind: "auth" } }));
  assert.equal(friendlyModelError(key, "mai-code-1.1-flash", "copilot"), "This is a classic GitHub token. Use a fine-grained token.", "a key problem is said as it is");
});
