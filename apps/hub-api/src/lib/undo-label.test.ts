import assert from "node:assert/strict";
import test from "node:test";
import { tidyUndoLabel } from "./undo-label.js";

test("a quoted title is quoted once and a long one is cut", () => {
  assert.equal(tidyUndoLabel("Edited “Plan”"), "Edited “Plan”");
  assert.equal(tidyUndoLabel("Edited ““Plan””"), "Edited “Plan”");
  assert.equal(tidyUndoLabel("Moved “\"Plan\"” to Trash"), "Moved “Plan” to Trash");
  assert.equal(tidyUndoLabel("Added “The \"big\" plan”"), "Added “The \"big\" plan”");
  const long = tidyUndoLabel(`Edited “${"a".repeat(100)}”`);
  assert.equal(long, `Edited “${"a".repeat(59)}…”`);
  assert.equal(tidyUndoLabel(`Updated “${"🚀".repeat(70)}”`), `Updated “${"🚀".repeat(59)}…”`);
});
