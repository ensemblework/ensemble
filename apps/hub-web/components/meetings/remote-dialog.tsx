"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import type { ImportedMeetingNote } from "@/lib/api-connected";
import { MEETING_QUERY, meetingsApi, PROVIDER_LABEL, PROVIDER_LOGO, type MeetingProblem, type RemoteMeeting, type RemoteProvider } from "@/lib/api-meetings";
import { BrandLogo } from "../connectors/brand-logo";
import { Dialog, InfoTip, SkeletonRows, Spinner } from "../ui";
import { FetchProblem } from "./fetch-problem";
import { meetingWhen } from "./meeting-time";

const LINK_HINT: Record<RemoteProvider, string> = {
  teams: "https://teams.microsoft.com/l/meetup-join/…",
  google_meet: "https://meet.google.com/abc-defg-hij",
  zoom: "https://zoom.us/j/85012345678",
};

const ABOUT: Record<RemoteProvider, string> = {
  teams:
    "Ensemble reads a meeting's transcript through Microsoft Graph with your own sign-in, once, when you ask. Microsoft lets apps download a transcript only with the organizer's account; as an attendee you can still copy it from Teams' recap and paste it here.",
  google_meet: "Ensemble reads a call's transcript through the Google Meet API with your own sign-in, once, when you ask. Google keeps transcript entries for 30 days; after that, upload the transcript Doc from Drive.",
  zoom: "Ensemble reads cloud-recording transcripts through Zoom's API with your own sign-in, once, when you ask. Zoom makes them on paid plans when the host records to the cloud with audio transcripts on.",
};

/** Recent meetings in Teams, Google Meet or Zoom, and fetching one's transcript into Meeting notes. */
export function RemoteMeetingsDialog({
  provider,
  onClose,
  onImported,
  onPaste,
  onUpload,
  onOpenNote,
}: {
  provider: RemoteProvider;
  onClose: () => void;
  onImported: (note: ImportedMeetingNote) => void;
  onPaste: (event?: { id: string; title: string; start: string } | null) => void;
  onUpload: (event?: { id: string; title: string; start: string } | null) => void;
  onOpenNote: (id: string) => void;
}) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: MEETING_QUERY.remote(provider), queryFn: () => meetingsApi.remote(provider), staleTime: 30_000 });
  const [problems, setProblems] = useState<Record<string, MeetingProblem>>({});
  const [link, setLink] = useState("");
  const fetchOne = useMutation({
    mutationFn: (meeting: Pick<RemoteMeeting, "ref" | "eventId" | "title" | "start">) =>
      meetingsApi.fetchRemote(provider, { ref: meeting.ref, ...(meeting.eventId ? { eventId: meeting.eventId } : {}), ...(meeting.title ? { title: meeting.title } : {}), ...(meeting.start ? { start: meeting.start } : {}) }),
    onSuccess: (result, meeting) => {
      if (result.ok) {
        void client.invalidateQueries({ queryKey: MEETING_QUERY.remote(provider) });
        onImported(result.note);
        return;
      }
      setProblems((current) => ({ ...current, [meeting.ref]: result.problem }));
    },
  });
  const meetings = list.data?.meetings ?? [];
  const label = PROVIDER_LABEL[provider];
  const eventOf = (meeting: RemoteMeeting) => (meeting.eventId ? { id: meeting.eventId, title: meeting.title, start: meeting.start } : null);
  const linkProblem = problems[link.trim()];
  return (
    <Dialog open onClose={onClose} title={`From ${label}`} width={620} bodyClassName="remote-dialog">
      <div className="remote-head">
        <BrandLogo id={PROVIDER_LOGO[provider]} size={28} decorative />
        <p className="min-w-0 flex-1 text-[13px] text-muted">Pick a meeting you were in. Ensemble saves its transcript, speakers and the calendar event as a meeting note.</p>
        <InfoTip label={`How ${label} transcripts are read`} text={ABOUT[provider]} />
      </div>
      {list.isPending ? (
        <SkeletonRows count={3} />
      ) : list.isError ? (
        <div className="work-load-error" role="alert">Couldn't load your {label} meetings.<button type="button" className="btn" onClick={() => void list.refetch()}>Try again</button></div>
      ) : list.data?.problem ? (
        <FetchProblem problem={list.data.problem} onPaste={() => onPaste(null)} onUpload={() => onUpload(null)} />
      ) : (
        <>
          {meetings.length ? (
            <ul className="remote-list" aria-label={`Recent ${label} meetings`}>
              {meetings.map((meeting) => {
                const pending = fetchOne.isPending && fetchOne.variables?.ref === meeting.ref;
                const problem = problems[meeting.ref];
                return (
                  <li key={meeting.ref} className="remote-row">
                    <div className="remote-row-main">
                      <div className="min-w-0">
                        <p className="remote-title">{meeting.title}</p>
                        <p className="remote-meta">
                          <time dateTime={meeting.start}>{meetingWhen(meeting.start)}</time>
                          {meeting.organizer ? <span>· {meeting.isOrganizer ? "You organized" : `Organizer: ${meeting.organizer}`}</span> : null}
                          {meeting.hasTranscript === false ? <span>· No transcript</span> : null}
                        </p>
                      </div>
                      {meeting.noteId ? (
                        <button type="button" className="btn" onClick={() => onOpenNote(meeting.noteId!)}><Check size={14} aria-hidden />Open note</button>
                      ) : (
                        <button type="button" className="btn" disabled={fetchOne.isPending} onClick={() => fetchOne.mutate(meeting)}>
                          {pending ? <><Spinner size={13} />Fetching…</> : "Get transcript"}
                        </button>
                      )}
                    </div>
                    {problem ? <FetchProblem compact problem={problem} onPaste={() => onPaste(eventOf(meeting))} onUpload={() => onUpload(eventOf(meeting))} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty-state">No {label} meetings in the last two weeks{provider === "teams" ? " on your Outlook calendar" : ""}. Paste a meeting link below, or upload the transcript.</p>
          )}
          <form
            className="remote-link"
            onSubmit={(event) => {
              event.preventDefault();
              const ref = link.trim();
              if (ref) fetchOne.mutate({ ref, eventId: null, title: "", start: "" });
            }}
          >
            <label className="import-label" htmlFor="remote-link">Or fetch by meeting link</label>
            <div className="flex gap-2">
              <span className="remote-link-field">
                <Link2 size={14} aria-hidden />
                <input id="remote-link" type="url" inputMode="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder={LINK_HINT[provider]} />
              </span>
              <button type="submit" className="btn" disabled={!link.trim() || fetchOne.isPending}>{fetchOne.isPending && fetchOne.variables?.ref === link.trim() ? "Fetching…" : "Fetch"}</button>
            </div>
            {linkProblem ? <FetchProblem compact problem={linkProblem} onPaste={() => onPaste(null)} onUpload={() => onUpload(null)} /> : null}
          </form>
        </>
      )}
      {fetchOne.isError ? <p className="import-error" role="alert">{(fetchOne.error as Error).message}</p> : null}
    </Dialog>
  );
}
