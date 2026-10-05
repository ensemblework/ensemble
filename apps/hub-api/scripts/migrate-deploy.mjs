/**
 * Apply pending migrations with `prisma migrate deploy`.
 * `migrate dev` compares the live database to a shadow replay and, on drift,
 * asks to reset the public schema. Deploy only runs migrations that are not
 * recorded yet, so the workspace repair can land without deleting rows.
 *
 * A database created with `pnpm db:push` has tables and no migration history.
 * Deploy refuses that with P3005. Replaying the files would fail too, because
 * several of them add columns and tables that db push already created. This
 * script aligns the schema in place, records those migrations as applied, and
 * does not reset the database.
 *
 * When the workspace repair migration actually runs, its summary is stored on
 * `_prisma_migrations.logs` (the migrate CLI does not print RAISE NOTICE).
 * This script prints that summary.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { config } from "dotenv";
import { ensureLocalDatabase } from "./ensure-local-db.mjs";
import { alreadyRecorded, nextMigrateStep } from "./migrate-plan.mjs";

const repair = "20261001180000_workspace_fk_indexes";
const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) config({ path: envFile });

const require = createRequire(import.meta.url);
const prismaEntry = require.resolve("prisma/build/index.js");

function runPrisma(args) {
  return spawnSync(process.execPath, [prismaEntry, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function show(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function migrationNames() {
  const root = new URL("../prisma/migrations/", import.meta.url);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/migration.sql`, root)))
    .map((entry) => entry.name)
    .sort();
}

function schemaInSync() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const diff = runPrisma(["migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]);
  if (diff.status === 1) show(diff);
  return diff.status === 0;
}

function finish(deployed) {
  if (!combined(deployed).includes(repair)) return;
  const generated = runPrisma(["generate"]);
  if (generated.status !== 0) {
    show(generated);
    console.error("prisma migrate deploy applied the workspace repair. prisma generate failed, so the repair log was not printed. It is stored on _prisma_migrations.logs.");
    return;
  }
  return printRepairLog();
}

async function printRepairLog() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT logs FROM "_prisma_migrations" WHERE migration_name = ${repair}
    `;
    const logs = rows[0]?.logs;
    if (typeof logs === "string" && logs.trim()) console.log(logs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Workspace repair applied. Could not read its log: ${message}`);
  } finally {
    await prisma.$disconnect();
  }
}

function baseline() {
  console.error(
    "This database already has tables and no migration history (Prisma P3005). That is what an earlier pnpm db:push leaves behind. Rows stay. The schema is aligned in place, then the existing migrations are recorded as applied. Do not run prisma migrate reset.",
  );
  const pushed = runPrisma(["db", "push", "--skip-generate"]);
  show(pushed);
  if (pushed.status !== 0) {
    console.error("Could not align this database without dropping data. Nothing was reset.");
    process.exit(pushed.status ?? 1);
  }
  for (const name of migrationNames()) {
    const resolved = runPrisma(["migrate", "resolve", "--applied", name]);
    if (resolved.status !== 0 && !alreadyRecorded(combined(resolved))) {
      show(resolved);
      process.exit(resolved.status ?? 1);
    }
  }
  const generated = runPrisma(["generate"]);
  show(generated);
}

const database = await ensureLocalDatabase();
if (database.action === "failed") process.exit(database.status ?? 1);

const status = runPrisma(["migrate", "status"]);
show(status);
const statusText = combined(status);
if (/P1001|Can't reach database server/i.test(statusText)) {
  console.error(
    "Prisma could not open DATABASE_URL. If this is the local database, open Docker Desktop and run pnpm infra:up from the repo root, then retry.",
  );
  process.exit(status.status ?? 1);
}
const pending = /have not yet been applied/i.test(statusText);
const step = nextMigrateStep(statusText, pending ? schemaInSync() : false);

if (step === "baseline") baseline();

if (step !== "done") {
  let deployed = runPrisma(["migrate", "deploy"]);
  show(deployed);
  // `migrate status` lists pending files for a db-push database. `migrate deploy`
  // then refuses with P3005 when those files were never recorded. Align in place.
  if (deployed.status !== 0 && step !== "baseline" && nextMigrateStep(combined(deployed), false) === "baseline") {
    baseline();
    deployed = runPrisma(["migrate", "deploy"]);
    show(deployed);
  }
  if (deployed.status !== 0) process.exit(deployed.status ?? 1);
  await finish(deployed);
}
