import { createHash } from "node:crypto";
import type { Actor, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { lockUserTransaction } from "./user-lock.js";

export async function appendLedger(input: {
  userId: string;
  actor: Actor;
  action: string;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  payload?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockUserTransaction(tx, input.userId);
    const prev = await tx.auditLedger.findFirst({
      where: { userId: input.userId },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      select: { hash: true, ts: true },
    });
    const body = JSON.stringify({
      action: input.action,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      payload: input.payload ?? {},
      prev: prev?.hash ?? "",
    });
    const hash = createHash("sha256").update(body).digest("hex");
    await tx.auditLedger.create({
      data: {
        userId: input.userId,
        actor: input.actor,
        action: input.action,
        taskId: input.taskId,
        runId: input.runId,
        approvalId: input.approvalId,
        prevHash: prev?.hash,
        hash,
        ts: new Date(Math.max(Date.now(), (prev?.ts.getTime() ?? 0) + 1)),
        payload: input.payload ?? {},
      },
    });
  });
}
