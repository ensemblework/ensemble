/**
 * What of Ensemble Node the Hub's Needs me shows (docs/35 §8.6, docs/02 §3.3). The rule: the Hub lists
 * only what a node's sessions ask for, named by the agent that asks (GitHub Copilot, Claude Code…), its
 * folder and computer, with the node it works for as secondary context. That is the questions and
 * permissions of a node run's agent (`agent_decisions` of the run's job, `GET /api/decisions`) and the
 * cards a run raises for its agent: a sign-in or captures held for a preview that carry the run's
 * `jobId` (`GET /api/node/approvals`); a run's own card in the chat (`run_decision`) is not listed, as its
 * decision is. A node's own requests (Ensemble writes, posts and drafts, starting, steering or handing over
 * a session, proposals, secrets, administrator commands, its own sign-ins and captures, room cards and its
 * computer tools) are answered in the Node chat only. `GET /api/shell` counts exactly the rows these
 * lists return.
 */
import type { AgentDecision, Prisma, PrismaClient } from "@prisma/client";
import { ENGINE_LABELS, isCodeEngine } from "@ensemble/shared-types";
import { nodeWebOrigin } from "../lib/node-origin.js";
import { NODE_TOOL_DECISION } from "./device-tool-decisions.js";
import { RUN_DECISION_CARD } from "./run-decisions.js";

/** Card types a run raises for its agent (node/logins.ts `LOGIN_CARD`, evidence/held.ts `MEDIA_PREVIEW_CARD`). */
const SESSION_CARD_TYPES = new Set(["login", "media_preview"]);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Whether a node's approval card is raised for one of its runs, so the Hub lists it: a run's sign-in or
 * held captures, which carry the run's `jobId`. The node's own sign-in or captures carry an `operation`
 * instead, and its other cards are its own requests.
 */
export function sessionCard(data: unknown): boolean {
  const row = record(data);
  return SESSION_CARD_TYPES.has(String(row.type ?? "")) && Boolean(text(row.jobId));
}

/** The Hub's Needs me leaves out a node's own computer-tool questions (node/device-tool-decisions.ts). */
export function hubDecisionsWhere(): Prisma.AgentDecisionWhereInput {
  return { NOT: { source: "ensemble", toolName: NODE_TOOL_DECISION } };
}

/** The agent's name for a run's engine, or null for anything else. */
export function agentLabel(engine: string | null | undefined): string | null {
  return isCodeEngine(engine) ? ENGINE_LABELS[engine] : null;
}

/** Where a request comes from: the session's agent, folder and computer, and the node it works for. */
export type SessionOrigin = {
  agent: string | null;
  folder: string | null;
  computer: string | null;
  task: { id: string; title: string } | null;
  node: { slug: string; name: string; roomId: string; room: string | null; url: string | null } | null;
};

/** The last part of a repository's address, as a folder name. */
function repoName(url: string | null): string | null {
  if (!url) return null;
  const last = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
  return last.replace(/\.git$/, "") || null;
}

/** Each job's origin, by job id: the space's runs, and the node that follows each one, if any. */
export async function sessionOrigins(prisma: PrismaClient, spaceId: string, jobIds: readonly string[]): Promise<Map<string, SessionOrigin>> {
  const ids = [...new Set(jobIds.filter(Boolean))];
  const out = new Map<string, SessionOrigin>();
  if (!ids.length) return out;
  const [jobs, runs] = await Promise.all([
    prisma.workspaceJob.findMany({
      where: { id: { in: ids }, userId: spaceId },
      select: { id: true, provider: true, folderLabel: true, repoUrl: true, taskId: true, task: { select: { title: true } }, device: { select: { name: true } } },
    }),
    prisma.nodeRun.findMany({ where: { jobId: { in: ids }, userId: spaceId }, select: { jobId: true, nodeId: true, roomId: true, messageId: true, settings: true } }),
  ]);
  const [nodes, rooms] = runs.length
    ? await Promise.all([
        prisma.nodeAgent.findMany({ where: { id: { in: runs.map((row) => row.nodeId) } }, select: { id: true, slug: true, name: true } }),
        prisma.nodeRoom.findMany({ where: { id: { in: runs.map((row) => row.roomId) } }, select: { id: true, title: true } }),
      ])
    : [[], []];
  const site = nodeWebOrigin();
  for (const job of jobs) {
    const run = runs.find((row) => row.jobId === job.id);
    const node = run ? nodes.find((row) => row.id === run.nodeId) : undefined;
    // The agent as the node's run settled it (node/settings.ts), else the job's engine.
    const settings = record(run?.settings);
    const agent = agentLabel(text(record(settings.resolved).agent) ?? text(record(settings.requested).agent)) ?? agentLabel(job.provider);
    out.set(job.id, {
      agent,
      folder: text(job.folderLabel) ?? repoName(job.repoUrl),
      computer: text(job.device?.name),
      task: { id: job.taskId, title: job.task.title },
      node:
        run && node
          ? {
              slug: node.slug,
              name: node.name,
              roomId: run.roomId,
              room: rooms.find((row) => row.id === run.roomId)?.title ?? null,
              url: site ? `${site}/r/${run.roomId}${run.messageId ? `#m-${run.messageId}` : ""}` : null,
            }
          : null,
    });
  }
  return out;
}

/**
 * Origins of a run's requests in a list of decisions, by decision id. A request with its own card in the
 * Node chat (node/run-decisions.ts) links to that card, else to its run's card.
 */
export async function decisionOrigins(prisma: PrismaClient, spaceId: string, rows: readonly Pick<AgentDecision, "id" | "source" | "sessionId" | "detail">[]): Promise<Map<string, SessionOrigin>> {
  const jobOf = (row: (typeof rows)[number]) => (row.source === "ensemble" ? (text(record(row.detail).jobId) ?? row.sessionId) : null);
  const origins = await sessionOrigins(prisma, spaceId, rows.map(jobOf).filter((id): id is string => Boolean(id)));
  const site = nodeWebOrigin();
  const asked = rows.filter((row) => origins.get(jobOf(row) ?? "")?.node);
  const cards = site && asked.length
    ? await prisma.nodeMessage.findMany({
        where: { userId: spaceId, kind: "approval", AND: [{ data: { path: ["type"], equals: RUN_DECISION_CARD } }, { OR: asked.map((row) => ({ data: { path: ["decisionId"], equals: row.id } })) }] },
        select: { id: true, roomId: true, data: true },
      })
    : [];
  const out = new Map<string, SessionOrigin>();
  for (const row of rows) {
    const origin = origins.get(jobOf(row) ?? "");
    if (!origin) continue;
    const card = cards.find((item) => record(item.data).decisionId === row.id);
    out.set(row.id, card && origin.node ? { ...origin, node: { ...origin.node, url: `${site}/r/${card.roomId}#m-${card.id}` } } : origin);
  }
  return out;
}
