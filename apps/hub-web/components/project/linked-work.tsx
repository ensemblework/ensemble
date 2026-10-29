"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, CheckSquare, Link2, NotebookPen, Plus, Target, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, type ProjectDetail } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { usePeek } from "@/components/shell/peek";
import { useToast } from "@/components/toast";
import { Popover, PriorityTag, StatusPill, cx } from "@/components/ui";

/** A one-line "+ New …" row: Enter adds and stays open for the next one, Esc or an empty blur closes it. */
function AddRow({ label, onAdd, busy }: { label: string; onAdd: (title: string) => Promise<unknown>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  if (!open) return <button type="button" className="linked-add" onClick={() => setOpen(true)}><Plus size={14} /> {label}</button>;
  return (
    <form className="linked-add is-open" onSubmit={(event) => {
      event.preventDefault();
      const title = value.trim();
      if (!title || busy) return;
      void onAdd(title).then(() => { setValue(""); input.current?.focus(); }).catch(() => undefined);
    }}>
      <Plus size={14} className="text-faint" />
      <input ref={input} autoFocus value={value} aria-label={label} placeholder={`${label.replace(/^New /, "")} title, then Enter`} onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setValue(""); setOpen(false); } }}
        onBlur={() => { if (!value.trim()) setOpen(false); }} />
    </form>
  );
}

/** Search-and-pick from records that are not linked yet. */
function LinkExisting<T extends { id: string; title: string }>({ label, items, loading, onPick, detail }: { label: string; items: T[]; loading: boolean; onPick: (item: T) => void; detail?: (item: T) => React.ReactNode }) {
  const [query, setQuery] = useState("");
  const shown = items.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 40);
  return (
    <Popover align="right" width={320} trigger={(open, toggle) => <button type="button" className="linked-action" aria-expanded={open} onClick={toggle}><Link2 size={13} /> Link existing</button>}>
      {(close) => (
        <div className="linked-picker">
          <input autoFocus type="search" className="field w-full text-[13px]" placeholder={`Find ${label}…`} aria-label={`Find ${label}`} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="mt-1.5 max-h-[260px] overflow-y-auto">
            {loading ? <p className="px-2 py-3 text-[12.5px] text-muted">Loading…</p> : shown.length ? shown.map((item) => (
              <button key={item.id} type="button" className="linked-pick" onClick={() => { onPick(item); close(); }}>
                <span className="min-w-0 flex-1 truncate">{item.title || "Untitled"}</span>
                {detail ? <span className="shrink-0 text-[11.5px] text-faint">{detail(item)}</span> : null}
              </button>
            )) : <p className="px-2 py-3 text-[12.5px] text-muted">{query ? "Nothing matches." : `No other ${label} to link.`}</p>}
          </div>
        </div>
      )}
    </Popover>
  );
}

function Section({ icon: Icon, title, count, actions, children }: { icon: LucideIcon; title: string; count: number; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="linked-section" aria-label={title}>
      <header>
        <h2><Icon size={15} className="text-faint" /> {title}{count ? <span className="linked-count">{count}</span> : null}</h2>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </header>
      <div className="linked-rows">{children}</div>
    </section>
  );
}

/**
 * The project's tasks, deliverables and meeting notes as editable lists: add one in place, link an
 * existing one, or take it off the project. Rows open the same page or peek as everywhere else.
 */
export function LinkedWork({ project, editable }: { project: ProjectDetail; editable: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const router = useRouter();
  const id = project.id;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["project", id] });
    void client.invalidateQueries({ queryKey: ["projects"] });
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
  };
  const fail = (error: Error) => toast(error.message, { tone: "error" });
  const [pickTasks, setPickTasks] = useState(false);
  const [pickMeetings, setPickMeetings] = useState(false);
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: editable && pickTasks });
  const meetings = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions, enabled: editable && pickMeetings });

  const addTask = useMutation({ mutationFn: (title: string) => api.createTask({ title, projectId: id, status: "todo" }), onSuccess: refresh, onError: fail });
  const linkTask = useMutation({ mutationFn: ({ taskId, on }: { taskId: string; on: boolean }) => api.patchTask(taskId, { projectId: on ? id : null }), onSuccess: refresh, onError: fail });
  const addDeliverable = useMutation({ mutationFn: (title: string) => api.createDeliverable({ title, projectId: id }), onSuccess: refresh, onError: fail });
  const finishDeliverable = useMutation({ mutationFn: ({ rowId, done }: { rowId: string; done: boolean }) => api.patchDeliverable(rowId, { status: done ? "completed" : "upcoming" }), onSuccess: refresh, onError: fail });
  const addMeeting = useMutation({
    mutationFn: (title: string) => api.startMeeting(null, title, id),
    onSuccess: (result) => { refresh(); router.push(`/meetings?session=${encodeURIComponent(result.session.id)}`); },
    onError: fail,
  });
  const linkMeeting = useMutation({ mutationFn: ({ sessionId, on }: { sessionId: string; on: boolean }) => api.setMeetingProject(sessionId, on ? id : null), onSuccess: refresh, onError: fail });

  const linkedTasks = new Set(project.tasks.map((task) => task.id));
  const sessions = project.meetingSessions ?? [];
  const linkedSessions = new Set(sessions.map((row) => row.id));
  const meetingCount = sessions.length + project.meetingNotes.length;

  return (
    <div className="linked-work">
      <Section icon={CheckSquare} title="Tasks" count={project.tasks.length} actions={editable ? <span onPointerDown={() => setPickTasks(true)} onFocus={() => setPickTasks(true)}>
        <LinkExisting label="tasks" loading={tasks.isPending} items={(tasks.data?.tasks ?? []).filter((task) => !linkedTasks.has(task.id) && task.status !== "done")} detail={(task) => task.projectId ? "in another project" : null} onPick={(task) => linkTask.mutate({ taskId: task.id, on: true })} />
      </span> : null}>
        {project.tasks.map((task) => (
          <div key={task.id} className="linked-row group">
            <button type="button" className="linked-main" onClick={() => peek.open(task.id)}>
              <span className={cx("linked-title", task.status === "done" && "is-done")}>{task.title || "Untitled"}</span>
              <PriorityTag priority={task.priority} />
              <StatusPill status={task.status} />
            </button>
            {editable ? <button type="button" className="linked-remove" aria-label={`Remove “${task.title}” from this project`} title="Remove from project" onClick={() => linkTask.mutate({ taskId: task.id, on: false })}><X size={13} /></button> : null}
          </div>
        ))}
        {editable ? <AddRow label="New task" busy={addTask.isPending} onAdd={(title) => addTask.mutateAsync(title)} /> : project.tasks.length ? null : <p className="linked-empty">No tasks yet.</p>}
      </Section>

      <Section icon={Target} title="Deliverables" count={project.deliverables.length}>
        {project.deliverables.map((row) => {
          const done = row.status === "completed";
          return (
            <div key={row.id} className="linked-row group">
              {editable ? <button type="button" role="checkbox" aria-checked={done} aria-label={`${done ? "Reopen" : "Complete"} “${row.title}”`} className={cx("linked-check", done && "is-done")} onClick={() => finishDeliverable.mutate({ rowId: row.id, done: !done })}>{done ? <Check size={11} strokeWidth={3} /> : null}</button> : null}
              <button type="button" className="linked-main" onClick={() => peek.open(row.id, "deliverable")}>
                <span className={cx("linked-title", done && "is-done")}>{row.title}</span>
                {row.due ? <span className="linked-meta"><CalendarDays size={12} /> {shortDate(row.due)}</span> : null}
              </button>
            </div>
          );
        })}
        {editable ? <AddRow label="New deliverable" busy={addDeliverable.isPending} onAdd={(title) => addDeliverable.mutateAsync(title)} /> : project.deliverables.length ? null : <p className="linked-empty">No deliverables yet.</p>}
      </Section>

      <Section icon={NotebookPen} title="Meeting notes" count={meetingCount} actions={editable ? <span onPointerDown={() => setPickMeetings(true)} onFocus={() => setPickMeetings(true)}>
        <LinkExisting label="meeting notes" loading={meetings.isPending} items={(meetings.data?.sessions ?? []).filter((row) => !linkedSessions.has(row.id))} detail={(row) => shortDate(row.startedAt)} onPick={(row) => linkMeeting.mutate({ sessionId: row.id, on: true })} />
      </span> : null}>
        {sessions.map((row) => (
          <div key={row.id} className="linked-row group">
            <Link href={`/meetings?session=${encodeURIComponent(row.id)}`} className="linked-main">
              <span className="linked-title">{row.title || "Meeting notes"}</span>
              <span className="linked-meta">{shortDate(row.startedAt)}</span>
            </Link>
            {editable ? <button type="button" className="linked-remove" aria-label={`Remove “${row.title}” from this project`} title="Remove from project" onClick={() => linkMeeting.mutate({ sessionId: row.id, on: false })}><X size={13} /></button> : null}
          </div>
        ))}
        {project.meetingNotes.map((note) => (
          <div key={note.id} className="linked-row">
            <Link href="/meetings" className="linked-main" title="Imported notes open from Meeting notes">
              <span className="linked-title">{note.title}</span>
              <span className="linked-meta">{shortDate(note.askedAt)}</span>
            </Link>
          </div>
        ))}
        {editable ? <AddRow label="New meeting note" busy={addMeeting.isPending} onAdd={(title) => addMeeting.mutateAsync(title)} /> : meetingCount ? null : <p className="linked-empty">No meeting notes yet.</p>}
      </Section>
    </div>
  );
}
