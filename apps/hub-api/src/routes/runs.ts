import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { MODULE_DENIED, moduleForPath, hasModule } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { estimateUsd, providerFor } from "../lib/pricing.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { isHosted } from "../lib/hosted-access.js";
import { createJob, Assign } from "../workspace/assign.js";
import { repeatAssignment } from "../workspace/repeat.js";
import { runnerRefusal } from "./agents.js";
import { isPaused } from "../lib/activity.js";
import { actorFor } from "../sharing/context.js";

const DAY = 24 * 60 * 60 * 1000;

const JOB_FACTS = {
  context: true,
  id: true,
  kind: true,
  status: true,
  userId: true,
  runnerAccountId: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  executionMode: true,
  networkAccess: true,
  delivery: true,
  accessMode: true,
  unattended: true,
  folderLabel: true,
  repoUrl: true,
  branch: true,
  turns: true,
  toolCalls: true,
  tokensIn: true,
  tokensOut: true,
  maxTurns: true,
  maxToolCalls: true,
  maxMinutes: true,
  evidence: true,
  results: true,
  deviceId: true,
  device: { select: { name: true } },
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

type JobFactsRow = {
  context: unknown;
  id: string;
  kind: string;
  status: string;
  userId: string;
  runnerAccountId: string | null;
  provider: string | null;
  model: string;
  reasoningEffort: string | null;
  executionMode: string;
  networkAccess: boolean;
  delivery: string;
  accessMode: string;
  unattended: boolean;
  folderLabel: string | null;
  repoUrl: string | null;
  branch: string;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  maxTurns: number;
  maxToolCalls: number;
  maxMinutes: number;
  evidence: unknown;
  results: unknown;
  deviceId: string | null;
  device: { name: string } | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

const ENGINES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "cursor-agent": "Cursor" };

/**
 * The agent job behind a run, as the run page shows it: which harness ran it, the model asked for and
 * the one that answered, where it ran and under what limits, and what it cost. No paths on this server.
 */
function jobFacts(job: JobFactsRow) {
  const evidence = (job.evidence && typeof job.evidence === "object" && !Array.isArray(job.evidence) ? job.evidence : {}) as Record<string, unknown>;
  const engine = job.kind === "code" && job.provider && ENGINES[job.provider] ? job.provider : "ensemble";
  const mine = (job.runnerAccountId ?? null) === actorFor(job.userId);
  return {
    sourceRunId: typeof (job.context as Record<string, unknown> | null)?.feedbackOnRun === "string" ? (job.context as Record<string, unknown>).feedbackOnRun as string : null,
    id: job.id,
    kind: job.kind,
    status: job.status,
    engine,
    engineName: ENGINES[engine] ?? "Ensemble agent",
    provider: engine === "ensemble" ? job.provider : null,
    model: job.model,
    modelUsed: typeof evidence.model === "string" && evidence.model ? evidence.model : null,
    reasoningEffort: job.reasoningEffort,
    where: job.deviceId ? "device" : isHosted() ? "server" : "local",
    deviceName: job.deviceId && mine ? (job.device?.name ?? null) : null,
    runnerAccountId: job.runnerAccountId,
    sandbox: job.executionMode === "sandbox",
    networkAccess: job.networkAccess,
    delivery: job.delivery,
    accessMode: job.accessMode,
    unattended: job.unattended,
    folder: job.folderLabel,
    repoUrl: job.repoUrl,
    branch: job.branch || null,
    turns: job.turns,
    toolCalls: job.toolCalls,
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
    limits: { turns: job.maxTurns, toolCalls: job.maxToolCalls, minutes: job.maxMinutes },
    costUsd: typeof evidence.costUsd === "number" && Number.isFinite(evidence.costUsd) ? evidence.costUsd : null,
    files: (Array.isArray(evidence.files) ? evidence.files : []).slice(0, 200) as Array<{ path: string; added: number; removed: number }>,
    results: Array.isArray(job.results) ? job.results : [],
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

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
        workspaceJob: { select: JOB_FACTS },
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
        const job = run.workspaceJob ? jobFacts(run.workspaceJob) : null;
        return {
          sourceRunId: job?.sourceRunId ?? null,
          id: run.id,
          taskId: run.taskId,
          title: run.task.title,
          worker: run.worker,
          outcome: run.outcome,
          error: run.error,
          model: job?.modelUsed ?? run.requestedModel ?? run.plannerModel ?? run.steps.find((step) => step.model)?.model ?? null,
          credits,
          costUsd: job?.costUsd ?? null,
          engineName: job?.engineName ?? null,
          where: job?.where ?? null,
          deviceName: job?.deviceName ?? null,
          jobStatus: job?.status ?? null,
          toolCalls: job?.toolCalls ?? null,
          tokens: job ? job.tokensIn + job.tokensOut : null,
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
        workspaceJob: { select: JOB_FACTS },
      },
    });
    if (!run) return reply.code(404).send({ error: "Run not found." });
    const { workspaceJob, ...rest } = run;
    return { run: { ...rest, sourceRunId: workspaceJob ? jobFacts(workspaceJob).sourceRunId : null }, job: workspaceJob ? jobFacts(workspaceJob) : null };
  });

  app.post("/api/runs/:id/feedback", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(4000), start: z.boolean() }).strict().parse(request.body);
    const run = await prisma.run.findFirst({ where: { id, userId: request.userId, deletedAt: null }, include: { task: true, workspaceJob: true } });
    if (!run) return reply.code(404).send({ error: "Run not found." });
    if (!run.endedAt && (!run.workspaceJob || ["queued", "claimed", "running", "waiting_approval", "stopping"].includes(run.workspaceJob.status))) return reply.code(409).send({ error: "Wait for this run to finish before leaving feedback." });
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const current = await tx.run.findUniqueOrThrow({ where: { id: run.id }, select: { feedback: true } });
      const rows = (Array.isArray(current.feedback) ? current.feedback : []) as Array<{ id: string; text: string; at: string; authorId: string; jobId: string | null }>;
      const existing = rows.find(row => row.id === body.id);
      if (existing) return { feedback: existing, created: false };
      if (rows.length >= 100) throw Object.assign(new Error("This run already has 100 feedback tags."), { statusCode: 409 });
      const feedback = { id: body.id, text: body.text, at: new Date().toISOString(), authorId: actorFor(request.userId) ?? request.userId, jobId: null as string | null };
      await tx.run.update({ where: { id: run.id }, data: { feedback: [...rows, feedback] } });
      return { feedback, created: true };
    });
    if (!claim.created) return { feedback: claim.feedback, jobId: claim.feedback.jobId };
    let jobId: string | null = null;
    if (body.start) {
      if (!hasModule(request.modules, "workspace")) return reply.code(404).send({ error: MODULE_DENIED });
      if (run.workspaceJob) {
        const refusal = await runnerRefusal(app, run.workspaceJob);
        if (refusal) return reply.code(403).send({ error: refusal });
      }
      if (await isPaused(app.redis, request.userId)) return reply.code(409).send({ error: "Resume the agent before starting another run." });
      const original = run.workspaceJob ? repeatAssignment(run.workspaceJob) : Assign.parse({ taskId: run.taskId, kind: "research", instructions: run.assignmentInstructions ?? run.task.description });
      const instructions = `${original.instructions ?? run.task.description}\n\nOriginal task: ${run.task.title}\n\nFeedback on the earlier result:\n${body.text}`;
      const created = await createJob(prisma, request.userId, Assign.parse({ ...original, instructions }), { context: { feedbackOnRun: run.id, feedbackId: body.id } });
      if (!created) return reply.code(404).send({ error: "The original task is no longer available." });
      jobId = created.jobId;
    }
    const feedback = { ...claim.feedback, jobId };
    if (jobId) await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const current = await tx.run.findUniqueOrThrow({ where: { id: run.id }, select: { feedback: true } });
      const rows = Array.isArray(current.feedback) ? current.feedback : [];
      await tx.run.update({ where: { id: run.id }, data: { feedback: rows.map(row => row && typeof row === "object" && !Array.isArray(row) && row.id === body.id ? feedback : row) } });
    });
    return { feedback, jobId };
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
