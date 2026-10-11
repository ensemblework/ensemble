"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { ImportedMeetingNotes } from "@/components/meetings/imported-notes";
import { useToast } from "@/components/toast";
import { connectedApi } from "@/lib/api-connected";
import { api } from "@/lib/api";
import { MeetingNotesFields } from "@/components/meetings/notes-fields";
import { ArrowUpRight, BookOpen, Clock3, FileText, MessageSquare, Plus, Search } from "lucide-react";
import { whenLabel } from "@/lib/format";

function MeetingsBody() {
  const params = useSearchParams();
  const selected = params.get("session");
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions });
  const imported = useQuery({ queryKey: ["meetings-imported"], queryFn: connectedApi.importedMeetings });
  const [active, setActive] = useState(selected ?? "");
  const [question, setQuestion] = useState("");
  const [search, setSearch] = useState("");
  const autoSelected = useRef(false);
  const [filter, setFilter] = useState<"all" | "active" | "recaps">("all");
  const choose = (id: string) => { setActive(id); router.replace(id ? `/meetings?session=${encodeURIComponent(id)}` : "/meetings", { scroll: false }); };

  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);
  const detail = useQuery({
    queryKey: ["meeting-session", active],
    queryFn: () => api.meetingSession(active),
    enabled: Boolean(active),
  });

  const summarize = useMutation({
    mutationFn: () => api.summarizeMeetings(question),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const start = useMutation({
    mutationFn: () => api.startMeeting(null, "Meeting notes"),
    onSuccess: (result) => {
      choose(result.session.id);
      void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
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
  const recap = useMutation({
    mutationFn: () => api.meetingRecap(active),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["meeting-session", active] }),
  });

  const session = detail.data?.session;
  const sessions = list.data?.sessions ?? [];
  const importedNotes = imported.data?.notes ?? [];
  const libraryReady = list.isSuccess && imported.isSuccess;
  const visible = sessions.filter((s) => (filter === "all" || filter === "active" && s.status !== "ended" || filter === "recaps" && Boolean(s.recap?.trim())) && `${s.title} ${s.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { if (!autoSelected.current && list.isSuccess) { autoSelected.current = true; if (!active && !selected && sessions[0]) setActive(sessions[0].id); } }, [active, selected, sessions, list.isSuccess]);

  return (
    <div className="page-read meeting-workspace mx-auto max-w-[1120px] px-6 pb-24 pt-8">
      <PageHeader
        title="Meeting notes"
        description="Conversations become context. Keep the notes, decisions, and next steps together."
        actions={
          <button type="button" className="btn-primary" disabled={start.isPending} onClick={() => start.mutate()}>
            <Plus size={14} /> New notes
          </button>
        }
      />
      <div className="meeting-metrics">
        <div><BookOpen size={17} /><strong>{libraryReady ? sessions.length + importedNotes.length : "—"}</strong><span>notes in your library</span></div>
        <div><Clock3 size={17} /><strong>{list.isSuccess ? sessions.filter((s) => s.status !== "ended").length : "—"}</strong><span>in progress</span></div>
        <div><FileText size={17} /><strong>{libraryReady ? sessions.filter((s) => s.recap?.trim()).length + importedNotes.filter((n) => n.summary?.trim()).length : "—"}</strong><span>with a recap</span></div>
      </div>
      <form
        className="meeting-question mb-6 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) summarize.mutate();
        }}
      >
        <input value={question} onChange={(event) => setQuestion(event.target.value)} className="field flex-1" aria-label="Summarize across meetings" placeholder="Ask across your meeting notes" />
        <button type="submit" className="btn" disabled={summarize.isPending}>
          {summarize.isPending ? "Looking…" : "Summarize"}
        </button>
      </form>
      {summarize.data ? (
        <div className="mb-6 rounded-xl border border-line bg-panel px-4 py-3">
          <p className="text-[13.5px]">{summarize.data.answer}</p>
          <ul className="mt-2 space-y-2">
            {summarize.data.quotes.map((quote) => (
              <li key={`${quote.href}-${quote.text.slice(0, 24)}`}>
                <Link href={quote.href} className="text-[13px] hover:underline">
                  {quote.title}
                </Link>
                <p className="text-[12.5px] text-muted">{quote.text}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="meeting-library-tools"><label><Search size={15} /><input aria-label="Search meeting notes" placeholder="Find a conversation…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><div className="work-view-tabs" aria-label="Meeting note views">{([["all", "All notes"], ["active", "In progress"], ["recaps", "With recap"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
      <ImportedMeetingNotes search={search} />
      {list.isError && <div className="work-load-error" role="alert">Couldn't load your meeting library.<button type="button" className="btn" onClick={() => void list.refetch()}>Try again</button></div>}
      {list.isLoading && !list.data ? (
        <SkeletonRows count={3} />
      ) : !list.isError && sessions.length === 0 && !session ? (
        <div className="empty-panel">
          <h2 className="text-[18px] font-semibold">A page for your next conversation</h2>
          <p className="mt-1 max-w-[42ch] text-[14px] leading-5 text-muted">Start a page for the meeting you are in. The notes stay here, and you can ask across them later.</p>
          <button type="button" className="btn-primary mt-4" onClick={() => start.mutate()} disabled={start.isPending}>
            Start notes
          </button>
        </div>
      ) : null}
      <div className={sessions.length === 0 && !session ? "hidden" : "meeting-library grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]"}>
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
                <span className="meeting-card-meta"><MessageSquare size={14} />{whenLabel(row.startedAt)}<i data-active={row.status !== "ended"}>{row.status !== "ended" ? "In progress" : "Ended"}</i></span>
                <strong>{row.title}</strong>
                <p>{row.notes.trim().slice(0, 110) || "A fresh page for this conversation."}</p>
                <span className="meeting-card-footer">{row.recap?.trim() ? "Recap ready" : "Meeting notes"}<ArrowUpRight size={12} /></span>
              </button>
            </li>
          ))}
          {!visible.length && sessions.length > 0 && <li className="work-quiet-state">No notes match this view.</li>}
        </ul>
        {detail.isError ? <div className="work-load-error" role="alert">Couldn't open this meeting.<button type="button" className="btn" onClick={() => void detail.refetch()}>Try again</button></div> : detail.isPending && active ? <SkeletonRows count={4} /> : session ? (
          <article className="meeting-paper">
            <div className="meeting-paper-kicker"><MessageSquare size={13} />{whenLabel(session.startedAt)}<span>{session.status !== "ended" ? "In progress" : "Meeting ended"}</span></div>
            <MeetingNotesFields key={session.id} session={session} onRemoved={() => choose("")} />
            <div className="mt-3 flex flex-wrap gap-2">
              {session.status !== "ended" ? (
                <button type="button" className="btn" disabled={end.isPending} onClick={() => end.mutate()}>
                  End meeting
                </button>
              ) : null}
              <button type="button" className="btn-ghost" disabled={recap.isPending} onClick={() => recap.mutate()}>
                Refresh recap
              </button>
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
                <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-6">{session.recap}</p>
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
