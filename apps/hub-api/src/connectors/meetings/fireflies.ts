/**
 * Fireflies.ai (GraphQL, personal API key from Integrations → Fireflies API).
 * https://docs.fireflies.ai/graphql-api/query/transcripts
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, type SyncContext, type SyncResult } from "../types.js";
import { parseActionItemsText } from "./actions.js";
import { ingestMeetings } from "./ingest.js";
import { clock, dateOr, MEETINGS_PER_SYNC, probe, refused, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const FIREFLIES_URL = "https://api.fireflies.ai/graphql";

interface Transcript {
  id: string;
  title?: string | null;
  date?: number | string | null;
  duration?: number | null;
  transcript_url?: string | null;
  organizer_email?: string | null;
  participants?: string[] | null;
  calendar_id?: string | null;
  meeting_link?: string | null;
  meeting_attendees?: Array<{ displayName?: string | null; email?: string | null; name?: string | null }> | null;
  speakers?: Array<{ id?: string | number | null; name?: string | null }> | null;
  sentences?: Array<{ speaker_name?: string | null; text?: string | null; start_time?: number | null }> | null;
  summary?: { overview?: string | null; short_summary?: string | null; action_items?: string | null; keywords?: string[] | null } | null;
}

const QUERY = `query Transcripts($fromDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
    id title date duration transcript_url organizer_email participants calendar_id meeting_link
    meeting_attendees { displayName email name }
    speakers { id name }
    sentences { speaker_name text start_time }
    summary { overview short_summary action_items keywords }
  }
}`;

const PAGE = 10;

async function graphql<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await vendorJson<{ data?: T; errors?: Array<{ message?: string; code?: string; extensions?: { code?: string } }> }>("Fireflies", FIREFLIES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!body.data) {
    const error = body.errors?.[0];
    const code = error?.code ?? error?.extensions?.code ?? "";
    throw new ConnectorError(`Fireflies: ${error?.message ?? "no data returned"}`, /auth|forbidden|unauthori[sz]ed/i.test(`${code} ${error?.message ?? ""}`));
  }
  return body.data;
}

export function firefliesRecord(row: Transcript): MeetingRecord | null {
  const start = dateOr(row.date ?? null);
  if (!row.id || !start) return null;
  const end = row.duration && row.duration > 0 ? new Date(start.getTime() + row.duration * 60_000) : null;
  const attendees = new Map<string, { name: string | null; email: string | null }>();
  for (const person of row.meeting_attendees ?? []) {
    const email = person.email?.trim().toLowerCase() || null;
    const name = person.displayName?.trim() || person.name?.trim() || null;
    const key = email ?? name?.toLowerCase();
    if (key) attendees.set(key, { name, email });
  }
  for (const email of row.participants ?? []) {
    for (const part of email.split(",")) {
      const value = part.trim().toLowerCase();
      if (value.includes("@") && !attendees.has(value)) attendees.set(value, { name: null, email: value });
    }
  }
  const summary = row.summary?.overview?.trim() || row.summary?.short_summary?.trim() || "";
  return {
    id: row.id,
    title: row.title?.trim() || "Fireflies meeting",
    start,
    end,
    url: row.transcript_url ?? null,
    calendarEventId: row.calendar_id ?? null,
    organizer: row.organizer_email ?? null,
    attendees: [...attendees.values()],
    speakers: (row.speakers ?? []).map((speaker) => ({ name: speaker.name ?? null })).filter((speaker) => speaker.name),
    transcript: (row.sentences ?? [])
      .filter((line) => line.text?.trim())
      .map((line) => ({ speaker: line.speaker_name?.trim() || "Speaker", text: line.text!.trim(), at: clock(line.start_time ?? null) })),
    summary,
    actionItems: parseActionItemsText(row.summary?.action_items),
    extra: { durationMinutes: row.duration ?? null, keywords: (row.summary?.keywords ?? []).slice(0, 20), meetingLink: row.meeting_link ?? null },
  };
}

export async function syncFireflies(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "fireflies");
  if (!account) throw new ConnectorError("Fireflies is not connected. Paste a Fireflies API key in Settings → Connections.", true);
  const rows: Transcript[] = [];
  for (let skip = 0; rows.length < MEETINGS_PER_SYNC; skip += PAGE) {
    const data = await graphql<{ transcripts: Transcript[] | null }>(account.accessToken, QUERY, { fromDate: ctx.since.toISOString(), limit: PAGE, skip });
    const page = data.transcripts ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const records = rows.slice(0, MEETINGS_PER_SYNC).map(firefliesRecord).filter((row): row is MeetingRecord => row !== null);
  return ingestMeetings(ctx, "fireflies", records, account.account);
}

export async function checkFireflies(token: string): Promise<TokenCheck> {
  const res = await probe("Fireflies", FIREFLIES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: "{ user { user_id email name } }" }),
  });
  const body = (res.body ?? {}) as { data?: { user?: { user_id?: string; email?: string; name?: string } | null }; errors?: Array<{ message?: string }> };
  if (!res.ok || !body.data?.user) refused("Fireflies", body.errors?.[0]?.message ?? res.status);
  const user = body.data!.user!;
  return { account: user.email ?? user.name ?? "Fireflies", meta: { via: "token", firefliesUserId: user.user_id ?? null } };
}
