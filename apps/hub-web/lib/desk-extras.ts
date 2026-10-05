"use client";

import type { DeskId } from "@/components/desk/desks";

export const DESK_EXTRAS = [
  { id: "deadlines", label: "Deadlines", line: "Dated deadlines, as a timeline. On for Exam season until you turn it off." },
  { id: "learning", label: "Learning", line: "A tab for what you yourself are learning. On for Classes until you turn it off." },
  { id: "bench", label: "On the bench", line: "What is clamped right now, and the next check. On for Bench until you turn it off." },
] as const;

export type DeskExtraId = (typeof DESK_EXTRAS)[number]["id"];

const KNOWN = new Set<string>(DESK_EXTRAS.map((row) => row.id));

export function defaultExtras(deskId: DeskId | null): DeskExtraId[] {
  if (deskId === "exam") return ["deadlines"];
  if (deskId === "classes") return ["learning"];
  if (deskId === "bench") return ["bench"];
  return [];
}

/** A missing preference uses the desk default. An array, even empty, is an explicit choice. */
export function resolveExtras(deskId: DeskId | null, value: unknown): Set<DeskExtraId> {
  if (Array.isArray(value)) {
    return new Set(value.filter((item): item is DeskExtraId => typeof item === "string" && KNOWN.has(item)));
  }
  return new Set(defaultExtras(deskId));
}
