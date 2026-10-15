import { timeZoneName } from "@ensemble/shared-types";

/** The zone a download writes its times in: the person's (Settings › Account), else this computer's. */
export function exportTimeZone(saved?: string | null): string {
  return (saved ? timeZoneName(saved) : null) ?? timeZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * "2026-10-16T14:05:00+05:30": ISO 8601 in `timeZone`, with its UTC offset, so a spreadsheet and
 * a person read the same moment. Empty for no value; text that is not a time comes back as is.
 */
export function isoInZone(value: string | number | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const wall = Date.UTC(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = Math.round((wall - (date.getTime() - date.getUTCMilliseconds())) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return `${String(year).padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
}
