/**
 * Fetching one meeting's transcript from the app the meeting ran in (docs/03 §2.4): Microsoft
 * Teams (teams.ts), Google Meet (google-meet.ts) and Zoom (zoom.ts). Each says plainly why a
 * transcript cannot be read (not connected, access not approved, not the organizer, nothing
 * recorded) and what the person can do instead, as a `MeetingProblem`.
 */
import { prisma } from "../../lib/prisma.js";
import type { AccountProvider } from "../accounts.js";
import { missingScopes, providerAccessToken, type ProviderToken } from "../tokens.js";

export const REMOTE_PROVIDERS = ["teams", "google_meet", "zoom"] as const;
export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];

export const REMOTE: Record<RemoteProvider, { label: string; provider: AccountProvider; connector: string; product: string | null; productLabel: string }> = {
  teams: { label: "Microsoft Teams", provider: "microsoft", connector: "microsoft_365", product: "teams_meetings", productLabel: "Teams meeting transcripts" },
  google_meet: { label: "Google Meet", provider: "google", connector: "google_workspace", product: "meet", productLabel: "Google Meet transcripts" },
  zoom: { label: "Zoom", provider: "zoom", connector: "zoom", product: null, productLabel: "Zoom" },
};

export type ProblemAction =
  | { kind: "connect"; label: string; connector: string; product: string | null }
  | { kind: "open"; label: string; url: string }
  | { kind: "paste"; label: string }
  | { kind: "upload"; label: string }
  | { kind: "ask_organizer"; label: string; email: string | null; subject: string; body: string };

export type ProblemCode =
  | "not_connected"
  | "needs_access"
  | "admin_blocked"
  | "personal_account"
  | "not_found"
  | "not_organizer"
  | "no_transcript"
  | "recording_only"
  | "processing"
  | "expired"
  | "app_not_set_up"
  | "unavailable";

export interface MeetingProblem {
  code: ProblemCode;
  provider: RemoteProvider;
  title: string;
  detail: string;
  actions: ProblemAction[];
}

export class MeetingFetchProblem extends Error {
  constructor(readonly problem: MeetingProblem) {
    super(problem.detail);
  }
}

export const problem = (value: MeetingProblem): never => {
  throw new MeetingFetchProblem(value);
};

export const connectAction = (provider: RemoteProvider, label?: string): ProblemAction => ({
  kind: "connect",
  label: label ?? `Connect ${REMOTE[provider].label}`,
  connector: REMOTE[provider].connector,
  product: REMOTE[provider].product,
});

export const openAction = (url: string | null | undefined, label: string): ProblemAction[] => (url && /^https:\/\//.test(url) ? [{ kind: "open", label, url }] : []);

export function askOrganizer(organizer: { name?: string | null; email?: string | null } | null, title: string, app: string): ProblemAction {
  const who = organizer?.name?.split(/\s+/)[0] || "there";
  return {
    kind: "ask_organizer",
    label: organizer?.name ? `Ask ${organizer.name.split(/\s+/)[0]} to share it` : "Ask the organizer to share it",
    email: organizer?.email ?? null,
    subject: `Transcript of “${title}”`,
    body: `Hi ${who},\n\nCould you share the transcript of “${title}”? In ${app}, open the meeting's recap, then download the transcript (.vtt or .docx) and send it to me.\n\nThanks!`,
  };
}

/** A fresh token with the access this provider's transcripts need, or the problem to show instead. */
export async function remoteToken(userId: string, provider: RemoteProvider, scopes: readonly string[]): Promise<ProviderToken> {
  const spec = REMOTE[provider];
  let token: ProviderToken | null;
  try {
    token = await providerAccessToken(userId, spec.provider);
  } catch {
    token = null;
  }
  if (!token) {
    return problem({
      provider,
      code: "not_connected",
      title: `Connect ${spec.label} first`,
      detail: `Ensemble reads ${spec.label} transcripts with your own sign-in. Connect it once, then fetch any meeting you were in.`,
      actions: [connectAction(provider), { kind: "upload", label: "Upload a transcript file instead" }],
    });
  }
  if (missingScopes(token, scopes).length) {
    return problem({
      provider,
      code: "needs_access",
      title: `Allow Ensemble to read ${spec.productLabel.toLowerCase()}`,
      detail:
        provider === "teams"
          ? "Turn on Teams meeting transcripts and approve the new access. Many organizations ask an admin to approve “Read all transcripts of online meetings” for Ensemble once; Microsoft shows that request when you sign in."
          : `Turn on ${spec.productLabel} and approve the new access when ${provider === "google_meet" ? "Google" : spec.label} asks.`,
      actions: [connectAction(provider, "Turn on and approve"), { kind: "paste", label: "Paste the transcript instead" }],
    });
  }
  return token;
}

/** Notes already imported from this provider, by its meeting id. */
export async function importedIds(userId: string, provider: RemoteProvider, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.meetingNote.findMany({ where: { userId, externalSource: provider, externalId: { in: [...ids] }, deletedAt: null }, select: { id: true, externalId: true } });
  return new Map(rows.map((row) => [row.externalId!, row.id]));
}

/** Calendar events in the window whose join link is this provider's. */
export async function storedOnlineEvents(userId: string, provider: RemoteProvider, from: Date, to: Date) {
  const rows = await prisma.artifact.findMany({
    where: { userId, kind: "event", deletedAt: null, ts: { gte: from, lt: to } },
    select: { id: true, title: true, ts: true, url: true, metadata: true, participants: true },
    orderBy: { ts: "desc" },
    take: 200,
  });
  return rows
    .map((row) => {
      const meta = (row.metadata ?? {}) as { joinUrl?: unknown; end?: unknown; organizer?: unknown };
      const joinUrl = typeof meta.joinUrl === "string" ? meta.joinUrl : null;
      return { ...row, joinUrl, end: typeof meta.end === "string" ? meta.end : null, organizer: typeof meta.organizer === "string" ? meta.organizer : null };
    })
    .filter((row) => row.joinUrl && providerForUrl(row.joinUrl) === provider);
}

/** Which app a meeting link belongs to. */
export function providerForUrl(url: string | null | undefined): RemoteProvider | null {
  if (!url) return null;
  let host: string;
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

/** One meeting a provider can fetch, as the import dialog lists it. */
export interface RemoteMeeting {
  /** What the import call sends back: a join link (Teams), a conference record (Meet), a meeting uuid (Zoom). */
  ref: string;
  title: string;
  start: string;
  end: string | null;
  joinUrl: string | null;
  organizer: string | null;
  isOrganizer: boolean | null;
  /** A transcript is known to exist (Zoom, Meet); null when only fetching will tell (Teams). */
  hasTranscript: boolean | null;
  eventId: string | null;
  noteId: string | null;
}

/** An error body from a Google or Microsoft API: code, status and message, whatever the nesting. */
export async function errorBody(response: Response): Promise<{ code: string; message: string; inner: string }> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = ((body && typeof body === "object" ? (body as { error?: unknown }).error : null) ?? body ?? {}) as Record<string, unknown>;
  const inner = (error.innerError ?? error.innererror ?? {}) as Record<string, unknown>;
  const details = Array.isArray(error.details) ? (error.details as Array<Record<string, unknown>>) : [];
  return {
    code: String(error.code ?? error.status ?? ""),
    message: String(error.message ?? (body && typeof body === "object" ? (body as { message?: unknown }).message ?? "" : "")),
    inner: String(inner.code ?? details.map((row) => row.reason ?? "").find(Boolean) ?? ""),
  };
}

export async function getJson<T>(url: string, token: string, init: { accept?: string; timeoutMs?: number } = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; body: Awaited<ReturnType<typeof errorBody>> }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: init.accept ?? "application/json" }, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  } catch (error) {
    return { ok: false, status: 0, body: { code: "network", message: error instanceof Error ? error.message : String(error), inner: "" } };
  }
  if (!response.ok) return { ok: false, status: response.status, body: await errorBody(response) };
  if ((init.accept ?? "application/json").startsWith("application/json")) return { ok: true, data: (await response.json()) as T };
  return { ok: true, data: (await response.text()) as T };
}

export function unavailable(provider: RemoteProvider, status: number, message: string, actions: ProblemAction[] = [{ kind: "paste", label: "Paste the transcript instead" }]): never {
  const label = REMOTE[provider].label;
  return problem({
    provider,
    code: "unavailable",
    title: status === 429 ? `${label} asked Ensemble to slow down` : `${label} didn't answer`,
    detail: status === 429 ? "Try again in a minute." : status === 0 ? `Ensemble couldn't reach ${label}. Try again in a moment.` : `${label} answered ${status}${message ? `: ${message.slice(0, 200)}` : ""}.`,
    actions,
  });
}
