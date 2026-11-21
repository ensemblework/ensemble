/**
 * The report fields of a node's reply (DESIGN §6.2, docs/35 §5.6), for its turn's trace: how the turn ended,
 * what the reply itself says about that, and what it says remains. The constitution asks a reply about work
 * to say how it ended (done, partial, blocked, failed, stopped or uncertain) and what remains
 * (`constitution/14-completion`); these read that, in English, without a model. What Ensemble observed
 * (the turn stopped, failed or waits; the answer check did not pass; a claim was taken out) outweighs the
 * reply's own word.
 */

export const REPLY_OUTCOMES = ["done", "partial", "blocked", "failed", "stopped", "uncertain"] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

const WORD = String.raw`(done|partial(?:ly done)?|blocked|failed|stopped|uncertain)`;
/** "Outcome: partial", "**Status:** blocked", "- Result: done". */
const LABELLED = new RegExp(String.raw`^[\s>*#-]*(?:\*\*)?(?:outcome|status|result)(?:\*\*)?\s*:\s*(?:\*\*)?\s*${WORD}\b`, "im");
/** A reply that opens with its outcome: "Partial: …", "Blocked. …", "**Done**: …". */
const LEADING = new RegExp(String.raw`^\s*(?:\*\*)?${WORD}(?:\*\*)?\s*[:.!]`, "i");

/** How the reply says the work ended, when it says so. */
export function statedOutcome(text: string): ReplyOutcome | null {
  const found = LABELLED.exec(text)?.[1] ?? LEADING.exec(text)?.[1];
  if (!found) return null;
  const word = found.toLowerCase();
  return word.startsWith("partial") ? "partial" : (word as ReplyOutcome);
}

const REMAINS = /^[\s>*#-]*(?:\*\*)?(?:remaining|what remains|still to do|left to do|not done yet|outstanding)(?:\*\*)?\s*:\s*(?:\*\*)?(.*)$/im;
const NOTHING = /^(?:none|nothing|n\/a|-|no(?:thing)? (?:more|else)?)\b[.!]?\s*$/i;

/** What the reply says is left to do: the text after "Remaining:" (or the list under it), when it names something. */
export function remainingIn(text: string): string | null {
  const match = REMAINS.exec(text);
  if (!match) return null;
  let said = match[1]!.replace(/\*\*/g, "").trim();
  if (!said) {
    const after = text.slice(match.index + match[0].length).replace(/^\n+/, "");
    said = after.split(/\n\s*\n/)[0]!.split("\n").map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean).join("; ");
  }
  return said && !NOTHING.test(said) ? said : null;
}

/** How a turn ended (`node/queue.ts` outcomes) as a reply's outcome, before what the reply says. */
const ENDED: Record<string, ReplyOutcome> = { cancelled: "stopped", coalesced: "stopped", skipped: "stopped", failed: "failed", retry: "failed", parked: "blocked" };

/**
 * A reply's outcome: how the turn ended when it did not finish (stopped, failed, or blocked on its owner's
 * answer), then what the reply says unless it says done, then partial when the answer check did not pass, a
 * claim was taken out or the reply names work left; otherwise done.
 */
export function replyOutcome(input: { ended?: string | null; error?: boolean; stated: ReplyOutcome | null; verified: boolean | null; falseClaims: number; remaining: boolean }): ReplyOutcome {
  const ended = input.ended ? ENDED[input.ended] : undefined;
  if (ended) return ended;
  if (input.error) return "failed";
  if (input.stated && input.stated !== "done") return input.stated;
  if (input.verified === false || input.falseClaims > 0 || input.remaining) return "partial";
  return "done";
}
