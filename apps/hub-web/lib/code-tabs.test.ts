import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OPEN_FILES, openTab } from "./code-tabs.js";

const files = (count: number) => Array.from({ length: count }, (_, index) => `src/f${index}.ts`);
const none = () => false;

test("a file opens as a new tab until ten are open; an open file is not added twice", () => {
  assert.equal(MAX_OPEN_FILES, 10);
  assert.deepEqual(openTab([], "a.ts", null, none), { tabs: ["a.ts"], closed: null });
  assert.deepEqual(openTab(["a.ts"], "a.ts", "a.ts", none), { tabs: ["a.ts"], closed: null });
  assert.deepEqual(openTab(files(9), "new.ts", "src/f8.ts", none), { tabs: [...files(9), "new.ts"], closed: null });
});

test("the eleventh file closes the oldest saved one that is not in view", () => {
  const open = files(10);
  assert.deepEqual(openTab(open, "new.ts", "src/f9.ts", none), { tabs: [...open.slice(1), "new.ts"], closed: "src/f0.ts" });
  assert.deepEqual(openTab(open, "new.ts", "src/f0.ts", none), { tabs: [open[0]!, ...open.slice(2), "new.ts"], closed: "src/f1.ts" }, "not the file in view");
  const busy = (path: string) => path === "src/f0.ts" || path === "src/f1.ts";
  assert.deepEqual(openTab(open, "new.ts", "src/f9.ts", busy), { tabs: [open[0]!, open[1]!, ...open.slice(3), "new.ts"], closed: "src/f2.ts" }, "not one with unsaved edits");
});

test("when every other open file has unsaved edits, the new file is refused with a reason", () => {
  const result = openTab(files(10), "new.ts", "src/f0.ts", () => true);
  assert.ok("refused" in result);
  assert.match(result.refused, /Up to 10 files can be open at once/);
});
