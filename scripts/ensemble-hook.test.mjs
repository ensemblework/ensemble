import assert from "node:assert/strict";
import test from "node:test";
import { normalizePayload } from "./ensemble-hook.mjs";

test("Copilot CLI's tool arguments always reach Ensemble as an object, a patch sent as text too", () => {
  assert.deepEqual(normalizePayload({ toolName: "grep", toolArgs: JSON.stringify({ pattern: "x", paths: ["~/notes"] }) }).tool_input, { pattern: "x", paths: ["~/notes"] });
  assert.deepEqual(normalizePayload({ toolName: "apply_patch", toolArgs: "*** Begin Patch\n*** Add File: a.md\n*** End Patch" }).tool_input, { value: "*** Begin Patch\n*** Add File: a.md\n*** End Patch" });
  assert.deepEqual(normalizePayload({ toolName: "apply_patch", toolArgs: JSON.stringify("*** Begin Patch\n*** Add File: a.md\n*** End Patch") }).tool_input, { value: "*** Begin Patch\n*** Add File: a.md\n*** End Patch" });
  assert.deepEqual(normalizePayload({ toolName: "view", toolArgs: JSON.stringify(["a", "b"]) }).tool_input, { value: ["a", "b"] });
  assert.deepEqual(normalizePayload({ tool_name: "Read", tool_input: { file_path: "a.md" } }).tool_input, { file_path: "a.md" });
});
