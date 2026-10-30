import assert from "node:assert/strict";
import test from "node:test";
import { candidateKey, failureSignature, parseReport, verdictOf, type StepReport } from "./report.js";

const report = (value: Partial<StepReport>): StepReport => ({ outcome: "pass", summary: "Checked.", ...value });

test("a verification passes only when every check passed", () => {
  assert.deepEqual(verdictOf("verify", report({ checks: [{ name: "renders", verdict: "pass" }] })), { outcome: "pass", problem: null });
  const failed = verdictOf("verify", report({ checks: [{ name: "renders", verdict: "pass" }, { name: "pipe in title", verdict: "fail" }] }));
  assert.equal(failed.outcome, "fail");
  assert.match(failed.problem!, /pipe in title/);
  assert.equal(verdictOf("verify", report({ checks: [] })).outcome, "blocked");
  assert.equal(verdictOf("verify", report({ checks: [{ name: "live account", verdict: "blocked" }, { name: "renders", verdict: "pass" }] })).outcome, "blocked");
  assert.equal(verdictOf("verify", report({ checks: [{ name: "renders", verdict: "skipped" }] })).outcome, "blocked");
});

test("a verification's mandatory criteria each need a passing check", () => {
  const value = report({ checks: [{ id: "tables", name: "tables", verdict: "pass" }] });
  assert.equal(verdictOf("verify", value, ["tables"]).outcome, "pass");
  assert.equal(verdictOf("verify", value, ["tables", "links"]).outcome, "blocked");
});

test("a fail or blocked report is taken; a fail without a failing check is flagged", () => {
  assert.deepEqual(verdictOf("verify", report({ outcome: "blocked", blockedBy: "login_required" })), { outcome: "blocked", problem: null });
  const bare = verdictOf("verify", report({ outcome: "fail" }));
  assert.equal(bare.outcome, "fail");
  assert.ok(bare.problem);
  assert.deepEqual(verdictOf("verify", report({ outcome: "fail", checks: [{ name: "x", verdict: "fail" }] })), { outcome: "fail", problem: null });
});

test("other kinds finish or are blocked", () => {
  assert.equal(verdictOf("build", report({ outcome: "done" })).outcome, "done");
  assert.equal(verdictOf("build", report({ outcome: "pass" })).outcome, "done");
  assert.equal(verdictOf("build", report({ outcome: "fail" })).outcome, "blocked");
  assert.equal(verdictOf("build", report({ outcome: "done", checks: [{ name: "unit tests", verdict: "fail" }] })).outcome, "blocked");
  assert.equal(verdictOf("other", report({ outcome: "blocked" })).outcome, "blocked");
});

test("a failure's signature ignores commits, paths, numbers and times", () => {
  const first = report({ outcome: "fail", subject: { commit: "4ea13ef" }, checks: [{ name: "Pipe in title", verdict: "fail", detail: "Row 12 at /tmp/a/b.md lost cell 3 (sha 4ea13ef, 2026-10-29 12:03)" }] });
  const second = report({ outcome: "fail", subject: { commit: "9bc2210" }, checks: [{ name: "pipe in title", verdict: "fail", detail: "Row 14 at /home/x/c.md lost cell 2 (sha 9bc2210aa, 2026-10-30 09:41)" }] });
  assert.equal(failureSignature(first), failureSignature(second));
  const other = report({ outcome: "fail", checks: [{ name: "links", verdict: "fail" }] });
  assert.notEqual(failureSignature(first), failureSignature(other));
});

test("reports parse strictly; candidates key on commit, then content", () => {
  assert.equal(parseReport({ outcome: "pass", summary: "x", extra: 1 }), null);
  assert.equal(parseReport({ outcome: "nope", summary: "x" }), null);
  assert.ok(parseReport({ outcome: "done", summary: "x", subject: { commit: "abc1234" } }));
  assert.equal(candidateKey({ commit: "abc1234", contentHash: "f00" }), "abc1234");
  assert.equal(candidateKey({ contentHash: "f00" }), "f00");
  assert.equal(candidateKey(undefined), null);
});
