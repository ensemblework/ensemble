import type { Prisma, PrismaClient } from "@prisma/client";
import { keysFor } from "../sharing/context.js";

export async function recordMetric(
  prisma: PrismaClient,
  input: {
    userId: string;
    kind: string;
    taskId?: string;
    runId?: string;
    seconds?: number;
    meta?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await prisma.metricEvent.create({
    data: {
      // Metrics are personal: work you do in a space shared with you counts on your account.
      userId: keysFor(input.userId),
      kind: input.kind,
      taskId: input.taskId,
      runId: input.runId,
      seconds: input.seconds,
      payload: input.meta ?? {},
    },
  });
}
