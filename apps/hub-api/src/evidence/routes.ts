/**
 * Evidence routes (docs/25 §4.11, docs/32 §7). A paired computer uploads a file its run's worker
 * attached, with the job's lease like progress and complete; the server checks it again (size by kind,
 * the type sniffed from the bytes, credential names), redacts text, keeps the bytes where Files keeps
 * uploads and lists it on the run's card. Only the account whose computer ran the job reads it back:
 * images and video inline, everything else as a download, active formats (HTML, SVG, XML, JavaScript)
 * never run (a download, or `?view=1` inside a sandbox that allows nothing).
 */
import type { Device } from "@prisma/client";
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

export async function evidenceRoutes(app: FastifyInstance, gate: DeviceGate): Promise<void> {
  const { prisma } = app;
  // Raw bytes for this plugin's upload route only.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_BODY_LIMIT }, (_request, body, done) => done(null, body));

  app.post("/api/devices/self/jobs/:id/evidence", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const lease = z.string().min(1).max(200).safeParse(header(request, EVIDENCE_HEADERS.lease));
    if (!lease.success) return reply.code(400).send({ error: "The job's lease is missing." });
    let meta: EvidenceMeta;
    try {
      meta = EvidenceMeta.parse(JSON.parse(Buffer.from(header(request, EVIDENCE_HEADERS.meta) ?? "", "base64url").toString("utf8")));
    } catch {
      return reply.code(400).send({ error: "The file's description could not be read." });
    }
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
    if ((await prisma.jobEvidence.count({ where: { jobId: job.id } })) >= MAX_EVIDENCE_PER_JOB) return reply.code(409).send({ error: `A run keeps at most ${MAX_EVIDENCE_PER_JOB} files.` });
    const limit = evidenceLimit(meta.kind);
    let bytes: Buffer | null = null;
    let mime: string;
    let size = meta.size;
    let sha256 = meta.sha256;
    if (meta.local) {
      // Upload is off on that computer: its name and size only, shown as there and not uploaded.
      if (raw.length) return reply.code(400).send({ error: "A file kept on the computer comes without its bytes." });
      if (meta.size > limit) return reply.code(413).send({ error: `A ${meta.kind} can be at most ${limit / 1024 / 1024} MB.` });
      mime = plainMime(meta.mime);
    } else {
      if (raw.length !== meta.size) return reply.code(400).send({ error: "The file is not the size its description says." });
      if (raw.length > limit) return reply.code(413).send({ error: `A ${meta.kind} can be at most ${limit / 1024 / 1024} MB.` });
      if (sha256Hex(raw) !== meta.sha256) return reply.code(400).send({ error: "The file changed on the way: its digest does not match." });
      mime = sniffMime(raw, name);
      const mismatch = kindMismatch(meta.kind, mime);
      if (mismatch) return reply.code(415).send({ error: mismatch });
      // Text is redacted before it is kept, as every text a computer sends is.
      bytes = isTextMime(mime) ? Buffer.from(redactText(raw.toString("utf8")), "utf8") : raw;
      size = bytes.length;
      sha256 = sha256Hex(bytes);
    }
    const owner = device.userId;
    const key = evidenceKey(owner, job.id, meta.id);
    const stored = bytes ? await putEvidence(key, bytes, mime) : { onRow: null };
    let row;
    try {
      row = await prisma.jobEvidence.create({
        data: {
          id: meta.id,
          userId: owner,
          jobId: job.id,
          kind: meta.kind,
          name,
          mime,
          size,
          sha256,
          storageKey: key,
          bytes: stored.onRow ? new Uint8Array(stored.onRow) : null,
          local: meta.local,
          caption: meta.caption ? redactText(meta.caption).slice(0, 300) : null,
          requirementId: meta.requirementId ? meta.requirementId.slice(0, 80) : null,
        },
      });
    } catch (error) {
      // The same file sent twice at once: the first row stands, this copy of the bytes goes.
      if (bytes && !stored.onRow) await discardEvidence(key);
      const again = await prisma.jobEvidence.findUnique({ where: { id: meta.id } });
      if (again?.jobId === job.id) return reply.code(200).send({ evidence: cardEvidence(again) });
      throw error;
    }
    await appendLedger({ userId: job.userId, actor: "agent", action: "evidence.upload", payload: { jobId: job.id, evidenceId: row.id, kind: row.kind, size: row.size, local: row.local, deviceId: device.id } });
    await refreshRunCard(prisma, job.id).catch((error: unknown) => request.log.warn({ err: error }, "could not list evidence on the run card"));
    sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
    return reply.code(201).send({ evidence: cardEvidence(row) });
  });

  // A run's evidence, for the account whose computer ran it.
  app.get("/api/node/evidence", async (request) => {
    const accountId = reader(request);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.query);
    return { evidence: await evidenceOf(prisma, jobId, accountId) };
  });

  // One file's bytes. Images and video show inline; anything else downloads; active formats never run.
  app.get("/api/node/evidence/:id", async (request, reply) => {
    const accountId = reader(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { view } = z.object({ view: z.enum(["0", "1"]).optional() }).parse(request.query);
    const head = await prisma.jobEvidence.findFirst({ where: { id, userId: accountId }, select: { name: true, mime: true, sha256: true, local: true, size: true } });
    if (!head) return reply.code(404).send({ error: "That evidence is not available." });
    if (head.local) return reply.code(409).send({ error: "This file is on the computer that ran the job, not uploaded: evidence upload is off there (`ensemble evidence on` turns it on)." });
    const media = head.mime.startsWith("image/") && !isActiveMime(head.mime) ? true : head.mime.startsWith("video/");
    const etag = `"${head.sha256}"`;
    reply
      .header("ETag", etag)
      .header("Cache-Control", "private, no-cache")
      .header("X-Content-Type-Options", "nosniff")
      // Opened directly, nothing in the file runs or loads anything: no scripts, no requests, no forms.
      .header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header("Referrer-Policy", "no-referrer")
      .header("Accept-Ranges", "bytes")
      .header("Content-Type", head.mime.startsWith("text/") || head.mime === "application/json" || head.mime === "application/xml" || head.mime === "image/svg+xml" ? `${head.mime}; charset=utf-8` : head.mime)
      .header("Content-Disposition", disposition(media || (view === "1" && !head.mime.startsWith("application/octet")) ? "inline" : "attachment", head.name));
    const match = request.headers["if-none-match"];
    if (typeof match === "string" && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) return reply.code(304).send();
    const row = await prisma.jobEvidence.findFirst({ where: { id, userId: accountId }, select: { bytes: true, storageKey: true, local: true } });
    if (!row) return reply.code(404).send({ error: "That evidence is not available." });
    const bytes = await evidenceContent(row);
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
