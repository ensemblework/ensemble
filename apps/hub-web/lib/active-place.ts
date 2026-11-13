export const PLACE_HEADER = "x-ensemble-place";
export const PLACE_ACCOUNT_HEADER = "x-ensemble-place-account";
export const PLACE_BLOCKED_EVENT = "ensemble:place-blocked";
const KEY = "ensemble.active-place";
let current: { id: string; seq: number; accountId?: string } | null = null;

export function placeHeaders(): Record<string, string> {
  return current ? { [PLACE_HEADER]: current.id, ...(current.accountId ? { [PLACE_ACCOUNT_HEADER]: current.accountId } : {}) } : {};
}

export function nextPlaceInput(surface: "hub" | "desktop") {
  if (!current) throw new Error("This window has not joined Ensemble.");
  current.seq += 1;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // The in-memory id still distinguishes this tab when storage is unavailable.
  }
  return { ...current, surface };
}

/** Web Locks distinguish duplicated tabs, whose sessionStorage starts as a copy. */
export async function acquirePlace(accountId?: string): Promise<() => void> {
  let saved: { id?: unknown; seq?: unknown } = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) ?? "{}"); } catch { /* Storage is optional. */ }
  const id = typeof saved?.id === "string" && /^[a-f0-9-]{36}$/.test(saved.id) ? saved.id : crypto.randomUUID();
  const seq = typeof saved?.seq === "number" && Number.isSafeInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0;
  if (!navigator.locks) {
    current = { id: crypto.randomUUID(), seq: 0, accountId };
    return () => { current = null; };
  }
  return new Promise((resolve, reject) => {
    const lock = (wanted: string, serial: number) => {
      void navigator.locks.request(`ensemble.place:${wanted}`, { ifAvailable: true }, async (held) => {
        if (!held) { lock(crypto.randomUUID(), 0); return; }
        current = { id: wanted, seq: serial, accountId };
        await new Promise<void>((release) => {
          resolve(() => { current = null; release(); });
        });
      }).catch(reject);
    };
    lock(id, seq);
  });
}

export type OpenPlace = { windowId: string; surface: "hub" | "node" | "desktop"; label: string; lastSeen: string };
export type PlaceAnswer = { allowed: boolean; code?: string; places: OpenPlace[] };
