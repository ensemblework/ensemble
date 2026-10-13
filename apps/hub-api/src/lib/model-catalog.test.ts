import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { CATALOG_WEEK_MS, catalogStale } = await import("./model-catalog.js");
const { effortToSend, rememberMeta } = await import("./model-meta.js");

test("a stored model list is fetched again after a week, for a new key, and ten minutes after an error", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const row = (ageMs: number, error: string | null = null, keyHint = "…r2Qw") => ({ fetchedAt: new Date(now - ageMs), keyHint, entry: { models: [], error } });
  assert.equal(catalogStale(undefined, "…r2Qw", now), true, "never fetched");
  assert.equal(catalogStale(row(6 * 24 * 3_600_000), "…r2Qw", now), false, "six days old");
  assert.equal(catalogStale(row(CATALOG_WEEK_MS + 1), "…r2Qw", now), true, "a week old");
  assert.equal(catalogStale(row(60_000), "…new1", now), true, "another key");
  assert.equal(catalogStale(row(5 * 60_000, "HTTP 503"), "…r2Qw", now), false);
  assert.equal(catalogStale(row(11 * 60_000, "HTTP 503"), "…r2Qw", now), true);
});

test("a model call sends the chosen level, or is refused before anything is sent", async () => {
  rememberMeta("space-1", "copilot", { "claude-opus-5.5": { efforts: ["low", "medium", "high", "xhigh", "max"] }, "gpt-4.1": { efforts: [] } });
  assert.equal(await effortToSend("space-1", "copilot", "claude-opus-5.5", "max"), "max");
  assert.equal(await effortToSend("space-1", "copilot", "claude-opus-5.5", "default"), undefined);
  assert.equal(await effortToSend("space-1", "copilot", "gpt-4.1", "high"), undefined, "no thinking setting on that model");
  await assert.rejects(
    () => effortToSend("space-1", "copilot", "claude-opus-5.5", "minimal"),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.match((error as Error).message, /claude-opus-5\.5 does not take thinking “Minimal”\. It takes Low, Medium, High, Extra high and Max/);
      return true;
    },
  );
  rememberMeta("space-1", "google", {});
  assert.equal(await effortToSend("space-1", null, "gemini-3.5-flash-lite", "minimal"), "minimal", "the provider is read from the model name");
});
