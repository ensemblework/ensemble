import assert from "node:assert/strict";
import test from "node:test";
import { folderLabels, pathShapedLabel, rejectPathLabels, runBranchPushEnabled } from "./labels.js";

test("folder labels stay names, and run-branch push stays off", () => {
  assert.equal(pathShapedLabel("Desktop/acme"), false);
  assert.equal(pathShapedLabel("~/Desktop/acme"), true);
  assert.equal(pathShapedLabel("/Users/me/src"), true);
  assert.equal(pathShapedLabel("C:\\src"), true);
  assert.deepEqual(folderLabels({ folders: ["Office", { label: "Desk" }, "/tmp/keys", "Office"] }), ["Office", "Desk"]);
  assert.deepEqual(folderLabels({}), []);
  assert.equal(runBranchPushEnabled({}), false);
  assert.equal(runBranchPushEnabled({ runBranchPush: true }), true);
  assert.equal(runBranchPushEnabled({ runBranchPush: "yes" }), false);
  assert.match(rejectPathLabels({ folders: ["~/secrets"] }) ?? "", /label/);
  assert.equal(rejectPathLabels({ folders: ["Notes"] }), null);
});
