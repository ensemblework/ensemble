/**
 * Jamie public API (personal key "jk_…" from Settings → Developers → API Keys; Pro, Team or Enterprise plan).
 * https://docs.meetjamie.ai/developers/api/api
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "../types.js";
import { parseSpeakerBlocks } from "./actions.js";
import { ingestMeetings } from "./ingest.js";
import { dateOr, MEETINGS_PER_SYNC, pace, probe, refused, vendorFetch, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const JAMIE_API = "https://beta-api.meetjamie.ai/v1/me";

type Person = { name?: string | null; email?: string | null };

interface JamieMeeting {
  id: string;
  title?: string | null;
  generatedTitle?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  user?: { email?: string | null } | null;
  summary?: { markdown?: string | null; short?: string | null } | null;
  transcript?: string | null;
  participants?: Person[] | null;
  tasks?: Array<{ content?: string | null; completed?: boolean | null; assignee?: Person | null }> | null;
  event?: { externalId?: string | null; title?: string | null; attendees?: Array<Person & { organizer?: boolean }> | null } | null;
}

type Envelope<T> = { result?: { data?: { json?: T } } };

const input = (value: Record<string, unknown>) => encodeURIComponent(JSON.stringify({ json: value }));

export function jamieRecord(row: JamieMeeting): MeetingRecord | null {
  const start = dateOr(row.startTime ?? null);
  if (!row.id || !start) return null;
  const organizer = row.event?.attendees?.find((person) => person.organizer)?.email ?? row.user?.email ?? null;
  return {
    id: row.id,
    title: row.title?.trim() || row.generatedTitle?.trim() || row.event?.title?.trim() || "Jamie meeting",
    start,
    end: dateOr(row.endTime ?? null),
    url: null,
    calendarEventId: row.event?.externalId ?? null,
    organizer,
    attendees: (row.event?.attendees ?? []).map((person) => ({ name: person.name ?? null, email: person.email ?? null })),
    speakers: (row.participants ?? []).map((person) => ({ name: person.name ?? null, email: person.email ?? null })),
    transcript: parseSpeakerBlocks(row.transcript),
    summary: row.summary?.markdown?.trim() || row.summary?.short?.trim() || "",
    actionItems: (row.tasks ?? [])
      .filter((task) => task.content?.trim())
      .map((task) => ({ text: task.content!.trim(), assignee: task.assignee ?? null, completed: Boolean(task.completed) })),
  };
}

export async function syncJamie(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "jamie");
  if (!account) throw new ConnectorError("Jamie is not connected. Paste a personal Jamie API key in Settings → Connections.", true);
  const headers = { "x-api-key": account.accessToken, Accept: "application/json" };
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query = input({ limit: MEETINGS_PER_SYNC, startDate: ctx.since.toISOString(), ...(cursor ? { cursor } : {}) });
    const page: Envelope<{ meetings?: Array<{ id: string }>; nextCursor?: string | null }> = await vendorJson("Jamie", `${JAMIE_API}/meetings.list?input=${query}`, { headers });
    const json = page.result?.data?.json;
    ids.push(...(json?.meetings ?? []).map((row) => row.id));
    cursor = json?.nextCursor ?? null;
  } while (cursor && ids.length < MEETINGS_PER_SYNC);
  const records: MeetingRecord[] = [];
  for (const id of ids.slice(0, MEETINGS_PER_SYNC)) {
    if (records.length) await pace();
    const response = await vendorFetch("Jamie", `${JAMIE_API}/meetings.get?input=${input({ meetingId: id })}`, { headers });
    if (response.status === 404) continue;
    const record = jamieRecord((await readJson<Envelope<JamieMeeting>>(response, "Jamie")).result?.data?.json ?? ({ id } as JamieMeeting));
    if (record) records.push(record);
  }
  return ingestMeetings(ctx, "jamie", records, account.account);
}

export async function checkJamie(token: string): Promise<TokenCheck> {
  const res = await probe("Jamie", `${JAMIE_API}/meetings.list?input=${input({ limit: 1 })}`, { headers: { "x-api-key": token, Accept: "application/json" } });
  if (!res.ok) refused("Jamie", res.status === 403 ? "use a personal key, not a workspace key" : res.status);
  return { account: "Jamie", meta: { via: "token" } };
}
