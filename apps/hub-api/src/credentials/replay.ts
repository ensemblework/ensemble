/**
 * Each encrypted value is taken once (B12, docs/35 §8.7). This computer remembers, in Ensemble's data
 * folder, every box it opened (its nonce) and every request it saved a value for (its decision id),
 * until a while after the box would have expired anyway. A box seen before is refused, and so is a new
 * box for a request already answered: the relay cannot replay one, or answer a request twice.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../remote/store.js";
import { SealError } from "./seal.js";

/** Kept this long after a box's expiry, then forgotten (the expiry refuses it by then). */
const KEEP_AFTER_EXPIRY_MS = 24 * 3600_000;
const MAX_ENTRIES = 5000;

type Seen = { decisions: Record<string, number>; nonces: Record<string, number> };

const seenPath = () => join(stateDir(), "seal-seen.json");

function load(): Seen {
  const path = seenPath();
  if (!existsSync(path)) return { decisions: {}, nonces: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Seen>;
    return { decisions: value.decisions ?? {}, nonces: value.nonces ?? {} };
  } catch {
    return { decisions: {}, nonces: {} };
  }
}

function prune(map: Record<string, number>, now: number): Record<string, number> {
  const kept = Object.entries(map).filter(([, until]) => until > now);
  return Object.fromEntries(kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES));
}

function persist(seen: Seen): void {
  const path = seenPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(seen)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

let queue: Promise<unknown> = Promise.resolve();

/** One at a time, so two copies of a box arriving together cannot both pass. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Runs `work` for a box once: refused when its nonce was seen, or its request was already answered
 * here. The nonce is remembered before `work` runs (so even a failed save cannot be replayed); the
 * request only when `work` succeeds, so the owner can type the value again after a failure.
 */
export function takeOnce<T>(box: { decisionId: string; nonce: string; expiresAt: string }, work: () => Promise<T>, now = Date.now()): Promise<T> {
  return serial(async () => {
    const until = (Number.isFinite(Date.parse(box.expiresAt)) ? Date.parse(box.expiresAt) : now) + KEEP_AFTER_EXPIRY_MS;
    const seen = load();
    seen.decisions = prune(seen.decisions, now);
    seen.nonces = prune(seen.nonces, now);
    if (seen.decisions[box.decisionId]) throw new SealError("replay", "This request was already answered on this computer.");
    if (seen.nonces[box.nonce]) throw new SealError("replay", "That encrypted value was already used. Type it again.");
    seen.nonces[box.nonce] = until;
    persist(seen);
    const result = await work();
    const after = load();
    after.decisions[box.decisionId] = until;
    after.nonces[box.nonce] = until;
    persist(after);
    return result;
  });
}

/**
 * Takes a box for work that runs long (a command as the administrator), refused like `takeOnce`, but
 * without holding up other boxes while it runs: its nonce and its request are remembered at once.
 * `release` forgets the request again (never the nonce) when the work could not use the box (a
 * password that was not accepted), so the owner can answer the same request with a new box.
 */
export function claimOnce(box: { decisionId: string; nonce: string; expiresAt: string }, now = Date.now()): Promise<{ release: () => Promise<void> }> {
  return serial(async () => {
    const until = (Number.isFinite(Date.parse(box.expiresAt)) ? Date.parse(box.expiresAt) : now) + KEEP_AFTER_EXPIRY_MS;
    const seen = load();
    seen.decisions = prune(seen.decisions, now);
    seen.nonces = prune(seen.nonces, now);
    if (seen.decisions[box.decisionId]) throw new SealError("replay", "This request was already answered on this computer.");
    if (seen.nonces[box.nonce]) throw new SealError("replay", "That encrypted value was already used. Type it again.");
    seen.nonces[box.nonce] = until;
    seen.decisions[box.decisionId] = until;
    persist(seen);
    return {
      release: () =>
        serial(async () => {
          const after = load();
          delete after.decisions[box.decisionId];
          persist(after);
        }),
    };
  });
}
