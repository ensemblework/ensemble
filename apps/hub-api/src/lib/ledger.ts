import { createHash } from "node:crypto";
import type { Actor, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { lockUserTransaction } from "./user-lock.js";
import { actorFor, nodeActingIn } from "../sharing/context.js";

type LedgerInput = {
  userId: string;
  actor: Actor;
  action: string;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  payload?: Prisma.InputJsonValue;
};

export async function appendLedger(input: LedgerInput): Promise<void> {
  await prisma.$transaction(tx => appendLedgerInTransaction(tx, input));
}

export async function appendLedgerInTransaction(tx: Prisma.TransactionClient, input: LedgerInput): Promise<void> {
  // Someone the space is shared with, or a node acting for its owner: the entry says who it was.
  const by = actorFor(input.userId);
  const node = nodeActingIn(input.userId);
  if (by || node) {
    const plain = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload);
    const base = plain ? (input.payload as Record<string, Prisma.InputJsonValue>) : input.payload === undefined ? {} : { value: input.payload };
    input = { ...input, payload: { ...base, ...(by ? { byAccountId: by } : {}), ...(node ? { byNodeId: node } : {}) } };
  }
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
}
