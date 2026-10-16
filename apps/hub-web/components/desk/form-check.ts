import { dueDateProblem } from "@/lib/due-date";

export type DeskField = {
  key: string;
  label: string;
  input?: "text" | "date" | "number" | "select";
  options?: Array<[string, string]>;
  optional?: boolean;
  placeholder?: string;
};

/** Class start and end times. Typed as text, sent to the API as HH:MM. */
const TIME_KEYS = new Set(["start", "end"]);

/** "9:05", "09:05" or "0905" as minutes past midnight; null for anything else ("25:99"). */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * What is wrong with a desk entry before it is sent, field by field, and the values to send
 * (times normalised to HH:MM). An empty `errors` means it can be saved.
 */
export function checkDeskFields(fields: DeskField[], raw: Record<string, string>): { errors: Record<string, string>; values: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values = { ...raw };
  const times: Record<string, number> = {};
  for (const field of fields) {
    const value = (raw[field.key] ?? "").trim();
    if (!value) {
      if (!field.optional) errors[field.key] = field.input === "select" ? `Choose a ${field.label.toLowerCase()}.` : `${field.label} is required.`;
      continue;
    }
    if (TIME_KEYS.has(field.key)) {
      const minutes = parseClock(value);
      if (minutes === null) errors[field.key] = "Use a time like 09:00.";
      else {
        times[field.key] = minutes;
        values[field.key] = clock(minutes);
      }
    } else if (field.input === "date") {
      const problem = dueDateProblem(value);
      if (problem) errors[field.key] = problem;
    } else if (field.input === "number" && !Number.isFinite(Number(value))) {
      errors[field.key] = "Enter a number.";
    }
  }
  if (times.start !== undefined && times.end !== undefined && times.end <= times.start) {
    errors.end = "End has to be after Start.";
  }
  return { errors, values };
}
