/**
 * Import jobs run in this process, in the background. Each batch of about a
 * hundred items is one transaction, and the job row records counts and the
 * ids it created after every batch, so progress is visible, a cancel stops
 * cleanly between batches, and "Undo this import" knows what to remove.
 */
import type { ImportJob, Prisma, PrismaClient, TaskStatus } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { CREATED_CAP, newWriterState, writeBatch, type CreatedIds } from "./apply.js";
import { parseUpload, uploadItems } from "./files/index.js";
import type { CsvMapping } from "./files/csv.js";
import { createImportHttp } from "./http.js";
import type { PreviewEntry } from "./previews.js";
import { API_SOURCES, SOURCE_GAP_MS } from "./sources.js";
import {
  emptyCounts,
  ImportError,
  SOURCE_KIND,
  SOURCE_LABEL,
  type ImportAs,
  type ImportContainer,
  type ImportCounts,
  type ImportItem,
  type ImportSourceId,
  type SourceOptions,
  type WritePlan,
} from "./types.js";

export const BATCH_SIZE = 100;
export const MAX_ITEMS = 20_000;
const ACTIVE = ["queued", "running", "cancelling"];
const HEARTBEAT_MS = 30_000;
const STALE_MS = 2 * 60_000;

export interface StartImportInput {
  preview: PreviewEntry;
  containerIds: string[];
  statusMap: Record<string, TaskStatus>;
  importAs: Record<string, ImportAs>;
  columns: Record<string, CsvMapping>;
  options: SourceOptions;
}

export interface JobProgress {
  phase: "starting" | "fetching" | "writing" | "finished";
  fetched: number;
  written: number;
  total: number | null;
  created: CreatedIds;
  projects: Array<{ id: string; name: string }>;
  labels: string[];
  note?: string;
  undone?: { tasks: number; pages: number; projects: number; at: string };
}

type Running = { controller: AbortController; userId: string };
const running = new Map<string, Running>();

/** For tests: resolves when no import is running in this process. */
export async function importsIdle(timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (running.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
}

function emptyProgress(): JobProgress {
  return { phase: "starting", fetched: 0, written: 0, total: null, created: { tasks: [], pages: [], projects: [], truncated: false }, projects: [], labels: [] };
}

export function serializeJob(job: ImportJob) {
  const progress = (job.progress ?? {}) as Partial<JobProgress>;
  const options = (job.options ?? {}) as Record<string, unknown>;
  return {
    id: job.id,
    source: job.source,
    sourceLabel: SOURCE_LABEL[job.source as ImportSourceId] ?? job.source,
    status: job.status,
    error: job.error,
    counts: job.counts as unknown as ImportCounts,
    progress: {
      phase: progress.phase ?? "starting",
      fetched: progress.fetched ?? 0,
      written: progress.written ?? 0,
      total: progress.total ?? null,
      note: progress.note ?? null,
      created: {
        tasks: progress.created?.tasks.length ?? 0,
        pages: progress.created?.pages.length ?? 0,
        projects: progress.created?.projects.length ?? 0,
      },
      undone: progress.undone ?? null,
    },
    links: {
      projects: progress.projects ?? [],
      labels: progress.labels ?? [],
      pages: (progress.created?.pages ?? []).slice(0, 10),
    },
    containers: (options.containers as Array<{ id: string; name: string }> | undefined) ?? [],
    fileName: (options.fileName as string | undefined) ?? null,
    canUndo: ["done", "failed", "cancelled", "interrupted"].includes(job.status) && !progress.undone,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

/** Jobs left "running" by a process that stopped. Called on reads, so no boot hook is needed. */
export async function reconcileStale(prisma: PrismaClient, userId: string): Promise<void> {
  // Running jobs touch updated_at every 30 s; older than that means no process owns them any more.
  const stale = await prisma.importJob.findMany({
    where: { userId, status: { in: ACTIVE }, updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
    select: { id: true },
  });
  const orphans = stale.filter((job) => !running.has(job.id)).map((job) => job.id);
  if (!orphans.length) return;
  await prisma.importJob.updateMany({
    where: { id: { in: orphans }, userId, status: { in: ACTIVE } },
    data: { status: "interrupted", finishedAt: new Date(), error: "Ensemble restarted before this import finished. Run it again: it updates what came over and adds the rest, without copies." },
  });
}

export function planFor(preview: PreviewEntry, statusMap: Record<string, TaskStatus>, importAs: Record<string, ImportAs>): WritePlan {
  const upload = preview.upload;
  const source = upload?.source ?? preview.source;
  return {
    externalSource: upload?.externalSource ?? preview.source,
    sourceKind: SOURCE_KIND[source],
    sourceLabel: SOURCE_LABEL[source],
    statusMap: Object.fromEntries(Object.entries(statusMap).map(([key, value]) => [key.trim().toLowerCase(), value])),
    importAs,
  };
}

export async function startImport(prisma: PrismaClient, userId: string, input: StartImportInput): Promise<ImportJob> {
  const { preview } = input;
  const chosen = new Set(input.containerIds);
  const containers = preview.containers.filter((container) => chosen.has(container.id));
  if (!containers.length) throw new ImportError("Choose at least one thing to import.");
  await reconcileStale(prisma, userId);
  const active = await prisma.importJob.count({ where: { userId, status: { in: ACTIVE } } });
  if (active) throw new ImportError("An import is already running. Wait for it to finish or cancel it first.", 409);
  const importAs: Record<string, ImportAs> = {};
  for (const container of containers) importAs[container.id] = input.importAs[container.id] ?? container.importAs ?? "tasks";
  const plan = planFor(preview, input.statusMap, importAs);
  const total = containers.every((container) => typeof container.count === "number") ? containers.reduce((sum, container) => sum + (container.count ?? 0), 0) : null;
  const job = await prisma.importJob.create({
    data: {
      userId,
      source: preview.upload?.source ?? preview.source,
      status: "running",
      startedAt: new Date(),
      options: {
        containers: containers.map((container) => ({ id: container.id, name: container.name, kind: container.kind })),
        statusMap: plan.statusMap,
        importAs,
        includeCompleted: input.options.includeCompleted !== false,
        via: preview.kind === "file" ? "file" : preview.auth?.via ?? "account",
        externalSource: plan.externalSource,
        ...(preview.fileName ? { fileName: preview.fileName.slice(0, 200), format: preview.upload?.format } : {}),
      } as Prisma.InputJsonValue,
      counts: emptyCounts() as unknown as Prisma.InputJsonValue,
      progress: { ...emptyProgress(), total } as unknown as Prisma.InputJsonValue,
    },
  });
  const controller = new AbortController();
  running.set(job.id, { controller, userId });
  void runJob(prisma, job.id, userId, plan, input, containers, controller.signal).finally(() => running.delete(job.id));
  return job;
}

async function* itemsFor(input: StartImportInput, containers: ImportContainer[], signal: AbortSignal): AsyncGenerator<ImportItem[]> {
  const { preview } = input;
  if (preview.file) {
    // Parsed here, from the bytes the preview kept, so no parsed copy waits in memory between preview and import.
    const items = uploadItems(parseUpload(preview.file.name, preview.file.data, preview.file.hint), new Set(containers.map((container) => container.id)), input.columns);
    while (items.length) yield items.splice(0, BATCH_SIZE);
    return;
  }
  const source = API_SOURCES[preview.source];
  if (!source || !preview.auth) throw new ImportError("This source cannot be imported over its API.");
  const http = createImportHttp({ signal, label: SOURCE_LABEL[preview.source], gapMs: SOURCE_GAP_MS[preview.source] });
  yield* source.fetchItems({ auth: preview.auth, http, signal, options: { ...preview.options, ...input.options, preview: false } }, containers);
}

async function runJob(
  prisma: PrismaClient,
  jobId: string,
  userId: string,
  plan: WritePlan,
  input: StartImportInput,
  containers: ImportContainer[],
  signal: AbortSignal,
): Promise<void> {
  const counts = emptyCounts();
  const state = newWriterState(userId, plan, counts);
  const progress: JobProgress = emptyProgress();
  progress.created = state.created;
  progress.total = containers.every((container) => typeof container.count === "number") ? containers.reduce((sum, container) => sum + (container.count ?? 0), 0) : null;
  const labels = new Map<string, number>();
  let buffer: ImportItem[] = [];
  let status = "done";
  let error: string | null = null;

  const save = async (extra: Partial<ImportJob> = {}) => {
    progress.projects = await touchedProjects(prisma, userId, [...new Set(state.projects.values())]);
    progress.labels = [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label]) => label);
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        counts: counts as unknown as Prisma.InputJsonValue,
        progress: progress as unknown as Prisma.InputJsonValue,
        ...extra,
      } as Prisma.ImportJobUpdateInput,
    });
  };
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    progress.phase = "writing";
    await writeBatch(prisma, state, batch);
    progress.written += batch.length;
    for (const item of batch) for (const label of item.labels ?? []) labels.set(label, (labels.get(label) ?? 0) + 1);
    await save();
    sseHub.publish(userId, { event: "task", data: { action: "import", jobId } });
  };

  const heartbeat = setInterval(() => {
    void prisma.importJob.updateMany({ where: { id: jobId, status: { in: ACTIVE } }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    progress.phase = "fetching";
    for await (const page of itemsFor(input, containers, signal)) {
      if (signal.aborted) break;
      for (const item of page) {
        if (progress.fetched >= MAX_ITEMS) break;
        buffer.push(item);
        progress.fetched += 1;
        if (buffer.length >= BATCH_SIZE) await flush();
      }
      if (progress.fetched >= MAX_ITEMS) {
        progress.note = `Stopped at ${MAX_ITEMS.toLocaleString("en")} items, the most one import takes. Import the remaining projects or boards in another run.`;
        break;
      }
      await flush();
    }
    if (!signal.aborted) await flush();
    if (signal.aborted) status = "cancelled";
  } catch (caught) {
    if (signal.aborted) status = "cancelled";
    else {
      status = "failed";
      error = caught instanceof ImportError ? caught.message : "The import stopped on an error. What came over is kept; run it again to continue.";
    }
  }
  clearInterval(heartbeat);
  progress.phase = "finished";
  if (state.created.truncated) progress.note = [progress.note, `More than ${CREATED_CAP} items were created; undo also removes rows this import created by time.`].filter(Boolean).join(" ");
  await save({ status, error, finishedAt: new Date() }).catch(() => undefined);
  sseHub.publish(userId, { event: "task", data: { action: "import", jobId } });
  sseHub.publish(userId, { event: "context", data: { action: "import", jobId } });
  await appendLedger({
    userId,
    actor: "me",
    action: "import.run",
    payload: { jobId, source: plan.externalSource, status, counts } as unknown as Prisma.InputJsonValue,
  }).catch(() => undefined);
}

async function touchedProjects(prisma: PrismaClient, userId: string, ids: string[]): Promise<Array<{ id: string; name: string }>> {
  if (!ids.length) return [];
  const rows = await prisma.project.findMany({ where: { userId, id: { in: ids.slice(0, 50) }, deletedAt: null }, select: { id: true, name: true }, take: 20 });
  return rows;
}

export async function cancelImport(prisma: PrismaClient, userId: string, jobId: string): Promise<ImportJob | null> {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, userId } });
  if (!job) return null;
  const live = running.get(jobId);
  if (live && live.userId === userId) {
    live.controller.abort();
    return prisma.importJob.update({ where: { id: jobId }, data: { status: "cancelling" } });
  }
  if (ACTIVE.includes(job.status)) {
    return prisma.importJob.update({ where: { id: jobId }, data: { status: "cancelled", finishedAt: new Date() } });
  }
  return job;
}

export async function undoImport(prisma: PrismaClient, userId: string, jobId: string): Promise<ImportJob | null> {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, userId } });
  if (!job) return null;
  if (ACTIVE.includes(job.status) && running.has(jobId)) throw new ImportError("Cancel the import before undoing it.", 409);
  const progress = (job.progress ?? {}) as Partial<JobProgress>;
  if (progress.undone) throw new ImportError("This import was already undone.", 409);
  const created = progress.created ?? { tasks: [], pages: [], projects: [], truncated: false };
  const options = (job.options ?? {}) as Record<string, unknown>;
  const externalSource = typeof options.externalSource === "string" ? options.externalSource : job.source;
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const tasks = await tx.task.updateMany({ where: { userId, id: { in: created.tasks }, deletedAt: null }, data: { deletedAt: now } });
    let extraTasks = 0;
    if (created.truncated && job.startedAt) {
      const more = await tx.task.updateMany({
        where: { userId, externalSource, deletedAt: null, createdAt: { gte: job.startedAt, lte: job.finishedAt ?? now } },
        data: { deletedAt: now },
      });
      extraTasks = more.count;
    }
    const pages = await tx.taskPage.deleteMany({ where: { userId, id: { in: created.pages }, taskId: null } });
    const projects = await tx.project.updateMany({ where: { userId, id: { in: created.projects }, deletedAt: null }, data: { deletedAt: now } });
    const undone = { tasks: tasks.count + extraTasks, pages: pages.count, projects: projects.count, at: now.toISOString() };
    return tx.importJob.update({
      where: { id: jobId },
      data: { status: "undone", progress: { ...progress, undone } as unknown as Prisma.InputJsonValue },
    });
  });
  sseHub.publish(userId, { event: "task", data: { action: "import-undo", jobId } });
  sseHub.publish(userId, { event: "context", data: { action: "import-undo", jobId } });
  await appendLedger({ userId, actor: "me", action: "import.undo", payload: { jobId } }).catch(() => undefined);
  return result;
}
