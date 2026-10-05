/**
 * Calendar facts the assistant needs, and a warning when Apply would
 * store a reminder or due date that has already passed.
 */
import { isHmTime, isIsoDate, zonedDateTimeToUtc, zonedParts } from "../lib/clock.js";

export type ScheduleInput = {
  dueDate?: string | null;
  dueTime?: string | null;
  due?: string | null;
  tasks?: Array<{ due?: string | null }>;
};

export function pastScheduleWarning(input: ScheduleInput, timeZone: string, now = new Date()): string | null {
  let notes: string[];
  try {
    notes = pastNotes(input, timeZone, now);
  } catch {
    return null;
  }
  if (!notes.length) return null;
  return `Warning: this is in the past (${notes.join("; ")}).`;
}

export function withPastScheduleWarning(summary: string, input: unknown, timeZone: string, now = new Date()): string {
  if (!input || typeof input !== "object") return summary;
  const warning = pastScheduleWarning(input as ScheduleInput, timeZone, now);
  if (!warning || summary.includes("in the past")) return summary;
  return `${summary}\n${warning}`;
}

function pastNotes(input: ScheduleInput, timeZone: string, now: Date): string[] {
  const notes: string[] = [];
  if (typeof input.dueDate === "string" && isIsoDate(input.dueDate)) {
    const time = typeof input.dueTime === "string" && isHmTime(input.dueTime) ? input.dueTime : "09:00";
    const instant = zonedDateTimeToUtc(input.dueDate, time, timeZone);
    if (instant.getTime() < now.getTime()) {
      notes.push(`reminder ${input.dueDate}${typeof input.dueTime === "string" && input.dueTime ? ` ${input.dueTime}` : ""}`);
    }
  }
  const today = zonedParts(timeZone, now).date;
  for (const due of dueValues(input)) {
    if (isIsoDate(due)) {
      if (due < today) notes.push(`due ${due}`);
      continue;
    }
    const parsed = new Date(due);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime()) notes.push(`due ${due}`);
  }
  return notes;
}

function dueValues(input: ScheduleInput): string[] {
  const values: Array<string | null | undefined> = [input.due];
  for (const task of input.tasks ?? []) values.push(task?.due);
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}
