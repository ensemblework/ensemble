/**
 * Meeting-notes connectors (docs/03 §2.3). Each vendor file reads its API and
 * maps a meeting into a MeetingRecord; ingest.ts does the rest the same way
 * for every vendor: transcript artifact, MeetingNote, calendar match, people,
 * and action items.
 */
import { ConnectorError, readJson } from "../types.js";

export const MEETING_VENDORS = ["fireflies", "fathom", "granola", "tldv", "krisp", "jamie", "otter"] as const;
export type MeetingVendor = (typeof MEETING_VENDORS)[number];

export const VENDOR_LABEL: Record<MeetingVendor, string> = {
  fireflies: "Fireflies.ai",
  fathom: "Fathom",
  granola: "Granola",
  tldv: "tl;dv",
  krisp: "Krisp",
  jamie: "Jamie",
  otter: "Otter.ai",
};

export const isMeetingVendor = (value: string): value is MeetingVendor => (MEETING_VENDORS as readonly string[]).includes(value);

export interface MeetingPerson {
  name?: string | null;
  email?: string | null;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
  /** Offset from the start, "mm:ss" or "hh:mm:ss". */
  at?: string | null;
}

export interface ActionItemInput {
  text: string;
  assignee?: MeetingPerson | null;
  due?: string | null;
  completed?: boolean;
  /** A link to that moment of the recording, when the vendor has one. */
  url?: string | null;
  at?: string | null;
}

export interface MeetingRecord {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  url: string | null;
  /** The calendar provider's event id, when the vendor knows it (Google event id, Graph id). */
  calendarEventId?: string | null;
  organizer?: string | null;
  attendees: MeetingPerson[];
  speakers?: MeetingPerson[];
  transcript?: TranscriptLine[];
  summary: string;
  decisions?: string[];
  actionItems: ActionItemInput[];
  /** Vendor extras kept on the transcript artifact's metadata (ids, duration, keywords). */
  extra?: Record<string, unknown>;
}

/** How many meetings one Sync now reads per vendor. */
export const MEETINGS_PER_SYNC = 20;

const TIMEOUT_MS = 30_000;

/** Pause between per-meeting detail calls; vendor burst limits are 25 requests per 5 seconds. */
export function pace(): Promise<void> {
  const ms = Number(process.env.ENSEMBLE_MEETING_PACE_MS ?? 220);
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function vendorFetch(label: string, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new ConnectorError(`Could not reach ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function vendorJson<T>(label: string, url: string, init: RequestInit = {}): Promise<T> {
  return readJson<T>(await vendorFetch(label, url, init), label);
}

/** Seconds → "mm:ss", or "h:mm:ss" past an hour. */
export function clock(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function dateOr(value: string | number | null | undefined, fallback: Date | null = null): Date | null {
  if (value == null || value === "") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export const personName = (row: { name?: string | null; first_name?: string | null; last_name?: string | null; displayName?: string | null; display_name?: string | null } | null | undefined): string | null => {
  if (!row) return null;
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return row.name?.trim() || row.displayName?.trim() || row.display_name?.trim() || full || null;
};

export interface TokenCheck {
  account: string;
  meta: Record<string, unknown>;
}

/** A pasted key the vendor refused; token-providers turns it into a 400 for the store. */
export class MeetingTokenError extends Error {}

export async function probe(label: string, url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new MeetingTokenError(`Could not reach ${label} to check that key. Try again.`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

export function refused(label: string, detail: string | number): never {
  throw new MeetingTokenError(`${label} rejected that key (${detail}).`);
}
