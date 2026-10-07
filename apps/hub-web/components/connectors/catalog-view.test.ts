import assert from "node:assert/strict";
import test from "node:test";
import { categoryCounts, entryStatus, featuredEntries, filterEntries, statusLabel } from "./catalog-view.js";
import { catalogWith } from "./test-fixtures.js";

test("Settings shows exactly the five featured connectors, in order", () => {
  const featured = featuredEntries(catalogWith());
  assert.deepEqual(
    featured.map((entry) => entry.id),
    ["google_workspace", "microsoft_365", "notion", "linear", "github"],
  );
});

test("search matches names, vendors, taglines and products; every word must match", () => {
  const entries = catalogWith();
  assert.deepEqual(filterEntries(entries, { query: "jira" }).map((entry) => entry.id), ["atlassian"]);
  assert.ok(filterEntries(entries, { query: "teams" }).some((entry) => entry.id === "microsoft_365"));
  assert.ok(filterEntries(entries, { query: "GMAIL" }).some((entry) => entry.id === "google_workspace"));
  assert.equal(filterEntries(entries, { query: "notion zzzz" }).length, 0);
});

test("categories, Connected and Import filter the store", () => {
  const entries = catalogWith({ notion: { connected: true, account: "mira@fieldnote.example" }, granola: { mcp: { status: "connected", toolCount: 4, lastError: null } } });
  assert.ok(filterEntries(entries, { category: "work_tracking" }).every((entry) => entry.category === "work_tracking"));
  assert.deepEqual(filterEntries(entries, { category: "connected" }).map((entry) => entry.id).sort(), ["granola", "notion"]);
  assert.ok(filterEntries(entries, { category: "import" }).every((entry) => entry.import));
  assert.ok(filterEntries(entries, { category: "import" }).some((entry) => entry.id === "csv"));
  const counts = categoryCounts(entries);
  assert.equal(counts.all, entries.length);
  assert.equal(counts.connected, 2);
});

test("coming-soon entries sort after ready ones", () => {
  const list = filterEntries(catalogWith(), { category: "cloud" });
  assert.ok(list.length > 0);
  const firstSoon = list.findIndex((entry) => entry.status === "soon");
  assert.ok(list.slice(firstSoon).every((entry) => entry.status === "soon"));
});

test("status labels say who is connected, and when the server is not set up", () => {
  const entries = catalogWith({
    google_workspace: { connected: true, account: "mira@fieldnote.example" },
    microsoft_365: { appReady: false, oauthReady: false },
    github: { appReady: true, oauthReady: false },
  });
  const by = (id: string) => entries.find((entry) => entry.id === id)!;
  assert.equal(statusLabel(by("google_workspace")), "Connected as mira@fieldnote.example");
  assert.equal(entryStatus(by("microsoft_365")), "not_set_up");
  assert.equal(statusLabel(by("microsoft_365")), "Not set up on this server");
  // GitHub still works with a pasted token when its OAuth app is missing.
  assert.equal(statusLabel(by("github")), "Not connected");
  assert.equal(statusLabel(by("csv")), "Import from a file");
  assert.equal(statusLabel(by("aws")), "Coming soon");
});
