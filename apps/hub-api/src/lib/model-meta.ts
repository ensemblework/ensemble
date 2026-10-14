/**
 * What each provider said about its models (their thinking levels), read from the stored catalog
 * (`model-catalog.ts`), and the check every model call makes with it before anything is sent.
 */
import { checkEffort, type ModelMeta } from "@ensemble/shared-types";
import { knownProvider } from "../runtime/payload.js";
import { keysFor } from "../sharing/context.js";
import { prisma } from "./prisma.js";
import { RuntimeError } from "./runtime-error.js";

const META_TTL_MS = 60_000;
const metaCache = new Map<string, { at: number; meta: Record<string, ModelMeta> }>();
const slot = (owner: string, provider: string) => `${owner}\u0000${provider}`;

export function rememberMeta(owner: string, provider: string, meta: Record<string, ModelMeta> | undefined): void {
  metaCache.set(slot(owner, provider), { at: Date.now(), meta: meta ?? {} });
}

export function forgetMeta(owner: string, provider: string): void {
  metaCache.delete(slot(owner, provider));
}

async function metaFor(owner: string, provider: string): Promise<Record<string, ModelMeta>> {
  const hit = metaCache.get(slot(owner, provider));
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  const row = await prisma.modelCatalog.findUnique({ where: { userId_provider: { userId: owner, provider } } }).catch(() => null);
  const meta = ((row?.entry as { meta?: Record<string, ModelMeta> } | undefined)?.meta ?? {}) as Record<string, ModelMeta>;
  rememberMeta(owner, provider, meta);
  return meta;
}

/**
 * The thinking level to send with a model call: the chosen one, or none when there is none or the
 * model has no thinking setting. A level the model does not take is refused here, with the levels
 * it takes, before anything is sent: the provider never gets a different level than the one chosen.
 */
export async function effortToSend(userId: string, provider: string | null | undefined, model: string, effort: string | null | undefined): Promise<string | undefined> {
  if (!effort || effort === "default" || !model) return undefined;
  const vendor = provider || knownProvider(model);
  // A model whose provider is not known has no thinking table to check; the call itself is refused for that.
  if (!vendor) return effort;
  const meta = (await metaFor(keysFor(userId), vendor))[model] ?? null;
  const verdict = checkEffort(vendor, model, effort, meta);
  if (!verdict.ok) throw new RuntimeError(verdict.message, 400);
  return verdict.send ?? undefined;
}
