import type { Prisma, PrismaClient } from "@prisma/client";

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
      userId: input.userId,
      kind: input.kind,
      taskId: input.taskId,
      runId: input.runId,
      seconds: input.seconds,
      payload: input.meta ?? {},
    },
  });
}
