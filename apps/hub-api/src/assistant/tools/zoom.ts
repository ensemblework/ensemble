/**
 * Zoom (read only): meetings, cloud recordings, transcripts and AI Companion
 * meeting summaries, through the Zoom REST API v2 with the person's own
 * OAuth token.
 *
 * Scopes are listed with their classic and granular names, because a Zoom app
 * grants whichever kind it was built with.
 */
import { z } from "zod";
import { zonedParts } from "../../lib/clock.js";
import { clip } from "../../lib/office/text.js";
import { defineTool, toolOk, type AppToolMeta, type ToolContext } from "../types.js";
import { AppRequestError, UNTRUSTED_NOTE, addDays, appFetch, appToken, localStamp, missingAccess, plural, quote } from "./apps-common.js";

const meta = (scopes: AppToolMeta["scopes"]): AppToolMeta => ({ provider: "zoom", suite: "zoom", products: [], scopes, label: "Zoom" });

const MEETINGS = meta([["meeting:read:list_meetings", "meeting:read:list_meetings:admin", "meeting:read", "meeting:read:admin"]]);
const SUMMARY = meta([["meeting:read:summary", "meeting:read:summary:admin", "meeting_summary:read", "meeting_summary:read:admin"]]);
const RECORDINGS = meta([["cloud_recording:read:list_user_recordings", "cloud_recording:read:list_user_recordings:admin", "recording:read", "recording:read:admin"]]);
const TRANSCRIPT = meta([["cloud_recording:read:meeting_transcript", "cloud_recording:read:meeting_transcript:admin", "recording:read", "recording:read:admin"]]);

export const ZOOM_API = "https://api.zoom.us/v2";

const PAID = "Zoom cloud recordings, transcripts and AI Companion summaries need a paid Zoom plan (Pro or higher) on the host's account.";

/** Zoom answers with { code, message }. Code 200 on these endpoints means the host's plan does not include them. */
function zoomError(tool: AppToolMeta, paidOnly: boolean) {
  return (status: number, body: unknown): Error | null => {
    const record = (body && typeof body === "object" ? body : {}) as { code?: unknown; message?: unknown };
    const code = Number(record.code);
    const message = typeof record.message === "string" ? record.message : "";
    if (code === 4711 || /does not contain scopes/i.test(message)) return missingAccess(tool, tool.scopes.map((any) => any[0]!));
    if (paidOnly && (code === 200 || /paid account|upgrade|pro plan/i.test(message))) return new AppRequestError(PAID, status);
    if (code === 2305 && message) return new AppRequestError(`Zoom: ${message}`, status);
    return null;
  };
}

/** Meeting ids work as they are; UUIDs that start with "/" or contain "//" must be encoded twice. */
export function zoomMeetingPath(id: string): string {
  const once = encodeURIComponent(id.trim());
  return id.startsWith("/") || id.includes("//") ? encodeURIComponent(once) : once;
}

const MeetingId = z.string().trim().min(1).max(200).describe("Meeting id (number) or a meeting instance uuid from zoom_list_meetings or zoom_list_recordings.");

interface ZoomMeeting {
  id?: number;
  uuid?: string;
  topic?: string;
  type?: number;
  start_time?: string;
  duration?: number;
  timezone?: string;
  agenda?: string;
  join_url?: string;
}

export const zoomListMeetings = defineTool({
  name: "zoom_list_meetings",
  area: "apps",
  app: MEETINGS,
  description: "List the person's scheduled Zoom meetings, upcoming or past, optionally between two dates.",
  input: z.object({
    when: z.enum(["upcoming", "past"]).default("upcoming"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, inclusive."),
    max: z.number().int().min(1).max(100).default(30),
    nextPageToken: z.string().max(200).optional(),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, MEETINGS);
    const params = new URLSearchParams({ type: input.when === "past" ? "previous_meetings" : "upcoming", page_size: String(input.max) });
    if (input.from) params.set("from", input.from);
    if (input.to) params.set("to", input.to);
    if (input.nextPageToken) params.set("next_page_token", input.nextPageToken);
    const body = await appFetch<{ meetings?: ZoomMeeting[]; next_page_token?: string }>(ctx, MEETINGS, token, `${ZOOM_API}/users/me/meetings?${params}`, {
      onError: zoomError(MEETINGS, false),
    });
    const meetings = (body.meetings ?? []).map((meeting) => ({
      id: meeting.id,
      uuid: meeting.uuid,
      topic: meeting.topic ?? "(no topic)",
      start: localStamp(meeting.start_time, ctx.settings.timezone),
      durationMinutes: meeting.duration,
      agenda: meeting.agenda || undefined,
      joinUrl: meeting.join_url,
    }));
    return toolOk(`Found ${plural(meetings.length, `${input.when} Zoom meeting`)}.`, {
      meetings,
      ...(body.next_page_token ? { nextPageToken: body.next_page_token } : {}),
    });
  },
});

interface ZoomSummary {
  meeting_topic?: string;
  meeting_start_time?: string;
  summary_title?: string;
  summary_content?: string;
  summary_overview?: string;
  summary_details?: Array<{ label?: string; summary?: string }>;
  next_steps?: string[];
  summary_doc_url?: string;
}

/** The summary as Markdown. `summary_content` is Zoom's current field; the rest are the older ones it still sends. */
export function zoomSummaryText(summary: ZoomSummary): string {
  if (summary.summary_content?.trim()) return summary.summary_content.trim();
  return [
    summary.summary_overview?.trim() ?? "",
    ...(summary.summary_details ?? []).map((row) => [row.label ? `## ${row.label}` : "", row.summary?.trim() ?? ""].filter(Boolean).join("\n")),
    summary.next_steps?.length ? `## Next steps\n${summary.next_steps.map((step) => `- ${step}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const zoomGetMeetingSummary = defineTool({
  name: "zoom_get_meeting_summary",
  area: "apps",
  app: SUMMARY,
  description: "Read the AI Companion summary of a past Zoom meeting, when the host had meeting summaries on.",
  input: z.object({ meetingId: MeetingId, offset: z.number().int().min(0).default(0) }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, SUMMARY);
    const summary = await appFetch<ZoomSummary>(ctx, SUMMARY, token, `${ZOOM_API}/meetings/${zoomMeetingPath(input.meetingId)}/meeting_summary`, {
      onError: zoomError(SUMMARY, true),
      notFound: "no AI Companion summary for that meeting; the host needs Meeting Summary with AI Companion turned on",
    });
    const text = zoomSummaryText(summary);
    const window = clip(text, input.offset, 5000);
    const title = summary.summary_title ?? summary.meeting_topic ?? "the meeting";
    return toolOk(
      text ? `Read the Zoom summary of ${quote(title)}.` : `Zoom has an empty summary for ${quote(title)}.`,
      {
        title,
        start: localStamp(summary.meeting_start_time, ctx.settings.timezone),
        summary: window.text,
        offset: window.offset,
        total: window.total,
        ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset } : {}),
        ...(summary.summary_doc_url ? { link: summary.summary_doc_url } : {}),
        note: UNTRUSTED_NOTE,
      },
      summary.summary_doc_url ? { href: summary.summary_doc_url } : {},
    );
  },
});

interface ZoomRecordingMeeting extends ZoomMeeting {
  share_url?: string;
  recording_files?: Array<{ file_type?: string; recording_type?: string; status?: string }>;
}

/** Zoom lists at most one month of recordings per request. */
const MAX_RANGE_DAYS = 30;

export const zoomListRecordings = defineTool({
  name: "zoom_list_recordings",
  area: "apps",
  app: RECORDINGS,
  description: "List the person's Zoom cloud recordings in a date range (up to a month), and which have transcripts.",
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to 30 days before to."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to today."),
    max: z.number().int().min(1).max(100).default(30),
    nextPageToken: z.string().max(200).optional(),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const today = zonedParts(ctx.settings.timezone).date;
    const to = input.to ?? today;
    const earliest = addDays(to, -MAX_RANGE_DAYS);
    const from = input.from && input.from >= earliest ? input.from : earliest;
    if (from > to) throw new Error("from is after to.");
    const token = await appToken(ctx, RECORDINGS);
    const params = new URLSearchParams({ from, to, page_size: String(input.max) });
    if (input.nextPageToken) params.set("next_page_token", input.nextPageToken);
    const body = await appFetch<{ meetings?: ZoomRecordingMeeting[]; next_page_token?: string }>(ctx, RECORDINGS, token, `${ZOOM_API}/users/me/recordings?${params}`, {
      onError: zoomError(RECORDINGS, true),
    });
    const recordings = (body.meetings ?? []).map((meeting) => {
      const types = [...new Set((meeting.recording_files ?? []).map((file) => file.file_type).filter((type): type is string => Boolean(type)))];
      return {
        meetingId: meeting.id,
        uuid: meeting.uuid,
        topic: meeting.topic ?? "(no topic)",
        start: localStamp(meeting.start_time, ctx.settings.timezone),
        durationMinutes: meeting.duration,
        files: types,
        hasTranscript: types.includes("TRANSCRIPT"),
        shareUrl: meeting.share_url,
      };
    });
    const clamped = input.from && input.from < earliest;
    return toolOk(`Found ${plural(recordings.length, "Zoom cloud recording")} from ${from} to ${to}.`, {
      from,
      to,
      recordings,
      ...(clamped ? { note: `Zoom lists at most ${MAX_RANGE_DAYS} days at a time, so this starts at ${from}. Ask again with an earlier range for older recordings.` } : {}),
      ...(body.next_page_token ? { nextPageToken: body.next_page_token } : {}),
    });
  },
});

/** WebVTT → "[mm:ss] Speaker: words", one line per run of the same speaker. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  let speaker = "";
  let current = "";
  const flush = () => {
    if (current) lines.push(current);
    current = "";
  };
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n").map((row) => row.trim()).filter(Boolean);
    const timing = rows.findIndex((row) => row.includes("-->"));
    if (timing < 0) continue;
    const start = rows[timing]!.split("-->")[0]!.trim();
    const text = rows.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    const match = /^([^:]{1,80}):\s+(.*)$/.exec(text);
    const who = match ? match[1]!.trim() : "";
    const said = match ? match[2]! : text;
    if (current && who === speaker) {
      current += ` ${said}`;
      continue;
    }
    flush();
    speaker = who;
    const parts = start.replace(/[.,]\d+$/, "").split(":").map(Number);
    const [hours = 0, minutes = 0, seconds = 0] = parts.length === 3 ? parts : [0, ...parts];
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    current = `[${stamp}] ${who ? `${who}: ` : ""}${said}`;
  }
  flush();
  return lines.join("\n");
}

const TRANSCRIPT_MISSING: Record<string, string> = {
  NOT_READY: "Zoom is still processing this transcript. Try again in a few minutes.",
  NO_TRANSCRIPT_DATA: "This meeting has no transcript. Zoom makes one only when the meeting is recorded to the cloud with audio transcripts on.",
  DELETED_OR_TRASHED: "This meeting's transcript was deleted or is in the Zoom trash.",
  UNSUPPORTED: "Zoom cannot provide a transcript for this meeting.",
};

/** Download links must stay on Zoom: the person's token is sent with them. */
function zoomDownload(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppRequestError("Zoom returned a transcript link Ensemble could not read.", 0);
  }
  if (parsed.protocol !== "https:" || !(parsed.hostname === "zoom.us" || parsed.hostname.endsWith(".zoom.us"))) {
    throw new AppRequestError("Zoom returned a transcript link outside zoom.us, so Ensemble did not follow it.", 0);
  }
  return parsed.toString();
}

async function transcriptText(ctx: ToolContext, token: string, meetingId: string): Promise<string> {
  const info = await appFetch<{ can_download?: boolean; download_url?: string | null; download_restriction_reason?: string | null }>(
    ctx,
    TRANSCRIPT,
    token,
    `${ZOOM_API}/meetings/${zoomMeetingPath(meetingId)}/transcript`,
    { onError: zoomError(TRANSCRIPT, true), notFound: "no transcript for that meeting; Zoom makes one only for cloud recordings with audio transcripts on" },
  );
  if (!info.can_download || !info.download_url) {
    throw new AppRequestError(TRANSCRIPT_MISSING[info.download_restriction_reason ?? ""] ?? TRANSCRIPT_MISSING.NO_TRANSCRIPT_DATA!, 404);
  }
  return appFetch<string>(ctx, TRANSCRIPT, token, zoomDownload(info.download_url), { expect: "text", onError: zoomError(TRANSCRIPT, true) });
}

export const zoomGetTranscript = defineTool({
  name: "zoom_get_transcript",
  area: "apps",
  app: TRANSCRIPT,
  description: "Read the transcript of a recorded Zoom meeting as speaker lines with timestamps.",
  input: z.object({
    meetingId: MeetingId,
    offset: z.number().int().min(0).default(0).describe("Character offset for long transcripts; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, TRANSCRIPT);
    const raw = await transcriptText(ctx, token, input.meetingId);
    const text = raw.trimStart().startsWith("WEBVTT") || raw.includes("-->") ? vttToText(raw) : raw.trim();
    const window = clip(text, input.offset, 6000);
    const speakers = [...new Set(text.split("\n").map((line) => /^\[[^\]]+\] ([^:]{1,80}):/.exec(line)?.[1]).filter((name): name is string => Boolean(name)))];
    return toolOk(`Read the Zoom transcript${speakers.length ? ` (${plural(speakers.length, "speaker")})` : ""}.`, {
      speakers,
      transcript: window.text,
      offset: window.offset,
      total: window.total,
      ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset } : {}),
      note: UNTRUSTED_NOTE,
    });
  },
});

export const zoomTools = [zoomListMeetings, zoomGetMeetingSummary, zoomListRecordings, zoomGetTranscript];
