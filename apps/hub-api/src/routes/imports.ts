import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TaskStatus } from "@ensemble/shared-types";
import { prisma } from "../lib/prisma.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";
import { CSV_FIELDS, PRESET_LABEL, type CsvMapping } from "../imports/files/csv.js";
import { MAX_UPLOAD_BYTES, parseUpload, summarizeUpload, uploadItems } from "../imports/files/index.js";
import { createImportHttp } from "../imports/http.js";
import { cancelImport, reconcileStale, serializeJob, startImport, undoImport } from "../imports/jobs.js";
import { sampleRows, statusesFound } from "../imports/preview-data.js";
import { assertPreviewRoom, beginUpload, dropPreview, endUpload, getPreview, savePreview, withUploadSlot, type PreviewEntry } from "../imports/previews.js";
import { API_SOURCES, listSources, resolveAuth, SOURCE_GAP_MS } from "../imports/sources.js";
import { IMPORT_SOURCES, ImportError, SOURCE_LABEL, type ImportItem, type ImportSourceId } from "../imports/types.js";

const SourceId = z.enum(IMPORT_SOURCES);
const Id = z.string().min(1).max(200);
const Credentials = z
  .object({
    token: z.string().trim().max(4000).optional(),
    email: z.string().trim().max(320).optional(),
    site: z.string().trim().max(255).optional(),
    key: z.string().trim().max(200).optional(),
  })
  .strict();
const Options = z.object({ includeCompleted: z.boolean().optional(), mine: z.boolean().optional() }).strict();
const Columns = z.record(Id, z.record(z.enum(CSV_FIELDS), z.array(z.string().max(300)).max(10)));

const PreviewBody = z
  .object({
    source: SourceId.optional(),
    previewId: z.string().uuid().optional(),
    credentials: Credentials.optional(),
    containers: z.array(Id).max(500).optional(),
    columns: Columns.optional(),
    options: Options.optional(),
  })
  .strict()
  .refine((body) => body.source || body.previewId, { message: "Choose a source." });

const StartBody = z
  .object({
    previewId: z.string().uuid().optional(),
    source: SourceId.optional(),
    containers: z.array(Id).min(1, "Choose at least one thing to import.").max(500),
    statusMap: z.record(z.string().max(200), TaskStatus).optional(),
    importAs: z.record(Id, z.enum(["tasks", "pages"])).optional(),
    columns: Columns.optional(),
    options: Options.optional(),
  })
  .strict()
  .refine((body) => body.previewId || body.source, { message: "Start from a preview or name a source." });

const limiter = new MemoryRateLimiter();
const LIMITS = {
  preview: { limit: 60, windowMs: 10 * 60_000 },
  start: { limit: 30, windowMs: 60 * 60_000 },
  undo: { limit: 30, windowMs: 60 * 60_000 },
} as const;

function limited(request: FastifyRequest, reply: FastifyReply, bucket: keyof typeof LIMITS): boolean {
  const { limit, windowMs } = LIMITS[bucket];
  const wait = limiter.take(`${bucket}:${request.userId}`, limit, windowMs);
  if (wait === null) return false;
  reply.header("Retry-After", String(Math.ceil(wait / 1000)));
  void reply.code(429).send({ error: "Too many import requests. Try again in a few minutes." });
  return true;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ImportError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

function columnsFor(entry: PreviewEntry, override?: Record<string, CsvMapping>): Record<string, CsvMapping> {
  const out: Record<string, CsvMapping> = {};
  for (const table of entry.upload?.tables ?? []) out[table.containerId] = override?.[table.containerId] ?? table.mapping;
  return out;
}

function previewPayload(entry: PreviewEntry, items: ImportItem[] | null, columns?: Record<string, CsvMapping>) {
  const current = columnsFor(entry, columns);
  return {
    previewId: entry.id,
    source: entry.upload?.source ?? entry.source,
    sourceLabel: SOURCE_LABEL[entry.upload?.source ?? entry.source],
    via: entry.kind === "file" ? "file" : entry.auth?.via ?? "account",
    format: entry.upload?.format ?? null,
    formatLabel: entry.upload?.formatLabel ?? null,
    fileName: entry.fileName ?? null,
    containers: entry.containers.map((container) => ({ ...container, importAs: container.importAs ?? "tasks" })),
    mapping: {
      fields: CSV_FIELDS,
      tables: (entry.upload?.tables ?? []).map((table) => ({
        containerId: table.containerId,
        headers: table.headers,
        preset: table.preset,
        presetLabel: PRESET_LABEL[table.preset],
        columns: current[table.containerId] ?? table.mapping,
      })),
      statuses: items ? statusesFound(items) : [],
    },
    samples: items ? sampleRows(items) : [],
    summary: {
      containers: entry.containers.length,
      items: items ? items.length : entry.containers.every((container) => typeof container.count === "number") ? entry.containers.reduce((sum, container) => sum + (container.count ?? 0), 0) : null,
      sampled: entry.kind === "api" && items !== null,
    },
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

/** A first page from up to three chosen containers, for samples and status values. */
async function apiSample(entry: PreviewEntry, containerIds: string[], signal: AbortSignal): Promise<ImportItem[]> {
  const source = API_SOURCES[entry.source];
  if (!source || !entry.auth) return [];
  const chosen = entry.containers.filter((container) => containerIds.includes(container.id)).slice(0, 3);
  const http = createImportHttp({ signal, label: SOURCE_LABEL[entry.source], gapMs: SOURCE_GAP_MS[entry.source], maxRetries: 1 });
  const items: ImportItem[] = [];
  for (const container of chosen) {
    let pages = 0;
    for await (const page of source.fetchItems({ auth: entry.auth, http, signal, options: { ...entry.options, preview: true } }, [container])) {
      items.push(...page);
      pages += 1;
      if (pages >= 1 || items.length >= 60) break;
    }
  }
  return items;
}

async function readMultipart(request: FastifyRequest): Promise<{ source: ImportSourceId; name: string; data: Uint8Array }> {
  const body = request.body;
  if (!Buffer.isBuffer(body)) throw new ImportError("Upload the export as a file.");
  const form = await new Response(body, { headers: { "content-type": String(request.headers["content-type"] ?? "") } })
    .formData()
    .catch(() => {
      throw new ImportError("That upload could not be read. Try again.");
    });
  const file = form.get("file");
  if (!file || typeof file === "string") throw new ImportError("Attach the export file.");
  const source = SourceId.safeParse(String(form.get("source") ?? "csv"));
  if (!source.success) throw new ImportError("Choose a source.");
  if (file.size > MAX_UPLOAD_BYTES) throw new ImportError("That file is larger than 50 MB. Export a smaller part and import each.", 413);
  return { source: source.data, name: (file.name || "export").slice(0, 300), data: new Uint8Array(await file.arrayBuffer()) };
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  const uploadSlots = new WeakSet<FastifyRequest>();
  // Scoped to this plugin: uploads arrive as one buffer, read with the platform FormData parser.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024 }, (_request, body, done) => done(null, body));

  app.addHook("preHandler", async (request) => {
    await requireVerifiedUser(request.userId);
  });

  app.get("/api/imports/sources", async (request) => ({ sources: await listSources(request.userId) }));

  const isUpload = (request: FastifyRequest) => String(request.headers["content-type"] ?? "").startsWith("multipart/form-data");

  app.post(
    "/api/imports/preview",
    {
      bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024,
      // Claim the person's upload slot before Fastify buffers up to 50 MB of body.
      onRequest: async (request, reply) => {
        if (!isUpload(request) || !request.userId) return;
        if (!beginUpload(request.userId)) {
          return reply.code(429).send({ error: "Ensemble is still reading your last upload. Wait a moment and try again." });
        }
        uploadSlots.add(request);
      },
      onResponse: async (request) => {
        if (uploadSlots.delete(request)) endUpload(request.userId);
      },
    },
    async (request, reply) => {
    if (limited(request, reply, "preview")) return reply;
    const userId = request.userId;
    try {
      if (isUpload(request)) {
        const upload = await readMultipart(request);
        assertPreviewRoom(userId, upload.data.byteLength);
        const parsed = parseUpload(upload.name, upload.data, upload.source);
        const items = uploadItems(parsed, new Set(parsed.containers.map((container) => container.id)));
        const entry = savePreview({
          userId,
          source: parsed.source,
          kind: "file",
          options: {},
          containers: parsed.containers,
          file: { name: upload.name, data: upload.data, hint: upload.source },
          upload: summarizeUpload(parsed),
          fileName: upload.name,
        });
        return previewPayload(entry, items);
      }
      const body = PreviewBody.parse(request.body ?? {});
      const signal = AbortSignal.timeout(60_000);
      if (body.previewId) {
        const entry = getPreview(userId, body.previewId);
        if (!entry) return reply.code(404).send({ error: "That preview expired. Start the import again." });
        if (body.options) entry.options = { ...entry.options, ...body.options };
        const chosen = body.containers ?? entry.containers.map((container) => container.id);
        const file = entry.file;
        if (file) {
          const items = await withUploadSlot(userId, () => uploadItems(parseUpload(file.name, file.data, file.hint), new Set(chosen), columnsFor(entry, body.columns)));
          return previewPayload(entry, items, body.columns);
        }
        return previewPayload(entry, body.containers ? await apiSample(entry, chosen, signal) : null);
      }
      const source = body.source!;
      if (!API_SOURCES[source]) return reply.code(400).send({ error: `${SOURCE_LABEL[source]} imports from a file. Upload the export.` });
      const auth = await resolveAuth(userId, source, body.credentials);
      const http = createImportHttp({ signal, label: SOURCE_LABEL[source], gapMs: SOURCE_GAP_MS[source], maxRetries: 1 });
      const options = body.options ?? {};
      const containers = await API_SOURCES[source]!.listContainers({ auth, http, signal, options });
      if (!containers.length) {
        return reply.code(404).send({ error: `${SOURCE_LABEL[source]} returned nothing this token can read. Check its access and try again.` });
      }
      const entry = savePreview({ userId, source, kind: "api", auth, options, containers });
      return previewPayload(entry, body.containers ? await apiSample(entry, body.containers, signal) : null);
    } catch (error) {
      return sendError(reply, error);
    }
    },
  );

  app.post("/api/imports", async (request, reply) => {
    if (limited(request, reply, "start")) return reply;
    const body = StartBody.parse(request.body ?? {});
    const userId = request.userId;
    try {
      let entry: PreviewEntry | null = null;
      if (body.previewId) {
        entry = getPreview(userId, body.previewId);
        if (!entry) return reply.code(404).send({ error: "That preview expired. Start the import again." });
      } else {
        const source = body.source!;
        if (!API_SOURCES[source]) return reply.code(400).send({ error: `${SOURCE_LABEL[source]} imports from a file. Upload the export first.` });
        const auth = await resolveAuth(userId, source);
        const signal = AbortSignal.timeout(60_000);
        const http = createImportHttp({ signal, label: SOURCE_LABEL[source], gapMs: SOURCE_GAP_MS[source], maxRetries: 1 });
        const containers = await API_SOURCES[source]!.listContainers({ auth, http, signal, options: body.options ?? {} });
        entry = savePreview({ userId, source, kind: "api", auth, options: body.options ?? {}, containers });
      }
      const known = new Set(entry.containers.map((container) => container.id));
      const unknown = body.containers.filter((id) => !known.has(id));
      if (unknown.length) return reply.code(400).send({ error: "Some of the chosen items are not in this preview. Refresh the list and choose again." });
      const job = await startImport(prisma, userId, {
        preview: entry,
        containerIds: body.containers,
        statusMap: body.statusMap ?? {},
        importAs: body.importAs ?? {},
        columns: columnsFor(entry, body.columns),
        options: { ...entry.options, ...(body.options ?? {}) },
      });
      // The running job keeps the bytes it needs; the preview does not hold a second reference for 30 minutes.
      if (entry.file) dropPreview(entry.id);
      return reply.code(202).send({ job: serializeJob(job) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/imports", async (request) => {
    await reconcileStale(prisma, request.userId);
    const jobs = await prisma.importJob.findMany({ where: { userId: request.userId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { jobs: jobs.map(serializeJob) };
  });

  app.get("/api/imports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await reconcileStale(prisma, request.userId);
    const job = await prisma.importJob.findFirst({ where: { id, userId: request.userId } });
    if (!job) return reply.code(404).send({ error: "Import not found." });
    return { job: serializeJob(job) };
  });

  app.post("/api/imports/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await cancelImport(prisma, request.userId, id);
    if (!job) return reply.code(404).send({ error: "Import not found." });
    return { job: serializeJob(job) };
  });

  app.post("/api/imports/:id/undo", async (request, reply) => {
    if (limited(request, reply, "undo")) return reply;
    const { id } = request.params as { id: string };
    try {
      const job = await undoImport(prisma, request.userId, id);
      if (!job) return reply.code(404).send({ error: "Import not found." });
      return { job: serializeJob(job) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
