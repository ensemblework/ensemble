import assert from "node:assert/strict";
import test from "node:test";
import { figureBytes } from "./figure-file.js";

test("svg export keeps the markup instead of base64-decoding it", () => {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>`;
  const blob = figureBytes("svg", markup);
  assert.equal(blob.type, "image/svg+xml");
  assert.equal(blob.size, markup.length);
});

test("png export decodes the base64 payload", () => {
  const blob = figureBytes("png", Buffer.from("png").toString("base64"));
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 3);
});
