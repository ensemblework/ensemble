/**
 * The model keys saved on the person's Ensemble account (Settings → Models on the web), used for
 * this computer's own model calls, so one set of keys works on the web, in the desktop app and in
 * the CLI. Read with the device token from `/api/devices/self/model-keys` while this computer is
 * paired, held in memory only (never written to this computer's database), and read again after
 * ten minutes. A key saved on this computer wins for its provider. Off the network, the last keys
 * read stay in use; a removed computer (401) has none.
 */
import { createHash } from "node:crypto";
import { authRejected, fetchAccountKeys, type AccountKey } from "./client.js";
import { loadSettings, readDeviceToken } from "./store.js";

const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;

type Held = { pairing: string; at: number; ttl: number; keys: Map<string, AccountKey> };
let held: Held | null = null;
let pending: Promise<Map<string, AccountKey>> | null = null;
let source: (() => Promise<{ pairing: string; read: () => Promise<{ keys: AccountKey[] }> } | null>) | null = null;

/** Tests: where the keys come from. `null` restores the paired account. */
export function setAccountKeySourceForTests(fn: typeof source): void {
  source = fn;
  held = null;
}

async function pairedAccount(): Promise<{ pairing: string; read: () => Promise<{ keys: AccountKey[] }> } | null> {
  if (source) return source();
  if (process.env.ENSEMBLE_DESKTOP !== "1") return null;
  const base = loadSettings().apiBase;
  const token = await readDeviceToken();
  if (!base || !token) return null;
  return { pairing: createHash("sha256").update(`${base}\u0000${token}`).digest("hex"), read: () => fetchAccountKeys(base, token) };
}

/** The account's keys by provider; empty when this computer is not paired or the account shares none. */
export async function accountKeys(): Promise<Map<string, AccountKey>> {
  const account = await pairedAccount();
  if (!account) return new Map();
  if (held && held.pairing === account.pairing && Date.now() - held.at < held.ttl) return held.keys;
  pending ??= (async () => {
    try {
      const body = await account.read();
      held = { pairing: account.pairing, at: Date.now(), ttl: FRESH_MS, keys: new Map(body.keys.map((key) => [key.provider, key])) };
    } catch (error) {
      const last = held?.pairing === account.pairing && !authRejected(error) ? held.keys : new Map<string, AccountKey>();
      held = { pairing: account.pairing, at: Date.now(), ttl: RETRY_MS, keys: last };
    }
    return held.keys;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** A key was saved or removed on the account, or the person asked to refresh: read them again next time. */
export function forgetAccountKeys(): void {
  held = null;
}
