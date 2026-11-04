import type { CalendarEvent } from "./api";
import { del, get, post } from "./api";
import { toBase64 } from "./api-files";
import type { ImportedMeetingNote } from "./api-connected";

/** Meeting transcripts: files, pastes, Teams, Google Meet and Zoom (routes/meeting-notes.ts). Docs: docs/03 §2.4. */

export type TranscriptLine = { speaker: string; text: string; at: string | null };

export type TranscriptPreview = {
  format: string;
  formatLabel: string;
  title: string | null;
  startedAt: string | null;
  durationMinutes: number | null;
  speakers: Array<{ name: string; turns: number; me: boolean; person: { id: string; name: string } | null }>;
  attendees: string[];
  lineCount: number;
  sample: TranscriptLine[];
  actionItems: number;
  decisions: number;
  suggested: boolean;
  hasSummary: boolean;
  warnings: string[];
};

export type TranscriptSource = { file: File } | { text: string };

export type RemoteProvider = "teams" | "google_meet" | "zoom";

export type MeetingSources = {
  apps: Array<{ id: RemoteProvider; label: string; connector: string; product: string | null; productLabel: string; state: "ready" | "needs_access" | "not_connected"; available: boolean; account: string | null }>;
  vendors: Array<{ id: string; label: string; connected: boolean; account: string | null; available: boolean }>;
  calendar: boolean;
  fileLimitBytes: number;
};

export type ProblemAction =
  | { kind: "connect"; label: string; connector: string; product: string | null }
  | { kind: "open"; label: string; url: string }
  | { kind: "paste"; label: string }
  | { kind: "upload"; label: string }
  | { kind: "ask_organizer"; label: string; email: string | null; subject: string; body: string };

export type MeetingProblem = { code: string; provider: RemoteProvider; title: string; detail: string; actions: ProblemAction[] };

export type RemoteMeeting = {
  ref: string;
  title: string;
  start: string;
  end: string | null;
  joinUrl: string | null;
  organizer: string | null;
  isOrganizer: boolean | null;
  hasTranscript: boolean | null;
  eventId: string | null;
  noteId: string | null;
};

export type FetchResult = { ok: true; note: ImportedMeetingNote; problem: null } | { ok: false; note: null; problem: MeetingProblem };

export const MEETING_QUERY = {
  sources: ["meeting-sources"] as const,
  remote: (provider: RemoteProvider) => ["meeting-remote", provider] as const,
  calendar: ["meeting-calendar"] as const,
  note: (id: string) => ["meeting-note", id] as const,
};

async function body(source: TranscriptSource) {
  if ("file" in source) return { filename: source.file.name, dataBase64: toBase64(new Uint8Array(await source.file.arrayBuffer())) };
  return { text: source.text };
}

const encode = encodeURIComponent;

export const meetingsApi = {
  sources: () => get<MeetingSources>("/api/meetings/sources"),
  preview: async (source: TranscriptSource) => (await post<{ preview: TranscriptPreview }>("/api/meetings/transcripts/preview", await body(source))).preview,
  importTranscript: async (source: TranscriptSource, choices: { title?: string; occurredAt?: string | null; eventId?: string | null; addPeople?: string[] }) =>
    (await post<{ note: ImportedMeetingNote }>("/api/meetings/transcripts", { ...(await body(source)), ...choices })).note,
  deleteNote: (id: string) => del<{ deleted: boolean }>(`/api/meetings/notes/${encode(id)}`),
  restoreNote: (id: string) => post<{ note: ImportedMeetingNote }>(`/api/meetings/notes/${encode(id)}/restore`),
  makeTask: (id: string, text: string, owner?: string | null) =>
    post<{ task: { id: string; title: string; status: string }; created: boolean; undoEntryId?: string | null }>(`/api/meetings/notes/${encode(id)}/tasks`, { text, ...(owner ? { owner } : {}) }),
  importVendor: (vendor: string, days = 30) => post<{ ok: boolean; items: number; proposed: number; message: string }>(`/api/meetings/vendors/${encode(vendor)}/import`, { days }),
  remote: (provider: RemoteProvider, days = 14) => get<{ meetings: RemoteMeeting[]; problem: MeetingProblem | null }>(`/api/meetings/remote/${provider}?days=${days}`),
  fetchRemote: (provider: RemoteProvider, input: { ref?: string; eventId?: string; title?: string; start?: string }) => post<FetchResult>(`/api/meetings/remote/${provider}/import`, input),
  eventTranscript: (eventId: string) => post<FetchResult>(`/api/meetings/events/${encode(eventId)}/transcript`),
  calendar: (from: string, to: string) => get<{ events: CalendarEvent[] }>(`/api/calendar?from=${encode(from)}&to=${encode(to)}`),
};

/** Which meeting app a join link belongs to; mirrors providerForUrl in hub-api connectors/meetings/remote.ts. */
export function providerForUrl(url: string | null | undefined): RemoteProvider | null {
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) return "teams";
  if (host === "meet.google.com") return "google_meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.com" || host.endsWith(".zoomgov.com")) return "zoom";
  return null;
}

export const PROVIDER_LABEL: Record<RemoteProvider, string> = { teams: "Microsoft Teams", google_meet: "Google Meet", zoom: "Zoom" };
export const PROVIDER_LOGO: Record<RemoteProvider, string> = { teams: "teams", google_meet: "googlemeet", zoom: "zoom" };
