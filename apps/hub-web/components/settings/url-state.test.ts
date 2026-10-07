import assert from "node:assert/strict";
import test from "node:test";
import { parseSettingsLocation, SECTION_TAB, settingsUrl } from "./url-state.js";

test("old one-page hashes land on the tab that now holds the section", () => {
  const cases: Array<[string, string]> = [
    ["#models", "assistant"],
    ["#assistant", "assistant"],
    ["#autonomy", "assistant"],
    ["#prompts", "assistant"],
    ["#quiet", "assistant"],
    ["#connections", "connections"],
    ["#connect", "connections"],
    ["#fetch", "connections"],
    ["#editors", "connections"],
    ["#devices", "connections"],
    ["#retention", "data"],
    ["#completed", "data"],
    ["#trash", "data"],
    ["#terminal", "data"],
    ["#danger", "data"],
    ["#brief", "notifications"],
    ["#nudges", "notifications"],
    ["#reminders", "notifications"],
    ["#capture", "notifications"],
    ["#account", "account"],
    ["#features", "account"],
    ["#appearance", "account"],
    ["#you", "account"],
    ["#this-mac", "account"],
  ];
  for (const [hash, tab] of cases) {
    const location = parseSettingsLocation("", hash);
    assert.equal(location.tab, tab, hash);
    assert.equal(location.anchor, hash.slice(1), hash);
  }
});

test("every hash the old Settings nav linked to is still mapped", () => {
  const old = ["account", "features", "appearance", "you", "autonomy", "orchestration", "prompts", "models", "assistant", "fetch", "quiet", "editors", "devices", "connections", "connect", "retention", "completed", "trash", "brief", "nudges", "capture", "reminders", "terminal", "danger", "this-mac"];
  for (const id of old) assert.ok(SECTION_TAB[id], id);
});

test("the tab parameter wins, and store links open Connections", () => {
  assert.equal(parseSettingsLocation("?tab=data", "#models").tab, "data");
  assert.equal(parseSettingsLocation("?tab=nope", "").tab, "account");
  assert.equal(parseSettingsLocation("", "").tab, "account");
  const store = parseSettingsLocation("?connector=google_workspace", "");
  assert.equal(store.tab, "connections");
  assert.equal(store.connector, "google_workspace");
  assert.equal(parseSettingsLocation("?store=chat", "").tab, "connections");
  assert.equal(parseSettingsLocation("?dialog=keys", "").tab, "assistant");
  assert.equal(parseSettingsLocation("?tab=assistant&dialog=bogus", "").dialog, null);
});

test("settingsUrl writes the view and keeps unrelated parameters", () => {
  const url = settingsUrl(
    { tab: "connections", anchor: null, connector: "notion", store: "all", dialog: null },
    { pathname: "/settings", search: "?from=mail&dialog=keys" },
  );
  assert.equal(url, "/settings?from=mail&tab=connections&store=all&connector=notion");
  assert.equal(settingsUrl({ tab: "data", anchor: "trash", connector: null, store: null, dialog: null }), "/settings?tab=data#trash");
});
