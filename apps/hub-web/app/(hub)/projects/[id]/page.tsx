"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderKanban, GitBranch, Target, Users } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";
import { usePeek } from "@/components/shell/peek";
import { DiagramCard } from "@/components/diagrams/diagram-card";
import { LinkedSources } from "@/components/project/linked-sources";
import { useModuleOn } from "@/lib/use-module";
import { MakeDiagramButton, deliverableDiagramPrompt, projectDiagramPrompt } from "@/components/diagrams/make-diagram";
import { Empty, InlineEdit, MenuItem, Popover, PriorityTag, Spinner, StatusPill, Tag } from "@/components/ui";
import { API, api, type TaskStatus } from "@/lib/api";
import { shortDate } from "@/lib/format";

type ProjectDetail = {
  id: string;
  name: string;
  summary: string;
  notes: string;
  status: "active" | "done";
  people: Array<{ person: { id: string; name: string; email: string | null } }>;
  repoLinks: Array<{ repo: { id: string; fullName: string; url: string | null } }>;
  deliverables: Array<{ id: string; title: string; status: string; due: string | null }>;
  tasks: Array<{ id: string; title: string; status: TaskStatus; priority: "critical" | "p0" | "p1" | "p2" }>;
  meetingNotes: Array<{ id: string; title: string; askedAt: string }>;
};

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: baked } = use(params);
  const id = useDesktopParam(baked);
  const client = useQueryClient();
  const peek = usePeek();
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => fetchProject(id),
    enabled: !isBakedParam(id),
  });
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchProject(id, data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project", id] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  if (project.isPending) return <div className="p-10"><Spinner /></div>;
  if (!project.data) return <div className="p-10 text-muted">Project not found.</div>;
  const data = project.data;
  const personIds = data.people.map((row) => row.person.id);
  const repoIds = data.repoLinks.map((row) => row.repo.id);

  return (
    <div className="mx-auto max-w-[900px] px-16 pb-24 pt-10">
      <div className="mb-2 text-[12.5px] text-muted">
        <Link href="/context?tab=projects" className="hover:text-ink">Projects</Link> / {data.status}
      </div>
      <div className="flex items-center gap-3">
        <FolderKanban size={26} className="text-muted" />
        <InlineEdit value={data.name} onSave={(name) => save.mutate({ name })} className="text-[32px] font-bold tracking-tight" />
        <div className="ml-auto">
          <MakeDiagramButton text={projectDiagramPrompt(id, data.name)} />
        </div>
      </div>
      <div className="mt-3">
        <InlineEdit value={data.summary} placeholder="Add a summary…" multiline onSave={(summary) => save.mutate({ summary })} className="text-[14px] leading-6 text-ink/85" />
      </div>

      <div className="mt-6 space-y-1 text-[13.5px]">
        <div className="flex min-h-[32px] items-center gap-2">
          <span className="flex w-[140px] items-center gap-2 text-muted"><Users size={14} /> People</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex flex-wrap gap-1.5 rounded px-1.5 py-0.5">
                {data.people.length ? data.people.map((row) => <Tag key={row.person.id} tone="pink">{row.person.name}</Tag>) : <span className="text-faint">Empty</span>}
              </button>
            )}
          >
            {() =>
              (people.data?.people ?? []).map((person) => {
                const on = personIds.includes(person.id);
                return (
                  <MenuItem key={person.id} active={on} hint={on ? "✓" : undefined}
                    onClick={() => save.mutate({ personIds: on ? personIds.filter((value) => value !== person.id) : [...personIds, person.id] })}>
                    {person.name}
                  </MenuItem>
                );
              })
            }
          </Popover>
        </div>
        <div className="flex min-h-[32px] items-center gap-2">
          <span className="flex w-[140px] items-center gap-2 text-muted"><GitBranch size={14} /> Repositories</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex flex-wrap gap-1.5 rounded px-1.5 py-0.5">
                {data.repoLinks.length ? data.repoLinks.map((row) => <Tag key={row.repo.id} tone="green">{row.repo.fullName}</Tag>) : <span className="text-faint">Empty</span>}
              </button>
            )}
          >
            {() =>
              (repos.data?.repos ?? []).map((repo) => {
                const on = repoIds.includes(repo.id);
                return (
                  <MenuItem key={repo.id} active={on} hint={on ? "✓" : undefined}
                    onClick={() => save.mutate({ repoIds: on ? repoIds.filter((value) => value !== repo.id) : [...repoIds, repo.id] })}>
                    {repo.fullName}
                  </MenuItem>
                );
              })
            }
          </Popover>
        </div>
        <div className="flex min-h-[32px] items-center gap-2">
          <span className="flex w-[140px] items-center gap-2 text-muted"><Target size={14} /> Status</span>
          <button type="button" className="row-tile -mx-1.5 rounded px-1.5 py-0.5" onClick={() => save.mutate({ status: data.status === "active" ? "done" : "active" })}>
            <Tag tone={data.status === "active" ? "blue" : "green"}>{data.status}</Tag>
          </button>
        </div>
        <LinkedSources projectId={id} projectName={data.name} />
      </div>

      <DiagramList projectId={id} deliverableIds={data.deliverables.map((row) => row.id)} />

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Deliverables</h2>
      {data.deliverables.length === 0 ? <Empty>No deliverables.</Empty> : (
        <div className="space-y-1">
          {data.deliverables.map((row) => (
            <div key={row.id} className="row-tile flex items-center justify-between rounded-md border-b border-b-line px-2 py-2 text-[13.5px]">
              <span className="font-medium">{row.title}</span>
              <span className="flex items-center gap-2 text-[12px] text-muted">
                {row.due ? shortDate(row.due) : null}
                <Tag tone={row.status === "completed" ? "green" : "gray"}>{row.status}</Tag>
                <MakeDiagramButton text={deliverableDiagramPrompt(row.id, row.title)} />
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Tasks</h2>
      {data.tasks.length === 0 ? <Empty>No tasks linked to this project.</Empty> : (
        <div className="space-y-1">
          {data.tasks.map((task) => (
            <button key={task.id} type="button" onClick={() => peek.open(task.id)} className="row-tile flex w-full items-center gap-3 rounded-md border-b border-b-line px-2 py-2 text-left">
              <FileText size={13} className="text-faint" />
              <span className="flex-1 text-[13.5px] font-medium">{task.title}</span>
              <PriorityTag priority={task.priority} />
              <StatusPill status={task.status} />
            </button>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Meeting notes</h2>
      {data.meetingNotes.length === 0 ? <Empty>No meeting notes linked yet.</Empty> : (
        <div className="space-y-1">
          {data.meetingNotes.map((note) => (
            <div key={note.id} className="row-tile flex items-center justify-between rounded-md px-2 py-2 text-[13.5px]">
              <span>{note.title}</span>
              <span className="text-[12px] text-muted">{shortDate(note.askedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiagramList({ projectId, deliverableIds }: { projectId: string; deliverableIds: string[] }) {
  const diagramsOn = useModuleOn("diagrams");
  const links = useQuery({ queryKey: ["diagram-links"], queryFn: () => api.diagramLinks(), enabled: diagramsOn });
  const rows = (links.data?.links ?? []).filter(
    (link) =>
      (link.targetKind === "project" && link.targetId === projectId) ||
      (link.targetKind === "deliverable" && deliverableIds.includes(link.targetId)),
  );
  const seen = new Set<string>();
  const diagrams = rows.filter((link) => (seen.has(link.diagram.id) ? false : (seen.add(link.diagram.id), true)));
  if (!diagramsOn || !diagrams.length) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-2 text-[17px] font-semibold">Diagrams</h2>
      <div className="space-y-3">
        {diagrams.map((link) => (
          <DiagramCard key={link.diagram.id} id={link.diagram.id} label={link.diagram.title} />
        ))}
      </div>
    </section>
  );
}

async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`${API}/api/projects/${id}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Project not found.");
  return ((await response.json()) as { project: ProjectDetail }).project;
}
