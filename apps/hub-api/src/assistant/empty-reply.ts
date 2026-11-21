/**
 * A turn whose model ends without words (docs/11, Turn limits and final answer). Ensemble's own loop asks
 * once for the reply (ANSWER_NUDGE in agent.ts); on the person's own AI plan the agent's session is
 * resumed once with `REPLY_PROMPT`. When that brings no words either, a turn that did something still
 * answers: `workReply` says what its tools did, from the tool log, in plain words. Only a turn that did
 * nothing and said nothing fails, with `NO_REPLY_FAILURE`.
 */

/** The prompt that resumes the agent's own session when its turn ended without a reply. */
export const REPLY_PROMPT = "You ended your turn without writing a reply. Reply now, in a few lines: what you did and the result. Do not do the work again.";

/** The failure of a turn that neither answered nor did anything. */
export const NO_REPLY_FAILURE = "The model ended its turn without replying or doing anything. Try again, or choose another model.";

/** One of Ensemble's tool calls in the turn, as its record keeps it. `looks`: it only read or looked (registry.ts `readsOnly`). */
export type LoggedCall = { name: string; state?: string; summary?: string | null; error?: string | null; isWrite?: boolean; looks?: boolean };

/** One of the agent's own calls on the person's plan (its shell, files, web), as its chat chip names it (subscriptions/own-tools.ts). */
export type OwnCall = { name: string; summary: string; ok?: boolean; acts: boolean };

const MAX_ITEMS = 6;

/** A call's line as an item of a list: its first line, without ids, the details in brackets at its end, or its full stop. */
function item(text: string): string {
  const line = (text.split("\n").find((part) => part.trim()) ?? "").replace(/[`*]/g, "").trim();
  const plain = line
    .replace(/\s*\[[0-9a-f-]{8,}\]/gi, "")
    .replace(/\s*\([^()]*\)\s*\.?\s*$/, "")
    .replace(/[\s.;:,!]+$/, "");
  const cut = plain.length > 120 ? `${plain.slice(0, 117).replace(/\s+\S*$/, "")}...` : plain;
  // "Created task" reads "created task" inside the list; a name such as "GitHub" or "PR" keeps its capitals.
  return /^[A-Z][a-z]+\b/.test(cut) ? `${cut[0]!.toLowerCase()}${cut.slice(1)}` : cut;
}

/** What one of the agent's own calls did, in words. */
function ownItem(call: OwnCall): string {
  const what = item(call.summary);
  switch (call.name) {
    case "Shell":
      return what ? `ran ${what}` : "ran a command";
    case "Edit":
      return what ? `edited ${what}` : "edited a file";
    case "Read":
    case "Web page":
      return what ? `read ${what}` : "read a file";
    case "Search":
      return what ? `searched for ${what}` : "searched the files";
    case "Web search":
      return what ? `searched the web for ${what}` : "searched the web";
    default:
      return `${call.name.toLowerCase()}${what ? ` ${what}` : ""}`;
  }
}

/** Items as one list: the same item once with its count, at most `MAX_ITEMS`, then how many more. */
function list(items: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const one of items.filter(Boolean)) counts.set(one, (counts.get(one) ?? 0) + 1);
  const all = [...counts].map(([one, count]) => (count > 1 ? `${one} (${count} times)` : one));
  const shown = all.slice(0, MAX_ITEMS).join("; ");
  return all.length > MAX_ITEMS ? `${shown}; and ${all.length - MAX_ITEMS} more` : shown;
}

/**
 * The reply of a turn that ended without words, from what its tools did: what was done, what waits for the
 * person's approval, what did not work, and (only when nothing was done) what it looked at. One paragraph.
 * Null when no tool ran.
 */
export function workReply(calls: readonly LoggedCall[], own: readonly OwnCall[] = []): string | null {
  if (!calls.length && !own.length) return null;
  const line = (call: LoggedCall) => item(call.summary || call.name);
  const done = [...calls.filter((call) => call.state === "ok" && !call.looks).map(line), ...own.filter((call) => call.ok !== false && call.acts).map(ownItem)];
  const waiting = calls.filter((call) => call.state === "awaiting_approval").map(line);
  const looked = [...calls.filter((call) => call.state === "ok" && call.looks).map(line), ...own.filter((call) => call.ok !== false && !call.acts).map(ownItem)];
  const failed = [...calls.filter((call) => call.state === "failed").map((call) => item(call.error || call.summary || call.name)), ...own.filter((call) => call.ok === false).map(ownItem)];
  const lines = [
    done.length ? `Done: ${list(done)}.` : "",
    waiting.length ? `Waiting for your approval: ${list(waiting)}.` : "",
    !done.length && !waiting.length && looked.length ? `Looked at: ${list(looked)}.` : "",
    failed.length ? `Did not work: ${list(failed)}.` : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}
