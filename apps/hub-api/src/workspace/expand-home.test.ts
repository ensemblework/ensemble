import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandHome } from "./guard.js";

test("a leading tilde expands to the home directory on either separator", () => {
  const home = homedir();
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("~/ensemble-workspace"), join(home, "ensemble-workspace"));
  assert.equal(expandHome("~\\ensemble-workspace"), join(home, "ensemble-workspace"));
  assert.equal(expandHome("~/fieldnote/relay"), join(home, "fieldnote", "relay"));
  assert.equal(expandHome("~\\fieldnote\\relay"), join(home, "fieldnote", "relay"));
});

test("paths without a leading tilde stay as written", () => {
  assert.equal(expandHome("/tmp/ensemble-workspace"), "/tmp/ensemble-workspace");
  assert.equal(expandHome("C:\\work\\ensemble"), "C:\\work\\ensemble");
  assert.equal(expandHome("~user/ensemble-workspace"), "~user/ensemble-workspace");
  assert.equal(expandHome("ensemble-workspace"), "ensemble-workspace");
});
