/**
 * Granola public API (personal API key from Settings → Connectors → API keys; Business plan or above).
 * https://docs.granola.ai/introduction · Granola's MCP server is a separate store entry path.
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "../types.js";
import { actionItemsFromMarkdown, decisionsFromMarkdown } from "./actions.js";
import { ingestMeetings } from "./ingest.js";
import { clock, dateOr, MEETINGS_PER_SYNC, pace, probe, refused, vendorFetch, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const GRANOLA_API = "https://public-api.granola.ai/v1";

type User = { name?: string | null; email?: string | null };

interface GranolaNote {
  id: string;
  title?: string | null;
  owner?: User | null;
  created_at?: string | null;
  updated_at?: string | null;
  web_url?: string | null;
  calendar_event?: {
    event_title?: string | null;
    invitees?: Array<{ email?: string | null }> | null;
    organiser?: string | null;
    calendar_event_id?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
  } | null;
  attendees?: User[] | null;
  summary_text?: string | null;
  summary_markdown?: string | null;
  transcript?: Array<{
    speaker?: { source?: string | null; attribution?: string | null; diarization_label?: string | null; name?: string | null } | null;
    text?: string | null;
    start_time?: string | null;
  }> | null;
}

export function granolaRecord(note: GranolaNote): MeetingRecord | null {
  const event = note.calendar_event ?? null;
  const start = dateOr(event?.scheduled_start_time ?? note.created_at ?? null);
  if (!note.id || !start) return null;
  const attendees = new Map<string, { name: string | null; email: string | null }>();
  for (const person of note.attendees ?? []) {
    const email = person.email?.trim().toLowerCase() || null;
    if (email) attendees.set(email, { name: person.name ?? null, email });
  }
  for (const invitee of event?.invitees ?? []) {
    const email = invitee.email?.trim().toLowerCase();
    if (email && !attendees.has(email)) attendees.set(email, { name: null, email });
  }
  const lines = note.transcript ?? [];
  const first = lines.map((line) => dateOr(line.start_time ?? null)).find((value): value is Date => value !== null) ?? null;
  const summary = note.summary_markdown?.trim() || note.summary_text?.trim() || "";
  return {
    id: note.id,
    title: note.title?.trim() || event?.event_title?.trim() || "Granola note",
    start,
    end: dateOr(event?.scheduled_end_time ?? null),
    url: note.web_url ?? null,
    calendarEventId: event?.calendar_event_id ?? null,
    organizer: event?.organiser ?? null,
    attendees: [...attendees.values()],
    transcript: lines
      .filter((line) => line.text?.trim())
      .map((line) => {
        const at = dateOr(line.start_time ?? null);
        const speaker =
          line.speaker?.name?.trim() ||
          (line.speaker?.attribution === "me" ? note.owner?.name?.trim() || "Me" : line.speaker?.diarization_label?.trim() || (line.speaker?.attribution === "them" ? "Them" : "Speaker"));
        return { speaker, text: line.text!.trim(), at: at && first ? clock((at.getTime() - first.getTime()) / 1000) : null };
      }),
    summary,
    decisions: decisionsFromMarkdown(summary),
    actionItems: actionItemsFromMarkdown(summary),
    extra: { owner: note.owner?.email ?? null },
  };
}

async function noteWithTranscript(key: string, id: string): Promise<GranolaNote> {
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const response = await vendorFetch("Granola", `${GRANOLA_API}/notes/${encodeURIComponent(id)}?include=transcript`, { headers });
  // Long meetings: the transcript does not fit inline. Keep the summary rather than paging hours of text.
  if (response.status === 413) return vendorJson<GranolaNote>("Granola", `${GRANOLA_API}/notes/${encodeURIComponent(id)}`, { headers });
  return readJson<GranolaNote>(response, "Granola");
}

export async function syncGranola(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "granola");
  if (!account) throw new ConnectorError("Granola is not connected. Paste a Granola API key in Settings → Connections.", true);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ updated_after: ctx.since.toISOString(), page_size: "30", ...(cursor ? { cursor } : {}) });
    const page: { notes?: Array<{ id: string; deleted_at?: string | null }>; hasMore?: boolean; cursor?: string | null } = await vendorJson(
      "Granola",
      `${GRANOLA_API}/notes?${params}`,
      { headers: { Authorization: `Bearer ${account.accessToken}`, Accept: "application/json" } },
    );
    for (const note of page.notes ?? []) if (!note.deleted_at) ids.push(note.id);
    cursor = page.hasMore ? (page.cursor ?? null) : null;
  } while (cursor && ids.length < MEETINGS_PER_SYNC);
  const records: MeetingRecord[] = [];
  for (const id of ids.slice(0, MEETINGS_PER_SYNC)) {
    if (records.length) await pace();
    const record = granolaRecord(await noteWithTranscript(account.accessToken, id));
    if (record) records.push(record);
  }
  return ingestMeetings(ctx, "granola", records, account.account);
}

export async function checkGranola(token: string): Promise<TokenCheck> {
  const res = await probe("Granola", `${GRANOLA_API}/notes?page_size=1`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) refused("Granola", res.status);
  const owner = (res.body as { notes?: Array<{ owner?: User }> } | null)?.notes?.[0]?.owner;
  return { account: owner?.email ?? "Granola", meta: { via: "token" } };
}
