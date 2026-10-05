/**
 * One row in sync_state is the lock for a scheduled slot.
 * Insert, or update only when the stored cursor is a different slot.
 * Postgres holds the row lock, so two API processes during a deploy
 * cannot both receive a row back for the same slot.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

type ClaimDb = Pick<PrismaClient, "$queryRaw">;

export async function claimSlot(db: ClaimDb, userId: string, connector: string, slot: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO sync_state (id, user_id, connector, cursor, last_sync_at, item_count, updated_at)
    VALUES (${randomUUID()}, ${userId}, ${connector}, ${slot}, NOW(), 0, NOW())
    ON CONFLICT (user_id, connector)
    DO UPDATE SET
      cursor = EXCLUDED.cursor,
      last_sync_at = EXCLUDED.last_sync_at,
      updated_at = NOW()
    WHERE sync_state.cursor IS DISTINCT FROM EXCLUDED.cursor
    RETURNING id
  `;
  return rows.length === 1;
}
