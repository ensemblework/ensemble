const SOURCE_READING: Record<string, string> = {
  gmail: "Reading Gmail…",
  google_calendar: "Reading Calendar…",
  github: "Reading GitHub…",
  slack: "Reading Slack…",
  linear: "Reading Linear…",
};

function readingLine(calls: Array<{ name: string; arguments?: string }>): string | null {
  const fetch = calls.find((call) => call.name === "hub_fetch_now");
  if (!fetch) return null;
  let sources: string[] = [];
  try {
    const parsed = JSON.parse(fetch.arguments || "{}") as { sources?: unknown };
    if (Array.isArray(parsed.sources)) sources = parsed.sources.filter((item): item is string => typeof item === "string");
  } catch {
    sources = [];
  }
  if (sources.length === 1) return SOURCE_READING[sources[0]] ?? `Reading ${sources[0]}…`;
  if (sources.length > 1) {
    const labels = sources.map((id) => SOURCE_READING[id]?.replace(/^Reading /, "").replace(/…$/, "") ?? id);
    return `Reading ${labels.join(", ")}…`;
  }
  return "Reading your connected sources…";
}

/** One line the dock shows while tools run. "Working…" is the playful-verb fallback. */
export function statusFor(calls: Array<{ name: string; arguments?: string }>): string {
  const reading = readingLine(calls);
  if (reading) return reading;
  const unique = [...new Set(calls.map((call) => call.name))];
  if (unique.every((name) => name.startsWith("hub_list") || name.startsWith("hub_get") || name.startsWith("hub_read"))) {
    return "Looking through your context…";
  }
  if (unique.some((name) => name.startsWith("hub_create") || name.startsWith("hub_upsert") || name.startsWith("hub_update"))) {
    return "Writing to your Hub…";
  }
  return "Working…";
}
