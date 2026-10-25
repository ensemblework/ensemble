import assert from "node:assert/strict";
import test from "node:test";
import { toolSpecs } from "./tools.js";

test("view_attachment is offered only to a model that reads images", () => {
  for (const kind of ["code", "research"]) {
    assert.ok(toolSpecs(kind, false, true).some((spec) => spec.name === "view_attachment"), kind);
    assert.ok(!toolSpecs(kind, false).some((spec) => spec.name === "view_attachment"), kind);
  }
});
