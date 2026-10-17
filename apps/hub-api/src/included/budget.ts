/**
 * The Ensemble credits ledger for included models. Every call reserves its worst case before it
 * runs and settles with the real usage after it, so neither an account's monthly credits nor the
 * operator's monthly ceiling can be overrun by calls in flight. One row in `included_periods` per
 * month is the lock all reservations and settlements take (docs/33).
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  INCLUDED_CREDITS_USED,
  INCLUDED_PAUSED,
  INCLUDED_UNAVAILABLE,
  includedModelName,
  includedPeriod,
  includedResetsAt,
  type IncludedUsage,
  type IncludedUsageRow,
} from "@ensemble/shared-types";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { CREDITS_PER_USD, includedConfig, type IncludedConfig } from "./config.js";
import { IncludedLimitError, includedMessage } from "./errors.js";
import { includedCost, worstCaseUsd, type IncludedTokens } from "./pricing.js";

type Tx = Prisma.TransactionClient;

/** A reservation nobody settled in this long (a crashed runtime) is charged at its reserved amount. */
export const STALE_RESERVATION_MS = 30 * 60_000;

let db: PrismaClient = defaultPrisma;
let fake: { reserve: typeof reserveIncluded; settle: typeof settleIncluded } | null = null;

export function setIncludedDatabaseForTests(client: PrismaClient | null): void {
  db = client ?? defaultPrisma;
}

/** The in-process runtime's tests swap the ledger out. */
export function setIncludedBudgetForTests(value: { reserve: typeof reserveIncluded; settle: typeof settleIncluded } | null): void {
  fake = value;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

/** The account that pays for a call: a space resolves to its owner. */
async function accountOf(client: PrismaClient | Tx, userId: string): Promise<string> {
  const row = await client.user.findUnique({ where: { id: userId }, select: { id: true, ownerId: true } });
  if (!row) throw new IncludedLimitError(INCLUDED_UNAVAILABLE, "A signed-in account is required to use included models.");
  return row.ownerId ?? row.id;
}

function configured(model?: string): IncludedConfig {
  const config = includedConfig();
  if (!config) throw new IncludedLimitError(INCLUDED_UNAVAILABLE);
  if (model && !config.models.some((item) => item.id === model)) {
    throw new IncludedLimitError(INCLUDED_UNAVAILABLE, `${includedModelName(model)} is not offered on this server. Pick another included model in Settings → Models.`);
  }
  return config;
}

/** Locks this month's row, creating it on the month's first call. */
async function lockPeriod(tx: Tx, period: string): Promise<{ spent: number; reserved: number }> {
  await tx.$executeRaw`INSERT INTO included_periods (period) VALUES (${period}) ON CONFLICT (period) DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ spent: string; reserved: string }>>`
    SELECT spent_usd::text AS spent, reserved_usd::text AS reserved FROM included_periods WHERE period = ${period} FOR UPDATE`;
  return { spent: num(rows[0]?.spent), reserved: num(rows[0]?.reserved) };
}

/** Charges abandoned reservations of this month at what they reserved. Runs under the month lock. */
async function expireStale(tx: Tx, period: string, now: Date): Promise<void> {
  const before = new Date(now.getTime() - STALE_RESERVATION_MS);
  const rows = await tx.$queryRaw<Array<{ total: string | null }>>`
    WITH stale AS (
      UPDATE included_usage
         SET status = 'expired', usd = reserved_usd, settled_at = ${now}
       WHERE period = ${period} AND status = 'reserved' AND created_at < ${before}
   RETURNING reserved_usd
    )
    SELECT SUM(reserved_usd)::text AS total FROM stale`;
  const total = num(rows[0]?.total);
  if (total > 0) {
    await tx.$executeRaw`
      UPDATE included_periods
         SET reserved_usd = GREATEST(reserved_usd - ${total}::numeric, 0), spent_usd = spent_usd + ${total}::numeric, updated_at = ${now}
       WHERE period = ${period}`;
  }
}

/** USD an account has spent or holds in reservations this month. */
async function accountUsedUsd(client: PrismaClient | Tx, account: string, period: string): Promise<number> {
  const rows = await client.$queryRaw<Array<{ used: string | null }>>`
    SELECT SUM(CASE WHEN status = 'reserved' THEN reserved_usd ELSE usd END)::text AS used
      FROM included_usage WHERE account_id = ${account} AND period = ${period}`;
  return num(rows[0]?.used);
}

function refusal(code: typeof INCLUDED_CREDITS_USED | typeof INCLUDED_PAUSED, resetsAt: Date, detail?: { need?: number; left?: number }): IncludedLimitError {
  return new IncludedLimitError(code, includedMessage(code, resetsAt, detail), resetsAt.toISOString());
}

export type IncludedReservation = { id: string };

/**
 * Holds the most this call can cost against the account's credits and the month's ceiling, or
 * refuses it. The refusal says which limit was reached and when it resets.
 */
export async function reserveIncluded(args: {
  userId: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  purpose?: string | null;
}): Promise<IncludedReservation> {
  if (fake) return fake.reserve(args);
  const config = configured(args.model);
  await requireVerifiedUser(args.userId);
  const account = await accountOf(db, args.userId);
  const now = new Date();
  const period = includedPeriod(now);
  const resetsAt = includedResetsAt(now);
  const inputTokens = Math.max(0, Math.ceil(args.inputTokens));
  const maxOutputTokens = Math.max(1, Math.ceil(args.maxOutputTokens));
  const need = worstCaseUsd(args.model, inputTokens, maxOutputTokens);
  const limitUsd = config.monthlyCredits / CREDITS_PER_USD;
  return db.$transaction(
    async (tx) => {
      await lockPeriod(tx, period);
      await expireStale(tx, period, now);
      const total = await lockPeriod(tx, period);
      if (total.spent + total.reserved + need > config.totalMonthlyUsd) throw refusal(INCLUDED_PAUSED, resetsAt);
      const used = await accountUsedUsd(tx, account, period);
      if (used + need > limitUsd) {
        throw refusal(INCLUDED_CREDITS_USED, resetsAt, { need: need * CREDITS_PER_USD, left: Math.max(0, limitUsd - used) * CREDITS_PER_USD });
      }
      const id = randomUUID();
      await tx.$executeRaw`
        INSERT INTO included_usage (id, account_id, user_id, period, model, purpose, status, estimated_input_tokens, max_output_tokens, reserved_usd, created_at)
        VALUES (${id}, ${account}, ${args.userId}, ${period}, ${args.model}, ${args.purpose ?? null}, 'reserved', ${inputTokens}, ${maxOutputTokens}, ${need}::numeric, ${now})`;
      await tx.$executeRaw`
        UPDATE included_periods SET reserved_usd = reserved_usd + ${need}::numeric, updated_at = ${now} WHERE period = ${period}`;
      return { id };
    },
    { isolationLevel: "ReadCommitted" },
  );
}

/**
 * Replaces a reservation with the call's real cost. `usage` null means the call stopped without
 * the provider saying what it used (a cancelled request), so the reservation is charged in full.
 * Settling twice returns the first result.
 */
export async function settleIncluded(args: { id: string; usage: IncludedTokens | null; answeredBy?: string | null }): Promise<{ credits: number }> {
  if (fake) return fake.settle(args);
  const head = await db.includedUsage.findUnique({ where: { id: args.id }, select: { period: true } });
  if (!head) throw new Error("Unknown included reservation.");
  const now = new Date();
  return db.$transaction(
    async (tx) => {
      await lockPeriod(tx, head.period);
      const rows = await tx.$queryRaw<
        Array<{ model: string; status: string; reserved: string; usd: string; est_in: number; max_out: number }>
      >`SELECT model, status, reserved_usd::text AS reserved, usd::text AS usd, estimated_input_tokens AS est_in, max_output_tokens AS max_out
          FROM included_usage WHERE id = ${args.id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("Unknown included reservation.");
      if (row.status !== "reserved") return { credits: num(row.usd) * CREDITS_PER_USD };
      const reserved = num(row.reserved);
      const usage = args.usage;
      const cost = usage
        ? includedCost(row.model, usage)
        : includedCost(row.model, { inputTokens: row.est_in, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: row.max_out });
      const tokens = usage ?? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      // Cannot happen while Azure stops each reply at the cap; it is charged as reported if it does.
      if (cost.usd > reserved + 1e-9) console.error(`Included call ${args.id} on ${row.model} settled above its reservation: $${cost.usd.toFixed(6)} > $${reserved.toFixed(6)}.`);
      await tx.$executeRaw`
        UPDATE included_usage
           SET status = ${usage ? "settled" : "unreported"}, usd = ${cost.usd}::numeric, input_usd = ${cost.inputUsd}::numeric, output_usd = ${cost.outputUsd}::numeric,
               input_tokens = ${Math.max(0, Math.floor(tokens.inputTokens))}, cache_read_tokens = ${Math.max(0, Math.floor(tokens.cacheReadTokens))},
               cache_write_tokens = ${Math.max(0, Math.floor(tokens.cacheWriteTokens))}, output_tokens = ${Math.max(0, Math.floor(tokens.outputTokens))},
               answered_by = ${args.answeredBy ?? null}, settled_at = ${now}
         WHERE id = ${args.id}`;
      await tx.$executeRaw`
        UPDATE included_periods
           SET reserved_usd = GREATEST(reserved_usd - ${reserved}::numeric, 0), spent_usd = spent_usd + ${cost.usd}::numeric, updated_at = ${now}
         WHERE period = ${head.period}`;
      return { credits: cost.usd * CREDITS_PER_USD };
    },
    { isolationLevel: "ReadCommitted" },
  );
}

/**
 * The cheap check before a chat opens its stream: refuses when the account has no credits left or
 * the month's ceiling is reached, so the person gets a plain 429 instead of a failed turn. The
 * runtime's reservation is still the check that counts.
 */
export async function assertIncludedOpen(userId: string, model: string): Promise<void> {
  const config = configured(model);
  const now = new Date();
  const period = includedPeriod(now);
  const resetsAt = includedResetsAt(now);
  const totals = await db.includedPeriod.findUnique({ where: { period } });
  if (totals && num(totals.spentUsd) + num(totals.reservedUsd) >= config.totalMonthlyUsd) throw refusal(INCLUDED_PAUSED, resetsAt);
  const used = await accountUsedUsd(db, await accountOf(db, userId), period);
  if (used >= config.monthlyCredits / CREDITS_PER_USD) throw refusal(INCLUDED_CREDITS_USED, resetsAt);
}

const emptyRow = (): IncludedUsageRow => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, inputCredits: 0, outputCredits: 0, credits: 0 });

type Grouped = { key: string | null; calls: number; input_tokens: string; cached: string; output_tokens: string; input_usd: string; output_usd: string; usd: string };

function usageRow(row: Grouped | undefined): IncludedUsageRow {
  if (!row) return emptyRow();
  return {
    calls: Number(row.calls),
    inputTokens: num(row.input_tokens),
    cachedTokens: num(row.cached),
    outputTokens: num(row.output_tokens),
    inputCredits: round(num(row.input_usd) * CREDITS_PER_USD),
    outputCredits: round(num(row.output_usd) * CREDITS_PER_USD),
    credits: round(num(row.usd) * CREDITS_PER_USD),
  };
}

/** This account's included credits for the current month, in credits only. */
export async function includedUsage(userId: string, now = new Date()): Promise<IncludedUsage> {
  const period = includedPeriod(now);
  const resetsAt = includedResetsAt(now).toISOString();
  const config = includedConfig();
  if (!config) {
    return { available: false, models: [], period, resetsAt, limit: 0, used: 0, remaining: 0, paused: false, totals: emptyRow(), byModel: [], byPurpose: [], days: [] };
  }
  const account = await accountOf(db, userId);
  // A reservation still in flight counts at what it holds; its tokens are not known yet.
  const charged = `CASE WHEN status = 'reserved' THEN reserved_usd ELSE usd END`;
  const grouped = (by: string) => db.$queryRawUnsafe<Grouped[]>(
    `SELECT ${by} AS key, COUNT(*)::int AS calls, SUM(input_tokens)::text AS input_tokens, SUM(cache_read_tokens)::text AS cached,
            SUM(output_tokens)::text AS output_tokens,
            SUM(CASE WHEN status = 'reserved' THEN 0 ELSE input_usd END)::text AS input_usd,
            SUM(CASE WHEN status = 'reserved' THEN 0 ELSE output_usd END)::text AS output_usd,
            SUM(${charged})::text AS usd
       FROM included_usage WHERE account_id = $1 AND period = $2 GROUP BY 1 ORDER BY 1`,
    account,
    period,
  );
  const [models, purposes, days, all, totals] = await Promise.all([
    grouped("model"),
    grouped("COALESCE(purpose, 'Other')"),
    // created_at holds UTC wall time (timestamp without time zone), so the day is read as stored.
    grouped("to_char(created_at, 'YYYY-MM-DD')"),
    grouped("'all'"),
    db.includedPeriod.findUnique({ where: { period } }),
  ]);
  const usedUsd = num(all[0]?.usd);
  const usedCredits = round(usedUsd * CREDITS_PER_USD);
  return {
    available: true,
    models: config.models.map(({ id, label, vendor, azureVersion, efforts, autoEffort, relativeCost, role }) => ({ id, label, vendor, azureVersion, efforts, autoEffort, relativeCost, role })),
    period,
    resetsAt,
    limit: config.monthlyCredits,
    used: usedCredits,
    remaining: Math.max(0, round(config.monthlyCredits - usedCredits)),
    paused: totals ? num(totals.spentUsd) + num(totals.reservedUsd) >= config.totalMonthlyUsd : false,
    totals: usageRow(all[0]),
    byModel: models.map((row) => ({ ...usageRow(row), model: String(row.key), label: includedModelName(String(row.key)) })).sort((a, b) => b.credits - a.credits),
    byPurpose: purposes.map((row) => ({ purpose: String(row.key), calls: Number(row.calls), credits: usageRow(row).credits })).sort((a, b) => b.credits - a.credits),
    days: days.map((row) => ({ day: String(row.key), credits: usageRow(row).credits, calls: Number(row.calls) })),
  };
}

/** The operator's view: this month's spend across all accounts, in USD. Never sent to people. */
export async function includedSpendUsd(now = new Date()): Promise<{ period: string; spentUsd: number; reservedUsd: number; ceilingUsd: number | null }> {
  const period = includedPeriod(now);
  const row = await db.includedPeriod.findUnique({ where: { period } });
  return { period, spentUsd: num(row?.spentUsd), reservedUsd: num(row?.reservedUsd), ceilingUsd: includedConfig()?.totalMonthlyUsd ?? null };
}
