import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_MAP } from "@ensemble/shared-types";
import { SETTINGS_DESTINATION_BY_ID } from "./navigation.js";
import { parseSettingsLocation, SECTION_TAB, settingsUrl } from "./url-state.js";

test("old one-page hashes land on the tab that now holds the section", () => {
  const cases: Array<[string, string]> = [
    ["#models", "assistant"],
    ["#assistant", "assistant"],
    ["#autonomy", "agents"],
    ["#orchestration", "agents"],
    ["#prompts", "assistant"],
    ["#quiet", "notifications"],
    ["#connections", "connections"],
    ["#connect", "connections"],
    ["#fetch", "connections"],
    ["#editors", "connections"],
    ["#devices", "connections"],
    ["#retention", "data"],
    ["#completed", "data"],
    ["#trash", "data"],
    ["#terminal", "agents"],
    ["#failed", "connections"],
    ["#danger", "data"],
    ["#brief", "notifications"],
    ["#nudges", "notifications"],
    ["#reminders", "notifications"],
    ["#capture", "notifications"],
    ["#account", "account"],
    ["#features", "account"],
    ["#appearance", "appearance"],
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

test("every link in the shared settings map opens its tab and lands on a known control", () => {
  for (const entry of SETTINGS_MAP) {
    const url = new URL(entry.href, "https://ensemble.test");
    assert.equal(url.pathname, "/settings", entry.id);
    const location = parseSettingsLocation(url.search, url.hash);
    assert.equal(location.tab, entry.tab, entry.id);
    if (url.searchParams.get("dialog")) {
      assert.equal(location.dialog, url.searchParams.get("dialog"), entry.id);
      continue;
    }
    const anchor = location.anchor;
    assert.ok(anchor, `${entry.id} has an anchor`);
    const destination = SETTINGS_DESTINATION_BY_ID.get(anchor);
    assert.equal(destination?.tab ?? SECTION_TAB[anchor], entry.tab, `${entry.id}: #${anchor}`);
  }
});

test("old explicit Account appearance bookmarks now select Appearance", () => {
  assert.equal(parseSettingsLocation("?tab=account", "#appearance").tab, "appearance");
  assert.equal(parseSettingsLocation("?tab=account", "#jump-appearance-accent").tab, "appearance");
});

test("old account-deletion links open Data's danger zone", () => {
  assert.equal(parseSettingsLocation("?tab=account", "#jump-account-delete-account").tab, "data");
});

test("links written before a section moved tab open where it is now", () => {
  for (const [search, hash, tab] of [
    ["?tab=assistant", "#quiet", "notifications"],
    ["?tab=assistant", "#autonomy", "agents"],
    ["?tab=assistant", "#orchestration", "agents"],
    ["?tab=data", "#terminal", "agents"],
    ["?tab=data", "#failed", "connections"],
    ["?tab=assistant", "#jump-quiet-quiet-hours-start", "notifications"],
    ["?tab=data", "#jump-terminal-folders-code-can-use", "agents"],
    ["?tab=assistant", "#jump-automations-tell-me-when-agent-work-waits-for-review", "notifications"],
    ["?tab=data", "#jump-trash-trash", "data"],
  ] as const) {
    assert.equal(parseSettingsLocation(search, hash).tab, tab, `${search}${hash}`);
  }
  // A section that never moved keeps the tab the link names.
  assert.equal(parseSettingsLocation("?tab=data", "#models").tab, "data");
});

test("renamed controls keep their old jump ids", () => {
  for (const [old, now] of [
    ["jump-automations-tell-me-when-agent-work-waits-for-review", "jump-nudges-tell-me-when-agent-work-waits-for-review"],
    ["jump-export-export-space", "jump-export-download-this-space"],
    ["jump-trash-trash", "jump-completed-trash"],
    ["jump-appearance-text-and-font", "jump-appearance-text"],
  ]) {
    assert.equal(SETTINGS_DESTINATION_BY_ID.get(old)?.id, now, old);
  }
});
