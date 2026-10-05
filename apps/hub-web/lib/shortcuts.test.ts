import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUTS, formatBinding, shortcutProblems } from "@ensemble/shared-types";

test("the help sheet can label every binding", () => {
  assert.deepEqual(shortcutProblems(SHORTCUTS), []);
  for (const binding of SHORTCUTS) {
    assert.ok(formatBinding(binding, true).length > 0 || formatBinding(binding, false).length > 0);
  }
  const capture = SHORTCUTS.find((binding) => binding.id === "capture");
  assert.equal(formatBinding(capture!, true), "⌘⌃⇧U");
  assert.equal(formatBinding(capture!, false), "Ctrl+Alt+Shift+U");
});
