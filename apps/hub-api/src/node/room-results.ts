/**
 * Results into the room and onto the board (docs/35 §12.13; ensemble-node design C6, extension §17.1 and
 * §19 steps 7–8). When a mission whose result goes to a room ends, code (no model) delivers it, once:
 *
 *   - Onto the board. Its checked evidence becomes files of the room's space tagged with the task, and the
 *     task's page gets a short Result section: how it ended, its requirements, a review's checks, the files.
 *     Work done for the person it is with moves their task to Done, unless they close tasks themselves. A
 *     review's result goes on the requester's task, which stays theirs to move.
 *   - Into the room. The lead posts the result with its media, built from the mission's ledger and its
 *     evidence only, never from the lead's private report. It is always the owner's draft (Post this for
 *     you?): it comes from owner-wide work, and only a room-bound reply ever posts at once.
 *
 * Accepting the request (or starting the room's task) is the owner's yes to delivering the result to the
 * task; the room post is a second, separate yes. Both people must still be in the room, and the owner must
 * still be able to edit the space.
 *
 * Also here: starting a room task from My crew (the Start button, or the owner's yes to their lead's offer),
 * whose mission is linked to the task by `roomTaskOrigin` (called from `missionOriginFor`).
 */
import type { FastifyInstance } from "fastify";
import type { NodeMission, NodeRoom, Prisma, PrismaClient, Task } from "@prisma/client";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { missionEnded } from "./missions-core.js";
import { missionMedia, type Media } from "./media.js";
import { loadPlan } from "./plans.js";
import { enqueueTurn } from "./queue.js";
import { boundSpaceId, roleIn } from "./room-space.js";
import { personIn, postMessage } from "./store.js";
import { personRow, prefsOf } from "./trust.js";

type Db = PrismaClient | Prisma.TransactionClient;

export class RoomResultError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
  }
}

type DeliverTo = { roomId?: unknown; audience?: unknown; taskId?: unknown; deliveredAt?: unknown };
const RUNNING = ["draft", "running", "reporting"];

async function spaceOwnerOf(db: Db, spaceId: string): Promise<string | null> {
  const row = await db.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
  return row ? (row.ownerId ?? row.id) : null;
}

/** Who a task is with: the space's owner for their own "me" tasks, else its assignee account. */
const holderOf = (task: Pick<Task, "owner" | "assigneeAccountId">, owner: string) => (task.owner === "me" ? (task.assigneeAccountId ?? owner) : null);

/** Moves a task by code, and tells the rooms following the space it was not news (the room's post is). */
async function moveTask(app: FastifyInstance, task: Task, status: "in_progress" | "done", reason: string): Promise<void> {
  const prisma = app.prisma;
  const moved = await prisma.task.updateMany({ where: { id: task.id, status: task.status }, data: { status, ...(status === "done" ? { completedAt: new Date() } : {}) } });
  if (!moved.count) return;
  const fresh = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  await prisma.taskTransition.create({ data: { userId: task.userId, taskId: task.id, fromStatus: task.status, toStatus: status, actor: "agent", reason } });
  await prisma.nodeRoomTask.updateMany({ where: { taskId: task.id }, data: { status, taskUpdatedAt: fresh.updatedAt } });
  sseHub.publish(task.userId, { event: "task", data: { id: task.id, action: "update" } });
}

// ── starting a room task ────────────────────────────────────────────────────────────────────

/**
 * The person a room-space task is with starts it from My crew (the Start button on their lead's
 * message): one private turn of their lead plans it; its mission delivers to the task and the room.
 */
export async function startRoomTask(app: FastifyInstance, room: NodeRoom, accountId: string, taskId: string, mode: "private" | "shared"): Promise<void> {
  const prisma = app.prisma;
  const spaceId = boundSpaceId(room);
  if (!spaceId) throw new RoomResultError("This room has no shared space.", 404);
  const role = await roleIn(accountId, spaceId);
  if (role !== "owner" && role !== "editor") throw new RoomResultError("Join the room's space as an editor first.", 403);
  const task = await prisma.task.findFirst({ where: { id: taskId, userId: spaceId, deletedAt: null } });
  const owner = await spaceOwnerOf(prisma, spaceId);
  if (!task || !owner) throw new RoomResultError("That task is not on the room's board.", 404);
  if (holderOf(task, owner) !== accountId) throw new RoomResultError("Only the person the task is with starts it.", 403);
  if (task.peerRequestId) throw new RoomResultError("This task came from a request: accept the request instead.", 409);
  if (["done", "dropped"].includes(task.status)) throw new RoomResultError("That task is finished.", 409);
  if (await prisma.nodeMission.findFirst({ where: { userId: accountId, status: { in: RUNNING }, deliverTo: { path: ["taskId"], equals: task.id } }, select: { id: true } })) {
    throw new RoomResultError("Work on that task is already going.", 409);
  }
  const lead = await prisma.nodeRoomMember.findFirst({ where: { roomId: room.id, userId: accountId, nodeId: { not: null }, representative: true } });
  if (!lead?.nodeId) throw new RoomResultError("Bring a node to this room first.", 409);
  const space = await prisma.user.findUnique({ where: { id: spaceId }, select: { spaceName: true } });
  const note =
    `Your owner asked you to start the room's task “${task.title}” (on the board of “${space?.spaceName ?? "the room's space"}”). ` +
    (mode === "shared"
      ? `Work in that space (name it as the space in Ensemble calls), where its members see the run. `
      : "Work in your owner's own space as usual; the result is delivered to the task. ") +
    "Plan it now with node_plan for your owner (their nodes, their computer, their credits). When it ends, its result goes to the task and the room; your detailed report stays here with your owner.";
  await enqueueTurn(app, { nodeId: lead.nodeId, roomId: room.id, reason: "request", private: true, audience: "owner", operationId: `room-task:${task.id}:${mode}:${Date.now()}`, note });
}

/**
 * Where a mission made by a lead's private turn in a room delivers, when it is for a task of the room's
 * space held by the lead's owner: the Start button (operation `room-task:<id>:<mode>:…`), or the owner's
 * yes in My crew to their lead's offer to start one assigned task. `{}` otherwise.
 */
export async function roomTaskOrigin(
  db: Db,
  turn: { nodeId: string; roomId: string | null; userId: string; private: boolean; triggerMessageId: string | null },
  operationId: string | null,
): Promise<{ deliverTo?: Prisma.InputJsonValue; principals?: Prisma.InputJsonValue; spaceId?: string }> {
  if (!turn.private || !turn.roomId) return {};
  const room = await db.nodeRoom.findUnique({ where: { id: turn.roomId } });
  const spaceId = room && room.kind === "room" ? boundSpaceId(room) : null;
  if (!spaceId) return {};
  const started = /^room-task:([0-9a-f-]{36}):(private|shared):/.exec(operationId ?? "");
  let taskId = started?.[1] ?? null;
  if (!taskId && turn.triggerMessageId) {
    // The owner's yes, just after (or replying to) their lead's offer to start one task.
    const trigger = await db.nodeMessage.findUnique({ where: { id: turn.triggerMessageId } });
    if (trigger && trigger.authorKind === "human" && trigger.userId === turn.userId && trigger.visibleTo.length === 1 && trigger.visibleTo[0] === turn.userId) {
      const replyTo = (trigger.data as { replyTo?: { id?: unknown } } | null)?.replyTo?.id;
      const offer =
        typeof replyTo === "string"
          ? await db.nodeMessage.findUnique({ where: { id: replyTo } })
          : await db.nodeMessage.findFirst({ where: { roomId: turn.roomId, seq: { lt: trigger.seq }, visibleTo: { equals: [turn.userId] } }, orderBy: { seq: "desc" } });
      const data = offer?.data as { type?: unknown; start?: { taskIds?: unknown } } | null;
      const ids = Array.isArray(data?.start?.taskIds) ? (data!.start!.taskIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
      if (offer && offer.authorNodeId === turn.nodeId && data?.type === "room_events" && ids.length === 1) taskId = ids[0]!;
    }
  }
  if (!taskId) return {};
  const task = await db.task.findFirst({ where: { id: taskId, userId: spaceId, deletedAt: null, status: { notIn: ["done", "dropped"] } } });
  const owner = await spaceOwnerOf(db, spaceId);
  if (!task || !owner || holderOf(task, owner) !== turn.userId || task.peerRequestId) return {};
  const role = await db.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId, accountId: turn.userId } }, select: { role: true } });
  if (owner !== turn.userId && role?.role !== "editor") return {};
  if (await db.nodeMission.findFirst({ where: { userId: turn.userId, status: { in: RUNNING }, deliverTo: { path: ["taskId"], equals: task.id } }, select: { id: true } })) return {};
  const me = turn.userId;
  return {
    deliverTo: { roomId: turn.roomId, audience: "room", taskId: task.id },
    principals: { data: me, billing: me, executionDevice: me, approver: me },
    ...(started?.[2] === "shared" ? { spaceId } : {}),
  };
}

// ── delivering a result ─────────────────────────────────────────────────────────────────────

/** A plan card changed: its mission's task moves to In progress when work starts, and its result is delivered when it ends. */
export async function followMission(app: FastifyInstance, missionId: string): Promise<void> {
  const prisma = app.prisma;
  const mission = await prisma.nodeMission.findUnique({ where: { id: missionId } });
  const to = (mission?.deliverTo ?? null) as DeliverTo | null;
  if (!mission || typeof to?.roomId !== "string" || to.audience !== "room") return;
  if (!missionEnded(mission.status)) {
    if (typeof to.taskId !== "string" || mission.status === "draft") return;
    const task = await prisma.task.findFirst({ where: { id: to.taskId, deletedAt: null } });
    const kind = (mission.requestedBy as { kind?: unknown } | null)?.kind;
    if (task && kind !== "review" && task.status === "todo") await moveTask(app, task, "in_progress", "room task started");
    return;
  }
  if (to.deliveredAt) return;
  // A request's mission waits for node/peer-requests.ts to settle the request (done, or cancelled when someone left).
  const requestId = (mission.requestedBy as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId === "string" && (await prisma.nodePeerRequest.findUnique({ where: { id: requestId }, select: { status: true } }))?.status === "approved") return;
  // Once: the first to mark it delivers.
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE node_missions SET deliver_to = deliver_to || jsonb_build_object('deliveredAt', ${new Date().toISOString()}::text)
    WHERE id = ${mission.id} AND NOT (deliver_to ? 'deliveredAt') RETURNING id`;
  if (!claimed.length) return;
  await deliverResult(app, mission, to.roomId, typeof to.taskId === "string" ? to.taskId : null);
}

/** Missions whose end nobody saw (a restart): delivered on a sweep. */
export async function syncMissionResults(app: FastifyInstance): Promise<void> {
  const rows = await app.prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM node_missions
    WHERE deliver_to IS NOT NULL AND deliver_to->>'audience' = 'room' AND NOT (deliver_to ? 'deliveredAt')
      AND status IN ('succeeded', 'partially_completed', 'failed', 'stopped') AND updated_at > now() - interval '7 days'
    ORDER BY updated_at DESC LIMIT 100`;
  for (const row of rows) await followMission(app, row.id);
}

const OUTCOME_WORDS: Record<string, string> = { succeeded: "is ready", partially_completed: "is partly done", failed: "did not work out", stopped: "was stopped" };
/** Requirement states (node/plans.ts ledger) and check verdicts. */
const MARK: Record<string, string> = { accepted: "✓", pass: "✓", failed: "✗", fail: "✗", deferred: "–", cancelled: "–", blocked: "!", skipped: "–" };

type Ledger = { title: string; outcome: string; verdict: "pass" | "fail" | null; requirements: Array<{ text: string; status: string }>; checks: Array<{ name: string; verdict: string }>; candidate: string | null };

/** What may be said of the mission: its ledger and a review's checks. Nothing from any report's prose. */
async function ledgerOf(db: Db, mission: NodeMission, task: Task | null, requestText: string | null): Promise<Ledger> {
  const plan = await loadPlan(db, mission.id);
  const requirements = (plan?.data.requirements ?? []).map((row) => ({ text: truncateText(row.text, 200), status: row.status }));
  const kind = (mission.requestedBy as { kind?: unknown } | null)?.kind;
  // A review's checks and verdict: what the candidate is, not how the reviewer works, so the requester may read them.
  const steps = kind === "review" ? await db.nodeStep.findMany({ where: { missionId: mission.id }, orderBy: { position: "asc" }, select: { outcome: true, report: true } }) : [];
  const checks = steps
    .flatMap((step) => ((step.report ?? {}) as { checks?: Array<{ name?: unknown; verdict?: unknown }> }).checks ?? [])
    .filter((check) => typeof check.name === "string" && typeof check.verdict === "string")
    .slice(0, 20)
    .map((check) => ({ name: truncateText(String(check.name), 160), verdict: String(check.verdict) }));
  const verdict = kind !== "review" ? null : steps.some((step) => step.outcome === "fail") || checks.some((check) => check.verdict === "fail") || mission.status === "failed" ? "fail" : mission.status === "succeeded" ? "pass" : null;
  const candidate = (mission.requestedBy as { candidate?: { repo?: unknown; commit?: unknown; url?: unknown } } | null)?.candidate;
  const pinned = candidate ? [candidate.repo, candidate.commit ? `at ${candidate.commit}` : "", candidate.url].filter((part) => typeof part === "string" && part).join(" ") : null;
  const title = truncateText((task?.title ?? requestText?.split("\n")[0] ?? mission.goal ?? "The work").trim(), 160);
  return { title, outcome: mission.status, verdict, requirements, checks, candidate: pinned || null };
}

function resultText(ledger: Ledger, taskTitle: string | null): string {
  const head = ledger.verdict
    ? `Review of ${ledger.candidate ?? ledger.title}: ${ledger.verdict}.`
    : `${ledger.title} ${OUTCOME_WORDS[ledger.outcome] ?? `ended (${ledger.outcome.replace(/_/g, " ")})`}.`;
  const lines = [
    ...ledger.requirements.slice(0, 8).map((row) => `- ${MARK[row.status] ?? "·"} ${row.text}`),
    ...ledger.checks.slice(0, 8).map((row) => `- ${MARK[row.verdict] ?? "·"} ${row.name}`),
  ];
  return [head, ...lines, ...(taskTitle ? [`Task: “${taskTitle}”`] : [])].join("\n");
}

/** The result onto the board, then into the room. */
async function deliverResult(app: FastifyInstance, mission: NodeMission, roomId: string, taskId: string | null): Promise<void> {
  const prisma = app.prisma;
  const owner = mission.userId;
  const room = await prisma.nodeRoom.findUnique({ where: { id: roomId } });
  if (!room || room.archivedAt || !(await personIn(prisma, roomId, owner))) return;
  const requestId = (mission.requestedBy as { requestId?: unknown } | null)?.requestId;
  const request = typeof requestId === "string" ? await prisma.nodePeerRequest.findUnique({ where: { id: requestId } }) : null;
  // A request delivers only when both people are still there (node/peer-requests.ts marks it done, or cancelled).
  if (request && request.status !== "done") return;
  const spaceId = boundSpaceId(room);
  const task = taskId && spaceId ? await prisma.task.findFirst({ where: { id: taskId, userId: spaceId, deletedAt: null } }) : null;
  const ledger = await ledgerOf(prisma, mission, task, request?.text ?? null);
  const media = await missionMedia(prisma, mission.id, owner);
  let files: Array<{ id: string; name: string }> = [];
  if (task && spaceId && ["owner", "editor"].includes((await roleIn(owner, spaceId)) ?? "")) {
    files = await attachEvidence(app, spaceId, task, media);
    await resultOnTask(app, spaceId, task, ledger, files, owner);
    const spaceOwner = await spaceOwnerOf(prisma, spaceId);
    const holder = spaceOwner ? holderOf(task, spaceOwner) : null;
    const member = await personRow(prisma, roomId, owner);
    // Work for the person it is with closes their task, unless they close tasks themselves. A review leaves the requester's task to them.
    if (holder === owner && request?.kind !== "review" && mission.status === "succeeded" && prefsOf(member).closeTasks !== "me" && !["done", "dropped"].includes(task.status)) {
      await moveTask(app, task, "done", "room result delivered");
    }
  }
  await postResult(app, room, mission, ledger, media, task, request?.id ?? null, files);
}

/** The mission's checked evidence, as files of the room's space tagged with the task. */
async function attachEvidence(app: FastifyInstance, spaceId: string, task: Task, media: Media[]): Promise<Array<{ id: string; name: string }>> {
  const prisma = app.prisma;
  const { evidenceContent } = await import("../evidence/store.js");
  const { saveFile } = await import("../files/store.js");
  const out: Array<{ id: string; name: string }> = [];
  for (const item of media) {
    const row = await prisma.jobEvidence.findUnique({ where: { id: item.evidenceId } });
    if (!row || row.local) continue;
    try {
      const bytes = await evidenceContent(row);
      const file = await saveFile(prisma, spaceId, { filename: row.name, mediaType: row.mime, bytes: new Uint8Array(bytes) }, { summarize: false, tags: { taskIds: [task.id] } });
      out.push({ id: file.id, name: file.filename });
    } catch (error) {
      // A hosted file cap, or bytes gone: the room still sees the media.
      app.log.warn({ err: error, evidenceId: item.evidenceId }, "Could not attach evidence to the room's task");
    }
  }
  return out;
}

/** A short Result section at the end of the task's page. */
async function resultOnTask(app: FastifyInstance, spaceId: string, task: Task, ledger: Ledger, files: Array<{ id: string; name: string }>, owner: string): Promise<void> {
  const prisma = app.prisma;
  const who = await prisma.user.findUnique({ where: { id: owner }, select: { name: true, email: true } });
  const name = who?.name?.trim() || who?.email.split("@")[0] || "Someone";
  const head = ledger.verdict ? `Review by ${name}: ${ledger.verdict}${ledger.candidate ? ` (${ledger.candidate})` : ""}` : `Result from ${name}: ${ledger.outcome.replace(/_/g, " ")}`;
  const markdown = [
    `## ${head}`,
    ...ledger.requirements.map((row) => `- ${MARK[row.status] ?? "·"} ${row.text}`),
    ...ledger.checks.map((row) => `- ${MARK[row.verdict] ?? "·"} ${row.name}`),
    ...(files.length ? ["", ...files.map((file) => `[@${file.name}](ensemble://file/${file.id})`)] : []),
  ].join("\n");
  const { appendToTaskPage } = await import("../assistant/tools/pages.js");
  await prisma.$transaction((tx) => appendToTaskPage(tx, spaceId, task.id, markdown));
}

/** The lead's post in the room, as the owner's draft. */
async function postResult(app: FastifyInstance, room: NodeRoom, mission: NodeMission, ledger: Ledger, media: Media[], task: Task | null, requestId: string | null, files: Array<{ id: string; name: string }>): Promise<void> {
  const prisma = app.prisma;
  const lead = await prisma.nodeAgent.findUnique({ where: { id: mission.leadNodeId } });
  if (!lead || lead.userId !== mission.userId) return;
  const result = {
    missionId: mission.id,
    ...(requestId ? { requestId } : {}),
    ...(task ? { taskId: task.id, spaceId: task.userId } : {}),
    outcome: mission.status,
    ...(ledger.verdict ? { verdict: ledger.verdict } : {}),
    requirements: ledger.requirements,
    ...(ledger.checks.length ? { checks: ledger.checks } : {}),
    files: files.length,
  };
  const refs = task ? [{ kind: "task", id: task.id, spaceId: task.userId, title: task.title }] : [];
  const body = resultText(ledger, task?.title ?? null);
  // Only a room-bound turn's own reply ever posts straight into a room with other people (node/tools.ts
  // postAsNode): this result came from owner-wide work, so it is always the owner's draft.
  await postMessage(prisma, {
    roomId: room.id,
    userId: lead.userId,
    authorKind: "node",
    authorNodeId: lead.id,
    kind: "approval",
    body,
    data: { type: "post", status: "pending", result, ...(media.length ? { media } : {}), ...(refs.length ? { refs } : {}) },
    visibleTo: [lead.userId],
    clientId: `room-result-draft:${mission.id}`,
  });
}

/** The owner posted their lead's result draft: the post says it is a result, for the site and the digest. */
export async function resultPosted(app: FastifyInstance, draft: { data: unknown }, posted: { id: string; data: unknown }): Promise<void> {
  const result = (draft.data as { result?: unknown } | null)?.result;
  if (!result || typeof result !== "object") return;
  const { updateMessageData } = await import("./store.js");
  const message = await app.prisma.nodeMessage.findUnique({ where: { id: posted.id } });
  if (message) await updateMessageData(app.prisma, message, { type: "room_result", ...(result as Record<string, unknown>) });
}
