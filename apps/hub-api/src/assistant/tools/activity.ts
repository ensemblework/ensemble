/**
 * Running work and finished runs, for the assistant: what is running in this space right now
 * (the Activity panel: model calls, agent tasks, imports), stopping one, and recent agent runs.
 *
 * Every lookup is scoped to ctx.userId, the open space. The activity store is keyed the same
 * way GET /api/activity reads it (`keysFor`), so a space never sees another space's work.
 */
import { z } from "zod";
import type { ImportSourceId } from "../../imports/types.js";
import { SOURCE_LABEL } from "../../imports/types.js";
import { cancelImport } from "../../imports/jobs.js";
import { isPaused, listActivities, requestCancel } from "../../lib/activity.js";
import { appendLedger } from "../../lib/ledger.js";
import { truncateText } from "../../lib/text.js";
import { actorFor, isGuestIn } from "../../sharing/context.js";
import { stopJob } from "../../workspace/worker.js";
import { defineTool, toolOk, ToolBlockedError, type ToolContext } from "../types.js";

const LIVE_JOB = ["queued", "claimed", "running", "stopping", "waiting_approval"] as const;
const LIVE_IMPORT = ["queued", "running", "cancelling"];
const ENGINES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "cursor-agent": "Cursor", "copilot-cli": "GitHub Copilot" };

type Live = {
  id: string;
  kind: "assistant" | "agent_task" | "import" | "fetch" | "other";
  label: string;
  status: string;
  started: string;
  task?: { id: string; title: string };
  canStop: boolean;
  /** Why it cannot be stopped from here. */
  note?: string;
};

const runLink = (id: string) => `/runs?run=${id}`;
const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

function engineOf(provider: string | null | undefined, worker: string): string {
  if (provider && ENGINES[provider]) return ENGINES[provider]!;
  return worker === "workspace" || worker === "research" ? "Ensemble agent" : worker;
}

/** The id of this chat's own reply in the activity store. */
const ownTurn = (ctx: ToolContext) => (ctx.conversationId ? `assistant:${ctx.conversationId}` : null);

async function liveWork(ctx: ToolContext): Promise<Live[]> {
  const guest = isGuestIn(ctx.userId);
  const [calls, jobs, imports] = await Promise.all([
    listActivities(ctx.app.redis, ctx.userId),
    ctx.prisma.workspaceJob.findMany({
      where: { userId: ctx.userId, status: { in: [...LIVE_JOB] } },
      orderBy: { sequence: "asc" },
      take: 30,
      select: { id: true, status: true, runnerAccountId: true, userId: true, progress: true, createdAt: true, startedAt: true, task: { select: { id: true, title: true } } },
    }),
    // Imports are the owner's own (sharing policy: owner).
    guest
      ? Promise.resolve([])
      : ctx.prisma.importJob.findMany({ where: { userId: ctx.userId, status: { in: LIVE_IMPORT } }, orderBy: { createdAt: "asc" }, take: 10 }),
  ]);
  const jobIds = new Set(jobs.map((job) => `job:${job.id}`));
  // The store is per person (keysFor): someone a space is shared with also has their own spaces' replies there.
  const asked = calls.flatMap((call) => (call.conversationId ? [call.conversationId] : []));
  const here = new Set(
    asked.length
      ? (await ctx.prisma.assistantConversation.findMany({ where: { id: { in: asked }, userId: ctx.userId }, select: { id: true } })).map((row) => row.id)
      : [],
  );
  const own = ownTurn(ctx);
  const rows: Live[] = [];
  for (const call of calls) {
    if (jobIds.has(call.id)) continue;
    if (call.kind === "assistant" && !(call.conversationId && here.has(call.conversationId))) continue;
    const kind = call.kind === "assistant" || call.kind === "fetch" ? call.kind : "other";
    const self = call.id === own;
    rows.push({
      id: call.id,
      kind,
      label: kind === "assistant" ? `Assistant reply: ${truncateText(call.detail ?? call.label, 80)}` : truncateText(call.label, 80),
      status: "running",
      started: call.startedAt,
      canStop: !self,
      ...(self ? { note: "This chat's own reply." } : {}),
    });
  }
  for (const job of jobs) {
    const mine = (job.runnerAccountId ?? null) === actorFor(job.userId);
    rows.push({
      id: `job:${job.id}`,
      kind: "agent_task",
      label: truncateText(job.task.title, 80),
      status: job.status === "waiting_approval" ? "waiting for the person" : job.progress ? `${job.status}: ${truncateText(job.progress, 60)}` : job.status,
      started: (job.startedAt ?? job.createdAt).toISOString(),
      task: { id: job.task.id, title: job.task.title },
      canStop: mine,
      ...(mine ? {} : { note: "It runs on someone else's computer; only they can stop it." }),
    });
  }
  for (const job of imports) {
    rows.push({
      id: `import:${job.id}`,
      kind: "import",
      label: `Import from ${SOURCE_LABEL[job.source as ImportSourceId] ?? job.source}`,
      status: job.status,
      started: (job.startedAt ?? job.createdAt).toISOString(),
      canStop: job.status !== "cancelling",
    });
  }
  return rows.sort((a, b) => a.started.localeCompare(b.started));
}

async function findLive(ctx: ToolContext, id: string): Promise<Live> {
  const wanted = id.trim();
  if (wanted === ownTurn(ctx)) throw new ToolBlockedError("That is this chat's own reply; it cannot stop itself. The person can press Stop in the chat.");
  const row = (await liveWork(ctx)).find((item) => item.id === wanted);
  if (!row) throw new ToolBlockedError(`Nothing with id ${wanted} is running in this space. Call hub_list_activity for the current ids.`);
  if (!row.canStop) throw new ToolBlockedError(row.note ?? "That cannot be stopped from here.");
  return row;
}

function describeStop(row: Live): string {
  switch (row.kind) {
    case "agent_task":
      return row.status === "queued" ? `Remove the agent task “${row.label}” from the queue` : `Stop the agent task “${row.label}” (${row.status}); its folder and partial work are kept`;
    case "import":
      return `Cancel the ${lower(row.label)}; what already came over stays`;
    case "assistant":
      return `Stop the ${lower(row.label)}`;
    default:
      return `Stop “${row.label}”`;
  }
}

export const activityTools = [
  defineTool({
    name: "hub_list_activity",
    area: "runs",
    description:
      "What is running in this space right now: agent tasks (running, waiting for the person, queued), imports, and assistant replies in other chats. Each row has an id for hub_stop_activity and says whether it can be stopped.",
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const [rows, paused] = await Promise.all([liveWork(ctx), isPaused(ctx.app.redis, ctx.userId)]);
      const pausedNote = paused ? " The kill switch is on: nothing new starts until the person presses Resume." : "";
      if (!rows.length) return toolOk(`Nothing is running.${pausedNote}`, { activity: [], paused });
      return toolOk(`${rows.length} running or waiting.${pausedNote}`, { activity: rows, paused }, { href: "/workspace" });
    },
  }),
  defineTool({
    name: "hub_stop_activity",
    area: "runs",
    description:
      "Stop one running thing by its id from hub_list_activity: an agent task (job:…), an import (import:…), or an assistant reply in another chat (assistant:…). Never this chat's own reply.",
    input: z.object({ id: z.string().min(3).max(200).describe("The id exactly as hub_list_activity gave it, e.g. job:3f2a…") }),
    isWrite: true,
    risk: "medium",
    outsideTransaction: true,
    async preview(ctx, input) {
      return describeStop(await findLive(ctx, input.id));
    },
    async run(ctx, input) {
      const row = await findLive(ctx, input.id);
      const [prefix, rest] = [row.id.slice(0, row.id.indexOf(":")), row.id.slice(row.id.indexOf(":") + 1)];
      if (prefix === "job") {
        const stopped = await stopJob(ctx.app, ctx.userId, rest);
        if (!stopped) throw new ToolBlockedError("That agent task has already finished. Call hub_list_activity again.");
      } else if (prefix === "import") {
        if (isGuestIn(ctx.userId)) throw new ToolBlockedError("Only the space's owner can cancel its imports.");
        await cancelImport(ctx.prisma, ctx.userId, rest);
      } else {
        await requestCancel(ctx.app.redis, ctx.userId, row.id);
      }
      await appendLedger({ userId: ctx.userId, actor: "agent", action: "activity.stop", payload: { id: row.id, kind: row.kind } });
      const done = row.kind === "agent_task" ? `Stopping “${row.label}”.` : row.kind === "import" ? `Cancelling the ${lower(row.label)}.` : `Stopping the ${lower(row.label)}.`;
      return toolOk(done, { id: row.id, kind: row.kind }, { href: row.task ? `/tasks/${row.task.id}` : "/workspace", invalidate: ["agent-state", "workspace"] });
    },
  }),
  defineTool({
    name: "hub_list_runs",
    area: "runs",
    description:
      "Recent agent runs in this space, newest first: task, status (running, success, failed, cancelled, needs_info, waiting_approval), engine, model, started and finished. Use hub_get_run with an id for the result and the files it changed.",
    input: z.object({
      limit: z.number().int().min(1).max(25).default(10),
      taskId: z.string().uuid().optional().describe("Only runs of this task."),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const where = { userId: ctx.userId, deletedAt: null, ...(input.taskId ? { taskId: input.taskId } : {}) };
      const [runs, total] = await Promise.all([
        ctx.prisma.run.findMany({
          where,
          orderBy: { startedAt: "desc" },
          take: input.limit,
          select: {
            id: true,
            worker: true,
            outcome: true,
            error: true,
            requestedModel: true,
            plannerModel: true,
            startedAt: true,
            endedAt: true,
            task: { select: { id: true, title: true } },
            workspaceJob: { select: { provider: true, model: true } },
          },
        }),
        ctx.prisma.run.count({ where }),
      ]);
      const rows = runs.map((run) => ({
        id: run.id,
        task: { id: run.task.id, title: run.task.title },
        status: run.outcome ?? (run.endedAt ? "ended" : "running"),
        engine: engineOf(run.workspaceJob?.provider, run.worker),
        model: run.workspaceJob?.model ?? run.requestedModel ?? run.plannerModel ?? null,
        started: run.startedAt.toISOString(),
        finished: run.endedAt?.toISOString() ?? null,
        ...(run.error ? { error: truncateText(run.error, 160) } : {}),
        link: runLink(run.id),
      }));
      return toolOk(rows.length ? `Listed ${rows.length} of ${total} run(s).` : "No agent runs yet.", { runs: rows, total }, { href: "/runs" });
    },
  }),
  defineTool({
    name: "hub_get_run",
    area: "runs",
    description:
      "One agent run by id (from hub_list_runs): status, engine, steps, its result, the files it changed with a link to review them, and any pull request or commit it made.",
    input: z.object({ runId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const run = await ctx.prisma.run.findFirst({
        where: { id: input.runId, userId: ctx.userId, deletedAt: null },
        select: {
          id: true,
          worker: true,
          outcome: true,
          error: true,
          result: true,
          requestedModel: true,
          plannerModel: true,
          startedAt: true,
          endedAt: true,
          task: { select: { id: true, title: true } },
          steps: { orderBy: { index: "asc" }, select: { index: true, title: true, status: true } },
          workspaceJob: {
            select: {
              id: true,
              kind: true,
              provider: true,
              model: true,
              status: true,
              summary: true,
              branch: true,
              results: true,
              turns: true,
              toolCalls: true,
              review: { select: { id: true, agentPaths: true, completedAt: true, expiredAt: true } },
            },
          },
        },
      });
      if (!run) throw new ToolBlockedError("No run with that id in this space. Call hub_list_runs for the ids.");
      const job = run.workspaceJob;
      const review = job?.review ?? null;
      const files = review?.agentPaths ?? [];
      const results = Array.isArray(job?.results) ? (job.results as Array<{ kind?: string; url?: string }>).filter((row) => row && typeof row.url === "string").slice(0, 5) : [];
      const steps = run.steps.slice(0, 15).map((step) => ({ n: step.index + 1, title: truncateText(step.title, 80), status: step.status }));
      const data = {
        id: run.id,
        task: run.task,
        status: run.outcome ?? (run.endedAt ? "ended" : "running"),
        engine: engineOf(job?.provider, run.worker),
        model: job?.model ?? run.requestedModel ?? run.plannerModel ?? null,
        started: run.startedAt.toISOString(),
        finished: run.endedAt?.toISOString() ?? null,
        ...(run.error ? { error: truncateText(run.error, 300) } : {}),
        ...(job ? { turns: job.turns, toolCalls: job.toolCalls } : {}),
        steps,
        ...(run.steps.length > steps.length ? { moreSteps: run.steps.length - steps.length } : {}),
        result: truncateText(run.result ?? job?.summary ?? "", 1500) || null,
        ...(job?.kind === "code"
          ? {
              filesChanged: { count: files.length, files: files.slice(0, 20) },
              ...(review && !review.expiredAt ? { review: { link: `/code/review?review=${review.id}`, decided: Boolean(review.completedAt) } } : {}),
              ...(job.branch ? { branch: job.branch } : {}),
            }
          : {}),
        ...(results.length ? { published: results.map((row) => ({ kind: row.kind ?? "link", url: row.url })) } : {}),
        link: runLink(run.id),
      };
      return toolOk(`Read the run of “${run.task.title}” (${data.status}).`, data, { href: data.link });
    },
  }),
];
