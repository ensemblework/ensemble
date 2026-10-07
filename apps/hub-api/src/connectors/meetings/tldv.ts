/**
 * tl;dv public API v1alpha1 (API key from Settings → Personal settings → API keys; the
 * meeting organiser needs a Pro or Business plan for API access).
 * https://doc.tldv.io/index.html
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "../types.js";
import { actionItemsFromMarkdown, decisionsFromMarkdown } from "./actions.js";
import { ingestMeetings } from "./ingest.js";
import { clock, dateOr, MEETINGS_PER_SYNC, pace, probe, refused, vendorFetch, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const TLDV_API = "https://pasta.tldv.io/v1alpha1";

type Person = { name?: string | null; email?: string | null };

interface TldvMeeting {
  id: string;
  name?: string | null;
  happenedAt?: string | null;
  url?: string | null;
  duration?: number | null;
  organizer?: Person | null;
  invitees?: Person[] | null;
}

type Segment = { speaker?: string | null; text?: string | null; startTime?: number | null };
interface TldvTranscript {
  data?: Segment[] | { segments?: Segment[] } | null;
}
interface TldvNotes {
  markdownContent?: string | null;
  topics?: Array<{ title?: string | null; summary?: string | null }> | null;
}

export function tldvRecord(meeting: TldvMeeting, transcript: TldvTranscript | null, notes: TldvNotes | null): MeetingRecord | null {
  const start = dateOr(meeting.happenedAt ?? null);
  if (!meeting.id || !start) return null;
  const segments = Array.isArray(transcript?.data) ? transcript!.data : (transcript?.data?.segments ?? []);
  const markdown = notes?.markdownContent?.trim() ?? "";
  const topics = (notes?.topics ?? []).map((topic) => [topic.title, topic.summary].filter(Boolean).join(": ")).filter(Boolean);
  return {
    id: meeting.id,
    title: meeting.name?.trim() || "tl;dv meeting",
    start,
    end: meeting.duration && meeting.duration > 0 ? new Date(start.getTime() + meeting.duration * 1000) : null,
    url: meeting.url ?? null,
    organizer: meeting.organizer?.email ?? null,
    attendees: [...(meeting.organizer ? [meeting.organizer] : []), ...(meeting.invitees ?? [])].map((person) => ({ name: person.name ?? null, email: person.email ?? null })),
    transcript: segments
      .filter((line) => line.text?.trim())
      .map((line) => ({ speaker: line.speaker?.trim() || "Speaker", text: line.text!.trim(), at: clock(line.startTime ?? null) })),
    summary: markdown || topics.map((line) => `- ${line}`).join("\n"),
    decisions: decisionsFromMarkdown(markdown),
    actionItems: actionItemsFromMarkdown(markdown),
    extra: { durationSeconds: meeting.duration ?? null },
  };
}

async function optional<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  const response = await vendorFetch("tl;dv", url, { headers });
  if (response.status === 404) return null;
  return readJson<T>(response, "tl;dv");
}

export async function syncTldv(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "tldv");
  if (!account) throw new ConnectorError("tl;dv is not connected. Paste a tl;dv API key in Settings → Connections.", true);
  const headers = { "x-api-key": account.accessToken, Accept: "application/json" };
  const meetings: TldvMeeting[] = [];
  for (let page = 1; meetings.length < MEETINGS_PER_SYNC && page <= 3; page += 1) {
    const params = new URLSearchParams({ from: ctx.since.toISOString(), limit: String(MEETINGS_PER_SYNC), page: String(page) });
    const body: { results?: TldvMeeting[]; pages?: number } = await vendorJson("tl;dv", `${TLDV_API}/meetings?${params}`, { headers });
    meetings.push(...(body.results ?? []));
    if (!body.pages || page >= body.pages) break;
  }
  const records: MeetingRecord[] = [];
  for (const meeting of meetings.slice(0, MEETINGS_PER_SYNC)) {
    if (records.length) await pace();
    const id = encodeURIComponent(meeting.id);
    const transcript = await optional<TldvTranscript>(`${TLDV_API}/meetings/${id}/transcript`, headers);
    const notes = await optional<TldvNotes>(`${TLDV_API}/meetings/${id}/notes`, headers);
    const record = tldvRecord(meeting, transcript, notes);
    if (record) records.push(record);
  }
  return ingestMeetings(ctx, "tldv", records, account.account);
}

export async function checkTldv(token: string): Promise<TokenCheck> {
  const res = await probe("tl;dv", `${TLDV_API}/meetings?limit=1`, { headers: { "x-api-key": token, Accept: "application/json" } });
  if (!res.ok) refused("tl;dv", (res.body as { message?: string } | null)?.message ?? res.status);
  const organizer = (res.body as { results?: Array<{ organizer?: Person }> } | null)?.results?.[0]?.organizer;
  return { account: organizer?.email ?? "tl;dv", meta: { via: "token" } };
}
