/**
 * Crew plans (docs/35 §6.2): how a node hands work to its owner's other nodes without a chat
 * between them. In one turn the lead adds steps with `node_delegate` (each to one node, optionally
 * after other steps); its reply opens the plan as one card. Steps then run in order as silent turns
 * of their nodes: a node's reply in a step is its report to the plan, never a chat message, and a
 * step that started agent sessions finishes when its node reports after them. When nothing is left
 * to run, the lead gets one turn with every result and tells its owner once.
 *
 * The plan lives on its card (a `plan` message): every change is a compare-and-set on `version`, so
 * steps finishing together never lose an update. Runs and cards of a step carry `planId` and are
 * shown inside the plan card, not in the timeline.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { stopJob } from "../workspace/worker.js";
import { enqueueTurn, stopPlanTurns } from "./queue.js";
import { announce, postMessage, roomPeople, updateMessageData } from "./store.js";

export const MAX_STEPS = 12;
/** Agent runs one step may start or continue; past this its node reports instead of trying again. */
export const MAX_STEP_RUNS = 4;

export type StepStatus = "waiting" | "working" | "done" | "blocked" | "skipped" | "stopped";
export type PlanStatus = "draft" | "running" | "reporting" | "done" | "stopped";

export type PlanStep = {
  id: string;
  nodeId: string;
  handle: string;
  name: string;
  brief: string;
  /** Steps that must be done before this one starts. */
  after: string[];
  status: StepStatus;
  result: string | null;
  progress: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type PlanData = {
  type: "plan";
  version: number;
  leadNodeId: string;
  leadHandle: string;
  /** The lead's turn that made the plan: its reply opens it. */
  leadTurnId: string;
  /** Where the lead was asked, and so where it reports. */
  originRoomId: string;
  originPrivate: boolean;
  status: PlanStatus;
  steps: PlanStep[];
};

export type PlanLink = { planId: string; planStep: string | null };

const ENDED: ReadonlySet<StepStatus> = new Set(["done", "blocked", "skipped", "stopped"]);
const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval", "stopping"] as const;

export function planData(message: Pick<NodeMessage, "kind" | "data"> | null): PlanData | null {
  const data = message?.data as PlanData | null;
  return message?.kind === "plan" && data?.type === "plan" && Array.isArray(data.steps) ? data : null;
}

/** The plan a card or turn belongs to (`data.plan` on cards a step's node posts). */
export function planLinkOf(data: unknown): PlanLink | null {
  const link = (data as { plan?: { id?: unknown; step?: unknown } } | null)?.plan;
  return link && typeof link.id === "string" ? { planId: link.id, planStep: typeof link.step === "string" ? link.step : null } : null;
}

async function loadPlan(prisma: PrismaClient, planId: string): Promise<{ message: NodeMessage; data: PlanData } | null> {
  const message = await prisma.nodeMessage.findUnique({ where: { id: planId } });
  const data = planData(message);
  return message && data ? { message, data } : null;
}

/**
 * Changes a plan with a compare-and-set on its version; `change` returns false to leave it as it is.
 * Retried when another change got there first.
 */
async function mutatePlan(prisma: PrismaClient, planId: string, change: (data: PlanData, message: NodeMessage) => boolean | { body: string }): Promise<{ message: NodeMessage; data: PlanData } | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const found = await loadPlan(prisma, planId);
    if (!found) return null;
    const next = structuredClone(found.data);
    const verdict = change(next, found.message);
    if (verdict === false) return found;
    next.version = found.data.version + 1;
    const updated = await prisma.nodeMessage.updateMany({
      where: { id: planId, data: { path: ["version"], equals: found.data.version } },
      data: { data: next as unknown as Prisma.InputJsonValue, ...(typeof verdict === "object" ? { body: verdict.body } : {}) },
    });
    if (updated.count === 1) {
      const message = await prisma.nodeMessage.findUniqueOrThrow({ where: { id: planId } });
      await announce(prisma, message, "node.message.updated");
      return { message, data: next };
    }
  }
  throw new Error("The plan kept changing while it was updated.");
}

/** The plan the lead's current turn is building (or continuing, in its report turn), if any. */
export async function currentPlan(prisma: PrismaClient, leadNodeId: string, turnId: string, continuing: string | null): Promise<{ message: NodeMessage; data: PlanData } | null> {
  if (continuing) return loadPlan(prisma, continuing);
  const message = await prisma.nodeMessage.findFirst({
    where: { kind: "plan", authorNodeId: leadNodeId, AND: [{ data: { path: ["leadTurnId"], equals: turnId } }] },
    orderBy: { seq: "desc" },
  });
  const data = planData(message);
  return message && data ? { message, data } : null;
}

export type NewStep = { node: Pick<NodeAgent, "id" | "name">; handle: string; brief: string; after: string[] };

/**
 * Adds a step to the lead's plan for this turn, making the plan card on the first one. `after` names
 * handles already in the plan; their latest steps must be done first.
 */
export async function addStep(
  prisma: PrismaClient,
  input: { lead: NodeAgent; turnId: string; continuing: string | null; room: NodeRoom; originRoomId: string; originPrivate: boolean; visibleTo: string[]; step: NewStep },
): Promise<{ planId: string; step: PlanStep; position: number }> {
  let plan = await currentPlan(prisma, input.lead.id, input.turnId, input.continuing);
  if (!plan) {
    const data: PlanData = {
      type: "plan",
      version: 0,
      leadNodeId: input.lead.id,
      leadHandle: input.lead.slug,
      leadTurnId: input.turnId,
      originRoomId: input.originRoomId,
      originPrivate: input.originPrivate,
      status: "draft",
      steps: [],
    };
    const { message } = await postMessage(prisma, {
      roomId: input.room.id,
      userId: input.lead.userId,
      authorKind: "node",
      authorNodeId: input.lead.id,
      kind: "plan",
      body: "",
      data: data as unknown as Record<string, unknown>,
      visibleTo: input.visibleTo,
    });
    plan = { message, data };
  }
  const resolveAfter = (data: PlanData): string[] =>
    [...new Set(input.step.after)].map((handle) => {
      const found = [...data.steps].reverse().find((row) => row.handle === handle || row.handle === handle.replace(/^@/, ""));
      if (!found) throw new PlanError(`@${handle} has no step in this plan yet. Add its step first, then this one after it.`);
      return found.id;
    });
  resolveAfter(plan.data);
  let added: PlanStep | null = null;
  let position = 0;
  await mutatePlan(prisma, plan.message.id, (data) => {
    added = null;
    if (data.status === "done" || data.status === "stopped") throw new PlanError("That plan has ended; start a new one in a new turn.");
    if (data.steps.length >= MAX_STEPS) throw new PlanError(`A plan holds at most ${MAX_STEPS} steps. Give one node a bigger step instead.`);
    const same = data.steps.find((row) => row.nodeId === input.step.node.id && row.brief.trim() === input.step.brief.trim() && !ENDED.has(row.status));
    if (same) {
      added = same;
      position = data.steps.indexOf(same) + 1;
      return false;
    }
    added = {
      id: `s${data.steps.length + 1}-${randomUUID().slice(0, 6)}`,
      nodeId: input.step.node.id,
      handle: input.step.handle,
      name: input.step.node.name,
      brief: truncateText(input.step.brief.trim(), 4000),
      after: resolveAfter(data),
      status: "waiting",
      result: null,
      progress: null,
      startedAt: null,
      endedAt: null,
    };
    data.steps.push(added);
    position = data.steps.length;
    return true;
  });
  return { planId: plan.message.id, step: added!, position };
}

export class PlanError extends Error {}

/** Whether a step's turn should still run: its plan goes on and the step has not ended. */
export async function stepLive(prisma: PrismaClient, planId: string, stepId: string): Promise<boolean> {
  const found = await loadPlan(prisma, planId);
  const step = found?.data.steps.find((row) => row.id === stepId);
  return Boolean(found && (found.data.status === "running" || found.data.status === "reporting") && step && !ENDED.has(step.status));
}

/** The lead's turn ended: its reply (when it was posted in the plan's room) opens the plan, and the steps that can start, start. */
export async function startPlan(app: FastifyInstance, planId: string, intro: string | null): Promise<void> {
  await mutatePlan(app.prisma, planId, (data, message) => {
    const waiting = data.steps.some((row) => row.status === "waiting");
    if (data.status === "stopped" || data.status === "done" || (!waiting && data.status !== "draft")) return false;
    data.status = "running";
    return intro?.trim() ? { body: truncateText(intro.trim(), 6000) } : message.body ? true : { body: "Plan" };
  });
  await advancePlan(app, planId);
}

/** Starts every step whose earlier steps are done; when nothing is left to run, the lead reports. */
export async function advancePlan(app: FastifyInstance, planId: string): Promise<void> {
  const prisma = app.prisma;
  const start: PlanStep[] = [];
  let report = false;
  const now = new Date().toISOString();
  const found = await mutatePlan(prisma, planId, (data) => {
    // Only the attempt that commits decides what starts: a retried attempt starts over.
    start.length = 0;
    report = false;
    if (data.status !== "running") return false;
    let changed = false;
    for (const step of data.steps) {
      if (step.status !== "waiting") continue;
      const before = step.after.map((id) => data.steps.find((row) => row.id === id)).filter((row): row is PlanStep => Boolean(row));
      const failed = before.find((row) => row.status !== "done" && ENDED.has(row.status));
      if (failed) {
        Object.assign(step, { status: "skipped", result: `Not started: @${failed.handle}'s step did not finish.`, endedAt: now });
        changed = true;
      } else if (before.every((row) => row.status === "done")) {
        Object.assign(step, { status: "working", startedAt: now });
        start.push({ ...step });
        changed = true;
      }
    }
    if (!data.steps.some((row) => row.status === "waiting" || row.status === "working")) {
      data.status = "reporting";
      report = true;
      changed = true;
    }
    return changed;
  });
  if (!found) return;
  const { message, data } = found;
  for (const step of start) {
    const queued = await enqueueTurn(app, { nodeId: step.nodeId, roomId: message.roomId, reason: "plan", note: stepNote(data, step), planId, planStep: step.id });
    if (!queued) await finishStep(app, planId, step.id, { status: "blocked", result: `@${step.handle} is paused or gone, so it could not start.` });
  }
  if (report) {
    const reported = await enqueueTurn(app, { nodeId: data.leadNodeId, roomId: data.originRoomId, reason: "plan", note: reportNote(data), planId, private: data.originPrivate });
    if (!reported) await mutatePlan(prisma, planId, (next) => ((next.status = "done"), true));
  }
}

/** A step's node finished it, could not, or was stopped; what runs next starts. */
export async function finishStep(app: FastifyInstance, planId: string, stepId: string, outcome: { status: "done" | "blocked" | "stopped"; result: string }): Promise<boolean> {
  let changed = false;
  await mutatePlan(app.prisma, planId, (data) => {
    changed = false;
    const step = data.steps.find((row) => row.id === stepId);
    if (!step || ENDED.has(step.status)) return false;
    Object.assign(step, { status: outcome.status, result: truncateText(outcome.result.trim() || "Finished.", 4000), progress: null, endedAt: new Date().toISOString() });
    changed = true;
    return true;
  });
  if (changed) await advancePlan(app, planId);
  return changed;
}

export async function stepProgress(prisma: PrismaClient, planId: string, stepId: string, progress: string): Promise<void> {
  await mutatePlan(prisma, planId, (data) => {
    const step = data.steps.find((row) => row.id === stepId);
    if (!step || step.status !== "working") return false;
    step.progress = truncateText(progress.trim(), 600);
    return true;
  });
}

/** After the lead's report turn: done, unless that turn added steps (then they start). */
export async function afterReport(app: FastifyInstance, planId: string): Promise<void> {
  const found = await loadPlan(app.prisma, planId);
  if (!found || found.data.status !== "reporting") return;
  if (found.data.steps.some((row) => row.status === "waiting")) {
    await mutatePlan(app.prisma, planId, (data) => (data.status === "reporting" ? ((data.status = "running"), true) : false));
    await advancePlan(app, planId);
    return;
  }
  await mutatePlan(app.prisma, planId, (data) => (data.status === "reporting" ? ((data.status = "done"), true) : false));
}

/**
 * A plan's turn ended without settling its part (skipped, failed, dropped by a stop or a restart):
 * its step ends blocked, or the lead's report is given up, so the plan never waits forever. A no-op
 * when the turn already settled it.
 */
export async function planTurnEnded(app: FastifyInstance, turn: { planId: string | null; planStep: string | null }, why: string): Promise<void> {
  if (!turn.planId) return;
  if (turn.planStep) await finishStep(app, turn.planId, turn.planStep, { status: "blocked", result: why });
  else await afterReport(app, turn.planId);
}

/**
 * Agent runs a step has started so far, and those its node will still hear about: not reported yet
 * and not taken over by a newer call (a steer, a replacement, a stop), whose end wakes nobody.
 */
export async function stepRuns(prisma: PrismaClient, planId: string, stepId: string): Promise<{ total: number; pending: number }> {
  const runs = await prisma.nodeRun.findMany({ where: { planId, planStep: stepId }, select: { messageId: true, reportedAt: true } });
  const open = runs.filter((row) => !row.reportedAt);
  const cards = open.length ? await prisma.nodeMessage.findMany({ where: { id: { in: open.map((row) => row.messageId).filter((id): id is string => Boolean(id)) } }, select: { data: true } }) : [];
  const quiet = cards.filter((card) => typeof (card.data as { quiet?: unknown } | null)?.quiet === "string").length;
  return { total: runs.length, pending: Math.max(0, open.length - quiet) };
}

/** Cards of a step still waiting on the owner (a session to approve, a secret to type): the step goes on after them. */
export async function stepCardsWaiting(prisma: PrismaClient, planId: string, stepId: string): Promise<number> {
  return prisma.nodeMessage.count({
    where: { kind: "approval", AND: [{ data: { path: ["plan", "id"], equals: planId } }, { data: { path: ["plan", "step"], equals: stepId } }, { data: { path: ["status"], equals: "pending" } }] },
  });
}

/**
 * Stops plans: their steps that have not ended, and the agent runs those steps started. By room (the
 * room's Stop), by node (pausing it: the plans it leads and its own steps), or one plan.
 */
export async function stopPlans(app: FastifyInstance, where: { roomId?: string; nodeId?: string; planId?: string; userId: string }): Promise<number> {
  const prisma = app.prisma;
  const plans = await prisma.nodeMessage.findMany({
    where: {
      kind: "plan",
      userId: where.userId,
      ...(where.planId ? { id: where.planId } : {}),
      ...(where.roomId ? { roomId: where.roomId } : {}),
      OR: [{ data: { path: ["status"], equals: "running" } }, { data: { path: ["status"], equals: "draft" } }, { data: { path: ["status"], equals: "reporting" } }],
    },
  });
  let stopped = 0;
  const now = new Date().toISOString();
  for (const plan of plans) {
    const data = planData(plan);
    if (!data) continue;
    const whole = !where.nodeId || data.leadNodeId === where.nodeId;
    const steps = data.steps.filter((row) => !ENDED.has(row.status) && (whole || row.nodeId === where.nodeId)).map((row) => row.id);
    if (!whole && !steps.length) continue;
    // Its turns stop first, so none of them starts new work for a plan that is over.
    await stopPlanTurns(app, plan.id, whole ? null : steps);
    const runs = await prisma.nodeRun.findMany({ where: { planId: plan.id, ...(whole ? {} : { planStep: { in: steps } }), reportedAt: null } });
    const live = await prisma.workspaceJob.findMany({ where: { id: { in: runs.map((row) => row.jobId) }, status: { in: [...LIVE_JOB] }, cancelRequestedAt: null }, select: { id: true } });
    for (const job of live) await stopJob(app, where.userId, job.id);
    // Their ends wake nobody: the plan already says they stopped.
    for (const run of runs) {
      const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
      if (card && typeof (card.data as { quiet?: unknown }).quiet !== "string") await updateMessageData(prisma, card, { quiet: "stopped" });
    }
    await mutatePlan(prisma, plan.id, (next) => {
      for (const step of next.steps) {
        if (steps.includes(step.id)) Object.assign(step, { status: "stopped", result: step.result ?? "Stopped by your owner.", progress: null, endedAt: now });
      }
      if (whole) next.status = "stopped";
      return true;
    });
    if (!whole) await advancePlan(app, plan.id);
    stopped += 1;
  }
  return stopped;
}

/** Who sees a plan card: its owner only where other people read the room (or the lead was asked privately there). */
export async function planVisibility(prisma: PrismaClient, ownerId: string, room: NodeRoom, privateTo: string[] | null): Promise<string[]> {
  if (privateTo) return privateTo;
  return (await roomPeople(prisma, room.id)).some((id) => id !== ownerId) ? [ownerId] : [];
}

function stepTitle(data: PlanData, step: PlanStep): string {
  return `step ${data.steps.findIndex((row) => row.id === step.id) + 1} of ${data.steps.length}`;
}

function resultLine(row: PlanStep): string {
  return `- @${row.handle} (${row.status}): ${truncateText((row.result ?? row.progress ?? "no report").replace(/\s+/g, " "), 1200)}`;
}

/** What a step's node is told when its step starts. */
export function stepNote(data: PlanData, step: PlanStep): string {
  const before = step.after.map((id) => data.steps.find((row) => row.id === id)).filter((row): row is PlanStep => Boolean(row));
  return [
    `Your step in @${data.leadHandle}'s plan (${stepTitle(data, step)}):`,
    step.brief,
    before.length ? `\nDone before yours:\n${before.map(resultLine).join("\n")}` : "",
    "",
    STEP_RULES,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export const STEP_RULES = [
  "How a step works: your reply is not posted in the conversation. It is your report for the plan, which its lead reads when the plan ends; nobody talks to you meanwhile and you talk to nobody.",
  "- Quick work (reading, searching, a short text or report): do it now and reply with the result.",
  "- Code, files, commands or tests on the computer: run them in ONE agent session for this step (node_session_start, or node_session_send to your session when it is the same line of work), then reply exactly (no reply). You get a turn when the run ends.",
  "- When the step is finished, reply with the result in a few lines: what changed, where, how it was checked, anything left.",
  "- If it cannot be done (a decision only your owner can make, missing access, a failure you cannot fix), call node_step_blocked with why. Do not retry the same failing run.",
  "- Never announce that you are starting, waiting or holding: say nothing until you have a result.",
].join("\n");

/** What the lead is told when its plan has nothing left to run. */
export function reportNote(data: PlanData): string {
  const blocked = data.steps.some((row) => row.status !== "done");
  return [
    "Your plan ended. The steps' reports:",
    ...data.steps.map(resultLine),
    "",
    blocked
      ? "Tell your owner, in one message, what was done and what did not finish and why. To redo or add work, call node_delegate again: it continues this plan."
      : "Tell your owner, in one message, what was done and checked, and anything that needs them. Do not repeat each report; summarise.",
  ].join("\n");
}
