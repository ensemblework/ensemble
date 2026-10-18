import assert from "node:assert/strict";
import test from "node:test";
import { includedNotice, localOnlyRow, modelLabel } from "./included.js";

test("included refusals read as notices with the next step; other errors stay errors", () => {
  assert.equal(includedNotice("included_local_only", "")?.title, "Included models need your Ensemble account");
  assert.match(includedNotice(undefined, "This computer is no longer connected to your Ensemble account, so…")!.hint, /\/login/);
  const used = includedNotice("included_credits_used", "You've used this month's Ensemble credits. They reset on Nov 1.")!;
  assert.deepEqual([used.title, used.tone, used.text], ["Ensemble credits", "warn", "You've used this month's Ensemble credits. They reset on Nov 1."]);
  assert.equal(includedNotice("included_paused", "Paused.")?.tone, "warn");
  assert.equal(includedNotice(undefined, "No key for Google Gemini."), null);
  assert.equal(includedNotice("model_quota", "Quota."), null);
});

test("included models are named with their version, and a local-only row is recognised", () => {
  assert.equal(modelLabel("ensemble", "gpt-6-luna"), "GPT-6 Luna (2026-09-22)");
  assert.equal(modelLabel("anthropic", "claude-x"), "claude-x");
  assert.equal(localOnlyRow([{ provider: "ensemble", available: false, code: "included_local_only" }]), true);
  assert.equal(localOnlyRow([{ provider: "ensemble", available: true, code: null }]), false);
});
