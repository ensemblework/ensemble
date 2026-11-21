/**
 * What Ensemble Node records about its own work (docs/35 §5.7): one trace per turn (`node_turn_traces`),
 * where each turn ran (`node_turns.placement`), and the decisions Node makes (`node_decisions`), read by
 * the turn's owner at `GET /api/node/turns/:turnId/trace` (node/trace-routes.ts).
 *
 * A trace holds sizes, hashes, timings, counts and the models: never a message's text, a tool's input or
 * its output. The few short texts it keeps (an error, a step's one-line summary, the answer check's
 * problems) are cut and go through lib/redact first, and so does every string a decision records.
 */
import type { FastifyInstance } from "fastify";
import { Prisma, type NodeTurn, type PrismaClient } from "@prisma/client";
import { INCLUDED_PROVIDER, isSubscriptionProvider, type AssistantToolCall } from "@ensemble/shared-types";
import { loopTrace, type LoopTrace } from "../assistant/agent.js";
import { redactText } from "../lib/redact.js";
import { safePublicError, truncateText } from "../lib/text.js";
import { activeHeuristics, heuristicsVersion } from "./heuristics.js";
import type { InstructionsLog } from "./instructions.js";
import { remainingIn, replyOutcome, statedOutcome, type ReplyOutcome } from "./reply-report.js";
import type { PostedMessage } from "./turn-context.js";

/** Where a turn ran (DESIGN §3.2): which loop, who pays for the model, where its tools act, who keeps the conversation. */
export type Placement = {
  loop: "subscription-cli" | "ensemble-api";
  inference: "owner-subscription" | "owner-key" | "included" | "local";
  /** The paired computer that ran the owner's agent (its id), `server` (Ensemble's tools in this process), or null while not known. */
  toolsAt: string | null;
  /** `agent-app`: the owner went on in the agent's own app, and this turn brought that in first (assistant/outside.ts). */
  conversation: "ensemble" | "agent-app";
};

/** Where a turn on this provider runs, as far as it is known before the model is called. */
export function placementFor(provider: string): Placement {
  if (isSubscriptionProvider(provider)) return { loop: "subscription-cli", inference: "owner-subscription", toolsAt: null, conversation: "ensemble" };
  return { loop: "ensemble-api", inference: provider === INCLUDED_PROVIDER ? "included" : provider === "ollama" ? "local" : "owner-key", toolsAt: "server", conversation: "ensemble" };
}

/** A short text a trace or decision keeps: one line at most `max` characters, with secrets' shapes removed. */
export function shortText(value: string, max = 300): string {
  return redactText(truncateText(value.replace(/\s+/g, " ").trim(), max));
}

/** A JSON value as a trace or decision keeps it: strings cut and redacted, lists and depth bounded. */
export function compactJson(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return shortText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => compactJson(item, depth + 1)) as Prisma.InputJsonValue;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50).flatMap(([key, item]) => {
      const kept = compactJson(item, depth + 1);
      return kept === null && item !== null ? [] : [[key, kept] as const];
    });
    return Object.fromEntries(entries) as Prisma.InputJsonValue;
  }
  return null;
}

const json = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/** The instructions' record as a turn's trace keeps it, with the skills, memories and context items they name when they do. */
export type TracedInstructions = InstructionsLog & { selected?: unknown };

const STEP_TOOLS = new Set(["node_step_report", "node_step_blocked"]);

/**
 * What one turn is learning about itself while it runs (node/brain.ts): filled in as the turn goes,
 * saved once when it ends. `loop` is handed to the assistant loop (assistant/agent.ts `LoopTrace`).
 */
export class TurnTrace {
  readonly loop: LoopTrace = loopTrace();
  /** The turn chose its model (or failed to): from then on it keeps a trace. */
  started = false;
  instructions: TracedInstructions | null = null;
  requested: string | null = null;
  sent: { provider: string; model: string; effort: string | null } | null = null;
  reported: string | null = null;
  credits: number | null = null;
  placement: Placement | null = null;
  step = false;
  toolCalls: readonly AssistantToolCall[] = [];
  replyChars: number | null = null;
  /** The answer check: the kinds it checked, each round that sent the reply back (or passed it), and whether the reply the turn ended with passed. */
  verification: { checks: string[]; rounds: Array<{ round: number; problems: string | null }>; passed: boolean | null } | null = null;
  /** The model ended without words, also when asked again: the reply says what its tools did (assistant/empty-reply.ts). */
  emptyReply = false;
  /** Claims of something sent into the chat that never reached it, taken out of the reply (node/delivery-claims.ts). */
  falseClaims = 0;
  /** How the reply says the work ended, and what it says is left (node/reply-report.ts). */
  stated: ReplyOutcome | null = null;
  remaining: string | null = null;
  /** Files that reached the chat with the turn's messages (evidence ids), and files it saved into the owner's Ensemble Files. */
  shown: Array<{ id: string; kind: string }> = [];
  saved: string[] = [];
  error: string | null = null;

  constructor(readonly turn: Pick<NodeTurn, "id" | "userId" | "nodeId">) {}

  /** The model the node's settings chose for this turn (or why none could be), and where that runs. */
  begin(requested: { provider: string; model: string } | null): void {
    this.started = true;
    if (!requested) return;
    this.requested = requested.model;
    this.placement = placementFor(requested.provider);
  }

  /** The model a call is made with (the fallback after a rate limit too) and its thinking level. */
  sending(pick: { provider: string; model: string }, effort: string | null | undefined): void {
    this.sent = { provider: pick.provider, model: pick.model, effort: effort ?? null };
    this.placement = placementFor(pick.provider);
  }

  answered(result: { model?: string | null; credits?: number | null; toolCalls?: readonly AssistantToolCall[]; content?: string; emptyReply?: boolean; falseClaims?: number }): void {
    this.reported = result.model ?? null;
    this.credits = result.credits ?? null;
    this.toolCalls = result.toolCalls ?? [];
    this.replyChars = typeof result.content === "string" ? result.content.length : null;
    this.emptyReply = result.emptyReply === true;
    this.falseClaims = result.falseClaims ?? 0;
    // A reply built from the tool log says nothing of its own.
    const words = this.emptyReply ? "" : (result.content ?? "");
    this.stated = statedOutcome(words);
    const remaining = remainingIn(words);
    this.remaining = remaining ? shortText(remaining, 200) : null;
    this.saved = this.toolCalls.filter((call) => call.name === "hub_save_file" && call.state === "ok").flatMap((call) => (call.refs ?? []).filter((ref) => ref.kind === "file").map((ref) => ref.id));
  }

  /**
   * One check of the answer (node/deliverables.ts): what it found missing, if anything. A round sent the reply back
   * (or passed it); the `final` check, of the reply the turn ended with after its rounds, only says whether it passed.
   */
  checked(round: number, feedback: string | null, checks: ReadonlyArray<{ kind: string }>, final = false): void {
    const verification = (this.verification ??= { checks: [], rounds: [], passed: null });
    verification.checks = [...new Set(checks.map((check) => check.kind))];
    verification.passed = !feedback;
    if (final) return;
    const problems = feedback ? shortText(feedback.replace(/^Not done yet:\s*/i, "").replace(/\s*Do it now with your tools.*$/i, "")) : null;
    verification.rounds.push({ round, problems });
  }

  /** Files posted with the turn's messages. */
  delivered(media: ReadonlyArray<{ evidenceId: string; kind: string }>): void {
    for (const item of media) if (!this.shown.some((row) => row.id === item.evidenceId)) this.shown.push({ id: item.evidenceId, kind: item.kind });
  }

  failed(error: unknown): void {
    this.started = true;
    this.error ??= safePublicError(error);
  }
}

/**
 * A step's report (its `node_step_report` call), or a conversation turn's (DESIGN §6.2): how it ended (`outcome`; `stated`:
 * what the reply said), what it posted, the files that reached the chat or the owner's Files (`artifacts`), what the reply
 * says is left, whether the answer check passed (null: not checked), and whether the reply was built from the tool log or
 * had false claims taken out.
 */
function reportOf(trace: TurnTrace, posted: readonly PostedMessage[], ended?: string | null): Prisma.InputJsonValue | null {
  if (trace.step) {
    const call = [...trace.toolCalls].reverse().find((row) => STEP_TOOLS.has(row.name) && row.state === "ok");
    if (!call) return { kind: "step", reported: false };
    const input = (call.input ?? {}) as { outcome?: unknown; summary?: unknown; reason?: unknown; checks?: unknown; evidence?: unknown; blockedBy?: unknown };
    const checks = Array.isArray(input.checks) ? (input.checks as Array<{ verdict?: unknown }>) : [];
    return {
      kind: "step",
      tool: call.name,
      outcome: call.name === "node_step_blocked" ? "blocked" : String(input.outcome ?? "unknown"),
      ...(checks.length ? { checks: checks.length, passed: checks.filter((check) => check.verdict === "pass").length } : {}),
      ...(Array.isArray(input.evidence) && input.evidence.length ? { evidence: input.evidence.length } : {}),
      ...(typeof input.blockedBy === "string" ? { blockedBy: input.blockedBy } : {}),
      summary: shortText(String(input.summary ?? input.reason ?? ""), 200),
    };
  }
  if (!posted.length && trace.replyChars === null) return null;
  const verified = trace.verification?.passed ?? null;
  return {
    kind: "reply",
    outcome: replyOutcome({ ended, error: Boolean(trace.error), stated: trace.stated, verified, falseClaims: trace.falseClaims, remaining: Boolean(trace.remaining) }),
    ...(trace.stated ? { stated: trace.stated } : {}),
    ...(trace.replyChars !== null ? { chars: trace.replyChars } : {}),
    held: trace.toolCalls.filter((call) => call.state === "awaiting_approval").length,
    messages: posted.map((row) => ({ id: row.id, kind: row.kind, ...(row.type ? { type: row.type } : {}) })),
    artifacts: [...trace.shown.map((row) => ({ ...row, to: "chat" })), ...trace.saved.map((id) => ({ id, kind: "file", to: "files" }))],
    ...(trace.remaining ? { remaining: trace.remaining } : {}),
    verified,
    ...(trace.emptyReply ? { emptyReply: true } : {}),
    ...(trace.falseClaims ? { falseClaims: trace.falseClaims } : {}),
  };
}

/** Where the turn ran, now that its loop has said: the computer that ran the owner's agent, and whether the owner went on in its app. */
function finalPlacement(placement: Placement | null, loop: Record<string, unknown> | null): Placement | null {
  if (!placement || placement.loop !== "subscription-cli" || !loop || loop.kind !== "subscription") return placement;
  const toolsAt = typeof loop.computerId === "string" ? loop.computerId : typeof loop.computer === "string" ? "server" : placement.toolsAt;
  return { ...placement, toolsAt, conversation: typeof loop.outside === "number" && loop.outside > 0 ? "agent-app" : placement.conversation };
}

/** The placement a turn starts with, on its row, so a running turn shows where it runs. Best-effort: a failed write is logged and the turn goes on. */
export async function setPlacement(app: Pick<FastifyInstance, "prisma" | "log">, turnId: string, placement: Placement | null): Promise<void> {
  if (!placement) return;
  await app.prisma.nodeTurn
    .updateMany({ where: { id: turnId }, data: { placement } })
    .catch((error: unknown) => app.log.warn({ err: error, turnId }, "Could not record where a node turn runs"));
}

/** Saves a turn's trace (once it chose a model), and the placement its loop settled. */
export async function saveTrace(app: Pick<FastifyInstance, "prisma" | "log">, trace: TurnTrace, posted: readonly PostedMessage[], outcome?: { status?: string; error?: string } | null): Promise<void> {
  if (!trace.started) return;
  const loop = trace.loop.loop?.() ?? null;
  const placement = finalPlacement(trace.placement, loop);
  const log = trace.instructions;
  const error = trace.error ?? outcome?.error ?? null;
  const row = {
    userId: trace.turn.userId,
    nodeId: trace.turn.nodeId,
    instructionVersion: log?.version ?? null,
    instructionHash: log?.hash ?? null,
    sections: json(log ? { hashes: log.hashes, list: log.sections, dropped: log.dropped } : null),
    toolSchemaHash: trace.loop.tools?.hash ?? null,
    toolCount: trace.loop.tools?.count ?? null,
    modelRequested: trace.requested,
    modelSent: trace.sent?.model ?? null,
    modelReported: trace.reported,
    provider: trace.sent?.provider ?? null,
    effort: trace.sent?.effort ?? null,
    placement: json(placement),
    tokensIn: trace.loop.tokensIn,
    tokensOut: trace.loop.tokensOut,
    credits: trace.credits,
    costUsd: trace.loop.costUsd,
    calls: trace.loop.calls as unknown as Prisma.InputJsonValue,
    selected: json(log?.selected === undefined ? null : compactJson(log.selected)),
    verification: json(trace.verification),
    report: json(reportOf(trace, posted, outcome?.status ?? null)),
    loop: json(loop ? compactJson(loop) : null),
    error: error ? shortText(error, 500) : null,
  };
  await app.prisma.nodeTurnTrace.upsert({ where: { turnId: trace.turn.id }, create: { turnId: trace.turn.id, ...row }, update: row });
  if (placement && JSON.stringify(placement) !== JSON.stringify(trace.placement)) await setPlacement(app, trace.turn.id, placement);
}

export type DecisionKind = "route" | "skill" | "memory" | "context" | "session" | "model" | "escalation" | "steer";

export type Decision = {
  /** The account it decided for: whose message was routed, or whose node's turn it shaped. */
  userId: string;
  nodeId?: string | null;
  turnId?: string | null;
  kind: DecisionKind;
  /** What the rules read: ids, names, counts and flags, never content. */
  inputs: Record<string, unknown>;
  scores?: unknown;
  choice: Record<string, unknown>;
  /** A model decided, because the rules marked the case ambiguous. */
  ambiguous?: boolean;
  /** The config it decided with; the active heuristics' (node/heuristics.ts) when none is given. */
  configVersion?: string;
};

/**
 * Records one decision (`node_decisions`) for any module: routing (node/queue.ts), and the skills,
 * memories, context, session, model or escalation a turn is given. Never throws: a decision that cannot
 * be recorded is logged, and the work goes on. Returns its id, or null.
 */
export async function recordDecision(app: Pick<FastifyInstance, "prisma" | "log">, decision: Decision): Promise<string | null> {
  try {
    const row = await app.prisma.nodeDecision.create({
      data: {
        userId: decision.userId,
        nodeId: decision.nodeId ?? null,
        turnId: decision.turnId ?? null,
        kind: decision.kind,
        configVersion: decision.configVersion ?? heuristicsVersion(activeHeuristics(app.log)),
        inputs: compactJson(decision.inputs) ?? {},
        scores: json(compactJson(decision.scores)),
        choice: compactJson(decision.choice) ?? {},
        ambiguous: decision.ambiguous ?? false,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    app.log.warn({ err: error, kind: decision.kind, turnId: decision.turnId ?? null }, "Could not record a node decision");
    return null;
  }
}

const TURN_FIELDS = {
  id: true,
  nodeId: true,
  roomId: true,
  reason: true,
  private: true,
  lane: true,
  audience: true,
  triggerMessageId: true,
  planId: true,
  planStep: true,
  attempt: true,
  originTurnId: true,
  status: true,
  outcome: true,
  placement: true,
  model: true,
  credits: true,
  error: true,
  createdAt: true,
  finishedAt: true,
} as const;

const TRACE_FIELDS = {
  nodeId: true,
  createdAt: true,
  instructionVersion: true,
  instructionHash: true,
  sections: true,
  toolSchemaHash: true,
  toolCount: true,
  modelRequested: true,
  modelSent: true,
  modelReported: true,
  provider: true,
  effort: true,
  placement: true,
  tokensIn: true,
  tokensOut: true,
  credits: true,
  costUsd: true,
  calls: true,
  selected: true,
  verification: true,
  report: true,
  loop: true,
  error: true,
} as const;

/**
 * One turn of the account's own nodes, as its trace route shows it: the turn (its outcome and placement),
 * its trace (null while it runs, when it never reached a model, or after retention), and the decisions
 * about it: the routing that woke it and any its turn recorded. Null when the turn is not theirs.
 */
export async function turnTrace(prisma: PrismaClient, accountId: string, turnId: string) {
  const turn = await prisma.nodeTurn.findFirst({ where: { id: turnId, userId: accountId }, select: TURN_FIELDS });
  if (!turn) return null;
  // A routing that woke several nodes names this turn among them: it was recorded for one of the room's
  // people while the turn waited, which keeps the lookup on (user_id, created_at).
  const members = turn.roomId ? await prisma.nodeRoomMember.findMany({ where: { roomId: turn.roomId }, select: { userId: true }, distinct: ["userId"] }) : [];
  const authors = [...new Set([accountId, ...members.map((row) => row.userId)])];
  const during = { gte: new Date(turn.createdAt.getTime() - 60_000), lte: new Date((turn.finishedAt ?? new Date()).getTime() + 60_000) };
  const [trace, decisions] = await Promise.all([
    prisma.nodeTurnTrace.findUnique({ where: { turnId }, select: TRACE_FIELDS }),
    prisma.nodeDecision.findMany({
      where: { OR: [{ turnId }, { kind: "route", userId: { in: authors }, createdAt: during, choice: { path: ["woken"], array_contains: [{ turnId }] } }] },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, kind: true, nodeId: true, turnId: true, configVersion: true, inputs: true, scores: true, choice: true, ambiguous: true, createdAt: true },
    }),
  ]);
  return { turn, trace, decisions };
}
