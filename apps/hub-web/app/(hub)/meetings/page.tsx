"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { ImportedMeetingNotes } from "@/components/meetings/imported-notes";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { MeetingNotesFields } from "@/components/meetings/notes-fields";
import { whenLabel } from "@/lib/format";

function MeetingsBody() {
  const params = useSearchParams();
  const selected = params.get("session");
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions });
  const [active, setActive] = useState(selected ?? "");
  const [question, setQuestion] = useState("");

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
      setActive(result.session.id);
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
    onSuccess: () => void client.invalidateQueries({ queryKey: ["meeting-session", active] }),
  });

  const session = detail.data?.session;
  const sessions = list.data?.sessions ?? [];

  return (
    <div className="page-read mx-auto max-w-[920px] px-6 pb-24 pt-8">
      <PageHeader
        title="Meeting notes"
        description="Every meeting you took notes for. Ask across them, or open one."
        actions={
          <button type="button" className="btn" onClick={() => start.mutate()}>
            New notes
          </button>
        }
      />
      <form
        className="mb-6 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) summarize.mutate();
        }}
      >
        <input value={question} onChange={(event) => setQuestion(event.target.value)} className="field flex-1" aria-label="Summarize across meetings" placeholder="Ask across these notes" />
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
      <ImportedMeetingNotes />
      {list.isLoading && !list.data ? (
        <SkeletonRows count={3} />
      ) : sessions.length === 0 && !session ? (
        <div className="empty-panel">
          <h2 className="text-[18px] font-semibold">No meeting notes yet</h2>
          <p className="mt-1 max-w-[42ch] text-[14px] leading-5 text-muted">Start a page for the meeting you are in. The notes stay here, and you can ask across them later.</p>
          <button type="button" className="btn-primary mt-4" onClick={() => start.mutate()} disabled={start.isPending}>
            Start notes
          </button>
        </div>
      ) : null}
      <div className={sessions.length === 0 && !session ? "hidden" : "grid gap-6 md:grid-cols-[240px_minmax(0,1fr)]"}>
        <ul className="space-y-1">
          {sessions.length === 0 ? <li className="text-[13px] text-muted">No meeting notes yet.</li> : null}
          {sessions.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="tile w-full rounded-lg bg-panel px-2 py-1.5 text-left hover:border-line-strong data-[active=true]:bg-accent-soft"
                data-active={row.id === active || undefined}
                onClick={() => setActive(row.id)}
              >
                <div className="truncate text-[13.5px]">{row.title}</div>
                <div className="text-[12.5px] text-muted">{whenLabel(row.startedAt)}</div>
              </button>
            </li>
          ))}
        </ul>
        {session ? (
          <article>
            <MeetingNotesFields key={session.id} session={session} onRemoved={() => setActive("")} />
            <div className="mt-3 flex flex-wrap gap-2">
              {session.status !== "ended" ? (
                <button type="button" className="btn" onClick={() => end.mutate()}>
                  End meeting
                </button>
              ) : null}
              <button type="button" className="btn-ghost" onClick={() => recap.mutate()}>
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
              <section className="mt-5">
                <h3 className="text-[13px] font-semibold">Recap</h3>
                <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-6">{session.recap}</p>
              </section>
            ) : null}
            {detail.data?.openTasks.length ? (
              <section className="mt-4">
                <h3 className="text-[13px] font-semibold">Open tasks</h3>
                <ul className="mt-1 space-y-1 text-[13px]">
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
