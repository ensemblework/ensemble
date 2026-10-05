import assert from "node:assert/strict";
import test from "node:test";
import { parseDeskIntent } from "./intents.js";

test("mock and hearing lines parse", () => {
  const mock = parseDeskIntent("mock 112/200 today", "2026-09-30");
  assert.ok(mock && "intent" in mock && mock.intent.kind === "mock");
  if (mock && "intent" in mock && mock.intent.kind === "mock") {
    assert.equal(mock.intent.score, 112);
    assert.equal(mock.intent.outOf, 200);
    assert.equal(mock.intent.subject, "");
    assert.equal(mock.intent.day, "2026-09-30");
  }
  const hearing = parseDeskIntent("hearing Rao v Sunrise 5 Oct Court 32", "2026-09-30");
  assert.ok(hearing && "intent" in hearing && hearing.intent.kind === "hearing");
  if (hearing && "intent" in hearing && hearing.intent.kind === "hearing") {
    assert.equal(hearing.intent.title, "Rao v Sunrise");
    assert.equal(hearing.intent.day, "2026-10-05");
    assert.equal(hearing.intent.court, "Court 32");
  }
  assert.equal(parseDeskIntent("remind Priya Friday", "2026-09-30"), null);
  const bad = parseDeskIntent("mock 300/200", "2026-09-30");
  assert.ok(bad && "error" in bad);
});
