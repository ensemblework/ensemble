import type { Prisma, PrismaClient } from "@prisma/client";
import { isHosted, requireVerifiedUser } from "./hosted-access.js";
import { lockUserTransaction } from "./user-lock.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Hosted caps belong to the signed-in account, not to one Ensemble space: usage is summed
 * over every space, the lock is on the account row, and the daily job counter lives on the
 * account so deleting a space does not reset it.
 */
export async function quotaScope(db: Db, userId: string): Promise<{ account: string; ids: string[] }> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { ownerId: true } });
  const account = row?.ownerId ?? userId;
  const owned = await db.user.findMany({ where: { ownerId: account }, select: { id: true } });
  return { account, ids: [account, ...owned.map((item) => item.id)] };
}

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
    documents: limit("ENSEMBLE_MAX_DOCUMENTS", 10),
    documentBytes: limit("ENSEMBLE_MAX_DOCUMENT_BYTES", 50 * 1024 * 1024),
    /** Every stored original on this server, removed-but-not-purged included. */
    filesTotalBytes: limit("ENSEMBLE_FILES_TOTAL_MAX_BYTES", 10 * 1024 * 1024 * 1024),
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
  /** Longer than Prisma's 5 s default when the work uploads to the blob store. */
  timeoutMs?: number,
): Promise<T> {
  if (!isHosted()) return work(db);
  if (verify) await requireVerifiedUser(userId);
  // A transaction client cannot open another transaction; lock and work inside the caller's.
  if (!("$transaction" in db) || typeof db.$transaction !== "function") {
    await lockUserTransaction(db, (await quotaScope(db, userId)).account);
    return work(db);
  }
  return (db as PrismaClient).$transaction(async (tx) => {
    await lockUserTransaction(tx, (await quotaScope(tx, userId)).account);
    return work(tx);
  }, { isolationLevel: "ReadCommitted", ...(timeoutMs ? { timeout: timeoutMs } : {}) });
}

export async function createCappedJob(db: PrismaClient, userId: string, args: Prisma.WorkspaceJobCreateArgs) {
  return withHostedUserLock(db, userId, async (tx) => {
    let usage: { key: string; count: number; account: string } | undefined;
    if (isHosted()) {
      // A run in a space shared with you counts against you, the person whose computer runs it.
      if (args.data.userId !== userId && args.data.runnerAccountId !== userId) throw new Error("The job account does not match its quota account.");
      const scope = await quotaScope(tx, userId);
      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      const key = `hosted.agent-jobs.${from.toISOString().slice(0, 10)}`;
      const counter = await tx.preference.findUnique({ where: { userId_key: { userId: scope.account, key } } });
      const value = counter?.value;
      const saved = value && typeof value === "object" && !Array.isArray(value) ? value.count : undefined;
      if (counter && (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0)) throw new Error("The hosted daily job usage counter is invalid.");
      const mine = { OR: [{ userId: { in: scope.ids }, runnerAccountId: null }, { runnerAccountId: scope.account }] };
      const used = Math.max(typeof saved === "number" ? saved : 0, await tx.workspaceJob.count({ where: { ...mine, createdAt: { gte: from } } }));
      assertWithinLimit(used, 1, hostedLimits().jobsPerDay, "agent jobs per UTC day");
      usage = { key, count: used + 1, account: scope.account };
    }
    const job = await tx.workspaceJob.create(args);
    if (usage) {
      await tx.preference.upsert({
        where: { userId_key: { userId: usage.account, key: usage.key } },
        create: { userId: usage.account, key: usage.key, value: { count: usage.count }, source: "system" },
        update: { value: { count: usage.count }, deletedAt: null },
      });
    }
    return job;
  });
}

export async function checkDatasetBytes(tx: Prisma.TransactionClient, userId: string, bytes: number, replacingId?: string) {
  if (!isHosted()) return;
  const { ids } = await quotaScope(tx, userId);
  const sum = await tx.plotDataset.aggregate({ where: { userId: { in: ids }, ...(replacingId ? { id: { not: replacingId } } : {}) }, _sum: { byteSize: true } });
  assertWithinLimit(sum._sum.byteSize ?? 0, bytes, hostedLimits().datasetBytes, "dataset bytes");
}

/** "50 MB", "12 KB", "5 bytes": sizes as people read them. */
export function sizeLabel(bytes: number): string {
  const mib = 1024 * 1024;
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < mib) return `${Math.ceil(bytes / 1024)} KB`;
  const value = bytes / mib;
  return `${value >= 10 || Number.isInteger(value) ? Math.ceil(value) : Math.ceil(value * 10) / 10} MB`;
}

export class FileStorageFullError extends Error {
  readonly statusCode = 507;
  readonly expose = true;
  constructor() { super("File storage on this server is full right now."); this.name = "FileStorageFullError"; }
}

/**
 * Hosted caps for files, checked under the account lock: how many files and how many bytes the
 * account keeps (removed files do not count), and the whole server's stored originals.
 * `replacingId` is a file whose bytes are being replaced; `files` is 1 for a new file, 0 for a replacement.
 */
export async function assertFileRoom(tx: Prisma.TransactionClient, userId: string, change: { files: 0 | 1; bytes: number; replacingId?: string }): Promise<void> {
  if (!isHosted()) return;
  const limits = hostedLimits();
  const { ids } = await quotaScope(tx, userId);
  const others = change.replacingId ? { id: { not: change.replacingId } } : {};
  const kept = await tx.document.aggregate({ where: { userId: { in: ids }, deletedAt: null, ...others }, _count: true, _sum: { byteSize: true } });
  if (change.files && kept._count + change.files > limits.documents) {
    throw new HostedLimitError(`You can keep ${limits.documents} ${limits.documents === 1 ? "file" : "files"} on the hosted plan. Remove one to add another.`);
  }
  const used = kept._sum.byteSize ?? 0;
  if (used + change.bytes > limits.documentBytes) {
    const subject = change.replacingId ? "this change" : "this one";
    throw new HostedLimitError(`Files can use ${sizeLabel(limits.documentBytes)} together on the hosted plan; ${subject} needs ${sizeLabel(used + change.bytes - limits.documentBytes)} more.`);
  }
  const replaced = change.replacingId ? await tx.document.findUnique({ where: { id: change.replacingId }, select: { byteSize: true } }) : null;
  const growth = change.bytes - (replaced?.byteSize ?? 0);
  if (growth > 0) {
    const stored = await tx.document.aggregate({ _sum: { byteSize: true } });
    if ((stored._sum.byteSize ?? 0) + growth > limits.filesTotalBytes) throw new FileStorageFullError();
  }
}

/** Creates a file row once the hosted caps allow it, under the account lock so two uploads cannot both squeeze in. */
export async function createCappedDocument<T extends Prisma.DocumentCreateArgs>(
  db: PrismaClient,
  userId: string,
  args: Prisma.SelectSubset<T, Prisma.DocumentCreateArgs>,
) {
  if (args.data.userId !== userId) throw new Error("The document account does not match its quota account.");
  const bytes = args.data.byteSize;
  if (args.data.original && args.data.original.byteLength !== bytes) throw new Error("The document size does not match its original bytes.");
  if (!args.data.original && !args.data.blobKey) throw new Error("The document has neither original bytes nor a blob key.");
  return withHostedUserLock(db, userId, async (tx) => {
    await assertFileRoom(tx, userId, { files: 1, bytes });
    return tx.document.create(args);
  }, false);
}
