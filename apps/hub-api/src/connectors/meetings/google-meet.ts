/**
 * Google Meet transcripts through the Meet REST API v2, one call at a time, when the person
 * asks (docs/03 §2.4): conference records (by meeting code and time, or recent ones), their
 * transcripts, each transcript's entries, and the participants who said them. Google keeps
 * entries for 30 days after a call; the transcript Doc in Drive stays and can be uploaded.
 */
import { prisma } from "../../lib/prisma.js";
import { clock } from "./types.js";
import { saveTranscript } from "./transcript-import.js";
import { transcriptFromLines } from "./transcript-parse.js";
import { connectAction, getJson, importedIds, openAction, problem, remoteToken, storedOnlineEvents, unavailable, type ProblemAction, type RemoteMeeting } from "./remote.js";

export const MEET_API = "https://meet.googleapis.com/v2";
export const MEET_SCOPES = ["https://www.googleapis.com/auth/meetings.space.readonly"] as const;
/** Google deletes transcript entries this long after a call ends. */
const ENTRY_DAYS = 30;
const MAX_ENTRIES = 6000;

interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
}

interface MeetTranscript {
  name: string;
  state?: "STATE_UNSPECIFIED" | "STARTED" | "ENDED" | "FILE_GENERATED";
  startTime?: string;
  endTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

interface MeetEntry {
  participant?: string;
  text?: string;
  startTime?: string;
}

interface MeetParticipant {
  name: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** "https://meet.google.com/abc-mnop-xyz?authuser=0" → "abc-mnop-xyz". */
export function meetingCode(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "meet.google.com") return null;
    const code = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

const uploadDoc: ProblemAction = { kind: "upload", label: "Upload the transcript Doc" };

function refused(status: number, body: { code: string; message: string; inner: string }, open: ProblemAction[]): never {
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(`${body.inner} ${body.message}`)) {
    return problem({
      provider: "google_meet",
      code: "app_not_set_up",
      title: "Google Meet's API isn't switched on for this server",
      detail: "Whoever runs this Ensemble server turns on the Google Meet REST API for its Google Cloud project. Until then, download the transcript Doc from Drive and upload it here.",
      actions: [...open, uploadDoc],
    });
  }
  if (status === 401 || (status === 403 && /scope|insufficient/i.test(`${body.inner} ${body.message}`))) {
    return problem({
      provider: "google_meet",
      code: "needs_access",
      title: "Allow Ensemble to read Google Meet transcripts",
      detail: "Google refused the request because Ensemble doesn't have Meet access for your account yet. Turn on Google Meet transcripts and approve it.",
      actions: [connectAction("google_meet", "Turn on and approve"), uploadDoc],
    });
  }
  if (status === 403) {
    return problem({
      provider: "google_meet",
      code: "not_organizer",
      title: "Google didn't share this transcript with your account",
      detail: "Meet gives transcripts to the meeting's owner and the people it shares the transcript Doc with. Ask the organizer to share the Doc, then download it as .docx or .txt and upload it.",
      actions: [...open, uploadDoc],
    });
  }
  return unavailable("google_meet", status, body.message, [...open, uploadDoc]);
}

async function pages<T>(url: string, key: string, token: string, max: number, open: ProblemAction[]): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  do {
    const joiner = url.includes("?") ? "&" : "?";
    const result = await getJson<Record<string, unknown>>(`${url}${joiner}pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, token);
    if (!result.ok) refused(result.status, result.body, open);
    const data = result.ok ? result.data : {};
    out.push(...((data[key] as T[] | undefined) ?? []));
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const participantName = (row: MeetParticipant): string => row.signedinUser?.displayName ?? row.anonymousUser?.displayName ?? row.phoneUser?.displayName ?? "";

/** Calls you were in during the last `days`, titled from the calendar where Ensemble has the event. */
export async function listMeetMeetings(userId: string, days: number): Promise<RemoteMeeting[]> {
  const token = await remoteToken(userId, "google_meet", MEET_SCOPES);
  const from = new Date(Date.now() - Math.min(days, ENTRY_DAYS) * 86_400_000);
  const filter = `start_time>="${from.toISOString()}"`;
  const records = await pages<ConferenceRecord>(`${MEET_API}/conferenceRecords?filter=${encodeURIComponent(filter)}`, "conferenceRecords", token.token, 40, []);
  const events = await storedOnlineEvents(userId, "google_meet", new Date(from.getTime() - 86_400_000), new Date());
  const spaces = new Map<string, string | null>();
  await Promise.all(
    [...new Set(records.map((row) => row.space).filter((space): space is string => Boolean(space)))].slice(0, 20).map(async (space) => {
      const result = await getJson<{ meetingCode?: string; meetingUri?: string }>(`${MEET_API}/${space}`, token.token);
      spaces.set(space, result.ok ? result.data.meetingCode ?? meetingCode(result.data.meetingUri) : null);
    }),
  );
  const imported = await importedIds(userId, "google_meet", records.map((row) => row.name));
  return records.map((record) => {
    const code = record.space ? spaces.get(record.space) ?? null : null;
    const start = record.startTime ? new Date(record.startTime) : new Date();
    const event = events.find((row) => meetingCode(row.joinUrl) === code && Math.abs(row.ts.getTime() - start.getTime()) < 6 * 3_600_000) ?? null;
    return {
      ref: record.name,
      title: event?.title || (code ? `Google Meet call (${code})` : "Google Meet call"),
      start: start.toISOString(),
      end: record.endTime ?? null,
      joinUrl: code ? `https://meet.google.com/${code}` : event?.joinUrl ?? null,
      organizer: event?.organizer ?? null,
      isOrganizer: null,
      hasTranscript: null,
      eventId: event?.id ?? null,
      noteId: imported.get(record.name) ?? null,
    };
  });
}

/** The conference record for a calendar event's Meet link: the call that started nearest the event. */
async function recordFor(token: string, code: string, near: Date | null, open: ProblemAction[]): Promise<ConferenceRecord | null> {
  const filter = near
    ? `space.meeting_code = "${code}" AND start_time>="${new Date(near.getTime() - 3 * 3_600_000).toISOString()}" AND start_time<="${new Date(near.getTime() + 6 * 3_600_000).toISOString()}"`
    : `space.meeting_code = "${code}"`;
  const records = await pages<ConferenceRecord>(`${MEET_API}/conferenceRecords?filter=${encodeURIComponent(filter)}`, "conferenceRecords", token, 20, open);
  if (!records.length) return null;
  if (!near) return records[0]!;
  return [...records].sort((a, b) => Math.abs(new Date(a.startTime ?? 0).getTime() - near.getTime()) - Math.abs(new Date(b.startTime ?? 0).getTime() - near.getTime()))[0]!;
}

/** Imports the transcript of one Meet call: a conference record name, or a Meet link and the event's time. Returns the note id. */
export async function importMeetMeeting(userId: string, input: { record?: string | null; joinUrl?: string | null; start?: Date | null; eventId?: string | null; title?: string | null }): Promise<string> {
  const token = await remoteToken(userId, "google_meet", MEET_SCOPES);
  const open = openAction(input.joinUrl, "Open in Google Meet");
  let record: ConferenceRecord | null = null;
  if (input.record && /^conferenceRecords\/[\w-]+$/.test(input.record)) {
    const result = await getJson<ConferenceRecord>(`${MEET_API}/${input.record}`, token.token);
    if (!result.ok && result.status !== 404) refused(result.status, result.body, open);
    record = result.ok ? result.data : null;
  } else {
    const code = meetingCode(input.joinUrl);
    if (!code) return problem({ provider: "google_meet", code: "not_found", title: "That isn't a Google Meet link", detail: "Meet links look like meet.google.com/abc-defg-hij.", actions: [uploadDoc] });
    record = await recordFor(token.token, code, input.start ?? null, open);
  }
  const title = input.title?.trim() || "Google Meet call";
  if (!record) {
    return problem({
      provider: "google_meet",
      code: "not_found",
      title: "Google Meet has no record of this call for your account",
      detail: `Meet keeps call records for ${ENTRY_DAYS} days, for calls you organized or joined with this Google account. If the call happened, find the transcript Doc in Drive (Meet Recordings), download it as .docx or .txt and upload it.`,
      actions: [uploadDoc],
    });
  }
  const transcripts = await pages<MeetTranscript>(`${MEET_API}/${record.name}/transcripts`, "transcripts", token.token, 10, open);
  const doc = transcripts.find((row) => row.docsDestination?.exportUri)?.docsDestination?.exportUri ?? null;
  const openDoc = openAction(doc, "Open the transcript Doc");
  if (!transcripts.length) {
    const recordings = await getJson<{ recordings?: unknown[] }>(`${MEET_API}/${record.name}/recordings`, token.token);
    const recorded = recordings.ok && (recordings.data.recordings?.length ?? 0) > 0;
    return problem({
      provider: "google_meet",
      code: recorded ? "recording_only" : "no_transcript",
      title: recorded ? "This call was recorded, but not transcribed" : "No transcript for this call",
      detail: recorded
        ? "Meet writes a transcript only when someone turns on transcripts during the call. Ensemble reads transcripts; it doesn't turn recordings into text."
        : "Nobody turned on transcripts in this call. Next time, in Meet choose Activities → Transcripts → Start transcription.",
      actions: recorded ? [...open, uploadDoc] : [{ kind: "paste", label: "Paste notes or a transcript" }],
    });
  }
  if (transcripts.every((row) => row.state === "STARTED")) {
    return problem({ provider: "google_meet", code: "processing", title: "The transcript is still being written", detail: "Meet finishes the transcript a few minutes after the call ends. Try again shortly.", actions: openDoc });
  }
  const participants = await pages<MeetParticipant>(`${MEET_API}/${record.name}/participants`, "participants", token.token, 300, open);
  const names = new Map(participants.map((row) => [row.name, participantName(row)]));
  const started = record.startTime ? new Date(record.startTime) : input.start ?? null;
  const entries: MeetEntry[] = [];
  for (const transcript of transcripts) {
    entries.push(...(await pages<MeetEntry>(`${MEET_API}/${transcript.name}/entries`, "transcriptEntries", token.token, MAX_ENTRIES - entries.length, [...openDoc, ...open])));
    if (entries.length >= MAX_ENTRIES) break;
  }
  const ended = record.endTime ? new Date(record.endTime).getTime() : null;
  if (!entries.length) {
    const expired = ended !== null && Date.now() - ended > ENTRY_DAYS * 86_400_000;
    return problem({
      provider: "google_meet",
      code: expired ? "expired" : "no_transcript",
      title: expired ? `Google deleted this transcript's entries after ${ENTRY_DAYS} days` : "The transcript is empty",
      detail: expired ? "The transcript Doc in Drive stays. Open it, download it as .docx or .txt, and upload it here." : "Meet returned a transcript with no words in it.",
      actions: [...openDoc, uploadDoc],
    });
  }
  const lines = entries
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
    .map((entry) => ({
      speaker: names.get(entry.participant ?? "") ?? "",
      text: entry.text ?? "",
      at: started && entry.startTime ? clock((new Date(entry.startTime).getTime() - started.getTime()) / 1000) : null,
    }));
  const parsed = transcriptFromLines("google-meet", lines, {
    title,
    startedAt: started,
    durationSeconds: started && ended ? Math.round((ended - started.getTime()) / 1000) : null,
    attendees: [...new Set(participants.map(participantName).filter(Boolean))],
  });
  const event = input.eventId ? await prisma.artifact.findFirst({ where: { id: input.eventId, userId, kind: "event", deletedAt: null }, select: { id: true } }) : null;
  return saveTranscript(userId, parsed, {
    origin: "google_meet",
    externalId: record.name,
    source: "connector",
    title: input.title?.trim() || null,
    start: started,
    end: ended ? new Date(ended) : null,
    url: doc ?? input.joinUrl ?? null,
    eventArtifactId: event?.id ?? null,
    extra: { transcripts: transcripts.length, ...(doc ? { document: doc } : {}) },
  });
}
