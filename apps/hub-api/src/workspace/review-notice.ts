/**
 * "Ready for review": an agent finished a task and its work waits for the person (the task is not
 * marked done by the run). One notification per run, unless Settings › Assistant › Automations
 * turns review notices off. Failures and stops notify on their own (workspace/agent.ts, devices/finish.ts).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";

type Db = PrismaClient | Prisma.TransactionClient;

export async function noticeReadyForReview(db: Db, input: { userId: string; taskId: string; title: string; summary: string | null | undefined; runId: string | null }): Promise<void> {
  const settings = await loadSettings(db, input.userId);
  if (!settings.automations.reviewNotices) return;
  const summary = (input.summary ?? "").replace(/\s+/g, " ").trim();
  await db.notification.create({
    data: {
      userId: input.userId,
      // Not a "needs you" notification: it stays until read, whatever the task's status (notifications/needs.ts).
      kind: "review",
      title: `Ready for review: ${input.title}`.slice(0, 200),
      body: (summary || "The agent finished. Its report is on the task.").slice(0, 300),
      url: `/tasks/${input.taskId}`,
      subject: `task:${input.taskId}`,
    },
  });
}
