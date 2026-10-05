/**
 * ENSEMBLE_PLOT_CONCURRENCY, shared by the desktop worker and hub-api config.
 * The agent runtime parses the same variable the same way: a blank or
 * non-numeric value is the default, and the rest is clamped.
 */
const INTEGER = /^[+-]?\d+$/;

export function parsePlotConcurrency(raw: string | undefined | null): number {
  const text = (raw ?? "").trim();
  if (!INTEGER.test(text)) return 2;
  const value = Number(text);
  if (value < 1) return 1;
  if (value > 32) return 32;
  return value;
}
