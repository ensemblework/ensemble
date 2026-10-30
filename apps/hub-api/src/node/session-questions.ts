/**
 * A node answering its agents' questions (docs/35 §8.11). When a run of one of its sessions asks a
 * question of fact (`ask_person`: "which branch?") and its owner lets it (the default;
 * `autonomy.answerAgentQuestions: false` turns it off), the node hears the question as an attention note
 * (node/watchdog.ts). It may answer only with a fact quoted word for word from the mission (its goal and
 * requirements), the step's brief, the mission's constraints or its owner's own message that started the
 * work, naming the source; the answer is recorded as "answered by @node from <source>". Permissions,
 * widening the scope, security, cost and anything destructive are never its to answer: those, and every
 * question it leaves, stay in Needs me for its owner. The first answer wins, from anywhere.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AgentDecision, NodeAgent, NodeRun, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolResult } from "../assistant/types.js";
import { publishDevice } from "../devices/publish.js";
import { closedRefusal, decideOnce, decisionBus } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { recordSessionEvent, refreshSessionCards } from "./session-queue.js";
import type { SessionToolScope } from "./sessions.js";

export const QUOTE_SOURCES = ["owner", "mission", "step", "constraints"] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

const SOURCE_WORDS: Record<QuoteSource, string> = {
  owner: "your owner's message",
  mission: "the mission",
  step: "the step's brief",
  constraints: "the mission's constraints",
};
const NO_SOURCE: Record<QuoteSource, string> = {
  owner: "There is no message from your owner that started this work.",
  mission: "This run is not part of a mission.",
  step: "This run is not part of a plan step.",
  constraints: "The mission has no constraints.",
};

/** Whether this node may answer its agents' questions of fact (on unless its owner turned it off). */
export function answersQuestions(node: Pick<NodeAgent, "autonomy">): boolean {
  const autonomy = (node.autonomy && typeof node.autonomy === "object" ? node.autonomy : {}) as Record<string, unknown>;
  return autonomy.answerAgentQuestions !== false;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Choices no node makes for its owner, by what the question is about. */
const NOT_A_FACT: Array<[string, RegExp]> = [
  ["a permission", /\b(permissions?|permit|approve|approval|authori[sz]e|grant access|allow (me|you|it|us)|sudo|admin rights?)\b/i],
  ["widening the scope", /\b(outside (the|this|your|its) (folder|repo|repository|project|scope)|(another|other) (folder|repo|repository|project)|expand(ing)? the scope|beyond the (task|scope|request)|out of scope)\b/i],
  ["security", /\b(secrets?|passwords?|credentials?|tokens?|api[ -]?keys?|ssh[ -]?keys?|private keys?|security|vulnerab\w*|encrypt\w*|(disable|skip|bypass) (the )?(sandbox|checks?|tests?|lint\w*|hooks?|verification)|--no-verify|chmod)\b/i],
  ["cost", /\b(costs?|costly|pay|paid|payment|price|pricing|billing|budget|purchase|buy|subscriptions?|credits?|spend\w*|expensive)\b/i],
  ["something destructive", /\b(delete|deleting|remove|removing|drop|dropping|wipe|erase|destroy|overwrite|force[- ]?push|reset --hard|rm -rf|truncate|discard|revert|roll ?back|purge|deploy\w*|production|prod|publish\w*|release|merge|push(ing)? to)\b/i],
];

/**
 * Why a request is not a node's to answer, or null for a question of fact. Only questions (never a
 * permission), from an Ensemble run, not marked for confirmation, and not about permissions, the scope,
 * security, cost or anything destructive.
 */
export function questionRefusal(row: Pick<AgentDecision, "event" | "source" | "title" | "detail">): string | null {
  if (row.source !== "ensemble") return "It is not from one of your runs.";
  if (row.event !== "question") return "It asks for a permission, which only your owner gives.";
  const detail = record(row.detail);
  if (detail.tier === "high_risk" || detail.tier === "run_branch_push" || detail.confirm === true) return "It needs your owner's own confirmation.";
  const described = Array.isArray(detail.optionDetails) ? detail.optionDetails.map((item) => `${record(item).label ?? ""} ${record(item).description ?? ""}`) : [];
  const text = [row.title, ...strings(detail.options), ...described].join("\n");
  for (const [what, pattern] of NOT_A_FACT) if (pattern.test(text)) return `It is about ${what}, which only your owner decides.`;
  return null;
}

/** Text compared word for word: letter case, quote marks and runs of white space do not matter; words do. */
export function normalizeQuote(text: string): string {
  return text.normalize("NFKC").replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The quote appears word for word in the source, and says something (at least two words). */
export function quoteFound(quote: string, source: string): boolean {
  const wanted = normalizeQuote(quote).replace(/^["']+|["'.,;:!?]+$/g, "").trim();
  if (wanted.length < 6 || wanted.split(" ").filter(Boolean).length < 2) return false;
  return normalizeQuote(source).includes(wanted);
}

/** "key: value" lines from a mission's constraints, so a quote can name the constraint it states. */
function constraintLines(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return value.trim() ? [prefix ? `${prefix}: ${value}` : value] : [];
  if (typeof value === "number" || typeof value === "boolean") return prefix ? [`${prefix}: ${String(value)}`] : [];
  if (Array.isArray(value)) return value.flatMap((item) => constraintLines(item, prefix));
  return Object.entries(record(value)).flatMap(([key, item]) => constraintLines(item, prefix ? `${prefix} ${key}` : key));
}

/**
 * What a node may quote for a run: its owner's own messages that started the work (the run's and the
 * session's first run's, and the plan's), the mission's goal and requirements, the step's brief and the
 * mission's constraints. A node's own words to its agent are not a source.
 */
export async function quoteSources(prisma: PrismaClient, run: Pick<NodeRun, "userId" | "messageId" | "sessionId" | "jobId" | "planId" | "planStep">): Promise<Record<QuoteSource, string[]>> {
  const out: Record<QuoteSource, string[]> = { owner: [], mission: [], step: [], constraints: [] };
  const first = run.sessionId ? await prisma.nodeRun.findFirst({ where: { userId: run.userId, OR: [{ sessionId: run.sessionId }, { jobId: run.sessionId }] }, orderBy: { createdAt: "asc" }, select: { messageId: true } }) : null;
  const cardIds = [...new Set([run.messageId, first?.messageId, run.planId].filter((id): id is string => Boolean(id)))];
  const cards = cardIds.length ? await prisma.nodeMessage.findMany({ where: { id: { in: cardIds } }, select: { rootMessageId: true, kind: true, data: true } }) : [];
  const roots = [...new Set(cards.map((card) => card.rootMessageId).filter((id): id is string => Boolean(id)))];
  const asked = roots.length ? await prisma.nodeMessage.findMany({ where: { id: { in: roots }, authorKind: "human", userId: run.userId }, select: { body: true } }) : [];
  out.owner = asked.map((row) => row.body).filter((body) => body.trim());
  if (run.planId) {
    const mission = await prisma.nodeMission.findUnique({ where: { id: run.planId }, select: { goal: true, requirements: true, constraints: true } });
    const card = cards.find((row) => row.kind === "plan");
    const data = record(card?.data);
    const requirements = [...(Array.isArray(mission?.requirements) ? mission!.requirements : []), ...(Array.isArray(data.requirements) ? data.requirements : [])].map(record);
    out.mission = [
      mission?.goal ?? "",
      typeof data.goal === "string" ? data.goal : "",
      ...requirements.flatMap((row) => [typeof row.text === "string" ? row.text : "", ...(Array.isArray(row.acceptance) ? row.acceptance.map((item) => String(record(item).text ?? "")) : [])]),
    ].filter((text) => text.trim());
    out.constraints = constraintLines(mission?.constraints ?? {});
    if (run.planStep) {
      const step = await prisma.nodeStep.findUnique({ where: { missionId_id: { missionId: run.planId, id: run.planStep } }, select: { brief: true } });
      const fromCard = (Array.isArray(data.steps) ? data.steps : []).map(record).find((row) => row.id === run.planStep);
      out.step = [step?.brief ?? "", typeof fromCard?.brief === "string" ? fromCard.brief : ""].filter((text) => text.trim());
    }
  }
  return out;
}

export const AnswerInput = z
  .object({
    decision: z.string().uuid().describe("The question's id, from the attention note."),
    answer: z.string().min(1).max(500).describe("Your answer as the agent should read it. For a question with options: one of them, exactly."),
    quote: z.string().min(1).max(1000).describe("The words that state the answer, copied exactly from the source."),
    source: z.enum(QUOTE_SOURCES).describe("Where the quote is: owner (your owner's own message that started this work), mission (its goal and requirements), step (your step's brief), constraints (the mission's constraints)."),
  })
  .strict();
export type AnswerInput = z.infer<typeof AnswerInput>;

/** Answers one of its agents' questions for the node, when a quoted source states the answer. */
export async function answerQuestion(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId" | "slug">, input: AnswerInput): Promise<ToolResult> {
  const prisma = app.prisma;
  const row = await prisma.agentDecision.findFirst({ where: { id: input.decision, userId: node.userId } });
  if (!row) throw new ToolBlockedError("There is no question with that id.", "Use the id from the attention note.");
  if (row.status !== "pending") throw new ToolBlockedError(closedRefusal(row));
  const run = row.sessionId ? await prisma.nodeRun.findFirst({ where: { jobId: row.sessionId, nodeId: node.id } }) : null;
  if (!run) throw new ToolBlockedError("That question is not from one of your runs.", "Leave it for your owner.");
  const refusal = questionRefusal(row);
  if (refusal) throw new ToolBlockedError(refusal, "Leave it in Needs me for your owner; say so in one line if they should know.");
  const detail = record(row.detail);
  const offered = strings(detail.options);
  let answer = input.answer.trim();
  if (offered.length && detail.allowCustom !== true) {
    const picked = offered.find((option) => option.trim().toLowerCase() === answer.toLowerCase());
    if (!picked) throw new ToolBlockedError(`Answer with one of its options: ${offered.map((option) => `“${option}”`).join(", ")}.`);
    answer = picked;
  }
  const sources = await quoteSources(prisma, run);
  const texts = sources[input.source];
  if (!texts.length) throw new ToolBlockedError(NO_SOURCE[input.source], "Quote another source, or leave the question for your owner.");
  if (!texts.some((text) => quoteFound(input.quote, text))) {
    throw new ToolBlockedError(`That quote is not in ${SOURCE_WORDS[input.source]}, word for word.`, "Copy the words exactly as they are there, or leave the question for your owner.");
  }
  const answeredBy = { nodeId: node.id, handle: node.slug, source: input.source, quote: truncateText(input.quote.trim(), 1000), at: new Date().toISOString() };
  const decided = await decideOnce(prisma, row.id, { status: "decided", decision: "allow", scope: "once", reason: answer, decidedAt: new Date(), detail: { ...detail, answeredBy } as never });
  if (!decided) {
    const now = await prisma.agentDecision.findUnique({ where: { id: row.id } });
    throw new ToolBlockedError(now ? closedRefusal(now) : "That question is gone.");
  }
  decisionBus.emit(row.id);
  if (typeof detail.deviceId === "string" && detail.deviceId) publishDevice(detail.deviceId, "decision.answered", row.id, { decision: "allow", scope: "once", reason: answer });
  sseHub.publish(node.userId, { event: "decision", data: { id: row.id, status: "decided", title: row.title, source: row.source, runnerAccountId: typeof detail.runnerAccountId === "string" ? detail.runnerAccountId : null } });
  const line = `Answered by @${node.slug} from ${SOURCE_WORDS[input.source].replace(/^your owner's/, "its owner's")}: “${truncateText(answer, 200)}”`;
  await prisma.workspaceEvent.create({ data: { jobId: run.jobId, kind: "needs_me_answered", data: { decisionId: row.id, title: line, answer: truncateText(answer, 500), source: input.source, quote: answeredBy.quote, nodeId: node.id } } });
  await appendLedger({ userId: node.userId, actor: "agent", action: "decision.allow", payload: { source: row.source, tool: row.toolName, title: row.title, scope: "once", via: "node", nodeId: node.id, from: input.source } });
  const sessionId = run.sessionId ?? run.jobId;
  await recordSessionEvent(prisma, { userId: node.userId, nodeId: node.id, sessionId, jobId: run.jobId, action: "answer", actor: "node", via: "chat", detail: { decisionId: row.id, question: row.title, answer, source: input.source, quote: answeredBy.quote } });
  await refreshSessionCards(prisma, node.userId, sessionId);
  return toolOk(`Answered “${truncateText(row.title, 120)}” with “${truncateText(answer, 120)}”, quoting ${SOURCE_WORDS[input.source]}. The agent goes on.`, { decision: row.id, answer, source: input.source });
}

/**
 * `node_answer_question`, in turns only its owner reads and started, unless its owner turned answering
 * off for this node.
 */
export function questionTools(scope: Pick<SessionToolScope, "node" | "ownerOnly" | "lineage">): AnyHubTool[] {
  if (!scope.ownerOnly || scope.lineage.fromNonOwner || !answersQuestions(scope.node)) return [];
  return [
    defineTool({
      name: "node_answer_question",
      area: "tasks",
      description:
        "Answer a question one of your agents asked (from an attention note), only when the mission, your step's brief, the mission's constraints or your owner's own message that started the work states the answer: quote those words exactly and name the source. " +
        "Never for permissions, widening the scope, security, cost or anything destructive, and never from memory or a guess: leave those in Needs me for your owner.",
      input: AnswerInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        return answerQuestion(ctx.app, scope.node, input);
      },
    }),
  ];
}
