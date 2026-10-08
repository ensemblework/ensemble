"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useState } from "react";
import { ArrowLeft, Columns3, FileText, FolderGit2, LineChart, BookOpen, CalendarCheck, Briefcase, Workflow, CheckSquare, ShieldOff, X } from "lucide-react";
import { ApiError, HUB_API, api, setOpenShare, withShare, type OpenedShare, type ShareKind, type TaskRecord, type TaskStatus } from "@/lib/api";
import { eventSourceInit, eventsStreamUrl } from "@/lib/events";
import { invalidateSoon } from "@/lib/invalidate";
import { presenceStore, tabId } from "@/lib/presence";
import { STATUS } from "@/lib/format";
import { Avatar } from "./people";
import { PagePeople } from "./page-people";
import { Tag } from "@/components/ui";
import { useToast } from "@/components/toast";

const NotePage = dynamic(() => import("@/components/pages/note-page").then((mod) => mod.NotePage), { ssr: false });
const TaskPage = dynamic(() => import("@/components/task/task-page").then((mod) => mod.TaskPage), { ssr: false });
const DiagramEditor = dynamic(() => import("@/components/diagrams/editor").then((mod) => mod.DiagramEditor), { ssr: false });
const PlotWorkspace = dynamic(() => import("@/components/plots/workspace").then((mod) => mod.PlotWorkspace), { ssr: false });

const KIND: Record<ShareKind, { label: string; icon: typeof FileText }> = {
  page: { label: "Page", icon: FileText },
  task: { label: "Task", icon: CheckSquare },
  board: { label: "Board", icon: Columns3 },
  diagram: { label: "Diagram", icon: Workflow },
  plot_space: { label: "Plot space", icon: LineChart },
  plot: { label: "Plot", icon: LineChart },
  meeting: { label: "Meeting notes", icon: CalendarCheck },
  skill: { label: "Skill", icon: BookOpen },
  workspace: { label: "Workspace", icon: Briefcase },
  code: { label: "Code", icon: FolderGit2 },
};

/** The live stream for one share: saves and presence on the shared item only. */
function useShareLive(shareId: string) {
  const client = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = async () => {
      try {
        const { ticket } = await api.eventsTicket();
        if (closed) return;
        source = new EventSource(`${eventsStreamUrl(HUB_API)}?ticket=${encodeURIComponent(ticket)}`, eventSourceInit());
        const relay = (event: string, name: string) =>
          source!.addEventListener(event, (frame) => {
            try {
              window.dispatchEvent(new CustomEvent(name, { detail: JSON.parse((frame as MessageEvent<string>).data) }));
            } catch {
              // ignore malformed frames
            }
          });
        relay("page", "ensemble:page");
        relay("diagram", "ensemble:diagram");
        source.addEventListener("page", () => invalidateSoon(client, ["page"]));
        source.addEventListener("task", () => {
          invalidateSoon(client, ["task"]);
          invalidateSoon(client, ["shared-board"]);
        });
        source.addEventListener("workspace", () => invalidateSoon(client, ["shared-workspace"]));
        source.addEventListener("presence", (frame) => {
          try {
            presenceStore.apply(JSON.parse((frame as MessageEvent<string>).data));
          } catch {
            // ignore malformed frames
          }
        });
        source.addEventListener("sharing.changed", () => void client.invalidateQueries({ queryKey: ["shared-open"] }));
        source.onerror = () => {
          source?.close();
          source = null;
          if (!closed) retry = window.setTimeout(() => void connect(), 4000);
        };
      } catch {
        if (!closed) retry = window.setTimeout(() => void connect(), 8000);
      }
    };
    void connect();
    // Who is here, then a heartbeat.
    void api.presence().then((data) => presenceStore.reset(data.people, data.you)).catch(() => undefined);
    const beat = () => void api.sendPresence({ tabId: tabId() }).catch(() => undefined);
    beat();
    const timer = window.setInterval(beat, 15_000);
    const sweep = window.setInterval(() => presenceStore.sweep(), 10_000);
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(timer);
      window.clearInterval(sweep);
      source?.close();
      // The share header is already cleared when this runs: name the share explicitly.
      void withShare(shareId, () => api.sendPresence({ tabId: tabId(), leave: true }, true)).catch(() => undefined);
      presenceStore.clear();
    };
  }, [client, shareId]);
}

function SharedBoard({ role }: { role: "view" | "edit" }) {
  const toast = useToast();
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const tasks = useQuery({ queryKey: ["shared-board"], queryFn: api.tasks });
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => api.moveTask(id, { status }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["shared-board"] }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const columns: TaskStatus[] = ["todo", "in_progress", "waiting_approval", "done"];
  const byStatus = (status: TaskStatus) => (tasks.data?.tasks ?? []).filter((task: TaskRecord) => (status === "todo" ? task.status === "todo" || task.status === "proposed" : task.status === status));
  return (
    <div className="flex h-full min-h-0 gap-0">
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3 overflow-x-auto p-4">
        {columns.map((status) => (
          <section key={status} className="flex min-h-0 flex-col rounded-lg bg-panel/60 p-2">
            <h3 className="mb-2 flex items-center justify-between px-1 text-[12px] font-medium text-muted">
              {STATUS[status].label}
              <span className="text-faint">{byStatus(status).length}</span>
            </h3>
            <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
              {byStatus(status).map((task) => (
                <div key={task.id} className="group rounded-md border border-line bg-bg px-2.5 py-2 text-[13px] hover:border-line-strong">
                  <button type="button" className="block w-full text-left" onClick={() => setOpen(task.id)}>
                    {task.title || "Untitled"}
                  </button>
                  {role === "edit" ? (
                    <select
                      aria-label="Status"
                      className="mt-1.5 rounded border border-line bg-transparent px-1 py-0.5 text-2xs text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
                      value={task.status}
                      onChange={(event) => move.mutate({ id: task.id, status: event.target.value as TaskStatus })}
                    >
                      {(Object.keys(STATUS) as TaskStatus[]).map((key) => (
                        <option key={key} value={key}>
                          {STATUS[key].label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {open ? (
        <aside className="relative w-[min(720px,55vw)] shrink-0 overflow-y-auto border-l border-line">
          <button type="button" className="icon-btn absolute right-3 top-3 z-10" aria-label="Close" onClick={() => setOpen(null)}>
            <X size={15} />
          </button>
          <TaskPage taskId={open} variant="peek" shared={{ role }} />
        </aside>
      ) : null}
    </div>
  );
}

function SharedSkill({ id, role }: { id: string; role: "view" | "edit" }) {
  const toast = useToast();
  const client = useQueryClient();
  const skill = useQuery({ queryKey: ["shared-skill", id], queryFn: () => api.skill(id) });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: string) => api.patchSkill(id, { body }),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["shared-skill", id] });
      toast("Saved.", { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  if (!skill.data) return <div className="p-10 text-muted">{skill.isError ? (skill.error as Error).message : "Loading…"}</div>;
  const record = skill.data.skill;
  return (
    <div className="mx-auto w-full max-w-[860px] px-6 py-8">
      <h1 className="text-[28px] font-semibold tracking-tight">{record.name}</h1>
      {record.description ? <p className="mt-1 text-[14px] text-muted">{record.description}</p> : null}
      {draft !== null ? (
        <>
          <textarea className="field mt-5 min-h-[420px] w-full font-mono text-[12.5px]" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <pre className="mt-5 whitespace-pre-wrap rounded-lg border border-line bg-panel p-4 font-mono text-[12.5px] leading-5">{record.body}</pre>
          {role === "edit" ? (
            <button type="button" className="btn mt-3" onClick={() => setDraft(record.body)}>
              Edit
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function SharedMeeting({ id }: { id: string }) {
  const meeting = useQuery({
    queryKey: ["shared-meeting", id],
    queryFn: async () => {
      try {
        const { session } = await api.meetingSession(id);
        return { title: session.title, when: session.startedAt, body: [session.recap, session.notes].filter(Boolean).join("\n\n"), decisions: [] as string[], actions: [] as string[] };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        const { note } = await api.importedMeetingNote(id);
        return { title: note.title, when: note.occurredAt, body: note.summary, decisions: note.decisions, actions: note.actionItems.map((item) => item.text) };
      }
    },
  });
  if (!meeting.data) return <div className="p-10 text-muted">{meeting.isError ? (meeting.error as Error).message : "Loading…"}</div>;
  const data = meeting.data;
  return (
    <div className="mx-auto w-full max-w-[820px] px-6 py-8">
      <h1 className="text-[28px] font-semibold tracking-tight">{data.title || "Meeting"}</h1>
      <p className="mt-1 text-[13px] text-muted">{new Date(data.when).toLocaleString()}</p>
      {data.body ? <div className="mt-6 whitespace-pre-wrap text-[14.5px] leading-6">{data.body}</div> : <p className="mt-6 text-muted">No notes were written.</p>}
      {data.decisions.length ? (
        <section className="mt-8">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Decisions</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px]">{data.decisions.map((line) => <li key={line}>{line}</li>)}</ul>
        </section>
      ) : null}
      {data.actions.length ? (
        <section className="mt-6">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Action items</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px]">{data.actions.map((line) => <li key={line}>{line}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function SharedWorkspace() {
  const board = useQuery({ queryKey: ["shared-workspace"], queryFn: api.workspace, refetchInterval: 15_000 });
  if (!board.data) return <div className="p-10 text-muted">{board.isError ? (board.error as Error).message : "Loading…"}</div>;
  const groups: Array<[string, Array<{ id: string; title: string; status: string; progress?: string | null; deviceName?: string | null }>]> = [
    ["Running", board.data.running ?? []],
    ["Waiting", board.data.waiting ?? []],
    ["Queued", board.data.queued ?? []],
  ];
  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-8">
      <h1 className="text-[24px] font-semibold tracking-tight">Agent workspace</h1>
      <p className="mt-1 text-[13px] text-muted">What the agents are doing in this space, live. View only.</p>
      {groups.map(([label, jobs]) => (
        <section key={label} className="mt-6">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-faint">
            {label} · {jobs.length}
          </h2>
          <div className="mt-2 divide-y divide-line rounded-lg border border-line">
            {jobs.length ? (
              jobs.map((job) => (
                <div key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{job.title}</span>
                  <span className="truncate text-2xs text-muted">{job.progress ?? job.status}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-2.5 text-[12.5px] text-muted">Nothing here.</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function SharedCode() {
  const reviews = useQuery({ queryKey: ["shared-code"], queryFn: () => api.reviews("all", false) });
  if (!reviews.data) return <div className="p-10 text-muted">{reviews.isError ? (reviews.error as Error).message : "Loading…"}</div>;
  const rows = reviews.data.reviews ?? [];
  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-8">
      <h1 className="text-[24px] font-semibold tracking-tight">Code</h1>
      <p className="mt-1 text-[13px] text-muted">Changes the agents made, view only. Accepting, rejecting and editing stay with the owner.</p>
      <div className="mt-5 divide-y divide-line rounded-lg border border-line">
        {rows.length ? (
          rows.map((review) => (
            <div key={review.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
              <FolderGit2 size={14} className="text-faint" />
              <span className="min-w-0 flex-1 truncate">{review.title}</span>
              <span className="text-2xs text-muted">
                {review.files} file{review.files === 1 ? "" : "s"} · <span className="text-ok">+{review.added}</span> <span className="text-danger">−{review.removed}</span>
              </span>
              <Tag>{review.completedAt ? "Reviewed" : "Needs review"}</Tag>
            </div>
          ))
        ) : (
          <div className="px-3 py-2.5 text-[12.5px] text-muted">No code changes to show.</div>
        )}
      </div>
    </div>
  );
}

function SharedPlot({ id }: { id: string }) {
  const plot = useQuery({ queryKey: ["shared-plot", id], queryFn: () => api.plot(id) });
  if (!plot.data) return <div className="p-10 text-muted">{plot.isError ? (plot.error as Error).message : "Loading…"}</div>;
  return (
    <div className="mx-auto w-full max-w-[860px] px-6 py-8">
      <h1 className="text-[24px] font-semibold tracking-tight">{plot.data.plot.title}</h1>
      {plot.data.plot.code ? <pre className="mt-5 whitespace-pre-wrap rounded-lg border border-line bg-panel p-4 font-mono text-[12px]">{plot.data.plot.code}</pre> : null}
    </div>
  );
}

function Body({ share }: { share: OpenedShare }) {
  const role = share.role;
  switch (share.kind) {
    case "page":
      return <NotePage pageId={share.resourceId} shared={{ role }} />;
    case "task":
      return <TaskPage taskId={share.resourceId} variant="page" shared={{ role }} />;
    case "diagram":
      return <DiagramEditor id={share.resourceId} shared={{ role }} />;
    case "plot_space":
      return <PlotWorkspace shared={{ spaceId: share.resourceId, role }} />;
    case "plot":
      return <SharedPlot id={share.resourceId} />;
    case "board":
      return <SharedBoard role={role} />;
    case "skill":
      return <SharedSkill id={share.resourceId} role={role} />;
    case "meeting":
      return <SharedMeeting id={share.resourceId} />;
    case "workspace":
      return <SharedWorkspace />;
    case "code":
      return <SharedCode />;
  }
}

function Opened({ share }: { share: OpenedShare }) {
  useShareLive(share.id);
  const kind = KIND[share.kind];
  const Icon = kind.icon;
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg text-ink">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3">
        <Link href="/shared" className="icon-btn" aria-label="Back to Shared with you" title="Shared with you">
          <ArrowLeft size={16} />
        </Link>
        <span className="flex items-center gap-1.5 rounded-md bg-panel px-2 py-1 text-2xs text-muted">
          <Icon size={12} /> {kind.label}
        </span>
        <span className="min-w-0 truncate text-[14px] font-medium">{share.title}</span>
        <span className="ml-auto flex items-center gap-3">
          <PagePeople kind={share.kind} id={share.resourceId} />
          <span className="hidden items-center gap-1.5 text-2xs text-muted sm:flex" title={`${share.owner.name} shared this with you`}>
            <Avatar person={share.owner} size={18} />
            Shared by {share.owner.name.split(" ")[0]} · {share.role === "edit" ? "can edit" : "view only"}
          </span>
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Body share={share} />
      </main>
    </div>
  );
}

/** /shared/[id]: one item someone shared with you, and nothing else of theirs. */
export function SharedViewer({ shareId }: { shareId: string }) {
  const [ready, setReady] = useState(false);
  // Every request from here on names this share; set before any child asks for anything.
  useLayoutEffect(() => {
    setOpenShare(shareId);
    setReady(true);
    return () => setOpenShare(null);
  }, [shareId]);
  const opened = useQuery({
    queryKey: ["shared-open", shareId],
    queryFn: () => api.openShare(shareId),
    enabled: ready,
    retry: false,
  });
  if (!ready || opened.isLoading) return <div className="grid h-dvh place-items-center text-[13px] text-muted">Opening…</div>;
  if (!opened.data) {
    const gone = opened.error instanceof ApiError && (opened.error.status === 404 || opened.error.status === 403);
    return (
      <div className="grid h-dvh place-items-center px-6">
        <div className="max-w-sm text-center">
          <ShieldOff size={28} className="mx-auto text-faint" />
          <h1 className="mt-3 text-[18px] font-semibold">{gone ? "This isn't shared with you anymore" : "Couldn't open this"}</h1>
          <p className="mt-1.5 text-[13px] leading-5 text-muted">
            {gone ? "The owner stopped sharing it, or the link belongs to someone else. Links only open for the person they were shared with." : (opened.error as Error | null)?.message}
          </p>
          <Link href="/shared" className="btn mt-4 inline-flex">
            Shared with you
          </Link>
        </div>
      </div>
    );
  }
  return <Opened share={opened.data} />;
}
