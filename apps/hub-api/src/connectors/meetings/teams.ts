/**
 * Microsoft Teams meeting transcripts through Microsoft Graph, one meeting at a time, when the
 * person asks (docs/03 §2.4): the meeting from its join link (`/me/onlineMeetings?$filter=
 * JoinWebUrl eq '…'`), its transcripts, and each one's WebVTT content. Graph lets apps
 * download a transcript only with the organizer's account; attendees who can read it in
 * Teams are told so and offered the organizer, Teams itself, and pasting.
 */
import { prisma } from "../../lib/prisma.js";
import { GRAPH, odata } from "../microsoft.js";
import { hasScopes } from "../tokens.js";
import { saveTranscript } from "./transcript-import.js";
import { parseTranscript, transcriptFromLines, type ParsedTranscript } from "./transcript-parse.js";
import {
  askOrganizer,
  connectAction,
  getJson,
  openAction,
  problem,
  remoteToken,
  storedOnlineEvents,
  unavailable,
  type ProblemAction,
  type RemoteMeeting,
} from "./remote.js";

export const TEAMS_TRANSCRIPT_SCOPES = ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"] as const;
/** Optional: says "recorded, not transcribed" instead of "nothing recorded". */
export const TEAMS_RECORDING_SCOPE = "OnlineMeetingRecording.Read.All";

const PERSONAL = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;

interface GraphIdentity {
  upn?: string | null;
  identity?: { user?: { id?: string | null; displayName?: string | null } | null } | null;
}

interface GraphOnlineMeeting {
  id: string;
  subject?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  joinWebUrl?: string | null;
  allowTranscription?: boolean | null;
  participants?: { organizer?: GraphIdentity | null; attendees?: GraphIdentity[] | null } | null;
}

interface GraphTranscript {
  id: string;
  createdDateTime?: string | null;
  endDateTime?: string | null;
}

interface GraphCalendarEvent {
  id: string;
  subject?: string | null;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isOrganizer?: boolean;
  isCancelled?: boolean;
  onlineMeetingProvider?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  organizer?: { emailAddress?: { name?: string | null; address?: string | null } };
}

const person = (row: GraphIdentity | null | undefined) => ({ name: row?.identity?.user?.displayName?.trim() || null, email: row?.upn?.trim().toLowerCase() || null });

const pasteFromTeams: ProblemAction = { kind: "paste", label: "Paste from Teams" };

const utc = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Recent Teams meetings from the Outlook calendar (when it is allowed) and from calendars Ensemble already saved. */
export async function listTeamsMeetings(userId: string, days: number): Promise<RemoteMeeting[]> {
  const token = await remoteToken(userId, "teams", TEAMS_TRANSCRIPT_SCOPES);
  const now = Date.now();
  const from = new Date(now - days * 86_400_000);
  const to = new Date(now + 3_600_000);
  const rows: RemoteMeeting[] = [];
  const stored = await storedOnlineEvents(userId, "teams", from, to);
  if (hasScopes(token, ["Calendars.Read"])) {
    const url = `${GRAPH}/me/calendarView?${odata({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: 100, $select: "id,subject,start,end,isOrganizer,isCancelled,onlineMeetingProvider,onlineMeeting,organizer", $orderby: "start/dateTime desc" })}`;
    const result = await getJson<{ value?: GraphCalendarEvent[] }>(url, token.token);
    if (result.ok) {
      for (const event of result.data.value ?? []) {
        const joinUrl = event.onlineMeeting?.joinUrl ?? null;
        if (event.isCancelled || !joinUrl || !/teams\.(microsoft|live)\.com/i.test(joinUrl)) continue;
        const start = utc(event.start?.dateTime);
        if (!start) continue;
        const saved = stored.find((row) => row.joinUrl === joinUrl);
        rows.push({
          ref: joinUrl,
          title: event.subject?.trim() || "Teams meeting",
          start,
          end: utc(event.end?.dateTime),
          joinUrl,
          organizer: event.organizer?.emailAddress?.name ?? event.organizer?.emailAddress?.address ?? null,
          isOrganizer: event.isOrganizer ?? null,
          hasTranscript: null,
          eventId: saved?.id ?? null,
          noteId: null,
        });
      }
    }
  }
  for (const event of stored) {
    if (rows.some((row) => row.joinUrl === event.joinUrl)) continue;
    rows.push({ ref: event.joinUrl!, title: event.title || "Teams meeting", start: event.ts.toISOString(), end: event.end, joinUrl: event.joinUrl, organizer: event.organizer, isOrganizer: null, hasTranscript: null, eventId: event.id, noteId: null });
  }
  const meetingIds = await prisma.meetingNote.findMany({
    where: { userId, externalSource: "teams", deletedAt: null, transcriptArtifact: { url: { in: rows.map((row) => row.joinUrl!).filter(Boolean) } } },
    select: { id: true, transcriptArtifact: { select: { url: true } } },
  });
  const byUrl = new Map(meetingIds.map((row) => [row.transcriptArtifact?.url ?? "", row.id]));
  return rows
    .map((row) => ({ ...row, noteId: byUrl.get(row.joinUrl ?? "") ?? null }))
    .filter((row) => new Date(row.start).getTime() <= now)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 40);
}

/** Graph error → what the person can do about it. */
function refused(status: number, body: { code: string; message: string; inner: string }, context: { joinUrl: string; title: string; organizer: { name: string | null; email: string | null } | null; isOrganizer: boolean | null }): never {
  const open = openAction(context.joinUrl, "Open in Teams");
  if (body.inner === "GraphAccessToTranscriptsDisabled" || /access to transcripts is disabled/i.test(body.message)) {
    return problem({
      provider: "teams",
      code: "admin_blocked",
      title: "Your organization has turned off transcript access for apps",
      detail: "A Microsoft 365 admin switched off Graph access to Teams transcripts, so no app can download them. You can still copy the transcript in Teams and paste it here.",
      actions: [...open, pasteFromTeams],
    });
  }
  if (/scope|insufficient privileges|consent/i.test(body.message) && context.isOrganizer !== false) {
    return problem({
      provider: "teams",
      code: "needs_access",
      title: "Microsoft needs you to approve transcript access",
      detail: "Microsoft refused the request because Ensemble doesn't have “Read all transcripts of online meetings” for your account yet. Approve it again; if your organization requires it, Microsoft sends the request to an admin.",
      actions: [connectAction("teams", "Reconnect and approve"), pasteFromTeams],
    });
  }
  if ((status === 403 || status === 404) && context.isOrganizer !== true) {
    return problem({
      provider: "teams",
      code: "not_organizer",
      title: "Only the organizer can download this transcript",
      detail: `Teams lets attendees read the transcript and ask Copilot about it in the meeting recap, but Microsoft only lets apps download it with the organizer's account${context.organizer?.name ? ` (${context.organizer.name})` : ""}. Ask them to share the file, or copy the transcript from Teams and paste it here.`,
      actions: [askOrganizer(context.organizer, context.title, "Teams"), ...open, pasteFromTeams],
    });
  }
  if (status === 404) {
    return problem({
      provider: "teams",
      code: "expired",
      title: "Teams no longer has this meeting's transcript",
      detail: "The meeting has expired in Teams, or its transcript was deleted. If you downloaded it earlier, upload the file.",
      actions: [{ kind: "upload", label: "Upload a transcript file" }, ...open],
    });
  }
  return unavailable("teams", status, body.message, [...open, pasteFromTeams]);
}

/** Every transcript of the meeting at this join link, imported as one note. Returns the note id. */
export async function importTeamsMeeting(userId: string, input: { joinUrl: string; eventId?: string | null; title?: string | null }): Promise<string> {
  const token = await remoteToken(userId, "teams", TEAMS_TRANSCRIPT_SCOPES);
  const open = openAction(input.joinUrl, "Open in Teams");
  if (token.account && PERSONAL.test(token.account)) {
    return problem({
      provider: "teams",
      code: "personal_account",
      title: "Personal Microsoft accounts have no transcript API",
      detail: "Microsoft offers meeting transcripts to apps only for work or school accounts. Copy the transcript in Teams and paste it here.",
      actions: [...open, pasteFromTeams],
    });
  }
  const filter = `JoinWebUrl eq '${input.joinUrl.replace(/'/g, "''")}'`;
  const found = await getJson<{ value?: GraphOnlineMeeting[] }>(`${GRAPH}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`, token.token);
  const title = input.title?.trim() || "this meeting";
  if (!found.ok) refused(found.status, found.body, { joinUrl: input.joinUrl, title, organizer: null, isOrganizer: null });
  const meeting = found.ok ? found.data.value?.[0] : undefined;
  if (!meeting) {
    return problem({
      provider: "teams",
      code: "not_found",
      title: "Teams didn't return this meeting for your account",
      detail: "Graph finds meetings you organized or were invited to in your own organization. Meetings run by another organization, and some channel meetings, can't be read this way. Copy the transcript in Teams and paste it here.",
      actions: [...open, pasteFromTeams],
    });
  }
  const organizer = person(meeting.participants?.organizer);
  const self = typeof token.meta?.graphUserId === "string" ? token.meta.graphUserId : null;
  const organizerId = meeting.participants?.organizer?.identity?.user?.id ?? null;
  const isOrganizer = self && organizerId ? self === organizerId : organizer.email && token.account ? organizer.email === token.account.toLowerCase() : null;
  const subject = meeting.subject?.trim() || input.title?.trim() || "Teams meeting";
  const context = { joinUrl: input.joinUrl, title: subject, organizer, isOrganizer };
  const base = `${GRAPH}/me/onlineMeetings/${encodeURIComponent(meeting.id)}`;
  const listed = await getJson<{ value?: GraphTranscript[] }>(`${base}/transcripts`, token.token);
  if (!listed.ok) refused(listed.status, listed.body, context);
  const transcripts = (listed.ok ? listed.data.value ?? [] : []).sort((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""));
  if (!transcripts.length) {
    let recorded = false;
    if (hasScopes(token, [TEAMS_RECORDING_SCOPE])) {
      const recordings = await getJson<{ value?: unknown[] }>(`${base}/recordings`, token.token);
      recorded = recordings.ok && (recordings.data.value?.length ?? 0) > 0;
    }
    if (recorded) {
      return problem({
        provider: "teams",
        code: "recording_only",
        title: "This meeting was recorded, but not transcribed",
        detail: "Teams writes a transcript only when transcription is on during the meeting. Ensemble reads transcripts; it doesn't turn recordings into text.",
        actions: [...open, { kind: "upload", label: "Upload a transcript file" }],
      });
    }
    return problem({
      provider: "teams",
      code: "no_transcript",
      title: meeting.allowTranscription === false ? "Transcription was off for this meeting" : "No transcript for this meeting",
      detail:
        isOrganizer === false
          ? "Teams returned no transcript Ensemble can read. If someone transcribed it, only the organizer's account can download it; copy it from Teams' recap and paste it here."
          : "Nobody started transcription in this meeting. Next time, in Teams choose More → Record and transcribe → Start transcription.",
      actions: isOrganizer === false ? [askOrganizer(organizer, subject, "Teams"), ...open, pasteFromTeams] : [...open, pasteFromTeams],
    });
  }
  const lines: ParsedTranscript["lines"] = [];
  for (const transcript of transcripts.slice(0, 10)) {
    const content = await getJson<string>(`${base}/transcripts/${encodeURIComponent(transcript.id)}/content?$format=text/vtt`, token.token, { accept: "text/vtt" });
    if (!content.ok) refused(content.status, content.body, context);
    if (content.ok) lines.push(...parseTranscript(content.data).lines);
  }
  const start = meeting.startDateTime ? new Date(meeting.startDateTime) : null;
  const end = meeting.endDateTime ? new Date(meeting.endDateTime) : null;
  const parsed = transcriptFromLines("teams-vtt", lines, { title: subject, startedAt: start });
  if (!parsed.lines.length) {
    return problem({ provider: "teams", code: "no_transcript", title: "The transcript is empty", detail: "Teams returned a transcript with no words in it.", actions: [...open, pasteFromTeams] });
  }
  const attendees = [meeting.participants?.organizer, ...(meeting.participants?.attendees ?? [])].map(person).filter((row) => row.email || row.name);
  return saveTranscript(userId, parsed, {
    origin: "teams",
    externalId: meeting.id,
    source: "connector",
    title: subject,
    start,
    end,
    url: meeting.joinWebUrl ?? input.joinUrl,
    eventArtifactId: input.eventId ?? null,
    attendees,
    organizer: organizer.email,
    extra: { transcripts: transcripts.length },
  });
}
