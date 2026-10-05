"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, type MeetingCue } from "@/lib/api";
import { useToast } from "../toast";

function whenLabel(start: string): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function MeetingCues() {
  const client = useQueryClient();
  const toast = useToast();
  const cues = useQuery({ queryKey: ["meeting-cues"], queryFn: api.meetingCues, refetchInterval: 60_000 });
  const rows = cues.data?.cues ?? [];
  if (!rows.length) return null;
  return (
    <section aria-label="Meetings" className="mb-6 space-y-2">
      {rows.map((cue) => (
        <CueCard
          key={cue.artifactId ?? cue.session?.id ?? cue.start}
          cue={cue}
          voice={cues.data?.voice ?? ""}
          onChange={() => {
            void client.invalidateQueries({ queryKey: ["meeting-cues"] });
            void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
          }}
          onError={(message) => toast(message, { tone: "error" })}
        />
      ))}
    </section>
  );
}

function CueCard({
  cue,
  voice,
  onChange,
  onError,
}: {
  cue: MeetingCue;
  voice: string;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(cue.kind !== "prep");
  const toast = useToast();
  const timer = useRef(0);
  const [notes, setNotes] = useState(cue.session?.notes ?? "");
  const [sessionId, setSessionId] = useState(cue.session?.id ?? "");
  useEffect(() => {
    setNotes(cue.session?.notes ?? "");
    setSessionId(cue.session?.id ?? "");
  }, [cue.session?.id, cue.session?.notes]);

  const start = useMutation({
    mutationFn: () => api.startMeeting(cue.artifactId, cue.title),
    onSuccess: (result) => {
      setSessionId(result.session.id);
      setOpen(true);
      onChange();
    },
    onError: (error) => onError((error as Error).message),
  });
  const end = useMutation({
    mutationFn: () => api.endMeeting(sessionId),
    onSuccess: () => onChange(),
    onError: (error) => onError((error as Error).message),
  });
  const attach = useMutation({
    mutationFn: () => api.attachMeeting(sessionId),
    onSuccess: (result) => {
      toast(result.message);
      onChange();
    },
    onError: (error) => onError((error as Error).message),
  });
  const decline = useMutation({
    mutationFn: () => api.declineMeeting(sessionId),
    onSuccess: () => onChange(),
    onError: (error) => onError((error as Error).message),
  });

  const label = cue.kind === "follow_up" ? "Follow-up" : cue.kind === "live" ? "Happening now" : "Coming up";
  const pending = cue.session?.attachState === "pending";

  return (
    <article className="pop-in rounded-xl border border-line bg-panel/80 px-3 py-2.5">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((value) => !value)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
        <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-faint">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          {whenLabel(cue.start)} {cue.title}
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-3 pl-3.5 text-[13px]">
          {cue.attendees.length ? (
            <p>
              <span className="text-muted">With </span>
              {cue.attendees.map((person) => person.name).join(", ")}
            </p>
          ) : null}
          <div>
            <div className="text-[12px] font-medium text-muted">Past decisions</div>
            {cue.decisions.length ? (
              <ul className="mt-1 space-y-1">
                {cue.decisions.map((row) => (
                  <li key={row.text}>{row.text}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No saved decisions with them yet.</p>
            )}
          </div>
          <div>
            <div className="text-[12px] font-medium text-muted">Open tasks</div>
            {cue.openTasks.length ? (
              <ul className="mt-1 space-y-1">
                {cue.openTasks.map((task) => (
                  <li key={task.id}>
                    <Link href={task.href} className="hover:underline">
                      {task.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Nothing open with them.</p>
            )}
          </div>
          {sessionId ? (
            <label className="block">
              <span className="text-[12px] font-medium text-muted">Notes</span>
              <textarea
                value={notes}
                onChange={(event) => {
                  const value = event.target.value;
                  const id = sessionId;
                  setNotes(value);
                  window.clearTimeout(timer.current);
                  timer.current = window.setTimeout(() => {
                    if (!id) return;
                    void api.saveMeetingNotes(id, value).catch((error: Error) => onError(error.message));
                  }, 500);
                }}
                rows={4}
                className="field mt-1 w-full resize-y"
                placeholder="Type what is said. No microphone yet."
              />
              <p className="mt-1 text-[11.5px] text-muted">{voice}</p>
            </label>
          ) : (
            <button type="button" className="btn" onClick={() => start.mutate()}>
              Take notes
            </button>
          )}
          {sessionId && cue.session?.status !== "ended" ? (
            <button type="button" className="btn-ghost" onClick={() => end.mutate()}>
              End meeting
            </button>
          ) : null}
          {pending ? (
            <div className="rounded-lg border border-line bg-bg px-3 py-2">
              <p>Attach these notes to the calendar event?</p>
              <p className="mt-1 text-[12px] text-muted">Ensemble will keep them on the event here. It will not write them back to Google or Outlook.</p>
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
        </div>
      ) : null}
    </article>
  );
}
