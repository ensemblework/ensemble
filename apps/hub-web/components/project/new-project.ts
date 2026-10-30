/** The name hub-api gives a project created without one; pages show it as a placeholder. */
export const UNTITLED_PROJECT = "Untitled project";

/**
 * A project created a moment ago opens with its name field focused, like a new page.
 * Reading does not consume the mark: a navigation renders as a transition React may restart.
 */
const fresh = new Map<string, number>();
export function markNewProject(id: string) { fresh.set(id, Date.now()); }
export function isNewProject(id: string): boolean { const at = fresh.get(id); return at !== undefined && Date.now() - at < 10_000; }
