/**
 * Model lists are kept a week per key and fetched again only when stale, for a new key, or on
 * Refresh; a paired computer reads the account's keys unless the person turned that off.
 * Runs on PGlite with the in-process runtime and a fake provider.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
const { createHttpHarness } = await import("../test/http.js");
const harness = await createHttpHarness();
const { setRuntimeFetchForTests, clearCatalogCache } = await import("../runtime/models.js");
after(async () => {
  setRuntimeFetchForTests(null);
  await harness.close();
});

const geminiCalls: string[] = [];
setRuntimeFetchForTests(async (input) => {
  const url = String(input);
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls.push(url);
    return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});

type Catalog = { providers: Array<{ provider: string; models: string[]; available: boolean; fetchedAt?: string | null }>; fetchedAt: string | null; runtime: boolean };

test("a provider's list is stored, served without asking again, and fetched again on Refresh or a new key", async () => {
  const mira = await harness.asUser();
  const saved = await mira.inject({ method: "PUT", url: "/api/model-keys/google", payload: { apiKey: "AIza-test-key-0001" } });
  assert.equal(saved.statusCode, 200, saved.body);
  clearCatalogCache();
  geminiCalls.length = 0;

  const first = (await mira.inject({ method: "GET", url: "/api/models" })).json<Catalog>();
  assert.equal(first.runtime, true);
  const google = first.providers.find((row) => row.provider === "google")!;
  assert.deepEqual(google.models, ["gemini-3.5-flash-lite", "gemini-3.5-flash"]);
  assert.ok(google.fetchedAt);
  assert.ok(first.fetchedAt);
  assert.equal(first.providers.find((row) => row.provider === "openai")?.available, false, "providers without a key are listed, not fetched");
  assert.equal(geminiCalls.length, 1);
  const stored = await harness.prisma.modelCatalog.findUnique({ where: { userId_provider: { userId: mira.id, provider: "google" } } });
  assert.ok(stored, "the list is kept");

  clearCatalogCache();
  await harness.prisma.modelCatalog.update({ where: { userId_provider: { userId: mira.id, provider: "google" } }, data: { fetchedAt: new Date(Date.now() - 6 * 24 * 3_600_000) } });
  const later = await mira.inject({ method: "POST", url: "/api/models/refresh", payload: { providers: ["openai"] } });
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(geminiCalls.length, 1, "a six-day-old list is still used; refreshing another provider does not ask Google");

  const refreshed = await mira.inject({ method: "POST", url: "/api/models/refresh", payload: {} });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(geminiCalls.length, 2, "Refresh asks every provider with a key");

  await harness.prisma.modelCatalog.update({ where: { userId_provider: { userId: mira.id, provider: "google" } }, data: { fetchedAt: new Date(Date.now() - 8 * 24 * 3_600_000) } });
  clearCatalogCache();
  await mira.inject({ method: "POST", url: "/api/models/refresh", payload: { providers: ["openai"] } });
  assert.equal(geminiCalls.length, 3, "a list older than a week is fetched again");

  const removed = await mira.inject({ method: "DELETE", url: "/api/model-keys/google" });
  assert.equal(removed.statusCode, 204);
  assert.equal(await harness.prisma.modelCatalog.count({ where: { userId: mira.id } }), 0, "no key, no stored list");
});

test("a paired computer reads the account's keys, unless the person turned that off", async () => {
  const ben = await harness.asUser();
  assert.equal((await ben.inject({ method: "PUT", url: "/api/model-keys/google", payload: { apiKey: "AIza-test-key-0002" } })).statusCode, 200);
  const device = await harness.asToken(ben, "device");
  await harness.prisma.device.create({ data: { userId: ben.id, name: "Studio Mac", platform: "macos", tokenId: device.id } });
  const read = await device.inject({ method: "GET", url: "/api/devices/self/model-keys" });
  assert.equal(read.statusCode, 200, read.body);
  const body = read.json<{ shared: boolean; keys: Array<{ provider: string; secret: string; hint: string }> }>();
  assert.equal(body.shared, true);
  assert.deepEqual(body.keys.map((key) => [key.provider, key.secret]), [["google", "AIza-test-key-0002"]]);
  const ledger = await harness.prisma.auditLedger.findMany({ where: { userId: ben.id, action: "model.keys.device" } });
  assert.equal(ledger.length, 1);
  assert.equal(JSON.stringify(ledger[0]!.payload).includes("AIza"), false, "the ledger names providers, never keys");

  const browser = await ben.inject({ method: "GET", url: "/api/devices/self/model-keys" });
  assert.equal(browser.statusCode, 403, "only the paired computer");

  assert.equal((await ben.inject({ method: "PATCH", url: "/api/settings", payload: { models: { keysOnComputers: false } } })).statusCode, 200);
  const off = (await device.inject({ method: "GET", url: "/api/devices/self/model-keys" })).json<{ shared: boolean; keys: unknown[] }>();
  assert.deepEqual(off, { shared: false, keys: [] });
});
