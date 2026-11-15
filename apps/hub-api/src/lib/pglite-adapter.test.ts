/**
 * Prisma's Rust-free client (`engineType = "client"`) on PGlite, as the Windows arm64 sidecar runs it:
 * the adapter wrapper in pglite-adapter.ts converts bytes and timestamps and names constraint errors.
 * The integration test generates that client into a scratch folder under node_modules/.cache (where it
 * finds @prisma/client's runtime), so the workspace's own client stays as it is.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyMigration, appliedMigrationNames, listMigrationFiles, migrationsDir, openPglite } from "./pglite-engine.js";
import { nameDatabaseError, pgliteAdapter, withBinary, withUtcTimes } from "./pglite-adapter.js";

// A timestamp read as local time is off by this zone's offset, which UTC (CI) would hide.
process.env.TZ = "Asia/Kolkata";
const require = createRequire(import.meta.url);
const hubApi = fileURLToPath(new URL("../../", import.meta.url));

test("bytes go to PGlite as binary; other values and the Rust engine's binary values are left alone", () => {
  const query = {
    sql: "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
    args: ["AAEC", ["AAE=", "/w=="], "AAEC"],
    argTypes: [{ scalarType: "bytes", arity: "scalar" }, { scalarType: "bytes", arity: "list" }, { scalarType: "string", arity: "scalar" }],
  };
  const converted = withBinary(query).args;
  assert.deepEqual(converted[0], Buffer.from([0, 1, 2]));
  assert.deepEqual(converted[1], [Buffer.from([0, 1]), Buffer.from([255])]);
  assert.equal(converted[2], "AAEC");
  const binary = new Uint8Array([1, 2]);
  assert.equal(withBinary({ ...query, args: [binary, [], "x"] }).args[0], binary);
  const plain = { sql: "SELECT $1", args: ["x"], argTypes: [{ scalarType: "string", arity: "scalar" }] };
  assert.equal(withBinary(plain), plain);
});

test("timestamps without an offset are UTC; values with one, and other columns, are kept", () => {
  const result = withUtcTimes({
    columnNames: ["at", "with_zone", "list", "text"],
    columnTypes: [10, 10, 74, 7],
    rows: [["2026-11-15 10:20:30.456", "2026-11-15 10:20:30-05", ["2026-11-15 10:20:30", null], "2026-11-15 10:20:30"]],
  });
  assert.deepEqual(result.rows[0], ["2026-11-15T10:20:30.456+00:00", "2026-11-15 10:20:30-05", ["2026-11-15T10:20:30+00:00", null], "2026-11-15 10:20:30"]);
  assert.equal(new Date(result.rows[0][0] as string).toISOString(), "2026-11-15T10:20:30.456Z");
});

test("database errors get the kinds the Rust engine read from their SQLSTATE codes", () => {
  const error = (cause: Record<string, unknown>) => Object.assign(new Error("database error"), { name: "DriverAdapterError", cause: { kind: "postgres", ...cause } });
  const unique = nameDatabaseError(error({ code: "23505", message: 'duplicate key value violates unique constraint "users_email_key"', detail: "Key (email)=(a@b.c) already exists." })) as { cause: Record<string, unknown> };
  assert.deepEqual(unique.cause, { kind: "UniqueConstraintViolation", constraint: { fields: ["email"] }, originalCode: "23505", originalMessage: 'duplicate key value violates unique constraint "users_email_key"' });
  const foreign = nameDatabaseError(error({ code: "23503", message: 'insert or update on table "tasks" violates foreign key constraint "tasks_user_id_fkey"' })) as { cause: Record<string, unknown> };
  assert.deepEqual(foreign.cause.constraint, { index: "tasks_user_id_fkey" });
  assert.equal((nameDatabaseError(error({ code: "23502", column: "title" })) as { cause: { kind: string } }).cause.kind, "NullConstraintViolation");
  assert.equal((nameDatabaseError(error({ code: "40001" })) as { cause: { kind: string } }).cause.kind, "TransactionWriteConflict");
  const other = nameDatabaseError(error({ code: "22P02", message: "invalid input syntax" })) as { cause: Record<string, unknown> };
  assert.equal(other.cause.kind, "postgres");
  assert.equal(other.cause.originalCode, "22P02");
  const plain = new Error("not from the database");
  assert.equal(nameDatabaseError(plain), plain);
});

test("Prisma's Rust-free client reads and writes PGlite like the Rust engine", { timeout: 180_000 }, async () => {
  mkdirSync(join(hubApi, "node_modules", ".cache"), { recursive: true });
  const scratch = mkdtempSync(join(hubApi, "node_modules", ".cache", "rust-free-client-"));
  try {
    const schema = readFileSync(join(hubApi, "prisma", "schema.prisma"), "utf8").replace(
      /(generator client \{\r?\n)/,
      `$1  engineType      = "client"\n  output          = ${JSON.stringify(join(scratch, "client"))}\n`,
    );
    writeFileSync(join(scratch, "schema.prisma"), schema);
    const cli = join(dirname(require.resolve("prisma/package.json")), "build", "index.js");
    const generated = spawnSync(process.execPath, [cli, "generate", "--schema", join(scratch, "schema.prisma")], { encoding: "utf8", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
    assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
    const { PrismaClient, Prisma } = require(join(scratch, "client", "index.js")) as typeof import("@prisma/client");

    const db = await openPglite();
    await appliedMigrationNames(db);
    for (const file of listMigrationFiles(migrationsDir())) await applyMigration(db, file);
    const prisma = new PrismaClient({ adapter: pgliteAdapter(db, { rustFree: true }) as never });
    try {
      const code = (error: unknown) => (error instanceof Prisma.PrismaClientKnownRequestError ? error.code : String(error));
      const email = `${randomUUID()}@rust-free.test`;
      const user = await prisma.user.create({ data: { email, name: "Rust-free", passwordHash: "x" } });
      assert.equal(await prisma.user.create({ data: { email, name: "Again", passwordHash: "x" } }).then(() => "none", code), "P2002");
      assert.equal(await prisma.task.create({ data: { userId: randomUUID(), title: "orphan" } }).then(() => "none", code), "P2003");
      assert.equal(await prisma.task.update({ where: { id: randomUUID() }, data: { title: "x" } }).then(() => "none", code), "P2025");

      const original = Buffer.from([0, 1, 2, 92, 120, 39, 250, 255]);
      const at = new Date("2026-11-15T10:20:30.456Z");
      await prisma.document.create({ data: { userId: user.id, filename: "a.bin", mediaType: "application/octet-stream", byteSize: original.length, sha256: "s", original, format: "bin", parsedAt: at } });
      const document = await prisma.document.findFirstOrThrow({ where: { userId: user.id } });
      assert.ok(Buffer.from(document.original!).equals(original));
      assert.equal(document.parsedAt!.toISOString(), at.toISOString());
      const [raw] = await prisma.$queryRaw<{ hex: string; parsed: Date; echoed: Buffer }[]>`SELECT encode(original, 'hex') AS hex, parsed_at AS parsed, ${original}::bytea AS echoed FROM context_documents WHERE user_id = ${user.id}`;
      assert.equal(raw.hex, original.toString("hex"));
      assert.equal(raw.parsed.toISOString(), at.toISOString(), "a raw query's timestamp is UTC, not local time");
      assert.ok(Buffer.from(raw.echoed).equals(original));
      assert.equal(await prisma.$queryRawUnsafe("SELECT * FROM no_such_table").then(() => "none", code), "P2010");

      await prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { userId: user.id, title: "kept" } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      await prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { userId: user.id, title: "rolled back" } });
        throw new Error("stop");
      }).catch(() => undefined);
      assert.deepEqual((await prisma.task.findMany({ where: { userId: user.id }, select: { title: true } })).map((task) => task.title), ["kept"]);
    } finally {
      await prisma.$disconnect();
      await db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
