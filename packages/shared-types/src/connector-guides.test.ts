import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTOR_GUIDES, connectorGuide, guideParts, guideUrls, hasWrittenGuide, IMPORT_TIPS } from "./connector-guides.js";
import { CONNECTOR_CATALOG } from "./connectors.js";

test("every connector that takes a pasted token has a written guide in the vendor's words", () => {
  for (const entry of CONNECTOR_CATALOG.filter((row) => row.auth.includes("token"))) {
    const guide = CONNECTOR_GUIDES[entry.id];
    assert.ok(guide, `${entry.id} has a guide`);
    assert.ok(guide.term, `${entry.id} names what is pasted`);
    assert.ok(guide.steps.length >= 2, `${entry.id} has steps`);
    assert.equal(connectorGuide(entry, "token"), guide);
    assert.ok(hasWrittenGuide(entry, "token"));
  }
});

test("every MCP server that takes a token, an address or your own app has a written guide", () => {
  const needs = CONNECTOR_CATALOG.filter((row) => row.mcp && !row.auth.includes("token") && (row.mcp.token || row.mcp.fields?.length || row.mcp.ownClient));
  assert.ok(needs.length >= 9);
  for (const entry of needs) {
    const guide = CONNECTOR_GUIDES[entry.id];
    assert.ok(guide, `${entry.id} has a guide`);
    assert.equal(connectorGuide(entry, "mcp"), guide);
    if (entry.mcp!.token) {
      assert.ok(guide.term, `${entry.id} names its token`);
      assert.ok(entry.mcp!.token.label.toLowerCase().includes(guide.term!.toLowerCase()), `${entry.id}: the field label "${entry.mcp!.token.label}" uses the guide's word "${guide.term}"`);
    }
    for (const field of entry.mcp!.fields ?? []) assert.ok(guide.steps.some((step) => step.includes(field.label)), `${entry.id} names the ${field.label} field`);
  }
});

test("sign-in and plain MCP connectors get a short guide that says what to approve", () => {
  for (const entry of CONNECTOR_CATALOG) {
    if (entry.auth.includes("oauth")) {
      const guide = connectorGuide(entry, "oauth")!;
      assert.ok(guide.steps.some((step) => /approve|Authorize|allow access/i.test(step)), `${entry.id} says what to approve`);
    }
    if (entry.mcp) assert.ok(connectorGuide(entry, "mcp")?.steps.length, `${entry.id} has an MCP guide`);
  }
  const linear = CONNECTOR_CATALOG.find((row) => row.id === "linear")!;
  assert.match(connectorGuide(linear, "mcp")!.steps.join(" "), /Use your Linear connection/);
  const google = CONNECTOR_CATALOG.find((row) => row.id === "google_workspace")!;
  assert.match(connectorGuide(google, "oauth")!.steps.join(" "), /Sign in with Google/);
  assert.equal(connectorGuide(google, "token"), undefined);
});

test("guides belong to catalog entries, link only https, and hold at most one link per step", () => {
  const ids = new Set(CONNECTOR_CATALOG.map((entry) => entry.id));
  for (const id of [...Object.keys(CONNECTOR_GUIDES), ...Object.keys(IMPORT_TIPS)]) assert.ok(ids.has(id), `${id} is in the catalog`);
  const guides = [
    ...Object.values(CONNECTOR_GUIDES),
    ...CONNECTOR_CATALOG.flatMap((entry) => (["oauth", "token", "mcp"] as const).map((way) => connectorGuide(entry, way)).filter((guide) => guide !== undefined)),
  ];
  for (const guide of guides) {
    for (const url of guideUrls(guide)) assert.match(url, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$|#)/, url);
    for (const step of guide.steps) assert.ok((step.match(/https?:\/\//g) ?? []).length <= 1, step);
  }
});

test("Trello's guide points at the Token link and warns off the Secret", () => {
  const trello = CONNECTOR_GUIDES.trello!;
  assert.match(trello.steps.join(" "), /power-ups\/admin/);
  assert.match(trello.steps.join(" "), /Token link/);
  assert.match(trello.looksLike!, /ATTA/);
  assert.match(trello.notThis!, /Secret/);
  assert.match(IMPORT_TIPS.trello!, /Export as JSON/);
});

test("guideParts turns addresses into links and keeps sentence punctuation outside", () => {
  assert.deepEqual(guideParts("Open https://trello.com/power-ups/admin."), [
    { text: "Open " },
    { text: "trello.com/power-ups/admin", href: "https://trello.com/power-ups/admin" },
    { text: "." },
  ]);
  assert.deepEqual(guideParts("No link here"), [{ text: "No link here" }]);
});
