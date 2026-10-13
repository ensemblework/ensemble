/**
 * The models each person's keys reach, kept in `model_catalogs` so the settings do not ask every
 * provider on each visit. A provider's list is fetched again when it is a week old, when its key
 * changed, after an error (ten minutes), or when the person presses Refresh. Only providers with a
 * key are asked. What a provider says about each model (its thinking levels) is kept with the list
 * and checked before a model call (`effortToSend` in model-meta.ts), so the level sent is the level chosen.
 */
import type { Prisma } from "@prisma/client";
import type { ModelMeta } from "@ensemble/shared-types";
import { keysFor } from "../sharing/context.js";
import { forgetMeta, rememberMeta } from "./model-meta.js";
import { prisma } from "./prisma.js";
import { runtime } from "./runtime.js";

export const CATALOG_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 10 * 60 * 1000;

type Entry = Record<string, unknown> & { provider: string; models: string[]; meta?: Record<string, ModelMeta>; error?: string | null; fetchedAt?: string | null };
type Credential = { provider: string; source: string; hint?: string | null };

/** A key was saved or removed: its provider's list is fetched again next time. */
export async function forgetCatalog(userId: string, provider: string): Promise<void> {
  const owner = keysFor(userId);
  forgetMeta(owner, provider);
  await prisma.modelCatalog.deleteMany({ where: { userId: owner, provider } });
}

/** Whether a stored list should be fetched again. */
export function catalogStale(row: { fetchedAt: Date; keyHint: string; entry: unknown } | undefined, keyHint: string, now = Date.now()): boolean {
  if (!row) return true;
  if (row.keyHint !== keyHint) return true;
  const age = now - row.fetchedAt.getTime();
  const failed = Boolean((row.entry as { error?: unknown } | null)?.error);
  return age > (failed ? ERROR_RETRY_MS : CATALOG_WEEK_MS);
}

/**
 * Each provider's models for this person's keys: stored lists, with stale ones fetched again.
 * `refresh: true` fetches every provider that has a key; a list of names fetches those.
 */
export async function modelCatalog(userId: string, ollamaUrl: string, options: { refresh?: boolean | string[] } = {}) {
  const owner = keysFor(userId);
  const listed = await runtime<{ credentials: Credential[] }>(`/api/credentials?${new URLSearchParams({ userId })}`);
  const keyed = new Map(listed.credentials.filter((row) => row.source !== "none").map((row) => [row.provider, row]));
  const rows = await prisma.modelCatalog.findMany({ where: { userId: owner } });
  const stored = new Map(rows.map((row) => [row.provider, row]));
  const forced = options.refresh === true ? new Set(keyed.keys()) : new Set(Array.isArray(options.refresh) ? options.refresh : []);
  const now = Date.now();
  const due = [...keyed.keys()].filter((provider) => forced.has(provider) || catalogStale(stored.get(provider), keyed.get(provider)?.hint ?? "", now));
  const keyless = listed.credentials.filter((row) => row.source === "none").map((row) => row.provider);
  // Asking for providers without a key costs no network call; the runtime answers "no key" for them.
  const asked = [...due, ...keyless];
  const fresh = asked.length
    ? (await runtime<{ providers: Entry[] }>(`/api/models?${new URLSearchParams({ userId, ollamaUrl, providers: asked.join(",") })}`, { timeoutMs: 30_000 })).providers
    : [];
  const fetchedAt = new Date();
  for (const entry of fresh) {
    if (!keyed.has(entry.provider)) continue;
    const data = { entry: entry as unknown as Prisma.InputJsonValue, keyHint: keyed.get(entry.provider)?.hint ?? "", fetchedAt };
    await prisma.modelCatalog.upsert({ where: { userId_provider: { userId: owner, provider: entry.provider } }, create: { userId: owner, provider: entry.provider, ...data }, update: data });
    rememberMeta(owner, entry.provider, entry.meta);
  }
  const gone = rows.filter((row) => !keyed.has(row.provider)).map((row) => row.provider);
  if (gone.length) await prisma.modelCatalog.deleteMany({ where: { userId: owner, provider: { in: gone } } });

  const byProvider = new Map<string, Entry>();
  // Where the key comes from is read now; a stored list may predate a key added on this computer.
  for (const row of rows) if (keyed.has(row.provider)) byProvider.set(row.provider, { ...(row.entry as Entry), source: keyed.get(row.provider)!.source, fetchedAt: row.fetchedAt.toISOString() });
  for (const entry of fresh) byProvider.set(entry.provider, { ...entry, fetchedAt: keyed.has(entry.provider) ? fetchedAt.toISOString() : null });
  const providers = listed.credentials.map((row) => byProvider.get(row.provider)).filter((entry): entry is Entry => Boolean(entry));
  const dates = providers.map((entry) => entry.fetchedAt).filter((value): value is string => Boolean(value)).sort();
  return { providers, fetchedAt: dates[0] ?? null, refreshedAt: dates[dates.length - 1] ?? null };
}
