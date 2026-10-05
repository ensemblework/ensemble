/**
 * Picks up documents whose summary was queued and finishes them.
 * Same shape as the other in-process workers: a short poll, plus a kick
 * from the upload route so a new file does not wait for the next tick.
 */
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { complete } from "../lib/runtime.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { enrichOne, type SummaryOutcome, type SummaryRow, type SummaryStore } from "./summarize.js";

const STALE_MS = 120_000;

export async function enrichDocument(app: FastifyInstance, id: string): Promise<SummaryOutcome | null> {
  const outcome = await enrichOne(prismaStore(app), id, (prompt) => ask(app, id, prompt));
  if (outcome) {
    const row = await app.prisma.document.findUnique({ where: { id }, select: { userId: true } });
    if (row) sseHub.publish(row.userId, { event: "documents", data: { id } });
  }
  return outcome;
}

export async function drainDocumentEnrichment(app: FastifyInstance): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const stale = await app.prisma.document.findMany({
    where: { deletedAt: null, enrichmentStatus: "running", updatedAt: { lt: staleBefore } },
    select: { id: true, userId: true },
    take: 8,
  });
  for (const row of stale) {
    await app.prisma.document.updateMany({
      where: { id: row.id, enrichmentStatus: "running" },
      data: {
        enrichmentStatus: "failed",
        enrichmentError: { message: "The summary was interrupted. Upload the file again to retry." },
      },
    });
    sseHub.publish(row.userId, { event: "documents", data: { id: row.id } });
  }
  const queued = await app.prisma.document.findMany({
    where: { deletedAt: null, enrichmentStatus: "queued" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 4,
  });
  for (const row of queued) {
    await enrichDocument(app, row.id);
  }
}

export function startDocumentEnrichment(app: FastifyInstance): () => void {
  if (process.env.ENSEMBLE_DOCUMENT_ENRICHMENT === "off") return () => undefined;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    drainDocumentEnrichment(app)
      .catch((error: unknown) => app.log.error({ err: error }, "document summary failed"))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(run, 1500);
  timer.unref();
  run();
  return () => clearInterval(timer);
}

function prismaStore(app: FastifyInstance): SummaryStore {
  return {
    async claim(id: string): Promise<SummaryRow | null> {
      const claimed = await app.prisma.document.updateMany({
        where: { id, deletedAt: null, enrichmentStatus: "queued" },
        data: { enrichmentStatus: "running", enrichmentAttempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;
      const row = await app.prisma.document.findUnique({
        where: { id },
        select: { id: true, filename: true, artifact: { select: { text: true } } },
      });
      if (!row) return null;
      return { id: row.id, filename: row.filename, text: row.artifact?.text ?? "" };
    },
    async finish(id: string, outcome: SummaryOutcome): Promise<void> {
      if (outcome.status === "done") {
        await app.prisma.document.updateMany({
          where: { id, enrichmentStatus: "running" },
          data: { enrichmentStatus: "done", summary: outcome.summary, enrichedAt: new Date(), enrichmentError: Prisma.DbNull },
        });
        return;
      }
      await app.prisma.document.updateMany({
        where: { id, enrichmentStatus: "running" },
        data: { enrichmentStatus: "failed", enrichmentError: { message: outcome.message }, enrichedAt: new Date() },
      });
    },
  };
}

async function ask(app: FastifyInstance, id: string, prompt: string): Promise<string> {
  const row = await app.prisma.document.findUnique({ where: { id }, select: { userId: true } });
  if (!row) throw new Error("That document was not found.");
  const settings = await loadSettings(app.prisma, row.userId);
  const answer = await complete({
    userId: row.userId,
    settings,
    tier: "easy",
    prompt,
    purpose: "Document summary",
  });
  return answer.text;
}
