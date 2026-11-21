/**
 * Crew plans and node work as missions (docs/35 §6.2-6.4; ensemble-node docs/design B1, B2, B4).
 *
 * A mission is a row in node_missions with its steps in node_steps; its card (a `plan` message, whose
 * id is the mission's id) is a view of them. Every change runs in one transaction that locks the
 * mission, applies the pure rules of missions-core.ts (what starts, what is held, what is repaired,
 * how a stuck step climbs the ladder, when the lead reports), stores the steps, writes the effects to
 * the outbox and refreshes the card. The outbox (node/outbox.ts) then delivers the effects at least
 * once; turns it enqueues carry an operation id, so a redelivered effect does nothing new.
 *
 * Execution and result are separate: a step whose run finished may have failed its checks, and a
 * failed check holds every step after it until the build is repaired and checked again. A step's
 * result enters its lead once: recorded with the attempt's `reportedAt` in the transaction that wakes
 * the lead, and marked delivered in the transaction that starts the lead's turn carrying it.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type NodeAgent, type NodeMessage, type NodeMission, type NodeRoom, type NodeStep, type PrismaClient } from "@prisma/client";
import { sectionText } from "@ensemble/prompts";
import { truncateText } from "../lib/text.js";
import { stopJob } from "../workspace/worker.js";
import { stopPlanTurns } from "./queue.js";
import { announce, postMessage, roomPeople, updateMessageData } from "./store.js";
import {
  conclude,
  decide,
  draftOf,
  ENDED,
  finish,
  heldBy,
  lastAttempt,
  LIVE_MISSIONS,
  markDelivered,
  missionEnded,
  openConflicts,
  raiseConflicts,
  ready,
  replaceStep,
  satisfied,
  settle,
  stepById,
  stuck,
  unseen,
  type Attempt,
  type Decision,
  type Draft,
  type Effect,
  type Finish,
  type MissionState,
  type MissionStatus,
  type StepState,
  type StepStatus,
} from "./missions-core.js";
import { CHECKING_KINDS, parseReport, STEP_KINDS, type StepKind, type StepOutcome } from "./report.js";
import { renderConstraints, type ArtifactInput, type Constraints, type PlanInput, type ProofKind, type StepInput } from "./plan-contract.js";
import { conflictsOf, reviewPart, storedPacket, versionLines, type MissionArtifact, type PacketHeader, type StoredPacket } from "./packet.js";
import { activeHeuristics } from "./heuristics.js";
import { missionOriginFor } from "./peer-requests.js";
import { claimEvents, releaseIn, stepHolder } from "./claims.js";
import { staleChecks, type Stale } from "./parallel.js";
import { withVisionChecks } from "./vision.js";

export { ENDED, LIVE_MISSIONS, missionEnded } from "./missions-core.js";
export type { StepStatus } from "./missions-core.js";

/**
 * How big a plan may be and how many failed agent runs one attempt may have: brakes on runaway planning,
 * not on work, from the config (node/heuristics.ts `plans`).
 */
export function planLimits(): { maxSteps: number; maxRequirements: number; maxStepFailures: number } {
  return activeHeuristics().plans;
}

export type PlanStatus = MissionStatus;

/** How the step's agent runs go, as its owner asked (applied when the step's node names none). */
export type StepRun = { agent?: string; model?: string; effort?: string; context?: "default" | "long_context" };

/** A step as the card shows it (contracts: the plan card projection). */
export type PlanStep = {
  id: string;
  nodeId: string;
  handle: string;
  name: string;
  kind: StepKind;
  executor: string;
  brief: string;
  run?: StepRun;
  /** Steps that must be done (or passed) before this one starts. */
  after: string[];
  verifies: string | null;
  /** A verify or review step: the acceptance criteria it judges (empty: all of its requirements'). */
  acceptanceIds?: string[];
  /** A re-plan replaced it with this step: it no longer counts. */
  supersededBy?: string | null;
  /** Versions of its task packet so far (node/packet.ts). */
  packetVersion?: number;
  /** An integration step: the builds whose worktrees or snapshots it brings into the folder (B13). */
  integrates?: string[];
  requirementIds: string[];
  status: StepStatus;
  held: boolean;
  heldBy: string | null;
  outcome: StepOutcome;
  attempt: number;
  attempts: Attempt[];
  /** A check that passed, after which another step left a different candidate in the same place (B13). */
  staleAfter?: Stale;
  result: string | null;
  progress: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
};

export type RequirementStatus = "open" | "in_progress" | "accepted" | "failed" | "deferred" | "cancelled";
export type Requirement = { id: string; text: string; status: RequirementStatus; acceptance: Array<{ id: string; text: string; mandatory: boolean; proof?: ProofKind }>; evidence?: string[] };

export type PlanData = {
  type: "plan";
  version: number;
  contract: number;
  missionId: string;
  kind: "plan" | "self";
  leadNodeId: string;
  leadHandle: string;
  leadTurnId: string | null;
  /** Where the lead was asked, and so where it reports. */
  originRoomId: string;
  originPrivate: boolean;
  status: PlanStatus;
  revision: number;
  goal: string | null;
  constraints: Constraints;
  requirements: Requirement[];
  deferred: Array<{ requirementId: string; reason: string }>;
  steps: PlanStep[];
  /** The routine whose occurrence started it (node/routines.ts). */
  routine: RoutineLink | null;
  /** What its steps work from, with hashes (node/packet.ts `MissionArtifact`). */
  artifacts?: MissionArtifact[];
};

/** A routine's occurrence, on the mission it started: notify says when its result is posted. */
export type RoutineLink = { id: string; runId: string; title: string; notify: "always" | "needed" | "never"; trigger?: string };

export type PlanLink = { planId: string; planStep: string | null };

const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval", "stopping"] as const;

export class PlanError extends Error {}

/** Crews stay crews (node/crew.ts): a step for another node goes only to a member of the plan's room. */
async function assertInRoom(db: Db, roomId: string, nodes: ReadonlyArray<Pick<NodeAgent, "id" | "name">>): Promise<void> {
  if (!nodes.length) return;
  const members = await db.nodeRoomMember.findMany({ where: { roomId, nodeId: { in: nodes.map((row) => row.id) } }, select: { nodeId: true } });
  const missing = nodes.filter((row) => !members.some((member) => member.nodeId === row.id));
  if (missing.length) throw new PlanError(`${missing.map((row) => `“${row.name}”`).join(", ")} ${missing.length === 1 ? "is" : "are"} not in this crew; only its members get steps (node_crew_add asks your owner to add one).`);
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The card's data, when the message is a plan card. */
export function planData(message: Pick<NodeMessage, "kind" | "data"> | null): PlanData | null {
  const data = message?.data as PlanData | null;
  return message?.kind === "plan" && data?.type === "plan" && Array.isArray(data.steps) ? data : null;
}

/** The plan a card or turn belongs to (`data.plan` on cards a step's node posts). */
export function planLinkOf(data: unknown): PlanLink | null {
  const link = (data as { plan?: { id?: unknown; step?: unknown } } | null)?.plan;
  return link && typeof link.id === "string" ? { planId: link.id, planStep: typeof link.step === "string" ? link.step : null } : null;
}

// ---------------------------------------------------------------------------------------------
// State: rows ⇄ the pure core's shapes

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function stepState(row: NodeStep): StepState {
  return {
    id: row.id,
    position: row.position,
    nodeId: row.nodeId,
    handle: row.handle,
    kind: row.kind,
    executor: row.executor,
    brief: row.brief,
    after: [...row.after],
    verifies: row.verifies,
    requirementIds: [...row.requirementIds],
    status: row.status as StepStatus,
    outcome: row.outcome as StepOutcome,
    attempt: row.attempt,
    attempts: Array.isArray(row.attempts) ? (row.attempts as unknown as Attempt[]) : [],
    report: parseReport(row.report),
    result: row.result,
    progress: row.progress,
    nudged: row.nudged,
    supersededBy: row.supersededBy,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
  };
}

/** A stuck step climbs the escalation ladder in a crew plan; a node's own work and a routine that reports nothing end as they are. */
export function laddered(row: Pick<NodeMission, "kind" | "contract" | "routine">): boolean {
  const routine = row.routine as RoutineLink | null;
  return row.kind === "plan" && row.contract >= 3 && routine?.notify !== "never";
}

function missionState(row: NodeMission): MissionState {
  return { id: row.id, contract: row.contract, status: row.status as MissionStatus, reportedAt: iso(row.reportedAt), ladder: laddered(row) };
}

/** The mission's artifact registry (node_missions.artifacts). */
export function artifactsOf(mission: Pick<NodeMission, "artifacts">): MissionArtifact[] {
  return Array.isArray(mission.artifacts) ? (mission.artifacts as unknown as MissionArtifact[]) : [];
}

/** The registry after the lead names artifacts: a new hash for a known ref keeps the one before in `versions`. */
export function registerArtifacts(registry: readonly MissionArtifact[], items: readonly ArtifactInput[], now: string): { registry: MissionArtifact[]; changed: string[] } {
  const next = registry.map((row) => ({ ...row, versions: [...(row.versions ?? [])] }));
  const changed: string[] = [];
  for (const item of items) {
    const known = next.find((row) => row.ref === item.ref);
    if (!known) {
      next.push({ ref: item.ref, ...(item.label ? { label: item.label } : {}), hash: item.hash ?? null, at: now, versions: [] });
      continue;
    }
    if (item.label) known.label = item.label;
    if (item.hash && item.hash !== known.hash) {
      known.versions = [...(known.versions ?? []), { hash: known.hash, at: known.at }].slice(-10);
      known.hash = item.hash;
      known.at = now;
      changed.push(item.ref);
    }
  }
  return { registry: next, changed };
}

function storedRequirements(mission: Pick<NodeMission, "requirements">): Requirement[] {
  return Array.isArray(mission.requirements) ? (mission.requirements as unknown as Requirement[]) : [];
}

function storedDeferred(mission: Pick<NodeMission, "deferred">): PlanData["deferred"] {
  return Array.isArray(mission.deferred) ? (mission.deferred as unknown as PlanData["deferred"]) : [];
}

/**
 * The requirement ledger (B6): each requested deliverable's state, derived from the steps that cover it.
 * Accepted needs every covering step done or passed, and a passing check when it has acceptance criteria.
 */
export function ledger(requirements: Requirement[], deferred: PlanData["deferred"], steps: StepState[], ended: boolean): Requirement[] {
  const deferredIds = new Set(deferred.map((row) => row.requirementId));
  return requirements.map((requirement) => {
    if (requirement.status === "cancelled") return requirement;
    if (deferredIds.has(requirement.id)) return { ...requirement, status: "deferred" };
    const covering = steps.filter((step) => !step.supersededBy && step.requirementIds.includes(requirement.id));
    const met = covering.length > 0 && covering.every((step) => satisfied(step));
    const checked = !requirement.acceptance?.length || covering.some((step) => CHECKING_KINDS.has(step.kind) && step.outcome === "pass");
    let status: RequirementStatus;
    if (met && checked) status = "accepted";
    else if (ended) status = "failed";
    else if (covering.some((step) => step.status !== "waiting")) status = "in_progress";
    else status = "open";
    return { ...requirement, status };
  });
}

function project(mission: NodeMission, rows: NodeStep[], leadHandle: string): PlanData {
  const steps = rows.map(stepState);
  const view = { steps };
  const constraints = (mission.constraints && typeof mission.constraints === "object" ? mission.constraints : {}) as Constraints;
  const integratesOf = (row: NodeStep) => (Array.isArray(row.integrates) ? row.integrates : []);
  const stale = staleChecks({ missionId: mission.id, constraints, steps: steps.map((step, index) => ({ ...step, integrates: integratesOf(rows[index]!) })) });
  return {
    type: "plan",
    version: mission.version,
    contract: mission.contract,
    missionId: mission.id,
    kind: mission.kind === "self" ? "self" : "plan",
    leadNodeId: mission.leadNodeId,
    leadHandle,
    leadTurnId: mission.leadTurnId,
    originRoomId: mission.originRoomId,
    originPrivate: mission.originPrivate,
    status: mission.status as PlanStatus,
    revision: mission.revision,
    goal: mission.goal,
    constraints,
    requirements: ledger(storedRequirements(mission), storedDeferred(mission), steps, missionEnded(mission.status)),
    deferred: storedDeferred(mission),
    routine: mission.routine && typeof mission.routine === "object" ? (mission.routine as RoutineLink) : null,
    ...(artifactsOf(mission).length ? { artifacts: artifactsOf(mission) } : {}),
    steps: steps.map((step, index) => {
      const row = rows[index]!;
      const holder = heldBy(view, step);
      return {
        id: step.id,
        nodeId: step.nodeId,
        handle: step.handle,
        name: row.name,
        kind: (STEP_KINDS as readonly string[]).includes(step.kind) ? (step.kind as StepKind) : "other",
        executor: step.executor,
        brief: step.brief,
        ...(row.run && typeof row.run === "object" && Object.values(row.run as object).some(Boolean) ? { run: row.run as StepRun } : {}),
        after: step.after,
        verifies: step.verifies,
        ...(row.acceptanceIds?.length ? { acceptanceIds: [...row.acceptanceIds] } : {}),
        ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
        ...(row.packetVersion ? { packetVersion: row.packetVersion } : {}),
        ...(integratesOf(row).length ? { integrates: integratesOf(row) } : {}),
        requirementIds: step.requirementIds,
        status: step.status,
        held: Boolean(holder),
        heldBy: holder,
        outcome: step.outcome,
        attempt: step.attempt,
        attempts: step.attempts,
        ...(stale.has(step.id) ? { staleAfter: stale.get(step.id)! } : {}),
        result: step.result,
        progress: step.progress,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        sessionId: row.sessionId,
      };
    }),
  };
}

async function leadHandleOf(db: Db, mission: Pick<NodeMission, "leadNodeId">): Promise<string> {
  return (await db.nodeAgent.findUnique({ where: { id: mission.leadNodeId }, select: { slug: true } }))?.slug ?? "lead";
}

/** The mission and its card data, read without locking. */
export async function loadPlan(db: Db, planId: string): Promise<{ message: NodeMessage; data: PlanData; mission: NodeMission } | null> {
  const [message, mission] = await Promise.all([db.nodeMessage.findUnique({ where: { id: planId } }), db.nodeMission.findUnique({ where: { id: planId } })]);
  if (!message || !mission) return null;
  const rows = await db.nodeStep.findMany({ where: { missionId: planId }, orderBy: { position: "asc" } });
  return { message, mission, data: project(mission, rows, await leadHandleOf(db, mission)) };
}

// ---------------------------------------------------------------------------------------------
// Changes: one transaction per change, effects into the outbox

type Ctx = { prisma: PrismaClient; app?: FastifyInstance };
/** In the change's transaction: the client and the step rows as read under the lock. */
type Within = { tx: Prisma.TransactionClient; rows: NodeStep[] };
type ChangeResult = false | void | { body?: string };
type Change = (draft: Draft, mission: NodeMission, within: Within) => ChangeResult | Promise<ChangeResult>;

let outboxKick: ((app: FastifyInstance) => void) | null = null;

/** node/outbox.ts registers how a committed change wakes it (kept here so plans.ts does not import the outbox). */
export function onMissionEffects(kick: (app: FastifyInstance) => void): void {
  outboxKick = kick;
}

/** Wakes the outbox for rows written outside a mission change (a resource handed to a step waiting for it). */
export function kickMissions(app: FastifyInstance): void {
  outboxKick?.(app);
}

function effectRow(effect: Effect, mission: NodeMission, steps: StepState[], version: number): { kind: string; payload: Record<string, unknown>; key: string } {
  if (effect.kind === "turn") {
    const step = stepById({ steps }, effect.stepId)!;
    return { kind: "turn", key: `turn:${effect.stepId}:${effect.attempt}:${effect.reason}`, payload: { stepId: effect.stepId, attempt: effect.attempt, reason: effect.reason, nodeId: step.nodeId } };
  }
  if (effect.kind === "report") return { kind: "report", key: effect.key ?? `report:${version}`, payload: { judgement: effect.judgement, leadNodeId: mission.leadNodeId } };
  if (effect.kind === "replan") return { kind: "replan", key: effect.key ?? `replan:${version}`, payload: { steps: effect.steps, judgement: effect.judgement, leadNodeId: mission.leadNodeId } };
  if (effect.kind === "decide") return { kind: "decide", key: effect.key ?? `decide:${effect.stepId}:${effect.attempt}`, payload: { stepId: effect.stepId, attempt: effect.attempt, why: effect.why } };
  return { kind: "expire_cards", key: `expire:${effect.steps?.join(",") ?? "all"}:${version}`, payload: { steps: effect.steps, why: effect.why } };
}

export type MutateResult = { data: PlanData; message: NodeMessage | null; changed: boolean };

/**
 * Changes a mission under a row lock: `change` edits the draft (or returns false to leave it), the
 * rules settle it, and steps, mission, outbox and card are written together.
 */
export async function mutateMission(ctx: Ctx, planId: string, change: Change, options: { settle?: boolean } = {}): Promise<MutateResult | null> {
  const db = ctx.prisma;
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM node_missions WHERE id = ${planId} FOR UPDATE`;
    const mission = await tx.nodeMission.findUnique({ where: { id: planId } });
    if (!mission) return null;
    const rows = await tx.nodeStep.findMany({ where: { missionId: planId }, orderBy: { position: "asc" } });
    const draft = draftOf(missionState(mission), rows.map(stepState));
    const verdict = await change(draft, mission, { tx, rows });
    const leadHandle = await leadHandleOf(tx, mission);
    if (verdict === false) {
      const card = await tx.nodeMessage.findUnique({ where: { id: planId } });
      return { mission, rows, leadHandle, card, changed: false, kicked: false };
    }
    if (options.settle !== false) settle(draft, new Date().toISOString(), { replanTurns: activeHeuristics().escalation.replanTurns });
    const now = new Date();
    for (const step of draft.steps) {
      if (!draft.dirty.has(step.id)) continue;
      await tx.nodeStep.update({
        where: { missionId_id: { missionId: planId, id: step.id } },
        data: {
          status: step.status,
          outcome: step.outcome,
          attempt: step.attempt,
          attempts: step.attempts as unknown as Prisma.InputJsonValue,
          report: step.report ? (step.report as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          result: step.result,
          progress: step.progress,
          nudged: step.nudged,
          supersededBy: step.supersededBy ?? null,
          after: step.after,
          verifies: step.verifies,
          startedAt: step.startedAt ? new Date(step.startedAt) : null,
          endedAt: step.endedAt ? new Date(step.endedAt) : null,
        },
      });
    }
    const version = mission.version + 1;
    const updated = await tx.nodeMission.update({
      where: { id: planId },
      data: {
        status: draft.mission.status,
        version,
        ...(missionEnded(draft.mission.status) && !mission.endedAt ? { endedAt: now } : {}),
        ...(draft.mission.reportedAt && !mission.reportedAt ? { reportedAt: new Date(draft.mission.reportedAt) } : {}),
      },
    });
    // What ended steps (or the ended mission) held on the computer goes to the next in line (node/claims.ts).
    const ended = draft.steps.filter((step) => draft.dirty.has(step.id) && ENDED.has(step.status)).map((step) => stepHolder(planId, step.id));
    const handovers = await releaseIn(tx, missionEnded(draft.mission.status) ? { missionId: planId } : { holders: ended });
    for (const effect of draft.effects) {
      const { kind, payload, key } = effectRow(effect, mission, draft.steps, version);
      const operationId = `${planId}:${key}`;
      await tx.nodeOutbox.upsert({ where: { operationId }, create: { operationId, missionId: planId, kind, payload: payload as Prisma.InputJsonValue }, update: {} });
    }
    const fresh = await tx.nodeStep.findMany({ where: { missionId: planId }, orderBy: { position: "asc" } });
    const data = project(updated, fresh, leadHandle);
    const existing = await tx.nodeMessage.findUnique({ where: { id: planId }, select: { id: true } });
    const card = existing
      ? await tx.nodeMessage.update({ where: { id: planId }, data: { data: data as unknown as Prisma.InputJsonValue, ...(typeof verdict === "object" && verdict.body !== undefined ? { body: verdict.body } : {}) } })
      : null;
    return { mission: updated, rows: fresh, leadHandle, card, changed: true, kicked: draft.effects.length > 0 || handovers.length > 0, handed: handovers.length > 0 };
  });
  if (!result) return null;
  const data = project(result.mission, result.rows, result.leadHandle);
  if (result.changed && result.card) await announce(db, result.card, "node.message.updated");
  if ("handed" in result && result.handed) claimEvents.emit("released");
  if (result.kicked && ctx.app && outboxKick) outboxKick(ctx.app);
  return { data, message: result.card, changed: result.changed };
}

// ---------------------------------------------------------------------------------------------
// Making plans and work

/** The plan the lead's current turn is building (or continuing, in its report turn), if any. */
export async function currentPlan(db: Db, leadNodeId: string, turnId: string, continuing: string | null): Promise<{ message: NodeMessage; data: PlanData } | null> {
  if (continuing) return loadPlan(db, continuing);
  const mission = await db.nodeMission.findFirst({ where: { leadNodeId, leadTurnId: turnId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  return mission ? loadPlan(db, mission.id) : null;
}

export type NewStep = {
  node: Pick<NodeAgent, "id" | "name">;
  handle: string;
  brief: string;
  after: string[];
  run?: StepRun;
  kind?: StepKind;
  /** Handle of the node whose latest step this one verifies (verify steps). */
  verifies?: string;
  /** node: one of the owner's nodes; self: the lead itself; helper: the lead's temporary helper (node/helpers.ts). */
  executor?: "node" | "self" | "helper";
};

/** What a node's role suggests a step is, when the lead does not say. */
export function kindFromRole(role: string | null | undefined): StepKind {
  const text = (role ?? "").toLowerCase();
  if (/test|qa|verif|review/.test(text)) return "verify";
  if (/doc|writ|copy|editor/.test(text)) return "write";
  if (/research|analy|scout/.test(text)) return "research";
  if (/engineer|build|develop|code|swe|program|implement|frontend|backend/.test(text)) return "build";
  return "other";
}

/**
 * Adds a step to the lead's plan for this turn, making the plan (mission and card) on the first one.
 * `after` names handles already in the plan; their latest steps must be done first.
 */
export async function addStep(
  db: PrismaClient,
  input: { lead: NodeAgent; turnId: string; continuing: string | null; room: NodeRoom; originRoomId: string; originPrivate: boolean; visibleTo: string[]; step: NewStep; kind?: "plan" | "self"; goal?: string; routine?: RoutineLink },
): Promise<{ planId: string; step: PlanStep; position: number }> {
  let plan = await currentPlan(db, input.lead.id, input.turnId, input.continuing);
  if ((input.step.executor ?? "node") === "node" && input.step.node.id !== input.lead.id) await assertInRoom(db, plan?.message.roomId ?? input.room.id, [input.step.node]);
  if (!plan) {
    const { message } = await postMessage(db, {
      roomId: input.room.id,
      userId: input.lead.userId,
      authorKind: "node",
      authorNodeId: input.lead.id,
      kind: "plan",
      body: "",
      data: { type: "plan", version: 0, contract: 3, missionId: "", kind: input.kind ?? "plan", leadNodeId: input.lead.id, leadHandle: input.lead.slug, leadTurnId: input.turnId, originRoomId: input.originRoomId, originPrivate: input.originPrivate, status: "draft", goal: input.goal ?? null, requirements: [], deferred: [], steps: [], routine: input.routine ?? null },
      visibleTo: input.visibleTo,
      // A routine's runs are listed with the routine, not in the timeline: only what it reports is a message.
      planId: input.routine?.id ?? null,
    });
    await db.nodeMission.create({
      data: {
        id: message.id,
        userId: input.lead.userId,
        leadNodeId: input.lead.id,
        originRoomId: input.originRoomId,
        originPrivate: input.originPrivate,
        leadTurnId: input.turnId,
        kind: input.kind ?? "plan",
        contract: 3,
        status: "draft",
        goal: input.goal ?? null,
        ...(input.routine ? { routine: input.routine as unknown as Prisma.InputJsonValue } : {}),
        ...(await missionOriginFor(db, input.turnId)),
      },
    });
    plan = await loadPlan(db, message.id);
    if (!plan) throw new Error("The new plan could not be read back.");
  }
  const planId = plan.message.id;
  let position = 0;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM node_missions WHERE id = ${planId} FOR UPDATE`;
    const mission = await tx.nodeMission.findUniqueOrThrow({ where: { id: planId } });
    if (missionEnded(mission.status)) throw new PlanError("That plan has ended; start a new one in a new turn.");
    const rows = await tx.nodeStep.findMany({ where: { missionId: planId }, orderBy: { position: "asc" } });
    const { maxSteps } = planLimits();
    if (rows.length >= maxSteps) throw new PlanError(`A plan holds at most ${maxSteps} steps. Give one node a bigger step instead.`);
    const latest = (handle: string) => [...rows].reverse().find((row) => row.handle === handle || row.handle === handle.replace(/^@/, ""));
    const after = [...new Set(input.step.after)].map((handle) => {
      const found = latest(handle);
      if (!found) throw new PlanError(`@${handle.replace(/^@/, "")} has no step in this plan yet. Add its step first, then this one after it.`);
      return found.id;
    });
    const brief = truncateText(input.step.brief.trim(), 4000);
    const same = rows.find((row) => row.nodeId === input.step.node.id && row.brief.trim() === brief && !ENDED.has(row.status as StepStatus));
    if (same) {
      position = same.position;
      return;
    }
    const kind = input.step.kind ?? "other";
    let verifies: string | null = null;
    if (CHECKING_KINDS.has(kind)) {
      if (input.step.verifies) {
        const target = latest(input.step.verifies);
        if (!target) throw new PlanError(`@${input.step.verifies.replace(/^@/, "")} has no step in this plan to ${kind === "review" ? "review" : "verify"}. Add its build step first.`);
        if (kind === "review" && target.nodeId === input.step.node.id) throw new PlanError("A review is independent: give it to another node (or a helper) than the one whose work it reviews.");
        verifies = target.id;
      } else {
        verifies = after.map((id) => rows.find((row) => row.id === id)!).filter((row) => row.kind === "build" || (kind === "review" && row.kind === "write")).at(-1)?.id ?? null;
      }
    }
    position = rows.length + 1;
    await tx.nodeStep.create({
      data: {
        missionId: planId,
        id: `s${position}-${randomUUID().slice(0, 6)}`,
        position,
        nodeId: input.step.node.id,
        handle: input.step.handle,
        name: input.step.node.name,
        kind,
        executor: input.step.executor ?? "node",
        brief,
        after,
        verifies,
        // A review judges what the work it reviews covers.
        ...(kind === "review" && verifies ? { requirementIds: rows.find((row) => row.id === verifies)?.requirementIds ?? [] } : {}),
        ...(input.step.run && Object.values(input.step.run).some(Boolean) ? { run: input.step.run as Prisma.InputJsonValue } : {}),
      },
    });
  });
  const changed = await mutateMission({ prisma: db }, planId, () => undefined, { settle: false });
  const data = changed?.data ?? (await loadPlan(db, planId))!.data;
  const added = data.steps.find((row) => data.steps.indexOf(row) === position - 1);
  if (!added) throw new Error("The new step could not be read back.");
  return { planId, step: added, position };
}

/** Whether a step's turn should still run: its plan goes on and the step has not ended. */
export async function stepLive(db: Db, planId: string, stepId: string): Promise<boolean> {
  const [mission, step] = await Promise.all([
    db.nodeMission.findUnique({ where: { id: planId }, select: { status: true } }),
    db.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } }, select: { status: true } }),
  ]);
  return Boolean(mission && (mission.status === "running" || mission.status === "replanning" || mission.status === "reporting") && step && !ENDED.has(step.status as StepStatus));
}

/** The step row (for its kind, attempt, conversation and brief). */
export async function stepRow(db: Db, planId: string, stepId: string): Promise<NodeStep | null> {
  return db.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } } });
}

/** The lead's turn ended: its reply (when it was posted in the plan's room) opens the plan, and the steps that can start, start. */
export async function startPlan(app: FastifyInstance, planId: string, intro: string | null): Promise<void> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: planId }, select: { body: true } });
  await mutateMission({ prisma: app.prisma, app }, planId, (draft) => {
    if (draft.mission.status !== "draft") return false;
    draft.mission.status = "running";
    draft.missionDirty = true;
    return { body: intro?.trim() ? truncateText(intro.trim(), 6000) : card?.body || "Plan" };
  });
}

/** Starts every step whose earlier steps are done (or repairs, or reports): the rules settle the mission. */
export async function advancePlan(app: FastifyInstance, planId: string): Promise<void> {
  await mutateMission({ prisma: app.prisma, app }, planId, () => undefined);
}

/**
 * A step's node finished it, could not, or was stopped; what runs next starts (or the build is repaired).
 * Once per attempt: a second result for it changes nothing. `claimRun`: the agent run whose end carried
 * the result is marked reported in the same transaction, so its end is taken once, whatever happens next.
 */
export async function finishStep(app: FastifyInstance, planId: string, stepId: string, outcome: Finish, options: { claimRun?: string } = {}): Promise<boolean> {
  // Confirm before sending (B20): pictures the step's requirements asked for are judged before its report counts.
  if (outcome.report && outcome.status === "done") {
    const owner = (await app.prisma.nodeMission.findUnique({ where: { id: planId }, select: { userId: true } }))?.userId;
    if (owner) outcome = { ...outcome, report: await withVisionChecks(app, { ownerId: owner, missionId: planId, stepId, report: outcome.report }) };
  }
  let ended = false;
  await mutateMission({ prisma: app.prisma, app }, planId, async (draft, mission, { tx, rows }) => {
    if (options.claimRun) {
      const claimed = await tx.nodeRun.updateMany({ where: { id: options.claimRun, reportedAt: null }, data: { reportedAt: new Date() } });
      if (claimed.count !== 1) return false;
    }
    const now = new Date().toISOString();
    const step = stepById(draft, stepId);
    const row = rows.find((candidate) => candidate.id === stepId);
    const packet = storedPacket(row?.packet);
    // Conflicts: what this attempt's packet named has a new version now (node/packet.ts).
    const conflicts = step && packet && packet.header.attempt === step.attempt && outcome.status === "done" ? conflictsOf(packet.header, artifactsOf(mission), draft, now) : [];
    const criteria = row ? judgedBy(mission, row) : { mandatory: [], judged: [] };
    ended = finish(draft, stepId, { ...outcome, mandatory: criteria.mandatory, judged: row?.kind === "review" ? criteria.judged : [], conflicts }, now);
    return ended ? undefined : false;
  });
  return ended;
}

/** The acceptance criteria a verify or review step judges (its own `acceptanceIds`, else all of its requirements'), and those that must pass. */
function judgedBy(mission: Pick<NodeMission, "requirements">, step: Pick<NodeStep, "kind" | "requirementIds" | "acceptanceIds">): { mandatory: string[]; judged: string[] } {
  if (!CHECKING_KINDS.has(step.kind) || !step.requirementIds.length) return { mandatory: [], judged: [] };
  const only = step.acceptanceIds?.length ? new Set(step.acceptanceIds) : null;
  const items = storedRequirements(mission)
    .filter((row) => step.requirementIds.includes(row.id))
    .flatMap((row) => (row.acceptance ?? []).filter((item) => !only || only.has(item.id)));
  return { mandatory: items.filter((item) => item.mandatory !== false).map((item) => item.id), judged: items.map((item) => item.id) };
}

export async function stepProgress(db: PrismaClient, planId: string, stepId: string, progress: string): Promise<void> {
  await mutateMission({ prisma: db }, planId, (draft) => {
    const step = stepById(draft, stepId);
    if (!step || step.status !== "working") return false;
    step.progress = truncateText(progress.trim(), 600);
    draft.dirty.add(step.id);
    return undefined;
  }, { settle: false });
}

/** Asks a step's worker once to report (a turn with the nudge note); false when it already was asked. */
export async function nudgeStep(app: FastifyInstance, planId: string, stepId: string): Promise<boolean> {
  let nudged = false;
  await mutateMission({ prisma: app.prisma, app }, planId, (draft) => {
    const step = stepById(draft, stepId);
    if (!step || step.status !== "working" || step.nudged) return false;
    step.nudged = true;
    draft.dirty.add(step.id);
    draft.effects.push({ kind: "turn", stepId: step.id, attempt: step.attempt, reason: "nudge" });
    nudged = true;
    return undefined;
  }, { settle: false });
  return nudged;
}

/**
 * After the lead's plan turn. A re-plan turn: the mission goes on, and the rules take the next rung for
 * what is still stuck (its replacement starts, or its owner gets a card). A report turn: done, unless
 * that turn added steps (they start), or results came in that the turn did not carry: then exactly one
 * more report turn (its operation is keyed by those results, so asking again adds nothing).
 */
export async function afterReport(app: FastifyInstance, planId: string): Promise<void> {
  await mutateMission({ prisma: app.prisma, app }, planId, (draft, mission) => {
    if (draft.mission.status === "replanning") {
      draft.mission.status = "running";
      draft.missionDirty = true;
      return undefined;
    }
    if (draft.mission.status !== "reporting") return false;
    if (draft.steps.some((row) => row.status === "working" || (row.status === "waiting" && ready(draft, row)))) {
      draft.mission.status = "running";
      draft.missionDirty = true;
      return undefined;
    }
    const fresh = unseen(draft.steps);
    if (fresh.length) {
      draft.effects.push({ kind: "report", judgement: [], key: `report:resume:${fresh.map((row) => `${row.stepId}.${row.n}`).join(",")}` });
      return undefined;
    }
    const now = new Date().toISOString();
    const status = conclude(draft, now);
    // A mission with requested deliverables not accepted (and not deferred) is not a success.
    const open = ledger(storedRequirements(mission), storedDeferred(mission), draft.steps, true).filter((row) => row.status === "failed");
    if (status === "succeeded" && open.length) draft.mission.status = "partially_completed";
    draft.mission.reportedAt = draft.mission.reportedAt ?? now;
    return undefined;
  });
}

/**
 * The lead's report or re-plan turn starts: in one transaction, every result it now carries is marked
 * delivered to it (the lead's seen list), and its update is written from the mission as it is now.
 * Null when the mission no longer waits for its lead (it went on running, or it ended): the turn has
 * nothing to do.
 */
export async function beginPlanTurn(app: FastifyInstance, planId: string, turnId: string): Promise<{ kind: "report" | "replan"; note: string } | null> {
  let kind: "report" | "replan" | null = null;
  const result = await mutateMission(
    { prisma: app.prisma, app },
    planId,
    (draft) => {
      if (draft.mission.status !== "reporting" && draft.mission.status !== "replanning") return false;
      kind = draft.mission.status === "replanning" ? "replan" : "report";
      return markDelivered(draft, turnId, new Date().toISOString()).length ? undefined : false;
    },
    { settle: false },
  );
  if (!kind || !result) return null;
  return { kind, note: kind === "replan" ? replanNote(result.data) : reportNote(result.data) };
}

/** The owner's card for a stuck step (node/outbox.ts posts it): one decision, one press. */
export const PLAN_DECISION_CARD = "plan_decision";

/**
 * The owner answered a stuck step's card. Approve: try it again (or, for a conflict, redo it with the
 * new version); discard: finish the plan without it (or keep its result as it is). False when the card
 * no longer applies (the step moved on, was replaced, or was decided already).
 */
export async function answerPlanDecision(app: FastifyInstance, planId: string, stepId: string, attempt: number, answer: "approve" | "discard"): Promise<boolean> {
  let applied = false;
  await mutateMission({ prisma: app.prisma, app }, planId, (draft) => {
    if (missionEnded(draft.mission.status)) return false;
    const step = stepById(draft, stepId);
    const last = step && lastAttempt(step);
    if (!step || !last || last.n !== attempt) return false;
    const conflict = last.escalation?.why === "conflict" || openConflicts(step).length > 0;
    const how: Decision["how"] = answer === "approve" ? (conflict ? "forward" : "retry") : conflict ? "keep" : "finish_without";
    applied = decide(draft, stepId, { by: "owner", how, at: new Date().toISOString() });
    if (applied && draft.mission.status !== "running" && draft.mission.status !== "draft") {
      draft.mission.status = "running";
      draft.missionDirty = true;
    }
    return applied ? undefined : false;
  });
  return applied;
}

/** Ends a mission at once (its lead cannot report: paused or gone). */
export async function endPlan(app: FastifyInstance, planId: string): Promise<void> {
  await mutateMission({ prisma: app.prisma, app }, planId, (draft) => {
    if (missionEnded(draft.mission.status)) return false;
    conclude(draft, new Date().toISOString());
    return undefined;
  }, { settle: false });
}

/**
 * A plan's turn ended without settling its part (skipped, failed, dropped by a stop): its step ends
 * blocked, or the lead's report is given up, so the plan never waits forever. A no-op when the turn
 * already settled it, or when a run or card of the step is still to come back.
 */
export async function planTurnEnded(app: FastifyInstance, turn: { planId: string | null; planStep: string | null }, why: string): Promise<void> {
  if (!turn.planId) return;
  if (!turn.planStep) return afterReport(app, turn.planId);
  if (await stepPending(app.prisma, turn.planId, turn.planStep)) return;
  await finishStep(app, turn.planId, turn.planStep, { status: "blocked", result: why, outcome: "blocked" });
}

/** When the step's current attempt started: runs and cards from before it belong to an earlier attempt. */
async function attemptStart(db: Db, planId: string, stepId: string): Promise<{ attempt: number; since: Date | null }> {
  const step = await db.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } }, select: { attempt: true, startedAt: true } });
  return { attempt: step?.attempt ?? 1, since: step?.startedAt ?? null };
}

/** The current attempt of a step (for runs and cards it starts). */
export async function currentAttempt(db: Db, planId: string, stepId: string): Promise<number> {
  return (await attemptStart(db, planId, stepId)).attempt;
}

/** Whether a step still waits on an agent run or a card of its own (in its current attempt). `except`: a run whose end is being taken now. */
export async function stepPending(db: Db, planId: string, stepId: string, options: { except?: string } = {}): Promise<boolean> {
  return (await stepRuns(db, planId, stepId, options)).pending > 0 || (await stepCardsWaiting(db, planId, stepId)) > 0;
}

/** The run settings the lead gave a step. */
export async function stepRun(db: Db, planId: string, stepId: string): Promise<StepRun> {
  const step = await db.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } }, select: { run: true } });
  return (step?.run as StepRun | null) ?? {};
}

/**
 * Agent runs the step's current attempt started, and those its node will still hear about: not
 * reported yet and not taken over by a newer call (a steer, a replacement, a stop), whose end wakes nobody.
 */
export async function stepRuns(db: Db, planId: string, stepId: string, options: { except?: string } = {}): Promise<{ total: number; pending: number; failed: number }> {
  const { since } = await attemptStart(db, planId, stepId);
  const runs = await db.nodeRun.findMany({ where: { planId, planStep: stepId, ...(since ? { createdAt: { gte: since } } : {}) }, select: { id: true, messageId: true, reportedAt: true, jobId: true } });
  const open = runs.filter((row) => !row.reportedAt && row.id !== options.except);
  const cards = open.length ? await db.nodeMessage.findMany({ where: { id: { in: open.map((row) => row.messageId).filter((id): id is string => Boolean(id)) } }, select: { data: true } }) : [];
  const quiet = cards.filter((card) => typeof (card.data as { quiet?: unknown } | null)?.quiet === "string").length;
  const failed = runs.length ? await db.workspaceJob.count({ where: { id: { in: runs.map((row) => row.jobId) }, status: "failed" } }) : 0;
  return { total: runs.length, pending: Math.max(0, open.length - quiet), failed };
}

/** Cards of a step's current attempt still waiting on the owner (a session to approve, a secret to type): the step goes on after them. */
export async function stepCardsWaiting(db: Db, planId: string, stepId: string): Promise<number> {
  const { since } = await attemptStart(db, planId, stepId);
  return db.nodeMessage.count({
    where: {
      kind: "approval",
      ...(since ? { createdAt: { gte: since } } : {}),
      AND: [{ data: { path: ["plan", "id"], equals: planId } }, { data: { path: ["plan", "step"], equals: stepId } }, { data: { path: ["status"], equals: "pending" } }],
    },
  });
}

/** Whether a run belongs to an earlier attempt of its step than the current one (it started before the attempt). */
export async function runIsStale(db: Db, run: { planId: string | null; planStep: string | null; createdAt: Date }): Promise<boolean> {
  if (!run.planId || !run.planStep) return false;
  const { since } = await attemptStart(db, run.planId, run.planStep);
  return Boolean(since && run.createdAt < since);
}

/**
 * Stops plans: their steps that have not ended, and the agent runs those steps started. By room (the
 * room's Stop), by node (pausing it: the plans it leads and its own steps), or one plan.
 */
export async function stopPlans(app: FastifyInstance, where: { roomId?: string; nodeId?: string; planId?: string; userId: string }): Promise<number> {
  const db = app.prisma;
  const cards = where.roomId ? await db.nodeMessage.findMany({ where: { kind: "plan", roomId: where.roomId, userId: where.userId }, select: { id: true } }) : [];
  const missions = await db.nodeMission.findMany({
    where: {
      userId: where.userId,
      status: { in: [...LIVE_MISSIONS] },
      ...(where.planId ? { id: where.planId } : {}),
      AND: [
        ...(where.roomId ? [{ OR: [{ id: { in: cards.map((row) => row.id) } }, { originRoomId: where.roomId }] }] : []),
        ...(where.nodeId ? [{ OR: [{ leadNodeId: where.nodeId }, { steps: { some: { nodeId: where.nodeId } } }] }] : []),
      ],
    },
    include: { steps: true },
  });
  let stopped = 0;
  for (const mission of missions) {
    const whole = !where.nodeId || mission.leadNodeId === where.nodeId;
    const steps = mission.steps.filter((row) => !ENDED.has(row.status as StepStatus) && (whole || row.nodeId === where.nodeId)).map((row) => row.id);
    if (!whole && !steps.length) continue;
    // Its turns stop first, so none of them starts new work for a plan that is over.
    await stopPlanTurns(app, mission.id, whole ? null : steps);
    const runs = await db.nodeRun.findMany({ where: { planId: mission.id, ...(whole ? {} : { planStep: { in: steps } }), reportedAt: null } });
    const live = await db.workspaceJob.findMany({ where: { id: { in: runs.map((row) => row.jobId) }, status: { in: [...LIVE_JOB] }, cancelRequestedAt: null }, select: { id: true } });
    for (const job of live) await stopJob(app, where.userId, job.id);
    // Their ends wake nobody: the plan already says they stopped.
    for (const run of runs) {
      const card = run.messageId ? await db.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
      if (card && typeof (card.data as { quiet?: unknown }).quiet !== "string") await updateMessageData(db, card, { quiet: "stopped" });
    }
    await mutateMission({ prisma: db, app }, mission.id, (draft) => {
      const now = new Date().toISOString();
      for (const step of draft.steps) {
        if (!steps.includes(step.id) || ENDED.has(step.status)) continue;
        step.status = "stopped";
        step.result = step.result ?? "Stopped by your owner.";
        step.progress = null;
        step.endedAt = now;
        draft.dirty.add(step.id);
      }
      draft.effects.push({ kind: "expire_cards", steps: whole ? null : steps, why: "Its work was stopped." });
      if (whole) {
        draft.mission.status = "stopped";
        draft.missionDirty = true;
      }
      return undefined;
    }, { settle: !whole });
    stopped += 1;
  }
  return stopped;
}

/** Who sees a plan card: its owner only where other people read the room (or the lead was asked privately there). */
export async function planVisibility(db: Db, ownerId: string, room: NodeRoom, privateTo: string[] | null): Promise<string[]> {
  if (privateTo) return privateTo;
  return (await roomPeople(db, room.id)).some((id) => id !== ownerId) ? [ownerId] : [];
}

// ---------------------------------------------------------------------------------------------
// What nodes are told

function stepTitle(data: PlanData, step: PlanStep): string {
  return data.kind === "self" ? "your own work" : `step ${data.steps.findIndex((row) => row.id === step.id) + 1} of ${data.steps.length}`;
}

function resultLine(data: PlanData, row: PlanStep): string {
  const outcome = row.outcome !== "unknown" && row.outcome !== row.status ? `, ${row.outcome}` : "";
  const holder = row.held ? data.steps.find((step) => step.id === row.heldBy) : undefined;
  const held = holder ? `, held by @${holder.handle}'s step` : "";
  return `- @${row.handle} (${row.kind}, ${row.status}${outcome}${held}): ${truncateText((row.result ?? row.progress ?? "no report").replace(/\s+/g, " "), 1200)}`;
}

function checksLine(attempt: Attempt | undefined): string {
  const checks = attempt?.checks ?? [];
  return checks.map((check) => `  - ${check.verdict.toUpperCase()} ${check.name}${check.detail ? `: ${truncateText(check.detail.replace(/\s+/g, " "), 400)}` : ""}`).join("\n");
}

/**
 * What a step's node is told when its step (or a new attempt of it) starts. `header`: the attempt's task
 * packet, whose later versions say what changed and what stays.
 */
export function stepNote(data: PlanData, step: PlanStep, reason: Attempt["reason"] = "first", header: PacketHeader | null = null): string {
  const before = step.after.map((id) => data.steps.find((row) => row.id === id)).filter((row): row is PlanStep => Boolean(row));
  const run = step.run ? Object.entries(step.run).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(", ") : "";
  const current = step.attempts.find((row) => row.n === step.attempt);
  const lines: string[] = header ? versionLines(header) : [];
  if (reason === "nudge") {
    return "Your step is not reported yet. Report it now with node_step_report: outcome (done, pass, fail, partial, uncertain or blocked), a short summary, the commit in subject if you made one, and for a verification or review each check with its verdict and strength. A reply in prose does not count as a report.";
  }
  if (reason === "repair") {
    const verify = data.steps.find((row) => row.id === current?.forVerify);
    const failed = verify?.attempts.filter((row) => row.outcome === "fail").at(-1);
    lines.push(
      `Repair, attempt ${step.attempt} of your step in @${data.leadHandle}'s plan: @${verify?.handle ?? "the tester"}'s independent ${verify?.kind === "review" ? "review" : "check"} of your work FAILED.`,
      failed?.summary ? `Their report: ${truncateText(failed.summary, 1500)}` : "",
      checksLine(failed) ? `Failing checks:\n${checksLine(failed)}` : "",
      failed?.candidate?.commit ? `Tested commit: ${failed.candidate.commit}.` : "",
      "Fix only this, in the same agent session as before (node_session_send to your session), and keep everything else as it is. Then report with node_step_report: what changed, with the new commit in subject.",
      `Your original step, for reference: ${step.brief}`,
    );
  } else if (step.kind === "review") {
    lines.push(`${reason === "retest" ? `Review again, attempt ${step.attempt}` : "Your review"} in @${data.leadHandle}'s plan (${stepTitle(data, step)}):`, reviewPart(data, step, reason), sectionText("node/85-task-review"));
  } else if (reason === "retest") {
    lines.push(
      `Retest, attempt ${step.attempt} of your check in @${data.leadHandle}'s plan: the build was repaired after your check failed.`,
      current?.candidate?.commit ? `Check the new candidate: commit ${current.candidate.commit}${current.candidate.branch ? ` on ${current.candidate.branch}` : ""}.` : "Check the repaired work.",
      "Run the same checks again (re-run any you recorded), plus anything the repair could have broken. Report with node_step_report: pass only if every check passes, each check named.",
      `Your original step, for reference: ${step.brief}`,
    );
  } else {
    if (reason === "amend") lines.push(`Attempt ${step.attempt} of your step: what it works from changed, so do it again with the new version (the changes are above).`);
    if (reason === "retry") lines.push(`Attempt ${step.attempt} of your step: it was stuck, and it is to be tried again.`);
    lines.push(`Your step in @${data.leadHandle}'s plan (${stepTitle(data, step)}, ${step.kind}):`, step.brief);
    const covers = data.requirements.filter((row) => step.requirementIds.includes(row.id));
    if (covers.length) {
      lines.push(
        `It covers: ${covers
          .map((row) => `${row.text}${row.acceptance.length ? ` (acceptance: ${row.acceptance.map((item) => `${item.id}: ${item.text}`).join("; ")})` : ""}`)
          .join(" · ")}`,
      );
      if (step.kind === "verify") lines.push("Report one check per acceptance criterion, with its id, so the plan knows each one passed.");
    }
    if (step.kind === "verify") {
      const target = data.steps.find((row) => row.id === step.verifies);
      const candidate = target?.attempts.filter((row) => row.outcome === "done").at(-1)?.candidate;
      if (target) lines.push(`You check @${target.handle}'s work independently${candidate?.commit ? ` at commit ${candidate.commit}` : ""}. Do not fix it yourself: report what fails.`);
    }
  }
  const rules = renderConstraints(data.constraints);
  if (rules) lines.push(`\nConstraints from your owner (they apply to this step and override anything else):\n${rules}`);
  if (run) lines.push(`Agent runs for this step use ${run}. These settings are already applied when you start or continue a session; do not check them.`);
  if (before.length && reason === "first") lines.push(`\nDone before yours:\n${before.map((row) => resultLine(data, row)).join("\n")}`);
  lines.push("", STEP_RULES);
  return lines.filter((line) => line !== "").join("\n");
}

/** How a step works, at the end of every step's update: the section a step turn's instructions carry too (node/instructions.ts). */
export const STEP_RULES = sectionText("node/21-step-rules");

/** Why steps need their lead's judgement, from their latest attempts (missions-core.ts `settle` writes it there). */
export function judgementOf(data: Pick<PlanData, "steps">): string[] {
  return data.steps.flatMap((row) => {
    const last = row.attempts.at(-1);
    return last?.judgement && !last.decision && !row.supersededBy ? [last.judgement] : [];
  });
}

function conflictLines(data: Pick<PlanData, "steps">): string[] {
  return data.steps.flatMap((row) =>
    openConflicts(row).map((conflict) => `- @${row.handle}'s step worked from ${conflict.label ?? conflict.ref} at ${conflict.was.slice(0, 12)}, which is now ${conflict.now.slice(0, 12)}: its result is not accepted until it is redone with the new version or kept as it is.`),
  );
}

function decisionLines(data: Pick<PlanData, "steps">): string[] {
  const words: Record<Decision["how"], string> = { retry: "try it again", finish_without: "finish without it", forward: "redo it with the new version", keep: "keep its result as it is", replaced: "replace it" };
  return data.steps.flatMap((row) => {
    const decided = [...row.attempts].reverse().find((attempt) => attempt.decision)?.decision;
    return decided ? [`- @${row.handle}: ${decided.by === "owner" ? "your owner" : "you"} chose to ${words[decided.how]}${row.supersededBy ? ` (replaced by step ${row.supersededBy})` : ""}.`] : [];
  });
}

/** What reports say is left, and the decisions only the owner can make. */
function remainingLines(data: Pick<PlanData, "steps">): { remaining: string[]; owner: string[] } {
  const remaining: string[] = [];
  const owner: string[] = [];
  for (const row of data.steps.filter((step) => !step.supersededBy)) {
    const last = row.attempts.at(-1);
    if (last?.remaining?.length && row.outcome !== "done" && row.outcome !== "pass") remaining.push(`- @${row.handle}: ${last.remaining.map((item) => truncateText(item, 200)).join("; ")}`);
    if (last?.ownerDecision) owner.push(`- @${row.handle}: ${truncateText(last.ownerDecision, 300)}`);
  }
  return { remaining, owner };
}

/** What the lead is told when its plan has nothing left to run (its report turn). */
export function reportNote(data: PlanData, judgement: string[] = judgementOf(data)): string {
  const counted = data.steps.filter((row) => !row.supersededBy);
  const ok = counted.every((row) => (row.outcome === "done" || row.outcome === "pass") && !openConflicts(row).length);
  const failed = counted.filter((row) => row.outcome === "fail");
  const held = counted.filter((row) => row.held);
  const stale = counted.filter((row) => row.staleAfter).map((row) => {
    const tested = [...row.attempts].reverse().find((attempt) => attempt.outcome === "pass")?.candidate;
    const was = tested?.commit ?? tested?.contentHash;
    const after = row.staleAfter!;
    return `- @${row.handle}'s check passed${was ? ` for ${was.slice(0, 12)}` : ""}, but @${after.handle}'s step then left ${after.candidate.slice(0, 12)} in the same place: that pass does not cover it.`;
  });
  const conflicts = conflictLines(data);
  const decisions = decisionLines(data);
  const unfinished = counted.filter((row) => row.outcome === "partial" || row.outcome === "uncertain");
  const left = remainingLines(data);
  const routine = data.routine
    ? [
        `This was your routine “${data.routine.title}”${data.routine.trigger ? ` (${data.routine.trigger})` : ""}.`,
        data.routine.notify === "needed" ? "Post only if something failed, changed or needs your owner; otherwise reply exactly (no reply)." : "",
      ].filter(Boolean)
    : [];
  return [
    ...routine,
    data.kind === "self" ? "Your own work ended. Its report:" : "Your plan has nothing left to run. The steps:",
    ...data.steps.map((row) => resultLine(data, row)),
    ...(failed.length ? ["", "Failed checks:", ...failed.map((row) => `- @${row.handle}:\n${checksLine(row.attempts.at(-1)) || `  ${truncateText(row.result ?? "", 400)}`}`)] : []),
    ...(unfinished.length ? ["", "Not done (partial or uncertain never count as done):", ...unfinished.map((row) => `- @${row.handle} (${row.outcome}): ${truncateText((row.result ?? "").replace(/\s+/g, " "), 400)}`)] : []),
    ...(left.remaining.length ? ["", "What is left, as reported:", ...left.remaining] : []),
    ...(left.owner.length ? ["", "Decisions only your owner can make, as reported:", ...left.owner] : []),
    ...(conflicts.length ? ["", "Conflicts (what a step worked from changed):", ...conflicts] : []),
    ...(decisions.length ? ["", "Decisions on stuck steps:", ...decisions] : []),
    ...(stale.length ? ["", "Passing checks a later change made stale (tell your owner; only a new check would cover it):", ...stale] : []),
    ...(data.requirements.length ? ["", "Requirements:", ...data.requirements.map((row) => `- ${row.status}: ${row.text}`)] : []),
    ...(judgement.length ? ["", "Needs your judgement:", ...judgement.map((line) => `- ${line}`)] : []),
    "",
    ok
      ? "Tell your owner, in one message, what was done and checked, and anything that needs them. Do not repeat each report; summarise."
      : `Tell your owner, in one message, what was done, what ${held.length ? "is held and why" : "did not finish and why"}, what remains, and the one decision you need from them, if any. To repair, redo or add work, call node_delegate (it continues this plan); to ask your owner, say what you need in your one message.`,
  ].join("\n");
}

/** What the lead is told in its one re-plan turn: the stuck steps with why, and the rest of the plan. */
export function replanNote(data: PlanData): string {
  const stuckRows = data.steps.filter((row) => {
    const last = row.attempts.at(-1);
    return last?.escalation?.replan && !last.escalation.owner && !last.decision && !row.supersededBy;
  });
  const others = data.steps.filter((row) => !stuckRows.includes(row));
  const why = (row: PlanStep): string[] => {
    const last = row.attempts.at(-1)!;
    const lines: string[] = [];
    if (last.escalation?.why === "conflict") {
      for (const conflict of openConflicts(row)) lines.push(`  What it worked from changed: ${conflict.label ?? conflict.ref} was ${conflict.was.slice(0, 12)}, is now ${conflict.now.slice(0, 12)}.`);
    }
    if (last.judgement) lines.push(`  ${last.judgement}`);
    const checks = checksLine(last);
    if (checks) lines.push(checks);
    if (last.remaining?.length) lines.push(`  Left to do: ${last.remaining.map((item) => truncateText(item, 200)).join("; ")}`);
    if (last.ownerDecision) lines.push(`  Needs your owner: ${truncateText(last.ownerDecision, 300)}`);
    return lines;
  };
  return [
    `Some steps of your plan are stuck and nothing else can run. This is your one re-plan turn for them (@${data.leadHandle}'s plan, revision ${data.revision}):`,
    ...stuckRows.flatMap((row) => [`- step ${row.id}: ${resultLine(data, row).slice(2)}`, ...why(row)]),
    "",
    "The rest of the plan:",
    ...(others.length ? others.map((row) => resultLine(data, row)) : ["- (no other steps)"]),
    "",
    "For each stuck step, choose one:",
    "- Replace it: node_plan_revise with a step that has replaces (the stuck step's id): another member, another agent or model, or a changed brief. The steps after it wait for the new one.",
    "- A conflict: node_plan_revise resolve [{step, how: forward}] redoes it with the new version; how: keep accepts its result as it is.",
    "- Leave it: your owner gets a card in the chat with the one decision it needs. Do not run the same thing again.",
    "Then reply exactly (no reply), or one line for your owner; they hear the outcome when the plan ends.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The mission contract (B6): a whole plan at once, and revisions

export type PlanNode = { node: Pick<NodeAgent, "id" | "name">; handle: string };

/** The run settings a step gets: its own, else the agent settings in the mission's constraints. */
function runFor(step: Pick<StepInput, "run">, constraints: Constraints): StepRun | undefined {
  const own = step.run && Object.values(step.run).some(Boolean) ? step.run : undefined;
  if (own) return own;
  const fromConstraints: StepRun = { agent: constraints.agent, model: constraints.model, effort: constraints.effort, context: constraints.context };
  return Object.values(fromConstraints).some(Boolean) ? fromConstraints : undefined;
}

/**
 * Creates a validated plan (node_plan): its card, its mission with goal, requirements, constraints and
 * deferrals, and every step, in one transaction. It opens (starts) when the lead's turn ends, like a
 * plan built with node_delegate. `nodes` maps each step's `to` handle to its node.
 */
export async function createPlan(
  db: PrismaClient,
  input: { lead: NodeAgent; turnId: string; room: NodeRoom; originRoomId: string; originPrivate: boolean; visibleTo: string[]; plan: PlanInput; nodes: Map<string, PlanNode>; routine?: RoutineLink },
): Promise<{ planId: string; steps: Map<string, string> }> {
  if (await currentPlan(db, input.lead.id, input.turnId, null)) throw new PlanError("This turn already made a plan; add to it with node_delegate or revise it with node_plan_revise.");
  await assertInRoom(db, input.room.id, [...input.nodes.values()].map((row) => row.node).filter((row) => row.id !== input.lead.id));
  const { message } = await postMessage(db, {
    roomId: input.room.id,
    userId: input.lead.userId,
    authorKind: "node",
    authorNodeId: input.lead.id,
    kind: "plan",
    body: "",
    data: { type: "plan", version: 0, contract: 3, missionId: "", kind: "plan", leadNodeId: input.lead.id, leadHandle: input.lead.slug, leadTurnId: input.turnId, originRoomId: input.originRoomId, originPrivate: input.originPrivate, status: "draft", goal: input.plan.goal, requirements: [], deferred: [], steps: [], routine: input.routine ?? null },
    visibleTo: input.visibleTo,
    planId: input.routine?.id ?? null,
  });
  const ids = new Map<string, string>();
  input.plan.steps.forEach((step, index) => ids.set(step.id, `s${index + 1}-${randomUUID().slice(0, 6)}`));
  const requirements: Requirement[] = input.plan.requirements.map((row) => ({
    id: row.id,
    text: row.text,
    status: "open",
    acceptance: row.acceptance.map((item) => ({ id: item.id, text: item.text, mandatory: item.mandatory !== false, ...(item.proof ? { proof: item.proof } : {}) })),
    ...(row.evidence?.length ? { evidence: row.evidence } : {}),
  }));
  const artifacts = registerArtifacts([], input.plan.artifacts ?? [], new Date().toISOString()).registry;
  // An accepted peer request (node/peer-requests.ts): who asked, where the result goes, its principals.
  const origin = await missionOriginFor(db, input.turnId, input.plan.constraints);
  await db.$transaction(async (tx) => {
    await tx.nodeMission.create({
      data: {
        id: message.id,
        userId: input.lead.userId,
        leadNodeId: input.lead.id,
        originRoomId: input.originRoomId,
        originPrivate: input.originPrivate,
        leadTurnId: input.turnId,
        kind: "plan",
        contract: 3,
        status: "draft",
        goal: input.plan.goal,
        constraints: input.plan.constraints as Prisma.InputJsonValue,
        requirements: requirements as unknown as Prisma.InputJsonValue,
        deferred: input.plan.deferred as unknown as Prisma.InputJsonValue,
        artifacts: artifacts as unknown as Prisma.InputJsonValue,
        ...(input.routine ? { routine: input.routine as unknown as Prisma.InputJsonValue } : {}),
        ...origin,
      },
    });
    for (const [index, step] of input.plan.steps.entries()) {
      const target = input.nodes.get(step.to)!;
      const run = runFor(step, input.plan.constraints);
      await tx.nodeStep.create({
        data: {
          missionId: message.id,
          id: ids.get(step.id)!,
          position: index + 1,
          nodeId: target.node.id,
          handle: target.handle,
          name: target.node.name,
          kind: step.kind,
          executor: target.node.id === input.lead.id ? "self" : "node",
          brief: truncateText(step.brief.trim(), 4000),
          after: step.after.map((id) => ids.get(id)!).filter(Boolean),
          verifies: step.verifies ? (ids.get(step.verifies) ?? null) : null,
          integrates: (step.integrates ?? []).map((id) => ids.get(id)!).filter(Boolean),
          requirementIds: step.requirementIds,
          acceptanceIds: step.acceptanceIds ?? [],
          ...(run ? { run: run as Prisma.InputJsonValue } : {}),
        },
      });
    }
  });
  await mutateMission({ prisma: db }, message.id, () => undefined, { settle: false });
  return { planId: message.id, steps: ids };
}

export type Revision = {
  add?: StepInput[];
  cancel?: string[];
  constraints?: Constraints;
  requirements?: Requirement[];
  defer?: Array<{ requirementId: string; reason: string }>;
  /** New versions of what the steps work from: steps that used an older one hold a conflict. */
  artifacts?: ArtifactInput[];
  /** Conflicts the lead settles: forward redoes the step with the new version; keep accepts its result. */
  resolve?: Array<{ step: string; how: "forward" | "keep" }>;
  /** Resolved nodes for added steps' `to` handles. */
  nodes?: Map<string, PlanNode>;
};

/**
 * Revises a running plan (node_plan_revise): new constraints apply to every step's next note; added
 * steps join (their `after` names new step ids or existing ones), and one that `replaces` a stuck step
 * takes its place; waiting steps can be cancelled; requirements can be added or deferred; a new
 * version of an artifact raises a conflict on the finished steps that used the old one, and the lead
 * can resolve conflicts. The revision number goes up; the rules then settle.
 */
export async function revisePlan(app: FastifyInstance, planId: string, change: Revision): Promise<{ revision: number; added: string[]; cancelled: string[]; replaced: string[]; conflicts: string[]; resolved: string[] }> {
  const added: string[] = [];
  const cancelled: string[] = [];
  const replaced: string[] = [];
  const conflicted: string[] = [];
  const resolved: string[] = [];
  const replacing = new Map<string, string>();
  let changedRefs: string[] = [];
  let revision = 0;
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: planId }, select: { roomId: true } });
  const lead = (await app.prisma.nodeMission.findUnique({ where: { id: planId }, select: { leadNodeId: true } }))?.leadNodeId;
  if (card) await assertInRoom(app.prisma, card.roomId, [...(change.nodes?.values() ?? [])].map((row) => row.node).filter((row) => row.id !== lead));
  await app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM node_missions WHERE id = ${planId} FOR UPDATE`;
    const mission = await tx.nodeMission.findUniqueOrThrow({ where: { id: planId } });
    if (missionEnded(mission.status)) throw new PlanError("That plan has ended; start a new one.");
    const rows = await tx.nodeStep.findMany({ where: { missionId: planId }, orderBy: { position: "asc" } });
    const constraints = change.constraints ?? ((mission.constraints ?? {}) as Constraints);
    const ids = new Map<string, string>();
    let position = rows.length;
    for (const step of change.add ?? []) ids.set(step.id, `s${++position}-${randomUUID().slice(0, 6)}`);
    const resolve = (ref: string) => ids.get(ref) ?? rows.find((row) => row.id === ref)?.id ?? [...rows].reverse().find((row) => `@${row.handle}` === ref || row.handle === ref.replace(/^@/, ""))?.id;
    position = rows.length;
    for (const step of change.add ?? []) {
      const target = change.nodes?.get(step.to);
      if (!target) throw new PlanError(`There is no node @${step.to} for step “${step.id}”.`);
      const old = step.replaces ? rows.find((row) => row.id === resolve(step.replaces!)) : undefined;
      if (step.replaces && !old) throw new PlanError(`Step “${step.id}” replaces “${step.replaces}”, which is not a step of this plan.`);
      if (old?.supersededBy) throw new PlanError(`Step “${old.id}” was already replaced by “${old.supersededBy}”.`);
      if (old?.status === "working") throw new PlanError(`Step “${old.id}” is still working: replace it once it has ended.`);
      const given = step.after.map((ref) => {
        const id = resolve(ref);
        if (!id) throw new PlanError(`Step “${step.id}” comes after “${ref}”, which is not a step of this plan.`);
        return id;
      });
      // A replacement comes where the step it replaces came: after what that came after, never after it.
      const after = (old && !given.length ? old.after : given).filter((id) => id !== old?.id);
      if (old) replacing.set(ids.get(step.id)!, old.id);
      const run = runFor(step, constraints);
      await tx.nodeStep.create({
        data: {
          missionId: planId,
          id: ids.get(step.id)!,
          position: ++position,
          nodeId: target.node.id,
          handle: target.handle,
          name: target.node.name,
          kind: step.kind,
          executor: target.node.id === mission.leadNodeId ? "self" : "node",
          brief: truncateText(step.brief.trim(), 4000),
          after,
          verifies: step.verifies ? (resolve(step.verifies) ?? null) : (old?.verifies ?? null),
          integrates: (step.integrates ?? []).map((ref) => resolve(ref)).filter((id): id is string => Boolean(id)),
          requirementIds: step.requirementIds.length ? step.requirementIds : (old?.requirementIds ?? []),
          acceptanceIds: step.acceptanceIds ?? old?.acceptanceIds ?? [],
          ...(run ? { run: run as Prisma.InputJsonValue } : {}),
        },
      });
      added.push(ids.get(step.id)!);
    }
    const requirements = [...storedRequirements(mission), ...(change.requirements ?? [])];
    const deferred = [...storedDeferred(mission), ...(change.defer ?? [])];
    const registered = registerArtifacts(artifactsOf(mission), change.artifacts ?? [], new Date().toISOString());
    changedRefs = registered.changed;
    const updated = await tx.nodeMission.update({
      where: { id: planId },
      data: {
        revision: { increment: 1 },
        constraints: constraints as Prisma.InputJsonValue,
        requirements: requirements as unknown as Prisma.InputJsonValue,
        deferred: deferred as unknown as Prisma.InputJsonValue,
        ...(change.artifacts?.length ? { artifacts: registered.registry as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    revision = updated.revision;
  });
  await mutateMission({ prisma: app.prisma, app }, planId, (draft, mission, { rows }) => {
    const now = new Date().toISOString();
    for (const [next, old] of replacing) if (replaceStep(draft, old, next, now)) replaced.push(old);
    // Finished steps whose packet named an artifact that now has a new version hold a conflict until it is resolved.
    if (changedRefs.length) {
      for (const row of rows) {
        const step = stepById(draft, row.id);
        const packet = storedPacket(row.packet);
        if (!step || step.status !== "done" || (step.outcome !== "done" && step.outcome !== "pass") || !packet || packet.header.attempt !== step.attempt) continue;
        const found = conflictsOf(packet.header, artifactsOf(mission), draft, now).filter((item) => changedRefs.includes(item.ref));
        if (raiseConflicts(draft, step.id, found)) conflicted.push(step.id);
      }
    }
    for (const item of change.resolve ?? []) {
      const step = stepById(draft, item.step);
      if (step && openConflicts(step).length && decide(draft, step.id, { by: "lead", how: item.how, at: now })) resolved.push(step.id);
    }
    if (replaced.length || resolved.length) draft.effects.push({ kind: "expire_cards", steps: [...replaced, ...resolved], why: "Its lead decided." });
    for (const id of change.cancel ?? []) {
      const step = stepById(draft, id);
      if (!step || step.status !== "waiting") continue;
      step.status = "skipped";
      step.result = `Cancelled in revision ${revision}.`;
      step.endedAt = now;
      draft.dirty.add(step.id);
      cancelled.push(step.id);
    }
    // A plan that was reporting goes on when the revision added work that can start (or started some).
    if (draft.mission.status === "reporting" && draft.steps.some((row) => row.status === "working" || (row.status === "waiting" && ready(draft, row)))) {
      draft.mission.status = "running";
      draft.missionDirty = true;
    }
    return undefined;
  });
  return { revision, added, cancelled, replaced, conflicts: conflicted, resolved };
}

/** The acceptance ids a verify or review step judges, and those that must pass (node_step_report's verdict). */
export async function acceptanceFor(db: Db, planId: string, stepId: string): Promise<{ mandatory: string[]; judged: string[] }> {
  const [mission, step] = await Promise.all([db.nodeMission.findUnique({ where: { id: planId } }), db.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } } })]);
  return mission && step ? judgedBy(mission, step) : { mandatory: [], judged: [] };
}

/**
 * What started a mission, for its packets' headers: another person's request, a task on the room's
 * board, a routine, else its owner's message (the lead's turn that made it).
 */
export function packetOrigin(mission: Pick<NodeMission, "id" | "routine" | "requestedBy" | "deliverTo" | "leadTurnId">): { origin: { kind: "message" | "routine" | "task" | "peer"; id: string | null }; rootTaskId: string } {
  const requested = mission.requestedBy as { requestId?: unknown } | null;
  const deliver = mission.deliverTo as { taskId?: unknown } | null;
  const routine = mission.routine as RoutineLink | null;
  if (typeof requested?.requestId === "string") return { origin: { kind: "peer", id: requested.requestId }, rootTaskId: `request:${requested.requestId}` };
  if (typeof deliver?.taskId === "string") return { origin: { kind: "task", id: deliver.taskId }, rootTaskId: `task:${deliver.taskId}` };
  if (routine?.id) return { origin: { kind: "routine", id: routine.id }, rootTaskId: mission.id };
  return { origin: { kind: "message", id: mission.leadTurnId }, rootTaskId: mission.id };
}

/**
 * Compiles a step attempt's task packet and stores it on the step, once per attempt and reason (a
 * redelivered start finds it stored). The packet's version follows the one before; its amendment is
 * computed from that one's header. Null when the attempt is no longer current.
 */
export async function storeStepPacket(db: PrismaClient, planId: string, stepId: string, attempt: number, reason: Attempt["reason"], compile: (previous: PacketHeader | null, registry: MissionArtifact[], mission: NodeMission) => StoredPacket): Promise<StoredPacket | null> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM node_missions WHERE id = ${planId} FOR UPDATE`;
    const [mission, row] = await Promise.all([tx.nodeMission.findUnique({ where: { id: planId } }), tx.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: stepId } } })]);
    if (!mission || !row || row.attempt !== attempt || ENDED.has(row.status as StepStatus)) return null;
    const stored = storedPacket(row.packet);
    if (stored && stored.header.attempt === attempt && stored.header.reason === reason) return stored;
    const packet = compile(stored?.header ?? null, artifactsOf(mission), mission);
    const attempts = (Array.isArray(row.attempts) ? (row.attempts as unknown as Attempt[]) : []).map((item) => (item.n === attempt ? { ...item, packet: { version: packet.header.packetVersion, hash: packet.header.hash } } : item));
    await tx.nodeStep.update({
      where: { missionId_id: { missionId: planId, id: stepId } },
      data: { packet: packet as unknown as Prisma.InputJsonValue, packetVersion: packet.header.packetVersion, attempts: attempts as unknown as Prisma.InputJsonValue },
    });
    return packet;
  });
}
