/** A Date the page can format. Invalid strings (a free-form reminder) must not throw. */
export function safeDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}
