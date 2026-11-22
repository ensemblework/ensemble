/**
 * The harness answers its nodes' owner cards as an owner in a hurry would, allowing work for this
 * run or mission and never "always": computer questions get "This mission", questions about the
 * agent's own calls their answer for this run (else Allow once), a coding run's permission "for
 * this run", held writes, sessions, drafts and proposals are approved. Cards only a
 * person can answer (a password, a secret, a sign-in) are declined, as by an owner who is away, and
 * so is any request to see or use the owner's own screen: an agent's private screen is fine, the
 * owner's never is. Both are reported. A stuck plan step's card is answered "finish without it" (a step
 * whose input changed: "keep the result"), so a run never retries the same failure until its deadline;
 * the report counts and lists it as a problem, with the step and why it was stuck.
 */

/** What the agent asked in a question when the owner cannot answer it now. */
export const UNATTENDED_ANSWER = "I can't answer right now. Decide yourself and finish the task.";

export type DecisionRow = { id: string; source: string; event: string; toolName: string; detail: unknown };
export type CardRow = { id: string; kind: string; data: unknown };

export type Plan = { url: string; body: Record<string, unknown>; answer: string; note?: string } | { skip: string };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * A capability that would show or drive the owner's real screen rather than an agent's private one. A
 * `desktop` question names a sensitive app, or `screen:owner` for the owner's own pointer and keyboard:
 * the eval's computer has no desktop session, so any app it asks about is on the agent screen.
 */
export function ownersScreen(capability: string, target = ""): boolean {
  if (target === "screen:owner") return true;
  if (capability === "desktop") return false;
  return /screen|desktop|display|portal|takeover/i.test(capability) && !/private|agent|virtual|sandbox/i.test(capability);
}

/** An Ensemble decision waiting for the owner (`agent_decisions`): how the harness answers it, or why it does not. */
export function planDecision(row: DecisionRow, scope: "session" | "once" = "session"): Plan {
  const detail = record(row.detail);
  const url = `/api/decisions/${row.id}/decide`;
  const options = strings(detail.options);
  const tool = record(detail.nodeTool);
  if (tool.nodeId) {
    const capability = String(tool.capability ?? "");
    if (ownersScreen(capability, String(tool.target ?? ""))) return { url, body: { decision: "deny", scope: "once" }, answer: "declined", note: `a request for the owner's own screen (${capability}), which the eval never allows` };
    // A question about the agent's own call offers its answer from then on beside the one for this run.
    const pick = tool.own
      ? (options.find((option) => /for this run$/i.test(option)) ?? options.find((option) => /^(allow )?once$/i.test(option)))
      : (options.find((option) => /this mission/i.test(option)) ?? options.find((option) => /^once$/i.test(option)));
    if (!pick) return { skip: tool.own ? "a question about the agent's own call without a run or once answer" : "a computer question without a mission or once answer" };
    return { url, body: { decision: "allow", scope: "once", reason: pick }, answer: pick };
  }
  if (detail.tier === "run_branch_push" || detail.tier === "high_risk") return { skip: `a ${String(detail.tier).replace(/_/g, " ")} request that is answered on the computer only` };
  const confirmed = detail.confirm === true ? { confirmed: true } : {};
  if (row.event === "question") {
    const recommended = typeof detail.recommended === "string" && options.includes(detail.recommended) ? detail.recommended : null;
    const picked = detail.allowCustom === true ? UNATTENDED_ANSWER : (recommended ?? options.find((option) => /\b(yes|continue|proceed|allow|go ahead|recommended)\b/i.test(option)) ?? options[0] ?? null);
    if (!picked) return { url, body: { decision: "allow", scope: "once", ...confirmed }, answer: "allow" };
    return { url, body: { decision: "allow", scope: "once", reason: picked, ...confirmed }, answer: picked };
  }
  // A permission: for the run when the computer takes a run answer, else once.
  return { url, body: { decision: "allow", scope, ...confirmed }, answer: scope === "session" ? "allow for this run" : "allow once" };
}

/** How the harness answers a stuck plan step's card: the plan goes on without the step, or keeps a result whose input changed. */
export const FINISHED_WITHOUT = "finish without it";
export const KEPT = "keep the result";

/** Card types answered by approving them (node/approvals.ts `settleApproval`). */
const APPROVED = new Set(["tools", "session", "post", "node_proposal", "crew_add", "media_preview"]);
/** Card types only a person could approve: they need a password, a secret or a sign-in. The harness declines them. */
const PERSON_ONLY: Record<string, string> = {
  sudo: "an administrator command needs the computer's password",
  secret: "a secret has to be typed by the owner",
  login: "a sign-in or human check needs the owner",
  device_code: "a command's sign-in code needs the owner",
};

/** A stuck plan step's card, for the report: the step, and why it was stuck (the card's question without the closing ask). */
function stuckNote(data: Record<string, unknown>, conflict: boolean): string {
  const step = record(data.plan).step;
  const question = typeof data.question === "string" ? data.question.replace(/\s+/g, " ").trim() : "";
  const why = question.replace(/(?<=[.!?…])\s+[^.!?…]*\?$/, "");
  return `step ${typeof step === "string" ? step : "unknown"} ${conflict ? "changed under it" : "stuck"}${why ? `: ${why}` : ""}`;
}

/** A node message card (`kind: "approval"`): how the harness answers it, or why it does not. Computer and run-question cards are answered through their decision. */
export function planCard(card: CardRow): Plan | null {
  const data = record(card.data);
  const type = typeof data.type === "string" ? data.type : "tools";
  if (data.status !== undefined && data.status !== "pending") return null;
  if (type === "computer" || type === "run_decision") return null;
  if (PERSON_ONLY[type]) {
    const note = PERSON_ONLY[type]!;
    return type === "sudo" ? { url: `/api/node/sudo/${card.id}`, body: { action: "deny" }, answer: "declined", note } : { url: `/api/node/approvals/${card.id}`, body: { decision: "discard" }, answer: "declined", note };
  }
  if (card.kind !== "approval") return null;
  if (ownersScreen(type)) return { url: `/api/node/approvals/${card.id}`, body: { decision: "discard" }, answer: "declined", note: `a request for the owner's own screen (${type}), which the eval never allows` };
  if (APPROVED.has(type)) return { url: `/api/node/approvals/${card.id}`, body: { decision: "approve" }, answer: type === "media_preview" ? "send" : "approve" };
  if (type === "plan_decision") {
    const conflict = data.why === "conflict";
    return { url: `/api/node/approvals/${card.id}`, body: { decision: "discard" }, answer: conflict ? KEPT : FINISHED_WITHOUT, note: stuckNote(data, conflict) };
  }
  return { skip: `a ${type} card the harness does not know how to answer` };
}

/** How a waiting decision is logged: a computer question, one about the agent's own call (by what it covers), or a run's question or permission. */
export function decisionType(row: Pick<DecisionRow, "event" | "detail">): string {
  const tool = record(record(row.detail).nodeTool);
  if (Object.keys(tool).length) return tool.own ? `own:${String(record(tool.own).kind ?? "write")}` : "computer";
  return row.event === "question" ? "run_question" : "run_permission";
}

/** The `data.type` of a card, for the log. */
export function cardType(card: CardRow): string {
  const type = record(card.data).type;
  return typeof type === "string" ? type : card.kind;
}
