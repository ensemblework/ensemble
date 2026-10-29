/**
 * Evidence routes (docs/25 §4.11, docs/32 §7). A paired computer uploads a file its run's worker
 * attached, with the job's lease like progress and complete; the server checks it again (size by kind,
 * the type sniffed from the bytes, credential names), redacts text, keeps the bytes where Files keeps
 * uploads and lists it on the run's card. Only the account whose computer ran the job reads it back:
 * images and video inline, everything else as a download, active formats (HTML, SVG, XML, JavaScript)
 * never run (a download, or `?view=1` inside a sandbox that allows nothing).
 */
import { mediaReadable } from "../node/media.js";
import type { Device, Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { accountIdOf } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { sseHub } from "../lib/sse.js";
import { isVisitor } from "../sharing/context.js";
import { EVIDENCE_HEADERS, EvidenceMeta } from "../remote/contract.js";
import { credentialPathReason, EVIDENCE_MAX_BYTES, evidenceLimit, evidenceName, isActiveMime, isTextMime, kindMismatch, MAX_EVIDENCE_PER_JOB, sha256Hex, sniffMime } from "./limits.js";
import { cardEvidence, discardEvidence, evidenceContent, evidenceKey, evidenceOf, putEvidence, refreshRunCard } from "./store.js";
import { dropGrant, dropPreview, grantOf, keepPreview, PREVIEW_MAX_BYTES } from "./grants.js";
import { HeldError, previewCardForRun, previewHeld, settleHeld } from "./held.js";

type HeldJob = { id: string; userId: string; deviceId: string | null; taskId: string };
type Held = { ok: false; status: 404 | 409; message: string } | { ok: true; job: HeldJob; now: Date };

/** The device routes' own checks (devices/routes.ts), passed in so the two modules do not import each other. */
export type DeviceGate = {
  ownDevice: (app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => Promise<Device | null>;
  holdLease: (app: FastifyInstance, device: Device, jobId: string, leaseToken: string) => Promise<Held>;
};

/** Room for a 100 MB video and the request around it. */
const UPLOAD_BODY_LIMIT = EVIDENCE_MAX_BYTES + 64 * 1024;

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, expose: true });

/** A MIME type a computer named for a file kept on it, or the generic one. */
function plainMime(value: string | null | undefined): string {
  return value && /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i.test(value) ? value.toLowerCase() : "application/octet-stream";
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
}

/** The account reading evidence: a signed-in person or their full key; never a link visitor or a narrow key. */
function reader(request: FastifyRequest): string {
  const accountId = accountIdOf(request);
  if (request.authVia === "link" || isVisitor(accountId)) throw fail(403, "Sign in to see this.");
  if (request.tokenScope && request.tokenScope !== "full") throw fail(403, "This key cannot read evidence.");
  return accountId;
}

/** `attachment` with an ASCII name for old clients and the real one (RFC 5987) for the rest. */
function disposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

type Checked = { ok: true; bytes: Buffer | null; mime: string; size: number; sha256: string } | { ok: false; status: number; error: string };

/**
 * The bytes a computer sent for one file, checked again here: the size for its kind, the digest, the
 * type sniffed from the bytes (never the sender's word), text redacted. A file kept on the computer
 * (upload off there, or held for the owner's preview) comes without bytes: only its description.
 */
function checkUpload(meta: EvidenceMeta, raw: Buffer, name: string): Checked {
  const limit = evidenceLimit(meta.kind);
  if (meta.local || meta.held) {
    if (raw.length) return { ok: false, status: 400, error: "A file kept on the computer comes without its bytes." };
    if (meta.size > limit) return { ok: false, status: 413, error: `A ${meta.kind} can be at most ${limit / 1024 / 1024} MB.` };
    return { ok: true, bytes: null, mime: plainMime(meta.mime), size: meta.size, sha256: meta.sha256 };
  }
  if (raw.length !== meta.size) return { ok: false, status: 400, error: "The file is not the size its description says." };
  if (raw.length > limit) return { ok: false, status: 413, error: `A ${meta.kind} can be at most ${limit / 1024 / 1024} MB.` };
  if (sha256Hex(raw) !== meta.sha256) return { ok: false, status: 400, error: "The file changed on the way: its digest does not match." };
  const mime = sniffMime(raw, name);
  const mismatch = kindMismatch(meta.kind, mime);
  if (mismatch) return { ok: false, status: 415, error: mismatch };
  // Text is redacted before it is kept, as every text a computer sends is.
  const bytes = isTextMime(mime) ? Buffer.from(redactText(raw.toString("utf8")), "utf8") : raw;
  return { ok: true, bytes, mime, size: bytes.length, sha256: sha256Hex(bytes) };
}

function metaOf(request: FastifyRequest): EvidenceMeta | null {
  try {
    return EvidenceMeta.parse(JSON.parse(Buffer.from(header(request, EVIDENCE_HEADERS.meta) ?? "", "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** What capture measured, as kept: numbers and the codec only. */
function detailsOf(meta: EvidenceMeta): Prisma.InputJsonValue | undefined {
  return meta.details ? (meta.details as Prisma.InputJsonValue) : undefined;
}

/** A held file, or its image, as described by the computer: the reason kept with it. */
function holdOf(meta: EvidenceMeta): { held: boolean; holdReason: string | null } {
  return meta.held ? { held: true, holdReason: meta.holdReason ? redactText(meta.holdReason).slice(0, 300) : "The computer could not check it." } : { held: false, holdReason: null };
}

const MAX_RELAYED = PREVIEW_MAX_BYTES;

export async function evidenceRoutes(app: FastifyInstance, gate: DeviceGate): Promise<void> {
  const { prisma } = app;
  const redis = app.redis as unknown as Parameters<typeof grantOf>[0] & Parameters<typeof keepPreview>[0];
  // Raw bytes for this plugin's upload routes only.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_BODY_LIMIT }, (_request, body, done) => done(null, body));

  app.post("/api/devices/self/jobs/:id/evidence", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const lease = z.string().min(1).max(200).safeParse(header(request, EVIDENCE_HEADERS.lease));
    if (!lease.success) return reply.code(400).send({ error: "The job's lease is missing." });
    const meta = metaOf(request);
    if (!meta) return reply.code(400).send({ error: "The file's description could not be read." });
    const held = await gate.holdLease(app, device, id, lease.data);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    const job = held.job;
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const name = evidenceName(meta.name);
    const named = credentialPathReason(name);
    if (named) return reply.code(422).send({ error: named });
    const known = await prisma.jobEvidence.findUnique({ where: { id: meta.id } });
    if (known) {
      if (known.jobId !== job.id) return reply.code(409).send({ error: "That evidence belongs to another run." });
      return reply.code(200).send({ evidence: cardEvidence(known) });
    }
    if ((await prisma.jobEvidence.count({ where: { jobId: job.id, variantOf: null } })) >= MAX_EVIDENCE_PER_JOB && !meta.variantOf) return reply.code(409).send({ error: `A run keeps at most ${MAX_EVIDENCE_PER_JOB} files.` });
    const checked = checkUpload(meta, raw, name);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const owner = device.userId;
    const key = evidenceKey(owner, job.id, meta.id);
    const stored = checked.bytes ? await putEvidence(key, checked.bytes, checked.mime) : { onRow: null };
    let row;
    try {
      row = await prisma.jobEvidence.create({
        data: {
          id: meta.id,
          userId: owner,
          jobId: job.id,
          kind: meta.kind,
          name,
          mime: checked.mime,
          size: checked.size,
          sha256: checked.sha256,
          storageKey: key,
          bytes: stored.onRow ? new Uint8Array(stored.onRow) : null,
          local: !checked.bytes,
          ...holdOf(meta),
          deviceId: device.id,
          variantOf: meta.variantOf ?? null,
          variant: meta.variantOf ? (meta.variant ?? "poster") : null,
          details: detailsOf(meta),
          caption: meta.caption ? redactText(meta.caption).slice(0, 300) : null,
          requirementId: meta.requirementId ? meta.requirementId.slice(0, 80) : null,
        },
      });
    } catch (error) {
      // The same file sent twice at once: the first row stands, this copy of the bytes goes.
      if (checked.bytes && !stored.onRow) await discardEvidence(key);
      const again = await prisma.jobEvidence.findUnique({ where: { id: meta.id } });
      if (again?.jobId === job.id) return reply.code(200).send({ evidence: cardEvidence(again) });
      throw error;
    }
    await appendLedger({ userId: job.userId, actor: "agent", action: "evidence.upload", payload: { jobId: job.id, evidenceId: row.id, kind: row.kind, size: row.size, local: row.local, held: row.held, deviceId: device.id } });
    await refreshRunCard(prisma, job.id).catch((error: unknown) => request.log.warn({ err: error }, "could not list evidence on the run card"));
    // A held capture waits for its owner's preview, announced where the run is followed.
    if (row.held && !row.variantOf) await previewCardForRun(app, job.id, [row]).catch((error: unknown) => request.log.warn({ err: error }, "could not post the preview card"));
    sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
    return reply.code(201).send({ evidence: cardEvidence(row) });
  });

  // A file the web asked this computer for by an upload id (evidence/grants.ts): a node's capture, or a held file released or previewed.
  app.post("/api/devices/self/evidence-uploads/:uploadId", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { uploadId } = z.object({ uploadId: z.string().min(1).max(100) }).parse(request.params);
    const grant = await grantOf(redis, uploadId);
    if (!grant || grant.deviceId !== device.id || grant.ownerId !== device.userId) return reply.code(410).send({ error: "Nobody waits for this file any more." });
    const meta = metaOf(request);
    if (!meta) return reply.code(400).send({ error: "The file's description could not be read." });
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const name = evidenceName(meta.name);
    const named = credentialPathReason(name);
    if (named) return reply.code(422).send({ error: named });
    const owner = device.userId;

    if (grant.mode === "preview" || grant.mode === "release") {
      const row = await prisma.jobEvidence.findUnique({ where: { id: grant.evidenceId } });
      if (!row || row.userId !== owner || meta.id !== row.id) return reply.code(404).send({ error: "That evidence is not here any more." });
      if (meta.local || meta.held) return reply.code(400).send({ error: "This file must come with its bytes." });
      const checked = checkUpload(meta, raw, name);
      if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
      if (grant.mode === "preview") {
        // Its owner's preview only: five minutes in Redis, never the database or the blob store.
        if (checked.size > MAX_RELAYED) return reply.code(413).send({ error: "Too large to preview from the computer." });
        await keepPreview(redis, row.id, checked.mime, checked.bytes!);
        return reply.code(200).send({ ok: true });
      }
      if (!row.held && !row.local) return reply.code(200).send({ evidence: cardEvidence(row) });
      const key = row.jobId ? evidenceKey(owner, row.jobId, row.id) : evidenceKey(owner, `node-${row.nodeId ?? "none"}`, row.id);
      const stored = await putEvidence(key, checked.bytes!, checked.mime);
      const released = await prisma.jobEvidence.update({
        where: { id: row.id },
        data: { held: false, holdReason: null, local: false, mime: checked.mime, size: checked.size, sha256: checked.sha256, storageKey: key, bytes: stored.onRow ? new Uint8Array(stored.onRow) : null },
      });
      await dropPreview(redis, row.id);
      await dropGrant(redis, uploadId);
      if (row.jobId) await refreshRunCard(prisma, row.jobId).catch(() => undefined);
      return reply.code(200).send({ evidence: cardEvidence(released) });
    }

    // A node's own capture: a new file of its tool operation.
    const known = await prisma.jobEvidence.findUnique({ where: { id: meta.id } });
    if (known) {
      if (known.operation !== grant.operation || known.userId !== owner) return reply.code(409).send({ error: "That evidence belongs to other work." });
      return reply.code(200).send({ evidence: cardEvidence(known) });
    }
    if ((await prisma.jobEvidence.count({ where: { operation: grant.operation, jobId: null, variantOf: null } })) >= MAX_EVIDENCE_PER_JOB && !meta.variantOf) {
      return reply.code(409).send({ error: `This work keeps at most ${MAX_EVIDENCE_PER_JOB} files.` });
    }
    const checked = checkUpload(meta, raw, name);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const key = evidenceKey(owner, `node-${grant.nodeId}`, meta.id);
    const stored = checked.bytes ? await putEvidence(key, checked.bytes, checked.mime) : { onRow: null };
    let row;
    try {
      row = await prisma.jobEvidence.create({
        data: {
          id: meta.id,
          userId: owner,
          jobId: null,
          nodeId: grant.nodeId,
          operation: grant.operation,
          kind: meta.kind,
          name,
          mime: checked.mime,
          size: checked.size,
          sha256: checked.sha256,
          storageKey: key,
          bytes: stored.onRow ? new Uint8Array(stored.onRow) : null,
          local: !checked.bytes,
          ...holdOf(meta),
          deviceId: device.id,
          variantOf: meta.variantOf ?? null,
          variant: meta.variantOf ? (meta.variant ?? "poster") : null,
          details: detailsOf(meta),
          caption: meta.caption ? redactText(meta.caption).slice(0, 300) : null,
        },
      });
    } catch (error) {
      if (checked.bytes && !stored.onRow) await discardEvidence(key);
      const again = await prisma.jobEvidence.findUnique({ where: { id: meta.id } });
      if (again?.operation === grant.operation) return reply.code(200).send({ evidence: cardEvidence(again) });
      throw error;
    }
    await appendLedger({ userId: owner, actor: "agent", action: "evidence.upload", payload: { nodeId: grant.nodeId, evidenceId: row.id, kind: row.kind, size: row.size, local: row.local, held: row.held, deviceId: device.id } });
    return reply.code(201).send({ evidence: cardEvidence(row) });
  });

  // A run's evidence, or a node's own captures, for the account whose computer made them.
  app.get("/api/node/evidence", async (request, reply) => {
    const accountId = reader(request);
    const query = z.object({ jobId: z.string().uuid().optional(), nodeId: z.string().uuid().optional() }).parse(request.query);
    if (query.jobId) return { evidence: await evidenceOf(prisma, { jobId: query.jobId }, accountId) };
    if (query.nodeId) return { evidence: await evidenceOf(prisma, { nodeId: query.nodeId }, accountId) };
    return reply.code(400).send({ error: "Name a run (jobId) or a node (nodeId)." });
  });

  // The owner releases a held file (it is uploaded, then usable like any evidence) or discards it.
  app.post("/api/node/evidence/:id/release", async (request, reply) => {
    const accountId = reader(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { decision } = z.object({ decision: z.enum(["approve", "discard"]) }).parse(request.body);
    const row = await prisma.jobEvidence.findUnique({ where: { id }, select: { userId: true, held: true, variantOf: true } });
    if (!row || row.userId !== accountId || row.variantOf) return reply.code(404).send({ error: "That evidence is not available." });
    if (!row.held) return reply.code(409).send({ error: "That file is not waiting for a preview." });
    const settled = await settleHeld(app, accountId, [id], decision);
    if (settled.failed.length) return reply.code(409).send({ error: settled.failed[0]!.error });
    return { released: settled.released, discarded: settled.discarded };
  });

  // One file's bytes. Images and video show inline; anything else downloads; active formats never run.
  app.get("/api/node/evidence/:id", async (request, reply) => {
    const accountId = reader(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { view, message } = z.object({ view: z.enum(["0", "1"]).optional(), message: z.string().uuid().optional() }).parse(request.query);
    // Its owner, or someone who may read the message that shows it (node/media.ts).
    const head = (await mediaReadable(prisma, accountId, id, message)) ? await prisma.jobEvidence.findUnique({ where: { id } }) : null;
    if (!head) return reply.code(404).send({ error: "That evidence is not available." });
    let bytes: Buffer;
    let mime = head.mime;
    let etag: string | null = `"${head.sha256}"`;
    if (head.held) {
      // Held for its owner's preview: only they see it, fetched from the computer that keeps it.
      if (head.userId !== accountId) return reply.code(404).send({ error: "That evidence is not available." });
      try {
        const preview = await previewHeld(app, head);
        bytes = preview.bytes;
        mime = preview.mime;
        etag = null;
      } catch (error) {
        if (error instanceof HeldError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    } else {
      if (head.local) return reply.code(409).send({ error: "This file is on the computer that ran the job, not uploaded: evidence upload is off there (`ensemble evidence on` turns it on)." });
      const match = request.headers["if-none-match"];
      if (typeof match === "string" && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return reply.code(304).header("ETag", etag).send();
      bytes = await evidenceContent(head);
    }
    const media = mime.startsWith("image/") && !isActiveMime(mime) ? true : mime.startsWith("video/");
    if (etag) reply.header("ETag", etag);
    reply
      // A held file's preview is never kept by a browser or a proxy.
      .header("Cache-Control", head.held ? "no-store" : "private, no-cache")
      .header("X-Content-Type-Options", "nosniff")
      // Opened directly, nothing in the file runs or loads anything: no scripts, no requests, no forms.
      .header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header("Referrer-Policy", "no-referrer")
      .header("Accept-Ranges", "bytes")
      .header("Content-Type", mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "image/svg+xml" ? `${mime}; charset=utf-8` : mime)
      .header("Content-Disposition", disposition(media || (view === "1" && !mime.startsWith("application/octet")) ? "inline" : "attachment", head.name));
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? "").trim());
    if (range && (range[1] || range[2])) {
      const total = bytes.byteLength;
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start > end || start >= total) return reply.code(416).header("Content-Range", `bytes */${total}`).send();
      return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${total}`).send(bytes.subarray(start, end + 1));
    }
    return reply.send(bytes);
  });
}
