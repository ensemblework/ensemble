"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { usePeek } from "@/components/shell/peek";
import { api, type ProjectRecord } from "@/lib/api";
import { plural } from "@/lib/format";
import { useToast } from "../toast";
import { Spinner, Tag } from "../ui";
import { LoadError } from "../load-error";
import { markNewProject, UNTITLED_PROJECT } from "../project/new-project";

function ProjectCard({ project }: { project: ProjectRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => {
      toast(`Deleted ${project.name}. Restore it from Settings → Deleted items.`);
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <div className="tile lift group relative flex flex-col rounded-xl bg-panel p-4 text-[13px]">
      <button
        type="button"
        className="icon-btn absolute right-2 top-2 h-6 w-6 opacity-0 group-hover:opacity-100"
        title="Delete project"
        onClick={() => remove.mutate()}
      >
        <Trash2 size={13} />
      </button>
      <button type="button" title={project.name} className="flex min-w-0 items-center gap-2 pr-6 text-left text-[15px] font-semibold leading-5 hover:underline" onClick={() => peek.open(project.id, "project")}>
        <span className={project.name === UNTITLED_PROJECT ? "min-w-0 truncate text-muted" : "min-w-0 truncate"} data-project-name>{project.name}</span>
        {project.status === "done" ? <Tag tone="green">done</Tag> : null}
      </button>
      {project.summary ? <p className="mt-2 line-clamp-3 text-[12.5px] leading-[18px] text-muted">{project.summary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {project.people.map((person) => (
          <span key={person.id} className="chip" style={{ ["--chip" as string]: "var(--kind-people)" }}>
            {person.name}
          </span>
        ))}
        {project.repos.map((repo) => (
          <span key={repo.id} className="chip" style={{ ["--chip" as string]: "var(--kind-repo)" }}>
            {repo.fullName}
          </span>
        ))}
      </div>
      <div className="mt-auto pt-3 text-[12px] text-faint">
        {plural(project.taskCount, "task")} · {plural(project.deliverableCount, "deliverable")}
      </div>
    </div>
  );
}

/** New project works like New page: it is created at once, untitled, and opens with its name focused. */
export function ProjectsTab({ ids = "" }: { ids?: string }) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const toast = useToast();
  const peek = usePeek();
  const create = useMutation({
    mutationFn: () => api.createProject(),
    onSuccess: ({ project }) => {
      markNewProject(project.id);
      void client.invalidateQueries({ queryKey: ["projects"] });
      peek.open(project.id, "project");
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const allow = ids ? new Set(ids.split(",").filter(Boolean)) : null;
  const list = (projects.data?.projects ?? []).filter((project) => !allow || allow.has(project.id));
  const newButton = <button type="button" className="btn" disabled={create.isPending} aria-busy={create.isPending || undefined} onClick={(event) => { if (event.detail < 2) create.mutate(); }}><Plus size={13} /> New project</button>;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{plural(list.length, "project")}</span>
        {newButton}
      </div>
      {projects.isPending ? (
        <Spinner />
      ) : projects.isError && !projects.data ? (
        <LoadError error={projects.error} onRetry={() => void projects.refetch()} retrying={projects.isFetching} what="your projects" />
      ) : list.length === 0 ? (
        allow ? <p className="py-6 text-center text-[13px] text-muted">No projects on today's work.</p> : (
          <button type="button" className="project-empty" onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus size={16} />
            <span><strong>Start a project</strong><small>A page for the goal, with its tasks, deliverables and meeting notes in one place.</small></span>
          </button>
        )
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-3">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
