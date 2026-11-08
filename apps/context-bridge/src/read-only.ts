/** Underscores are word characters, so a boundary check would miss `ensemble_delete_task`. */
const WRITE = /(^|_)(create|update|delete|remove|send|post|patch|write|approve|deny|mutate)($|_)/i;

/** The only write-named tools the bridge may register, and only for a key made with changes allowed. */
export const ALLOWED_WRITE_TOOLS: readonly string[] = ["ensemble_create_task", "ensemble_update_task", "ensemble_upload_file"];

/** Startup guard: a write-shaped read tool name refuses to boot. */
export function assertReadOnlyNames(names: readonly string[]): void {
  for (const name of names) {
    if (WRITE.test(name)) {
      throw new Error(`Context Bridge refused to start: "${name}" looks like a write tool. The bridge's read tools are read-only.`);
    }
  }
}

/** Startup guard: a write tool outside the allowlist refuses to boot. */
export function assertAllowedWriteNames(names: readonly string[]): void {
  for (const name of names) {
    if (!ALLOWED_WRITE_TOOLS.includes(name)) {
      throw new Error(`Context Bridge refused to start: "${name}" is not an allowed write tool. Only ${ALLOWED_WRITE_TOOLS.join(", ")} may write.`);
    }
  }
}
