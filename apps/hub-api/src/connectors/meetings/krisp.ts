/**
 * Krisp Meeting Assistant API (personal key "krsp_u_…" from Integrations → API; Core or Advanced plan).
 * https://meeting-api-docs.krisp.ai/docs/getting-started
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "../types.js";
import type { ActionItemInput } from "./types.js";
import { ingestMeetings } from "./ingest.js";
import { clock, dateOr, MEETINGS_PER_SYNC, pace, personName, probe, refused, vendorFetch, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const KRISP_API = "https://meeting-api.krisp.ai/v1";

type Participant = { email?: string | null; first_name?: string | null; last_name?: string | null; name?: string | null };
type Block = { type?: string; text?: string | null; completed?: boolean | null; assignee?: unknown; due_date?: string | null; children?: Block[] };

interface KrispMeeting {
  id: string;
  title?: string | null;
  started_at?: string | null;
  duration?: number | null;
  source?: string | null;
  participants?: Participant[] | null;
  transcript?: { speakers?: Record<string, Participant> | null; segments?: Array<{ speaker?: number | null; text?: string | null; start?: number | null }> | null } | null;
  notes?: { blocks?: Block[] | null } | null;
}

const MARK = /\s*\{\{\d{1,2}:\d{2}(?::\d{2})?\}\}/g;

function assignee(value: unknown): { name: string | null; email: string | null } | null {
  if (!value || typeof value !== "object") return typeof value === "string" && value.trim() ? { name: value.trim(), email: null } : null;
  const row = value as Participant;
  const email = typeof row.email === "string" ? row.email : null;
  const name = personName(row);
  return name || email ? { name, email } : null;
}

function walk(blocks: readonly Block[] | null | undefined, visit: (block: Block, path: string[]) => void, path: string[] = []): void {
  for (const block of blocks ?? []) {
    visit(block, path);
    walk(block.children, visit, [...path, block.type ?? ""]);
  }
}

export function krispRecord(row: KrispMeeting): MeetingRecord | null {
  const start = dateOr(row.started_at ?? null);
  if (!row.id || !start) return null;
  const end = row.duration && row.duration > 0 ? new Date(start.getTime() + row.duration * 1000) : null;
  const speakers = row.transcript?.speakers ?? {};
  const summary: string[] = [];
  const decisions: string[] = [];
  const actionItems: ActionItemInput[] = [];
  walk(row.notes?.blocks, (block, path) => {
    const text = block.text?.replace(MARK, "").trim();
    if (!text) return;
    if (block.type === "action_item") {
      actionItems.push({ text, assignee: assignee(block.assignee), completed: Boolean(block.completed), due: block.due_date ?? null });
    } else if (path.includes("detailed_summaries") || path.includes("key_points")) {
      summary.push(block.type === "heading" ? `\n${text}` : `- ${text}`);
      if (/decid|agreed|approved/i.test(text) && block.type !== "heading") decisions.push(text);
    }
  });
  return {
    id: row.id,
    title: row.title?.trim() || "Krisp meeting",
    start,
    end,
    url: null,
    attendees: (row.participants ?? []).map((person) => ({ name: personName(person), email: person.email ?? null })),
    speakers: Object.values(speakers).map((person) => ({ name: personName(person), email: person.email ?? null })),
    transcript: (row.transcript?.segments ?? [])
      .filter((line) => line.text?.trim())
      .map((line) => ({
        speaker: personName(speakers[String(line.speaker ?? "")] ?? null) ?? `Speaker ${line.speaker ?? "?"}`,
        text: line.text!.trim(),
        at: clock(line.start ?? null),
      })),
    summary: summary.join("\n").trim(),
    decisions,
    actionItems,
    extra: { durationSeconds: row.duration ?? null, app: row.source ?? null },
  };
}

export async function syncKrisp(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "krisp");
  if (!account) throw new ConnectorError("Krisp is not connected. Paste a Krisp API key in Settings → Connections.", true);
  const headers = { Authorization: `Bearer ${account.accessToken}`, Accept: "application/json" };
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ from: ctx.since.toISOString(), limit: String(MEETINGS_PER_SYNC), ...(cursor ? { cursor } : {}) });
    const page: { meetings?: Array<{ id: string }>; next_cursor?: string | null } = await vendorJson("Krisp", `${KRISP_API}/meetings?${params}`, { headers });
    ids.push(...(page.meetings ?? []).map((row) => row.id));
    cursor = page.next_cursor ?? null;
  } while (cursor && ids.length < MEETINGS_PER_SYNC);
  const records: MeetingRecord[] = [];
  for (const id of ids.slice(0, MEETINGS_PER_SYNC)) {
    if (records.length) await pace();
    const fields = "title,started_at,duration,source,participants,transcript,notes";
    const response = await vendorFetch("Krisp", `${KRISP_API}/meetings/${encodeURIComponent(id)}?fields=${fields}`, { headers });
    // 409: still processing. The next Sync now picks it up.
    if (response.status === 409 || response.status === 404) continue;
    const record = krispRecord(await readJson<KrispMeeting>(response, "Krisp"));
    if (record) records.push(record);
  }
  return ingestMeetings(ctx, "krisp", records, account.account);
}

export async function checkKrisp(token: string): Promise<TokenCheck> {
  const res = await probe("Krisp", `${KRISP_API}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) refused("Krisp", (res.body as { error?: string } | null)?.error ?? res.status);
  const body = (res.body ?? {}) as Participant;
  return { account: body.email ?? personName(body) ?? "Krisp", meta: { via: "token" } };
}
