import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { MODULE_DENIED, moduleForPath, hasModule } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { estimateUsd, providerFor } from "../lib/pricing.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";

const DAY = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  app.addHook("preHandler", async (request, reply) => {
    const needed = moduleForPath(request.routeOptions.url ?? "");
    if (needed && !hasModule(request.modules, needed)) return reply.code(404).send({ error: MODULE_DENIED });
  });

  // ── runs ────────────────────────────────────────────────────────────────

  app.get("/api/runs", async (request) => {
    const { take } = z.object({ take: z.coerce.number().int().min(0).default(20) }).parse(request.query);
    const runs = await prisma.run.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: { startedAt: "desc" },
      take: Math.min(take, 200),
      include: {
        task: { select: { id: true, title: true } },
        steps: { select: { model: true, credits: true, status: true } },
      },
    });
    const total = await prisma.run.count({ where: { userId: request.userId, deletedAt: null } });
    return {
      total,
      runs: runs.map((run) => {
        const credits = run.steps.reduce<number | null>(
          (sum, step) => (sum === null || step.credits === null ? null : sum + step.credits),
          run.plannerCredits,
        );
        return {
          id: run.id,
          taskId: run.taskId,
          title: run.task.title,
          worker: run.worker,
          outcome: run.outcome,
          error: run.error,
          model: run.requestedModel ?? run.plannerModel ?? run.steps.find((step) => step.model)?.model ?? null,
          credits,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
          stepCount: run.steps.length,
        };
      }),
    };
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await prisma.run.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
      include: {
        task: { select: { id: true, title: true } },
        steps: { orderBy: { index: "asc" } },
        approvals: { orderBy: { requestedAt: "asc" } },
      },
    });
    if (!run) return reply.code(404).send({ error: "Run not found." });
    return { run };
  });

  app.delete("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.run.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!result.count) return reply.code(404).send({ error: "Run not found." });
    return reply.code(204).send();
  });

  // ── metrics ─────────────────────────────────────────────────────────────

  app.get("/api/metrics/summary", async (request) => {
    const userId = request.userId;
    const since = new Date(Date.now() - 14 * DAY);
    const [steps, notes, usageEvents, baselines, events, approvals, runs, ledgerCount, waiting] = await Promise.all([
      prisma.runStep.findMany({
        where: { run: { userId }, startedAt: { gte: since } },
        select: { model: true, credits: true, tokensIn: true, tokensOut: true, startedAt: true, run: { select: { task: { select: { title: true } } } } },
        orderBy: { startedAt: "desc" },
        take: 400,
      }),
      prisma.meetingNote.findMany({
        where: { userId, extractedAt: { gte: since } },
        select: { extractionModel: true, extractedAt: true, title: true, extraction: true },
        take: 200,
      }),
      prisma.metricEvent.findMany({
        where: { userId, kind: "model.call", ts: { gte: since } },
        select: { ts: true, payload: true },
        orderBy: { ts: "desc" },
        take: 400,
      }),
      prisma.metricBaseline.findMany({ where: { userId } }),
      prisma.metricEvent.groupBy({
        by: ["kind"],
        where: { userId, ts: { gte: since } },
        _count: true,
        _avg: { seconds: true },
      }),
      prisma.approval.groupBy({ by: ["decision"], where: { userId }, _count: true }),
      prisma.run.findMany({
        where: { userId, startedAt: { gte: since } },
        select: { startedAt: true, endedAt: true, outcome: true },
        orderBy: { startedAt: "desc" },
        take: 200,
      }),
      prisma.auditLedger.count({ where: { userId } }),
      prisma.approval.count({ where: { userId, decision: null } }),
    ]);

    type Call = {
      title: string;
      purpose: string;
      provider: string;
      model: string;
      tokensIn: number | null;
      tokensOut: number | null;
      estimatedUsd: number | null;
      at: Date;
    };
    const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const text = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback);
    const fromEvent = (payload: unknown, at: Date): Call => {
      const row = (payload ?? {}) as Record<string, unknown>;
      const model = text(row.model, "unknown");
      const tokensIn = num(row.tokensIn);
      const tokensOut = num(row.tokensOut);
      return {
        title: text(row.title, "Model call"),
        purpose: text(row.purpose, "Other"),
        provider: providerFor(model, typeof row.provider === "string" ? row.provider : null),
        model,
        tokensIn,
        tokensOut,
        estimatedUsd: num(row.estimatedUsd) ?? estimateUsd(model, tokensIn, tokensOut),
        at,
      };
    };
    const recorded = usageEvents
      .map((event) => fromEvent(event.payload, event.ts))
      .filter((call) => call.tokensIn != null || call.tokensOut != null);
    const coveredKeys = new Set<string>();
    for (const call of recorded) {
      const bucket = Math.floor(call.at.getTime() / 20_000);
      coveredKeys.add(`${call.purpose}:${bucket - 1}`);
      coveredKeys.add(`${call.purpose}:${bucket}`);
      coveredKeys.add(`${call.purpose}:${bucket + 1}`);
    }
    const covered = (at: Date, purpose: string) => coveredKeys.has(`${purpose}:${Math.floor(at.getTime() / 20_000)}`);
    const priced = (model: string, tokensIn: number | null, tokensOut: number | null, at: Date, title: string, purpose: string): Call | null => {
      if (tokensIn == null && tokensOut == null) return null;
      const provider = providerFor(model);
      if (provider === "unknown") return null;
      return { title, purpose, provider, model, tokensIn, tokensOut, estimatedUsd: estimateUsd(model, tokensIn, tokensOut), at };
    };
    const calls: Call[] = [
      ...recorded,
      ...steps
        .filter((step) => !covered(step.startedAt ?? new Date(0), "Delegated tasks"))
        .map((step) => priced(step.model ?? "", step.tokensIn, step.tokensOut, step.startedAt ?? new Date(0), step.run.task.title, "Delegated tasks")),
      ...notes
        .filter((note) => !covered(note.extractedAt ?? new Date(0), "Meeting extraction"))
        .map((note) => {
          const extraction = (note.extraction ?? {}) as Record<string, unknown>;
          return priced(
            note.extractionModel ?? "",
            num(extraction.tokensIn),
            num(extraction.tokensOut),
            note.extractedAt ?? new Date(0),
            note.title,
            "Meeting extraction",
          );
        }),
    ]
      .filter((call): call is Call => call != null)
      .sort((a, b) => b.at.getTime() - a.at.getTime());

    const days: Array<{ day: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }> = [];
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      days.push({ day, calls: 0, tokensIn: 0, tokensOut: 0, estimatedUsd: null });
    }
    const byModel = new Map<string, { provider: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }>();
    const byPurpose = new Map<string, { calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }>();
    const addUsd = (current: number | null, next: number | null) => (next == null ? current : (current ?? 0) + next);
    for (const call of calls) {
      const day = days.find((row) => row.day === call.at.toISOString().slice(0, 10));
      if (day) {
        day.calls += 1;
        day.tokensIn += call.tokensIn ?? 0;
        day.tokensOut += call.tokensOut ?? 0;
        day.estimatedUsd = addUsd(day.estimatedUsd, call.estimatedUsd);
      }
      const model = byModel.get(call.model) ?? { provider: call.provider, calls: 0, tokensIn: 0, tokensOut: 0, estimatedUsd: null };
      model.calls += 1;
      model.tokensIn += call.tokensIn ?? 0;
      model.tokensOut += call.tokensOut ?? 0;
      model.estimatedUsd = addUsd(model.estimatedUsd, call.estimatedUsd);
      if (call.provider !== "unknown") model.provider = call.provider;
      byModel.set(call.model, model);
      const purpose = byPurpose.get(call.purpose) ?? { calls: 0, tokensIn: 0, tokensOut: 0, estimatedUsd: null };
      purpose.calls += 1;
      purpose.tokensIn += call.tokensIn ?? 0;
      purpose.tokensOut += call.tokensOut ?? 0;
      purpose.estimatedUsd = addUsd(purpose.estimatedUsd, call.estimatedUsd);
      byPurpose.set(call.purpose, purpose);
    }

    const durations = runs
      .filter((run) => run.endedAt)
      .map((run) => (run.endedAt!.getTime() - run.startedAt.getTime()) / 60000);
    const decided = Object.fromEntries(approvals.map((row) => [row.decision ?? "pending", row._count]));

    return {
      days,
      byModel: [...byModel.entries()].map(([model, row]) => ({ model, ...row })).sort((a, b) => b.calls - a.calls),
      byPurpose: [...byPurpose.entries()].map(([purpose, row]) => ({ purpose, ...row })),
      recent: calls.slice(0, 40).map((call) => ({ ...call, at: call.at.toISOString() })),
      providers: [...new Set(calls.map((call) => call.provider))].sort(),
      baselines: baselines.map((row) => {
        const current = events.find((event) => event.kind === row.kind);
        return {
          kind: row.kind,
          baselineSeconds: row.seconds,
          sampleSize: row.sampleSize,
          note: row.note,
          currentSeconds: current?._avg.seconds ?? null,
          observations: current?._count ?? 0,
        };
      }),
      events: events.map((event) => ({ kind: event.kind, count: event._count, avgSeconds: event._avg.seconds })),
      throughput: {
        completed: runs.filter((run) => run.outcome === "success").length,
        failed: runs.filter((run) => run.outcome === "failed").length,
        medianMinutes: median(durations),
        waitingOnYou: waiting,
      },
      trust: {
        approved: decided.approved ?? 0,
        edited: decided.edited ?? 0,
        rejected: decided.rejected ?? 0,
      },
      governance: { ledgerEntries: ledgerCount },
    };
  });

  app.post("/api/ledger/verify", async (request) => {
    const rows = await prisma.auditLedger.findMany({
      where: { userId: request.userId },
      orderBy: { ts: "asc" },
      select: { id: true, hash: true, prevHash: true, ts: true },
    });
    let previous: string | null = null;
    for (const row of rows) {
      if ((row.prevHash ?? null) !== previous) {
        return { ok: false, checked: rows.length, brokenAt: row.id, at: row.ts.toISOString() };
      }
      previous = row.hash;
    }
    return { ok: true, checked: rows.length };
  });
}
