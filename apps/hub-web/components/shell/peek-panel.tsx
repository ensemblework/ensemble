"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, SquareArrowOutUpRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { api, type DeliverableRecord } from "@/lib/api";
import { ProjectPage } from "../project/project-page";
import { shortDate } from "@/lib/format";
import { TaskPage } from "../task/task-page";
import { usePeek, type PeekKind } from "./peek";
import { ShareButton } from "../sharing/share-dialog";
import { TaskExportMenu } from "../task/task-export";


export function PeekPanel({ id, kind = "task" }: { id: string; kind?: PeekKind }) {
  const router = useRouter();
  const { close, fullscreen, setFullscreen, open } = usePeek();
  const task = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id), enabled: kind === "task" });
  const deliverables = useQuery({
    queryKey: ["deliverables", true],
    queryFn: () => api.deliverables(true),
    enabled: kind === "deliverable",
  });
  const project = useQuery({ queryKey: ["project", id], queryFn: () => api.project(id).then(result => result.project), enabled: kind === "project" });
  const deliverable = (deliverables.data?.deliverables ?? []).find((row) => row.id === id);
  const title =
    kind === "task" ? (task.data?.task.title ?? "Page") : kind === "deliverable" ? (deliverable?.title ?? "Deliverable") : (project.data?.name ?? "Project");
  const fullHref = kind === "project" ? `/projects/${id}` : kind === "task" ? `/tasks/${id}` : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-peek-kind={kind}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</div>
        {fullHref ? (
          <button type="button" className="icon-btn" title="Open as full page" aria-label="Open as full page" onClick={() => { close(); router.push(fullHref); }}>
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
        {kind === "task" ? <TaskExportMenu taskId={id} /> : null}
        {kind === "task" ? <ShareButton compact target={{ kind: "task", resourceId: id, title: task.data?.task.title ?? "Task" }} /> : null}
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
        <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind === "task" ? <TaskPage taskId={id} variant="peek" /> : null}
        {kind === "deliverable" ? <DeliverablePeek row={deliverable} onOpenProject={(projectId) => open(projectId, "project")} /> : null}
        {kind === "project" ? <ProjectPage key={id} id={id} variant="peek" /> : null}
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
        data-peek-escape
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
