import type { Prisma } from "@prisma/client";
import { privateIdentifier } from "../lib/secrets.js";
import { includedPeriod } from "@ensemble/shared-types";

type Tx = Prisma.TransactionClient;

export async function creditKeyFor(tx: Tx, accountId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: accountId }, select: { email: true } });
  return privateIdentifier("included-monthly-credits", user.email.trim().toLowerCase());
}

/** Caller holds the global month lock. Move legacy charges exactly once before any erasure. */
export async function accountBalance(tx: Tx, accountId: string, period: string): Promise<{ key: string; used: number }> {
  const key = await creditKeyFor(tx, accountId);
  const existing = await tx.includedCreditBalance.findUnique({ where: { creditKey_period: { creditKey: key, period } } });
  // Older workspace erasure removed included_usage but kept model.call metrics. Recover only
  // positively recorded charges before that erasure, when no corresponding billing rows remain.
  if (!existing) await tx.$executeRaw`
    INSERT INTO included_credit_balances (credit_key, period, used_usd)
    SELECT ${key}, ${period}, COALESCE(SUM(CASE WHEN jsonb_typeof(e.payload->'credits') = 'number'
      THEN GREATEST(0, (e.payload->>'credits')::numeric) / 1000 ELSE 0 END), 0)
    FROM metric_events e JOIN users u ON u.id = e.user_id
    WHERE (u.id = ${accountId} OR u.owner_id = ${accountId})
      AND e.kind = 'model.call' AND e.payload->>'provider' = 'ensemble'
      AND jsonb_typeof(e.payload->'credits') = 'number'
      AND to_char(e.ts, 'YYYY-MM') = ${period}
      AND EXISTS (SELECT 1 FROM audit_ledger a WHERE a.user_id = e.user_id
        AND a.action = 'data.delete.everything' AND a.ts >= e.ts
        AND NOT EXISTS (SELECT 1 FROM included_usage i WHERE i.user_id = e.user_id
          AND i.period = ${period} AND i.created_at <= a.ts))
    ON CONFLICT (credit_key, period) DO NOTHING`;
  await tx.$executeRaw`
    WITH adopted AS (
      UPDATE included_usage SET credit_key = ${key}
      WHERE account_id = ${accountId} AND period = ${period} AND credit_key IS NULL
      RETURNING CASE WHEN status = 'reserved' THEN reserved_usd ELSE usd END AS charge
    )
    INSERT INTO included_credit_balances (credit_key, period, used_usd)
    SELECT ${key}, ${period}, COALESCE(SUM(charge), 0) FROM adopted
    ON CONFLICT (credit_key, period) DO UPDATE
      SET used_usd = included_credit_balances.used_usd + EXCLUDED.used_usd`;
  const rows = await tx.$queryRaw<Array<{ used: string }>>`
    SELECT used_usd::text AS used FROM included_credit_balances WHERE credit_key = ${key} AND period = ${period}`;
  return { key, used: Number(rows[0]?.used ?? 0) };
}

/** Lock months before user rows, matching reservation/settlement order. No allowance is refunded. */
export async function preserveCreditAccounting(tx: Tx, userId: string): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { ownerId: true } });
  const accountId = user.ownerId ?? userId;
  const current = includedPeriod();
  const rows = await tx.$queryRaw<Array<{ account: string; period: string }>>`
    SELECT DISTINCT account_id AS account, period FROM included_usage
    WHERE user_id = ${userId} OR account_id = ${userId}
    UNION SELECT ${accountId}, ${current} ORDER BY period, account`;
  for (const row of rows) {
    await tx.$executeRaw`INSERT INTO included_periods (period) VALUES (${row.period}) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT period FROM included_periods WHERE period = ${row.period} FOR UPDATE`;
    await accountBalance(tx, row.account, row.period);
  }
}

/** Keep only amounts and settlement identities; an in-flight call needs its model until settlement. */
export async function eraseIncludedDetails(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE included_usage SET erased_at = CURRENT_TIMESTAMP, purpose = NULL, answered_by = NULL,
      model = CASE WHEN status = 'reserved' THEN model ELSE '' END,
      estimated_input_tokens = CASE WHEN status = 'reserved' THEN estimated_input_tokens ELSE 0 END,
      max_output_tokens = CASE WHEN status = 'reserved' THEN max_output_tokens ELSE 0 END,
      input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0,
      input_usd = 0, output_usd = 0
    WHERE user_id = ${userId}`;
}
