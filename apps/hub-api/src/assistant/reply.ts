/** What the assistant is allowed to claim, given the tool rows that actually exist. */

export type ReplyCall = {
  name?: string;
  state?: string;
  summary?: string;
  error?: string;
  isWrite?: boolean;
};

const ADDED = /\b(added|created|attached|saved|set up)\b/i;
const PROPOSED = /\bproposed\b/i;

function lineOf(call: ReplyCall): string {
  return (call.summary || call.error || call.name || "a change").trim();
}

/**
 * Drop a boast that work was added or proposed when the tool rows say otherwise,
 * and append the validation errors the model skipped.
 */
export function reflectProposals(text: string, calls: ReplyCall[]): string {
  const writes = calls.filter((call) => call.isWrite);
  if (!writes.length) return text.trim();
  const pending = writes.filter((call) => call.state === "awaiting_approval");
  const failed = writes.filter((call) => call.state === "failed");
  const done = writes.filter((call) => call.state === "ok");
  const facts = [
    ...pending.map((call) => `Proposed, not applied yet: ${lineOf(call)}`),
    ...done.map((call) => `Done: ${lineOf(call)}`),
    ...failed.map((call) => `Not added: ${call.error || call.summary || "That change was rejected."}`),
  ];
  const body = text.trim();
  const claimsAdded = ADDED.test(body);
  const claimsProposed = PROPOSED.test(body);
  const failureNoted = failed.every((call) => {
    const detail = (call.error || call.summary || "").trim();
    return !detail || body.includes(detail.slice(0, Math.min(24, detail.length)));
  });
  const overclaims =
    (claimsAdded && done.length === 0) ||
    (claimsProposed && pending.length === 0 && done.length === 0) ||
    (failed.length > 0 && (claimsAdded || claimsProposed) && !failureNoted);
  if (overclaims) return facts.join("\n");
  const missing = facts.filter((line) => {
    const detail = line.replace(/^(Proposed, not applied yet: |Done: |Not added: )/, "");
    return detail.length > 0 && !body.includes(detail.slice(0, Math.min(24, detail.length)));
  });
  if (!missing.length) return body;
  return [body, ...missing].filter(Boolean).join("\n\n");
}

const STALE_APPLY_PROMPT = /(?:\n{0,2})Nothing has changed yet — press Apply\.?/g;
// Written by reflectProposals before Apply. The summary changes on Apply
// ("Create project …" becomes "Created …"), so these lines cannot be matched
// to a call by text. The Applied / Still waiting sentence replaces them.
const PROPOSED_LINE = /^Proposed, not applied yet: .*$/gm;

function summaries(calls: ReplyCall[]): string {
  return calls
    .map((call) => call.summary?.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean)
    .join("; ");
}

/**
 * After Apply, the saved sentence must not still say nothing has changed.
 * A partial apply names what landed and what is still waiting.
 */
export function replyAfterApply(content: string, calls: ReplyCall[]): string {
  const writes = calls.filter((call) => call.isWrite !== false);
  const pending = writes.filter((call) => call.state === "awaiting_approval");
  const applied = writes.filter((call) => call.state === "ok");
  if (!applied.length) return content.trim();
  const body = content
    .replace(STALE_APPLY_PROMPT, "\n\n")
    .replace(/\n{0,2}Applied: .*Still waiting — press Apply for .*\.?/g, "\n\n")
    .replace(PROPOSED_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (pending.length === 0) {
    const detail = summaries(applied);
    const line = detail ? `Applied. ${detail}.` : "Applied.";
    if (body.includes(line)) return body;
    return `${body}\n\n${line}`.trim();
  }
  const done = summaries(applied) || "some changes";
  const left = summaries(pending) || "the rest";
  return `${body}\n\nApplied: ${done}. Still waiting — press Apply for ${left}.`.trim();
}
