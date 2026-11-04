/**
 * Zoom cloud-recording transcripts through the Zoom REST API v2, when the person asks
 * (docs/03 §2.4): recent recordings (`/users/me/recordings`), and one meeting's transcript
 * (`/meetings/{id}/transcript`, then its WebVTT download). Zoom gives these to the host's
 * account, on paid plans, when audio transcripts were on.
 */
import { zonedParts } from "../../lib/clock.js";
import { loadSettings } from "../../lib/settings.js";
import { prisma } from "../../lib/prisma.js";
import { saveTranscript } from "./transcript-import.js";
import { parseTranscript } from "./transcript-parse.js";
import { connectAction, getJson, importedIds, openAction, problem, remoteToken, storedOnlineEvents, unavailable, type ProblemAction, type RemoteMeeting } from "./remote.js";

const ZOOM_API = "https://api.zoom.us/v2";

const upload: ProblemAction = { kind: "upload", label: "Upload a transcript file" };

/** Meeting ids work as they are; uuids that start with "/" or contain "//" are encoded twice (as in assistant/tools/zoom.ts). */
const zoomMeetingPath = (id: string): string => {
  const once = encodeURIComponent(id.trim());
  return id.startsWith("/") || id.includes("//") ? encodeURIComponent(once) : once;
};

interface ZoomRecording {
  id?: number;
  uuid?: string;
  topic?: string;
  start_time?: string;
  duration?: number;
  share_url?: string;
  host_email?: string;
  recording_files?: Array<{ file_type?: string }>;
}

/** A Zoom meeting id from a join link: zoom.us/j/85012345678?pwd=… → "85012345678". */
export function zoomMeetingId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /\/(?:j|w|s|wc\/join|my)\/(\d{9,12})\b/.exec(url);
  return match ? match[1]! : null;
}

function refused(status: number, body: { code: string; message: string }, open: ProblemAction[]): never {
  const code = Number(body.code);
  if (code === 4711 || /does not contain scopes|scope/i.test(body.message) || status === 401) {
    return problem({
      provider: "zoom",
      code: "needs_access",
      title: "Reconnect Zoom to read transcripts",
      detail: "Zoom refused the request because the connection doesn't include access to cloud recordings and transcripts. Connect Zoom again and approve it.",
      actions: [connectAction("zoom", "Reconnect Zoom"), upload],
    });
  }
  if (code === 200 || /paid account|upgrade|pro plan/i.test(body.message)) {
    return problem({
      provider: "zoom",
      code: "no_transcript",
      title: "Cloud transcripts need a paid Zoom plan",
      detail: "Zoom makes transcripts only for cloud recordings on Pro plans and above. If you saved a transcript from the meeting, upload it.",
      actions: [upload, ...open],
    });
  }
  if (status === 404 || code === 3301 || code === 1001) {
    return problem({
      provider: "zoom",
      code: "not_organizer",
      title: "Zoom has no transcript for your account",
      detail: "Zoom gives cloud recordings and their transcripts to the meeting's host. If someone else hosted it, ask them to share the transcript (.vtt), or save the transcript from the meeting's Live Transcript panel and upload it.",
      actions: [upload, ...open],
    });
  }
  return unavailable("zoom", status, body.message, [upload, ...open]);
}

/** Your cloud recordings from the last `days` (Zoom lists at most 30 days per request). */
export async function listZoomMeetings(userId: string, days: number): Promise<RemoteMeeting[]> {
  const token = await remoteToken(userId, "zoom", []);
  const settings = await loadSettings(prisma, userId);
  const today = zonedParts(settings.timezone).date;
  const from = new Date(Date.now() - Math.min(days, 30) * 86_400_000).toISOString().slice(0, 10);
  const result = await getJson<{ meetings?: ZoomRecording[] }>(`${ZOOM_API}/users/me/recordings?${new URLSearchParams({ from, to: today, page_size: "50" })}`, token.token);
  if (!result.ok) refused(result.status, result.body, []);
  const meetings = result.ok ? result.data.meetings ?? [] : [];
  const events = await storedOnlineEvents(userId, "zoom", new Date(`${from}T00:00:00Z`), new Date());
  const imported = await importedIds(userId, "zoom", meetings.map((row) => row.uuid ?? "").filter(Boolean));
  return meetings
    .filter((row) => row.uuid)
    .map((row) => {
      const start = row.start_time ?? new Date().toISOString();
      const event = events.find((item) => zoomMeetingId(item.joinUrl) === String(row.id ?? "") && Math.abs(item.ts.getTime() - new Date(start).getTime()) < 6 * 3_600_000) ?? null;
      return {
        ref: row.uuid!,
        title: row.topic?.trim() || "Zoom meeting",
        start,
        end: row.duration ? new Date(new Date(start).getTime() + row.duration * 60_000).toISOString() : null,
        joinUrl: row.share_url ?? null,
        organizer: row.host_email ?? null,
        isOrganizer: true,
        hasTranscript: (row.recording_files ?? []).some((file) => file.file_type === "TRANSCRIPT"),
        eventId: event?.id ?? null,
        noteId: imported.get(row.uuid!) ?? null,
      };
    });
}

const MISSING: Record<string, { code: "processing" | "no_transcript" | "expired"; title: string; detail: string }> = {
  NOT_READY: { code: "processing", title: "Zoom is still writing the transcript", detail: "Try again in a few minutes." },
  NO_TRANSCRIPT_DATA: { code: "no_transcript", title: "No transcript for this meeting", detail: "Zoom makes a transcript only when the meeting is recorded to the cloud with audio transcripts on (Settings → Recording → Create audio transcript)." },
  DELETED_OR_TRASHED: { code: "expired", title: "This transcript was deleted", detail: "The recording's transcript is deleted or in the Zoom trash. Restore it in Zoom, or upload a saved copy." },
  UNSUPPORTED: { code: "no_transcript", title: "Zoom can't provide a transcript for this meeting", detail: "If you saved one from the meeting, upload it." },
};

/** Download links must stay on Zoom: the person's token is sent with them. */
function zoomDownload(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "zoom.us" || parsed.hostname.endsWith(".zoom.us")) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Imports one meeting's cloud transcript: a recording uuid from the list, or a join link's meeting id. Returns the note id. */
export async function importZoomMeeting(userId: string, input: { ref?: string | null; joinUrl?: string | null; eventId?: string | null; title?: string | null; start?: Date | null }): Promise<string> {
  const token = await remoteToken(userId, "zoom", []);
  const open = openAction(input.joinUrl, "Open in Zoom");
  const id = input.ref?.trim() || zoomMeetingId(input.joinUrl);
  if (!id) return problem({ provider: "zoom", code: "not_found", title: "That isn't a Zoom meeting link", detail: "Zoom links look like zoom.us/j/85012345678.", actions: [upload] });
  const info = await getJson<{ can_download?: boolean; download_url?: string | null; download_restriction_reason?: string | null; meeting_topic?: string; meeting_start_time?: string; host_email?: string }>(
    `${ZOOM_API}/meetings/${zoomMeetingPath(id)}/transcript`,
    token.token,
  );
  if (!info.ok) refused(info.status, info.body, open);
  const data = info.ok ? info.data : {};
  if (!data.can_download || !data.download_url) {
    const missing = MISSING[data.download_restriction_reason ?? ""] ?? MISSING.NO_TRANSCRIPT_DATA!;
    return problem({ provider: "zoom", code: missing.code, title: missing.title, detail: missing.detail, actions: [upload, ...open] });
  }
  const url = zoomDownload(data.download_url);
  if (!url) return unavailable("zoom", 0, "Zoom returned a transcript link outside zoom.us, so Ensemble did not follow it.", [upload]);
  const vtt = await getJson<string>(url, token.token, { accept: "text/vtt" });
  if (!vtt.ok) refused(vtt.status, vtt.body, open);
  const parsed = parseTranscript(vtt.ok ? vtt.data : "");
  if (!parsed.lines.length) return problem({ provider: "zoom", code: "no_transcript", title: "The transcript is empty", detail: "Zoom returned a transcript with no words in it.", actions: [upload, ...open] });
  const start = data.meeting_start_time ? new Date(data.meeting_start_time) : input.start ?? null;
  return saveTranscript(userId, parsed, {
    origin: "zoom",
    externalId: id,
    source: "connector",
    title: input.title?.trim() || data.meeting_topic?.trim() || null,
    start,
    url: input.joinUrl ?? null,
    eventArtifactId: input.eventId ?? null,
    organizer: data.host_email ?? null,
  });
}
