/** Underscores are word characters, so a boundary check would miss `ensemble_delete_task`. */
const WRITE = /(^|_)(create|update|delete|remove|send|post|patch|write|approve|deny|mutate)($|_)/i;

/** Startup guard: a write-shaped tool name refuses to boot. */
export function assertReadOnlyNames(names: readonly string[]): void {
  for (const name of names) {
    if (WRITE.test(name)) {
      throw new Error(`Context Bridge refused to start: "${name}" looks like a write tool. The bridge is read-only.`);
    }
  }
}
