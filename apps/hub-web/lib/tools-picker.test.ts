import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCatalogApp } from "@ensemble/shared-types";
import { appIsOn, offLabel, setApp, setTool, toolIsOn } from "./tools-picker.js";

const GOOGLE: ToolCatalogApp = {
  key: "google_workspace",
  name: "Google Workspace",
  logo: "google",
  source: "connector",
  account: null,
  tools: [
    { name: "gmail_search", title: "Search", product: "Gmail", write: false },
    { name: "gmail_read", title: "Read", product: "Gmail", write: false },
    { name: "calendar_create_event", title: "Create event", product: "Google Calendar", write: true, blocked: "Changes in apps are off" },
  ],
};
const ACME: ToolCatalogApp = { key: "mcp:custom-acme", name: "Acme", logo: null, source: "mcp", account: null, tools: [{ name: "deploy", title: "Deploy", write: true }] };

test("switching an app off drops its single tools, and on again clears it", () => {
  const one = setTool([], GOOGLE, "gmail_search", false);
  assert.deepEqual(one, ["google_workspace/gmail_search"]);
  assert.equal(toolIsOn(one, GOOGLE, "gmail_search"), false);
  assert.equal(appIsOn(one, GOOGLE), true);
  assert.deepEqual(setApp(one, GOOGLE, false), ["google_workspace"]);
  assert.deepEqual(setApp(["google_workspace", "mcp:custom-acme"], GOOGLE, true), ["mcp:custom-acme"]);
});

test("the last usable tool off becomes the app, and one tool back on from an app that is off keeps the rest off", () => {
  const both = setTool(setTool([], GOOGLE, "gmail_search", false), GOOGLE, "gmail_read", false);
  assert.deepEqual(both, ["google_workspace"], "the blocked tool does not count");
  assert.deepEqual(setTool(["google_workspace"], GOOGLE, "gmail_read", true), ["google_workspace/gmail_search"]);
});

test("the trigger says what is off in a few words", () => {
  assert.equal(offLabel([], [GOOGLE, ACME]), "All on");
  assert.equal(offLabel(["mcp:custom-acme"], [GOOGLE, ACME]), "1 app off");
  assert.equal(offLabel(["mcp:custom-acme", "google_workspace/gmail_search"], [GOOGLE, ACME]), "1 app, 1 tool off");
  assert.equal(offLabel(["notion"], [GOOGLE, ACME]), "All on", "an app no longer connected is not counted");
});
