/**
 * "Ready for review": an agent finished a task and its work waits for the person (the task is not
 * marked done by the run). One notification per run, unless Settings › Notifications › Nudges
 * turns review notices off. Failures and stops notify on their own (workspace/agent.ts, devices/finish.ts).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { onCodeTab } from "../lib/code-watch.js";
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

/**
 * A turn of a Code tab thread ended. Nothing while the person is on the Code tab: the thread list marks it
 * (running, finished and unread, read). Otherwise one notification that opens the thread: its reply
 * (unless review notices are off), or that it stopped on an error.
 */
export async function noticeCodeTurn(db: Db, input: { userId: string; taskId: string; title: string; summary: string | null | undefined; failed: string | null }): Promise<void> {
  if (await onCodeTab(input.userId)) return;
  if (!input.failed && !(await loadSettings(db, input.userId)).automations.reviewNotices) return;
  const body = (input.failed ?? input.summary ?? "").replace(/\s+/g, " ").trim();
  await db.notification.create({
    data: {
      userId: input.userId,
      kind: input.failed ? "agent" : "review",
      title: `${input.failed ? "Agent needs you" : "Agent replied"}: ${input.title}`.slice(0, 200),
      body: (body || "The agent finished.").slice(0, 300),
      url: `/code?view=agent&thread=${encodeURIComponent(input.taskId)}`,
      subject: `task:${input.taskId}`,
    },
  });
}

