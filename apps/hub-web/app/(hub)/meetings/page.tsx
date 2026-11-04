"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CalendarDays, ChevronLeft, ClipboardPaste, FileText, ListChecks, MessageSquare, Plus, Search, Trash2, Upload, Users, X } from "lucide-react";
import { Dialog, InfoTip, PageHeader, SkeletonRows, Spinner } from "@/components/ui";
import { MeetingNoteDetail, personHref } from "@/components/meetings/imported-notes";
import { useToast } from "@/components/toast";
import { connectedApi, type ImportedMeetingNote } from "@/lib/api-connected";
import { api, type CalendarEvent, type MeetingSessionRecord } from "@/lib/api";
import { MEETING_QUERY, meetingsApi, providerForUrl, type MeetingProblem, type RemoteProvider } from "@/lib/api-meetings";
import { LinkifiedText } from "@/components/linkified-text";
import { MeetingNotesFields } from "@/components/meetings/notes-fields";
import { confirmAction } from "@/components/ask-dialog";
import { meetingWhen, newMeetingTitle, newestFirst } from "@/components/meetings/meeting-time";
import { CalendarMeetings, useMeetingCalendar } from "@/components/meetings/calendar-meetings";
import { ImportMenu } from "@/components/meetings/import-menu";
import { TranscriptImportDialog, type ImportTarget } from "@/components/meetings/import-dialog";
import { RemoteMeetingsDialog } from "@/components/meetings/remote-dialog";
import { FetchProblem } from "@/components/meetings/fetch-problem";
import { NoteSourceMark } from "@/components/meetings/note-source";
import "@/components/meetings/meetings.css";

type Selected = { kind: "session" | "note"; id: string };
type ShelfItem =
  | { kind: "session"; id: string; title: string; at: string; row: MeetingSessionRecord }
  | { kind: "note"; id: string; title: string; at: string; row: ImportedMeetingNote };

const ABOUT =
  "A meeting note is a page that knows its meeting: the calendar event, the people in it, the whole transcript (by speaker and time, searchable), and the decisions and action items you can turn into tasks. Take notes as it happens, or bring a meeting in from a transcript file, Teams, Google Meet, Zoom or a meeting-notes app.";

const ADMIN = /AADSTS(65001|90094|90008)|admin|approv|consent/i;
/** Until /api/meetings/sources answers; the API's limit is TRANSCRIPT_FILE_MAX_BYTES. */
const TEN_MB = 10 * 1024 * 1024;

function noteSnippet(note: ImportedMeetingNote): string {
  if (note.summary.trim()) return note.summary.replace(/[#*_>`-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const speakers = note.speakers ?? [];
  if (speakers.length) return `${speakers.slice(0, 3).join(", ")}${speakers.length > 3 ? ` +${speakers.length - 3}` : ""}`;
  return note.sourceLabel;
}

function noteFooter(note: ImportedMeetingNote): string {
  const parts = [note.lineCount ? `${note.lineCount.toLocaleString()} turns` : "", note.durationMinutes ? `${note.durationMinutes} min` : "", note.actionItems.length ? `${note.actionItems.length} action ${note.actionItems.length === 1 ? "item" : "items"}` : ""];
  return parts.filter(Boolean).join(" · ") || note.sourceLabel;
}

function Welcome({ onUpload, onPaste, onStart, starting }: { onUpload: () => void; onPaste: () => void; onStart: (event: React.MouseEvent) => void; starting: boolean }) {
  return (
    <section className="meetings-welcome" aria-labelledby="meetings-welcome-title">
      <h2 id="meetings-welcome-title">Every meeting, with its notes, transcript and next steps</h2>
      <ul className="meetings-welcome-points">
        <li><CalendarDays size={16} aria-hidden /><span><b>Tied to the meeting.</b> The calendar event and the people in it come along.</span></li>
        <li><FileText size={16} aria-hidden /><span><b>The whole transcript.</b> By speaker and time, and searchable.</span></li>
        <li><ListChecks size={16} aria-hidden /><span><b>Next steps that stick.</b> Action items become tasks in one click.</span></li>
      </ul>
      <div className="meetings-welcome-actions">
        <button type="button" className="btn-primary" onClick={onUpload}><Upload size={14} aria-hidden />Upload a transcript</button>
        <button type="button" className="btn" onClick={onPaste}><ClipboardPaste size={14} aria-hidden />Paste from Teams</button>
        <button type="button" className="btn" onClick={onStart} disabled={starting}><Plus size={14} aria-hidden />Start notes</button>
      </div>
      <p className="meetings-welcome-formats">Teams, Zoom, Google Meet, Otter, Fireflies and tl;dv transcripts · .vtt .srt .docx .txt .json</p>
    </section>
  );
}

/** What a page doesn't have: the calendar event these notes are for, and the people in it. */
function SessionProps({
  linked,
  event,
  people,
  transcript,
}: {
  linked: boolean;
  event: CalendarEvent | undefined;
  people: Array<{ id: string; name: string }>;
  transcript: { noteId: string | null; fetchable: boolean; pending: boolean; onFetch: () => void; onOpen: (id: string) => void };
}) {
  return (
    <dl className="note-props session-props">
      <div>
        <dt><CalendarDays size={14} aria-hidden />Meeting</dt>
        <dd className="session-event">
          {event ? (
            <span>{event.title || "Meeting"} · <time dateTime={event.start}>{meetingWhen(event.start)}</time></span>
          ) : linked ? (
            <span>Linked to a calendar event</span>
          ) : (
            <span className="text-faint">Not linked to a calendar event</span>
          )}
          {transcript.noteId ? (
            <button type="button" className="btn-ghost session-event-action" onClick={() => transcript.onOpen(transcript.noteId!)}><FileText size={13} aria-hidden />Open transcript</button>
          ) : transcript.fetchable ? (
            <button type="button" className="btn-ghost session-event-action" disabled={transcript.pending} onClick={transcript.onFetch}>
              {transcript.pending ? <Spinner size={12} /> : <FileText size={13} aria-hidden />}Get transcript
            </button>
          ) : null}
        </dd>
      </div>
      <div>
        <dt><Users size={14} aria-hidden />People</dt>
        <dd className="note-people">
          {people.length ? people.map((person) => <Link key={person.id} href={personHref(person.name)} className="note-person" data-linked>{person.name}</Link>) : <span className="text-faint">No one from People</span>}
        </dd>
      </div>
    </dl>
  );
}

function MeetingsBody() {
  const params = useSearchParams();
  const selectedSession = params.get("session");
  const selectedNote = params.get("note");
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions });
  const imported = useQuery({ queryKey: ["meetings-imported"], queryFn: connectedApi.importedMeetings });
  const sources = useQuery({ queryKey: MEETING_QUERY.sources, queryFn: meetingsApi.sources, staleTime: 60_000 });
  const calendar = useMeetingCalendar();
  const initial: Selected | null = selectedSession ? { kind: "session", id: selectedSession } : selectedNote ? { kind: "note", id: selectedNote } : null;
  const [active, setActive] = useState<Selected | null>(initial);
  const [reading, setReading] = useState(Boolean(initial));
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<ImportTarget | null>(null);
  const [remote, setRemote] = useState<RemoteProvider | null>(null);
  const [eventProblem, setEventProblem] = useState<{ event: CalendarEvent; problem: MeetingProblem } | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const autoSelected = useRef(false);

  const choose = (next: Selected | null) => {
    setActive(next);
    setReading(Boolean(next));
    router.replace(next ? `/meetings?${next.kind}=${encodeURIComponent(next.id)}` : "/meetings", { scroll: false });
  };

  useEffect(() => {
    if (selectedSession) { setActive({ kind: "session", id: selectedSession }); setReading(true); }
    else if (selectedNote) { setActive({ kind: "note", id: selectedNote }); setReading(true); }
    else setReading(false);
  }, [selectedSession, selectedNote]);

  // Back from a connector's sign-in: say how it went, then tidy the address.
  useEffect(() => {
    const error = params.get("connectError");
    const connected = params.get("connected");
    if (!error && !connected) return;
    if (error) setConnectNotice(error);
    if (connected) toast(`${connected === "microsoft" ? "Microsoft 365" : connected === "google" ? "Google Workspace" : connected === "zoom" ? "Zoom" : connected} connected.`);
    void client.invalidateQueries({ queryKey: MEETING_QUERY.sources });
    router.replace("/meetings", { scroll: false });
  }, [params, client, router, toast]);

  const sessionId = active?.kind === "session" ? active.id : "";
  const detail = useQuery({ queryKey: ["meeting-session", sessionId], queryFn: () => api.meetingSession(sessionId), enabled: Boolean(sessionId) });

  const starting = useRef(false);
  const start = useMutation({
    mutationFn: (event?: CalendarEvent) => api.startMeeting(event?.id ?? null, event?.title || newMeetingTitle()),
    onSuccess: (result) => {
      choose({ kind: "session", id: result.session.id });
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
    onSettled: () => { starting.current = false; },
  });
  // The second click of a double click (detail 2) is not a second note. The ref covers the tick
  // before isPending renders the button disabled.
  const startNotes = (event: React.MouseEvent, calendarEvent?: CalendarEvent) => {
    if (event.detail > 1 || starting.current) return;
    starting.current = true;
    start.mutate(calendarEvent);
  };
  const end = useMutation({
    mutationFn: () => api.endMeeting(sessionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["meeting-session", sessionId] });
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const attach = useMutation({
    mutationFn: () => api.attachMeeting(sessionId),
    onSuccess: (result) => {
      toast(result.message);
      void client.invalidateQueries({ queryKey: ["meeting-session", sessionId] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const decline = useMutation({
    mutationFn: () => api.declineMeeting(sessionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["meeting-session", sessionId] }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const trash = useMutation({
    mutationFn: (id: string) => api.deleteMeeting(id),
    onSuccess: (_, id) => {
      if (active?.kind === "session" && id === active.id) choose(null);
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
      toast("Meeting notes moved to Trash.", {
        action: {
          label: "Undo",
          run: () => {
            void api.restoreDeleted({ kind: "meeting", id }).then(() => client.invalidateQueries({ queryKey: ["meeting-sessions"] })).catch((error: Error) => toast(error.message, { tone: "error" }));
          },
        },
      });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const removeNote = useMutation({
    mutationFn: (id: string) => meetingsApi.deleteNote(id),
    onSuccess: (_, id) => {
      if (active?.kind === "note" && id === active.id) choose(null);
      void client.invalidateQueries({ queryKey: ["meetings-imported"] });
      toast("Meeting deleted.", {
        action: {
          label: "Undo",
          run: () => {
            void meetingsApi.restoreNote(id).then(() => client.invalidateQueries({ queryKey: ["meetings-imported"] })).catch((error: Error) => toast(error.message, { tone: "error" }));
          },
        },
      });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const transcriptFor = useMutation({
    mutationFn: (event: CalendarEvent) => meetingsApi.eventTranscript(event.id),
    onSuccess: (result, event) => {
      if (result.ok) {
        void client.invalidateQueries({ queryKey: ["meetings-imported"] });
        toast(`Imported the transcript of “${result.note.title}”.`);
        choose({ kind: "note", id: result.note.id });
        return;
      }
      setEventProblem({ event, problem: result.problem });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const removeSession = async (row: { id: string; title: string }) => {
    if (!(await confirmAction({ title: `Delete “${row.title}”?`, body: "Move these notes to Trash? You can restore them until the retention period expires.", confirm: "Move to Trash", danger: true }))) return;
    trash.mutate(row.id);
  };
  const deleteNote = async (row: { id: string; title: string }) => {
    if (!(await confirmAction({ title: `Delete “${row.title}”?`, body: "Its transcript, decisions and action items go too. Tasks you made from it stay. Importing it again brings it back.", confirm: "Delete meeting", danger: true }))) return;
    removeNote.mutate(row.id);
  };
  const showImported = (note: ImportedMeetingNote) => {
    setDialog(null);
    setRemote(null);
    setEventProblem(null);
    void client.invalidateQueries({ queryKey: ["meetings-imported"] });
    client.setQueryData<{ notes: ImportedMeetingNote[] }>(["meetings-imported"], (cached) => (cached ? { notes: [note, ...cached.notes.filter((row) => row.id !== note.id)] } : cached));
    choose({ kind: "note", id: note.id });
  };

  const session = active?.kind === "session" ? detail.data?.session : undefined;
  const sessionEvent = session?.artifactId ? calendar.data?.events.find((row) => row.id === session.artifactId) : undefined;
  const sessionPeople = (detail.data?.attendees ?? []).filter((person) => person.name && person.name !== person.id);
  const sessions = useMemo(() => newestFirst(list.data?.sessions ?? []), [list.data]);
  const importedNotes = useMemo(() => imported.data?.notes ?? [], [imported.data]);
  const shelf = useMemo<ShelfItem[]>(
    () =>
      [
        ...sessions.map((row) => ({ kind: "session" as const, id: row.id, title: row.title, at: row.startedAt, row })),
        ...importedNotes.map((row) => ({ kind: "note" as const, id: row.id, title: row.title, at: row.occurredAt, row })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [sessions, importedNotes],
  );
  const wanted = search.trim().toLowerCase();
  const visible = shelf.filter((item) =>
    !wanted || `${item.title} ${item.kind === "session" ? item.row.notes : `${item.row.summary} ${item.row.sourceLabel} ${(item.row.speakers ?? []).join(" ")}`}`.toLowerCase().includes(wanted),
  );
  const loaded = list.isSuccess && imported.isSuccess;
  const empty = loaded && shelf.length === 0;
  useEffect(() => {
    if (autoSelected.current || !loaded) return;
    autoSelected.current = true;
    if (!active && shelf[0]) setActive({ kind: shelf[0].kind, id: shelf[0].id });
  }, [active, shelf, loaded]);
  const note = active?.kind === "note" ? importedNotes.find((row) => row.id === active.id) : undefined;
  const fileLimit = sources.data?.fileLimitBytes ?? TEN_MB;
  const eventOf = (event: CalendarEvent) => ({ id: event.id, title: event.title, start: event.start });
  const linked = (eventId: string) => ({
    sessionId: sessions.find((row) => row.artifactId === eventId)?.id ?? null,
    noteId: importedNotes.find((row) => row.event?.id === eventId)?.id ?? null,
  });

  return (
    <div className="page-read meeting-workspace mx-auto max-w-[1120px] px-6 pb-24 pt-8">
      <PageHeader
        title="Meeting notes"
        description={<span className="inline-flex items-center gap-1">Notes, transcripts and next steps for every meeting.<InfoTip label="What meeting notes add" text={ABOUT} /></span>}
        actions={
          <>
            <ImportMenu sources={sources.data} onUpload={() => setDialog({ mode: "upload" })} onPaste={() => setDialog({ mode: "paste" })} onRemote={setRemote} />
            <button type="button" className="btn-primary" disabled={start.isPending} onClick={(event) => startNotes(event)}><Plus size={14} aria-hidden />New notes</button>
          </>
        }
      />
      {connectNotice ? (
        <div className="meetings-notice" role="alert">
          <AlertCircle size={16} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{ADMIN.test(connectNotice) ? "Your organization needs an admin to approve Ensemble" : "Sign-in didn't finish"}</p>
            <p className="text-muted">
              {ADMIN.test(connectNotice)
                ? "Microsoft asks a Microsoft 365 admin to approve “Read all transcripts of online meetings” for Ensemble once. Ask your IT admin, then turn it on again. Until then, paste transcripts from Teams."
                : connectNotice}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => setDialog({ mode: "paste", guide: "teams" })}><ClipboardPaste size={14} aria-hidden />Paste from Teams</button>
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setConnectNotice(null)}><X size={14} /></button>
        </div>
      ) : null}
      <CalendarMeetings
        linked={linked}
        onTakeNotes={(event) => { if (!starting.current) { starting.current = true; start.mutate(event); } }}
        onOpenSession={(id) => choose({ kind: "session", id })}
        onOpenNote={(id) => choose({ kind: "note", id })}
        onTranscript={(event) => transcriptFor.mutate(event)}
        starting={start.isPending ? start.variables?.id ?? null : null}
        fetching={transcriptFor.isPending ? transcriptFor.variables?.id ?? null : null}
      />
      {list.isError || imported.isError ? (
        <div className="work-load-error" role="alert">Couldn't load your meetings.<button type="button" className="btn" onClick={() => { void list.refetch(); void imported.refetch(); }}>Try again</button></div>
      ) : null}
      {!loaded && !list.isError ? (
        <SkeletonRows count={3} />
      ) : empty && !session ? (
        <Welcome onUpload={() => setDialog({ mode: "upload" })} onPaste={() => setDialog({ mode: "paste", guide: "teams" })} onStart={(event) => startNotes(event)} starting={start.isPending} />
      ) : loaded ? (
        <div data-reading={reading} className="meeting-library grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
          {reading ? <button type="button" className="btn md:hidden" onClick={() => setReading(false)}><ChevronLeft size={14} />All meetings</button> : null}
          <div className="meeting-shelf-panel min-w-0">
            <label className="meeting-search">
              <Search size={14} aria-hidden />
              <input aria-label="Search meetings" placeholder="Search meetings…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <ul className="meeting-shelf">
              {visible.map((item) => {
                const selected = active?.kind === item.kind && active.id === item.id;
                return (
                  <li key={`${item.kind}:${item.id}`} className="meeting-shelf-item">
                    <button type="button" className="meeting-note-card" data-active={selected || undefined} aria-pressed={selected} onClick={() => choose({ kind: item.kind, id: item.id })}>
                      {item.kind === "session" ? (
                        <>
                          <span className="meeting-card-meta"><MessageSquare size={14} aria-hidden /><time dateTime={item.at}>{meetingWhen(item.at)}</time><i data-active={item.row.status !== "ended"}>{item.row.status !== "ended" ? "In progress" : "Notes"}</i></span>
                          <strong>{item.title}</strong>
                          <p>{item.row.notes.trim().slice(0, 110) || "A fresh page for this conversation."}</p>
                          <span className="meeting-card-footer">{item.row.recap?.trim() ? "Recap ready" : item.row.artifactId ? "Linked to the calendar" : "Written in Ensemble"}</span>
                        </>
                      ) : (
                        <>
                          <span className="meeting-card-meta"><NoteSourceMark source={item.row.source} label={item.row.sourceLabel} /><time dateTime={item.at}>{meetingWhen(item.at)}</time><i>{item.row.source === "transcript" ? "Transcript" : item.row.sourceLabel}</i></span>
                          <strong>{item.title}</strong>
                          <p>{noteSnippet(item.row)}</p>
                          <span className="meeting-card-footer">{noteFooter(item.row)}</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="meeting-card-delete"
                      aria-label={`Delete “${item.title}”`}
                      title={item.kind === "session" ? "Move to Trash" : "Delete"}
                      disabled={trash.isPending || removeNote.isPending}
                      onClick={() => void (item.kind === "session" ? removeSession(item) : deleteNote(item))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                );
              })}
              {!visible.length ? <li className="work-quiet-state">No meetings match “{search.trim()}”.</li> : null}
            </ul>
          </div>
          {note ? (
            <article className="meeting-paper" data-meeting-id={note.id}>
              <MeetingNoteDetail key={note.id} note={note} onDelete={(row) => void deleteNote(row)} />
            </article>
          ) : active?.kind === "note" ? (
            <p className="text-[13px] text-muted">That meeting isn't here any more. Pick another one.</p>
          ) : detail.isError ? (
            <div className="work-load-error" role="alert">Couldn't open this meeting.<button type="button" className="btn" onClick={() => void detail.refetch()}>Try again</button></div>
          ) : detail.isPending && sessionId ? (
            <SkeletonRows count={4} />
          ) : session ? (
            <article className="meeting-paper" data-meeting-id={session.id}>
              <div className="meeting-paper-kicker"><MessageSquare size={13} aria-hidden /><time dateTime={session.startedAt}>{meetingWhen(session.startedAt)}</time><span>{session.status !== "ended" ? "In progress" : "Meeting ended"}</span></div>
              <MeetingNotesFields
                key={session.id}
                session={session}
                onRemoved={() => choose(null)}
                details={
                  <SessionProps
                    linked={Boolean(session.artifactId)}
                    event={sessionEvent}
                    people={sessionPeople}
                    transcript={{
                      noteId: sessionEvent ? linked(sessionEvent.id).noteId : null,
                      fetchable: Boolean(sessionEvent && providerForUrl(sessionEvent.joinUrl) && new Date(sessionEvent.start).getTime() < Date.now()),
                      pending: transcriptFor.isPending,
                      onFetch: () => { if (sessionEvent) transcriptFor.mutate(sessionEvent); },
                      onOpen: (id) => choose({ kind: "note", id }),
                    }}
                  />
                }
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {session.status !== "ended" ? (
                  <button type="button" className="btn" disabled={end.isPending} onClick={() => end.mutate()}>
                    End meeting
                  </button>
                ) : null}
              </div>
              {session.attachState === "pending" ? (
                <div className="mt-4 rounded-lg border border-line px-3 py-2">
                  <p className="text-[13.5px]">Attach these notes to the calendar event?</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="btn" onClick={() => attach.mutate()}>
                      Attach
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => decline.mutate()}>
                      Keep in Meeting notes
                    </button>
                  </div>
                </div>
              ) : null}
              {session.recap ? (
                <section className="meeting-recap mt-5">
                  <h3 className="text-[13px] font-semibold">Recap</h3>
                  <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-6"><LinkifiedText text={session.recap} /></p>
                </section>
              ) : null}
              {detail.data?.openTasks.length ? (
                <section className="meeting-actions mt-4">
                  <h3 className="text-[13px] font-semibold">Open tasks</h3>
                  <ul className="meeting-action-list mt-1 space-y-1 text-[13px]">
                    {detail.data.openTasks.map((task) => (
                      <li key={task.id}>
                        <Link href={task.href} className="hover:underline">
                          {task.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </article>
          ) : (
            <p className="text-[13px] text-muted">Pick a meeting, or start notes for one that is not on the calendar.</p>
          )}
        </div>
      ) : null}
      {dialog ? <TranscriptImportDialog target={dialog} fileLimit={fileLimit} onClose={() => setDialog(null)} onImported={showImported} /> : null}
      {remote ? (
        <RemoteMeetingsDialog
          provider={remote}
          onClose={() => setRemote(null)}
          onImported={showImported}
          onPaste={(event) => { const guide = remote === "teams" ? "teams" : null; setRemote(null); setDialog({ mode: "paste", event, guide }); }}
          onUpload={(event) => { setRemote(null); setDialog({ mode: "upload", event }); }}
          onOpenNote={(id) => { setRemote(null); choose({ kind: "note", id }); }}
        />
      ) : null}
      {eventProblem ? (
        <Dialog open onClose={() => setEventProblem(null)} title={`Transcript for “${eventProblem.event.title}”`} width={560}>
          <FetchProblem
            problem={eventProblem.problem}
            onPaste={() => { const { event } = eventProblem; setEventProblem(null); setDialog({ mode: "paste", event: eventOf(event), guide: providerForUrl(event.joinUrl) === "teams" ? "teams" : null }); }}
            onUpload={() => { const { event } = eventProblem; setEventProblem(null); setDialog({ mode: "upload", event: eventOf(event) }); }}
          />
        </Dialog>
      ) : null}
    </div>
  );
}

export default function MeetingsPage() {
  return (
    <Suspense fallback={null}>
      <MeetingsBody />
    </Suspense>
  );
}
