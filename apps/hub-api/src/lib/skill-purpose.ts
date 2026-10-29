/**
 * A personal skill made for one feature (`scope.purpose`, e.g. the morning brief's own skill): it
 * is that feature's, never a general preference for the assistant or an agent's task.
 */
export function purposeOf(scope: unknown): string | null {
  const purpose = scope && typeof scope === "object" ? (scope as { purpose?: unknown }).purpose : null;
  return typeof purpose === "string" && purpose ? purpose : null;
}
