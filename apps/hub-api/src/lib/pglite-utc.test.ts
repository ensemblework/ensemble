/**
 * The local database (desktop app and CLI runner) runs every session in UTC,
 * whatever the computer's zone. Prisma writes UTC wall time into the schema's
 * `timestamp(3)` columns, so `NOW()`, `CURRENT_TIMESTAMP` defaults and
 * `timestamptz` values from raw SQL have to be UTC too. This file runs on a
 * computer in India (UTC+05:30), where PGlite would otherwise pick `Etc/GMT-5`.
 */
process.env.TZ = "Asia/Kolkata";
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { claimSlot } from "../jobs/claim.js";
import { closeDesktopDatabase, openDesktopDatabase, openMemoryDatabase, openPglite } from "./pglite-engine.js";

/** Comfortably more than a slow test machine needs, far less than any zone offset. */
const SAME_INSTANT_MS = 30_000;

type ZoneRow = { setting: string; reset_val: string };
const ZONE_SQL = `SELECT setting, reset_val FROM pg_settings WHERE name = 'TimeZone'`;

function near(actual: Date | null | undefined, label: string): void {
  assert.ok(actual, `${label} is missing`);
  const off = actual.getTime() - Date.now();
  assert.ok(Math.abs(off) < SAME_INSTANT_MS, `${label} is ${(off / 1000).toFixed(1)} s from now`);
}

test("this file runs on a computer in India", () => {
  assert.equal(new Date().getTimezoneOffset(), -330);
});

test("the on-disk database opens in UTC, and so does reopening it", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-pglite-utc-"));
  const dataDir = join(root, "pglite");
  try {
    await openDesktopDatabase(dataDir);
    await closeDesktopDatabase();
    const reopened = await openPglite(dataDir);
    try {
      const zone = (await reopened.query<ZoneRow>(ZONE_SQL)).rows[0];
      assert.deepEqual(zone, { setting: "UTC", reset_val: "UTC" });
      await reopened.exec("RESET ALL");
      const now = (await reopened.query<{ now: string }>(`SELECT now()::text AS now`)).rows[0]?.now ?? "";
      assert.match(now, /\+00$/);
    } finally {
      await reopened.close();
    }
  } finally {
    await closeDesktopDatabase().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("an in-memory database on a computer in India", () => {
  let db: PrismaClient;
  const userId = randomUUID();

  before(async () => {
    await openMemoryDatabase();
    const { PrismaClient } = await import("@prisma/client");
    const { desktopAdapter } = await import("./desktop-db.js");
    db = new PrismaClient({ adapter: desktopAdapter()! });
    await db.user.create({ data: { id: userId, email: `${userId}@utc.example`, name: "Mira Chen", passwordHash: "scrypt:test" } });
  });

  after(async () => {
    await db?.$disconnect();
    await closeDesktopDatabase();
  });

  test("the session is UTC", async () => {
    assert.deepEqual(await db.$queryRawUnsafe<ZoneRow[]>(ZONE_SQL), [{ setting: "UTC", reset_val: "UTC" }]);
  });

  test("NOW() and a Prisma-written new Date() are the same instant", async () => {
    await db.syncState.create({ data: { userId, connector: "mail", lastSyncAt: new Date() } });
    const [row] = await db.$queryRaw<Array<{ drift: number; expired: boolean }>>`
      SELECT EXTRACT(EPOCH FROM (NOW() - last_sync_at))::float8 AS drift,
             last_sync_at < NOW() - interval '1 minute' AS expired
      FROM sync_state WHERE user_id = ${userId} AND connector = 'mail'`;
    assert.ok(row);
    assert.ok(Math.abs(row.drift) * 1000 < SAME_INSTANT_MS, `NOW() is ${row.drift.toFixed(1)} s after a Prisma-written new Date()`);
    assert.equal(row.expired, false);
  });

  test("NOW() written by raw SQL reads back through Prisma as the right instant", async () => {
    assert.equal(await claimSlot(db, userId, "schedule:mail", "slot-1"), true);
    const claimed = await db.syncState.findUniqueOrThrow({ where: { userId_connector: { userId, connector: "schedule:mail" } } });
    near(claimed.lastSyncAt, "a slot's last_sync_at = NOW()");
    near(claimed.updatedAt, "a slot's updated_at = NOW()");
  });

  test("a CURRENT_TIMESTAMP column default and Prisma's now() default agree", async () => {
    const raw = randomUUID();
    await db.$executeRaw`INSERT INTO preferences (id, user_id, key, value, updated_at) VALUES (${raw}, ${userId}, 'raw', '{}'::jsonb, ${new Date()})`;
    const viaPrisma = await db.preference.create({ data: { userId, key: "prisma", value: {} } });
    const viaDefault = await db.preference.findUniqueOrThrow({ where: { id: raw } });
    near(viaPrisma.createdAt, "Prisma's @default(now())");
    near(viaDefault.createdAt, "created_at DEFAULT CURRENT_TIMESTAMP");
  });

  test("a raw now() comes back as the right instant", async () => {
    const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    near(row?.now, "SELECT now()");
  });
});
