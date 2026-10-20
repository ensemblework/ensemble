import { preserveCreditAccounting, eraseIncludedDetails } from "../included/accounting.js";
import { lockUserTransaction } from "./user-lock.js";
import { appendLedgerInTransaction } from "./ledger.js";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

const KEPT_MODELS = new Set([
  "Session",
  "ApiToken",
  "AuthToken",
  "AuthIdentity",
  "AuthFlow",
  "EmailToken",
  "ModelCredential",
  "TerminalPasskey",
  "Device",
  "DevicePairing",
  "CliAuthRequest",
  "ConnectorApp",
  "McpConnection",
  "IncludedUsage",
  "TerminalSettings",
  "Preference",
]);
const CONTEXT_MODELS = new Set([
  "Artifact",
  "Document",
  "MeetingNote",
  "MeetingSession",
  "Extraction",
  "ContextPack",
  "SyncState",
  "Person",
  "Repo",
  "ProjectLink",
]);

/** Keep the account, sign-ins, configuration and deletion audit; erase the selected workspace data. */
export async function deleteWorkspaceData(
  prisma: PrismaClient,
  userId: string,
  scope: "context" | "everything",
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await preserveCreditAccounting(tx, userId);
      await lockUserTransaction(tx, userId);
      const active = await tx.workspaceJob.count({
        where: {
          userId,
          status: {
            in: ["claimed", "running", "stopping", "waiting_approval"],
          },
        },
      });
      if (active)
        throw Object.assign(
          new Error("Stop your active agent tasks before deleting your data."),
          { statusCode: 409 },
        );
      for (const model of Prisma.dmmf.datamodel.models) {
        const field = model.fields.find(
          (field) => field.name === "userId" && field.kind === "scalar",
        );
        if (
          !field ||
          (scope === "everything"
            ? KEPT_MODELS.has(model.name)
            : !CONTEXT_MODELS.has(model.name))
        )
          continue;
        const table = model.dbName ?? model.name;
        const column = field.dbName ?? field.name;
        if (
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table + "") ||
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)
        )
          throw new Error("Unexpected schema identifier.");
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "${column}" = $1`,
          userId,
        );
      }
      if (scope === "everything") {
        await eraseIncludedDetails(tx, userId);
        // Undo payloads and learned preferences can contain the erased content.
        await tx.preference.deleteMany({
          where: {
            userId,
            NOT: {
              OR: [{ key: "hub.settings" }, { key: { startsWith: "ui." } }],
            },
          },
        });
      }
      const value = randomUUID();
      await tx.preference.upsert({
        where: { userId_key: { userId, key: "hub.data-erasure" } },
        create: { userId, key: "hub.data-erasure", value, source: "system" },
        update: { value, deletedAt: null },
      });
      await appendLedgerInTransaction(tx, { userId, actor: "me", action: `data.delete.${scope}` });
    },
    { timeout: 60_000 },
  );
  if (scope === "everything") {
    const { eraseUserDatasetFiles } = await import("../plots/store.js");
    eraseUserDatasetFiles(userId);
  }
}

export async function dataErasureVersion(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const row = await prisma.preference.findUnique({
    where: { userId_key: { userId, key: "hub.data-erasure" } },
  });
  return typeof row?.value === "string" ? row.value : null;
}

/** Retire usage left by an earlier Everything erasure, preserving charges before their evidence. */
export async function repairErasedUsage(prisma: PrismaClient, userId: string): Promise<void> {
  const erased = await prisma.auditLedger.findFirst({
    where: { userId, action: "data.delete.everything" },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    select: { id: true, ts: true },
  });
  if (!erased) return;
  const key = "hub.usage-erasure-repair";
  const marker = await prisma.preference.findUnique({ where: { userId_key: { userId, key } } });
  if (marker?.value === erased.id) return;
  await prisma.$transaction(async tx => {
    await preserveCreditAccounting(tx, userId);
    await lockUserTransaction(tx, userId);
    await tx.metricEvent.deleteMany({ where: { userId, ts: { lte: erased.ts } } });
    await tx.metricBaseline.deleteMany({ where: { userId, createdAt: { lte: erased.ts } } });
    await tx.preference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: erased.id, source: "system" },
      update: { value: erased.id, deletedAt: null },
    });
  }, { timeout: 60_000 });
}
