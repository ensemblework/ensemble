/**
 * The stop path (ensemble-node docs/design B15, extension §3.5; docs/35 §6.4): Stop, or a message that is only
 * "stop" / "stop all", stops work at once without a model, with every child it has going: its turns, its plans
 * and their steps, the agent runs it started, its helpers' work, a desktop recording it has going (discarded on
 * its computer) and the commands it left running on a computer. "stop" stops what this conversation started;
 * "stop all" stops everything the owner's nodes here do, in every room. What is done stays done; late results
 * are fenced (their cards go quiet, a stopped command's end wakes nobody). Each node's stop is recorded as a
 * steering (kind `stop`, node/steering.ts) with the children it stopped.
 *
 * An interrupt or a replacement from the composer (`steerConversation`) stops one conversation's turn the same
 * way; a replacement also stops what that conversation started, or keeps it on purpose and says so.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeRoom } from "@prisma/client";
import { abortAssistantTurn } from "../assistant/agent.js";
import { stopJob } from "../workspace/worker.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { deviceOnline } from "../devices/constants.js";
import { quietRun, runningToolRuns, stopRunOnComputer } from "../devices/tool-runs.js";
import { DESKTOP_API } from "../remote/contract.js";
import { inBackground, interruptTurns, laneFor, liveTurnsIn, stopTurns } from "./queue.js";
import { LIVE_MISSIONS, loadPlan, stopPlans } from "./plans.js";
import { updateMessageData } from "./store.js";
import { recordingEnded, recordingsOf, type Recording } from "./recordings.js";
import { recordSteer, steerOperation, type SteerChild, type SteerKind } from "./steering.js";

const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval"];

/** A message that is only a stop command: "stop", "stop all", "stop everything", optionally with "/" or punctuation. */
export function stopCommand(text: string): "room" | "all" | null {
  const match = /^\/?\s*stop(?:\s+(all|everything|it all))?\s*[.!]*\s*$/i.exec(text.trim());
  if (!match) return null;
  return match[1] ? "all" : "room";
}

export type Stopped = { turns: number; plans: number; runs: number; helpers: number; recordings: number; commands: number };

type Redisish = Parameters<typeof recordingsOf>[0] & Parameters<typeof runningToolRuns>[0];
const redisOf = (app: FastifyInstance) => app.redis as unknown as Redisish;

/** What one node's work has going in a room (null: anywhere): the children a stop stops and a replacement stops or keeps. */
type Held = {
  plans: Array<{ id: string; goal: string | null }>;
  runs: Array<{ jobId: string; messageId: string | null; prompt: string | null }>;
  helpers: Array<{ id: string; slug: string }>;
  recordings: Recording[];
  commands: Array<{ runId: string; deviceId: string; command: string }>;
};

/** The helpers a node made (from this room, or anywhere): their work is its children's. */
async function helpersOf(app: FastifyInstance, nodeId: string, roomId: string | null): Promise<Array<{ id: string; slug: string }>> {
  const helpers = await app.prisma.nodeAgent.findMany({ where: { parentNodeId: nodeId }, select: { id: true, slug: true } });
  if (roomId === null || !helpers.length) return helpers;
  const rooms = await app.prisma.nodeRoom.findMany({ where: { kind: "task", members: { some: { nodeId: { in: helpers.map((row) => row.id) } } } }, select: { settings: true, members: { select: { nodeId: true } } } });
  return helpers.filter((helper) => rooms.some((room) => (room.settings as { originRoomId?: unknown } | null)?.originRoomId === roomId && room.members.some((row) => row.nodeId === helper.id)));
}

/** Agent runs of these nodes (in a room, or anywhere) still going on their computers and not asked to stop yet. */
async function liveRuns(app: FastifyInstance, nodeIds: readonly string[], roomId: string | null): Promise<Held["runs"]> {
  const runs = await app.prisma.nodeRun.findMany({ where: { nodeId: { in: [...nodeIds] }, reportedAt: null, ...(roomId ? { roomId } : {}) }, select: { jobId: true, messageId: true, prompt: true } });
  const live = runs.length ? await app.prisma.workspaceJob.findMany({ where: { id: { in: runs.map((row) => row.jobId) }, status: { in: LIVE_JOB as never }, cancelRequestedAt: null }, select: { id: true } }) : [];
  return runs.filter((row) => live.some((job) => job.id === row.jobId));
}

async function heldBy(app: FastifyInstance, accountId: string, nodeId: string, roomId: string | null): Promise<Held> {
  const plans = await app.prisma.nodeMission.findMany({ where: { userId: accountId, leadNodeId: nodeId, status: { in: [...LIVE_MISSIONS] }, ...(roomId ? { originRoomId: roomId } : {}) }, select: { id: true, goal: true } });
  const missions = new Set([...plans.map((row) => row.id), ...(roomId ? [`conversation:${roomId}:private`, `conversation:${roomId}:shared`] : [])]);
  const recordings = (await recordingsOf(redisOf(app), nodeId)).filter((row) => roomId === null || missions.has(row.mission));
  const commands = (await runningToolRuns(redisOf(app), nodeId)).filter(({ run }) => roomId === null || run.roomId === roomId || (run.planId !== null && missions.has(run.planId)));
  return {
    plans,
    runs: await liveRuns(app, [nodeId], roomId),
    helpers: await helpersOf(app, nodeId, roomId),
    recordings,
    commands: commands.map(({ runId, run }) => ({ runId, deviceId: run.deviceId, command: run.command })),
  };
}

const short = (text: string | null | undefined, max = 80) => (text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined);

/**
 * Results the steps of these (stopped) plans reported that no turn of their lead carried yet (node/plans.ts
 * `beginPlanTurn` marks what a report turn carries): what was done stays, and the lead hears it once, here.
 */
async function uncarriedResults(app: FastifyInstance, planIds: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const planId of planIds) {
    const plan = await loadPlan(app.prisma, planId);
    for (const step of plan?.data.steps ?? []) {
      for (const attempt of step.attempts) {
        const said = (attempt.summary ?? step.result ?? "").replace(/\s+/g, " ").trim();
        if (attempt.reportedAt && !attempt.deliveredAt && said) lines.push(`@${step.handle}: ${short(said, 300)}`);
      }
    }
  }
  return lines;
}

/** The children as a steering record lists them. */
function childList(held: Held, turns: readonly string[]): SteerChild[] {
  return [
    ...turns.map((id) => ({ kind: "turn" as const, id })),
    ...held.plans.map((row) => ({ kind: "plan" as const, id: row.id, ...(row.goal ? { title: short(row.goal) } : {}) })),
    ...held.runs.map((row) => ({ kind: "run" as const, id: row.jobId, ...(row.prompt ? { title: short(row.prompt) } : {}) })),
    ...held.helpers.map((row) => ({ kind: "helper" as const, id: row.id, title: `@${row.slug}` })),
    ...held.recordings.map((row) => ({ kind: "recording" as const, id: `${row.deviceId}:${row.mission}`, title: "screen recording" })),
    ...held.commands.map((row) => ({ kind: "command" as const, id: row.runId, title: short(row.command) })),
  ];
}

/** Agent runs stop on their computers; their cards go quiet, so their ends wake nobody. */
async function stopRuns(app: FastifyInstance, accountId: string, runs: Held["runs"]): Promise<void> {
  for (const run of runs) {
    await stopJob(app, accountId, run.jobId);
    const card = run.messageId ? await app.prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
    if (card && typeof (card.data as { quiet?: unknown }).quiet !== "string") await updateMessageData(app.prisma, card, { quiet: "stopped" });
  }
}

/** A recording going on is discarded on its computer, in the background (a computer that does not answer keeps it listed). */
function discardRecordings(app: FastifyInstance, nodeId: string, recordings: readonly Recording[]): void {
  if (!recordings.length) return;
  inBackground(app, async () => {
    for (const where of recordings) {
      const device = await app.prisma.device.findUnique({ where: { id: where.deviceId }, select: { lastSeenAt: true, capabilities: true, revokedAt: true } });
      const level = (device?.capabilities as { desktop?: unknown } | null)?.desktop;
      if (!device || device.revokedAt || !(typeof level === "number" && level >= DESKTOP_API)) {
        await recordingEnded(redisOf(app), nodeId, where);
        continue;
      }
      if (!deviceOnline(device.lastSeenAt)) continue;
      const data = { tool: "desktop", name: "desktop_record", input: { action: "discard" }, operation: `node:${nodeId}:own`, inlineImage: false, nodeId, mission: where.mission, attended: true, grants: [] };
      if (await askDeviceFor(app.redis as never, { deviceId: where.deviceId, event: "node.tool.request", data }, 20_000)) await recordingEnded(redisOf(app), nodeId, where);
    }
  });
}

/** Commands left running stop on their computers; their ends wake nobody. */
async function stopCommands(app: FastifyInstance, nodeId: string, commands: Held["commands"]): Promise<void> {
  for (const command of commands) {
    await quietRun(app.redis as never, command.runId, "stopped");
    const device = await app.prisma.device.findUnique({ where: { id: command.deviceId } });
    if (device) await stopRunOnComputer(app, device, nodeId, command.runId).catch((error: unknown) => app.log.warn({ err: error }, "Could not stop a node's command"));
  }
}

/** Stops a node's helpers' work (their turns, plans, runs, recordings and commands): what they did stays. */
async function stopHelpers(app: FastifyInstance, accountId: string, helpers: Held["helpers"]): Promise<void> {
  for (const helper of helpers) {
    await stopTurns(app, [helper.id], null);
    await stopPlans(app, { nodeId: helper.id, userId: accountId });
    const held = await heldBy(app, accountId, helper.id, null);
    await stopRuns(app, accountId, await liveRuns(app, [helper.id], null));
    discardRecordings(app, helper.id, held.recordings);
    await stopCommands(app, helper.id, held.commands);
  }
}

export async function stopWork(app: FastifyInstance, room: NodeRoom, accountId: string, scope: "room" | "all"): Promise<Stopped> {
  const prisma = app.prisma;
  const mine = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } } });
  const nodeIds = mine.map((row) => row.nodeId!);
  const roomId = scope === "all" ? null : room.id;
  // What each node has going, read before anything stops, for its record.
  const held = new Map<string, Held>();
  for (const nodeId of nodeIds) held.set(nodeId, await heldBy(app, accountId, nodeId, roomId));
  const running = liveTurnsIn(nodeIds, { roomId });
  const memberships = scope === "all" ? await prisma.nodeRoomMember.findMany({ where: { nodeId: { in: nodeIds } } }) : mine;
  for (const member of memberships) {
    for (const conversationId of [member.conversationId, member.privateConversationId]) if (conversationId) abortAssistantTurn(conversationId);
  }
  let plans = 0;
  if (scope === "all") for (const nodeId of nodeIds) plans += await stopPlans(app, { nodeId, userId: accountId });
  else plans += await stopPlans(app, { roomId: room.id, userId: accountId });
  // Runs its plans had are stopped with them; the rest stop here.
  const runs = await liveRuns(app, nodeIds, roomId);
  await stopRuns(app, accountId, runs);
  const turns = await stopTurns(app, nodeIds, roomId);
  let helpers = 0;
  let recordings = 0;
  let commands = 0;
  for (const [nodeId, children] of held) {
    await stopHelpers(app, accountId, children.helpers);
    discardRecordings(app, nodeId, children.recordings);
    await stopCommands(app, nodeId, children.commands);
    helpers += children.helpers.length;
    recordings += children.recordings.length;
    commands += children.commands.length;
    const own = running.filter((row) => row.nodeId === nodeId);
    await recordSteer(app, {
      userId: accountId,
      nodeId,
      roomId: room.id,
      turnId: own[0]?.turnId ?? null,
      kind: "stop",
      target: "conversation",
      targetId: roomId ?? "all",
      operation: "stop",
      worker: { state: own.length ? "running" : "idle", acted: own.some((row) => row.acted), canSteer: false },
      outcome: "done",
      children: { stopped: childList(children, own.map((row) => row.turnId)) },
    });
  }
  return { turns, plans, runs: runs.length, helpers, recordings, commands };
}

/** What the owner reads after a stop: "Stopped 1 plan and 2 agent runs. What was already done stays." */
export function stoppedLine(stopped: Stopped): string {
  const parts = [
    stopped.plans ? `${stopped.plans} plan${stopped.plans === 1 ? "" : "s"}` : "",
    stopped.runs ? `${stopped.runs} agent run${stopped.runs === 1 ? "" : "s"}` : "",
    stopped.helpers ? `the work of ${stopped.helpers} helper${stopped.helpers === 1 ? "" : "s"}` : "",
    stopped.recordings ? `${stopped.recordings} screen recording${stopped.recordings === 1 ? "" : "s"}` : "",
    stopped.commands ? `${stopped.commands} command${stopped.commands === 1 ? "" : "s"} on a computer` : "",
    stopped.turns && !stopped.plans && !stopped.runs && !stopped.helpers && !stopped.recordings && !stopped.commands ? "the reply in progress" : "",
  ].filter(Boolean);
  if (!parts.length) return "Nothing was running.";
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return `Stopped ${listed}. What was already done stays.`;
}

/**
 * An interrupt or a replacement sent with the owner's message (POST /api/node/rooms/:id/messages `steering`,
 * node/steering.ts), before the message is routed: the turn its nodes have going in this conversation stops
 * (an interrupt keeps everything else going). A replacement also stops what those nodes started in this room
 * (`children: "stop"`) or keeps it on purpose (`"keep"`); either way each node's record lists it. Returns the
 * note for the turns the message wakes, or undefined when there is nothing to tell.
 */
export async function steerConversation(
  app: FastifyInstance,
  input: { room: NodeRoom; accountId: string; message: NodeMessage; kind: "interrupt" | "replace"; children: "stop" | "keep" },
): Promise<string | undefined> {
  const { room, accountId, message } = input;
  const mine = await app.prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } }, select: { nodeId: true } });
  const named = new Set((Array.isArray(message.mentions) ? (message.mentions as Array<{ kind?: unknown; id?: unknown }>) : []).filter((row) => row.kind === "node").map((row) => String(row.id)));
  const ids = mine.map((row) => row.nodeId!);
  // The nodes it names, else all of the owner's nodes here.
  const nodeIds = ids.some((id) => named.has(id)) ? ids.filter((id) => named.has(id)) : ids;
  const lane = laneFor({ roomId: room.id, private: message.visibleTo.length > 0 });
  // A plan's turn and others bound to bookkeeping are never stopped by a message: they finish, and it comes next.
  const before = liveTurnsIn(nodeIds, { lane }).filter((row) => row.interruptible);
  const stoppedTurns = interruptTurns(nodeIds, lane, input.kind);
  const kind: SteerKind = input.kind === "interrupt" ? "interrupt" : "replacement";
  const lines: string[] = [];
  for (const nodeId of nodeIds) {
    const own = before.filter((row) => row.nodeId === nodeId);
    const worker = { state: own.length ? ("running" as const) : ("idle" as const), acted: own.some((row) => row.acted), canSteer: own.some((row) => row.steerable) };
    const turns = stoppedTurns.filter((row) => row.nodeId === nodeId).map((row) => row.turnId);
    let children: { stopped?: SteerChild[]; kept?: SteerChild[] } = turns.length ? { stopped: turns.map((id) => ({ kind: "turn" as const, id })) } : {};
    if (kind === "replacement") {
      const held = await heldBy(app, accountId, nodeId, room.id);
      const listed = childList(held, []);
      if (input.children === "stop") {
        for (const plan of held.plans) await stopPlans(app, { planId: plan.id, userId: accountId });
        await stopRuns(app, accountId, await liveRuns(app, [nodeId], room.id));
        await stopHelpers(app, accountId, held.helpers);
        discardRecordings(app, nodeId, held.recordings);
        await stopCommands(app, nodeId, held.commands);
        children = { stopped: [...(children.stopped ?? []), ...listed] };
        if (listed.length) lines.push(`Stopped for it: ${listed.map((child) => child.title ?? child.kind).join("; ")}.`);
        const results = await uncarriedResults(app, held.plans.map((plan) => plan.id));
        if (results.length) lines.push(`Done before the stop, and kept (you had not been told yet):\n${results.map((line) => `- ${line}`).join("\n")}`);
      } else {
        children = { ...children, kept: listed };
        if (listed.length) lines.push(`Still going, kept on purpose: ${listed.map((child) => `${child.title ?? child.kind} (${child.kind} ${child.id})`).join("; ")}. Use what fits the new work and stop the rest.`);
      }
    }
    await recordSteer(app, {
      userId: accountId,
      nodeId,
      roomId: room.id,
      turnId: turns[0] ?? null,
      kind,
      target: "conversation",
      targetId: lane,
      operation: steerOperation(kind, worker),
      worker,
      messageId: message.id,
      outcome: "done",
      children,
    });
  }
  const head =
    kind === "replacement"
      ? "Your owner replaced what you were doing here with this message: it is new work. Do not go on with the old work."
      : before.length
        ? "Your owner's new message stopped your turn going on. Go on from what it did, with this message."
        : "";
  return [head, ...[...new Set(lines)]].filter(Boolean).join("\n") || undefined;
}
