/**
 * Index page bodies that the migration left unmarked.
 *
 * The editor document is not a flat list of strings: each block joins its
 * children with a blank or a newline depending on the node type, headings get
 * a hash prefix, and agent blocks get a label. That is `pageSearchText`. A
 * SQL jsonb_path_query would not produce the same text, so this job calls
 * that function instead of a second extractor.
 *
 * `search_text` NULL is the marker. A save writes the text and clears it.
 * Each update matches only rows that are still NULL, so a save that lands
 * during this job is kept.
 *
 * Content that is not a page document is marked with the indexed title only
 * (`pageSearchText(title, null, "")`), under that same guard. The warning is
 * logged once, the row counts as skipped, and the next start does not read it
 * again. A row that throws for another reason, such as a database error, stays
 * NULL and is tried again on the next start.
 *
 * The VM runs this because `infra/deploy/update.sh` applies migrations with
 * `pnpm db:migrate` and then restarts `ensemble-api.service` (`tsx src/index.ts`
 * → `startHub`). `setup.sh` does the same migrate, then starts the service.
 * Both wait on `ready-check.sh` (`GET /health/ready`). The desktop sidecar
 * applies the same SQL in `openDesktopDatabase`, then calls `startHub`.
 * `startHub` listens first and starts this job after, so ready does not wait.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { PageDocument } from "@ensemble/shared-types";
import { pageSearchText } from "./markdown.js";

const BATCH = 200;
const PAUSE_MS = 150;

type BackfillLog = {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
};

export type PageSearchBackfillOptions = {
  batchSize?: number;
  pauseMs?: number;
  signal?: AbortSignal;
  log?: BackfillLog;
  /** Awaited before each batch. Unset resolves immediately. Tests hold this so /health/ready can answer first. */
  gate?: () => Promise<void>;
  /** Test hook. Runs after the text is computed and before the conditional update. */
  beforeWrite?: (row: { id: string }) => Promise<void>;
};

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function indexedTitle(row: { title: string; taskId: string | null; task: { title: string } | null }): string {
  if (row.taskId) return row.title.trim() || row.task?.title || "";
  return row.title;
}

export async function backfillPageSearchText(
  prisma: PrismaClient,
  options: PageSearchBackfillOptions = {},
): Promise<{ updated: number; skipped: number }> {
  const batchSize = options.batchSize ?? BATCH;
  const pauseMs = options.pauseMs ?? PAUSE_MS;
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? { warn: (obj, msg) => console.warn(msg ?? "page search backfill skipped a row", obj) };
  let updated = 0;
  let skipped = 0;
  let cursor: string | null = null;

  while (!signal.aborted) {
    const gate = options.gate ?? (async () => {});
    await Promise.race([gate(), whenAborted(signal)]);
    if (signal.aborted) break;
    const where: Prisma.TaskPageWhereInput = { searchText: null, ...(cursor ? { id: { gt: cursor } } : {}) };
    const rows = await prisma.taskPage.findMany({
      where,
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        title: true,
        taskId: true,
        content: true,
        notesSnapshot: true,
        task: { select: { title: true } },
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        let doc: PageDocument | null = null;
        let titleOnly = false;
        if (row.content != null) {
          const parsed = PageDocument.safeParse(row.content);
          if (!parsed.success) titleOnly = true;
          else doc = parsed.data;
        }
        const text = titleOnly
          ? pageSearchText(indexedTitle(row), null, "")
          : pageSearchText(indexedTitle(row), doc, row.notesSnapshot);
        if (options.beforeWrite) await options.beforeWrite({ id: row.id });
        const changed = await prisma.$executeRaw`
          UPDATE "task_pages"
          SET "search_text" = ${text}
          WHERE "id" = ${row.id} AND "search_text" IS NULL
        `;
        if (titleOnly) {
          skipped += 1;
          log.warn({ pageId: row.id }, "page search backfill skipped a row with content that is not a page");
        } else {
          updated += Number(changed);
        }
      } catch (error) {
        skipped += 1;
        log.warn(
          { pageId: row.id, err: error instanceof Error ? error.message : String(error) },
          "page search backfill skipped a row",
        );
      }
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < batchSize || signal.aborted) break;
    await pause(pauseMs, signal);
  }

  return { updated, skipped };
}

/** Fire-and-forget. Call only after the server is listening. */
export function startPageSearchBackfill(
  prisma: PrismaClient,
  log: BackfillLog & { info?: (obj: unknown, msg?: string) => void },
): { stop: () => void } {
  const ac = new AbortController();
  void backfillPageSearchText(prisma, { signal: ac.signal, log })
    .then((result) => {
      if (ac.signal.aborted) return;
      if (result.updated > 0 || result.skipped > 0) {
        log.info?.({ updated: result.updated, skipped: result.skipped }, "page search backfill finished");
      }
    })
    .catch((error: unknown) => {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, "page search backfill stopped");
    });
  return { stop: () => ac.abort() };
}
