"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Clock, Quote, RefreshCw, Sparkles, UserPlus } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { connectedApi, type ImportedMeetingNote, type MeetingAiItem } from "@/lib/api-connected";
import { MEETING_QUERY, meetingsApi } from "@/lib/api-meetings";
import { relative } from "@/lib/format";
import { InfoTip, Spinner, Tag } from "../ui";
import { useToast } from "../toast";

const KIND_LABEL: Record<string, string> = { task: "Task", deliverable: "Deliverable", follow_up: "Waiting on" };

function ItemRow({ item, noteId }: { item: MeetingAiItem; noteId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const make = useMutation({
    mutationFn: () => meetingsApi.makeTask(noteId, item.title, item.mine ? null : item.owner),
    onSuccess: (result) => {
      toast(result.created ? `Added “${result.task.title}” to your tasks.` : "That task is already on your board.");
      void client.invalidateQueries({ queryKey: MEETING_QUERY.note(noteId) });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const who = item.kind === "follow_up" ? (item.owner ?? "someone") : item.requestedBy && item.requestedBy.toLowerCase() !== "me" ? `asked by ${item.requestedBy}` : null;
  return (
    <li className="note-action !items-start" data-ai-item={item.grounded ? "grounded" : "unverified"}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5">
          <Tag tone={item.kind === "follow_up" ? "orange" : item.kind === "deliverable" ? "purple" : "blue"}>{KIND_LABEL[item.kind] ?? "Task"}</Tag>
          <span className={item.grounded ? "" : "text-muted"}>{item.title}</span>
        </p>
        {item.quote ? (
          <p className="mt-1 flex gap-1.5 text-[12.5px] italic leading-5 text-muted">
            <Quote size={12} aria-hidden className="mt-1 shrink-0" />
            <span>“{item.quote}”</span>
          </p>
        ) : null}
        <p className="note-action-meta">
          {who ? <span>{who}</span> : null}
          {item.at ? <span className="inline-flex items-center gap-1"><Clock size={11} aria-hidden />{item.at}</span> : null}
          {item.due ? <span>Due {item.due}{item.dueText ? ` (“${item.dueText}”)` : ""}</span> : null}
          {!item.grounded ? <span title="Its words were not found in the transcript or notes, so it was not proposed.">Not found in the meeting</span> : null}
        </p>
      </div>
      {item.task ? (
        <Link href={`/tasks/${item.task.id}`} className="btn shrink-0">{item.task.status === "proposed" ? "Review" : "Open task"}</Link>
      ) : item.alreadyTracked ? (
        <Link href={`/tasks/${item.alreadyTracked.id}`} className="btn shrink-0" title={item.alreadyTracked.title ? `Already tracked as “${item.alreadyTracked.title}”` : "Already tracked"}>Already tracked</Link>
      ) : (
        <button type="button" className="btn shrink-0" disabled={make.isPending} onClick={() => make.mutate()}>
          {make.isPending ? <Spinner size={12} /> : null}Make task
        </button>
      )}
    </li>
  );
}

/**
 * Ensemble's read of a meeting: summary, decisions and the work it asked for, each with the words it
 * was asked in. Proposed tasks wait on Today for review. `sessionId`: notes typed in Ensemble, whose
 * note is brought up to date before it is read.
 */
export function MeetingAiPanel({ noteId, sessionId, initial }: { noteId: string | null; sessionId?: string; initial?: ImportedMeetingNote }) {
  const client = useQueryClient();
  const toast = useToast();
  const note = useQuery({
    queryKey: MEETING_QUERY.note(noteId ?? ""),
    queryFn: () => connectedApi.meetingNote(noteId!),
    enabled: Boolean(noteId),
    staleTime: 30_000,
    initialData: initial ? { note: initial } : undefined,
    // While the model reads it, check back; the "meetings" live event usually lands first.
    refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.note.aiStatus ?? "") ? 4000 : false),
  });
  const suggest = useMutation({
    mutationFn: () => (sessionId ? meetingsApi.suggestSession(sessionId) : meetingsApi.suggestNote(noteId!)),
    onSuccess: (result) => {
      const id: string | null = "meetingNoteId" in result && typeof result.meetingNoteId === "string" ? result.meetingNoteId : noteId;
      if (id) void client.invalidateQueries({ queryKey: MEETING_QUERY.note(id) });
      if (sessionId) void client.invalidateQueries({ queryKey: ["meeting-session", sessionId] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const addPerson = useMutation({
    mutationFn: (person: { name: string; role: string | null }) => api.createPerson({ name: person.name, role: person.role ?? undefined }),
    onSuccess: (_, person) => {
      toast(`Added ${person.name} to People.`);
      void client.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const row = note.data?.note;
  const status = suggest.isPending ? "queued" : (row?.aiStatus ?? null);
  const ai = row?.ai ?? null;
  const reading = status === "queued" || status === "running";
  const button = (
    <button type="button" className="btn" disabled={reading || (!noteId && !sessionId)} onClick={() => suggest.mutate()}>
      {reading ? <Spinner size={12} /> : ai ? <RefreshCw size={13} aria-hidden /> : <Sparkles size={13} aria-hidden />}
      {reading ? "Reading the meeting…" : ai ? "Read again" : "Suggest tasks"}
    </button>
  );
  const proposed = ai?.items.filter((item) => item.task) ?? [];
  const yours = ai?.items.filter((item) => item.kind !== "follow_up") ?? [];
  const theirs = ai?.items.filter((item) => item.kind === "follow_up") ?? [];
  return (
    <section className="note-section" data-meeting-ai={status ?? "none"} aria-busy={reading || undefined}>
      <h3 className="!mb-1">
        <Sparkles size={13} aria-hidden />
        Ensemble's read
        <InfoTip label="How tasks are suggested" text="A model reads the transcript and notes and writes the work the meeting asked for, each with the exact words it was asked in. Only items whose words are found in the meeting become proposed tasks; you accept them on Today. Turn this off or pick its model in Settings › Assistant › Automations." />
      </h3>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        {status === "failed" ? (
          <span className="inline-flex items-center gap-1 text-[var(--danger,#d4574a)]"><AlertCircle size={13} aria-hidden />{row?.aiError ?? "The model could not read this meeting."}</span>
        ) : status === "skipped" ? (
          <span>{row?.aiError ?? "Nothing to read yet."}</span>
        ) : ai ? (
          <span>
            {proposed.length ? `${proposed.length} proposed` : "Nothing new to propose"}
            {ai.at ? ` · ${relative(ai.at)}` : ""}
            {ai.model ? ` · ${ai.model}` : ""}
          </span>
        ) : !reading ? (
          <span>Not read yet.</span>
        ) : null}
        <span className="ml-auto">{button}</span>
      </div>
      {ai ? (
        <div className="flex flex-col gap-4">
          {ai.summary ? <p className="text-[13.5px] leading-6">{ai.summary}</p> : null}
          {ai.project ? (
            <p className="text-[12.5px] text-muted">
              About {ai.project.id ? <Link className="note-link" href={`/projects/${ai.project.id}`}>{ai.project.name}</Link> : ai.project.name}
              {ai.project.applied ? " · linked to this meeting" : ""}
            </p>
          ) : null}
          {ai.decisions.length ? (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-muted">Decisions</h4>
              <ul className="note-decisions">{ai.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
            </div>
          ) : null}
          {yours.length ? (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-muted">Your work from it</h4>
              <ul className="note-actions">{yours.map((item) => <ItemRow key={`${item.kind}:${item.title}`} item={item} noteId={noteId!} />)}</ul>
            </div>
          ) : null}
          {theirs.length ? (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-muted">Waiting on others</h4>
              <ul className="note-actions">{theirs.map((item) => <ItemRow key={`${item.kind}:${item.title}`} item={item} noteId={noteId!} />)}</ul>
            </div>
          ) : null}
          {ai.openQuestions.length ? (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-muted">Open questions</h4>
              <ul className="note-decisions">{ai.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
            </div>
          ) : null}
          {ai.nextTime.length ? (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-muted">For next time</h4>
              <ul className="note-decisions">{ai.nextTime.map((topic) => <li key={topic}>{topic}</li>)}</ul>
            </div>
          ) : null}
          {ai.newPeople.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-muted">Also in the meeting:</span>
              {ai.newPeople.map((person) => (
                <button key={person.name} type="button" className="linked-action" disabled={addPerson.isPending} onClick={() => addPerson.mutate(person)} title="Add to People">
                  <UserPlus size={12} aria-hidden />{person.name}{person.role ? ` · ${person.role}` : ""}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
