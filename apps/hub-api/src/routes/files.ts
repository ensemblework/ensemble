/**
 * Files: upload, list, read, preview bytes, edit, make a page, remove.
 * Paths stay under /api/documents. Docs: docs/32_FILES.md, API rows in docs/02.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { fileFormat, fileTypeProblem, PageDocument, type FileStyleProfile } from "@ensemble/shared-types";
import { Prisma } from "@prisma/client";
import { enrichDocument } from "../context/enrich-documents.js";
import { clip } from "../lib/office/text.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { createStandalonePage } from "../pages/store.js";
import { assertOwned } from "../services/records.js";
import { configureFileText, fileTextRunning, patchWorkbook, queueFileText } from "../files/extract.js";
import { pageFromFile, pageTitle, serverPageFormat } from "../files/page.js";
import { assertNewFile, FILE_SELECT, FileError, fileRecord, fileStyle, fileTooLarge, fileUsage, filenameProblem, maxFileBytes, replaceFileBytes, saveFile, type FileRow } from "../files/store.js";

const TEXT_DEFAULT = 6000;
const TEXT_MAX = 20_000;
const CELLS_MAX_BYTES = 15 * 1024 * 1024;
const CELLS_MAX_CHANGES = 20_000;

const DocumentTags = z.object({
  projectIds: z.array(z.string()).default([]),
  personIds: z.array(z.string()).default([]),
  repoIds: z.array(z.string()).default([]),
  taskIds: z.array(z.string()).default([]),
});

async function assertDocumentTags(db: FastifyInstance["prisma"], userId: string, tags: z.infer<typeof DocumentTags>): Promise<void> {
  for (const [key, kind] of [["projectIds", "project"], ["personIds", "person"], ["repoIds", "repo"], ["taskIds", "task"]] as const) {
    for (const id of tags[key]) await assertOwned(db, userId, kind, id);
  }
}

const Upload = z.object({
  filename: z.string().max(1000),
  mediaType: z.string().max(255).default("application/octet-stream"),
  dataBase64: z.string(),
  summarize: z.boolean().default(true),
  tags: DocumentTags.default({}),
});

const Replace = z.object({
  dataBase64: z.string(),
  filename: z.string().max(1000).optional(),
  mediaType: z.string().max(255).optional(),
});

const CellValue = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);

const Patch = z.object({
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        set: z.array(z.object({ row: z.number().int().min(1).max(1_048_576), col: z.number().int().min(1).max(16_384), value: CellValue })).optional(),
        deleteRows: z.array(z.number().int().min(1).max(1_048_576)).optional(),
      }),
    )
    .min(1)
    .max(255),
});

const Points = z.number().finite().min(0).max(10_000);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Heading = z.object({ font: z.string().max(200).optional(), size: Points, color: Color, bold: z.boolean().optional() });

const StyleProfile: z.ZodType<FileStyleProfile> = z.object({
  source: z.enum(["pdf", "docx"]),
  page: z.object({ width: Points, height: Points, margins: z.object({ top: Points, right: Points, bottom: Points, left: Points }) }).optional(),
  body: z.object({ font: z.string().max(200), size: Points, color: Color, lineHeight: z.number().finite().min(0).max(10).optional() }).optional(),
  headings: z.object({ "1": Heading.optional(), "2": Heading.optional(), "3": Heading.optional() }).optional(),
});

const MakePage = z.object({
  title: z.string().max(200).optional(),
  content: PageDocument.optional(),
  style: StyleProfile.optional(),
});

/** Base64 with room for the JSON around it. */
const uploadLimit = () => Math.ceil((maxFileBytes() * 4) / 3) + 64 * 1024;

function decode(dataBase64: string): Buffer {
  const bytes = Buffer.from(dataBase64, "base64");
  if (dataBase64.trim() && !bytes.byteLength) throw Object.assign(new Error("dataBase64 is not base64."), { statusCode: 400 });
  return bytes;
}

function checkName(name: string): void {
  const problem = filenameProblem(name);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
}

/** `attachment` with an ASCII name for old clients and the real one (RFC 5987) for the rest. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "File not found." });

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  configureFileText({
    summarize: (id) => void enrichDocument(app, id).catch((error: unknown) => app.log.error({ err: error }, "document summary failed")),
    onError: (error, id) => app.log.error({ err: error, documentId: id }, "file text extraction failed"),
  });

  // Fastify refuses a body over the route's limit by its Content-Length, before reading it; say so as a file size.
  app.setErrorHandler((error) => {
    throw (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE" ? fileTooLarge() : error;
  });

  const owned = (id: string, userId: string) => ({ id, userId, deletedAt: null });

  /** A file whose text was queued by a process that has since stopped gets read again. */
  const resume = (rows: FileRow[]) => {
    for (const row of rows) if (row.parseStatus === "queued" && !fileTextRunning(row.id)) void queueFileText(prisma, row.id);
  };

  app.get("/api/documents", async (request) => {
    const { q } = z.object({ q: z.string().max(200).optional() }).parse(request.query);
    const rows = await prisma.document.findMany({
      where: { userId: request.userId, deletedAt: null, ...(q?.trim() ? { filename: { contains: q.trim(), mode: "insensitive" } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: FILE_SELECT,
    });
    resume(rows);
    return { files: rows.map(fileRecord), usage: await fileUsage(prisma, request.userId) };
  });

  app.post("/api/documents", { bodyLimit: uploadLimit() }, async (request, reply) => {
    const body = Upload.parse(request.body);
    checkName(body.filename);
    const bytes = decode(body.dataBase64);
    assertNewFile(body.filename, bytes.byteLength);
    await assertDocumentTags(prisma, request.userId, body.tags);
    const file = await saveFile(
      prisma,
      request.userId,
      { filename: body.filename, mediaType: body.mediaType, bytes },
      { summarize: body.summarize, tags: body.tags },
    );
    return reply.code(201).send({ file, document: { id: file.id, filename: file.filename, parseStatus: file.textStatus } });
  });

  app.get("/api/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: FILE_SELECT });
    if (!row) return notFound(reply);
    resume([row]);
    return { file: fileRecord(row) };
  });

  app.get("/api/documents/:id/original", async (request, reply) => {
    const { id } = request.params as { id: string };
    const head = await prisma.document.findFirst({ where: owned(id, request.userId), select: { filename: true, sha256: true } });
    if (!head) return notFound(reply);
    const etag = `"${head.sha256}"`;
    reply
      .header("ETag", etag)
      .header("Cache-Control", "private, no-cache")
      .header("X-Content-Type-Options", "nosniff")
      // Opened directly, an SVG or HTML file stays inert: no scripts, no requests.
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header("Accept-Ranges", "bytes");
    if (etagMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: { original: true } });
    if (!row) return notFound(reply);
    const bytes = Buffer.from(row.original.buffer, row.original.byteOffset, row.original.byteLength);
    const format = fileFormat(head.filename);
    reply.header("Content-Type", format.kind === "other" ? "application/octet-stream" : format.mime).header("Content-Disposition", contentDisposition(head.filename));
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? "").trim());
    if (range && (range[1] || range[2])) {
      const size = bytes.byteLength;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).send(bytes.subarray(start, end + 1));
    }
    return reply.send(bytes);
  });

  app.get("/api/documents/:id/text", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z
      .object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).default(TEXT_DEFAULT) })
      .parse(request.query);
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: { artifact: { select: { text: true } } } });
    if (!row) return notFound(reply);
    return clip(row.artifact?.text ?? "", query.offset, Math.min(query.limit, TEXT_MAX));
  });

  app.put("/api/documents/:id/content", { bodyLimit: uploadLimit() }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = Replace.parse(request.body);
    if (body.filename !== undefined) {
      checkName(body.filename);
      const kind = fileTypeProblem(body.filename);
      if (kind) throw new FileError(kind, 415);
    }
    const file = await replaceFileBytes(prisma, request.userId, id, { bytes: decode(body.dataBase64), filename: body.filename, mediaType: body.mediaType });
    if (!file) return notFound(reply);
    return { file };
  });

  app.post("/api/documents/:id/cells", async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = Patch.parse(request.body);
    const changes = patch.sheets.reduce((sum, sheet) => sum + (sheet.set?.length ?? 0) + (sheet.deleteRows?.length ?? 0), 0);
    if (changes > CELLS_MAX_CHANGES) return reply.code(400).send({ error: `Save at most ${CELLS_MAX_CHANGES.toLocaleString("en-US")} cell changes at a time.` });
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: { filename: true, byteSize: true } });
    if (!row) return notFound(reply);
    if (fileFormat(row.filename).edit !== "cells") {
      return reply.code(400).send({ error: "Only .xlsx workbooks can be edited cell by cell. Make an .xlsx copy to edit this one." });
    }
    if (row.byteSize > CELLS_MAX_BYTES) {
      return reply.code(413).send({ error: "This workbook is too large to edit here (over 15 MB). Edit it in Excel and upload it again." });
    }
    const current = await prisma.document.findFirstOrThrow({ where: owned(id, request.userId), select: { original: true } });
    const bytes = await patchWorkbook(current.original, patch);
    const file = await replaceFileBytes(prisma, request.userId, id, { bytes }, "document.cells");
    if (!file) return notFound(reply);
    return { file };
  });

  app.post("/api/documents/:id/page", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = MakePage.parse(request.body ?? {});
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: { filename: true, format: true } });
    if (!row) return notFound(reply);
    const format = fileFormat(row.filename);
    let content = body.content;
    if (!content) {
      if (format.toPage === "browser") return reply.code(400).send({ error: `${format.label} files become pages in your browser. Open the file in Ensemble and make the page from there.` });
      if (!serverPageFormat(row.filename)) return reply.code(400).send({ error: "This kind of file cannot become a page." });
      const original = await prisma.document.findFirstOrThrow({ where: owned(id, request.userId), select: { original: true } });
      content = pageFromFile(row.filename, original.original);
    }
    if (body.style) {
      if (body.style.source !== format.ext) return reply.code(400).send({ error: `This formatting was read from a ${body.style.source.toUpperCase()} file, not this one.` });
      await prisma.document.update({ where: { id }, data: { style: body.style as unknown as Prisma.InputJsonValue } });
    }
    const page = await createStandalonePage(prisma, request.userId, { title: body.title?.trim() || pageTitle(row.filename), content, sourceFileId: id });
    await appendLedger({ userId: request.userId, actor: "me", action: "document.page", payload: { id, pageId: page.id, filename: row.filename } });
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
    if (body.style) sseHub.publish(request.userId, { event: "documents", data: { id } });
    return reply.code(201).send({ pageId: page.id });
  });

  app.get("/api/documents/:id/style", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.document.findFirst({ where: owned(id, request.userId), select: { style: true } });
    if (!row) return notFound(reply);
    return { style: fileStyle(row.style) };
  });

  app.patch("/api/documents/:id/tags", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = DocumentTags.parse(request.body);
    const found = await prisma.document.findFirst({ where: owned(id, request.userId), select: { id: true } });
    if (!found) return notFound(reply);
    await assertDocumentTags(prisma, request.userId, body);
    await prisma.document.updateMany({ where: owned(id, request.userId), data: { ...body, manualTags: body } });
    return { ok: true };
  });

  app.delete("/api/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await prisma.$transaction(async (tx) => {
      const row = await tx.document.findFirst({ where: owned(id, request.userId), select: { filename: true, artifactId: true } });
      if (!row) return null;
      const now = new Date();
      await tx.document.update({ where: { id }, data: { deletedAt: now } });
      // The file's text leaves agents and search with it, and comes back if the file is restored.
      if (row.artifactId) await tx.artifact.updateMany({ where: { id: row.artifactId, userId: request.userId, deletedAt: null }, data: { deletedAt: now } });
      return row;
    });
    if (!removed) return notFound(reply);
    await appendLedger({ userId: request.userId, actor: "me", action: "document.delete", payload: { id, filename: removed.filename } });
    sseHub.publish(request.userId, { event: "documents", data: { id } });
    return reply.code(204).send();
  });
}
