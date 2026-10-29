"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, GitBranch, MoreHorizontal, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { isBakedParam } from "@/lib/desktop-param";
import { DiagramCard } from "@/components/diagrams/diagram-card";
import { LinkedSources } from "@/components/project/linked-sources";
import { AttachedItems } from "@/components/app-items/attached-items";
import { useModuleOn } from "@/lib/use-module";
import { MenuItem, Popover, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { useToast } from "@/components/toast";
import { PageTitleField } from "@/components/pages/title-field";
import { HumanDescription } from "@/components/pages/human-description";
import { PageLoadFailure } from "@/components/pages/page-load";
import { MakeDiagramButton, projectDiagramPrompt } from "@/components/diagrams/make-diagram";
import { ProjectBody } from "./project-body";
import { LinkedWork } from "./linked-work";
import { takeNewProject, UNTITLED_PROJECT } from "./new-project";


export function ProjectPage({ id, variant = "page" }: { id: string; variant?: "page" | "peek" }) {
  const client = useQueryClient();
  const toast = useToast();
  const access = useSpaceAccess();
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [focusTitle] = useState(() => takeNewProject(id));
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
    <div data-project-page className={`project-page mx-auto w-full max-w-[860px] px-4 pb-24 ${variant === "peek" ? "pt-6 sm:px-8" : "pt-10 sm:px-14"}`}>
      <div className="mb-4 flex items-center justify-between gap-2 text-[12.5px] text-muted">
        <span className="flex min-w-0 items-center gap-1.5"><Link href="/context?tab=projects" className="hover:text-ink">Projects</Link><span className="text-faint">/</span><span className="truncate">{data.name === UNTITLED_PROJECT ? "Untitled" : data.name}</span></span>
        {access.canEdit ? <Popover align="right" trigger={(open, toggle) => <button type="button" className="icon-btn" aria-label="More project actions" aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></button>}>{close => <div onClick={close}>
          <MenuItem onClick={() => save.mutate({ status: data.status === "active" ? "done" : "active" })}>{data.status === "active" ? "Mark project done" : "Reopen project"}</MenuItem>
          <MakeDiagramButton text={projectDiagramPrompt(id, data.name)} />
        </div>}</Popover> : null}
      </div>
      {access.canEdit ? <PageTitleField label="Project name" untitled={UNTITLED_PROJECT} autoFocus={focusTitle} value={data.name} onSave={name => save.mutate({ name })} /> : <h1 className="text-[34px] font-bold">{data.name}</h1>}
      <HumanDescription value={data.summary} editing={summaryEditing} onEditing={setSummaryEditing} onSave={summary => save.mutate({ summary })} readOnly={!access.canEdit} />
      {!data.summary && access.canEdit && !summaryEditing ? <button type="button" className="mt-1 text-[13.5px] text-faint hover:text-muted" onClick={() => setSummaryEditing(true)}>Add a one-line summary</button> : null}

      <div className="project-props mt-5" inert={!access.canEdit}>
        <div className="project-prop">
          <span className="project-prop-label"><CircleCheck size={14} /> Status</span>
          <button type="button" className="row-tile -mx-1.5 rounded px-1.5 py-0.5" onClick={() => save.mutate({ status: data.status === "active" ? "done" : "active" })} aria-label={`Status: ${data.status === "active" ? "Active" : "Done"}. Click to change.`}>
            <Tag tone={data.status === "active" ? "blue" : "green"}>{data.status === "active" ? "Active" : "Done"}</Tag>
          </button>
        </div>
        <div className="project-prop">
          <span className="project-prop-label"><Users size={14} /> People</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex min-w-0 flex-wrap gap-1.5 rounded px-1.5 py-0.5">
                {data.people.length ? data.people.map((row) => <Tag key={row.person.id} tone="pink">{row.person.name}</Tag>) : <span className="text-faint">Add people</span>}
              </button>
            )}
          >
            {() =>
              (people.data?.people ?? []).length ? (people.data?.people ?? []).map((person) => {
                const on = personIds.includes(person.id);
                return (
                  <MenuItem key={person.id} active={on} hint={on ? "✓" : undefined}
                    onClick={() => save.mutate({ personIds: on ? personIds.filter((value) => value !== person.id) : [...personIds, person.id] })}>
                    {person.name}
                  </MenuItem>
                );
              }) : <p className="px-2 py-2 text-[12.5px] text-muted">No people yet. Add them in Context › People.</p>
            }
          </Popover>
        </div>
        <div className="project-prop">
          <span className="project-prop-label"><GitBranch size={14} /> Repositories</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile -mx-1.5 flex min-w-0 flex-wrap gap-1.5 rounded px-1.5 py-0.5">
                {data.repoLinks.length ? data.repoLinks.map((row) => <Tag key={row.repo.id} tone="green">{row.repo.fullName}</Tag>) : <span className="text-faint">Add repositories</span>}
              </button>
            )}
          >
            {() =>
              (repos.data?.repos ?? []).length ? (repos.data?.repos ?? []).map((repo) => {
                const on = repoIds.includes(repo.id);
                return (
                  <MenuItem key={repo.id} active={on} hint={on ? "✓" : undefined}
                    onClick={() => save.mutate({ repoIds: on ? repoIds.filter((value) => value !== repo.id) : [...repoIds, repo.id] })}>
                    {repo.fullName}
                  </MenuItem>
                );
              }) : <p className="px-2 py-2 text-[12.5px] text-muted">No repositories yet. Add them in Context › Repos.</p>
            }
          </Popover>
        </div>
        <LinkedSources projectId={id} projectName={data.name} />
      </div>
      <AttachedItems projectId={id} className="mt-4" />

      <div className="project-divider" />
      <ProjectBody key={id} project={data} editable={access.canEdit} />
      <LinkedWork project={data} editable={access.canEdit} />
      <DiagramList projectId={id} deliverableIds={data.deliverables.map((row) => row.id)} />
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
    <section className="mt-8">
      <h2 className="mb-2 text-[15px] font-semibold">Diagrams</h2>
      <div className="space-y-3">
        {diagrams.map((link) => (
          <DiagramCard key={link.diagram.id} id={link.diagram.id} label={link.diagram.title} />
        ))}
      </div>
    </section>
  );
}
