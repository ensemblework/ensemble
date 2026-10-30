/**
 * A page created a moment ago opens in the peek with its title focused, like New page in the sidebar.
 * Reading does not consume the mark: a navigation renders as a transition React may restart.
 */
const fresh = new Map<string, number>();
export function markFreshPage(id: string) { fresh.set(id, Date.now()); }
export function isFreshPage(id: string): boolean { const at = fresh.get(id); return at !== undefined && Date.now() - at < 10_000; }
