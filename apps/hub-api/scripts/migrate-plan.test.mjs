import assert from "node:assert/strict";
import test from "node:test";
import { alreadyRecorded, nextMigrateStep } from "./migrate-plan.mjs";

const pending = `
20 migrations found in prisma/migrations
Following migrations have not yet been applied:
20261001120000_plots
`;

test("an up to date database is left alone", () => {
  assert.equal(nextMigrateStep("Database schema is up to date!\n", false), "done");
});

test("P3005 baselined a db-push database instead of replaying SQL", () => {
  const text = "Error: P3005\n\nThe database schema is not empty.\n";
  assert.equal(nextMigrateStep(text, false), "baseline");
});

test("pending migrations on a database that already matches the schema are recorded, not replayed", () => {
  assert.equal(nextMigrateStep(pending, true), "baseline");
});

test("pending migrations on an empty or older database are deployed", () => {
  assert.equal(nextMigrateStep(pending, false), "deploy");
});

test("a connection failure is not treated as a baseline", () => {
  assert.equal(nextMigrateStep("Can't reach database server at `127.0.0.1:5432`", false), "deploy");
});

test("resolving a migration that is already recorded is success", () => {
  assert.equal(alreadyRecorded("Error: P3008\n\nThe migration `20260929100000_db_push_baseline` is already recorded as applied in the database."), true);
  assert.equal(alreadyRecorded("Migration 20261001120000_plots marked as applied.\n"), false);
});
