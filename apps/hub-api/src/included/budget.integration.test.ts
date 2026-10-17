/**
 * The Ensemble credits ledger against PGlite: reserve and settle through the internal routes the
 * runtime calls, the per-account monthly credits, the operator's monthly ceiling for everyone,
 * stale reservations, spaces paying from their owner's credits, and the credits view people see.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_SETTINGS, includedPeriod, includedResetsAt } from "@ensemble/shared-types";
import { createHttpHarness } from "../test/http.js";
import { includedRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

process.env.AZURE_FOUNDRY_RESOURCE = "ensemble-ai-test";
process.env.AZURE_FOUNDRY_API_KEY = "test-key-not-real";
process.env.ENSEMBLE_INCLUDED_MONTHLY_CREDITS = "100";
process.env.ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD = "200";
delete process.env.ENSEMBLE_INCLUDED_MODELS;

const harness = await createHttpHarness();
const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  covered.set(route, new Set([...(covered.get(route) ?? []), ...checks]));
}
after(async () => {
  try {
    for (const [route, checks] of Object.entries(includedRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});
const db = harness.prisma as PrismaClient;
const { reserveIncluded, settleIncluded, assertIncludedOpen, STALE_RESERVATION_MS } = await import("./budget.js");
const { withIncludedDefaults } = await import("./defaults.js");
const { createSpaceUser } = await import("../spaces/store.js");

const period = includedPeriod();
const resetsAt = includedResetsAt().toISOString();

async function reserve(user: Awaited<ReturnType<typeof harness.asUser>>, body: Record<string, unknown>) {
  return harness.internal(user, { method: "POST", url: "/api/internal/included/reserve", payload: body });
}

async function settle(user: Awaited<ReturnType<typeof harness.asUser>>, body: Record<string, unknown>) {
  return harness.internal(user, { method: "POST", url: "/api/internal/included/settle", payload: body });
}

async function setCeiling(usd: number, spent = 0, reserved = 0) {
  process.env.ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD = String(usd);
  await db.$executeRaw`INSERT INTO included_periods (period) VALUES (${period}) ON CONFLICT (period) DO NOTHING`;
  await db.$executeRaw`UPDATE included_periods SET spent_usd = ${spent}::numeric, reserved_usd = ${reserved}::numeric WHERE period = ${period}`;
}

test("a call reserves, then settles at its real cost, and people see credits only", async () => {
  await setCeiling(200);
  const user = await harness.asUser();
  const held = await reserve(user, { model: "gpt-6-luna", inputTokens: 10_000, maxOutputTokens: 16_000, purpose: "Hub chat" });
  assert.equal(held.statusCode, 200, held.body);
  const { id } = held.json() as { id: string };
  const row = await db.includedUsage.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, "reserved");
  assert.equal(row.accountId, user.id);
  // 10,000 in at $0.10/M plus 16,000 out at $0.50/M.
  assert.equal(Number(row.reservedUsd), 0.009);

  const done = await settle(user, { id, usage: { inputTokens: 10_000, cacheReadTokens: 2_000, cacheWriteTokens: 1_000, outputTokens: 500 }, answeredBy: "gpt-6-luna" });
  assert.equal(done.statusCode, 200, done.body);
  // In: 7,000 × 0.10 + 2,000 × 0.01 + 1,000 × 0.125 = $0.000845. Out: 500 × 0.50 = $0.00025.
  assert.ok(Math.abs((done.json() as { credits: number }).credits - 1.095) < 1e-9);
  const again = await settle(user, { id, usage: { inputTokens: 99_999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 99_999 } });
  assert.ok(Math.abs((again.json() as { credits: number }).credits - 1.095) < 1e-9, "a second settle returns the first result");

  const view = await user.inject({ method: "GET", url: "/api/metrics/credits" });
  assert.equal(view.statusCode, 200, view.body);
  const usage = view.json();
  assert.equal(usage.available, true);
  assert.equal(usage.limit, 100);
  assert.equal(usage.used, 1.1);
  assert.equal(usage.remaining, 98.9);
  assert.equal(usage.resetsAt, resetsAt);
  assert.equal(usage.models.length, 4);
  assert.deepEqual(
    { input: usage.totals.inputTokens, cached: usage.totals.cachedTokens, output: usage.totals.outputTokens, inCredits: usage.totals.inputCredits, outCredits: usage.totals.outputCredits },
    { input: 10_000, cached: 2_000, output: 500, inCredits: 0.85, outCredits: 0.25 },
  );
  assert.equal(usage.byModel[0].label, "GPT-6 Luna (2026-09-22)");
  assert.deepEqual(usage.byPurpose, [{ purpose: "Hub chat", calls: 1, credits: 1.1 }]);
  assert.doesNotMatch(view.body, /usd|\$/i, "no dollar figure reaches people");
  claim("POST /api/internal/included/reserve", "happy-path");
  claim("POST /api/internal/included/settle", "happy-path");
  claim("GET /api/metrics/credits", "happy-path");

  const other = (await (await harness.asUser()).inject({ method: "GET", url: "/api/metrics/credits" })).json();
  assert.equal(other.used, 0, "another account sees only its own credits");
  assert.deepEqual(other.byModel, []);
  claim("GET /api/metrics/credits", "isolation");
});

test("malformed reserve and settle requests are refused", async () => {
  const user = await harness.asUser();
  assert.equal((await reserve(user, { model: "gpt-6-luna", inputTokens: -1, maxOutputTokens: 10 })).statusCode, 400);
  assert.equal((await reserve(user, { model: "gpt-6-luna", inputTokens: 1 })).statusCode, 400);
  claim("POST /api/internal/included/reserve", "invalid-input");
  assert.equal((await settle(user, { id: "not-a-uuid", usage: null })).statusCode, 400);
  assert.equal((await settle(user, { id: "00000000-0000-4000-8000-000000000000", usage: { inputTokens: 1.5, outputTokens: 1 } })).statusCode, 400);
  claim("POST /api/internal/included/settle", "invalid-input");
});

test("an account cannot start a call that could pass its monthly credits", async () => {
  await setCeiling(200);
  const user = await harness.asUser();
  // Worst case for GPT-6.1 Sol: 16,000 out at $10/M is $0.16 = 160 credits, over the 100 credits a month.
  const refused = await reserve(user, { model: "gpt-6.1-sol", inputTokens: 1_000, maxOutputTokens: 16_000 });
  assert.equal(refused.statusCode, 429, refused.body);
  const body = refused.json();
  assert.equal(body.code, "included_credits_used");
  assert.equal(body.resetsAt, resetsAt);
  assert.match(body.message, /could use up to 162 Ensemble credits and you have 100 left/);
  assert.equal(await db.includedUsage.count({ where: { accountId: user.id } }), 0, "a refused call holds nothing");

  const fine = await reserve(user, { model: "gpt-6-luna", inputTokens: 1_000, maxOutputTokens: 16_000 });
  assert.equal(fine.statusCode, 200, fine.body);
});

test("used-up credits are refused before a chat starts, with when they reset", async () => {
  await setCeiling(200);
  const user = await harness.asUser();
  await db.includedUsage.create({
    data: { accountId: user.id, userId: user.id, period, model: "gpt-6-luna", status: "settled", estimatedInputTokens: 0, maxOutputTokens: 1, reservedUsd: 0.1, usd: 0.1 },
  });
  await assert.rejects(assertIncludedOpen(user.id, "gpt-6-luna"), (error: Error & { code?: string; resetsAt?: string }) => {
    assert.equal(error.code, "included_credits_used");
    assert.equal(error.resetsAt, resetsAt);
    assert.match(error.message, /used this month's Ensemble credits/);
    return true;
  });
  const usage = (await user.inject({ method: "GET", url: "/api/metrics/credits" })).json();
  assert.equal(usage.remaining, 0);
});

test("the operator's monthly ceiling stops every included call, even with credits left", async () => {
  const user = await harness.asUser();
  await setCeiling(1, 0.995, 0);
  const refused = await reserve(user, { model: "gpt-6-luna", inputTokens: 1_000, maxOutputTokens: 16_000 });
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, "included_paused");
  assert.match(refused.json().message, /paused for everyone until/);
  await setCeiling(1, 1, 0);
  await assert.rejects(assertIncludedOpen(user.id, "gpt-6-luna"), /paused for everyone/);
  const usage = (await user.inject({ method: "GET", url: "/api/metrics/credits" })).json();
  assert.equal(usage.paused, true);
  await setCeiling(200);
});

test("reservations count against the ceiling while calls are in flight, and settle releases them", async () => {
  await setCeiling(0.02);
  const first = await harness.asUser();
  const second = await harness.asUser();
  const held = await reserve(first, { model: "gpt-6-luna", inputTokens: 10_000, maxOutputTokens: 16_000 });
  assert.equal(held.statusCode, 200);
  const two = await reserve(first, { model: "gpt-6-luna", inputTokens: 10_000, maxOutputTokens: 16_000 });
  assert.equal(two.statusCode, 200);
  const third = await reserve(second, { model: "gpt-6-luna", inputTokens: 10_000, maxOutputTokens: 16_000 });
  assert.equal(third.statusCode, 429, "two reservations of $0.009 leave less than the third needs");
  await settle(first, { id: held.json().id, usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } });
  const after = await reserve(second, { model: "gpt-6-luna", inputTokens: 10_000, maxOutputTokens: 16_000 });
  assert.equal(after.statusCode, 200, "settling released the unused part of the reservation");
  const totals = await db.includedPeriod.findUniqueOrThrow({ where: { period } });
  assert.ok(Number(totals.spentUsd) > 0);
  await setCeiling(200);
});

test("a call stopped without usage is charged its reservation; an abandoned one expires at it", async () => {
  await setCeiling(200);
  const user = await harness.asUser();
  const held = (await reserve(user, { model: "gpt-6-luna", inputTokens: 2_000, maxOutputTokens: 16_000 })).json();
  const stopped = await settle(user, { id: held.id, usage: null });
  // 2,000 in at $0.10/M plus 16,000 out at $0.50/M = $0.0082.
  assert.ok(Math.abs(stopped.json().credits - 8.2) < 1e-9);
  assert.equal((await db.includedUsage.findUniqueOrThrow({ where: { id: held.id } })).status, "unreported");

  const old = await reserveIncluded({ userId: user.id, model: "gpt-6-luna", inputTokens: 1_000, maxOutputTokens: 1_000 });
  await db.includedUsage.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - STALE_RESERVATION_MS - 1_000) } });
  await reserveIncluded({ userId: user.id, model: "gpt-6-luna", inputTokens: 1_000, maxOutputTokens: 1_000 });
  const expired = await db.includedUsage.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(expired.status, "expired");
  assert.equal(Number(expired.usd), Number(expired.reservedUsd));
  assert.deepEqual(await settleIncluded({ id: old.id, usage: null }), { credits: Number(expired.usd) * 1000 }, "a late settle keeps the expiry");
});

test("a space spends its owner's credits", async () => {
  await setCeiling(200);
  const owner = await harness.asUser();
  const space = await createSpaceUser(db, owner.id, { name: "Side project", icon: null });
  const { id } = await reserveIncluded({ userId: space, model: "gpt-6-luna", inputTokens: 100, maxOutputTokens: 100 });
  const row = await db.includedUsage.findUniqueOrThrow({ where: { id } });
  assert.equal(row.accountId, owner.id);
  assert.equal(row.userId, space);
});

test("models the operator did not deploy, and a server without included AI, are refused as unavailable", async () => {
  const user = await harness.asUser();
  process.env.ENSEMBLE_INCLUDED_MODELS = "gpt-6-luna,gpt-6.1-sol";
  try {
    const refused = await reserve(user, { model: "grok-4.7", inputTokens: 10, maxOutputTokens: 10 });
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.json().code, "included_unavailable");
    assert.equal((await user.inject({ method: "GET", url: "/api/metrics/credits" })).json().models.length, 2);
    process.env.ENSEMBLE_INCLUDED_MODELS = "off";
    const off = await reserve(user, { model: "gpt-6-luna", inputTokens: 10, maxOutputTokens: 10 });
    assert.equal(off.statusCode, 503);
    assert.equal((await user.inject({ method: "GET", url: "/api/metrics/credits" })).json().available, false);
  } finally {
    delete process.env.ENSEMBLE_INCLUDED_MODELS;
  }
});

test("the reserve and settle routes need the internal token", async () => {
  const user = await harness.asUser();
  const outside = await user.inject({ method: "POST", url: "/api/internal/included/reserve", payload: { model: "gpt-6-luna", inputTokens: 1, maxOutputTokens: 1 } });
  assert.equal(outside.statusCode, 401);
});

test("hosted: a tier whose provider has no key for this account reads as an included model; working tiers stay", async () => {
  const user = await harness.asUser();
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const chosen = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        medium: { provider: "openai" as const, model: "gpt-6-luna", effort: "low" as const },
        high: { provider: "anthropic" as const, model: "claude-sonnet-5-5", effort: "default" as const },
        max: { provider: "claude-code" as const, model: "haiku", effort: "default" as const },
      },
    };
    await db.modelCredential.create({ data: { userId: user.id, provider: "anthropic", secret: "v1:not-a-real-secret", hint: "…test" } });
    const read = await withIncludedDefaults(db, user.id, chosen);
    assert.deepEqual(read.models.easy, { provider: "ensemble", model: "gpt-6-luna", effort: "default" }, "the shipped Gemini default with no Google key");
    assert.deepEqual(read.models.medium, { provider: "ensemble", model: "gpt-6-luna", effort: "default" }, "a chosen OpenAI model with no OpenAI key");
    assert.deepEqual(read.models.high, chosen.models.high, "a tier on the account's own key is never changed");
    assert.deepEqual(read.models.max, chosen.models.max, "a tier on the person's AI plan is never changed");
    await db.modelCredential.create({ data: { userId: user.id, provider: "google", secret: "v1:not-a-real-secret", hint: "…test" } });
    assert.deepEqual((await withIncludedDefaults(db, user.id, DEFAULT_SETTINGS)).models.easy, DEFAULT_SETTINGS.models.easy);
    process.env.ENSEMBLE_INCLUDED_MODELS = "gpt-5-mini,gpt-4.1-mini";
    const free = await withIncludedDefaults(db, user.id, chosen);
    assert.deepEqual(free.models.medium, { provider: "ensemble", model: "gpt-5-mini", effort: "default" }, "a free account's models");
    assert.deepEqual((await withIncludedDefaults(db, (await harness.asUser()).id, DEFAULT_SETTINGS)).models.max, { provider: "ensemble", model: "gpt-5-mini", effort: "high" });
  } finally {
    process.env.NODE_ENV = before;
    delete process.env.ENSEMBLE_INCLUDED_MODELS;
  }
  assert.deepEqual((await withIncludedDefaults(db, user.id, DEFAULT_SETTINGS)).models, DEFAULT_SETTINGS.models, "not hosted: unchanged");
});

