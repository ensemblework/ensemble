"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { usePeek } from "@/components/shell/peek";
import { api, type ProjectRecord } from "@/lib/api";
import { plural } from "@/lib/format";
import { useToast } from "../toast";
import { Dialog, Empty, Field, Spinner, Tag } from "../ui";

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
      <button type="button" className="flex items-center gap-2 pr-6 text-left text-[15px] font-semibold leading-5 hover:underline" onClick={() => peek.open(project.id, "project")}>
        <span className="kind-dot" style={{ ["--kind" as string]: "var(--kind-project)" }} />
        {project.name}
        {project.status === "done" ? <Tag tone="green">done</Tag> : null}
      </button>
      <p className="mt-2 line-clamp-3 text-[12.5px] leading-[18px] text-muted">{project.summary || "No summary yet."}</p>
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

export function ProjectsTab({ ids = "" }: { ids?: string }) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const create = useMutation({
    mutationFn: () => api.createProject({ name, summary }),
    onSuccess: () => {
      setAdding(false);
      setName("");
      setSummary("");
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const allow = ids ? new Set(ids.split(",").filter(Boolean)) : null;
  const list = (projects.data?.projects ?? []).filter((project) => !allow || allow.has(project.id));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{plural(list.length, "project")}</span>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus size={13} /> New project
        </button>
      </div>
      {projects.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>
          {allow ? "No projects on today's work." : "No projects yet. They are inferred from recurring threads and repos, or you can create one."}
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="New project">
        <div className="space-y-3">
          <Field label="Name">
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="field w-full" />
          </Field>
          <Field label="What is it, in a sentence or two?">
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} className="field w-full" />
          </Field>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={!name.trim()} onClick={() => create.mutate()}>
              Create
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
