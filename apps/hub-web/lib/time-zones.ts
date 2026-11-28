/** The browser's own name for a zone, so two spellings of one place ("Asia/Kolkata", "Asia/Calcutta") compare equal. */
export function sameTimeZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalTimeZone(a) === canonicalTimeZone(b);
}

export function canonicalTimeZone(zone: string): string {
  const aliases: Record<string, string> = { "Asia/Calcutta": "Asia/Kolkata", "Africa/Asmera": "Africa/Asmara", "Europe/Kiev": "Europe/Kyiv", "Etc/UTC": "UTC", "Etc/GMT": "UTC" };
  if (aliases[zone]) return aliases[zone]!;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    return aliases[resolved] ?? resolved;
  } catch {
    return zone;
  }
}

/** "America/New York · GMT-4": the place, readable, and its offset right now. */
export function timeZoneLabel(zone: string, at = new Date()): string {
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    // An unknown zone has no offset to show.
  }
  const place = zone.replace(/_/g, " ");
  return offset ? `${place} · ${offset}` : place;
}
