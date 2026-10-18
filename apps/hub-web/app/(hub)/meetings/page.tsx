"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { MeetingNoteDetail } from "@/components/meetings/imported-notes";
import { useToast } from "@/components/toast";
import { connectedApi } from "@/lib/api-connected";
import { api } from "@/lib/api";
import { LinkifiedText } from "@/components/linkified-text";
import { MeetingNotesFields } from "@/components/meetings/notes-fields";
import { ChevronLeft, MessageSquare, Plus, Search } from "lucide-react";
import { meetingWhen, newMeetingTitle, newestFirst } from "@/components/meetings/meeting-time";

function MeetingsBody() {
  const params = useSearchParams();
  const selected = params.get("session");
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions });
  const imported = useQuery({ queryKey: ["meetings-imported"], queryFn: connectedApi.importedMeetings });
  const [active, setActive] = useState(selected ?? "");
  const [reading, setReading] = useState(Boolean(selected));
  const [importedId, setImportedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const autoSelected = useRef(false);
  const choose = (id: string) => { setImportedId(null); setActive(id); setReading(Boolean(id)); router.replace(id ? `/meetings?session=${encodeURIComponent(id)}` : "/meetings", { scroll: false }); };

  useEffect(() => {
    if (selected) { setActive(selected); setReading(true); }
    else setReading(false);
  }, [selected]);
  const detail = useQuery({
    queryKey: ["meeting-session", active],
    queryFn: () => api.meetingSession(active),
    enabled: Boolean(active),
  });

  const starting = useRef(false);
  const start = useMutation({
    mutationFn: () => api.startMeeting(null, newMeetingTitle()),
    onSuccess: (result) => {
      choose(result.session.id);
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
    onSettled: () => { starting.current = false; },
  });
  // The second click of a double click (detail 2) is not a second note. The ref covers the tick
  // before isPending renders the button disabled.
  const startNotes = (event: React.MouseEvent) => {
    if (event.detail > 1 || starting.current) return;
    starting.current = true;
    start.mutate();
  };
  const end = useMutation({
    mutationFn: () => api.endMeeting(active),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["meeting-session", active] });
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const attach = useMutation({
    mutationFn: () => api.attachMeeting(active),
    onSuccess: (result) => {
      toast(result.message);
      void client.invalidateQueries({ queryKey: ["meeting-session", active] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const decline = useMutation({
    mutationFn: () => api.declineMeeting(active),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["meeting-session", active] }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const session = detail.data?.session;
  const sessions = useMemo(() => newestFirst(list.data?.sessions ?? []), [list.data]);
  const importedNotes = imported.data?.notes ?? [];
  const visible = sessions.filter((s) => `${s.title} ${s.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { if (!autoSelected.current && list.isSuccess) { autoSelected.current = true; if (!active && !selected && sessions[0]) setActive(sessions[0].id); } }, [active, selected, sessions, list.isSuccess]);

  return (
    <div className="page-read meeting-workspace mx-auto max-w-[1120px] px-6 pb-24 pt-8">
      <PageHeader
        title="Meeting notes"
        description="Conversations become context. Keep the notes, decisions, and next steps together."
      />
      {list.isError && <div className="work-load-error" role="alert">Couldn't load your meeting library.<button type="button" className="btn" onClick={() => void list.refetch()}>Try again</button></div>}
      {list.isLoading && !list.data ? (
        <SkeletonRows count={3} />
      ) : !list.isError && sessions.length === 0 && !importedNotes.length && !session ? (
        <div className="empty-panel">
          <h2 className="text-[18px] font-semibold">A page for your next conversation</h2>
          <p className="mt-1 max-w-[42ch] text-[14px] leading-5 text-muted">Start a page for the meeting you are in. The notes stay here, and you can ask across them later.</p>
          <button type="button" className="btn-primary mt-4" onClick={startNotes} disabled={start.isPending}>
            Start notes
          </button>
        </div>
      ) : null}
      <div data-reading={reading} className={sessions.length === 0 && !importedNotes.length && !session ? "hidden" : "meeting-library grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]"}>
        {reading && <button type="button" className="btn md:hidden" onClick={() => setReading(false)}><ChevronLeft size={14} />Back to notes</button>}
        <div className="meeting-shelf-panel min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2"><label className="flex min-w-0 max-w-[190px] items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5"><Search size={14} /><input className="min-w-0 w-full bg-transparent text-[12px] outline-none" aria-label="Search meeting notes" placeholder="Find notes…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><button type="button" className="btn shrink-0" disabled={start.isPending} onClick={startNotes}><Plus size={13} />New notes</button></div>
        <ul className="meeting-shelf">
          {sessions.length === 0 ? <li className="text-[13px] text-muted">No meeting notes yet.</li> : null}
          {visible.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="meeting-note-card"
                data-active={row.id === active || undefined}
                aria-pressed={row.id === active}
                onClick={() => choose(row.id)}
              >
                <span className="meeting-card-meta"><MessageSquare size={14} /><time dateTime={row.startedAt}>{meetingWhen(row.startedAt)}</time><i data-active={row.status !== "ended"}>{row.status !== "ended" ? "In progress" : "Ended"}</i></span>
                <strong>{row.title}</strong>
                <p>{row.notes.trim().slice(0, 110) || "A fresh page for this conversation."}</p>
                <span className="meeting-card-footer">{row.recap?.trim() ? "Recap ready" : "Meeting notes"}</span>
              </button>
            </li>
          ))}
          {!visible.length && sessions.length > 0 && <li className="work-quiet-state">No notes match this view.</li>}
          {importedNotes.filter(note => `${note.title} ${note.summary}`.toLowerCase().includes(search.trim().toLowerCase())).map(note => <li key={note.id}><button type="button" className="meeting-note-card" data-active={importedId === note.id || undefined} aria-pressed={importedId === note.id} onClick={() => { setImportedId(note.id); setReading(true); }}><span className="meeting-card-meta">{note.sourceLabel} · {meetingWhen(note.occurredAt)}</span><strong>{note.title}</strong><p>{note.summary?.slice(0, 110)}</p></button></li>)}
        </ul>
        {imported.isError ? <div role="alert" className="work-load-error">Couldn’t load imported notes.<button className="btn" onClick={() => void imported.refetch()}>Retry</button></div> : null}
        </div>
        {importedId && importedNotes.find(note => note.id === importedId) ? <article className="meeting-paper" data-meeting-id={importedId}><h2 className="text-[28px] font-semibold">{importedNotes.find(note => note.id === importedId)!.title}</h2><MeetingNoteDetail note={importedNotes.find(note => note.id === importedId)!} /></article> : detail.isError ? <div className="work-load-error" role="alert">Couldn't open this meeting.<button type="button" className="btn" onClick={() => void detail.refetch()}>Try again</button></div> : detail.isPending && active ? <SkeletonRows count={4} /> : session ? (
          <article className="meeting-paper" data-meeting-id={session.id}>
            <div className="meeting-paper-kicker"><MessageSquare size={13} /><time dateTime={session.startedAt}>{meetingWhen(session.startedAt)}</time><span>{session.status !== "ended" ? "In progress" : "Meeting ended"}</span></div>
            <MeetingNotesFields key={session.id} session={session} onRemoved={() => choose("")} />
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
