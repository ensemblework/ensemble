/**
 * An agent's answer kept on a page (docs/16 §9): one `agentBlock` per run, at the end of a task's
 * page or a standalone page, tinted and labelled by the editor (`components/editor/agent-block.tsx`).
 * Its attributes say where it came from (the Code tab's agent, the agent and model, the thread, the
 * folder and computer, the run), so the page keeps the link to the work that wrote it. Keeping the same
 * run again replaces its block in place; the person's own blocks are never touched.
 */
import { markdownToNodes, type PageNode } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
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
        const kept = base.filter((node) => !(node.type === "paragraph" && !node.content?.length && base.length === 1));
        const index = kept.findIndex((node) => node.type === "agentBlock" && node.attrs?.jobId === meta.jobId);
        const next = index >= 0 ? kept.map((node, at) => (at === index ? block : node)) : [...kept, block];
        return { content: { type: "doc", content: next } };
      },
      "agent",
    ),
  );
  sseHub.publish(userId, { event: "page", data: { id: saved.id, ...(saved.taskId ? { taskId: saved.taskId } : {}), action: "save", by: "agent" } });
  return { id: saved.id, taskId: saved.taskId, title: saved.title };
}
