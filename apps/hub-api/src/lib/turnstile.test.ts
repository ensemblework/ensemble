import assert from "node:assert/strict";
import test from "node:test";
import { verifyTurnstile } from "./turnstile.js";

test("hosted signup cannot bypass missing Turnstile configuration or a failed/wrong-host challenge", async () => {
  const before = { ...process.env };
  const original = globalThis.fetch;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.ENSEMBLE_DESKTOP;
    delete process.env.TURNSTILE_SECRET_KEY;
    await assert.rejects(verifyTurnstile("token", "127.0.0.1"), /not configured/);
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.HUB_WEB_ORIGIN = "https://app.example.com";
    await assert.rejects(verifyTurnstile(undefined, "127.0.0.1"), /Complete/);
    for (const result of [
      { success: false, hostname: "app.example.com", action: "signup" },
      { success: true, hostname: "evil.example.com", action: "signup" },
      { success: true, hostname: "app.example.com", action: "other" },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(result));
      await assert.rejects(verifyTurnstile("token", "127.0.0.1"), /failed/);
    }
    globalThis.fetch = async (_url, init) => {
      assert.equal(new URLSearchParams(String(init?.body)).get("response"), "token");
      return new Response(JSON.stringify({ success: true, hostname: "app.example.com", action: "signup" }));
    };
    await verifyTurnstile("token", "127.0.0.1");
  } finally {
    globalThis.fetch = original;
    process.env = before;
  }
});
