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

test("cards: approve what can be approved, decline what needs a person, ignore settled ones", () => {
  assert.deepEqual(planCard({ id: "c", kind: "approval", data: { type: "session", status: "pending" } }), { url: "/api/node/approvals/c", body: { decision: "approve" }, answer: "approve" });
  assert.deepEqual(planCard({ id: "c", kind: "approval", data: { type: "tools", status: "pending", calls: [] } }), { url: "/api/node/approvals/c", body: { decision: "approve" }, answer: "approve" });
  assert.deepEqual(planCard({ id: "s", kind: "approval", data: { type: "sudo", status: "pending" } }), { url: "/api/node/sudo/s", body: { action: "deny" }, answer: "declined", note: "an administrator command needs the computer's password" });
  assert.deepEqual(planCard({ id: "l", kind: "approval", data: { type: "login", status: "pending" } }), { url: "/api/node/approvals/l", body: { decision: "discard" }, answer: "declined", note: "a sign-in or human check needs the owner" });
  assert.equal(planCard({ id: "x", kind: "approval", data: { type: "session", status: "applied" } }), null);
  assert.equal(planCard({ id: "y", kind: "approval", data: { type: "computer", status: "pending" } }), null);
  assert.equal(planCard({ id: "z", kind: "text", data: { type: "live" } }), null);
  assert.deepEqual(planCard({ id: "p", kind: "approval", data: { type: "plan_decision", status: "pending" } }), {
    url: "/api/node/approvals/p",
    body: { decision: "discard" },
    answer: "finish without it",
    note: "a stuck plan step: the plan finishes without it and its lead reports",
  });
});

test("a request for the owner's own screen is declined; an agent's private screen is allowed", () => {
  const ask = (capability: string) => planDecision({ id: "d", source: "ensemble", event: "question", toolName: "Computer tools", detail: { options: ["Once", "This mission"], nodeTool: { nodeId: "n", capability } } });
  assert.equal((ask("screen") as unknown as { body: { decision: string } }).body.decision, "deny");
  assert.equal((ask("desktop_portal") as { answer: string }).answer, "declined");
  assert.equal((ask("agent_screen") as { answer: string }).answer, "This mission");
  assert.equal((ask("run") as { answer: string }).answer, "This mission");
  assert.equal((planCard({ id: "t", kind: "approval", data: { type: "screen_share", status: "pending" } }) as { answer: string }).answer, "declined");
});
