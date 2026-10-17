import assert from "node:assert/strict";
import test from "node:test";
import { creditAmount, includedNote, includedRefusal, relativeCost, resetDay, tierModelLabel, tierModelName, tokenCount, wholeCredits } from "./included.js";

test("credits read as whole numbers from 10 up and one decimal below", () => {
  assert.equal(creditAmount(0.4), "0.4 credits");
  assert.equal(creditAmount(1), "1 credit");
  assert.equal(creditAmount(9.94), "9.9 credits");
  assert.equal(creditAmount(12.4), "12 credits");
  assert.equal(creditAmount(4210.2), "4,210 credits");
  assert.equal(creditAmount(0.01), "under 0.1 credits");
  assert.equal(creditAmount(0), "0 credits");
  assert.equal(wholeCredits(12_345.9), "12,345", "what is left rounds down");
  assert.equal(wholeCredits(-3), "0");
  assert.equal(tokenCount(1_234_000), "1.2M");
  assert.equal(tokenCount(85_000), "85K");
  assert.equal(tokenCount(940), "940");
});

test("the reset day is the UTC day, and the provider note says credits left or paused", () => {
  assert.equal(resetDay("2026-11-01T00:00:00.000Z"), "Nov 1");
  const usage = { paused: false, remaining: 12_345.6, resetsAt: "2026-11-01T00:00:00.000Z" } as Parameters<typeof includedNote>[0];
  assert.equal(includedNote(usage), "12,345 credits left");
  assert.equal(includedNote({ ...usage, paused: true }), "paused until Nov 1");
});

test("included tiers show the model's name with its version", () => {
  assert.equal(tierModelName("ensemble", "gpt-6-luna"), "GPT-6 Luna (2026-09-22)");
  assert.equal(tierModelName("openai", "gpt-6-luna"), "gpt-6-luna", "a person's own key keeps the id");
  assert.equal(tierModelLabel({ provider: "ensemble", model: "grok-4.7" }), "Included with Ensemble · Grok 4.7");
  assert.equal(tierModelLabel({ provider: "google", model: "gemini-3.5-flash" }), "gemini-3.5-flash");
  assert.equal(relativeCost("grok-4.7")?.badge, "20×");
  assert.match(relativeCost("grok-4.7")!.title, /about 20× the credits of GPT-6 Luna/);
  assert.equal(relativeCost("deepseek-v4-flash")?.badge, "2×");
  assert.match(relativeCost("gpt-6-luna")!.title, /GPT-6 Luna is the credit baseline/);
  assert.equal(relativeCost("gemini-3.5-flash"), null);
});

test("only an included code is an included refusal", () => {
  assert.equal(includedRefusal({ code: "included_paused", message: "Paused until Nov 1.", error: "Paused until Nov 1.", resetsAt: "2026-11-01T00:00:00.000Z", status: 429 }), "Paused until Nov 1.");
  assert.equal(includedRefusal({ code: "included_unavailable", error: "Not set up." }), "Not set up.");
  assert.equal(includedRefusal({ code: "model_quota_exceeded", message: "gemini is out of quota" }), null);
  assert.equal(includedRefusal("included_paused"), null);
});
