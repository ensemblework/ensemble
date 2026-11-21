import assert from "node:assert/strict";
import test from "node:test";
import { planCard, planDecision, UNATTENDED_ANSWER } from "./cards.js";

test("a computer question is allowed for this mission, never always", () => {
  const plan = planDecision({ id: "d1", source: "ensemble", event: "question", toolName: "Computer tools", detail: { options: ["Once", "This mission", "Always for this folder"], nodeTool: { nodeId: "n" } } });
  assert.deepEqual(plan, { url: "/api/decisions/d1/decide", body: { decision: "allow", scope: "once", reason: "This mission" }, answer: "This mission" });
});

test("a coding run's permission is allowed for the run, or once, and confirmed when it asks", () => {
  assert.deepEqual(planDecision({ id: "d2", source: "ensemble", event: "permission", toolName: "Bash", detail: { deviceId: "x", confirm: true } }), {
    url: "/api/decisions/d2/decide",
    body: { decision: "allow", scope: "session", confirmed: true },
    answer: "allow for this run",
  });
  assert.equal((planDecision({ id: "d3", source: "ensemble", event: "permission", toolName: "Bash", detail: {} }, "once") as unknown as { body: { scope: string } }).body.scope, "once");
});

test("a run's question gets the recommended option, or the unattended answer when it may be free text", () => {
  assert.equal((planDecision({ id: "q", source: "ensemble", event: "question", toolName: "ask", detail: { options: ["Red", "Blue"], recommended: "Blue" } }) as { answer: string }).answer, "Blue");
  assert.equal((planDecision({ id: "q", source: "ensemble", event: "question", toolName: "ask", detail: { options: ["Red"], allowCustom: true } }) as { answer: string }).answer, UNATTENDED_ANSWER);
});

test("a push or high-risk request is left for the computer", () => {
  assert.ok("skip" in planDecision({ id: "p", source: "ensemble", event: "permission", toolName: "git", detail: { tier: "run_branch_push" } }));
});

test("cards: approve what can be approved, report what needs a person, ignore settled ones", () => {
  assert.deepEqual(planCard({ id: "c", kind: "approval", data: { type: "session", status: "pending" } }), { url: "/api/node/approvals/c", body: { decision: "approve" }, answer: "approve" });
  assert.deepEqual(planCard({ id: "c", kind: "approval", data: { type: "tools", status: "pending", calls: [] } }), { url: "/api/node/approvals/c", body: { decision: "approve" }, answer: "approve" });
  assert.ok("skip" in (planCard({ id: "s", kind: "approval", data: { type: "sudo", status: "pending" } }) ?? {}));
  assert.ok("skip" in (planCard({ id: "l", kind: "approval", data: { type: "login", status: "pending" } }) ?? {}));
  assert.equal(planCard({ id: "x", kind: "approval", data: { type: "session", status: "applied" } }), null);
  assert.equal(planCard({ id: "y", kind: "approval", data: { type: "computer", status: "pending" } }), null);
  assert.equal(planCard({ id: "z", kind: "text", data: { type: "live" } }), null);
});
