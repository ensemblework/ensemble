/**
 * Included models in the desktop app and the CLI (included/device.ts): a local-only computer is
 * refused with a way to connect; a connected one sends the call to Ensemble's server, which runs it
 * on the account's credits, and shows the server's refusals as its own. No network, no database.
 */
import "../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { INCLUDED_CREDITS_USED, INCLUDED_LOCAL_ONLY } from "@ensemble/shared-types";
import { completeText } from "../runtime/models.js";
import { assertIncludedOpen } from "./budget.js";
import { deviceCredits, deviceIncludedCatalogEntry, forgetDeviceIncluded, setDeviceLinkForTests } from "./device.js";
import { IncludedLimitError } from "./errors.js";

const RESETS = "2026-11-01T00:00:00.000Z";
const BASE = "https://hub.example";
const USAGE = { available: true, models: [], period: "2026-10", resetsAt: RESETS, limit: 20000, used: 1000, remaining: 19000, paused: false, totals: { calls: 1, inputTokens: 10, cachedTokens: 0, outputTokens: 3, inputCredits: 1, outputCredits: 1, credits: 2 }, byModel: [], byPurpose: [], days: [] };
const CATALOG = { provider: "ensemble", available: true, source: "included", models: ["gpt-5-mini"], meta: { "gpt-5-mini": { efforts: ["low", "medium", "high"] } }, chat: true, cheapest: "gpt-5-mini", error: null, notes: {} };
const ASK = { provider: "ensemble", model: "gpt-5-mini", userId: "local-user", system: "Be brief.", prompt: "Hi", purpose: "Assistant" };

type Seen = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;

/** Ensemble on the web, answering this computer's device routes. */
function server(answer: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const row = { method: init?.method ?? "GET", url: String(input), auth: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    seen.push(row);
    return answer(row);
  }) as typeof fetch;
  return seen;
}

test.beforeEach(() => {
  process.env.ENSEMBLE_DESKTOP = "1";
  forgetDeviceIncluded();
});

test.afterEach(() => {
  delete process.env.ENSEMBLE_DESKTOP;
  setDeviceLinkForTests(null);
  globalThis.fetch = realFetch;
});

test("local only: included models are listed as unavailable, and every call is refused with a way to connect", async () => {
  setDeviceLinkForTests(async () => null);
  const seen = server(() => json({}));
  await assert.rejects(completeText(ASK), (error) => {
    assert.ok(error instanceof IncludedLimitError);
    assert.deepEqual([error.code, error.statusCode, error.resetsAt], [INCLUDED_LOCAL_ONLY, 403, null]);
    assert.match(error.message, /connected to your Ensemble account.*Settings → Account → This computer/);
    return true;
  });
  await assert.rejects(assertIncludedOpen("local-user", "gpt-5-mini"), (error) => error instanceof IncludedLimitError && error.code === INCLUDED_LOCAL_ONLY);
  const row = await deviceIncludedCatalogEntry();
  assert.deepEqual([row.provider, row.available, row.code, row.models], ["ensemble", false, INCLUDED_LOCAL_ONLY, []]);
  const credits = await deviceCredits();
  assert.deepEqual([credits.available, credits.localOnly, credits.remaining], [false, true, 0]);
  assert.equal(seen.length, 0, "nothing is sent anywhere");
});

test("connected: the server runs the call for this computer's account, with its device token", async () => {
  setDeviceLinkForTests(async () => ({ base: BASE, token: "ens_device_token" }));
  const seen = server((row) => {
    if (row.url.endsWith("/api/devices/self/included")) return json({ catalog: CATALOG, usage: USAGE });
    if (row.url.endsWith("/api/devices/self/included/turn")) return json({ turn: { text: "Hello.", model: "gpt-5-mini", tokensIn: 12, tokensOut: 3, credits: 0.4 } });
    return json({ error: "not found" }, 404);
  });
  assert.deepEqual(await deviceIncludedCatalogEntry(), CATALOG);
  assert.equal((await deviceCredits()).remaining, 19000);
  await assertIncludedOpen("local-user", "gpt-5-mini");
  const out = await completeText(ASK);
  assert.deepEqual([out.text, out.model, out.credits], ["Hello.", "gpt-5-mini", 0.4]);
  const turn = seen.find((row) => row.method === "POST")!;
  assert.equal(turn.url, `${BASE}/api/devices/self/included/turn`);
  assert.equal(turn.auth, "Bearer ens_device_token");
  assert.deepEqual(turn.body?.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }]);
  assert.deepEqual([turn.body?.model, turn.body?.purpose, turn.body?.jsonMode], ["gpt-5-mini", "Assistant", false]);
  assert.equal("userId" in (turn.body ?? {}), false, "the server knows the account from the token");
  assert.equal(seen.filter((row) => row.method === "GET").length, 1, "the status is held between reads");
});

test("connected: the server's refusals are this computer's, and a removed computer is local only again", async () => {
  setDeviceLinkForTests(async () => ({ base: BASE, token: "ens_device_token" }));
  let refusal = json({ code: INCLUDED_CREDITS_USED, error: "You've used this month's Ensemble credits.", message: "You've used this month's Ensemble credits.", resetsAt: RESETS, status: 429 }, 429);
  server((row) => (row.url.endsWith("/included") ? json({ catalog: CATALOG, usage: { ...USAGE, used: 20000, remaining: 0 } }) : refusal));
  await assert.rejects(completeText(ASK), (error) => error instanceof IncludedLimitError && error.code === INCLUDED_CREDITS_USED && error.resetsAt === RESETS && error.statusCode === 429);
  await assert.rejects(assertIncludedOpen("local-user", "gpt-5-mini"), (error) => error instanceof IncludedLimitError && error.code === INCLUDED_CREDITS_USED);
  refusal = json({ error: "This computer is no longer paired." }, 401);
  await assert.rejects(completeText(ASK), (error) => {
    assert.ok(error instanceof IncludedLimitError);
    assert.equal(error.code, INCLUDED_LOCAL_ONLY);
    assert.match(error.message, /no longer connected to your Ensemble account/);
    return true;
  });
});
