/**
 * Fathom (REST, personal API key from Settings → API Access; the free plan has one).
 * https://developers.fathom.ai/api-reference/meetings/list-meetings
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, type SyncContext, type SyncResult } from "../types.js";
import { ingestMeetings } from "./ingest.js";
import { dateOr, MEETINGS_PER_SYNC, probe, refused, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const FATHOM_API = "https://api.fathom.ai/external/v1";

type Person = { name?: string | null; email?: string | null };

interface FathomMeeting {
  title?: string | null;
  meeting_title?: string | null;
  recording_id: number | string;
  url?: string | null;
  share_url?: string | null;
  meeting_url?: string | null;
  created_at?: string | null;
  scheduled_start_time?: string | null;
  scheduled_end_time?: string | null;
  recording_start_time?: string | null;
  recording_end_time?: string | null;
  calendar_invitees?: Array<Person & { is_external?: boolean; matched_speaker_display_name?: string | null }> | null;
  recorded_by?: Person | null;
  transcript?: Array<{ speaker?: { display_name?: string | null; matched_calendar_invitee_email?: string | null } | null; text?: string | null; timestamp?: string | null }> | null;
  default_summary?: { markdown_formatted?: string | null } | null;
  action_items?: Array<{ description?: string | null; completed?: boolean | null; recording_timestamp?: string | null; recording_playback_url?: string | null; assignee?: Person | null }> | null;
}

export function fathomRecord(row: FathomMeeting): MeetingRecord | null {
  const start = dateOr(row.recording_start_time ?? row.scheduled_start_time ?? row.created_at ?? null);
  if (row.recording_id == null || !start) return null;
  const end = dateOr(row.recording_end_time ?? row.scheduled_end_time ?? null);
  const speakers = new Map<string, { name: string | null; email: string | null }>();
  for (const line of row.transcript ?? []) {
    const name = line.speaker?.display_name?.trim() || null;
    const email = line.speaker?.matched_calendar_invitee_email?.trim().toLowerCase() || null;
    const key = email ?? name?.toLowerCase();
    if (key && !speakers.has(key)) speakers.set(key, { name, email });
  }
  return {
    id: String(row.recording_id),
    title: row.meeting_title?.trim() || row.title?.trim() || "Fathom meeting",
    start,
    end,
    url: row.share_url ?? row.url ?? null,
    organizer: row.recorded_by?.email ?? null,
    attendees: (row.calendar_invitees ?? []).map((person) => ({ name: person.name ?? null, email: person.email ?? null })),
    speakers: [...speakers.values()],
    transcript: (row.transcript ?? [])
      .filter((line) => line.text?.trim())
      .map((line) => ({ speaker: line.speaker?.display_name?.trim() || "Speaker", text: line.text!.trim(), at: line.timestamp ?? null })),
    summary: row.default_summary?.markdown_formatted?.trim() ?? "",
    actionItems: (row.action_items ?? [])
      .filter((item) => item.description?.trim())
      .map((item) => ({
        text: item.description!.trim(),
        assignee: item.assignee ? { name: item.assignee.name ?? null, email: item.assignee.email ?? null } : null,
        completed: Boolean(item.completed),
        at: item.recording_timestamp ?? null,
        url: item.recording_playback_url ?? null,
      })),
    extra: { recordingId: row.recording_id, meetingUrl: row.meeting_url ?? null, recordedBy: row.recorded_by?.email ?? null },
  };
}

export async function syncFathom(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "fathom");
  if (!account) throw new ConnectorError("Fathom is not connected. Paste a Fathom API key in Settings → Connections.", true);
  const rows: FathomMeeting[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      created_after: ctx.since.toISOString(),
      include_transcript: "true",
      include_summary: "true",
      include_action_items: "true",
      ...(cursor ? { cursor } : {}),
    });
    const page: { items?: FathomMeeting[]; next_cursor?: string | null } = await vendorJson("Fathom", `${FATHOM_API}/meetings?${params}`, {
      headers: { "X-Api-Key": account.accessToken, Accept: "application/json" },
    });
    rows.push(...(page.items ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor && rows.length < MEETINGS_PER_SYNC);
  const records = rows.slice(0, MEETINGS_PER_SYNC).map(fathomRecord).filter((row): row is MeetingRecord => row !== null);
  return ingestMeetings(ctx, "fathom", records, account.account);
}

export async function checkFathom(token: string): Promise<TokenCheck> {
  const res = await probe("Fathom", `${FATHOM_API}/meetings?${new URLSearchParams({ created_after: new Date().toISOString() })}`, {
    headers: { "X-Api-Key": token, Accept: "application/json" },
  });
  if (!res.ok) refused("Fathom", res.status);
  return { account: "Fathom", meta: { via: "token" } };
}
