/**
 * The work board (ensemble-node docs/design, extension §3.3): what a node's conversation lane knows
 * about the work going on, built by code for every conversation turn, so the node can answer "how is
 * it going?" or steer the right thing without reading its work lanes' transcripts.
 */
import type { NodeAgent, PrismaClient } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { sessionEventLine, sessionEvents } from "./session-queue.js";

const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval", "stopping"];
const LIVE_MISSION = ["draft", "running", "reporting"];

/**
 * Tools that never change anything (lookups). Every other tool counts as acting: from its first
 * call the turn is not aborted to merge a newer message, and a restart reconciles it.
 */
const READS = /^(hub_(list|get|read|search|find|view|diagram_context|explain|validate|repo_read|repo_overview|weekly_recap|how_to)|hub_web_search|node_sessions|node_overview|node_computer_files|node_work_status|computer_git|browser_(tabs|snapshot|console|network_errors|wait)$|capture_(status|apps|check)$)/;

export function actsOnTheWorld(name: string, isWrite: boolean | undefined): boolean {
  if (isWrite) return true;
  return !READS.test(name);
}

function ago(date: Date | null | undefined): string {
  if (!date) return "";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** A few lines: live missions (with their steps), sessions, decisions waiting. Empty when there is nothing. */
export async function workBoard(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">, roomId: string): Promise<string> {
  const [missions, runs, cards] = await Promise.all([
    prisma.nodeMission.findMany({
      where: { userId: node.userId, status: { in: LIVE_MISSION }, OR: [{ leadNodeId: node.id }, { steps: { some: { nodeId: node.id } } }] },
      include: { steps: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.nodeRun.findMany({ where: { nodeId: node.id, reportedAt: null }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.nodeMessage.findMany({
      where: { kind: "approval", authorNodeId: node.id, AND: [{ data: { path: ["status"], equals: "pending" } }] },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { body: true, roomId: true, createdAt: true },
    }),
  ]);
  const jobs = runs.length ? await prisma.workspaceJob.findMany({ where: { id: { in: runs.map((row) => row.jobId) } }, select: { id: true, status: true, progress: true, provider: true, device: { select: { name: true } } } }) : [];
  const job = new Map(jobs.map((row) => [row.id, row]));
  const lines: string[] = [];
  for (const mission of missions) {
    const here = mission.originRoomId === roomId ? "" : " (asked in another room)";
    const steps = mission.steps.map((step) => {
      const outcome = step.outcome !== "unknown" ? `/${step.outcome}` : "";
      const doing = step.status === "working" && step.progress ? ` — ${truncateText(step.progress.replace(/\s+/g, " "), 120)}` : "";
      return `@${step.handle} ${step.kind} ${step.status}${outcome}${step.attempt > 1 ? ` (attempt ${step.attempt})` : ""}${doing}`;
    });
    lines.push(`- ${mission.kind === "self" ? "Own work" : "Plan"} [${mission.id}] ${mission.status}${here}: ${steps.join("; ") || "no steps yet"}`);
  }
  for (const run of runs) {
    const row = job.get(run.jobId);
    if (!row || !LIVE_JOB.includes(row.status)) continue;
    lines.push(`- Session ${run.sessionId ?? run.jobId} (${row.provider ?? "agent"} on ${row.device?.name ?? "a computer"}): ${row.status}${row.progress ? ` — ${truncateText(row.progress.replace(/\s+/g, " "), 140)}` : ""}${run.prompt ? `; asked: “${truncateText(run.prompt.replace(/\s+/g, " "), 100)}”` : ""} (${ago(run.createdAt)})`);
  }
  for (const card of cards) lines.push(`- Waiting for your owner since ${ago(card.createdAt)}: ${truncateText(card.body.replace(/\s+/g, " "), 140)}`);
  // What your owner (from a session card) or the watchdog did to your sessions lately: never undo it unasked.
  const events = (await sessionEvents(prisma, node.id, { since: new Date(Date.now() - 2 * 3_600_000), limit: 6 })).filter((row) => row.actor !== "node");
  for (const event of events) lines.push(`- ${sessionEventLine(event)}`);
  return lines.join("\n");
}
