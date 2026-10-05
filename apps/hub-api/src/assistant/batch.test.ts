import assert from "node:assert/strict";
import test from "node:test";
import { settleWriteBatch } from "./batch.js";

test("a failed write withdraws the other proposals in the same step", () => {
  const settled = settleWriteBatch([
    {
      call: { state: "ok", isWrite: false, summary: "Listed 2" },
      forModel: { ok: true },
    },
    {
      call: { state: "awaiting_approval", isWrite: true, summary: "Update “Write the ranker ADR”" },
      forModel: { status: "awaiting_approval" },
    },
    {
      call: { state: "failed", isWrite: true, summary: "No project named “Core Platform”.", error: "No project named “Core Platform”." },
      forModel: { error: "No project named “Core Platform”." },
    },
  ]);
  assert.equal(settled[0]?.call.state, "ok");
  assert.equal(settled[1]?.call.state, "failed");
  assert.match(String(settled[1]?.call.summary), /none of them can be applied/);
  assert.equal(settled[2]?.call.state, "failed");
  assert.match(JSON.stringify(settled[1]?.forModel), /Ask the user/);
});
