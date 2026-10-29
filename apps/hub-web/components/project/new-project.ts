/** The name hub-api gives a project created without one; pages show it as a placeholder. */
export const UNTITLED_PROJECT = "Untitled project";

/** A project created a moment ago opens with its name field focused, like a new page. */
const fresh = new Set<string>();
export function markNewProject(id: string) { fresh.add(id); }
export function takeNewProject(id: string): boolean { return fresh.delete(id); }
