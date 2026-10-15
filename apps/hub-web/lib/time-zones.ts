import { timeZoneName } from "@ensemble/shared-types";

/** The browser's own name for a zone, so two spellings of one place ("Asia/Kolkata", "Asia/Calcutta") compare equal. */
export function sameTimeZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}

function canonical(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/** Every IANA time zone this browser knows, plus UTC and this computer's, once each and sorted. The saved spelling of a zone wins. */
export function timeZoneOptions(saved?: string | null): string[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = new Map<string, string>();
  for (const zone of [...listed, "UTC", Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    const key = canonical(zone);
    if (!zones.has(key)) zones.set(key, zone);
  }
  const named = saved ? timeZoneName(saved) : null;
  if (named) zones.set(canonical(named), named);
  return [...zones.values()].sort((a, b) => a.localeCompare(b));
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
