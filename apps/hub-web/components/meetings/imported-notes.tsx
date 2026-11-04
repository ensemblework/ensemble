"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, CheckSquare, Clock, ExternalLink, FileText, FolderKanban, Plus, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MarkdownText } from "@/components/markdown-text";
import { api } from "@/lib/api";
import { connectedApi, type ImportedMeetingNote } from "@/lib/api-connected";
import { MEETING_QUERY, meetingsApi } from "@/lib/api-meetings";
import { InfoTip, Spinner } from "../ui";
import { useToast } from "../toast";
import { NoteSourceMark } from "./note-source";
import { meetingWhen } from "./meeting-time";
import { TranscriptView } from "./transcript-view";

const ownerLabel = (owner: { name: string | null; email: string | null } | null) => owner?.name ?? owner?.email ?? "Someone";
export const personHref = (name: string) => `/context?tab=people&search=${encodeURIComponent(name)}`;

/**
 * A meeting brought in from a transcript, a meeting app or a meeting-notes app: the calendar event
 * and people it belongs to, what was decided, action items that become tasks, and the whole
 * transcript. Read only; the source is the record.
 */
export function MeetingNoteDetail({ note: listed, onDelete }: { note: ImportedMeetingNote; onDelete?: (note: ImportedMeetingNote) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const full = useQuery({ queryKey: MEETING_QUERY.note(listed.id), queryFn: () => connectedApi.meetingNote(listed.id), staleTime: 30_000 });
  const note = full.data?.note ?? listed;
  const transcript = full.data?.note.transcript ?? [];
  const makeTask = useMutation({
    mutationFn: (item: { text: string; owner: string | null }) => meetingsApi.makeTask(listed.id, item.text, item.owner),
    onSuccess: (result) => {
      toast(result.created ? `Added “${result.task.title}” to your tasks.` : "That task is already on your board.", {
        action: { label: "Open", run: () => router.push(`/tasks/${result.task.id}`) },
      });
      void client.invalidateQueries({ queryKey: MEETING_QUERY.note(listed.id) });
      void client.invalidateQueries({ queryKey: ["meetings-imported"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 300_000 });
  // People in the meeting besides you: those in People, then speakers who are not.
  const named = new Set([...note.people.map((person) => person.name?.toLowerCase()), me.data?.user.name.trim().toLowerCase()]);
  const others = (note.speakers ?? []).filter((name) => !named.has(name.toLowerCase()));
  const open = note.actionItems.filter((item) => !item.completed);
  const yours = open.filter((item) => item.mine || !item.owner);
  const theirs = open.filter((item) => !item.mine && item.owner);
  const waitingElse = note.waitingOn.filter((row) => !note.actionItems.some((item) => item.text === row.text));
  const listedTasks = note.tasks.filter((task) => !note.actionItems.some((item) => item.taskId === task.id));
  const actionRow = (item: ImportedMeetingNote["actionItems"][number]) => {
    const pending = makeTask.isPending && makeTask.variables?.text === item.text;
    return (
      <li key={item.text} className="note-action">
        <CheckSquare size={15} aria-hidden className="note-action-icon" />
        <div className="min-w-0 flex-1">
          <p>{item.text}</p>
          {item.owner || item.at || item.due ? (
            <p className="note-action-meta">
              {item.owner ? <span>{ownerLabel(item.owner)}</span> : null}
              {item.at ? <span className="inline-flex items-center gap-1"><Clock size={11} aria-hidden />{item.at}</span> : null}
              {item.due ? <span>Due {new Date(item.due).toLocaleDateString()}</span> : null}
            </p>
          ) : null}
        </div>
        {item.taskId ? (
          <Link href={`/tasks/${item.taskId}`} className="btn shrink-0">Open task</Link>
        ) : (
          <button type="button" className="btn shrink-0" disabled={makeTask.isPending} aria-label={`Make task: ${item.text}`} onClick={() => makeTask.mutate({ text: item.text, owner: item.owner?.name ?? null })}>
            {pending ? <Spinner size={12} /> : <Plus size={13} aria-hidden />}Make task
          </button>
        )}
      </li>
    );
  };
  return (
    <div className="note-detail">
      <div className="meeting-paper-kicker">
        <NoteSourceMark source={note.source} label={note.sourceLabel} />
        <span className="note-kicker-text">{note.sourceLabel}</span>
        <span aria-hidden>·</span>
        <time dateTime={note.occurredAt}>{meetingWhen(note.occurredAt)}</time>
        {note.durationMinutes ? <><span aria-hidden>·</span><span>{note.durationMinutes} min</span></> : null}
        {onDelete ? (
          <button type="button" className="icon-btn ml-auto" aria-label={`Delete “${note.title}”`} title="Delete this meeting" onClick={() => onDelete(note)}>
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      <h2 className="note-title">{note.title}</h2>
      <dl className="note-props">
        <div>
          <dt><CalendarDays size={14} aria-hidden />Meeting</dt>
          <dd>
            {note.event ? (
              note.event.url ? <a href={note.event.url} target="_blank" rel="noopener noreferrer" className="note-link">{note.event.title}<ArrowUpRight size={12} aria-hidden /></a> : <span>{note.event.title}</span>
            ) : (
              <span className="text-faint">Not linked to a calendar event</span>
            )}
          </dd>
        </div>
        <div>
          <dt><Users size={14} aria-hidden />People</dt>
          <dd className="note-people">
            {note.people.map((person) => (
              <Link key={person.id} href={personHref(person.name ?? "")} className="note-person" data-linked>{person.name}</Link>
            ))}
            {others.map((name) => <span key={name} className="note-person" title="Spoke in the meeting; not in People">{name}</span>)}
            {!note.people.length && !others.length ? <span className="text-faint">No one recorded</span> : null}
          </dd>
        </div>
        {note.project ? (
          <div>
            <dt><FolderKanban size={14} aria-hidden />Project</dt>
            <dd><Link href={`/projects/${note.project.id}`} className="note-link">{note.project.name}</Link></dd>
          </div>
        ) : null}
        {note.transcriptUrl ? (
          <div>
            <dt><ExternalLink size={14} aria-hidden />Source</dt>
            <dd><a href={note.transcriptUrl} target="_blank" rel="noopener noreferrer" className="note-link">Open in {note.sourceLabel}<ArrowUpRight size={12} aria-hidden /></a></dd>
          </div>
        ) : null}
      </dl>

      {note.summary ? (
        <section className="note-section">
          <h3>Summary</h3>
          <div className="note-summary"><MarkdownText text={note.summary} /></div>
        </section>
      ) : null}

      {note.decisions.length ? (
        <section className="note-section">
          <h3>Decisions{note.suggested ? <SuggestedTip /> : null}</h3>
          <ul className="note-decisions">
            {note.decisions.map((decision) => <li key={decision}>{decision}</li>)}
          </ul>
        </section>
      ) : null}

      {yours.length || listedTasks.length ? (
        <section className="note-section">
          <h3>Action items{note.suggested ? <SuggestedTip /> : null}</h3>
          <ul className="note-actions">
            {yours.map(actionRow)}
            {listedTasks.map((task) => (
              <li key={task.id} className="note-action">
                <CheckSquare size={15} aria-hidden className="note-action-icon" />
                <p className="min-w-0 flex-1">{task.title}</p>
                <Link href={`/tasks/${task.id}`} className="btn shrink-0">{task.status === "proposed" ? "Review" : "Open task"}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {theirs.length || waitingElse.length ? (
        <section className="note-section">
          <h3>Waiting on others{note.suggested && !yours.length ? <SuggestedTip /> : null}</h3>
          <ul className="note-actions">
            {theirs.map(actionRow)}
            {waitingElse.map((item) => (
              <li key={`${ownerLabel(item.owner)}:${item.text}`} className="note-action">
                <CheckSquare size={15} aria-hidden className="note-action-icon" />
                <div className="min-w-0 flex-1">
                  <p>{item.text}</p>
                  <p className="note-action-meta"><span>{ownerLabel(item.owner)}</span></p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {full.isPending && (note.lineCount ?? 0) > 0 ? (
        <p className="mt-5 inline-flex items-center gap-2 text-[13px] text-muted"><Spinner size={13} />Loading the transcript…</p>
      ) : transcript.length ? (
        <TranscriptView key={note.id} lines={transcript} defaultOpen={!note.summary} />
      ) : !note.summary && !note.decisions.length && !open.length ? (
        <p className="empty-state mt-5"><FileText size={14} className="mr-1 inline" aria-hidden />{note.sourceLabel} sent no transcript for this meeting.</p>
      ) : null}
    </div>
  );
}

function SuggestedTip() {
  return <InfoTip label="Where these came from" text="Found in what was said, by phrases like “I'll send…”, “Could you review…” and “We agreed…”. Nothing was sent to a model; make a task from the ones that are real." />;
}
