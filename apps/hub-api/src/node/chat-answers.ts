/**
 * The owner's reply in a Node chat answers what a session there waits on (docs/35 §8.6). A run's agent
 * asks through Ensemble's Needs me (`agent_decisions` of the run's job); when the owner writes in the
 * conversation the run's card is in instead of answering on a card, that message is the answer. It goes
 * through the decide path every surface uses (`applyAnswer`): the first answer wins, the computer hears it,
 * and the request leaves Needs me in the Hub, on Node and in the CLI at once (`decision` on the owner's
 * stream). A question takes the option the reply names, or the reply itself when its agent takes a typed
 * answer. A permission is allowed by an explicit yes (one that must be confirmed waits on its card) and
 * denied by an explicit no. Anything else is not taken as an answer: the request waits on its card, so a
 * message about something else never refuses what an agent asked (nothing is rejected for the owner). Only one request is
 * answered: the one the reply quotes (its own card, or its run's card), else the only one waiting in the
 * conversation (or the only one whose option the reply names). A line in the chat says what was sent,
 * the node's work board records it, and the node still reads the reply.
 */
import type { FastifyInstance } from "fastify";
import type { AgentDecision, NodeMessage, NodeRoom, NodeRun } from "@prisma/client";
import { applyAnswer } from "../routes/decisions.js";
import { truncateText } from "../lib/text.js";
import { agentLabel } from "./needs-me.js";
import { recordSessionEvent, refreshSessionCards } from "./session-queue.js";
import { postMessage } from "./store.js";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);

/** The message as words: lower case, punctuation as spaces. */
function words(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim();
}

/** An explicit yes or no, the whole message ("yes", "ok, go ahead", "no thanks"): nothing else counts as one. */
const YES = /^(?:yes|yep|yeah|y|sure|ok|okay|allow|allow it|approve|approved|go|go ahead|go for it|do it|proceed|please do|fine)(?: (?:yes|please|go ahead|do it|allow it|thanks|thank you))*$/;
const NO = /^(?:no|nope|nah|n|deny|denied|don't|dont|do not|stop|cancel|skip|not now|never)(?: (?:no|thanks|thank you|please|do it|don't|dont|do not|not now|that))*$/;

/** The option the reply names: the whole reply, else the only option it contains as words. */
export function optionIn(options: readonly string[], reply: string): string | null {
  const said = words(reply);
  if (!said) return null;
  const exact = options.find((option) => words(option) === said);
  if (exact) return exact;
  const named = options.filter((option) => {
    const option_ = words(option);
    return option_.length > 0 && ` ${said} `.includes(` ${option_} `);
  });
  return named.length === 1 ? named[0]! : null;
}

type Reply = { decision: "allow" | "deny"; reason?: string; kind: "answered" | "allowed" | "denied" };

/** What the reply says to this request, or null when it cannot answer it from a chat. */
export function replyTo(row: Pick<AgentDecision, "event" | "detail">, reply: string): Reply | null {
  const detail = record(row.detail);
  const said = words(reply);
  if (!said) return null;
  if (row.event === "question") {
    const picked = optionIn(strings(detail.options), reply);
    if (picked) return { decision: "allow", reason: picked, kind: "answered" };
    if (detail.allowCustom === true) return { decision: "allow", reason: truncateText(reply.trim(), 500), kind: "answered" };
    return null;
  }
  if (YES.test(said)) return detail.confirm === true ? null : { decision: "allow", kind: "allowed" };
  if (NO.test(said)) return { decision: "deny", kind: "denied" };
  return null;
}

/** Only the owner answers from the web what is theirs to answer: not someone else's run, not one only its computer approves. */
function answerable(row: AgentDecision, owner: string): boolean {
  const detail = record(row.detail);
  const runner = str(detail.runnerAccountId);
  return (!runner || runner === owner) && detail.tier !== "run_branch_push" && detail.tier !== "high_risk";
}

/** What the chat says once it is sent. */
function line(reply: Reply, agent: string, title: string): string {
  const asked = `“${truncateText(title.replace(/\s+/g, " "), 160)}”`;
  switch (reply.kind) {
    case "answered":
      return `Sent your reply to ${agent} as its answer to ${asked}.`;
    case "allowed":
      return `Allowed ${agent}, once: ${asked}.`;
    default:
      return `Not allowed: ${agent} was told no to ${asked}.`;
  }
}

/**
 * Answers the one request a session in this conversation waits on with the owner's message, if it is one.
 * Returns the request answered, or null.
 */
export async function answerFromChat(app: FastifyInstance, room: NodeRoom, message: NodeMessage): Promise<AgentDecision | null> {
  const prisma = app.prisma;
  const owner = message.userId;
  const text = message.body.trim();
  if (message.authorKind !== "human" || !text || room.kind === "task") return null;
  // Where other people read, only what the owner says to their own crew (My crew) is meant for their sessions.
  if (room.kind === "room" && !(message.visibleTo.length === 1 && message.visibleTo[0] === owner)) return null;
  const pending = await prisma.agentDecision.findMany({
    where: { userId: owner, source: "ensemble", status: "pending", sessionId: { not: null }, expiresAt: { gt: new Date() } },
    orderBy: { requestedAt: "asc" },
    take: 50,
  });
  if (!pending.length) return null;
  const runs = await prisma.nodeRun.findMany({ where: { userId: owner, roomId: room.id, jobId: { in: pending.map((row) => row.sessionId!) } } });
  if (!runs.length) return null;
  const runOf = new Map<string, NodeRun>(runs.map((run) => [run.jobId, run]));
  let open = pending.filter((row) => runOf.has(row.sessionId!) && answerable(row, owner));
  // A reply that quotes a request's own card answers it; one that quotes a run's card answers that run.
  const quoted = str(record(record(message.data).replyTo).id);
  const quotedCard = quoted ? await prisma.nodeMessage.findFirst({ where: { id: quoted, roomId: room.id }, select: { data: true } }) : null;
  const quotedDecision = str(record(quotedCard?.data).decisionId);
  const quotedRun = quoted ? runs.find((run) => run.messageId === quoted) : undefined;
  if (quotedDecision && open.some((row) => row.id === quotedDecision)) open = open.filter((row) => row.id === quotedDecision);
  else if (quotedRun) open = open.filter((row) => row.sessionId === quotedRun.jobId);
  if (open.length > 1) {
    const named = open.filter((row) => row.event === "question" && optionIn(strings(record(row.detail).options), text));
    if (named.length !== 1) return null;
    open = named;
  }
  const row = open[0];
  if (!row) return null;
  const reply = replyTo(row, text);
  if (!reply) return null;
  let decided: AgentDecision;
  try {
    decided = await applyAnswer(app, owner, row.id, { decision: reply.decision, scope: "once", ...(reply.reason ? { reason: reply.reason } : {}) }, "me");
  } catch (error) {
    // Answered or closed meanwhile, or not answerable from the web after all: the request keeps its own state.
    if ((error as { statusCode?: number }).statusCode) return null;
    throw error;
  }
  const run = runOf.get(row.sessionId!)!;
  const job = await prisma.workspaceJob.findUnique({ where: { id: run.jobId }, select: { provider: true } });
  const agent = agentLabel(job?.provider) ?? "The agent";
  const said = line(reply, agent, row.title);
  const answer = reply.reason ?? (reply.decision === "allow" ? "Allowed" : "Not allowed");
  await prisma.workspaceEvent.create({ data: { jobId: run.jobId, kind: "needs_me_answered", data: { decisionId: row.id, title: `Answered by its owner in the Node chat: “${truncateText(answer, 200)}”`, answer: truncateText(answer, 500), source: "chat", messageId: message.id } } });
  const sessionId = run.sessionId ?? run.jobId;
  await recordSessionEvent(prisma, { userId: owner, nodeId: run.nodeId, sessionId, jobId: run.jobId, action: "answer", actor: "owner", via: "chat", detail: { decisionId: row.id, question: row.title, answer, decision: reply.decision, source: "their reply in the chat", messageId: message.id } });
  await refreshSessionCards(prisma, owner, sessionId);
  await postMessage(prisma, { roomId: room.id, userId: owner, authorKind: "system", kind: "status", body: said, data: { answeredFromChat: { decisionId: row.id, jobId: run.jobId, messageId: message.id, decision: reply.decision } }, visibleTo: [owner] });
  return decided;
}
