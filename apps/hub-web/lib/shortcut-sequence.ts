import type { ShortcutBinding } from "@ensemble/shared-types";

/** How long the first letter of a sequence (the G of G then B) waits for the second. */
export const SEQUENCE_MS = 1000;

export type SequenceKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean };

/**
 * One keydown against the global letter sequences. `buffer` is what was typed so far;
 * `blocked` is true while the person types in a field or works in a dialog.
 * Returns the new buffer and the binding id to run, if the keys completed one.
 */
export function sequenceStep(
  buffer: string,
  event: SequenceKey,
  blocked: boolean,
  bindings: readonly ShortcutBinding[],
): { buffer: string; hit: string | null } {
  if (blocked) return { buffer: "", hit: null };
  // Shift on its own (for a capital letter) and chords leave a started sequence alone.
  if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return { buffer, hit: null };
  const sequences = bindings.filter((binding) => binding.scope === "global" && binding.sequence?.length).map((binding) => ({ id: binding.id, keys: binding.sequence!.join("") }));
  const key = event.key.toLowerCase();
  for (const typed of buffer ? [(buffer + key).slice(-2), key] : [key]) {
    const hit = sequences.find((sequence) => sequence.keys === typed);
    if (hit) return { buffer: "", hit: hit.id };
    if (sequences.some((sequence) => sequence.keys.startsWith(typed))) return { buffer: typed, hit: null };
  }
  return { buffer: "", hit: null };
}
