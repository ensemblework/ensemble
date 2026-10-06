import { DEFAULT_SETTINGS, Settings, type Settings as SettingsType } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { isHosted } from "./hosted-access.js";
import { checkConnectorLimit, withHostedUserLock } from "./hosted-limits.js";

const KEY = "hub.settings";

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Arrays replace; objects merge. A settings patch never has to resend a whole section. */
export function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) && isPlain(base[key]) ? deepMerge(base[key] as Plain, value) : value;
  }
  return out;
}

export async function loadSettings(prisma: PrismaClient | Prisma.TransactionClient, userId: string): Promise<SettingsType> {
  const row = await prisma.preference.findFirst({ where: { userId, key: KEY, deletedAt: null } });
  const parsed = Settings.safeParse(row?.value ?? {});
  const base = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  if (!row) return { ...base, autonomy: env.ENSEMBLE_AUTONOMY_LEVEL, timezone: env.ENSEMBLE_TIMEZONE };
  return base;
}

export async function saveSettings(prisma: PrismaClient, userId: string, patch: unknown): Promise<SettingsType> {
  const write = async (db: PrismaClient | Prisma.TransactionClient) => {
    const current = await loadSettings(db, userId);
    const next = Settings.parse(deepMerge(current as unknown as Plain, isPlain(patch) ? patch : {}));
    checkConnectorLimit(next.connections);
    await db.preference.upsert({
      where: { userId_key: { userId, key: KEY } },
      create: { userId, key: KEY, value: next, source: "me" },
      update: { value: next, source: "me", deletedAt: null },
    });
    return next;
  };
  if (isHosted()) return withHostedUserLock(prisma, userId, write, isPlain(patch) && "connections" in patch);
  return write(prisma);
}
