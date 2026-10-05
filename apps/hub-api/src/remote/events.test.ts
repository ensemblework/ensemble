/** Progress may carry only the event kinds a device owns. The server writes the rest. */
import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_EVENT_KINDS, deviceOwnedEvents } from "./contract.js";

test("a device posts prepared, tool, and command, and not kinds the server writes", () => {
  assert.deepEqual([...DEVICE_EVENT_KINDS], ["prepared", "tool", "command"]);
  const posted = deviceOwnedEvents([
    { kind: "prepared", data: { branch: "ensemble/1" } },
    { kind: "needs_me", data: { title: "Which greeting?" } },
    { kind: "interrupted" },
    { kind: "tool", data: { name: "edit_file" } },
    { kind: "scrubbed" },
    { kind: "unattended" },
    { kind: "command", data: { command: "git status" } },
  ]);
  assert.deepEqual(
    posted.map((row) => row.kind),
    ["prepared", "tool", "command"],
  );
});
