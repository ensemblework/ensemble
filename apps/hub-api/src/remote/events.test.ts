/** Progress may carry only the event kinds a device owns. The server writes the rest. */
import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_EVENT_KINDS, deviceOwnedEvents } from "./contract.js";

test("a device posts prepared, tool, command, engine, sandbox, engine_retry and resumed, and not kinds the server writes", () => {
  assert.deepEqual([...DEVICE_EVENT_KINDS], ["prepared", "tool", "command", "engine", "sandbox", "engine_retry", "resumed"]);
  const posted = deviceOwnedEvents([
    { kind: "prepared", data: { branch: "ensemble/1" } },
    { kind: "needs_me", data: { title: "Which greeting?" } },
    { kind: "interrupted" },
    { kind: "tool", data: { name: "edit_file" } },
    { kind: "scrubbed" },
    { kind: "unattended" },
    { kind: "command", data: { command: "git status" } },
    { kind: "engine", data: { name: "Claude Code" } },
    { kind: "sandbox", data: { name: "macOS sandbox" } },
    { kind: "engine_retry", data: { attempt: 1 } },
    { kind: "resumed", data: { attempt: 1 } },
    { kind: "reconnected" },
  ]);
  assert.deepEqual(
    posted.map((row) => row.kind),
    ["prepared", "tool", "command", "engine", "sandbox", "engine_retry", "resumed"],
  );
});

test("to a server before protocol 5, a device does not post the carry-on kinds it would refuse", () => {
  const posted = deviceOwnedEvents([{ kind: "engine" }, { kind: "engine_retry" }, { kind: "resumed" }], 4);
  assert.deepEqual(
    posted.map((row) => row.kind),
    ["engine"],
  );
});

test("to a server before protocol 2, a device posts only the kinds that server takes", () => {
  const posted = deviceOwnedEvents(
    [
      { kind: "prepared" },
      { kind: "engine", data: { engine: "claude-code" } },
      { kind: "sandbox" },
      { kind: "command", data: { command: "git status" } },
    ],
    1,
  );
  assert.deepEqual(
    posted.map((row) => row.kind),
    ["prepared", "command"],
  );
});
