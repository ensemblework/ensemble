/**
 * Direct dispatch (ensemble-node docs/design B8, plan §8.4): a plan step that is work in files (a build,
 * its check, writing files where the mission names them) goes straight from its compiled packet to a
 * coding-agent session, with no turn of the step's node in between. The node takes a turn only when
 * judgement is needed: the run reported blocked, or still reported nothing after being asked once; the
 * step is not work in files; or the hand-over itself failed.
 *
 * Same line of work continues the same session (a repair, a builder's next feature in serial work); a
 * check runs in a session of its own, and so does each build that works apart in its own worktree (B13).
 * Before it starts, a step takes its place on the computer (node/placement.ts): the folder's checkout,
 * or its worktree; when another step has it, the step waits in line and is handed over when it frees.
 * The owner's "ask before computer work" setting still applies: the packet then
 * waits on the same approval card a node's own call would make.
 */
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeRun, PrismaClient } from "@prisma/client";
import { ToolBlockedError } from "../assistant/types.js";
import { folderLabels } from "../devices/labels.js";
import { nodeWebOrigin } from "../lib/node-origin.js";
import { truncateText } from "../lib/text.js";
import type { AttemptReason } from "./missions-core.js";
import { compilePacket, dispatchable } from "./packet.js";
import { parallelMode } from "./parallel.js";
import { placeStep, type Located } from "./placement.js";
import { stepProgress, type PlanData, type PlanStep } from "./plans.js";
import { computerWorkAsks, holdForOwner, ownerContext, SendInput, sendToSession, StartInput, startSession, type SessionCall, type SessionEnv, type Started } from "./sessions.js";
import { updateMessageData } from "./store.js";

export type Dispatch = { done: true; summary: string } | { done: false; why: string };

/** Asked once, in the same session, when a run of a dispatched step ends without its result. */
export const REPORT_ASK =
  "You finished without reporting your result. Call the Ensemble tool report_result now (or write .ensemble/result.json): outcome, a short summary, subject (repo, branch, commit), and each check with its verdict. Do not redo the work.";

/** The ask, naming the work it is about. */
export function reportAsk(title: string | null): string {
  return title ? `${REPORT_ASK.replace("You finished without", `You finished “${title}” without`)}` : REPORT_ASK;
}

/** The mission's folder as one of the owner's computers shares it (folders are shared by name, never by path). */
async function findShared(prisma: PrismaClient, ownerId: string, folder: string, computer: string | undefined): Promise<{ place: { folder: string; computer?: string }; located: Located } | null> {
  const devices = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, select: { id: true, name: true, capabilities: true }, orderBy: { lastSeenAt: "desc" } });
  const wanted = folder.trim().replace(/[\\/]+$/, "");
  const last = wanted.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const named = computer?.trim().toLowerCase();
  const candidates = devices.filter((device) => !named || device.id === computer || device.name.toLowerCase() === named);
  for (const device of candidates) {
    const label = folderLabels(device.capabilities).find((name) => name.toLowerCase() === wanted.toLowerCase() || name.toLowerCase() === last);
    if (label) return { place: { folder: label, ...(computer || devices.length > 1 ? { computer: device.name } : {}) }, located: { deviceId: device.id, deviceName: device.name, label, capabilities: device.capabilities } };
  }
  return null;
}


/** Where a session runs: its computer and the folder it was started in (a continued session stays there). */
async function sessionPlace(prisma: PrismaClient, sessionId: string): Promise<Located | null> {
  const first = await prisma.workspaceJob.findUnique({ where: { id: sessionId }, select: { folderLabel: true, device: { select: { id: true, name: true, capabilities: true } } } });
  if (!first?.device || !first.folderLabel) return null;
  return { deviceId: first.device.id, deviceName: first.device.name, label: first.folderLabel, capabilities: first.device.capabilities };
}

/** A repository the agent can clone: a URL or owner/repo. A bare name is not enough to find it. */
function cloneable(repo: string): boolean {
  return /^https?:\/\//.test(repo) || /^[\w.-]+\/[\w.-]+$/.test(repo);
}

type Place = { folder?: string; computer?: string; repoUrl?: string };

/** Where a new session for the mission works: the folder a computer shares (and where that is), else its one clonable repository. */
async function placeFor(prisma: PrismaClient, ownerId: string, constraints: PlanData["constraints"]): Promise<{ place: Place; located: Located | null } | { why: string }> {
  if (constraints.folder) {
    const shared = await findShared(prisma, ownerId, constraints.folder, constraints.computer);
    return shared ? { place: shared.place, located: shared.located } : { why: `No paired computer shares a folder matching “${constraints.folder}”${constraints.computer ? ` on ${constraints.computer}` : ""}.` };
  }
  const repos = (constraints.repos ?? []).filter(cloneable);
  if (repos.length !== 1) return { why: "The plan names its repositories without one clonable address (a URL or owner/repo) and no folder, so where to work is yours to choose." };
  return { place: { repoUrl: repos[0]!, ...(constraints.computer ? { computer: constraints.computer } : {}) }, located: null };
}

/** Runs of a session that have not ended: another step's work may be queued or running there. */
async function liveInSession(prisma: PrismaClient, sessionId: string): Promise<number> {
  return prisma.nodeRun.count({ where: { sessionId, reportedAt: null } });
}

/** The session this step's work continues, if any: its own (repair, retest), or its node's latest build or writing in this plan. */
async function sessionFor(prisma: PrismaClient, data: PlanData, step: PlanStep, reason: AttemptReason): Promise<string | null> {
  const latest = (stepIds: string[]) =>
    prisma.nodeRun.findFirst({ where: { planId: data.missionId, planStep: { in: stepIds }, nodeId: step.nodeId, sessionId: { not: null } }, orderBy: { createdAt: "desc" }, select: { sessionId: true } });
  if (reason === "repair" || reason === "retest") return (await latest([step.id]))?.sessionId ?? null;
  if (step.kind === "verify") return null;
  // Builds that work apart (B13) each have their own worktree, so their own session; so does their integration.
  if (parallelMode(data.constraints) !== "serial") return null;
  const mine = data.steps.filter((row) => row.id !== step.id && row.nodeId === step.nodeId && (row.kind === "build" || row.kind === "write")).map((row) => row.id);
  const session = mine.length ? ((await latest(mine))?.sessionId ?? null) : null;
  // Another step's work still goes on there: a session of its own, so each result is its own step's.
  return session && !(await liveInSession(prisma, session)) ? session : null;
}

/** This attempt was already handed over (a redelivered outbox row): a run or a held card made since it started. */
async function alreadyDispatched(prisma: PrismaClient, data: PlanData, step: PlanStep): Promise<boolean> {
  const since = step.attempts.find((row) => row.n === step.attempt)?.startedAt;
  const after = since ? new Date(since) : new Date(0);
  const runs = await prisma.nodeRun.count({ where: { planId: data.missionId, planStep: step.id, createdAt: { gte: after } } });
  if (runs) return true;
  const cards = await prisma.nodeMessage.count({
    where: { kind: "approval", createdAt: { gte: after }, AND: [{ data: { path: ["plan", "id"], equals: data.missionId } }, { data: { path: ["plan", "step"], equals: step.id } }, { data: { path: ["type"], equals: "session" } }] },
  });
  return cards > 0;
}

function why(error: unknown): string {
  if (error instanceof ToolBlockedError) return [error.message, error.remedy].filter(Boolean).join(" ");
  return error instanceof Error ? error.message : String(error);
}

async function envFor(app: FastifyInstance, node: NodeAgent, roomId: string, planId: string, stepId: string): Promise<SessionEnv | null> {
  const prisma = app.prisma;
  const [room, card] = await Promise.all([prisma.nodeRoom.findUnique({ where: { id: roomId } }), prisma.nodeMessage.findUnique({ where: { id: planId }, select: { visibleTo: true } })]);
  if (!room) return null;
  return {
    ctx: await ownerContext(app, node.userId),
    prisma,
    app,
    node,
    room,
    lineage: { rootMessageId: null, botDepth: 0, fromNonOwner: false },
    privateTo: card?.visibleTo.length ? card.visibleTo : null,
    plan: { planId, planStep: stepId },
    via: "chat",
  };
}

export async function noteTold(prisma: PrismaClient, jobId: unknown, told: string): Promise<void> {
  if (typeof jobId !== "string") return;
  const run = await prisma.nodeRun.findFirst({ where: { jobId }, select: { messageId: true } });
  const card = run?.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
  if (card) await updateMessageData(prisma, card, { told });
}

/**
 * Hands a step straight to a coding agent. Null: not a step for direct dispatch (its node takes the
 * turn). `done: false`: the hand-over failed, and its node takes the turn with why.
 */
export async function dispatchStep(app: FastifyInstance, data: PlanData, step: PlanStep, reason: AttemptReason, planRoomId: string): Promise<Dispatch | null> {
  if (!dispatchable(data, step, reason)) return null;
  const prisma = app.prisma;
  const node = await prisma.nodeAgent.findUnique({ where: { id: step.nodeId } });
  // A paused or deleted node: the turn path ends the step as it always has.
  if (!node || node.status !== "active") return null;
  if (await alreadyDispatched(prisma, data, step)) return { done: true, summary: "Already handed over." };
  const env = await envFor(app, node, planRoomId, data.missionId, step.id);
  if (!env) return null;
  const owner = await prisma.user.findUnique({ where: { id: node.userId }, select: { name: true } });
  const origin = nodeWebOrigin();

  const constraints = data.constraints;
  const continuing = await sessionFor(prisma, data, step, reason);
  let place: Place = {};
  let located: Located | null = null;
  if (!continuing) {
    const found = await placeFor(prisma, node.userId, constraints);
    if ("why" in found) return { done: false, why: found.why };
    place = found.place;
    located = found.located;
  } else if (constraints.folder) {
    located = await sessionPlace(prisma, continuing);
  }
  // Where it works on the computer (B13): the folder's checkout or its own worktree, held so no other step changes it meanwhile.
  const placed = await placeStep(app, { userId: node.userId, data, step, reason, located });
  if (placed.wait !== null) {
    await stepProgress(prisma, data.missionId, step.id, placed.wait);
    return { done: true, summary: placed.wait };
  }
  // The session adds the applied run settings itself (node/settings.ts), so the packet does not repeat them.
  const packet = compilePacket(data, step, reason, { ownerName: owner?.name || "your owner", node: { name: node.name, handle: node.slug, role: node.role }, planUrl: origin ? `${origin}/r/${data.originRoomId}` : null, place: placed.place });
  const startInput = () => StartInput.parse({ title: packet.title, prompt: packet.prompt, ...place });
  const call: SessionCall = continuing ? { action: "send", input: SendInput.parse({ session: continuing, prompt: packet.prompt, title: packet.title, delivery: "queue" }) } : { action: "start", input: startInput() };
  try {
    if (computerWorkAsks(node)) {
      // The card keeps the packet, so the run it starts once approved shows what the agent was told.
      await holdForOwner(env, call, { told: packet.prompt });
      await stepProgress(prisma, data.missionId, step.id, "Waiting for your approval to start the agent.");
      return { done: true, summary: "Waiting for approval." };
    }
    let started: Started;
    try {
      started = call.action === "start" ? await startSession(env, call.input) : await sendToSession(env, call.input);
    } catch (error) {
      // The session it would continue cannot go on (gone, or its computer too old): a new one in the
      // mission's place, found as for a first attempt; with no such place its node decides.
      if (call.action !== "send") throw error;
      const found = await placeFor(prisma, node.userId, constraints);
      if ("why" in found) return { done: false, why: `${why(error)} ${found.why}` };
      place = found.place;
      started = await startSession(env, startInput());
    }
    await noteTold(prisma, started.data.jobId, packet.prompt);
    await stepProgress(prisma, data.missionId, step.id, started.summary.replace(/ You hear when it ends\.$/, ""));
    return { done: true, summary: started.summary };
  } catch (error) {
    return { done: false, why: truncateText(why(error), 800) };
  }
}

/**
 * A dispatched run ended without its result: the same session is asked once to report (a new run,
 * queued in it). False when that is not possible or was already done; its node then judges.
 */
export async function askForReport(app: FastifyInstance, run: Pick<NodeRun, "nodeId" | "roomId" | "sessionId" | "planId" | "planStep">, title: string | null = null): Promise<boolean> {
  if (!run.sessionId || !run.planId || !run.planStep) return false;
  const prisma = app.prisma;
  // Other work queued or running in the session would come first, and its result could answer this ask.
  if (await liveInSession(prisma, run.sessionId)) return false;
  const node = await prisma.nodeAgent.findUnique({ where: { id: run.nodeId } });
  if (!node || node.status !== "active") return false;
  const env = await envFor(app, node, run.roomId, run.planId, run.planStep);
  if (!env) return false;
  const ask = reportAsk(title);
  try {
    const started = await sendToSession(env, SendInput.parse({ session: run.sessionId, prompt: ask, title: "Report the result", delivery: "queue" }));
    const jobId = started.data.jobId;
    if (typeof jobId === "string") {
      const asked = await prisma.nodeRun.findFirst({ where: { jobId }, select: { messageId: true } });
      const card = asked?.messageId ? await prisma.nodeMessage.findUnique({ where: { id: asked.messageId } }) : null;
      if (card) await updateMessageData(prisma, card, { told: ask, reportAsked: true });
    }
    return true;
  } catch {
    return false;
  }
}
