/**
 * Media in the conversation (ensemble-node docs/design B20, extension §8.5): a node's message can carry
 * the screenshots, videos and files its owner's runs attached (evidence): the owner's own, uploaded (not
 * kept on the computer). What a node's own tools capture in a turn comes with its reply by itself,
 * unless it chose with node_show. A mission's report brings the media of the steps that were done or
 * passed, so what reaches the chat was checked first. Reading a file follows the message: whoever may
 * read a message that shows it may open it; anyone else, only its owner.
 */
import type { NodeMessage, PrismaClient } from "@prisma/client";
import { canSee } from "./store.js";

/** One file on a message (`data.media`). A video names its poster image (`posterId`, its own evidence id) and what capture measured. */
export type Media = { evidenceId: string; kind: string; name: string; mime: string; caption: string | null; size: number; posterId?: string; width?: number; height?: number; durationMs?: number };

/** At most this many files on one message. */
export const MAX_MEDIA = 8;
/** At most this many captures come with a reply by themselves (the newest first). */
export const AUTO_MEDIA = 6;
const SHOWN_KINDS = new Set(["screenshot", "image", "video"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a turn chose with node_show. */
const chosen = new Map<string, Media[]>();
/** What a turn's own tools captured (screenshots, videos, terminal screens, shared files), oldest first. */
const captured = new Map<string, Media[]>();

/** Files a turn attached to its reply (node_show), shown when the reply is posted. */
export function attachToTurn(turnId: string, items: readonly Media[]): number {
  const list = chosen.get(turnId) ?? [];
  for (const item of items) if (!list.some((row) => row.evidenceId === item.evidenceId) && list.length < MAX_MEDIA) list.push(item);
  chosen.set(turnId, list);
  return list.length;
}

/** Files a turn's tools captured and kept (not held, uploaded): they come with its reply unless it chose with node_show. */
export function rememberCaptured(turnId: string, items: readonly Media[]): void {
  const list = (captured.get(turnId) ?? []).filter((row) => !items.some((item) => item.evidenceId === row.evidenceId));
  list.push(...items);
  captured.set(turnId, list.slice(-MAX_MEDIA * 4));
}

/** What a reply shows: what the turn chose with node_show, else what it captured (the newest first, at most `AUTO_MEDIA`). */
export function takeTurnMedia(turnId: string): Media[] {
  const picked = chosen.get(turnId);
  const own = captured.get(turnId) ?? [];
  forgetTurnMedia(turnId);
  return picked ?? own.slice(-AUTO_MEDIA).reverse();
}

/** The turn ended: what it chose or captured is not shown any more. */
export function forgetTurnMedia(turnId: string): void {
  chosen.delete(turnId);
  captured.delete(turnId);
}

/** The pictures and videos among files (what a browser or capture call's reply shows by itself). */
export function shownKinds<T extends { kind: string }>(items: readonly T[]): T[] {
  return items.filter((item) => SHOWN_KINDS.has(item.kind));
}

type EvidenceRow = { id: string; kind: string; name: string; mime: string; caption: string | null; size: number; local: boolean; held: boolean; details: unknown };
const SELECT = { id: true, kind: true, name: true, mime: true, caption: true, size: true, local: true, held: true, details: true } as const;

function toMedia(row: EvidenceRow, caption?: string | null, posterId?: string): Media {
  const details = (row.details && typeof row.details === "object" ? row.details : {}) as Record<string, unknown>;
  const measured = Object.fromEntries((["width", "height", "durationMs"] as const).filter((key) => typeof details[key] === "number").map((key) => [key, details[key] as number]));
  return { evidenceId: row.id, kind: row.kind, name: row.name, mime: row.mime, caption: caption ?? row.caption, size: row.size, ...(posterId ? { posterId } : {}), ...measured };
}

/** Each video's poster image, when it was released with it: the poster is shown, never kept apart from its video. */
async function postersOf(prisma: PrismaClient, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.jobEvidence.findMany({ where: { variantOf: { in: [...ids] }, variant: "poster", held: false, local: false }, select: { id: true, variantOf: true } });
  return new Map(rows.map((row) => [row.variantOf!, row.id]));
}

/**
 * The owner's own uploaded evidence for these ids (their runs' files and their nodes' own captures),
 * with why any other cannot be shown: another account's, kept on the computer, or held for the owner's
 * preview (never shown until they release it).
 */
export async function ownerMedia(prisma: PrismaClient, ownerId: string, ids: readonly string[]): Promise<{ media: Media[]; problems: string[] }> {
  const wanted = [...new Set(ids.map((id) => id.trim()))];
  const rows = await prisma.jobEvidence.findMany({ where: { id: { in: wanted.filter((id) => UUID.test(id)) }, userId: ownerId }, select: SELECT });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const posters = await postersOf(prisma, rows.filter((row) => row.kind === "video").map((row) => row.id));
  const media: Media[] = [];
  const problems: string[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) problems.push(`${id}: not a file your owner's runs or you captured`);
    else if (row.held) problems.push(`${row.name}: held for your owner to preview first (they release it on its card)`);
    else if (row.local) problems.push(`${row.name}: kept on the computer (evidence upload is off there)`);
    else media.push(toMedia(row, undefined, posters.get(row.id)));
  }
  return { media: media.slice(0, MAX_MEDIA), problems };
}

type ReportShape = { evidence?: Array<{ ref?: unknown; caption?: unknown }>; checks?: Array<{ evidence?: unknown; verdict?: unknown }> };

/**
 * Confirm before sending (design B20): the media a step may show, by evidence id, when one of its
 * requirements asks for a screenshot or video. Only files a passing check names (a capture_check: the
 * app alive with its window, the image not blank, the expected text on it), never one a failing or
 * skipped check names. Null: the step's requirements ask for no pictures, so its checked files show.
 */
export function checkedMedia(report: ReportShape, wantsPictures: boolean): Set<string> | null {
  if (!wantsPictures) return null;
  const passed = new Set<string>();
  const doubted = new Set<string>();
  for (const check of report.checks ?? []) {
    for (const id of Array.isArray(check.evidence) ? check.evidence : []) {
      if (typeof id !== "string" || !UUID.test(id)) continue;
      (check.verdict === "pass" ? passed : doubted).add(id);
    }
  }
  for (const id of doubted) passed.delete(id);
  return passed;
}

/**
 * What a mission's report shows: from each step that was done or passed, the files its worker named in
 * its report, then the screenshots and videos its runs (or its node) captured; videos and screenshots
 * first. Never a held file, and never the poster or preview of a video on its own. Where a step's
 * requirement asks for a screenshot or video, only the files its passing checks name (`checkedMedia`).
 */
export async function missionMedia(prisma: PrismaClient, missionId: string, ownerId: string, limit = 6): Promise<Media[]> {
  const steps = await prisma.nodeStep.findMany({ where: { missionId, outcome: { in: ["done", "pass"] } }, select: { id: true, report: true, startedAt: true, requirementIds: true } });
  if (!steps.length) return [];
  const mission = await prisma.nodeMission.findUnique({ where: { id: missionId }, select: { requirements: true } });
  const requirements = (Array.isArray(mission?.requirements) ? mission.requirements : []) as Array<{ id?: unknown; evidence?: unknown }>;
  const wantsPictures = (ids: readonly string[]) =>
    requirements.some((row) => typeof row.id === "string" && ids.includes(row.id) && Array.isArray(row.evidence) && row.evidence.some((kind) => kind === "screenshot" || kind === "video"));
  const named = new Map<string, string | null>();
  // Per step: the files it may show when its requirements ask for pictures (null: no such rule for it).
  const allowed: Array<Set<string> | null> = [];
  for (const step of steps) {
    const report = (step.report ?? {}) as ReportShape;
    const checked = checkedMedia(report, wantsPictures(step.requirementIds));
    allowed.push(checked);
    for (const ref of report.evidence ?? []) if (typeof ref.ref === "string" && UUID.test(ref.ref) && (!checked || checked.has(ref.ref))) named.set(ref.ref, typeof ref.caption === "string" ? ref.caption : null);
    for (const check of report.checks ?? []) for (const id of Array.isArray(check.evidence) ? check.evidence : []) if (typeof id === "string" && UUID.test(id) && !named.has(id) && (!checked || checked.has(id))) named.set(id, null);
  }
  // Only the attempt that passed: an earlier attempt's captures show what failed. Steps whose requirements ask for pictures show only what was named.
  const open = steps.filter((_, index) => !allowed[index]);
  const runs = open.length
    ? await prisma.nodeRun.findMany({ where: { planId: missionId, OR: open.map((row) => ({ planStep: row.id, ...(row.startedAt ? { createdAt: { gte: row.startedAt } } : {}) })) }, select: { jobId: true } })
    : [];
  const rows = await prisma.jobEvidence.findMany({
    where: { userId: ownerId, local: false, held: false, variantOf: null, OR: [{ id: { in: [...named.keys()] } }, { jobId: { in: runs.map((row) => row.jobId) }, kind: { in: [...SHOWN_KINDS] } }] },
    orderBy: { createdAt: "asc" },
    select: SELECT,
  });
  const rank = (row: EvidenceRow) => (named.has(row.id) ? 0 : 2) + (row.kind === "video" ? 0 : row.kind === "screenshot" ? 0.5 : 1);
  const shown = rows
    .filter((row) => named.has(row.id) || SHOWN_KINDS.has(row.kind))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
  const posters = await postersOf(prisma, shown.filter((row) => row.kind === "video").map((row) => row.id));
  return shown.map((row) => toMedia(row, named.get(row.id), posters.get(row.id)));
}

/**
 * Whether `accountId` may open an evidence file: its owner, or someone who may read a message that
 * shows it. The website names that message (`messageId`), so one row is checked; without it, only the
 * newest messages of the rooms this person is in.
 */
export async function mediaReadable(prisma: PrismaClient, accountId: string, evidenceId: string, messageId?: string | null): Promise<boolean> {
  const row = await prisma.jobEvidence.findUnique({ where: { id: evidenceId }, select: { userId: true, held: true, variantOf: true } });
  if (!row) return false;
  if (row.userId === accountId) return true;
  // Held for its owner's preview: nobody else, whatever a message says.
  if (row.held) return false;
  // A video's poster opens for whoever may open its video.
  if (row.variantOf) return mediaReadable(prisma, accountId, row.variantOf, messageId);
  const shows = { kind: "text", userId: row.userId, data: { path: ["media"], array_contains: [{ evidenceId }] } };
  let messages: NodeMessage[];
  if (messageId && UUID.test(messageId)) {
    messages = await prisma.nodeMessage.findMany({ where: { id: messageId, ...shows }, take: 1 });
  } else {
    const rooms = await prisma.nodeRoomMember.findMany({ where: { userId: accountId, nodeId: null }, select: { roomId: true }, take: 500 });
    messages = rooms.length ? await prisma.nodeMessage.findMany({ where: { roomId: { in: rooms.map((room) => room.roomId) }, ...shows }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
  }
  for (const message of messages) {
    // A deleted message shows nothing any more.
    if (!canSee(message, accountId) || (message.data as { deleted?: unknown } | null)?.deleted) continue;
    // A person of the room, and in a room with other people, one who had joined when it was posted.
    const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: message.roomId, userId: accountId, nodeId: null }, include: { room: { select: { kind: true } } } });
    if (member && (member.room.kind !== "room" || member.joinedAt <= message.createdAt)) return true;
  }
  return false;
}
