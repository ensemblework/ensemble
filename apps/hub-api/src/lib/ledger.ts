import { createHash } from "node:crypto";
import type { Actor, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function appendLedger(input: {
  userId: string;
  actor: Actor;
  action: string;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  payload?: Prisma.InputJsonValue;
}): Promise<void> {
  const prev = await prisma.auditLedger.findFirst({
    where: { userId: input.userId },
    orderBy: { ts: "desc" },
    select: { hash: true },
  });
  const body = JSON.stringify({
    action: input.action,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    payload: input.payload ?? {},
    prev: prev?.hash ?? "",
  });
  const hash = createHash("sha256").update(body).digest("hex");
  await prisma.auditLedger.create({
    data: {
      userId: input.userId,
      actor: input.actor,
      action: input.action,
      taskId: input.taskId,
      runId: input.runId,
      approvalId: input.approvalId,
      prevHash: prev?.hash,
      hash,
      payload: input.payload ?? {},
    },
  });
}
