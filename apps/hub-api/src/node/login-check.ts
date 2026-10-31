/**
 * "Done" in the chat (docs/35 §8.16.1): the owner signed in (or passed a human check) on a sign-in card's
 * page and says so in the chat instead of pressing I'm done. Before the node's conversation turn reads
 * their message, the computer checks the card's tab now (`login.resolve` `check`), and the turn's note
 * says how it went: signed in, carry on; or still not, with why, the card still waiting. The node never
 * reads the paused tab itself. A step's or a run's sign-in is woken as when the card is answered.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeTurn, Prisma } from "@prisma/client";
import { planLinkOf } from "./plans.js";
import { answerLoginCard, LOGIN_CARD, LOGIN_WAITING, LoginCardError, loginOutcomeNote, siteOf, type LoginCardData } from "./logins.js";

/** Turns a person's message starts (node/queue.ts): only these read the owner's new words. */
const PERSON_REASONS = new Set(["dm", "mentioned", "lead", "relevance"]);
/** Longer than "Done, I signed in and also …": a message this long is about something else. */
const MAX_CHARS = 200;

const FINISHED = new RegExp(
  [
    String.raw`^\s*(?:(?:ok(?:ay)?|right|yes|yep|great|cool|alright|there)[\s,.!-]+)?(?:i'?m |i am |it'?s |we'?re |all )?(?:done|finished)\b`,
    String.raw`^\s*(?:(?:all|i'?m|we'?re) )?(?:set|ready|good to go)[\s.!]*$`,
    String.raw`\b(?:signed|logged) (?:back )?in\b`,
    String.raw`\b(?:try|check) (?:it |that |again )?(?:now|again)\b`,
    String.raw`\b(?:passed|solved|cleared|did) (?:it|the (?:check|captcha|challenge|test|verification))\b`,
  ].join("|"),
  "i",
);
const NOT_YET = /\b(?:not|never|nope|haven'?t|hasn'?t|didn'?t|don'?t|can'?t|cannot|couldn'?t|won'?t|isn'?t|wasn'?t|aren'?t|yet|still|later|until|if)\b/i;

/** Whether the owner's message says they finished: "done", "I signed in", "logged in, try now", "passed it". */
export function saysFinished(text: string): boolean {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words || words.length > MAX_CHARS) return false;
  return FINISHED.test(words) && !NOT_YET.test(words);
}

const waitingCard = (turn: Pick<NodeTurn, "roomId" | "nodeId" | "userId">): Prisma.NodeMessageWhereInput => ({
  roomId: turn.roomId!,
  authorNodeId: turn.nodeId,
  userId: turn.userId,
  kind: "approval",
  visibleTo: { equals: [turn.userId] },
  AND: [{ data: { path: ["type"], equals: LOGIN_CARD } }, { OR: LOGIN_WAITING.map((status) => ({ data: { path: ["status"], equals: status } })) }],
});

/** What the turn is told after the check: the outcome in a line, then what to do. */
function outcome(card: NodeMessage, status: string, reason: string | null, hint: string | null): string {
  const data = card.data as LoginCardData;
  const site = siteOf(data.origin);
  const check = data.purpose === "human_check";
  if (status === "signed_in" || status === "passed") {
    const first = check || status === "passed" ? `Passed the human check on ${site}; carry on.` : `Signed in to ${site}; carry on.`;
    if (data.jobId) return `${first} The run that needed it carries on by itself; there is nothing to redo.`;
    if (planLinkOf(card.data)) return `${first} The plan step that needed it carries on by itself.`;
    return `${first} ${loginOutcomeNote(data, check ? "passed" : "signed_in")}`;
  }
  if (status === "needs_code") return `${site} now asks for a code${hint ? ` (“${hint}”)` : ""}. The card in this chat asks your owner for it; never ask for it in your reply. You continue when they enter it.`;
  if (status === "declined" || status === "expired" || status === "ended") return `The ${check ? "human check" : "sign-in"} on ${site} ended (${status}). Do not ${check ? "pass it" : "sign in"} yourself; go on without it or say what cannot be done.`;
  const why = reason ? `: ${reason.replace(/[.\s]+$/, "")}` : "";
  return `${check ? `The human check on ${site} is not passed yet` : `Still not signed in to ${site}`}${why}; the card is still waiting. Tell your owner in one line, and do not try again yourself.`;
}

/**
 * Called once at the start of a node's turn (node/brain.ts): when it is a conversation turn whose new
 * message from the owner says they finished, and this node has a sign-in card waiting in this thread,
 * the computer checks it now and the turn's note says how it went (kept on the turn's row, so a turn
 * that merges into another keeps it). Any other turn comes back as it was.
 */
export async function checkLoginOnDone(app: FastifyInstance, turn: NodeTurn): Promise<NodeTurn> {
  if (turn.planId || turn.planStep || !turn.roomId || !turn.triggerMessageId || !PERSON_REASONS.has(turn.reason)) return turn;
  const prisma = app.prisma;
  try {
    const trigger = await prisma.nodeMessage.findUnique({ where: { id: turn.triggerMessageId }, select: { authorKind: true, userId: true, body: true, data: true } });
    const fromOwner = trigger && trigger.authorKind === "human" && trigger.userId === turn.userId && (trigger.data as { fromNonOwner?: unknown } | null)?.fromNonOwner !== true;
    if (!fromOwner || !saysFinished(trigger.body)) return turn;
    const cards = await prisma.nodeMessage.findMany({ where: waitingCard(turn), orderBy: { createdAt: "desc" }, take: 10 });
    const card = cards.find((row) => ((row.data as { private?: unknown }).private === true) === turn.private);
    if (!card) return turn;
    let line: string;
    try {
      const done = await answerLoginCard(app, turn.userId, card.id, { action: "check" }, undefined, { wake: false });
      const data = done.message.data as LoginCardData;
      // A card still waiting: the site asks for a code now, or it is not done yet (with why).
      const status = data.status === "needs_code" && done.result.status === "needs_code" ? "needs_code" : (LOGIN_WAITING as readonly string[]).includes(data.status) ? "waiting" : data.status;
      line = outcome(done.message, status, done.result.message ?? null, data.codeHint ?? null);
    } catch (error) {
      if (!(error instanceof LoginCardError)) throw error;
      line = outcome(card, "waiting", error.message, null);
    }
    // A turn tried again (its model was busy) checks again, but says so once.
    const note = turn.note?.includes(line) ? turn.note : [turn.note, line].filter(Boolean).join("\n");
    await prisma.nodeTurn.update({ where: { id: turn.id }, data: { note } }).catch(() => undefined);
    return { ...turn, note };
  } catch (error) {
    app.log.warn({ err: error, turnId: turn.id }, "could not check a sign-in the owner said they finished");
    return turn;
  }
}
