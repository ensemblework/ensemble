/**
 * The owner's chat attachments for a node's own tools (docs/35 §8.13): `node_save_attachment` puts one
 * on the owner's computer, `hub_save_file {attachment}` into Ensemble Files (another space's, or a
 * project's). An attachment is a file in the owner's own Files: Node uploads it there and the message
 * names it (`data.files`). A node names it by its id, or by its name on one of the owner's messages in
 * this room, the newest first. The computer fetches its bytes once (`ROUTES.nodeFile`), with a download
 * id the web gives for that call: only that computer, only that file, for 15 minutes.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Device, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ToolBlockedError } from "../assistant/types.js";
import { ORIGINAL_SELECT, originalBytes } from "../files/originals.js";
import { appendLedger } from "../lib/ledger.js";

export type Attachment = { id: string; filename: string; byteSize: number; mediaType: string; sha256: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far back a node looks for an attachment by its name: the owner's latest messages in the room. */
const RECENT_MESSAGES = 200;
const SELECT = { id: true, filename: true, byteSize: true, mediaType: true, sha256: true } as const;

/** The files on the owner's own messages in this room, newest first: `{id, name}`, each once. */
export async function chatAttachments(prisma: PrismaClient, ownerId: string, roomId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.nodeMessage.findMany({ where: { roomId, userId: ownerId, authorKind: "human" }, orderBy: { seq: "desc" }, take: RECENT_MESSAGES, select: { data: true } });
  const seen = new Set<string>();
  const files: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    const listed = (row.data as { files?: unknown } | null)?.files;
    if (!Array.isArray(listed)) continue;
    for (const file of listed as Array<{ id?: unknown; name?: unknown }>) {
      if (typeof file?.id !== "string" || seen.has(file.id)) continue;
      seen.add(file.id);
      files.push({ id: file.id, name: typeof file.name === "string" ? file.name : "file" });
    }
  }
  return files;
}

const plain = (name: string) => name.trim().split(/[\\/]/).pop()!.toLowerCase();

/** The attachment a node named: its id (any file in the owner's Files), or its name as attached in this room. */
export async function findAttachment(prisma: PrismaClient, ownerId: string, roomId: string, ref: string): Promise<Attachment> {
  const wanted = ref.trim().replace(/^ensemble:\/\/file\//, "");
  if (UUID.test(wanted)) {
    const row = await prisma.document.findFirst({ where: { id: wanted, userId: ownerId, deletedAt: null }, select: SELECT });
    if (row) return row;
  }
  const attached = await chatAttachments(prisma, ownerId, roomId);
  const named = attached.filter((file) => plain(file.name) === plain(wanted));
  for (const file of named) {
    const row = await prisma.document.findFirst({ where: { id: file.id, userId: ownerId, deletedAt: null }, select: SELECT });
    if (row) return row;
  }
  const names = [...new Set(attached.map((file) => `“${file.name}”`))].slice(0, 10);
  throw new ToolBlockedError(
    named.length ? `“${ref}” is no longer in your owner's Files.` : `No file called “${ref}” is attached in this chat.`,
    names.length ? `Attached here: ${names.join(", ")}. Use one of those names (or its id).` : "Your owner attaches a file to a message here first.",
  );
}

// ── download ids ────────────────────────────────────────────────────────────

type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(...keys: string[]): Promise<unknown> };
export type DownloadGrant = { deviceId: string; ownerId: string; nodeId: string; fileId: string; sha256: string; size: number };

const key = (downloadId: string) => `ensemble:node:file:${downloadId}`;
const TTL_SECONDS = 15 * 60;

export async function grantDownload(redis: Redisish, grant: DownloadGrant): Promise<string> {
  const downloadId = randomUUID();
  await redis.set(key(downloadId), JSON.stringify(grant), "EX", TTL_SECONDS);
  return downloadId;
}

async function downloadOf(redis: Pick<Redisish, "get">, downloadId: string): Promise<DownloadGrant | null> {
  if (!UUID.test(downloadId)) return null;
  const raw = await redis.get(key(downloadId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DownloadGrant;
  } catch {
    return null;
  }
}

type Gate = { ownDevice: (app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => Promise<Device | null> };

/** The computer's side: the file a download id names, once, to the computer it was given for. */
export async function nodeFileRoutes(app: FastifyInstance, gate: Gate): Promise<void> {
  const redis = app.redis as unknown as Redisish;
  app.get("/api/devices/self/node-files/:downloadId", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { downloadId } = z.object({ downloadId: z.string().min(1).max(100) }).parse(request.params);
    const grant = await downloadOf(redis, downloadId);
    if (!grant || grant.deviceId !== device.id || grant.ownerId !== device.userId) return reply.code(410).send({ error: "Nobody asked this computer for that file, or it was already fetched." });
    const row = await app.prisma.document.findFirst({ where: { id: grant.fileId, userId: grant.ownerId, deletedAt: null }, select: { filename: true, ...ORIGINAL_SELECT } });
    if (!row) return reply.code(404).send({ error: "That file is no longer in Ensemble Files." });
    const bytes = await originalBytes(row);
    if (createHash("sha256").update(bytes).digest("hex") !== grant.sha256) return reply.code(409).send({ error: "That file changed after it was asked for. Ask again." });
    if (request.method === "GET") {
      await redis.del(key(downloadId)).catch(() => undefined);
      await appendLedger({ userId: grant.ownerId, actor: "agent", action: "node.file_download", payload: { nodeId: grant.nodeId, fileId: grant.fileId, deviceId: device.id, size: bytes.byteLength } });
    }
    return reply.type("application/octet-stream").header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(bytes);
  });
}
