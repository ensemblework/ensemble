"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, GitBranch, MoreHorizontal, Target, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { isBakedParam } from "@/lib/desktop-param";
import { usePeek } from "@/components/shell/peek";
import { DiagramCard } from "@/components/diagrams/diagram-card";
import { LinkedSources } from "@/components/project/linked-sources";
import { AttachedItems } from "@/components/app-items/attached-items";
import { useModuleOn } from "@/lib/use-module";
import { MenuItem, Popover, PriorityTag, Spinner, StatusPill, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { useToast } from "@/components/toast";
import { PageTitleField } from "@/components/pages/title-field";
import { HumanDescription } from "@/components/pages/human-description";
import { PageLoadFailure } from "@/components/pages/page-load";
import { shortDate } from "@/lib/format";
import { MakeDiagramButton, projectDiagramPrompt } from "@/components/diagrams/make-diagram";

export function ProjectPage({ id, variant = "page" }: { id: string; variant?: "page" | "peek" }) {
  const client = useQueryClient();
  const peek = usePeek();
  const toast = useToast();
  const access = useSpaceAccess();
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.project(id).then(result => result.project),
    enabled: !isBakedParam(id),
  });
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchProject(id, data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project", id] });
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["context-board"] });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
    },
    onError: error => toast(error.message, { tone: "error" }),
  });

  if (project.isPending) return <div className="p-10"><Spinner /></div>;
  if (!project.data) return <PageLoadFailure kind="page" missing={false} error={project.error} retrying={project.isFetching} onRetry={() => void project.refetch()} />;
  const data = project.data;
  const personIds = data.people.map((row) => row.person.id);
  const repoIds = data.repoLinks.map((row) => row.repo.id);

  return (
    <div data-project-page className={`mx-auto w-full max-w-[900px] px-4 pb-24 ${variant === "peek" ? "pt-6 sm:px-8" : "pt-10 sm:px-16"}`}>
      <div className="mb-3 flex items-center justify-between gap-2 text-[12.5px] text-muted">
        <span><Link href="/context?tab=projects" className="hover:text-ink">Projects</Link> / {data.status}</span>
        {access.canEdit ? <Popover align="right" trigger={(open, toggle) => <button type="button" className="icon-btn" aria-label="More project actions" aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></button>}>{close => <div onClick={close}><MakeDiagramButton text={projectDiagramPrompt(id, data.name)} /></div>}</Popover> : null}
      </div>
      {access.canEdit ? <PageTitleField label="Project name" value={data.name} onSave={name => save.mutate({ name })} /> : <h1 className="text-[34px] font-bold">{data.name}</h1>}
      <HumanDescription value={data.summary} editing={summaryEditing} onEditing={setSummaryEditing} onSave={summary => save.mutate({ summary })} readOnly={!access.canEdit} />
      {!data.summary && access.canEdit ? <button type="button" className="btn-ghost mt-2" onClick={() => setSummaryEditing(true)}>Add summary</button> : null}

      <div className="mt-6 space-y-1 text-[13.5px]" inert={!access.canEdit}>
        <div className="flex min-h-[32px] items-center gap-2">
          <span className="flex w-[110px] shrink-0 items-center gap-2 text-muted"><Users size={14} /> People</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex min-w-0 flex-wrap gap-1.5 rounded px-1.5 py-0.5">
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
          <span className="flex w-[110px] shrink-0 items-center gap-2 text-muted"><GitBranch size={14} /> Repositories</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex min-w-0 flex-wrap gap-1.5 rounded px-1.5 py-0.5">
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
          <span className="flex w-[110px] shrink-0 items-center gap-2 text-muted"><Target size={14} /> Status</span>
          <button type="button" className="row-tile -mx-1.5 rounded px-1.5 py-0.5" onClick={() => save.mutate({ status: data.status === "active" ? "done" : "active" })}>
            <Tag tone={data.status === "active" ? "blue" : "green"}>{data.status}</Tag>
          </button>
        </div>
        <LinkedSources projectId={id} projectName={data.name} />
      </div>
      <AttachedItems projectId={id} className="mt-5" />

      <section className="mt-8" data-project-notes>
        <HumanDescription value={data.notes} editing={notesEditing} onEditing={setNotesEditing} onSave={notes => save.mutate({ notes })} readOnly={!access.canEdit} />
        {!data.notes && access.canEdit ? <button type="button" className="btn-ghost" onClick={() => setNotesEditing(true)}>Add notes</button> : null}
      </section>
      <DiagramList projectId={id} deliverableIds={data.deliverables.map((row) => row.id)} />

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Deliverables</h2>
      {data.deliverables.length === 0 ? <p className="text-[13px] text-muted">No deliverables.</p> : (
        <div className="space-y-1">
          {data.deliverables.map((row) => (
            <div key={row.id} className="row-tile flex flex-wrap items-center justify-between gap-2 rounded-md border-b border-b-line px-2 py-2 text-[13.5px]">
              <button type="button" className="min-w-0 flex-1 text-left font-medium [overflow-wrap:anywhere]" onClick={() => peek.open(row.id, "deliverable")}>{row.title}</button>
              <span className="flex items-center gap-2 text-[12px] text-muted">
                {row.due ? shortDate(row.due) : null}
                <Tag tone={row.status === "completed" ? "green" : "gray"}>{row.status}</Tag>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Tasks</h2>
      {data.tasks.length === 0 ? <p className="text-[13px] text-muted">No tasks.</p> : (
        <div className="space-y-1">
          {data.tasks.map((task) => (
            <button key={task.id} type="button" onClick={() => peek.open(task.id)} className="row-tile flex w-full items-center gap-3 rounded-md border-b border-b-line px-2 py-2 text-left">
              <FileText size={13} className="text-faint" />
              <span className="min-w-0 flex-1 text-[13.5px] font-medium [overflow-wrap:anywhere]">{task.title}</span>
              <PriorityTag priority={task.priority} />
              <StatusPill status={task.status} />
            </button>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-10 text-[17px] font-semibold">Meeting notes</h2>
      {data.meetingNotes.length === 0 ? <p className="text-[13px] text-muted">No meeting notes.</p> : (
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
