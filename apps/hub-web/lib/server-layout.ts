import { cookies } from "next/headers";
import { HUB_API, type BoardPayload, type MeetingCue } from "@/lib/api";
import { desktopExport } from "@/lib/desktop-export";
import type { LayoutDocument, LayoutSurface } from "@ensemble/shared-types/widgets";

export type LayoutPayload = {
  surface: string;
  document: LayoutDocument;
  templateId: string | null;
  source: string;
  ignored: string[];
};

export type TodayNudges = {
  days: number;
  nudges: Array<{ id: string; title: string; question: string; reasons: string[] }>;
};

export type TodayCues = {
  cues: MeetingCue[];
  voice: string;
};

async function loadJson<T>(session: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(`${HUB_API}${path}`, {
      headers: { cookie: `ensemble_session=${session}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Server render uses the saved layout so the first paint already has the final grid. */
export async function loadContextBoard(): Promise<BoardPayload | null> {
  if (desktopExport()) return null;
  const jar = await cookies();
  const session = jar.get("ensemble_session")?.value;
  if (!session) return null;
  return loadJson<BoardPayload>(session, "/api/context/board");
}

export async function loadLayout(surface: LayoutSurface): Promise<LayoutPayload | null> {
  if (desktopExport()) return null;
  const jar = await cookies();
  const session = jar.get("ensemble_session")?.value;
  if (!session) return null;
  return loadJson<LayoutPayload>(session, `/api/layouts/${surface}`);
}

/**
 * Today decides whether Meetings and Still relevant are on the desk before
 * the first byte. An empty list hides the tile; a non-empty list keeps it.
 * Either way the grid in the HTML is the grid that stays.
 */
/** True when this account still has marketplace sample rows. Signup starters are not samples. */
export async function loadSampleNotice(): Promise<boolean> {
  if (desktopExport()) return false;
  const jar = await cookies();
  const session = jar.get("ensemble_session")?.value;
  if (!session) return false;
  const body = await loadJson<{ present?: boolean }>(session, "/api/marketplace/samples");
  return body?.present === true;
}

export async function loadActiveTemplateId(): Promise<string | null> {
  if (desktopExport()) return null;
  const jar = await cookies();
  const session = jar.get("ensemble_session")?.value;
  if (!session) return null;
  const shell = await loadJson<{ activeTemplateId?: string | null }>(session, "/api/shell");
  return shell?.activeTemplateId ?? null;
}

export async function loadTodayDesk(): Promise<{ layout: LayoutPayload | null; nudges: TodayNudges | null; cues: TodayCues | null }> {
  if (desktopExport()) return { layout: null, nudges: null, cues: null };
  const jar = await cookies();
  const session = jar.get("ensemble_session")?.value;
  if (!session) return { layout: null, nudges: null, cues: null };
  const layout = await loadJson<LayoutPayload>(session, "/api/layouts/today");
  const types = new Set(layout?.document.placements.map((row) => row.type) ?? []);
  const [nudges, cues] = await Promise.all([
    types.has("stale-nudges") ? loadJson<TodayNudges>(session, "/api/nudges") : Promise.resolve(null),
    types.has("meeting-cues") ? loadJson<TodayCues>(session, "/api/meetings/cues") : Promise.resolve(null),
  ]);
  return { layout, nudges, cues };
}
