import assert from "node:assert/strict";
import test from "node:test";
import { spaceInitial, spaceLabel } from "./spaces";

test("a space's initial is the first letter or digit of its name, not a leading emoji", () => {
  assert.equal(spaceInitial("work"), "W");
  assert.equal(spaceInitial("🚀 Launch"), "L");
  assert.equal(spaceInitial("⚖️ Law firm"), "L");
  assert.equal(spaceInitial("🇮🇳 2026 trip"), "2");
  assert.equal(spaceInitial("👩🏽‍💻"), "👩🏽‍💻");
  assert.equal(spaceInitial("   "), "S");
});

test("the name beside the icon does not repeat the emoji the icon already shows", () => {
  assert.equal(spaceLabel({ name: "🚀 Launch", icon: null }), "🚀 Launch");
  assert.equal(spaceLabel({ name: "🚀 Launch", icon: "🚀" }), "Launch");
  assert.equal(spaceLabel({ name: "⚖ Law", icon: "⚖️" }), "Law");
  assert.equal(spaceLabel({ name: "🚀 Launch", icon: "🎯" }), "🚀 Launch");
  assert.equal(spaceLabel({ name: "Personal", icon: "🏠" }), "Personal");
  assert.equal(spaceLabel({ name: "🚀", icon: null }), "🚀");
});
