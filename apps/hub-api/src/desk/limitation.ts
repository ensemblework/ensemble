/** Limitation Act dates. s.4 carries a closed last day forward to the next open court day. */

export const LIMITATION_RULES = ["30d", "45d", "90d", "120d", "3m", "6m"] as const;
export type LimitationRule = (typeof LIMITATION_RULES)[number];

const LABELS: Record<LimitationRule, string> = {
  "30d": "30 days",
  "45d": "45 days",
  "90d": "90 days",
  "120d": "120 days",
  "3m": "3 months",
  "6m": "6 months",
};

export function isLimitationRule(value: string): value is LimitationRule {
  return (LIMITATION_RULES as readonly string[]).includes(value);
}

export function ruleLabel(rule: LimitationRule): string {
  return LABELS[rule];
}

function iso(day: Date): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIso(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
}

function addPeriod(orderIso: string, rule: LimitationRule): Date {
  const date = parseIso(orderIso);
  if (rule === "3m" || rule === "6m") {
    const day = date.getUTCDate();
    date.setUTCMonth(date.getUTCMonth() + (rule === "3m" ? 3 : 6));
    if (date.getUTCDate() < day) date.setUTCDate(0);
    return date;
  }
  const days = rule === "30d" ? 30 : rule === "45d" ? 45 : rule === "90d" ? 90 : 120;
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso).getTime();
  const b = parseIso(toIso).getTime();
  return Math.round((b - a) / 86_400_000);
}

export type LimitationHit = {
  due: string;
  raw: string;
  shifted: boolean;
  days: number;
  note: string | null;
};

/** Weekends are closed. Named holidays are closed too. s.4 walks forward. */
export function limitationDue(
  orderIso: string,
  rule: LimitationRule,
  holidays: Array<{ day: string; name: string }>,
  todayIso: string,
): LimitationHit {
  const named = new Map(holidays.map((row) => [row.day, row.name]));
  const rawDate = addPeriod(orderIso, rule);
  const raw = iso(rawDate);
  let cursor = new Date(rawDate.getTime());
  let guard = 0;
  while (guard < 21) {
    const key = iso(cursor);
    const weekday = cursor.getUTCDay();
    const holiday = named.get(key);
    if (weekday !== 0 && weekday !== 6 && !holiday) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  const due = iso(cursor);
  const shifted = due !== raw;
  const blocker = named.get(raw);
  const why = blocker ? blocker : "the court is closed";
  const note = shifted ? `${LABELS[rule]} from the order. The last day is ${why}, so s.4 carries it to the next open day.` : null;
  return { due, raw, shifted, days: daysBetween(todayIso, due), note };
}
