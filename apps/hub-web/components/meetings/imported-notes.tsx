"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { MarkdownText } from "@/components/markdown-text";
import { connectedApi, type ImportedMeetingNote } from "@/lib/api-connected";
import { whenLabel } from "@/lib/format";

const ownerLabel = (owner: { name: string | null; email: string | null } | null) => owner?.name ?? owner?.email ?? "Someone";

/** Meetings Fireflies, Fathom, Granola and the other meeting-notes connectors brought in. Hidden until there are any. */
export function ImportedMeetingNotes() {
  const notes = useQuery({ queryKey: ["meetings-imported"], queryFn: connectedApi.importedMeetings });
  const [open, setOpen] = useState<string | null>(null);
  const rows = notes.data?.notes ?? [];
  if (!rows.length) return null;
  return (
    <section className="mb-8" data-testid="imported-meetings">
      <h2 className="mb-2 text-[15px] font-semibold">From your meeting tools</h2>
      <ul className="space-y-2">
        {rows.map((note) => (
          <li key={note.id} className="rounded-xl border border-line bg-panel">
            <button type="button" className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left" aria-expanded={open === note.id} onClick={() => setOpen(open === note.id ? null : note.id)}>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{note.title}</span>
              <span className="shrink-0 text-[12px] text-muted">
                {note.sourceLabel} · {whenLabel(note.occurredAt)}
              </span>
            </button>
            {open === note.id ? <MeetingNoteDetail note={note} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MeetingNoteDetail({ note }: { note: ImportedMeetingNote }) {
  const mine = note.actionItems.filter((item) => item.mine);
  return (
    <div className="space-y-4 border-t border-line px-4 py-3 text-[13px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        {note.event ? (
          <span className="inline-flex items-center gap-1">
            <CalendarDays size={13} />
            {note.event.url ? (
              <a href={note.event.url} target="_blank" rel="noreferrer" className="hover:underline">
                {note.event.title}
              </a>
            ) : (
              note.event.title
            )}
          </span>
        ) : (
          <span>Not matched to a calendar event</span>
        )}
        {note.transcriptUrl ? (
          <a href={note.transcriptUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
            Open in {note.sourceLabel} <ExternalLink size={12} />
          </a>
        ) : null}
        {note.project ? (
          <Link href={`/projects/${note.project.id}`} className="hover:underline">
            {note.project.name}
          </Link>
        ) : null}
        {note.people.length ? <span>{note.people.map((person) => person.name).join(", ")}</span> : null}
      </div>
      {note.summary ? (
        <div>
          <h3 className="text-[12px] font-semibold text-muted">Summary</h3>
          <div className="mt-1 max-h-72 overflow-auto leading-6">
            <MarkdownText text={note.summary} />
          </div>
        </div>
      ) : null}
      {note.decisions.length ? (
        <div>
          <h3 className="text-[12px] font-semibold text-muted">Decisions</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {note.decisions.map((decision) => (
              <li key={decision}>{decision}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {mine.length || note.tasks.length ? (
        <div>
          <h3 className="text-[12px] font-semibold text-muted">Your action items</h3>
          <ul className="mt-1 space-y-0.5">
            {note.tasks.map((task) => (
              <li key={task.id}>
                <Link href={`/tasks/${task.id}`} className="hover:underline">
                  {task.title}
                </Link>{" "}
                <span className="text-[12px] text-muted">{task.status === "proposed" ? "proposed" : task.status}</span>
              </li>
            ))}
            {note.tasks.length ? null : mine.map((item) => <li key={item.text}>{item.text}</li>)}
          </ul>
        </div>
      ) : null}
      {note.waitingOn.length ? (
        <div>
          <h3 className="text-[12px] font-semibold text-muted">Waiting on others</h3>
          <ul className="mt-1 space-y-0.5">
            {note.waitingOn.map((item) => (
              <li key={`${ownerLabel(item.owner)}:${item.text}`}>
                <span className="font-medium">{ownerLabel(item.owner)}</span>: {item.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
