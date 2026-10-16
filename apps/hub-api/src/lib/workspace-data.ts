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
  "AuditLedger",
  "MetricEvent",
  "MetricBaseline",
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
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
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
