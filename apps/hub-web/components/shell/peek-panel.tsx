"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { API, api, type DeliverableRecord } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { TaskPage } from "../task/task-page";
import { usePeek, type PeekKind } from "./peek";
import { ShareButton } from "../sharing/share-dialog";

type ProjectDetail = {
  id: string;
  name: string;
  summary: string;
  status: "active" | "done";
  deliverables: Array<{ id: string; title: string; status: string; due: string | null }>;
  tasks: Array<{ id: string; title: string; status: string }>;
};

async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`${API}/api/projects/${id}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Project not found.");
  return ((await response.json()) as { project: ProjectDetail }).project;
}

export function PeekPanel({ id, kind = "task" }: { id: string; kind?: PeekKind }) {
  const router = useRouter();
  const { close, fullscreen, setFullscreen, open } = usePeek();
  const task = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id), enabled: kind === "task" });
  const deliverables = useQuery({
    queryKey: ["deliverables", true],
    queryFn: () => api.deliverables(true),
    enabled: kind === "deliverable",
  });
  const project = useQuery({ queryKey: ["project", id], queryFn: () => fetchProject(id), enabled: kind === "project" });
  const deliverable = (deliverables.data?.deliverables ?? []).find((row) => row.id === id);
  const title =
    kind === "task" ? (task.data?.task.title ?? "Page") : kind === "deliverable" ? (deliverable?.title ?? "Deliverable") : (project.data?.name ?? "Project");
  const fullHref = kind === "project" ? `/projects/${id}` : kind === "task" ? `/tasks/${id}` : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-peek-kind={kind}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</div>
        {fullHref ? (
          <button type="button" className="icon-btn" title="Open as full page" aria-label="Open as full page" onClick={() => router.push(fullHref)}>
            <SquareArrowOutUpRight size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title={fullscreen ? "Back to side peek" : "Full screen"}
          aria-label={fullscreen ? "Back to side peek" : "Full screen"}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {kind === "task" ? <ShareButton compact target={{ kind: "task", resourceId: id, title: task.data?.task.title ?? "Task" }} /> : null}
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
        <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind === "task" ? <TaskPage taskId={id} variant="peek" /> : null}
        {kind === "deliverable" ? <DeliverablePeek row={deliverable} onOpenProject={(projectId) => open(projectId, "project")} /> : null}
        {kind === "project" ? (
          <ProjectPeek
            project={project.data}
            missing={project.isError}
            onOpenTask={(taskId) => open(taskId, "task")}
            onOpenDeliverable={(deliverableId) => open(deliverableId, "deliverable")}
          />
        ) : null}
      </div>
    </div>
  );
}

function DeliverablePeek({ row, onOpenProject }: { row: DeliverableRecord | undefined; onOpenProject: (projectId: string) => void }) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchDeliverable(row!.id, data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["deliverables"] });
      void client.invalidateQueries({ queryKey: ["home"] });
    },
  });
  if (!row) return <p className="p-6 text-[13.5px] text-muted">This deliverable is not on the list.</p>;
  const done = row.status === "completed";
  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <input
        aria-label="Deliverable title"
        defaultValue={row.title}
        key={row.title}
        className="field w-full bg-transparent text-[28px] font-semibold leading-tight"
        onBlur={(event) => {
          const title = event.target.value.trim();
          if (title && title !== row.title) save.mutate({ title });
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
        <button type="button" className="btn" onClick={() => onOpenProject(row.projectId)}>
          {row.project.name}
        </button>
        <button type="button" className="btn" aria-pressed={done} onClick={() => save.mutate({ status: done ? "upcoming" : "completed" })}>
          {done ? "Completed" : "Upcoming"}
        </button>
        {row.due ? <span className="text-muted">Due {shortDate(row.due)}</span> : null}
      </div>
    </div>
  );
}

function ProjectPeek({
  project,
  missing,
  onOpenTask,
  onOpenDeliverable,
}: {
  project: ProjectDetail | undefined;
  missing: boolean;
  onOpenTask: (id: string) => void;
  onOpenDeliverable: (id: string) => void;
}) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchProject(project!.id, data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project", project!.id] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  if (missing) return <p className="p-6 text-[13.5px] text-muted">Project not found.</p>;
  if (!project) return <div className="p-6"><div className="skeleton h-8 w-48" /></div>;
  return (
    <div className="mx-auto max-w-[720px] px-6 py-8">
      <input
        aria-label="Project name"
        defaultValue={project.name}
        key={project.name}
        className="field w-full bg-transparent text-[28px] font-semibold leading-tight"
        onBlur={(event) => {
          const name = event.target.value.trim();
          if (name && name !== project.name) save.mutate({ name });
        }}
      />
      <textarea
        aria-label="Project summary"
        defaultValue={project.summary}
        key={`${project.id}:${project.summary}`}
        placeholder="Add a summary…"
        className="field mt-3 min-h-16 w-full bg-transparent text-[14px] leading-6"
        onBlur={(event) => {
          if (event.target.value !== project.summary) save.mutate({ summary: event.target.value });
        }}
      />
      <h2 className="mt-6 text-[13px] font-medium text-muted">Deliverables</h2>
      <ul className="mt-2 space-y-1">
        {project.deliverables.length ? (
          project.deliverables.map((row) => (
            <li key={row.id}>
              <button type="button" className="row-tile w-full rounded-lg px-2 py-1.5 text-left text-[13.5px]" onClick={() => onOpenDeliverable(row.id)}>
                {row.title}
                {row.due ? <span className="ml-2 text-[12px] text-muted">{shortDate(row.due)}</span> : null}
              </button>
            </li>
          ))
        ) : (
          <li className="text-[13px] text-muted">No deliverables yet.</li>
        )}
      </ul>
      <h2 className="mt-6 text-[13px] font-medium text-muted">Tasks</h2>
      <ul className="mt-2 space-y-1">
        {project.tasks.length ? (
          project.tasks.map((row) => (
            <li key={row.id}>
              <button type="button" className="row-tile w-full rounded-lg px-2 py-1.5 text-left text-[13.5px]" onClick={() => onOpenTask(row.id)}>
                {row.title}
              </button>
            </li>
          ))
        ) : (
          <li className="text-[13px] text-muted">No tasks yet.</li>
        )}
      </ul>
    </div>
  );
}
