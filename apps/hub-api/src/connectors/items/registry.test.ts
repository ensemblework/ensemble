import "../../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import { ITEM_SOURCES } from "./registry.js";

test("every searchable app matches its store entry: same kinds, and people and comments only where both promise them", () => {
  const ids = new Set<string>();
  for (const source of ITEM_SOURCES) {
    assert.ok(!ids.has(source.id), `${source.id} is listed twice`);
    ids.add(source.id);
    const entry = CONNECTOR_CATALOG.find((row) => row.id === source.id);
    assert.ok(entry?.items, `${source.id} has a store entry with items`);
    assert.equal(entry.provider, source.provider, `${source.id} signs in with the same account`);
    assert.deepEqual([...source.kinds].sort(), [...entry.items.kinds].sort(), `${source.id} kinds`);
    if (entry.items.people) assert.ok(source.people, `${source.id} promises people`);
    if (entry.items.comments) assert.ok(source.comment, `${source.id} promises comments`);
  }
  for (const entry of CONNECTOR_CATALOG) {
    if (entry.items) assert.ok(ids.has(entry.id), `${entry.id} promises items but has no source`);
  }
});

test("ids that could leave a vendor path or add a query never reach a source", async () => {
  const { safeItemId } = await import("./index.js");
  for (const id of ["fieldnote/atlas#42", "Fieldnote Web/42", "id:a4ayc_80_OEAAAAAAAAAXw", "ENG-42", "AAMkAGI2TG93AAA=", "01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K"]) {
    assert.equal(safeItemId(id), id);
  }
  for (const id of ["../users/me", "a/../../b", "42?fields=*", "42&x=1", "42%2F..", "a\\b", "line\nbreak", "", " ".repeat(3), "x".repeat(301)]) {
    assert.throws(() => safeItemId(id), /not an item id/, JSON.stringify(id));
  }
});
