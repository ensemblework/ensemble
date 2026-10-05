import type { PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { zonedParts } from "../lib/clock.js";
import { createDeskEntry } from "./entries.js";

export type DeskIntent =
  | { kind: "mock"; score: number; outOf: number; subject: string; day: string }
  | { kind: "hearing"; title: string; day: string; court: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/** Cheap desk lines. Null means this is an ordinary capture. */
export function parseDeskIntent(text: string, today: string): { intent: DeskIntent } | { error: string } | null {
  const line = text.replace(/\s+/g, " ").trim();
  const mock = line.match(/^mock\s+(\d{1,4})\s*\/\s*(\d{1,4})(?:\s+(.+))?$/i);
  if (mock) {
    const score = Number(mock[1]);
    const outOf = Number(mock[2]);
    if (outOf < 1 || score > outOf) return { error: "That score is larger than the paper." };
    const tail = (mock[3] ?? "").trim();
    const subject = /^today$/i.test(tail) ? "" : tail;
    return { intent: { kind: "mock", score, outOf, subject, day: today } };
  }
  const hearing = line.match(/^hearing\s+(.+?)\s+(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(.+))?$/i);
  if (hearing) {
    const title = hearing[1]!.trim();
    const month = monthIndex(hearing[3]!);
    if (!title || month < 0) return null;
    const year = Number(today.slice(0, 4));
    const day = iso(year, month, Number(hearing[2]));
    if (!day) return { error: "That hearing date is not a real day." };
    return { intent: { kind: "hearing", title, day, court: (hearing[4] ?? "").trim() } };
  }
  return null;
}

export async function captureDeskIntent(db: PrismaClient, userId: string, text: string) {
  const settings = await loadSettings(db, userId);
  const today = zonedParts(settings.timezone).date;
  const parsed = parseDeskIntent(text, today);
  if (!parsed) return null;
  if ("error" in parsed) throw Object.assign(new Error(parsed.error), { statusCode: 400 });
  const intent = parsed.intent;
  const fields =
    intent.kind === "mock"
      ? { score: intent.score, outOf: intent.outOf, subject: intent.subject, day: intent.day }
      : { title: intent.title, day: intent.day, court: intent.court };
  const saved = await createDeskEntry(db, userId, intent.kind, fields);
  const dueLabel = intent.kind === "hearing" ? intent.day : intent.day;
  return {
    answer: intent.kind === "mock" ? `Logged mock ${intent.score}/${intent.outOf}.` : `Listed ${intent.title} on ${intent.day}.`,
    task: { id: saved.id, title: saved.title },
    undoEntryId: saved.undoEntryId,
    parsed: { title: saved.title, dueLabel, matched: [] as Array<{ id: string; name: string }>, unmatched: [] as string[] },
  };
}
