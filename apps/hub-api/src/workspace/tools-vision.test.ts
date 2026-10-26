import assert from "node:assert/strict";
import test from "node:test";
import { toolSpecs } from "./tools.js";

test("Ensemble's own model loop gets view_attachment; read_attachment (extracted text) is off", () => {
  for (const kind of ["code", "research"]) {
    const names = toolSpecs(kind, false, true).map((spec) => spec.name);
    assert.ok(names.includes("view_attachment"), kind);
    assert.ok(!names.includes("read_attachment"), kind);
    assert.ok(!toolSpecs(kind, false).some((spec) => spec.name === "view_attachment"), kind);
  }
});
