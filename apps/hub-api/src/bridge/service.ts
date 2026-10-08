import type { Prisma, PrismaClient } from "@prisma/client";
import { hasModule, PageDocument } from "@ensemble/shared-types";
import { pageText as pageDocumentText } from "../pages/markdown.js";
import { env } from "../config.js";
import { DATA_GAPS, REFERENCE_NOTE, UNTRUSTED_NOTE } from "./gaps.js";
import { distinctById, OPEN_STATUSES, resolveBriefAnchor, type TaskRef } from "./resolve.js";
import {
  excerpt,
  hubUrl,
  isUuid,
  normalizeRepoName,
  pageText,
  plainFromJson,
  trustForIngested,
  zonedDayRange,
} from "./text.js";
import { visibleArtifacts } from "../sharing/context.js";

type Db = PrismaClient;

const TASK_PUBLIC = {
  id: true,
  title: true,
  description: true,
  notes: true,
  status: true,
  priority: true,
  owner: true,
  complexity: true,
  due: true,
  todayFocus: true,
  sourceKind: true,
  sourceUrl: true,
  excerpt: true,
  taskType: true,
  projectId: true,
  repoId: true,
  deliverableId: true,
  people: true,
  skillIds: true,
  snoozedUntil: true,
  updatedAt: true,
  createdAt: true,
} satisfies Prisma.TaskSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function taskCard(task: {
  id: string;
  title: string;
  status: string;
  priority: string;
  owner: string;
  due: Date | null;
  projectId: string | null;
  repoId: string | null;
  updatedAt: Date;
  description?: string;
  todayFocus?: string;
}, names?: { project?: string | null; repo?: string | null }) {
  return {
    id: task.id,
    kind: "task" as const,
    title: task.title,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    due: iso(task.due),
    updatedAt: task.updatedAt.toISOString(),
    projectId: task.projectId,
    project: names?.project ?? null,
    repoId: task.repoId,
    repo: names?.repo ?? null,
    todayFocus: task.todayFocus,
    descriptionExcerpt: task.description ? excerpt(task.description).excerpt : "",
    url: hubUrl(`/tasks/${task.id}`),
    trust: "hub" as const,
    trustLabel: "A task stored in your Ensemble Hub.",
  };
}

function toRef(task: { id: string; title: string; status: string; updatedAt: Date; repoId: string | null; projectId: string | null }): TaskRef {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt.toISOString(),
    repoId: task.repoId,
    projectId: task.projectId,
  };
}

export async function listTasks(db: Db, userId: string, query: { status?: string; q?: string; limit: number }) {
  const tasks = await db.task.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" } },
              { description: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: query.limit,
    select: {
      ...TASK_PUBLIC,
      project: { select: { name: true } },
      repo: { select: { fullName: true } },
    },
  });
  return {
    tasks: tasks.map((task) => taskCard(task, { project: task.project?.name, repo: task.repo?.fullName })),
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

export async function listProjects(db: Db, userId: string, query: { q?: string; limit: number }) {
  const projects = await db.project.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { summary: { contains: query.q, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: { name: "asc" },
    take: query.limit,
    include: {
      _count: { select: { tasks: { where: { deletedAt: null } }, deliverables: { where: { deletedAt: null } } } },
    },
  });
  return {
    projects: projects.map((project) => ({
      id: project.id,
      kind: "project" as const,
      name: project.name,
      summary: excerpt(project.summary, 320).excerpt,
      status: project.status,
      taskCount: project._count.tasks,
      deliverableCount: project._count.deliverables,
      url: hubUrl(`/projects/${project.id}`),
      trust: "hub" as const,
      trustLabel: "A project page stored in your Ensemble Hub.",
    })),
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

export async function listDiagrams(db: Db, userId: string, query: { q?: string; limit: number }) {
  const rows = await db.blockDiagram.findMany({
    where: {
      userId,
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    select: { id: true, title: true, updatedAt: true, source: true },
  });
  return {
    diagrams: rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      excerpt: row.source.slice(0, 400),
      url: hubUrl(`/diagrams/${row.id}`),
      trust: "hub" as const,
      trustLabel: "A block diagram stored in your Ensemble Hub.",
    })),
    notes: "Diagram writes are not on this bridge. Create and edit diagrams from the Hub assistant.",
  };
}

export async function listPlots(db: Db, userId: string, query: { q?: string; limit: number }) {
  const rows = await db.plot.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    select: { id: true, title: true, updatedAt: true, dataset: { select: { name: true } } },
  });
  return {
    plots: rows.map((row) => ({
      id: row.id,
      title: row.title,
      dataset: row.dataset?.name ?? null,
      updatedAt: row.updatedAt.toISOString(),
      url: hubUrl(`/plots/${row.id}`),
      trust: "hub" as const,
      trustLabel: "A plot stored in your Ensemble Hub.",
    })),
    notes: "Plot writes are not on this bridge. Create and edit plots from the Hub assistant.",
  };
}

export async function listRepos(db: Db, userId: string, query: { q?: string; limit: number }) {
  const repos = await db.repo.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.q ? { fullName: { contains: query.q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ tracked: "desc" }, { fullName: "asc" }],
    take: query.limit,
    select: {
      id: true,
      fullName: true,
      provider: true,
      url: true,
      description: true,
      defaultBranch: true,
      tracked: true,
      myRole: true,
      languages: true,
    },
  });
  return {
    repos: repos.map((repo) => ({
      ...repo,
      kind: "repo" as const,
      description: repo.description ? excerpt(repo.description, 320).excerpt : null,
      url: hubUrl(`/context?repo=${repo.id}`),
      sourceUrl: repo.url,
      trust: "hub" as const,
      trustLabel: "A repository row in your Engineer Graph. The source URL may point at GitHub.",
    })),
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

export async function listSkills(db: Db, userId: string, query: { q?: string; limit: number; includeDisabled: boolean }) {
  const skills = await db.skill.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.includeDisabled ? {} : { enabled: true }),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { description: { contains: query.q, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: { name: "asc" },
    take: query.limit,
    select: { id: true, slug: true, name: true, description: true, version: true, enabled: true, provenance: true, confidence: true },
  });
  return {
    skills: skills.map((skill) => ({
      ...skill,
      kind: "skill" as const,
      url: hubUrl(`/skills?skill=${skill.id}`),
      trust: "trusted" as const,
      trustLabel: "A skill you keep in Ensemble. Only the current version is readable; history is not exposed here.",
    })),
    notes: "Skills are your own conventions. They are not mail or GitHub text. Older versions are not returned.",
    gaps: DATA_GAPS,
  };
}

export async function listDeliverables(db: Db, userId: string, query: { limit: number; includeCompleted: boolean }) {
  const deliverables = await db.deliverable.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.includeCompleted ? {} : { status: "upcoming" }),
    },
    orderBy: [{ due: "asc" }, { title: "asc" }],
    take: query.limit,
    include: { project: { select: { id: true, name: true } } },
  });
  return {
    deliverables: deliverables.map((row) => ({
      id: row.id,
      kind: "deliverable" as const,
      title: row.title,
      status: row.status,
      due: iso(row.due),
      owner: row.owner,
      notesExcerpt: excerpt(row.notes, 280).excerpt,
      projectId: row.projectId,
      project: row.project.name,
      url: hubUrl(`/projects/${row.projectId}`),
      trust: "hub" as const,
      trustLabel: "A deliverable stored on a project in your Ensemble Hub.",
    })),
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

export async function listPeople(db: Db, userId: string, query: { q?: string; limit: number }) {
  const people = await db.person.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { email: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ relationshipWeight: "desc" }, { name: "asc" }],
    take: query.limit,
    select: { id: true, name: true, email: true, role: true, team: true, lastInteraction: true },
  });
  return {
    people: people.map((person) => ({
      ...person,
      kind: "person" as const,
      lastInteraction: iso(person.lastInteraction),
      url: hubUrl(`/context?person=${person.id}`),
      trust: "hub" as const,
      trustLabel: "A person in your Engineer Graph. The name and email may have been learned from mail or GitHub.",
    })),
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

function eventCard(event: { id: string; title: string; ts: Date; url: string | null; metadata: Prisma.JsonValue; participants: Prisma.JsonValue }) {
  const meta = (event.metadata ?? {}) as { end?: string; allDay?: boolean; joinUrl?: string; location?: string };
  const trust = trustForIngested("calendar event");
  return {
    id: event.id,
    kind: "artifact" as const,
    artifactKind: "event" as const,
    title: event.title,
    start: event.ts.toISOString(),
    end: meta.end ?? null,
    allDay: Boolean(meta.allDay),
    location: meta.location ?? null,
    joinUrl: meta.joinUrl ?? event.url ?? null,
    participants: event.participants,
    url: hubUrl(`/context?artifact=${event.id}`),
    sourceUrl: event.url,
    ...trust,
  };
}

export async function listMeetings(db: Db, userId: string, query: { from?: string; to?: string; limit: number }) {
  const now = new Date();
  const from = query.from ? new Date(query.from) : now;
  const to = query.to ? new Date(query.to) : new Date(now.getTime() + 14 * 86_400_000);
  const events = await db.artifact.findMany({
    where: { userId, deletedAt: null, kind: "event", ts: { gte: from, lt: to } },
    orderBy: { ts: "asc" },
    take: query.limit,
    select: { id: true, title: true, ts: true, url: true, metadata: true, participants: true },
  });
  return {
    meetings: events.map(eventCard),
    window: { from: from.toISOString(), to: to.toISOString() },
    notes: `${UNTRUSTED_NOTE} Outlook calendar is not connected in this build; these rows are Artifact kind "event".`,
    gaps: DATA_GAPS,
  };
}

export async function listDecisions(db: Db, userId: string, query: { limit: number }) {
  const [approvals, decisions] = await Promise.all([
    db.approval.findMany({
      where: { userId, decision: null },
      orderBy: { requestedAt: "asc" },
      take: query.limit,
    }),
    db.agentDecision.findMany({
      where: { userId, status: "pending" },
      orderBy: { requestedAt: "asc" },
      take: query.limit,
    }),
  ]);
  return {
    needsMe: {
      approvals: approvals.map((row) => ({
        id: row.id,
        kind: "approval" as const,
        approvalKind: row.kind,
        title: row.title,
        taskId: row.taskId,
        runId: row.runId,
        requestedAt: row.requestedAt.toISOString(),
        previewExcerpt: excerpt(JSON.stringify(row.preview), 400).excerpt,
        url: hubUrl("/needs-me"),
        trust: "untrusted" as const,
        trustLabel: "An approval preview may quote mail, a PR, or model output. Untrusted. This bridge cannot approve or send it.",
      })),
      editorDecisions: decisions.map((row) => ({
        id: row.id,
        kind: "decision" as const,
        source: row.source,
        toolName: row.toolName,
        title: row.title,
        status: row.status,
        cwd: row.cwd,
        requestedAt: row.requestedAt.toISOString(),
        url: hubUrl("/needs-me"),
        trust: "untrusted" as const,
        trustLabel: "A permission prompt from another coding tool. The command and tool input are untrusted. This bridge cannot allow or deny it.",
      })),
    },
    notes: "Read-only view of Needs me. Nothing here is decided or sent.",
    gaps: DATA_GAPS,
  };
}

function isFocus(task: { status: string; todayFocus: string; priority: string; due: Date | null }, todayEnd: Date): boolean {
  if (task.status === "done" || task.status === "dropped" || task.status === "proposed") return false;
  if (task.todayFocus === "hidden") return false;
  if (task.todayFocus === "keep") return true;
  if (task.priority === "p0") return true;
  return Boolean(task.due && task.due < todayEnd);
}

export async function todayBriefing(db: Db, userId: string) {
  const zone = env.ENSEMBLE_TIMEZONE;
  const day = zonedDayRange(zone);
  const [tasks, deliverables, meetings, approvals, decisions] = await Promise.all([
    db.task.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { ...TASK_PUBLIC, project: { select: { name: true } }, repo: { select: { fullName: true } } },
    }),
    db.deliverable.findMany({
      where: { userId, deletedAt: null, status: "upcoming" },
      orderBy: { due: "asc" },
      take: 12,
      include: { project: { select: { name: true } } },
    }),
    db.artifact.findMany({
      where: { userId, deletedAt: null, kind: "event", ts: { gte: day.from, lt: new Date(day.from.getTime() + 7 * 86_400_000) } },
      orderBy: { ts: "asc" },
      take: 20,
      select: { id: true, title: true, ts: true, url: true, metadata: true, participants: true },
    }),
    db.approval.count({ where: { userId, decision: null } }),
    db.agentDecision.count({ where: { userId, status: "pending" } }),
  ]);
  const now = new Date();
  const proposed = tasks.filter((task) => task.status === "proposed" && (!task.snoozedUntil || task.snoozedUntil <= now));
  const focus = tasks.filter((task) => isFocus(task, day.to));
  return {
    date: day.date,
    timezone: zone,
    focus: focus.slice(0, 20).map((task) => taskCard(task, { project: task.project?.name, repo: task.repo?.fullName })),
    proposed: proposed.slice(0, 20).map((task) => taskCard(task, { project: task.project?.name, repo: task.repo?.fullName })),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      title: row.title,
      due: iso(row.due),
      project: row.project.name,
      projectId: row.projectId,
      url: hubUrl(`/projects/${row.projectId}`),
      trust: "hub" as const,
      trustLabel: "A deliverable stored in your Ensemble Hub.",
    })),
    meetings: meetings.map(eventCard),
    needsMe: { pendingApprovals: approvals, pendingEditorDecisions: decisions, url: hubUrl("/needs-me") },
    omitted: ["Private reminders are stored in the Hub and shown on Today. They are not included here."],
    notes: REFERENCE_NOTE,
    gaps: DATA_GAPS,
  };
}

const READ_KINDS = [
  "task",
  "project",
  "repo",
  "skill",
  "deliverable",
  "person",
  "artifact",
  "document",
  "meeting_note",
  "approval",
  "decision",
  "diagram",
  "plot",
  "page",
] as const;

export type ReadKind = (typeof READ_KINDS)[number];

export function isReadKind(value: string): value is ReadKind {
  return (READ_KINDS as readonly string[]).includes(value);
}

export async function readItem(
  db: Db,
  userId: string,
  kind: ReadKind,
  id: string,
  offset: number,
  limit: number,
  modules?: string | null,
): Promise<{ found: false } | { found: true; item: Record<string, unknown> }> {
  if (kind === "skill" && !hasModule(modules, "skills")) return { found: false };
  if (kind === "diagram" && !hasModule(modules, "diagrams")) return { found: false };
  if (kind === "plot" && !hasModule(modules, "plots")) return { found: false };
  const body = (text: string) => pageText(text, offset, limit);
  switch (kind) {
    case "task": {
      const task = await db.task.findFirst({
        where: { id, userId, deletedAt: null },
        include: {
          project: { select: { id: true, name: true } },
          repo: { select: { id: true, fullName: true, url: true } },
          page: { select: { content: true, notesSnapshot: true } },
        },
      });
      if (!task) return { found: false };
      const page = [task.notes, task.page?.notesSnapshot ?? "", plainFromJson(task.page?.content)].filter(Boolean).join("\n\n");
      return {
        found: true,
        item: {
          id: task.id,
          kind,
          title: task.title,
          status: task.status,
          priority: task.priority,
          owner: task.owner,
          description: task.description,
          due: iso(task.due),
          sourceKind: task.sourceKind,
          sourceUrl: task.sourceUrl,
          project: task.project,
          repo: task.repo,
          people: task.people,
          url: hubUrl(`/tasks/${task.id}`),
          body: body(`${task.description}\n\n${page}`.trim()),
          trust: "hub",
          trustLabel: "Task text stored in your Hub. A source excerpt copied from mail or GitHub is untrusted.",
          sourceExcerpt: task.excerpt
            ? { ...excerpt(task.excerpt, 800), ...trustForIngested(task.sourceKind) }
            : null,
        },
      };
    }
    case "project": {
      const project = await db.project.findFirst({
        where: { id, userId, deletedAt: null },
        include: {
          people: { include: { person: { select: { id: true, name: true, role: true } } } },
          repoLinks: { include: { repo: { select: { id: true, fullName: true, url: true } } } },
          deliverables: { where: { deletedAt: null }, orderBy: { due: "asc" }, take: 30 },
        },
      });
      if (!project) return { found: false };
      return {
        found: true,
        item: {
          id: project.id,
          kind,
          name: project.name,
          status: project.status,
          summary: project.summary,
          people: project.people.map((link) => link.person),
          repos: project.repoLinks.map((link) => link.repo),
          deliverables: project.deliverables.map((row) => ({ id: row.id, title: row.title, status: row.status, due: iso(row.due) })),
          url: hubUrl(`/projects/${project.id}`),
          body: body(`${project.summary}\n\n${project.notes}`.trim()),
          trust: "hub",
          trustLabel: "A project page stored in your Ensemble Hub.",
        },
      };
    }
    case "repo": {
      const repo = await db.repo.findFirst({ where: { id, userId, deletedAt: null } });
      if (!repo) return { found: false };
      return {
        found: true,
        item: {
          id: repo.id,
          kind,
          fullName: repo.fullName,
          provider: repo.provider,
          description: repo.description,
          defaultBranch: repo.defaultBranch,
          tracked: repo.tracked,
          myRole: repo.myRole,
          languages: repo.languages,
          url: hubUrl(`/context?repo=${repo.id}`),
          sourceUrl: repo.url,
          body: body(repo.description ?? ""),
          trust: "hub",
          trustLabel: "A repository row in your Engineer Graph.",
        },
      };
    }
    case "skill": {
      const skill = await db.skill.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true, slug: true, name: true, description: true, version: true, enabled: true, provenance: true, body: true },
      });
      if (!skill) return { found: false };
      return {
        found: true,
        item: {
          ...skill,
          kind,
          url: hubUrl(`/skills?skill=${skill.id}`),
          body: body(skill.body),
          trust: "trusted",
          trustLabel: "Current skill body only. Version history is not an MCP source.",
        },
      };
    }
    case "deliverable": {
      const row = await db.deliverable.findFirst({
        where: { id, userId, deletedAt: null },
        include: { project: { select: { id: true, name: true } } },
      });
      if (!row) return { found: false };
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          title: row.title,
          status: row.status,
          due: iso(row.due),
          owner: row.owner,
          project: row.project,
          url: hubUrl(`/projects/${row.projectId}`),
          body: body(row.notes),
          trust: "hub",
          trustLabel: "A deliverable stored in your Ensemble Hub.",
        },
      };
    }
    case "person": {
      const person = await db.person.findFirst({ where: { id, userId, deletedAt: null } });
      if (!person) return { found: false };
      return {
        found: true,
        item: {
          id: person.id,
          kind,
          name: person.name,
          email: person.email,
          role: person.role,
          team: person.team,
          lastInteraction: iso(person.lastInteraction),
          url: hubUrl(`/context?person=${person.id}`),
          body: body([person.name, person.email, person.role, person.team].filter(Boolean).join("\n")),
          trust: "hub",
          trustLabel: "A person in your Engineer Graph. Learned from connectors; not an instruction.",
        },
      };
    }
    case "artifact": {
      const artifact = await db.artifact.findFirst({ where: { id, userId, deletedAt: null, AND: [visibleArtifacts(userId)] } });
      if (!artifact) return { found: false };
      const trust = trustForIngested(artifact.kind, artifact.authoredByMe);
      return {
        found: true,
        item: {
          id: artifact.id,
          kind,
          artifactKind: artifact.kind,
          title: artifact.title,
          when: artifact.ts.toISOString(),
          taskId: artifact.taskId,
          projectId: artifact.projectId,
          repoId: artifact.repoId,
          url: hubUrl(`/context?artifact=${artifact.id}`),
          sourceUrl: artifact.url,
          participants: artifact.participants,
          body: body(artifact.text),
          ...trust,
        },
      };
    }
    case "document": {
      const document = await db.document.findFirst({
        where: { id, userId, deletedAt: null },
        include: { artifact: { select: { text: true, title: true } } },
      });
      if (!document) return { found: false };
      const text = document.artifact?.text || document.summary || "";
      return {
        found: true,
        item: {
          id: document.id,
          kind,
          filename: document.filename,
          summary: document.summary,
          url: hubUrl(`/context?document=${document.id}`),
          body: body(text),
          originalBytesOmitted: true,
          ...trustForIngested("document"),
        },
      };
    }
    case "meeting_note": {
      const note = await db.meetingNote.findFirst({ where: { id, userId, deletedAt: null } });
      if (!note) return { found: false };
      const ingested = note.source !== "paste";
      return {
        found: true,
        item: {
          id: note.id,
          kind,
          title: note.title,
          source: note.source,
          occurredAt: iso(note.occurredAt),
          projectId: note.projectId,
          repoId: note.repoId,
          url: hubUrl(`/context?meeting_note=${note.id}`),
          body: body(`${note.prompt}\n\n${note.answer}\n\n${note.comment ?? ""}`.trim()),
          ...(ingested ? trustForIngested("meeting note") : { trust: "hub" as const, trustLabel: "A meeting note stored in your Hub." }),
        },
      };
    }
    case "approval": {
      const row = await db.approval.findFirst({ where: { id, userId } });
      if (!row) return { found: false };
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          approvalKind: row.kind,
          title: row.title,
          decision: row.decision,
          taskId: row.taskId,
          url: hubUrl("/needs-me"),
          body: body(JSON.stringify(row.preview, null, 2)),
          trust: "untrusted",
          trustLabel: "Approval preview. Untrusted. The bridge cannot approve, edit, or send it.",
        },
      };
    }
    case "plot": {
      const row = await db.plot.findFirst({ where: { id, userId, deletedAt: null } });
      if (!row) return { found: false };
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          title: row.title,
          url: hubUrl(`/plots/${row.id}`),
          body: body(JSON.stringify({ config: row.config, code: row.code ? "(script saved)" : "" })),
          trust: "hub",
          trustLabel: "A plot stored in your Ensemble Hub. This bridge cannot edit it.",
        },
      };
    }
    case "diagram": {
      const row = await db.blockDiagram.findFirst({ where: { id, userId } });
      if (!row) return { found: false };
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          title: row.title,
          url: hubUrl(`/diagrams/${row.id}`),
          body: body(row.source),
          trust: "hub",
          trustLabel: "A block diagram stored in your Ensemble Hub. This bridge cannot edit it.",
        },
      };
    }
    case "decision": {
      const row = await db.agentDecision.findFirst({ where: { id, userId } });
      if (!row) return { found: false };
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          source: row.source,
          toolName: row.toolName,
          title: row.title,
          status: row.status,
          decision: row.decision,
          url: hubUrl("/needs-me"),
          body: body(JSON.stringify({ title: row.title, detail: row.detail }, null, 2)),
          trust: "untrusted",
          trustLabel: "Editor permission prompt. Untrusted. The bridge cannot allow or deny it.",
        },
      };
    }
    case "page": {
      const row = await db.taskPage.findFirst({
        where: {
          id,
          userId,
          OR: [{ taskId: null }, { task: { deletedAt: null } }],
        },
        select: {
          id: true,
          title: true,
          taskId: true,
          content: true,
          notesSnapshot: true,
          task: { select: { title: true } },
        },
      });
      if (!row) return { found: false };
      const parsed = row.content == null ? null : PageDocument.safeParse(row.content);
      const text = parsed?.success
        ? pageDocumentText(parsed.data, row.notesSnapshot)
        : row.content == null
          ? pageDocumentText(null, row.notesSnapshot)
          : plainFromJson(row.content);
      const title = row.taskId ? row.task?.title || row.title || "Page" : row.title || "Untitled";
      return {
        found: true,
        item: {
          id: row.id,
          kind,
          title,
          url: row.taskId ? hubUrl(`/tasks/${row.taskId}`) : hubUrl(`/pages/${row.id}`),
          body: body(text),
          trust: "hub",
          trustLabel: row.taskId ? "A page on a task stored in your Ensemble Hub." : "A note stored in your Ensemble Hub.",
        },
      };
    }
    default:
      return { found: false };
  }
}

export async function searchHub(db: Db, userId: string, q: string, limit: number, modules?: string | null) {
  const skillsOn = hasModule(modules, "skills");
  const plotsOn = hasModule(modules, "plots");
  const [tasks, projects, people, skills, repos, artifacts, notes, plots, pages] = await Promise.all([
    db.task.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [{ title: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }],
      },
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, description: true, status: true },
    }),
    db.project.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [{ name: { contains: q, mode: "insensitive" } }, { summary: { contains: q, mode: "insensitive" } }],
      },
      take: limit,
      select: { id: true, name: true, summary: true },
    }),
    db.person.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }],
      },
      take: limit,
      select: { id: true, name: true, email: true, role: true },
    }),
    skillsOn
      ? db.skill.findMany({
          where: {
            userId,
            deletedAt: null,
            enabled: true,
            OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }, { body: { contains: q, mode: "insensitive" } }],
          },
          take: limit,
          select: { id: true, name: true, description: true },
        })
      : Promise.resolve([]),
    db.repo.findMany({
      where: { userId, deletedAt: null, fullName: { contains: q, mode: "insensitive" } },
      take: limit,
      select: { id: true, fullName: true, url: true, description: true },
    }),
    db.artifact.findMany({
      where: {
        userId,
        deletedAt: null,
        AND: [visibleArtifacts(userId)],
        OR: [{ title: { contains: q, mode: "insensitive" } }, { text: { contains: q, mode: "insensitive" } }],
      },
      take: limit,
      orderBy: { ts: "desc" },
      select: { id: true, kind: true, title: true, text: true, url: true, ts: true, authoredByMe: true },
    }),
    db.meetingNote.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [{ title: { contains: q, mode: "insensitive" } }, { answer: { contains: q, mode: "insensitive" } }],
      },
      take: limit,
      orderBy: { askedAt: "desc" },
      select: { id: true, title: true, answer: true, source: true, askedAt: true },
    }),
    plotsOn
      ? db.plot.findMany({
          where: { userId, deletedAt: null, title: { contains: q, mode: "insensitive" } },
          take: limit,
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    db.taskPage.findMany({
      where: {
        userId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { searchText: { contains: q, mode: "insensitive" } },
        ],
        AND: [{ OR: [{ taskId: null }, { task: { deletedAt: null } }] }],
      },
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        taskId: true,
        searchText: true,
        updatedAt: true,
        task: { select: { title: true } },
      },
    }),
  ]);
  const results = [
    ...tasks.map((task) => ({
      id: task.id,
      kind: "task",
      label: task.title,
      when: null as string | null,
      url: hubUrl(`/tasks/${task.id}`),
      ...excerpt(task.description || task.title),
      trust: "hub" as const,
      trustLabel: "A task stored in your Ensemble Hub.",
    })),
    ...projects.map((project) => ({
      id: project.id,
      kind: "project",
      label: project.name,
      when: null,
      url: hubUrl(`/projects/${project.id}`),
      ...excerpt(project.summary || project.name),
      trust: "hub" as const,
      trustLabel: "A project page stored in your Ensemble Hub.",
    })),
    ...people.map((person) => ({
      id: person.id,
      kind: "person",
      label: person.name,
      when: null,
      url: hubUrl(`/context?person=${person.id}`),
      excerpt: [person.email, person.role].filter(Boolean).join(" · "),
      truncated: false,
      trust: "hub" as const,
      trustLabel: "A person in your Engineer Graph.",
    })),
    ...skills.map((skill) => ({
      id: skill.id,
      kind: "skill",
      label: skill.name,
      when: null,
      url: hubUrl(`/skills?skill=${skill.id}`),
      ...excerpt(skill.description || skill.name),
      trust: "trusted" as const,
      trustLabel: "One of your current skills.",
    })),
    ...repos.map((repo) => ({
      id: repo.id,
      kind: "repo",
      label: repo.fullName,
      when: null,
      url: hubUrl(`/context?repo=${repo.id}`),
      sourceUrl: repo.url,
      ...excerpt(repo.description || repo.fullName),
      trust: "hub" as const,
      trustLabel: "A repository row in your Engineer Graph.",
    })),
    ...artifacts.map((artifact) => ({
      id: artifact.id,
      kind: "artifact",
      artifactKind: artifact.kind,
      label: artifact.title || artifact.kind,
      when: artifact.ts.toISOString(),
      url: hubUrl(`/context?artifact=${artifact.id}`),
      sourceUrl: artifact.url,
      ...excerpt(artifact.text || artifact.title),
      ...trustForIngested(artifact.kind, artifact.authoredByMe),
    })),
    ...notes.map((note) => ({
      id: note.id,
      kind: "meeting_note",
      label: note.title,
      when: note.askedAt.toISOString(),
      url: hubUrl(`/context?meeting_note=${note.id}`),
      ...excerpt(note.answer || note.title),
      ...(note.source === "paste"
        ? { trust: "hub" as const, trustLabel: "A meeting note stored in your Hub." }
        : trustForIngested("meeting note")),
    })),
    ...plots.map((plot) => ({
      id: plot.id,
      kind: "plot",
      label: plot.title,
      when: null,
      url: hubUrl(`/plots/${plot.id}`),
      excerpt: plot.title,
      truncated: false,
      trust: "hub" as const,
      trustLabel: "A plot stored in your Ensemble Hub.",
    })),
    ...pages.map((page) => ({
      id: page.id,
      kind: "page" as const,
      label: page.taskId ? page.task?.title || page.title || "Page" : page.title || "Untitled",
      when: page.updatedAt.toISOString(),
      url: page.taskId ? hubUrl(`/tasks/${page.taskId}`) : hubUrl(`/pages/${page.id}`),
      ...excerpt(page.searchText || page.title || "Untitled"),
      trust: "hub" as const,
      trustLabel: page.taskId ? "A page on a task stored in your Ensemble Hub." : "A note stored in your Ensemble Hub.",
    })),
  ];
  return {
    query: q,
    match: "substring",
    results: results.slice(0, limit * 3),
    empty: results.length === 0,
    message: results.length === 0 ? `Nothing in Ensemble matched “${q}”.` : undefined,
    notes: `${REFERENCE_NOTE} This is not semantic search.`,
    gaps: DATA_GAPS,
  };
}

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  body: string;
  scope: Prisma.JsonValue;
  confidence: number;
  provenance: string;
}

function rankSkills(
  skills: SkillRow[],
  task: { id: string; skillIds: string[]; taskType: string | null; people: string[] } | null,
  repoFullName: string | null,
  projectName: string | null,
) {
  const ranked = skills.map((skill) => {
    let score = 0;
    const reasons: string[] = [];
    if (task?.skillIds.includes(skill.id)) {
      score += 5;
      reasons.push("linked on the task");
    }
    const scope = JSON.stringify(skill.scope ?? {}).toLowerCase();
    if (repoFullName && scope.includes(repoFullName.toLowerCase())) {
      score += 3;
      reasons.push("scope mentions this repository");
    }
    if (projectName && scope.includes(projectName.toLowerCase())) {
      score += 2;
      reasons.push("scope mentions this project");
    }
    if (task?.taskType && scope.includes(task.taskType.toLowerCase())) {
      score += 2;
      reasons.push(`scope matches task type ${task.taskType}`);
    }
    if (reasons.length === 0) reasons.push("enabled skill; no tighter match in its scope");
    return { skill, score, why: reasons.join("; ") };
  });
  ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  const strong = ranked.filter((row) => row.score > 0);
  const chosen = (strong.length > 0 ? strong : ranked).slice(0, 3);
  return chosen.map((row) => {
    const body = excerpt(row.skill.body, 1800);
    return {
      id: row.skill.id,
      skill: row.skill.name,
      slug: row.skill.slug,
      version: row.skill.version,
      provenance: row.skill.provenance,
      why: row.why,
      body: body.excerpt,
      bodyTruncated: body.truncated,
      url: hubUrl(`/skills?skill=${row.skill.id}`),
      trust: "trusted" as const,
      trustLabel: "A skill you approved about how you work. Not third-party content.",
    };
  });
}

async function peopleFor(
  db: Db,
  userId: string,
  task: { people: string[]; projectId: string | null } | null,
) {
  if (!task) return [];
  const ids = task.people.filter(isUuid);
  const names = task.people.filter((value) => !isUuid(value));
  const [byId, projectLinks, named] = await Promise.all([
    ids.length
      ? db.person.findMany({ where: { userId, deletedAt: null, id: { in: ids } }, select: { id: true, name: true, role: true, email: true } })
      : Promise.resolve([]),
    task.projectId
      ? db.projectPerson.findMany({
          where: { projectId: task.projectId, person: { userId, deletedAt: null } },
          include: { person: { select: { id: true, name: true, role: true, email: true } } },
        })
      : Promise.resolve([]),
    names.length
      ? db.person.findMany({
          where: { userId, deletedAt: null, OR: names.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
          select: { id: true, name: true, role: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const map = new Map<string, { id: string; name: string; role: string | null; email: string | null }>();
  for (const person of [...byId, ...named, ...projectLinks.map((link) => link.person)]) map.set(person.id, person);
  return [...map.values()].map((person) => ({
    ...person,
    url: hubUrl(`/context?person=${person.id}`),
    trust: "hub" as const,
    trustLabel: "A person linked from your Hub. The record may have been learned from mail or GitHub.",
  }));
}

export async function buildBrief(
  db: Db,
  userId: string,
  input: { query?: string; repo?: string; branch?: string; limit: number },
  modules?: string | null,
) {
  const repoName = input.repo ? normalizeRepoName(input.repo) ?? input.repo.trim() : null;
  const branch = input.branch?.trim() || null;
  const repo = repoName
    ? await db.repo.findFirst({
        where: { userId, deletedAt: null, fullName: { equals: repoName, mode: "insensitive" } },
        include: { projects: { where: { project: { deletedAt: null } }, include: { project: { select: { id: true, name: true, summary: true, status: true } } } } },
      })
    : null;

  const branchRows = branch && hasModule(modules, "workspace")
    ? await db.workspaceJob.findMany({
        where: {
          userId,
          branch: { equals: branch, mode: "insensitive" },
          task: { deletedAt: null, ...(repo ? { repoId: repo.id } : {}) },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { task: { select: { id: true, title: true, status: true, updatedAt: true, repoId: true, projectId: true, deletedAt: true } } },
      })
    : [];
  const sessionRows = branch && hasModule(modules, "workspace")
    ? await db.workspaceSession.findMany({
        where: {
          userId,
          branch: { equals: branch, mode: "insensitive" },
          task: { deletedAt: null, ...(repo ? { repoId: repo.id } : {}) },
        },
        take: 20,
        include: { task: { select: { id: true, title: true, status: true, updatedAt: true, repoId: true, projectId: true } } },
      })
    : [];
  const branchTasks = distinctById([
    ...branchRows.map((row) => toRef(row.task)),
    ...sessionRows.map((row) => toRef(row.task)),
  ]);
  const openTasksOnRepo = repo
    ? (
        await db.task.findMany({
          where: { userId, deletedAt: null, repoId: repo.id, status: { in: [...OPEN_STATUSES] } },
          orderBy: { updatedAt: "desc" },
          take: 15,
          select: { id: true, title: true, status: true, updatedAt: true, repoId: true, projectId: true },
        })
      ).map(toRef)
    : [];

  const resolution = resolveBriefAnchor({
    repoRequested: repoName,
    repoFound: Boolean(repo),
    branch,
    branchTasks,
    openTasksOnRepo,
  });

  const taskId = resolution.kind === "task" ? resolution.task.id : resolution.kind === "ambiguous" ? null : null;
  const task = taskId
    ? await db.task.findFirst({
        where: { id: taskId, userId, deletedAt: null },
        include: {
          project: { select: { id: true, name: true, summary: true, status: true } },
          repo: { select: { id: true, fullName: true, url: true, description: true, defaultBranch: true } },
          page: { select: { content: true } },
        },
      })
    : null;

  const projectFromRepo = repo?.projects[0]?.project ?? null;
  const project = task?.project ?? projectFromRepo;
  const resolvedRepo = task?.repo ?? (repo ? { id: repo.id, fullName: repo.fullName, url: repo.url, description: repo.description, defaultBranch: repo.defaultBranch } : null);

  const query = input.query?.trim() || undefined;
  const artifactOr: Prisma.ArtifactWhereInput[] = [];
  if (task) artifactOr.push({ taskId: task.id });
  if (project) artifactOr.push({ projectId: project.id });
  if (resolvedRepo) artifactOr.push({ repoId: resolvedRepo.id });
  if (query) {
    artifactOr.push({ title: { contains: query, mode: "insensitive" } });
    artifactOr.push({ text: { contains: query, mode: "insensitive" } });
  }

  const [skills, people, deliverables, artifacts, meetingNotes] = await Promise.all([
    hasModule(modules, "skills")
      ? db.skill.findMany({
          where: { userId, deletedAt: null, enabled: true },
          take: 40,
          select: { id: true, slug: true, name: true, description: true, version: true, body: true, scope: true, confidence: true, provenance: true },
        })
      : Promise.resolve([]),
    peopleFor(db, userId, task),
    project
      ? db.deliverable.findMany({
          where: { userId, deletedAt: null, projectId: project.id, status: "upcoming" },
          orderBy: { due: "asc" },
          take: 8,
        })
      : Promise.resolve([]),
    artifactOr.length
      ? db.artifact.findMany({
          where: { userId, deletedAt: null, OR: artifactOr },
          orderBy: { ts: "desc" },
          take: input.limit,
          select: { id: true, kind: true, title: true, text: true, url: true, ts: true, authoredByMe: true },
        })
      : Promise.resolve([]),
    project || resolvedRepo || query
      ? db.meetingNote.findMany({
          where: {
            userId,
            deletedAt: null,
            OR: [
              ...(project ? [{ projectId: project.id }] : []),
              ...(resolvedRepo ? [{ repoId: resolvedRepo.id }] : []),
              ...(query ? [{ title: { contains: query, mode: "insensitive" as const } }, { answer: { contains: query, mode: "insensitive" as const } }] : []),
            ],
          },
          orderBy: { askedAt: "desc" },
          take: Math.min(input.limit, 8),
          select: { id: true, title: true, answer: true, source: true, askedAt: true },
        })
      : Promise.resolve([]),
  ]);

  const howIWork = rankSkills(skills, task, resolvedRepo?.fullName ?? null, project?.name ?? null).filter((skill) => {
    if (resolution.kind === "task" || resolution.kind === "repo_only" || project) return true;
    return skill.why !== "enabled skill; no tighter match in its scope";
  });

  const context = [
    ...(task
      ? [
          {
            id: task.id,
            kind: "task",
            label: task.title,
            when: task.updatedAt.toISOString(),
            url: hubUrl(`/tasks/${task.id}`),
            ...excerpt([task.description, plainFromJson(task.page?.content)].filter(Boolean).join(" ") || task.title),
            trust: "hub" as const,
            trustLabel: "The resolved task in your Hub.",
          },
        ]
      : []),
    ...deliverables.map((row) => ({
      id: row.id,
      kind: "deliverable",
      label: row.title,
      when: iso(row.due),
      url: hubUrl(`/projects/${row.projectId}`),
      ...excerpt(row.notes || row.title),
      trust: "hub" as const,
      trustLabel: "A deliverable on the linked project.",
    })),
    ...artifacts.map((artifact) => ({
      id: artifact.id,
      kind: "artifact",
      artifactKind: artifact.kind,
      label: artifact.title || artifact.kind,
      when: artifact.ts.toISOString(),
      url: hubUrl(`/context?artifact=${artifact.id}`),
      sourceUrl: artifact.url,
      ...excerpt(artifact.text || artifact.title),
      ...trustForIngested(artifact.kind, artifact.authoredByMe),
    })),
    ...meetingNotes.map((note) => ({
      id: note.id,
      kind: "meeting_note",
      label: note.title,
      when: note.askedAt.toISOString(),
      url: hubUrl(`/context?meeting_note=${note.id}`),
      ...excerpt(note.answer || note.title),
      ...(note.source === "paste"
        ? { trust: "hub" as const, trustLabel: "A meeting note stored in your Hub." }
        : trustForIngested("meeting note")),
    })),
  ].slice(0, input.limit + (task ? 1 : 0) + deliverables.length);

  const degradedSearch =
    (resolution.kind === "untracked_repo" || resolution.kind === "no_anchor" || resolution.kind === "branch_unmatched") && query
      ? await searchHub(db, userId, query, input.limit, modules)
      : null;

  const nothing =
    resolution.kind !== "task" &&
    context.length === 0 &&
    howIWork.length === 0 &&
    (!degradedSearch || degradedSearch.results.length === 0);

  return {
    resolution: resolution.kind,
    message: resolution.message,
    candidates: resolution.kind === "ambiguous" ? resolution.candidates.map((task) => ({ ...task, url: hubUrl(`/tasks/${task.id}`) })) : undefined,
    closedMatches: resolution.kind === "branch_unmatched" ? resolution.closed.map((task) => ({ ...task, url: hubUrl(`/tasks/${task.id}`) })) : undefined,
    otherOpenTasks: resolution.kind === "task" ? resolution.otherOpen.map((task) => ({ ...task, url: hubUrl(`/tasks/${task.id}`) })) : undefined,
    resolved: {
      task: task
        ? {
            id: task.id,
            title: task.title,
            status: task.status,
            url: hubUrl(`/tasks/${task.id}`),
            via: resolution.kind === "task" ? resolution.via : undefined,
          }
        : null,
      repo: resolvedRepo
        ? { id: resolvedRepo.id, fullName: resolvedRepo.fullName, url: hubUrl(`/context?repo=${resolvedRepo.id}`), sourceUrl: resolvedRepo.url }
        : null,
      project: project ? { id: project.id, name: project.name, url: hubUrl(`/projects/${project.id}`) } : null,
      people,
    },
    howIWork,
    context,
    search: degradedSearch
      ? { query: degradedSearch.query, results: degradedSearch.results, message: degradedSearch.message }
      : undefined,
    nothingFound: nothing,
    notes: nothing
      ? `Nothing relevant was found. ${REFERENCE_NOTE}`
      : REFERENCE_NOTE,
    readAgain: "Excerpts are bounded. Call ensemble_read with the cited kind and id for the rest.",
    gaps: DATA_GAPS,
  };
}
