/**
 * An agent's answer kept on a page (docs/16 §9): one `agentBlock` per run, at the end of a task's
 * page or a standalone page, tinted and labelled by the editor (`components/editor/agent-block.tsx`).
 * Its attributes say where it came from (the Code tab's agent, the agent and model, the thread, the
 * folder and computer, the run), so the page keeps the link to the work that wrote it. Keeping the same
 * run again replaces its block in place; the person's own blocks are never touched.
 */
import { markdownToNodes, type PageNode } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { meetingContent, meetingNotesFields, saveMeetingNotes } from "../cowork/service.js";
import { lockSave } from "../lib/save-conflict.js";
import { sseHub } from "../lib/sse.js";
import { fingerprint } from "./markdown.js";
import { writePageContent, type PageTarget } from "./store.js";

export type AgentOutputMeta = {
  /** What wrote it: `code-agent` for a thread of the Code tab's agent. */
  source: string;
  jobId: string;
  runId: string | null;
  engine: string;
  model: string;
  /** The label on the block's bar. */
  title: string;
  threadId: string | null;
  folder: string;
  computer: string;
};

export function agentOutputBlock(markdown: string, meta: AgentOutputMeta, at = new Date()): PageNode {
  const content = markdownToNodes(markdown);
  return {
    type: "agentBlock",
    attrs: {
      jobId: meta.jobId,
      runId: meta.runId,
      model: meta.model,
      title: meta.title,
      at: at.toISOString(),
      fingerprint: fingerprint(content),
      source: meta.source,
      engine: meta.engine,
      threadId: meta.threadId,
      folder: meta.folder,
      computer: meta.computer,
    },
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

/** Puts the block at the end of the page, or in place of the one the same run wrote there before. */
export async function keepAgentOutput(prisma: PrismaClient, userId: string, target: PageTarget, markdown: string, meta: AgentOutputMeta): Promise<{ id: string; taskId: string | null; title: string }> {
  const block = agentOutputBlock(markdown, meta);
  const saved = await prisma.$transaction((tx) =>
    writePageContent(
      tx,
      userId,
      target,
      (current) => {
        const base = current.content?.content ?? (current.notes.trim() ? markdownToNodes(current.notes) : []);
        return { content: { type: "doc", content: withBlock(base, block, meta.jobId) } };
      },
      "agent",
    ),
  );
  sseHub.publish(userId, { event: "page", data: { id: saved.id, ...(saved.taskId ? { taskId: saved.taskId } : {}), action: "save", by: "agent" } });
  return { id: saved.id, taskId: saved.taskId, title: saved.title };
}

/** The block in place of the one the same run wrote there before, or after everything else. */
function withBlock(base: PageNode[], block: PageNode, jobId: string): PageNode[] {
  const kept = base.filter((node) => !(node.type === "paragraph" && !node.content?.length && base.length === 1));
  const index = kept.findIndex((node) => node.type === "agentBlock" && node.attrs?.jobId === jobId);
  return index >= 0 ? kept.map((node, at) => (at === index ? block : node)) : [...kept, block];
}

export class KeepTargetError extends Error {
  readonly statusCode = 404;
}

/**
 * Keeps the output on meeting notes: at the end of notes already there, or as new notes (an ended
 * meeting, so nothing shows as going on). The notes' recap and linked note follow as for any save.
 */
export async function keepAgentOutputOnMeeting(prisma: PrismaClient, userId: string, target: { meetingId: string } | { newMeeting: { title: string } }, markdown: string, meta: AgentOutputMeta): Promise<{ id: string; title: string }> {
  const block = agentOutputBlock(markdown, meta);
  const saved = await prisma.$transaction(async (tx) => {
    if ("newMeeting" in target) {
      const now = new Date();
      const fields = meetingNotesFields({ content: { type: "doc", content: [block] } })!;
      const created = await tx.meetingSession.create({ data: { userId, title: target.newMeeting.title, status: "ended", startedAt: now, endedAt: now, ...fields } });
      return { id: created.id, title: created.title };
    }
    await lockSave(tx, "meeting_sessions", userId, target.meetingId);
    const current = await tx.meetingSession.findFirst({ where: { id: target.meetingId, userId, deletedAt: null } });
    if (!current) throw new KeepTargetError("Those meeting notes are gone.");
    const doc = meetingContent(current);
    await saveMeetingNotes(tx, userId, current.id, { content: { type: "doc", content: withBlock(doc?.content ?? [], block, meta.jobId) } });
    return { id: current.id, title: current.title };
  });
  sseHub.publish(userId, { event: "meetings", data: { id: saved.id } });
  return saved;
}

/** Keeps the output in a deliverable's notes, after what is there, under a line that says where it came from. */
export async function keepAgentOutputOnDeliverable(prisma: PrismaClient, userId: string, deliverableId: string, markdown: string, meta: AgentOutputMeta): Promise<{ id: string; title: string; projectId: string }> {
  const saved = await prisma.$transaction(async (tx) => {
    await lockSave(tx, "deliverables", userId, deliverableId);
    const current = await tx.deliverable.findFirst({ where: { id: deliverableId, userId, deletedAt: null }, select: { id: true, title: true, notes: true, projectId: true } });
    if (!current) throw new KeepTargetError("That deliverable is gone.");
    const mark = `<!-- ensemble:agent-output ${meta.jobId} -->`;
    const section = `${mark}\n_${meta.title} · ${new Date().toISOString().slice(0, 10)}_\n\n${markdown.trim()}\n${mark}`;
    const pattern = new RegExp(`${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const notes = pattern.test(current.notes) ? current.notes.replace(pattern, () => section) : [current.notes.trimEnd(), section].filter(Boolean).join("\n\n");
    await tx.deliverable.update({ where: { id: current.id }, data: { notes } });
    return current;
  });
  sseHub.publish(userId, { event: "deliverable", data: { id: saved.id } });
  return { id: saved.id, title: saved.title, projectId: saved.projectId };
}
