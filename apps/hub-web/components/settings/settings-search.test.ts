import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_DESTINATION_BY_ID } from "./navigation.js";
import { searchSettings, settingsScore } from "./settings-search.js";
import { parseSettingsLocation } from "./url-state.js";

test("a few words find the row, with where it is and what it does", () => {
  const quiet = searchSettings("quiet hours")[0]!;
  assert.equal(quiet.label, "Quiet hours");
  assert.equal(quiet.tab, "notifications");
  assert.equal(quiet.anchor, "jump-quiet-quiet-hours");
  assert.match(quiet.about ?? "", /Notifications wait/);

  assert.equal(searchSettings("dark")[0]?.anchor, "jump-appearance-theme");
  assert.equal(searchSettings("sandbox")[0]?.tab, "agents");
  assert.equal(searchSettings("api keys")[0]?.dialog, "keys");
  assert.equal(searchSettings("colour")[0]?.place.startsWith("Appearance"), true, "British spelling finds colour settings");
  assert.equal(searchSettings("agents")[0]?.key, "tab-agents", "a tab by its name comes first");
  assert.deepEqual(searchSettings("   "), []);
  assert.deepEqual(searchSettings("zzzz"), []);
});

test("every hit opens the tab it names, and hidden tabs and owner-only rows stay out", () => {
  for (const query of ["time", "model", "delete", "folder", "sync", "notification", "theme"]) {
    for (const hit of searchSettings(query, { limit: 50 })) {
      if (!hit.anchor) continue;
      assert.equal(parseSettingsLocation(`?tab=${hit.tab}`, `#${hit.anchor}`).tab, hit.tab, hit.key);
      assert.ok(SETTINGS_DESTINATION_BY_ID.has(hit.anchor), hit.key);
    }
  }
  assert.ok(searchSettings("trash").some((hit) => hit.tab === "data"));
  assert.ok(!searchSettings("trash", { guest: true }).some((hit) => hit.tab === "data"));
  assert.ok(!searchSettings("shortcuts", { hidden: ["shortcuts"] }).some((hit) => hit.tab === "shortcuts"));
  const labels = searchSettings("model", { limit: 50 }).map((hit) => `${hit.tab}:${hit.label.toLowerCase()}`);
  assert.equal(new Set(labels).size, labels.length, "no repeats");
});

test("the score prefers the label, then its start, then any word", () => {
  assert.equal(settingsScore("accent", "Accent", "Appearance › Theme"), 100);
  assert.equal(settingsScore("acc", "Accent", "Appearance › Theme"), 80);
  assert.equal(settingsScore("theme", "Accent", "Appearance › Theme"), 20);
  assert.equal(settingsScore("purple", "Accent", "Appearance › Theme"), 0);
});
