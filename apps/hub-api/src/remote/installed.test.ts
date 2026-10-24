import assert from "node:assert/strict";
import { test } from "node:test";
import { launcherRemoved, UNINSTALL_GRACE_MS } from "./installed.js";

const gone = () => false;
const there = () => true;

test("a launcher missing for a moment (a package upgrade relinking it) does not count as an uninstall", () => {
  assert.equal(launcherRemoved("/opt/homebrew/bin/ensemble", 0, gone), false);
  assert.equal(launcherRemoved("/opt/homebrew/bin/ensemble", 30_000, gone), false);
  assert.equal(launcherRemoved("/opt/homebrew/bin/ensemble", 60_000, there), false);
  assert.equal(launcherRemoved("/opt/homebrew/bin/ensemble", 60_000 + UNINSTALL_GRACE_MS, gone), false, "the grace starts again after the launcher came back");
});

test("a launcher missing on every check for the grace period counts as an uninstall", () => {
  launcherRemoved("/usr/local/bin/ensemble", 0, there);
  assert.equal(launcherRemoved("/usr/local/bin/ensemble", 1_000, gone), false);
  assert.equal(launcherRemoved("/usr/local/bin/ensemble", 1_000 + UNINSTALL_GRACE_MS - 1, gone), false);
  assert.equal(launcherRemoved("/usr/local/bin/ensemble", 1_000 + UNINSTALL_GRACE_MS, gone), true);
});

test("no launcher path (a development runtime) is never an uninstall", () => {
  assert.equal(launcherRemoved(undefined, UNINSTALL_GRACE_MS * 2, gone), false);
});
