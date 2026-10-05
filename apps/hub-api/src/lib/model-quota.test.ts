import assert from "node:assert/strict";
import test from "node:test";
import { nextPacificMidnight } from "./clock.js";
import { ModelQuotaError, quotaExceededMessage, quotaResetInstant } from "./model-quota.js";

test("quota without a retry hint resets at the next Pacific midnight", () => {
  const now = new Date("2026-10-04T20:30:00.000Z");
  const resets = quotaResetInstant(now, null);
  assert.equal(resets.toISOString(), "2026-10-05T07:00:00.000Z");
  assert.equal(nextPacificMidnight(now).toISOString(), resets.toISOString());
  const error = new ModelQuotaError("gemini-3.5-flash", resets, null);
  assert.equal(error.statusCode, 429);
  assert.equal(error.code, "model_quota_exceeded");
  assert.match(error.message, /gemini-3.5-flash is out of quota until/);
  assert.match(error.message, /PDT/);
  const body = error.toJSON();
  assert.equal(body.code, "model_quota_exceeded");
  assert.equal(body.model, "gemini-3.5-flash");
  assert.equal(body.resetsAt, "2026-10-05T07:00:00.000Z");
  assert.equal(body.status, 429);
  assert.equal(body.error, error.message);
  assert.equal(quotaExceededMessage("gemini-3.5-flash", resets), error.message);
});

test("a positive retry delay is the reset instant", () => {
  const now = new Date("2026-10-04T20:30:00.000Z");
  const resets = quotaResetInstant(now, 30);
  assert.equal(resets.toISOString(), "2026-10-04T20:30:30.000Z");
});
