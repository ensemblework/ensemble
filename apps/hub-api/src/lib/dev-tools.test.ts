import assert from "node:assert/strict";
import test from "node:test";
import { envDevTools } from "./dev-tools.js";

test("ENSEMBLE_DEV_TOOLS opens the switcher in dev and stays off in production", () => {
  const prevNode = process.env.NODE_ENV;
  const prev = process.env.ENSEMBLE_DEV_TOOLS;
  try {
    process.env.NODE_ENV = "development";
    process.env.ENSEMBLE_DEV_TOOLS = "1";
    assert.equal(envDevTools(), true);
    process.env.ENSEMBLE_DEV_TOOLS = "true";
    assert.equal(envDevTools(), true);
    process.env.ENSEMBLE_DEV_TOOLS = "0";
    assert.equal(envDevTools(), false);
    process.env.NODE_ENV = "production";
    process.env.ENSEMBLE_DEV_TOOLS = "1";
    assert.equal(envDevTools(), false);
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prev === undefined) delete process.env.ENSEMBLE_DEV_TOOLS;
    else process.env.ENSEMBLE_DEV_TOOLS = prev;
  }
});
