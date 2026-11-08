/**
 * Does a node's reply claim or promise what its tools did not do? (docs/35 §6.1, the answer check.)
 *
 * Small models often write the work instead of doing it: "I've delegated it", "@swe-1 please start",
 * "I'll resume the session now", "Do you want me to resume?", or post their own drafting notes. Measured on
 * replays of a real crew in the node-agent playground (docs/EXPERIMENTS.md there, 6 Nov 2026): this was the
 * most common failure of gpt-5-mini. Patterns only, no model call: each problem goes back to the model once
 * through the turn's verify hook, worded as a clause for `feedbackFor`.
 */
import type { AssistantToolCall } from "@ensemble/shared-types";

type Row = { call: AssistantToolCall; result: unknown };

const ACT =
  "create|add|update|assign|reassign|delegate|start|kick off|resume|restart|send|message|tell|instruct|stop|cancel|delete|remove|save|write|edit|change|fix|commit|push|open|merge|install|run|schedule|mark|move|book|order|buy|pay|email|post|upload|download|set up|hand (?:it )?(?:off|over)";
const ACTED =
  "created|added|updated|assigned|reassigned|delegated|started|kicked off|resumed|restarted|sent|messaged|told|instructed|stopped|cancell?ed|deleted|removed|saved|written|wrote|edited|changed|fixed|committed|pushed|opened|merged|installed|ran|scheduled|marked|moved|booked|ordered|bought|paid|emailed|posted|uploaded|downloaded|set up|handed (?:it )?(?:off|over)|steered";
const PROMISE = new RegExp(`\\b(?:I(?:'ll|’ll| will| am going to|'m going to|’m going to| shall)|let me|I(?:'m|’m) (?:now )?(?:about to|going to))\\s+(?:now\\s+|go ahead and\\s+|immediately\\s+|then\\s+|first\\s+)?(?:${ACT})\\b`, "i");
const CLAIM = new RegExp(`\\b(?:I(?:'ve|’ve| have)?|we(?:'ve|’ve| have)?)\\s+(?:now\\s+|just\\s+|already\\s+|also\\s+)?(?:${ACTED})\\b`, "i");
const DIRECTIVE = /(?:^|\s)@[\w-]+(?:[\s,]+(?:and\s+)?@[\w-]+)*\s*[,:—–-]?\s*(?:please\s+)?(?:start|begin|go ahead|proceed|pick up|work on|resume|kick off)\b/im;
const PERMISSION = /\b(?:do you want me to|shall I|should I (?:go ahead|proceed|start|resume)|would you like me to|want me to (?:go ahead|proceed|start))\b/i;
const NOTES = /^(?:ok(?:ay)?|now|so),?\s+(?:now\s+)?(?:i|we)\s+(?:need|must|should|have)\s+to\s+(?:craft|write|compose|draft|respond|reply|produce)|\b(?:the final reply|we must respond as|the user's message|craft the (?:final )?(?:reply|answer))\b/im;
/** What a reply may promise after its turn, once a tool started the work. */
const LATER = /\b(?:report back|let you know|update you|keep you posted|notify you|follow up|check back|hear back|tell you when)\b/i;
/** Tools that hand work over to someone (a node, a session, background work). */
const HANDS_OVER = /^(?:node_delegate|node_plan|node_plan_revise|node_session_start|node_session_send|node_work_start|node_helper|node_post)$/;

const acting = (row: Row) => row.call.state === "ok" && (row.call.isWrite === true || /^(?:node_|computer_|browser_|hub_(?:create|update|delete|move|save|stop|assign|add|set|remove|complete))/.test(row.call.name) && !/(?:_list|_get|_search|_read|_view|_snapshot|_sessions|_tabs)\b/.test(row.call.name));

/** The problems a reply has, each a clause for `feedbackFor`; none when it is backed by its tools. */
export function replyProblems(text: string, calls: readonly Row[], round = 0): string[] {
  const reply = text.trim();
  if (!reply) return [];
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const acted = calls.filter(acting);
  const problems: string[] = [];
  const promise = sentences.find((s) => PROMISE.test(s) && !LATER.test(s));
  if (promise) problems.push(`your reply promises “${promise.slice(0, 120)}”, but your turn ends with it: do that now with your tools, or say it was not done`);
  const directive = sentences.find((s) => DIRECTIVE.test(s));
  if (directive && !acted.some((row) => HANDS_OVER.test(row.call.name))) {
    problems.push(`your reply tells someone to start (“${directive.slice(0, 120)}”), but a message in the chat starts nothing: hand the work over with node_delegate (or node_plan, or a session tool)`);
  }
  const claim = sentences.find((s) => CLAIM.test(s));
  if (claim && !acted.length) problems.push(`your reply says “${claim.slice(0, 120)}”, but no tool call in this turn did that`);
  // After one round a question may stand: the owner may really need to choose.
  const permission = round === 0 ? sentences.find((s) => PERMISSION.test(s)) : undefined;
  if (permission) problems.push(`your reply asks “${permission.slice(0, 120)}”; if your owner already asked for it, do it instead of asking`);
  if (NOTES.test(reply)) problems.push("your reply contains your own notes about writing it: send only the message for your owner");
  return problems;
}
