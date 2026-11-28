/**
 * The calendar day a task, deliverable or matter is due. A date-only due is stored at midnight UTC
 * (hub-api `parseDue`) and keeps its date in every time zone; a due with a time is an instant and falls
 * on its date in `timeZone` (the browser's own zone when left out, which the Hub keeps in step with the
 * account's setting).
 */
export function isDateOnlyDue(due: Date): boolean {
  return due.getUTCHours() === 0 && due.getUTCMinutes() === 0 && due.getUTCSeconds() === 0 && due.getUTCMilliseconds() === 0;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const formats = new Map<string, Intl.DateTimeFormat>();

function dayIn(at: Date, timeZone: string | undefined): string {
  const key = timeZone ?? "";
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formats.set(key, format);
  }
  const parts = format.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** YYYY-MM-DD, or null for no due or one that is not a date. */
export function dueDay(due: Date | string | null | undefined, timeZone?: string): string | null {
  if (!due) return null;
  if (typeof due === "string" && DATE_ONLY.test(due)) return due;
  const date = typeof due === "string" ? new Date(due) : due;
  if (Number.isNaN(date.getTime())) return null;
  return isDateOnlyDue(date) ? date.toISOString().slice(0, 10) : dayIn(date, timeZone);
}
