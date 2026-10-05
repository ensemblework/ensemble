import assert from "node:assert/strict";
import test from "node:test";
import { getQuotaSnapshot, markModelOutOfQuota, quotaFor, quotaMessage, quotaSuffix } from "./model-quota.js";

test("a quota error marks the model until the reset time", () => {
  const model = `gemini-quota-${Date.now()}`;
  const mark = quotaMessage({
    code: "model_quota_exceeded",
    model,
    resetsAt: "2026-10-05T07:00:00.000Z",
    message: `${model} is out of quota until Oct 5, 12:00 AM PDT.`,
  });
  assert.ok(mark);
  markModelOutOfQuota(mark);
  assert.equal(quotaFor(model, Date.parse("2026-10-04T20:30:00.000Z"))?.message, mark.message);
  assert.equal(quotaFor(model, Date.parse("2026-10-05T07:00:00.000Z")), null);
  assert.equal(quotaSuffix(model, getQuotaSnapshot(), Date.parse("2026-10-04T20:30:00.000Z")), " · out of quota");
  assert.equal(quotaSuffix(model, getQuotaSnapshot(), Date.parse("2026-10-05T08:00:00.000Z")), "");
  assert.equal(quotaMessage({ error: "nope" }), null);
});
