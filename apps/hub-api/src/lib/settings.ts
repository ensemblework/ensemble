import { DEFAULT_SETTINGS, Settings, type Settings as SettingsType } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config.js";

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

export async function loadSettings(prisma: PrismaClient, userId: string): Promise<SettingsType> {
  const row = await prisma.preference.findFirst({ where: { userId, key: KEY, deletedAt: null } });
  const parsed = Settings.safeParse(row?.value ?? {});
  const base = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  if (!row) return { ...base, autonomy: env.ENSEMBLE_AUTONOMY_LEVEL, timezone: env.ENSEMBLE_TIMEZONE };
  return base;
}

export async function saveSettings(prisma: PrismaClient, userId: string, patch: unknown): Promise<SettingsType> {
  const current = await loadSettings(prisma, userId);
  const next = Settings.parse(deepMerge(current as unknown as Plain, isPlain(patch) ? patch : {}));
  await prisma.preference.upsert({
    where: { userId_key: { userId, key: KEY } },
    create: { userId, key: KEY, value: next, source: "me" },
    update: { value: next, source: "me", deletedAt: null },
  });
  return next;
}
