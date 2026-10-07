/**
 * Otter.ai public API (API key from Integrations → Developer; Enterprise workspaces only).
 * https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API
 */
import { syncAccount } from "../tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "../types.js";
import { parseSpeakerBlocks } from "./actions.js";
import { ingestMeetings } from "./ingest.js";
import { dateOr, MEETINGS_PER_SYNC, pace, probe, refused, vendorFetch, vendorJson, type MeetingRecord, type TokenCheck } from "./types.js";

export const OTTER_API = "https://api.otter.ai/v1";

type Person = { name?: string | null; email?: string | null };

interface OtterConversation {
  id: string;
  title?: string | null;
  url?: string | null;
  owner?: Person | null;
  created_at?: string | null;
  calendar_guests?: Person[] | null;
  abstract_summary?: string | null;
  relationships?: {
    action_items?: Array<{ text?: string | null; assignee?: Person | null; status?: unknown }> | null;
    transcript?: { content?: string | null } | null;
    outline?: Array<{ section?: string | null; text?: string[] | null }> | null;
  } | null;
}

export function otterRecord(row: OtterConversation): MeetingRecord | null {
  const start = dateOr(row.created_at ?? null);
  if (!row.id || !start) return null;
  const attendees = [...(row.owner ? [row.owner] : []), ...(row.calendar_guests ?? [])];
  const outline = (row.relationships?.outline ?? []).flatMap((section) => [section.section ? `\n${section.section}` : "", ...(section.text ?? []).map((line) => `- ${line}`)]);
  return {
    id: row.id,
    title: row.title?.trim() || "Otter conversation",
    start,
    end: null,
    url: row.url ?? null,
    organizer: row.owner?.email ?? null,
    attendees: attendees.map((person) => ({ name: person.name ?? null, email: person.email ?? null })),
    transcript: parseSpeakerBlocks(row.relationships?.transcript?.content),
    summary: [row.abstract_summary?.trim() ?? "", outline.join("\n").trim()].filter(Boolean).join("\n\n"),
    actionItems: (row.relationships?.action_items ?? [])
      .filter((item) => item.text?.trim())
      .map((item) => ({ text: item.text!.trim(), assignee: item.assignee ?? null, completed: typeof item.status === "string" && /done|complete/i.test(item.status) })),
  };
}

export async function syncOtter(ctx: SyncContext): Promise<SyncResult> {
  const account = await syncAccount(ctx.userId, "otter");
  if (!account) throw new ConnectorError("Otter is not connected. Paste an Otter API key in Settings → Connections.", true);
  const headers = { Authorization: `Bearer ${account.accessToken}`, Accept: "application/json" };
  const ids: string[] = [];
  let cursor: string | null = null;
  let older = false;
  do {
    const params = new URLSearchParams({ include_shared: "true", limit: String(MEETINGS_PER_SYNC), ...(cursor ? { cursor } : {}) });
    const page: { data?: Array<{ id: string; created_at?: string | null }>; meta?: { has_more?: boolean; next_cursor?: string | null } } = await vendorJson(
      "Otter",
      `${OTTER_API}/conversations?${params}`,
      { headers },
    );
    // Newest first: stop at the first conversation older than the look-back window.
    for (const row of page.data ?? []) {
      const at = dateOr(row.created_at ?? null);
      if (at && at < ctx.since) {
        older = true;
        break;
      }
      ids.push(row.id);
    }
    cursor = page.meta?.has_more ? (page.meta.next_cursor ?? null) : null;
  } while (cursor && !older && ids.length < MEETINGS_PER_SYNC);
  const records: MeetingRecord[] = [];
  for (const id of ids.slice(0, MEETINGS_PER_SYNC)) {
    if (records.length) await pace();
    const response = await vendorFetch("Otter", `${OTTER_API}/conversations/${encodeURIComponent(id)}?include=action_items,transcript,outline`, { headers });
    if (response.status === 404) continue;
    const record = otterRecord((await readJson<{ data?: OtterConversation }>(response, "Otter")).data ?? ({ id } as OtterConversation));
    if (record) records.push(record);
  }
  return ingestMeetings(ctx, "otter", records, account.account);
}

export async function checkOtter(token: string): Promise<TokenCheck> {
  const res = await probe("Otter", `${OTTER_API}/conversations?limit=1`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) refused("Otter", res.status === 403 ? "the public API needs an Enterprise workspace" : res.status);
  const owner = (res.body as { data?: Array<{ owner?: Person }> } | null)?.data?.[0]?.owner;
  return { account: owner?.email ?? "Otter", meta: { via: "token" } };
}
