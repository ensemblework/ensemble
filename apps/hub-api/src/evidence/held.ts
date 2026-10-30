/**
 * Captures held for the owner's preview (docs/35 §8.16, design B20): a screenshot or video the
 * computer could not clear (a saved secret or key on screen, a desktop app's window, a site the owner
 * previews first) stays on that computer. It never goes to a model, never shows in a chat and is not
 * uploaded until its owner previews it and releases it.
 *
 * - **Preview.** Only the owner opens it: the file comes from the computer on request (`evidence.request`,
 *   action `preview`) and is kept in Redis for five minutes, never in the database or the blob store.
 * - **Release.** The owner's approve: the computer uploads it as any other evidence (`release`); then
 *   `node_show` and a plan's report can show it.
 * - **Discard.** The computer deletes it, and the web forgets it.
 *
 * Each held capture is announced by one owner-only approval card where its work is followed
 * ("Preview before it's used", `data.type: "media_preview"`): in the run's room for a run's capture, in
 * the node's conversation for its own. Settling the card releases or discards every file on it.
 */
import type { Device, JobEvidence, NodeMessage } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { appendLedger } from "../lib/ledger.js";
import { CodeAnswer } from "../remote/contract.js";
import { postMessage, updateMessageData } from "../node/store.js";
import { dropPreview, grantUpload, PREVIEW_MAX_BYTES, previewOf } from "./grants.js";
import { cardsOf, discardEvidence, refreshRunCard, type CardEvidence } from "./store.js";

type App = Pick<FastifyInstance, "prisma" | "redis" | "log">;
type Redisish = Parameters<typeof grantUpload>[0] & Parameters<typeof askDeviceFor>[0];

export class HeldError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 | 413 | 502 | 504,
  ) {
    super(message);
  }
}

const redisOf = (app: App) => app.redis as unknown as Redisish;

/** The computer that keeps a file: the owner's, still paired. */
async function keeper(app: App, row: Pick<JobEvidence, "deviceId" | "userId" | "name">): Promise<Device> {
  const device = row.deviceId ? await app.prisma.device.findUnique({ where: { id: row.deviceId } }) : null;
  if (!device || device.userId !== row.userId || device.revokedAt) throw new HeldError(`“${row.name}” was kept on a computer that is no longer paired.`, 409);
  if (!deviceOnline(device.lastSeenAt)) throw new HeldError(`“${row.name}” is kept on ${device.name}, which is offline. Try again when Ensemble runs there.`, 504);
  return device;
}

/** Asks the computer to preview, release or discard a file it keeps; resolves with its answer. */
async function ask(app: App, device: Device, row: Pick<JobEvidence, "id" | "userId">, action: "preview" | "release" | "discard", timeoutMs: number): Promise<{ status: number; error?: string }> {
  const uploadId = action === "discard" ? undefined : await grantUpload(redisOf(app), { mode: action, deviceId: device.id, ownerId: row.userId, evidenceId: row.id });
  const raw = await askDeviceFor(redisOf(app), { deviceId: device.id, event: "evidence.request", data: { evidenceId: row.id, action, ...(uploadId ? { uploadId } : {}) } }, timeoutMs);
  if (!raw) return { status: 504, error: `${device.name} did not answer in time.` };
  const answer = CodeAnswer.safeParse(raw);
  if (!answer.success) return { status: 502, error: `${device.name} sent an answer that could not be read.` };
  const body = (answer.data.body ?? {}) as { error?: unknown };
  return { status: answer.data.status, ...(typeof body.error === "string" ? { error: body.error } : {}) };
}

/** A held file's bytes, for its owner only: from the computer, kept five minutes. */
export async function previewHeld(app: App, row: Pick<JobEvidence, "id" | "userId" | "deviceId" | "name" | "size">): Promise<{ mime: string; bytes: Buffer }> {
  const cached = await previewOf(redisOf(app), row.id);
  if (cached) return cached;
  if (row.size > PREVIEW_MAX_BYTES) throw new HeldError(`“${row.name}” is too large to preview from the computer (${Math.ceil(row.size / 1024 / 1024)} MB); preview its poster, or release it.`, 413);
  const device = await keeper(app, row);
  const answer = await ask(app, device, row, "preview", 60_000);
  if (answer.status !== 200) throw new HeldError(answer.error ?? `${device.name} could not send it (${answer.status}).`, answer.status === 404 || answer.status === 413 || answer.status === 504 ? answer.status : 409);
  const sent = await previewOf(redisOf(app), row.id);
  if (!sent) throw new HeldError(`${device.name} did not send “${row.name}”.`, 502);
  return sent;
}

/** A row and its variants (a video's poster and preview). */
async function withVariants(app: App, row: JobEvidence): Promise<JobEvidence[]> {
  return [row, ...(await app.prisma.jobEvidence.findMany({ where: { variantOf: row.id, userId: row.userId }, orderBy: { createdAt: "asc" } }))];
}

export type Settled = { released: string[]; discarded: string[]; failed: Array<{ id: string; name: string; error: string; status: number }> };

/**
 * The owner releases (uploads, then usable everywhere evidence is) or discards held files: each with
 * its poster and preview. Files of another account, or not held, are left as they are.
 */
export async function settleHeld(app: App, accountId: string, ids: readonly string[], decision: "approve" | "discard"): Promise<Settled> {
  const settled: Settled = { released: [], discarded: [], failed: [] };
  const jobs = new Set<string>();
  for (const id of new Set(ids)) {
    const row = await app.prisma.jobEvidence.findUnique({ where: { id } });
    if (!row || row.userId !== accountId || row.variantOf) continue;
    if (!row.held) {
      if (decision === "approve") settled.released.push(row.id);
      continue;
    }
    const rows = await withVariants(app, row);
    if (row.jobId) jobs.add(row.jobId);
    if (decision === "discard") {
      // The computer deletes its copy when it can; the web forgets it either way.
      const device = await keeper(app, row).catch(() => null);
      if (device) for (const item of rows) await ask(app, device, item, "discard", 15_000).catch(() => undefined);
      for (const item of rows) {
        if (!item.local) await discardEvidence(item.storageKey);
        await dropPreview(redisOf(app), item.id);
      }
      await app.prisma.jobEvidence.deleteMany({ where: { id: { in: rows.map((item) => item.id) } } });
      settled.discarded.push(row.id);
      await appendLedger({ userId: accountId, actor: "me", action: "evidence.discard", payload: { evidenceId: row.id, jobId: row.jobId, nodeId: row.nodeId } }).catch(() => undefined);
      continue;
    }
    try {
      const device = await keeper(app, row);
      for (const item of rows) {
        const answer = await ask(app, device, item, "release", Math.min(180_000, 30_000 + Math.ceil(item.size / (1024 * 1024)) * 1_000));
        const now = await app.prisma.jobEvidence.findUnique({ where: { id: item.id }, select: { held: true } });
        if (answer.status !== 200 || now?.held) throw new HeldError(answer.error ?? `${device.name} did not send “${item.name}”.`, 409);
      }
      settled.released.push(row.id);
      await appendLedger({ userId: accountId, actor: "me", action: "evidence.release", payload: { evidenceId: row.id, jobId: row.jobId, nodeId: row.nodeId, deviceId: device.id } }).catch(() => undefined);
    } catch (error) {
      settled.failed.push({ id: row.id, name: row.name, error: error instanceof Error ? error.message : String(error), status: error instanceof HeldError ? error.statusCode : 409 });
    }
  }
  for (const jobId of jobs) await refreshRunCard(app.prisma as never, jobId).catch(() => undefined);
  await settleCards(app, accountId, settled);
  return settled;
}

const CARD_TYPE = "media_preview";

type PreviewCardData = { type: typeof CARD_TYPE; status: string; evidence: CardEvidence[]; jobId?: string | null; operation?: string | null; nodeCapture?: boolean };

/**
 * Pending preview cards that name these files. Each file's answer is kept on its card as it is given
 * (`data.answers`, one statement per file, so answers given at once all stay); the card is settled when
 * none of its files is held any more, with every answer it was given.
 */
async function settleCards(app: App, accountId: string, settled: Settled): Promise<void> {
  const done = new Map<string, "released" | "discarded">([...settled.released.map((id) => [id, "released"] as const), ...settled.discarded.map((id) => [id, "discarded"] as const)]);
  if (!done.size) return;
  const cards = await app.prisma.nodeMessage.findMany({ where: { userId: accountId, kind: "approval", data: { path: ["type"], equals: CARD_TYPE } }, orderBy: { createdAt: "desc" }, take: 100 });
  for (const card of cards) {
    const data = card.data as PreviewCardData;
    if (data.status !== "pending" || !Array.isArray(data.evidence) || !data.evidence.some((item) => done.has(item.id))) continue;
    for (const item of data.evidence) {
      const answer = done.get(item.id);
      if (!answer) continue;
      await app.prisma.$executeRaw`UPDATE node_messages SET data = jsonb_set(data, '{answers}', COALESCE(data->'answers', '{}'::jsonb) || jsonb_build_object(${item.id}::text, ${answer}::text)) WHERE id = ${card.id}`;
    }
    const fresh = await app.prisma.nodeMessage.findUnique({ where: { id: card.id } });
    if (!fresh) continue;
    const now = fresh.data as PreviewCardData & { answers?: Record<string, string> };
    const answers = now.answers ?? {};
    const left = await app.prisma.jobEvidence.count({ where: { id: { in: now.evidence.map((item) => item.id) }, held: true } });
    if (left || now.status !== "pending") {
      // Still waiting for some: the card shows the answers so far.
      await updateMessageData(app.prisma, fresh, {});
      continue;
    }
    const released = now.evidence.filter((item) => answers[item.id] === "released").map((item) => item.id);
    const discarded = now.evidence.filter((item) => answers[item.id] === "discarded").map((item) => item.id);
    await updateMessageData(app.prisma, fresh, { status: released.length ? "released" : "discarded", result: { released, discarded } });
  }
}

export type PreviewCardInput = {
  ownerId: string;
  nodeId: string;
  roomId: string;
  rows: readonly JobEvidence[];
  jobId?: string | null;
  operation?: string | null;
  planId?: string | null;
  planStep?: string | null;
  rootMessageId?: string | null;
  /** The node's turn read only its owner's private thread. */
  private?: boolean;
};

/**
 * One owner-only card for held files of the same work: a new card, or the work's card still pending,
 * which takes the new files too.
 */
export async function postPreviewCard(app: App, input: PreviewCardInput): Promise<NodeMessage | null> {
  const prisma = app.prisma;
  const held = input.rows.filter((row) => row.held);
  if (!held.length) return null;
  const all = await prisma.jobEvidence.findMany({ where: { OR: [{ id: { in: held.map((row) => row.id) } }, { variantOf: { in: held.map((row) => row.id) } }] }, orderBy: { createdAt: "asc" } });
  const cards = cardsOf(all);
  const reasons = [...new Set(held.map((row) => row.holdReason).filter((reason): reason is string => Boolean(reason)))];
  const work = input.jobId ? { jobId: input.jobId } : { operation: input.operation ?? null };
  const open = await prisma.nodeMessage.findMany({ where: { roomId: input.roomId, userId: input.ownerId, kind: "approval", authorNodeId: input.nodeId, data: { path: ["type"], equals: CARD_TYPE } }, orderBy: { createdAt: "desc" }, take: 20 });
  const same = open.find((card) => {
    const data = card.data as PreviewCardData;
    return data.status === "pending" && (input.jobId ? data.jobId === input.jobId : data.operation === input.operation);
  });
  const body = (items: CardEvidence[]) => `Preview before it's used: ${items.map((item) => `“${item.name}”`).join(", ")}. ${reasons.length ? reasons.join(" ") : "The computer could not check it."} Nothing is sent to a model or shown in a chat until you release it.`;
  if (same) {
    const data = same.data as PreviewCardData;
    const evidence = [...data.evidence, ...cards.filter((item) => !data.evidence.some((known) => known.id === item.id))];
    return updateMessageData(prisma, same, { evidence }, body(evidence));
  }
  const { message } = await postMessage(prisma, {
    roomId: input.roomId,
    userId: input.ownerId,
    authorKind: "node",
    authorNodeId: input.nodeId,
    kind: "approval",
    body: body(cards),
    data: {
      type: CARD_TYPE,
      status: "pending",
      evidence: cards,
      reasons,
      ...work,
      nodeCapture: !input.jobId,
      ...(input.private ? { private: true } : {}),
      // Not under `plan`: a held capture never keeps its step waiting, and outlives the step's other cards.
      ...(input.planId ? { planId: input.planId, planStep: input.planStep ?? null } : {}),
    },
    visibleTo: [input.ownerId],
    rootMessageId: input.rootMessageId ?? null,
  });
  return message;
}

/** A run's held capture, announced where its run card is: by the run's node, to its owner only. */
export async function previewCardForRun(app: App, jobId: string, rows: readonly JobEvidence[]): Promise<void> {
  if (!rows.some((row) => row.held)) return;
  const run = await app.prisma.nodeRun.findUnique({ where: { jobId }, select: { nodeId: true, roomId: true, userId: true, planId: true, planStep: true } });
  if (!run) return;
  await postPreviewCard(app, { ownerId: run.userId, nodeId: run.nodeId, roomId: run.roomId, rows, jobId, planId: run.planId, planStep: run.planStep });
}

export const MEDIA_PREVIEW_CARD = CARD_TYPE;
