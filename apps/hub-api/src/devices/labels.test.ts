import assert from "node:assert/strict";
import test from "node:test";
import { deviceOpensPullRequests, folderLabels, pathShapedLabel, rejectPathLabels } from "./labels.js";

test("folder labels stay names, and run-branch push stays off", () => {
  assert.equal(pathShapedLabel("Desktop/acme"), false);
  assert.equal(pathShapedLabel("~/Desktop/acme"), true);
  assert.equal(pathShapedLabel("/Users/me/src"), true);
  assert.equal(pathShapedLabel("C:\\src"), true);
  assert.deepEqual(folderLabels({ folders: ["Office", { label: "Desk" }, "/tmp/keys", "Office"] }), ["Office", "Desk"]);
  assert.deepEqual(folderLabels({}), []);
  assert.equal(deviceOpensPullRequests({ pullRequests: 1, pullRequestBases: ["testing"] }), false, "0.4.10 and 0.4.11 open pull requests only into their own list");
  assert.equal(deviceOpensPullRequests({ pullRequests: 2 }), true);
  assert.match(rejectPathLabels({ folders: ["~/secrets"] }) ?? "", /label/);
  assert.equal(rejectPathLabels({ folders: ["Notes"] }), null);
});
