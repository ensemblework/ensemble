import assert from "node:assert/strict";
import test from "node:test";
import { formatSandbox } from "./sandbox.js";

test("a working sandbox names the mechanism and what it cannot enforce", () => {
  const lines = formatSandbox({
    os: "linux",
    strength: "reduced",
    osSandbox: true,
    mechanism: "landlock",
    reason: "Linux sandbox (Landlock).",
    networkOff: false,
    limits: ["this kernel cannot turn the network off (needs Linux 6.7 or later)"],
  });
  assert.equal(lines[0], "sandbox: Linux sandbox (Landlock)");
  assert.ok(lines.includes("  internet off is not enforced on this computer"));
  assert.ok(lines.some((line) => line.startsWith("  not enforced: this kernel")));
});

test("Windows before setup says how to turn it on", () => {
  const lines = formatSandbox({
    os: "win32",
    strength: "advisory",
    osSandbox: false,
    mechanism: "none",
    reason: "The Windows sandbox is not set up on this computer yet.",
    setup: { needed: true, how: "Run `ensemble sandbox setup`, or press Set up in Ensemble → Settings → This computer. Windows asks for permission once." },
  });
  assert.equal(lines[0], "sandbox: none");
  assert.match(lines.at(-1)!, /to turn it on: Run `ensemble sandbox setup`/);
});
