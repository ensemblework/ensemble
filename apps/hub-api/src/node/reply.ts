/** How a node's answer becomes a room message. Pure. */

export const NO_REPLY = "(no reply)";
const APPLY_HINT = /\n*Nothing has changed yet — press Apply\.\s*$/;

/** Outcome lines the assistant loop adds when the reply does not mention them (assistant/reply.ts). */
const OUTCOME = /^(Done|Proposed, not applied yet|Not added|Not done): /;

/** The reply as posted. Where tool chips and approval cards show the outcomes, their repeated lines go. */
export function cleanReply(text: string, outcomesShown: boolean): string {
  const body = text.replace(APPLY_HINT, "").trim();
  if (!outcomesShown) return body;
  const kept = body.split(/\n{2,}/).filter((paragraph) => !paragraph.split("\n").every((line) => OUTCOME.test(line.trim())));
  return kept.join("").trim() ? kept.join("\n\n").trim() : body;
}
