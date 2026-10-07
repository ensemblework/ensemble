import type { Prisma, PrismaClient } from "@prisma/client";
import { isHosted, requireVerifiedUser } from "./hosted-access.js";
import { lockUserTransaction } from "./user-lock.js";

export class HostedLimitError extends Error {
  readonly statusCode = 429;
  readonly expose = true;
  constructor(message: string) { super(message); this.name = "HostedLimitError"; }
}

export function hostedLimits(env: NodeJS.ProcessEnv = process.env) {
  function limit(name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
    return value;
  }
  return {
    connectors: limit("ENSEMBLE_MAX_CONNECTORS", 25),
    jobsPerDay: limit("ENSEMBLE_MAX_JOBS_PER_DAY", 50),
    datasetBytes: limit("ENSEMBLE_MAX_DATASET_BYTES", 100 * 1024 * 1024),
    documentBytes: limit("ENSEMBLE_MAX_DOCUMENT_BYTES", 100 * 1024 * 1024),
  };
}

export function assertWithinLimit(used: number, added: number, max: number, resource: string): void {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(added) || used < 0 || added < 0) throw new Error(`Invalid ${resource} usage.`);
  if (added > max - used) throw new HostedLimitError(`Your hosted ${resource} limit (${max}) has been reached.`);
}

export function checkConnectorLimit(connections: Record<string, { enabled: boolean }>): void {
  if (isHosted()) assertWithinLimit(0, Object.values(connections).filter((connection) => connection.enabled).length, hostedLimits().connectors, "enabled connectors");
}

export async function withHostedUserLock<T>(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  verify = true,
): Promise<T> {
  if (!isHosted()) return work(db);
  if (verify) await requireVerifiedUser(userId);
  // A transaction client cannot open another transaction; lock and work inside the caller's.
  if (!("$transaction" in db) || typeof db.$transaction !== "function") {
    await lockUserTransaction(db, userId);
    return work(db);
  }
  return (db as PrismaClient).$transaction(async (tx) => {
    await lockUserTransaction(tx, userId);
    return work(tx);
  }, { isolationLevel: "ReadCommitted" });
}

export async function createCappedJob(db: PrismaClient, userId: string, args: Prisma.WorkspaceJobCreateArgs) {
  return withHostedUserLock(db, userId, async (tx) => {
    let usage: { key: string; count: number } | undefined;
    if (isHosted()) {
      if (args.data.userId !== userId) throw new Error("The job account does not match its quota account.");
      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      const key = `hosted.agent-jobs.${from.toISOString().slice(0, 10)}`;
      const counter = await tx.preference.findUnique({ where: { userId_key: { userId, key } } });
      const value = counter?.value;
      const saved = value && typeof value === "object" && !Array.isArray(value) ? value.count : undefined;
      if (counter && (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0)) throw new Error("The hosted daily job usage counter is invalid.");
      const used = Math.max(typeof saved === "number" ? saved : 0, await tx.workspaceJob.count({ where: { userId, createdAt: { gte: from } } }));
      assertWithinLimit(used, 1, hostedLimits().jobsPerDay, "agent jobs per UTC day");
      usage = { key, count: used + 1 };
    }
    const job = await tx.workspaceJob.create(args);
    if (usage) {
      await tx.preference.upsert({
        where: { userId_key: { userId, key: usage.key } },
        create: { userId, key: usage.key, value: { count: usage.count }, source: "system" },
        update: { value: { count: usage.count }, deletedAt: null },
      });
    }
    return job;
  });
}

export async function checkDatasetBytes(tx: Prisma.TransactionClient, userId: string, bytes: number, replacingId?: string) {
  if (!isHosted()) return;
  const sum = await tx.plotDataset.aggregate({ where: { userId, ...(replacingId ? { id: { not: replacingId } } : {}) }, _sum: { byteSize: true } });
  assertWithinLimit(sum._sum.byteSize ?? 0, bytes, hostedLimits().datasetBytes, "dataset bytes");
}

export async function createCappedDocument<T extends Prisma.DocumentCreateArgs>(
  db: PrismaClient,
  userId: string,
  args: Prisma.SelectSubset<T, Prisma.DocumentCreateArgs>,
) {
  if (args.data.userId !== userId) throw new Error("The document account does not match its quota account.");
  const bytes = args.data.original.byteLength;
  if (args.data.byteSize !== bytes) throw new Error("The document size does not match its original bytes.");
  return withHostedUserLock(db, userId, async (tx) => {
    if (isHosted()) {
      const sum = await tx.document.aggregate({ where: { userId }, _sum: { byteSize: true } });
      assertWithinLimit(sum._sum.byteSize ?? 0, bytes, hostedLimits().documentBytes, "uploaded document bytes");
    }
    return tx.document.create(args);
  }, false);
}
