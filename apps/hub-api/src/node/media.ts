/**
 * Media in the conversation (ensemble-node docs/design B20, extension §8.5): a node's message can carry
 * the screenshots, videos and files its owner's runs attached (evidence): the owner's own, uploaded (not
 * kept on the computer). A mission's report brings the media of the steps that were done or passed, so
 * what reaches the chat was checked first. Reading a file follows the message: whoever may read a
 * message that shows it may open it; anyone else, only its owner.
 */
import type { NodeMessage, PrismaClient } from "@prisma/client";
import { canSee } from "./store.js";

export type Media = { evidenceId: string; kind: string; name: string; mime: string; caption: string | null; size: number };

/** At most this many files on one message. */
export const MAX_MEDIA = 8;
const SHOWN_KINDS = new Set(["screenshot", "image", "video"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pending = new Map<string, Media[]>();

/** Files a turn attached to its reply (node_show), shown when the reply is posted. */
export function attachToTurn(turnId: string, items: readonly Media[]): number {
  const list = pending.get(turnId) ?? [];
  for (const item of items) if (!list.some((row) => row.evidenceId === item.evidenceId) && list.length < MAX_MEDIA) list.push(item);
  pending.set(turnId, list);
  return list.length;
}

export function takeTurnMedia(turnId: string): Media[] {
  const list = pending.get(turnId) ?? [];
  pending.delete(turnId);
  return list;
}

type EvidenceRow = { id: string; kind: string; name: string; mime: string; caption: string | null; size: number; local: boolean };
const toMedia = (row: EvidenceRow, caption?: string | null): Media => ({ evidenceId: row.id, kind: row.kind, name: row.name, mime: row.mime, caption: caption ?? row.caption, size: row.size });

/** The owner's own uploaded evidence for these ids, with why any other cannot be shown. */
export async function ownerMedia(prisma: PrismaClient, ownerId: string, ids: readonly string[]): Promise<{ media: Media[]; problems: string[] }> {
  const wanted = [...new Set(ids.map((id) => id.trim()))];
  const rows = await prisma.jobEvidence.findMany({
    where: { id: { in: wanted.filter((id) => UUID.test(id)) }, userId: ownerId },
    select: { id: true, kind: true, name: true, mime: true, caption: true, size: true, local: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const media: Media[] = [];
  const problems: string[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) problems.push(`${id}: not a file your owner's runs attached`);
    else if (row.local) problems.push(`${row.name}: kept on the computer (evidence upload is off there)`);
    else media.push(toMedia(row));
  }
  return { media: media.slice(0, MAX_MEDIA), problems };
}

/**
 * What a mission's report shows: from each step that was done or passed, the files its worker named in
 * its report, then the screenshots and videos its runs attached; videos and screenshots first.
 */
export async function missionMedia(prisma: PrismaClient, missionId: string, ownerId: string, limit = 6): Promise<Media[]> {
  const steps = await prisma.nodeStep.findMany({ where: { missionId, outcome: { in: ["done", "pass"] } }, select: { id: true, report: true, startedAt: true } });
  if (!steps.length) return [];
  const named = new Map<string, string | null>();
  for (const step of steps) {
    const report = (step.report ?? {}) as { evidence?: Array<{ ref?: unknown; caption?: unknown }>; checks?: Array<{ evidence?: unknown }> };
    for (const ref of report.evidence ?? []) if (typeof ref.ref === "string" && UUID.test(ref.ref)) named.set(ref.ref, typeof ref.caption === "string" ? ref.caption : null);
    for (const check of report.checks ?? []) for (const id of Array.isArray(check.evidence) ? check.evidence : []) if (typeof id === "string" && UUID.test(id) && !named.has(id)) named.set(id, null);
  }
  // Only the attempt that passed: an earlier attempt's captures show what failed.
  const runs = await prisma.nodeRun.findMany({
    where: { planId: missionId, OR: steps.map((row) => ({ planStep: row.id, ...(row.startedAt ? { createdAt: { gte: row.startedAt } } : {}) })) },
    select: { jobId: true },
  });
  const rows = await prisma.jobEvidence.findMany({
    where: { userId: ownerId, local: false, OR: [{ id: { in: [...named.keys()] } }, { jobId: { in: runs.map((row) => row.jobId) }, kind: { in: [...SHOWN_KINDS] } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, name: true, mime: true, caption: true, size: true, local: true },
  });
  const rank = (row: EvidenceRow) => (named.has(row.id) ? 0 : 2) + (row.kind === "video" ? 0 : row.kind === "screenshot" ? 0.5 : 1);
  return rows
    .filter((row) => named.has(row.id) || SHOWN_KINDS.has(row.kind))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit)
    .map((row) => toMedia(row, named.get(row.id)));
}

/**
 * Whether `accountId` may open an evidence file: its owner, or someone who may read a message that
 * shows it. The website names that message (`messageId`), so one row is checked; without it, only the
 * newest messages of the rooms this person is in.
 */
export async function mediaReadable(prisma: PrismaClient, accountId: string, evidenceId: string, messageId?: string | null): Promise<boolean> {
  const row = await prisma.jobEvidence.findUnique({ where: { id: evidenceId }, select: { userId: true } });
  if (!row) return false;
  if (row.userId === accountId) return true;
  const shows = { kind: "text", userId: row.userId, data: { path: ["media"], array_contains: [{ evidenceId }] } };
  let messages: NodeMessage[];
  if (messageId && UUID.test(messageId)) {
    messages = await prisma.nodeMessage.findMany({ where: { id: messageId, ...shows }, take: 1 });
  } else {
    const rooms = await prisma.nodeRoomMember.findMany({ where: { userId: accountId, nodeId: null }, select: { roomId: true }, take: 500 });
    messages = rooms.length ? await prisma.nodeMessage.findMany({ where: { roomId: { in: rooms.map((room) => room.roomId) }, ...shows }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
  }
  for (const message of messages) {
    if (!canSee(message, accountId)) continue;
    // A person of the room, and in a room with other people, one who had joined when it was posted.
    const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: message.roomId, userId: accountId, nodeId: null }, include: { room: { select: { kind: true } } } });
    if (member && (member.room.kind !== "room" || member.joinedAt <= message.createdAt)) return true;
  }
  return false;
}
