import { DUE_YEAR_MAX, DUE_YEAR_MESSAGE, DUE_YEAR_MIN } from "@ensemble/shared-types";

/**
 * Why a `YYYY-MM-DD` value from a date field cannot be saved, or null when it can.
 * An empty value clears the date. A date field reports each keystroke of the year
 * (0002, 0020, 0202, 2026), so the in-between years land here and are not saved.
 */
export function dueDateProblem(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "Pick a real date.";
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < DUE_YEAR_MIN || year > DUE_YEAR_MAX) return DUE_YEAR_MESSAGE;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "Pick a real date.";
  return null;
}
