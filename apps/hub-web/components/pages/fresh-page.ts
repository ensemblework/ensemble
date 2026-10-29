/** A page created a moment ago opens in the peek with its title focused, like New page in the sidebar. */
const fresh = new Set<string>();
export function markFreshPage(id: string) { fresh.add(id); }
export function takeFreshPage(id: string): boolean { return fresh.delete(id); }
