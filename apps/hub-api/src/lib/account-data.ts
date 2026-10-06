import { Prisma, type PrismaClient } from "@prisma/client";

const scopedModels = Prisma.dmmf.datamodel.models.filter((model) => model.fields.some((field) => field.name === "userId" && field.kind === "scalar"));
const PRIVATE_TABLES = new Set(["sessions", "api_tokens", "oauth_tokens", "model_credentials", "email_tokens", "auth_flows", "terminal_passkeys", "device_pairings"]);
const PRIVATE_COLUMNS = ["password_hash", "secret", "access_token", "refresh_token", "token_hash", "code_verifier", "nonce"];
const SECRET_FIELDS = new Set(["secret", "password", "passwordhash", "clientsecret", "token", "accesstoken", "refreshtoken", "apikey", "apitoken", "tokenhash", "codeverifier", "nonce", "credentials", "pat"]);

function withoutSecrets(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .flatMap(([key, item]) => item === undefined || SECRET_FIELDS.has(key.replace(/[_-]/g, "").toLowerCase()) ? [] : [[key, withoutSecrets(item)]]));
  }
  return value;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Unexpected database identifier in the account export schema.");
  return `"${value}"`;
}

export async function exportAccountData(prisma: PrismaClient, userId: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true },
    });
    const tables: Record<string, Prisma.JsonValue[]> = {};
    for (const model of scopedModels) {
      const table = model.dbName ?? model.name;
      if (PRIVATE_TABLES.has(table)) continue;
      const field = model.fields.find((item) => item.name === "userId")!;
      const rows = await tx.$queryRawUnsafe<Array<{ row: Prisma.JsonValue }>>(
        `SELECT to_jsonb(t) - $2::text[] AS row FROM ${identifier(table)} t WHERE ${identifier(field.dbName ?? field.name)} = $1`,
        userId, PRIVATE_COLUMNS,
      );
      tables[table] = rows.map((row) => withoutSecrets(row.row));
    }
    // Child rows without userId are owned through their cascading foreign keys.
    for (const model of Prisma.dmmf.datamodel.models.filter((item) => !scopedModels.includes(item) && item.name !== "User")) {
      const relation = model.fields.find((field) => field.kind === "object" && field.relationFromFields?.length === 1
        && scopedModels.some((parent) => parent.name === field.type));
      if (!relation) continue;
      const parent = scopedModels.find((item) => item.name === relation.type)!;
      const foreign = model.fields.find((field) => field.name === relation.relationFromFields![0])!;
      const table = model.dbName ?? model.name;
      const scope = parent.fields.find((field) => field.name === "userId")!;
      const rows = await tx.$queryRawUnsafe<Array<{ row: Prisma.JsonValue }>>(
        `SELECT to_jsonb(t) - $2::text[] AS row FROM ${identifier(table)} t JOIN ${identifier(parent.dbName ?? parent.name)} p ON t.${identifier(foreign.dbName ?? foreign.name)} = p.id WHERE p.${identifier(scope.dbName ?? scope.name)} = $1`,
        userId, PRIVATE_COLUMNS,
      );
      tables[table] = rows.map((row) => withoutSecrets(row.row));
    }
    return { version: 1, exportedAt: new Date().toISOString(), user, tables };
  }, { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function deleteAccountData(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { id: userId } });
    await tx.$queryRaw`SELECT id FROM workspace_jobs WHERE user_id = ${userId} FOR UPDATE`;
    const active = await tx.workspaceJob.count({ where: { userId, status: { in: ["running", "claimed", "stopping", "waiting_approval"] } } });
    if (active) throw Object.assign(new Error("Stop your active agent runs before deleting your account."), { statusCode: 409 });
    // All domain foreign keys use Cascade/SetNull; userId-only legacy tables do
    // not reference users, so they must be removed explicitly.
    for (const model of scopedModels) {
      const field = model.fields.find((item) => item.name === "userId")!;
      await tx.$executeRawUnsafe(
        `DELETE FROM ${identifier(model.dbName ?? model.name)} WHERE ${identifier(field.dbName ?? field.name)} = $1`,
        userId,
      );
    }
    await tx.user.delete({ where: { id: userId } });
  }, { timeout: 60_000 });
  try {
    const { eraseUserDatasetFiles } = await import("../plots/store.js");
    eraseUserDatasetFiles(userId);
  } catch (cause) {
    throw Object.assign(new Error("Account records were removed, but uploaded dataset file cleanup failed. Contact the operator to finish removing the stored files.", { cause }), {
      statusCode: 503, expose: true, code: "ACCOUNT_FILES_CLEANUP_FAILED",
    });
  }
}
