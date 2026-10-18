"use client";

import type { DeskId } from "@/components/desk/desks";
import type { Role } from "@/components/onboarding/roles";

/**
 * Optional Today tiles. `profiles`: whose Settings → Features lists the switch. Deadlines and
 * Learning are for students and teachers; On the bench is listed for no profile (a person whose
 * bench it is adds the tile from the tile gallery, which switches it on).
 */
export const DESK_EXTRAS = [
  { id: "deadlines", tile: "deadlines", label: "Deadlines", line: "Dated deadlines, as a timeline.", profiles: ["student", "teacher"] },
  { id: "learning", tile: "concepts", label: "Learning", line: "A Today tile for what you yourself are learning.", profiles: ["student", "teacher"] },
  { id: "bench", tile: "hold", label: "On the bench", line: "What is clamped right now, and the next check.", profiles: [] },
] as const satisfies ReadonlyArray<{ id: string; tile: string; label: string; line: string; profiles: readonly Role[] }>;

export type DeskExtraId = (typeof DESK_EXTRAS)[number]["id"];

const KNOWN = new Set<string>(DESK_EXTRAS.map((row) => row.id));

/** The extras a profile is offered in Settings → Features. */
export function extrasForProfile(profile: Role | null | undefined): Array<(typeof DESK_EXTRAS)[number]> {
  return DESK_EXTRAS.filter((extra) => Boolean(profile) && (extra.profiles as readonly string[]).includes(profile!));
}

export function defaultExtras(deskId: DeskId | null): DeskExtraId[] {
  if (deskId === "exam") return ["deadlines"];
  if (deskId === "classes") return ["learning"];
  return [];
}

/** A missing preference uses the desk default. An array, even empty, is an explicit choice. */
export function resolveExtras(deskId: DeskId | null, value: unknown): Set<DeskExtraId> {
  if (Array.isArray(value)) {
    return new Set(value.filter((item): item is DeskExtraId => typeof item === "string" && KNOWN.has(item)));
  }
  return new Set(defaultExtras(deskId));
}
