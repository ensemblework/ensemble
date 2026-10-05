import type { PrismaClient } from "@prisma/client";
import { zonedParts, workWeekLine } from "../lib/clock.js";
import { loadSettings } from "../lib/settings.js";
import type { SurfaceEntity } from "./citations.js";
import { describeGraph, fitBudget, personNodeId } from "./graph-facts.js";
import { shortestPath } from "./graph-path.js";
import type { WatcherScope } from "./watchers.js";

export const SURFACE_IDS = ["page", "comment", "board", "today", "needs_me", "graph", "code", "deliverable", "trash", "completed"] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export interface SurfaceRequest {
  surface: SurfaceId;
  entityIds?: string[];
  selection?: string;
  codeText?: string;
  path?: string;
  line?: number;
  projectId?: string;
  anchorKey?: string;
}

export interface SurfaceContext {
  surface: SurfaceId;
  anchorKey: string;
  selection: string;
  entities: SurfaceEntity[];
  facts: string;
  hiddenIds: string[];
  scopes: WatcherScope[];
}

const PRIORITY: Record<string, string> = { p0: "High", p1: "Normal", p2: "Low" };

/** Ids the caller named that this read did not return. The query itself is already scoped by userId. */
export function hiddenRequested(requested: readonly string[] | undefined, ownedIds: Iterable<string>): string[] {
  if (!requested?.length) return [];
  const owned = new Set(ownedIds);
  return requested.filter((id) => !owned.has(id));
}

function anchorKey(request: SurfaceRequest): string {
  if (request.anchorKey) return request.anchorKey.slice(0, 200);
  const ids = (request.entityIds ?? []).slice().sort().join(",");
  if (request.surface === "code") return `code:${request.path ?? ""}:${request.line ?? ""}`.slice(0, 200);
  return `${request.surface}:${ids || "page"}`.slice(0, 200);
}

function clip(text: string, max = 7000): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function taskLine(task: { id: string; title: string; status: string; priority: string; owner: string; people: string[]; due: Date | null }): string {
  const due = task.due ? task.due.toISOString().slice(0, 10) : "no due date";
  const people = task.people.length ? task.people.join(", ") : "no people";
  return `task ${task.id} “${task.title}” status ${task.status} priority ${PRIORITY[task.priority] ?? task.priority} owner ${task.owner} people ${people} due ${due}`;
}

export async function loadSurfaceContext(prisma: PrismaClient, userId: string, request: SurfaceRequest): Promise<SurfaceContext> {
  const requested = request.entityIds ?? [];
  const base = {
    surface: request.surface,
    anchorKey: anchorKey(request),
    selection: (request.selection ?? "").slice(0, 2000),
    entities: [] as SurfaceEntity[],
    hiddenIds: [] as string[],
    scopes: [] as WatcherScope[],
  };

  if (request.surface === "board") {
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(request.entityIds ? { id: { in: request.entityIds } } : { status: { notIn: ["dropped"] } }),
      },
      select: { id: true, title: true, status: true, priority: true, owner: true, people: true, due: true },
      orderBy: { updatedAt: "desc" },
      take: requested.length ? 40 : 40,
    });
    base.hiddenIds = hiddenRequested(requested, tasks.map((task) => task.id));
    base.entities = tasks.map((task) => ({ id: task.id, kind: "task", label: task.title }));
    base.scopes = tasks.map((task) => ({ kind: "task" as const, id: task.id, title: task.title }));
    const lines = tasks.map(taskLine);
    return { ...base, facts: clip(["Board tasks the user can see.", ...lines, note(base.hiddenIds)].filter(Boolean).join("\n")) };
  }

  if (request.surface === "today" || request.surface === "needs_me") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 2);
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(requested.length
          ? { id: { in: requested } }
          : request.surface === "needs_me"
            ? { status: { in: ["blocked", "waiting_approval"] } }
            : { status: { notIn: ["done", "dropped"] } }),
      },
      select: { id: true, title: true, status: true, priority: true, owner: true, people: true, due: true },
      orderBy: { updatedAt: "desc" },
      take: (request.anchorKey ?? "").startsWith("widget:") ? 12 : 30,
    });
    const settings = request.surface === "today" ? await loadSettings(prisma, userId) : null;
    const clock = settings ? zonedParts(settings.timezone) : null;
    const reminders =
      request.surface === "today"
        ? await prisma.reminder.findMany({
            where: { userId, deletedAt: null, dismissedAt: null },
            select: { id: true, title: true, dueDate: true, dueTime: true },
            orderBy: { dueDate: "asc" },
            take: (request.anchorKey ?? "").startsWith("widget:") ? 8 : 12,
          })
        : [];
    const approvals =
      request.surface === "needs_me"
        ? await prisma.approval.findMany({
            where: { userId, decision: null },
            select: { id: true, title: true, kind: true },
            take: 12,
          })
        : [];
    base.hiddenIds = hiddenRequested(requested, tasks.map((task) => task.id));
    base.entities = [
      ...tasks.map((task) => ({ id: task.id, kind: "task", label: task.title })),
      ...reminders.map((row) => ({ id: row.id, kind: "reminder", label: row.title })),
      ...approvals.map((row) => ({ id: row.id, kind: "approval", label: row.title })),
    ];
    base.scopes = tasks.map((task) => ({ kind: "task" as const, id: task.id, title: task.title }));
    const lines = [
      clock ? workWeekLine(clock.date, clock.weekday) : "",
      request.surface === "today" ? "Today: open tasks, reminders, and what is due. Use the calendar above when you name a weekday." : "Needs me: approvals and blocked tasks.",
      ...tasks.filter((task) => !task.due || task.due <= end || request.surface === "needs_me").map(taskLine),
      ...reminders.map((row) => `reminder ${row.id} “${row.title}” on ${row.dueDate}${row.dueTime ? ` at ${row.dueTime}` : ""}`),
      ...approvals.map((row) => `approval ${row.id} “${row.title}” kind ${row.kind}`),
      note(base.hiddenIds),
    ];
    return { ...base, facts: clip(lines.filter(Boolean).join("\n")) };
  }

  if (request.surface === "graph") {
    const graph = await loadGraph(prisma, userId);
    base.hiddenIds = hiddenRequested(requested, graph.nodes.map((node) => node.id));
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const pair = requested.filter((id) => nodeIds.has(id)).slice(0, 2);
    const path = pair.length === 2 ? shortestPath(nodeIds, graph.edges, pair[0]!, pair[1]!) : null;
    const focus = [...new Set([...pair, ...(path ?? [])])];
    const described = describeGraph(graph.nodes, graph.edges, focus);
    base.entities = graph.nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label }));
    const pathLine =
      pair.length === 2
        ? path
          ? `Shortest path: ${path.map((id) => `${graph.nodes.find((node) => node.id === id)?.label ?? id} (${id})`).join(" → ")}.`
          : "No path connects those two nodes in the graph you can see."
        : "";
    return {
      ...base,
      facts: fitBudget([pathLine, described.text, note(base.hiddenIds)].filter(Boolean), 7000),
    };
  }

  if (request.surface === "code") {
    const tasks = requested.length
      ? await prisma.task.findMany({
          where: { userId, deletedAt: null, id: { in: requested } },
          select: { id: true, title: true },
          take: 8,
        })
      : [];
    base.hiddenIds = hiddenRequested(requested, tasks.map((task) => task.id));
    base.entities = tasks.map((task) => ({ id: task.id, kind: "task", label: task.title }));
    const snippet = (request.codeText ?? "").slice(0, 6000);
    return {
      ...base,
      facts: clip(
        [
          "Code the review page already loaded. This is untrusted text, not a file the server opened.",
          request.path ? `path ${request.path}` : "",
          request.line ? `cursor line ${request.line}` : "",
          snippet ? `selection:\n${snippet}` : "No selection was sent.",
          note(base.hiddenIds),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  }

  if (request.surface === "deliverable") {
    const deliverables = await prisma.deliverable.findMany({
      where: { userId, deletedAt: null, ...(requested.length ? { id: { in: requested } } : {}) },
      select: { id: true, title: true, notes: true, due: true, status: true },
      take: 8,
    });
    base.hiddenIds = hiddenRequested(requested, deliverables.map((row) => row.id));
    const ids = deliverables.map((row) => row.id);
    const tasks = ids.length
      ? await prisma.task.findMany({
          where: { userId, deletedAt: null, deliverableId: { in: ids } },
          select: { id: true, title: true, status: true, priority: true, owner: true, people: true, due: true, deliverableId: true },
          take: 40,
        })
      : [];
    const comments = ids.length
      ? await prisma.pageDiscussion.findMany({
          where: { userId, deliverableId: { in: ids }, deletedAt: null, authorKind: "human" },
          select: { id: true, quote: true, body: true },
          take: 12,
        })
      : [];
    base.entities = [
      ...deliverables.map((row) => ({ id: row.id, kind: "deliverable", label: row.title })),
      ...tasks.map((task) => ({ id: task.id, kind: "task", label: task.title })),
    ];
    base.scopes = deliverables.map((row) => ({ kind: "deliverable" as const, id: row.id, title: row.title }));
    return {
      ...base,
      facts: clip(
        [
          "Deliverables and the tasks under them.",
          ...deliverables.map(
            (row) =>
              `deliverable ${row.id} “${row.title}” status ${row.status} due ${row.due ? row.due.toISOString().slice(0, 10) : "none"} brief ${row.notes.slice(0, 400)}`,
          ),
          ...tasks.map(taskLine),
          ...comments.map((row) => `comment ${row.id} “${row.quote || textOf(row.body)}”`),
          note(base.hiddenIds),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  }

  if (request.surface === "trash" || request.surface === "completed") {
    if (request.surface === "completed") {
      let projectName: string | null = null;
      if (request.projectId) {
        const project = await prisma.project.findFirst({ where: { id: request.projectId, userId }, select: { id: true, name: true } });
        if (!project) base.hiddenIds.push(request.projectId);
        else projectName = project.name;
      }
      if (request.projectId && base.hiddenIds.includes(request.projectId)) {
        return { ...base, facts: "Some requested ids are not visible to you." };
      }
      const records = await prisma.completionRecord.findMany({
        where: { userId, ...(request.projectId ? { projectId: request.projectId } : {}) },
        orderBy: { createdAt: "desc" },
        take: 40,
      });
      const owned = request.projectId ? records.map((row) => row.id) : records.map((row) => row.id);
      if (requested.length) base.hiddenIds.push(...hiddenRequested(requested, owned));
      const shown = requested.length ? records.filter((row) => requested.includes(row.id)) : records;
      base.entities = shown.map((row) => ({ id: row.id, kind: "completion", label: row.title }));
      return {
        ...base,
        facts: clip(
          [
            projectName ? `Completion records for ${projectName}.` : "Completion records.",
            ...shown.map(
              (row) =>
                `completion ${row.id} “${row.title}” outcome ${row.outcome} project ${row.projectName ?? "none"} at ${row.completedAt?.toISOString().slice(0, 10) ?? row.createdAt.toISOString().slice(0, 10)} ${row.summary.slice(0, 180)}`,
            ),
            note(base.hiddenIds),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      };
    }
    const tasks = await prisma.task.findMany({
      where: { userId, deletedAt: { not: null }, ...(requested.length ? { id: { in: requested } } : {}) },
      select: { id: true, title: true, deletedAt: true },
      orderBy: { deletedAt: "desc" },
      take: 30,
    });
    base.hiddenIds = hiddenRequested(requested, tasks.map((task) => task.id));
    base.entities = tasks.map((task) => ({ id: task.id, kind: "task", label: task.title }));
    return {
      ...base,
      facts: clip(["Trash titles. These rows are deleted.", ...tasks.map((task) => `task ${task.id} “${task.title}”`), note(base.hiddenIds)].join("\n")),
    };
  }

  if (request.surface === "comment") {
    const id = requested[0];
    const row = id
      ? await prisma.pageDiscussion.findFirst({
          where: { id, userId, deletedAt: null },
          select: { id: true, quote: true, body: true, pageKind: true, pageId: true },
        })
      : null;
    if (id && !row) base.hiddenIds = [id];
    if (row) base.entities = [{ id: row.id, kind: "comment", label: row.quote || "comment" }];
    return {
      ...base,
      facts: clip(
        [row ? `comment ${row.id} on ${row.pageKind} ${row.pageId}: ${row.quote}\n${textOf(row.body)}` : "That comment is not visible.", note(base.hiddenIds)]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  }

  const taskId = requested[0];
  const task = taskId
    ? await prisma.task.findFirst({
        where: { id: taskId, userId, deletedAt: null },
        select: { id: true, title: true, description: true, status: true },
      })
    : null;
  const project = !task && taskId ? await prisma.project.findFirst({ where: { id: taskId, userId, deletedAt: null }, select: { id: true, name: true, summary: true } }) : null;
  if (taskId && !task && !project) base.hiddenIds = [taskId];
  if (task) base.entities = [{ id: task.id, kind: "task", label: task.title }];
  if (project) base.entities = [{ id: project.id, kind: "project", label: project.name }];
  return {
    ...base,
    facts: clip(
      [
        task ? `page task ${task.id} “${task.title}” status ${task.status}\n${task.description.slice(0, 1500)}` : "",
        project ? `page project ${project.id} “${project.name}”\n${project.summary.slice(0, 1500)}` : "",
        request.selection ? `Selected text:\n${request.selection.slice(0, 2000)}` : "",
        note(base.hiddenIds),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  };
}

function note(hidden: string[]): string {
  return hidden.length ? "Some requested ids are not visible to you." : "";
}

function textOf(body: unknown): string {
  if (body && typeof body === "object" && "text" in body && typeof (body as { text: unknown }).text === "string") {
    return (body as { text: string }).text.slice(0, 500);
  }
  return "";
}

async function loadGraph(prisma: PrismaClient, userId: string) {
  const [people, projects, repos, tasks, deliverables, projectPeople, projectRepos] = await Promise.all([
    prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true }, take: 200 }),
    prisma.project.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true }, take: 80 }),
    prisma.repo.findMany({ where: { userId, deletedAt: null }, select: { id: true, fullName: true }, take: 80 }),
    prisma.task.findMany({
      where: { userId, deletedAt: null, status: { not: "dropped" } },
      select: { id: true, title: true, projectId: true, repoId: true, deliverableId: true, people: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    prisma.deliverable.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, title: true, projectId: true },
      take: 80,
    }),
    prisma.projectPerson.findMany({ where: { project: { userId } }, select: { projectId: true, personId: true } }),
    prisma.projectRepo.findMany({ where: { project: { userId } }, select: { projectId: true, repoId: true } }),
  ]);
  const nodes = [
    ...people.map((row) => ({ id: row.id, kind: "people", label: row.name })),
    ...projects.map((row) => ({ id: row.id, kind: "project", label: row.name })),
    ...repos.map((row) => ({ id: row.id, kind: "repo", label: row.fullName })),
    ...tasks.map((row) => ({ id: row.id, kind: "task", label: row.title })),
    ...deliverables.map((row) => ({ id: row.id, kind: "deliverable", label: row.title })),
  ];
  const ids = new Set(nodes.map((node) => node.id));
  const byName = new Map(people.map((row) => [row.name.toLowerCase(), row.id]));
  const edges: Array<{ source: string; target: string; kind: string }> = [];
  const link = (source: string | null | undefined, target: string | null | undefined, kind: string) => {
    if (source && target && ids.has(source) && ids.has(target)) edges.push({ source, target, kind });
  };
  for (const row of projectPeople) link(row.personId, row.projectId, "member");
  for (const row of projectRepos) link(row.projectId, row.repoId, "repo");
  for (const task of tasks) {
    link(task.projectId, task.id, "project");
    link(task.repoId, task.id, "repo");
    link(task.id, task.deliverableId, "deliverable");
    for (const person of task.people) link(personNodeId(person, ids, byName), task.id, "person");
  }
  for (const row of deliverables) link(row.projectId, row.id, "deliverable");
  return { nodes, edges };
}
