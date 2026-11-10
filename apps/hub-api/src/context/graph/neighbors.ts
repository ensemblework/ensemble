/**
 * The context graph: everything one record links to, in both directions, from the tables that
 * already hold the links (foreign keys, id arrays, page mentions). There is no graph store; each
 * relation is one bounded, indexed query (docs/03 §4.4).
 *
 * `itemNeighbors` answers "what is this, and what is it connected to?" for the Hub (graph side panel,
 * person and project views), the assistant and Ensemble Node (`hub_item_context`), the Context Bridge
 * (`ensemble_context`) and agent briefs (packet.ts). Every relation returns item cards with a handle
 * (`ensemble://<kind>/<id>`) to follow.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { NOT_UPLOADED } from "../artifacts.js";
import { visibleArtifacts } from "../../sharing/context.js";
import { ON_BOARD } from "../../lib/node-tasks.js";
import { filesOnPage, filesOnTask } from "../../files/attached.js";
import { meetingsInSeries } from "../../cowork/series.js";
import { hubPath, isUuid, mentionGraphKind, refOf, type GraphKind, type ItemRef } from "./refs.js";

export type Db = PrismaClient | Prisma.TransactionClient;

export interface GraphCtx {
  db: Db;
  /** The open space. */
  userId: string;
  modules?: string | null;
}

export interface ItemCard {
  /** `ensemble://<kind>/<id>` for a record that can be opened with ensemble_context; null otherwise. */
  ref: string | null;
  kind: string;
  id: string;
  title: string;
  status?: string | null;
  due?: string | null;
  when?: string | null;
  /** A person's role on a project, or a project's role for a person. */
  role?: string | null;
  detail?: string | null;
  path: string | null;
}

export interface RelationGroup {
  rel: string;
  label: string;
  items: ItemCard[];
  /** More than shown: page with `rel` and `offset`. */
  more: boolean;
}

export interface ItemDetail extends ItemCard {
  summary: string;
  facts: Record<string, unknown>;
}

export interface Neighborhood {
  item: ItemDetail;
  groups: RelationGroup[];
}

interface Page {
  limit: number;
  offset: number;
}

const OPEN_TASK: Prisma.TaskWhereInput = { status: { notIn: ["done", "dropped"] } };
const DONE_TASK: Prisma.TaskWhereInput = { status: "done" };

export const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export function clip(text: string | null | undefined, max = 240): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "by", "at", "from", "is", "be", "it", "this", "that", "into", "up", "out", "our", "my", "your", "we", "i", "add", "make", "do", "get", "new"]);

/** Words of a title for overlap scores: lower case, no punctuation or stop words. */
export function words(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .split(/[\s-]+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

type TaskRow = { id: string; title: string; status: string; due: Date | null; updatedAt: Date; completedAt?: Date | null; project?: { name: string } | null };

const TASK_CARD_SELECT = { id: true, title: true, status: true, due: true, updatedAt: true, completedAt: true, project: { select: { name: true } } } satisfies Prisma.TaskSelect;

export function taskCard(row: TaskRow, detail?: string | null): ItemCard {
  return {
    ref: refOf("task", row.id),
    kind: "task",
    id: row.id,
    title: row.title,
    status: row.status,
    due: iso(row.due),
    when: iso(row.completedAt ?? row.updatedAt),
    detail: detail ?? row.project?.name ?? null,
    path: hubPath("task", row.id),
  };
}

function card(kind: GraphKind | string, id: string, title: string, extra: Partial<ItemCard> = {}): ItemCard {
  const graph = ["task", "project", "person", "repo", "deliverable", "meeting", "file", "page", "event"].includes(kind);
  return { ref: graph ? refOf(kind, id) : null, kind, id, title: title || "Untitled", path: hubPath(kind, id, title), ...extra };
}

function meetingCard(row: { id: string; title: string; at: Date | null; kind?: "note" | "session"; detail?: string | null; projectName?: string | null }): ItemCard {
  return {
    ref: refOf("meeting", row.id),
    kind: "meeting",
    id: row.id,
    title: row.title || "Meeting",
    when: iso(row.at),
    detail: row.detail ?? row.projectName ?? null,
    path: hubPath(row.kind === "session" ? "session" : "meeting", row.id),
  };
}

/** limit + 1 rows → the shown rows and whether there are more. */
function paged(rows: ItemCard[], page: Page): { items: ItemCard[]; more: boolean } {
  return { items: rows.slice(0, page.limit), more: rows.length > page.limit };
}

const take = (page: Page) => ({ skip: page.offset, take: page.limit + 1 });

function slicePage<T>(rows: T[], page: Page): T[] {
  return rows.slice(page.offset, page.offset + page.limit + 1);
}

// ── relations shared by several kinds ─────────────────────────────────────

const MENTION_KIND: Partial<Record<GraphKind, string>> = { person: "people", task: "task", project: "project", repo: "repo", deliverable: "deliverable", file: "file" };

/** Pages and tasks that mention a record. */
async function mentionedIn(ctx: GraphCtx, kind: GraphKind, id: string, page: Page): Promise<ItemCard[]> {
  const mention = MENTION_KIND[kind];
  if (!mention) return [];
  const rows = await ctx.db.taskPageMention.findMany({
    where: { kind: mention, entityId: id, page: { userId: ctx.userId, deletedAt: null, OR: [{ taskId: null }, { task: { deletedAt: null, ...ON_BOARD } }] } },
    orderBy: { page: { updatedAt: "desc" } },
    ...take(page),
    select: { page: { select: { id: true, title: true, updatedAt: true, task: { select: TASK_CARD_SELECT } } } },
  });
  return rows.map(({ page: row }) => (row.task ? taskCard(row.task) : card("page", row.id, row.title || "Untitled page", { when: iso(row.updatedAt) })));
}

async function filesTagged(ctx: GraphCtx, field: "projectIds" | "personIds" | "repoIds" | "deliverableIds", id: string, page: Page): Promise<ItemCard[]> {
  const rows = await ctx.db.document.findMany({
    where: { userId: ctx.userId, deletedAt: null, [field]: { has: id } },
    orderBy: { updatedAt: "desc" },
    ...take(page),
    select: { id: true, filename: true, updatedAt: true, summary: true },
  });
  return rows.map((row) => card("file", row.id, row.filename, { when: iso(row.updatedAt) }));
}

async function savedItems(ctx: GraphCtx, where: Prisma.ArtifactWhereInput, page: Page): Promise<ItemCard[]> {
  const rows = await ctx.db.artifact.findMany({
    where: { userId: ctx.userId, deletedAt: null, kind: { notIn: ["event", "transcript"] }, AND: [where, visibleArtifacts(ctx.userId), NOT_UPLOADED] },
    orderBy: { ts: "desc" },
    ...take(page),
    select: { id: true, kind: true, title: true, ts: true, url: true, metadata: true },
  });
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { source?: string; itemKind?: string };
    return {
      ref: null,
      kind: "artifact",
      id: row.id,
      title: row.title || row.kind,
      when: iso(row.ts),
      detail: [meta.source, meta.itemKind ?? row.kind].filter(Boolean).join(" "),
      path: `/files?view=apps&item=${row.id}`,
    };
  });
}

async function peopleCards(ctx: GraphCtx, values: string[], projectId: string | null): Promise<ItemCard[]> {
  const ids = values.filter(isUuid);
  const names = values.filter((value) => !isUuid(value) && value.trim());
  const [byId, byName, roles] = await Promise.all([
    ids.length ? ctx.db.person.findMany({ where: { userId: ctx.userId, deletedAt: null, id: { in: ids } }, select: { id: true, name: true, role: true, relationship: true, email: true } }) : [],
    names.length
      ? ctx.db.person.findMany({ where: { userId: ctx.userId, deletedAt: null, OR: names.map((name) => ({ name: { equals: name.trim(), mode: "insensitive" as const } })) }, select: { id: true, name: true, role: true, relationship: true, email: true } })
      : [],
    projectId && values.length ? ctx.db.projectPerson.findMany({ where: { projectId }, select: { personId: true, role: true } }) : [],
  ]);
  const role = new Map(roles.map((row) => [row.personId, row.role]));
  const found = new Map<string, ItemCard>();
  for (const person of [...byId, ...byName]) {
    found.set(person.id, card("person", person.id, person.name, { role: role.get(person.id) ?? person.role, detail: person.relationship ?? person.email ?? null }));
  }
  const known = new Set([...byName.map((person) => person.name.trim().toLowerCase())]);
  const unknown = names.filter((name) => !known.has(name.trim().toLowerCase())).map((name) => ({ ref: null, kind: "person", id: "", title: name.trim(), detail: "Not in People", path: null }) satisfies ItemCard);
  return [...found.values(), ...unknown];
}

// ── per kind ───────────────────────────────────────────────────────────────

interface Relation<A> {
  rel: string;
  label: string;
  run: (ctx: GraphCtx, anchor: A, page: Page) => Promise<ItemCard[]>;
}

interface KindSpec<A> {
  load: (ctx: GraphCtx, id: string) => Promise<A | null>;
  detail: (ctx: GraphCtx, anchor: A) => Promise<ItemDetail> | ItemDetail;
  relations: Array<Relation<A>>;
}

type TaskAnchor = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

async function loadTask(ctx: GraphCtx, id: string) {
  return ctx.db.task.findFirst({
    where: { id, userId: ctx.userId, deletedAt: null },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      owner: true,
      due: true,
      labels: true,
      people: true,
      dependsOn: true,
      projectId: true,
      repoId: true,
      deliverableId: true,
      meetingNoteId: true,
      excerpt: true,
      rationale: true,
      sourceKind: true,
      sourceUrl: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
      page: { select: { id: true, notesSnapshot: true } },
      project: { select: { id: true, name: true, summary: true } },
      repo: { select: { id: true, fullName: true } },
      deliverable: { select: { id: true, title: true, due: true, status: true } },
      meetingNote: { select: { id: true, title: true, occurredAt: true, askedAt: true } },
    },
  });
}

/** Open tasks near this one: same project, repository, meeting or deliverable, scored by shared people, labels and title words. */
async function relatedTasks(ctx: GraphCtx, task: TaskAnchor, page: Page): Promise<ItemCard[]> {
  const near: Prisma.TaskWhereInput[] = [];
  if (task.projectId) near.push({ projectId: task.projectId });
  if (task.repoId) near.push({ repoId: task.repoId });
  if (task.meetingNoteId) near.push({ meetingNoteId: task.meetingNoteId });
  if (task.deliverableId) near.push({ deliverableId: task.deliverableId });
  const people = task.people.filter(Boolean);
  if (people.length) near.push({ people: { hasSome: people } });
  if (!near.length) return [];
  const rows = await ctx.db.task.findMany({
    where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...OPEN_TASK, id: { not: task.id }, OR: near },
    orderBy: { updatedAt: "desc" },
    take: 80,
    select: { ...TASK_CARD_SELECT, projectId: true, repoId: true, meetingNoteId: true, deliverableId: true, people: true, labels: true },
  });
  const mine = words(task.title);
  const scored = rows
    .map((row) => {
      let score = overlap(mine, words(row.title)) * 4;
      const why: string[] = [];
      if (task.meetingNoteId && row.meetingNoteId === task.meetingNoteId) (score += 3), why.push("same meeting");
      if (task.deliverableId && row.deliverableId === task.deliverableId) (score += 3), why.push("same deliverable");
      if (task.repoId && row.repoId === task.repoId) (score += 1), why.push("same repository");
      const sharedPeople = row.people.filter((person) => people.includes(person)).length;
      if (sharedPeople) (score += 1.5 * sharedPeople), why.push("same people");
      const sharedLabels = row.labels.filter((label) => task.labels.includes(label)).length;
      if (sharedLabels) score += sharedLabels;
      if (task.projectId && row.projectId === task.projectId) score += 0.5;
      return { row, score, why };
    })
    .sort((a, b) => b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  return slicePage(scored, page).map(({ row, why }) => taskCard(row, why.join(", ") || row.project?.name || null));
}

/** Finished tasks like this one (same project or repository, shared title words), with what their last run said. */
async function doneBefore(ctx: GraphCtx, task: TaskAnchor, page: Page): Promise<ItemCard[]> {
  const near: Prisma.TaskWhereInput[] = [];
  if (task.projectId) near.push({ projectId: task.projectId });
  if (task.repoId) near.push({ repoId: task.repoId });
  if (!near.length) return [];
  const rows = await ctx.db.task.findMany({
    where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...DONE_TASK, id: { not: task.id }, OR: near },
    orderBy: { completedAt: "desc" },
    take: 60,
    select: TASK_CARD_SELECT,
  });
  const mine = words(task.title);
  const picked = slicePage(
    rows
      .map((row) => ({ row, score: overlap(mine, words(row.title)) }))
      .filter((entry) => entry.score > 0 || rows.length <= 6)
      .sort((a, b) => b.score - a.score),
    page,
  ).map((entry) => entry.row);
  if (!picked.length) return [];
  const runs = await ctx.db.run.findMany({
    where: { userId: ctx.userId, taskId: { in: picked.map((row) => row.id) }, outcome: "success", result: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { taskId: true, result: true },
  });
  const result = new Map<string, string>();
  for (const run of runs) if (!result.has(run.taskId) && run.result) result.set(run.taskId, run.result);
  return picked.map((row) => taskCard(row, result.has(row.id) ? clip(result.get(row.id), 280) : row.project?.name ?? null));
}

const taskSpec: KindSpec<TaskAnchor> = {
  load: loadTask,
  detail: (_ctx, task) => ({
    ...taskCard(task),
    summary: clip(task.description || task.page?.notesSnapshot || "", 700),
    facts: {
      priority: task.priority,
      owner: task.owner,
      labels: task.labels,
      project: task.project?.name ?? null,
      repo: task.repo?.fullName ?? null,
      deliverable: task.deliverable ? { title: task.deliverable.title, due: iso(task.deliverable.due), status: task.deliverable.status } : null,
      fromMeeting: task.meetingNote ? { title: task.meetingNote.title, at: iso(task.meetingNote.occurredAt ?? task.meetingNote.askedAt) } : null,
      source: task.sourceUrl ? { kind: task.sourceKind, url: task.sourceUrl } : null,
      excerpt: task.excerpt ? clip(task.excerpt, 500) : null,
      why: task.rationale ? clip(task.rationale, 300) : null,
      createdAt: iso(task.createdAt),
      completedAt: iso(task.completedAt),
    },
  }),
  relations: [
    {
      rel: "project",
      label: "Project",
      run: async (_ctx, task) => (task.project ? [card("project", task.project.id, task.project.name, { detail: clip(task.project.summary, 160) || null })] : []),
    },
    {
      rel: "meeting",
      label: "From meeting",
      run: async (_ctx, task) => (task.meetingNote ? [meetingCard({ id: task.meetingNote.id, title: task.meetingNote.title, at: task.meetingNote.occurredAt ?? task.meetingNote.askedAt })] : []),
    },
    {
      rel: "people",
      label: "People",
      run: async (ctx, task, page) => slicePage(await peopleCards(ctx, task.people, task.projectId), page),
    },
    {
      rel: "deliverable",
      label: "Deliverable",
      run: async (_ctx, task) => (task.deliverable ? [card("deliverable", task.deliverable.id, task.deliverable.title, { status: task.deliverable.status, due: iso(task.deliverable.due) })] : []),
    },
    {
      rel: "repos",
      label: "Repositories",
      run: async (ctx, task, page) => {
        const links = task.projectId ? await ctx.db.projectRepo.findMany({ where: { projectId: task.projectId, repo: { deletedAt: null } }, select: { repo: { select: { id: true, fullName: true } } } }) : [];
        const repos = new Map<string, string>();
        if (task.repo) repos.set(task.repo.id, task.repo.fullName);
        for (const link of links) repos.set(link.repo.id, link.repo.fullName);
        return slicePage([...repos].map(([id, name]) => card("repo", id, name, { detail: id === task.repoId ? "this task's repository" : "on the project" })), page);
      },
    },
    {
      rel: "depends_on",
      label: "Depends on",
      run: async (ctx, task, page) => {
        const ids = task.dependsOn.filter(isUuid);
        if (!ids.length) return [];
        const rows = await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, id: { in: ids } }, ...take(page), select: TASK_CARD_SELECT });
        return rows.map((row) => taskCard(row));
      },
    },
    {
      rel: "blocks",
      label: "Blocks",
      run: async (ctx, task, page) =>
        (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, dependsOn: { has: task.id } }, orderBy: { updatedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)),
    },
    { rel: "related", label: "Related open work", run: relatedTasks },
    { rel: "done_before", label: "Done before (similar)", run: doneBefore },
    {
      rel: "files",
      label: "Files",
      run: async (ctx, task, page) => slicePage((await filesOnTask(ctx.db as PrismaClient, ctx.userId, task.id)).map((file) => card("file", file.id, file.filename, { detail: file.format })), page),
    },
    {
      rel: "mentions",
      label: "Mentions on its page",
      run: async (ctx, task, page) => {
        if (!task.page) return [];
        const rows = await ctx.db.taskPageMention.findMany({ where: { pageId: task.page.id }, ...take(page), select: { kind: true, entityId: true, label: true } });
        return rows.map((row) => card(mentionGraphKind(row.kind), row.entityId, row.label));
      },
    },
    { rel: "mentioned_in", label: "Mentioned in", run: (ctx, task, page) => mentionedIn(ctx, "task", task.id, page) },
    { rel: "items", label: "Saved from apps", run: (ctx, task, page) => savedItems(ctx, { taskId: task.id }, page) },
    {
      rel: "runs",
      label: "Agent runs",
      run: async (ctx, task, page) => {
        const rows = await ctx.db.run.findMany({
          where: { userId: ctx.userId, taskId: task.id, deletedAt: null },
          orderBy: { startedAt: "desc" },
          ...take(page),
          select: { id: true, worker: true, outcome: true, result: true, error: true, startedAt: true, endedAt: true, workspaceJob: { select: { provider: true, model: true, status: true } } },
        });
        return rows.map((row) => ({
          ref: null,
          kind: "run",
          id: row.id,
          title: [row.workspaceJob?.provider, row.workspaceJob?.model].filter(Boolean).join(" · ") || row.worker,
          status: row.outcome ?? row.workspaceJob?.status ?? "running",
          when: iso(row.endedAt ?? row.startedAt),
          detail: clip(row.result ?? row.error ?? "", 280) || null,
          path: `/runs?run=${row.id}`,
        }));
      },
    },
  ],
};

type ProjectAnchor = NonNullable<Awaited<ReturnType<typeof loadProject>>>;

function loadProject(ctx: GraphCtx, id: string) {
  return ctx.db.project.findFirst({
    where: { id, userId: ctx.userId, deletedAt: null },
    select: { id: true, name: true, summary: true, notes: true, status: true, aliases: true, createdAt: true, updatedAt: true },
  });
}

async function projectMeetings(ctx: GraphCtx, field: { projectId: string } | { repoId: string }, page: Page): Promise<ItemCard[]> {
  const window = page.offset + page.limit + 1;
  const [notes, sessions] = await Promise.all([
    ctx.db.meetingNote.findMany({ where: { userId: ctx.userId, deletedAt: null, ...field }, orderBy: { occurredAt: "desc" }, take: window, select: { id: true, title: true, occurredAt: true, askedAt: true, source: true } }),
    "projectId" in field
      ? ctx.db.meetingSession.findMany({ where: { userId: ctx.userId, deletedAt: null, projectId: field.projectId, meetingNoteId: null }, orderBy: { startedAt: "desc" }, take: window, select: { id: true, title: true, startedAt: true } })
      : [],
  ]);
  const rows = [
    ...notes.map((row) => ({ id: row.id, title: row.title, at: row.occurredAt ?? row.askedAt, kind: "note" as const, detail: row.source === "live" ? "notes taken in Ensemble" : null })),
    ...sessions.map((row) => ({ id: row.id, title: row.title, at: row.startedAt, kind: "session" as const, detail: "notes taken in Ensemble" })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  return slicePage(rows, page).map(meetingCard);
}

const projectSpec: KindSpec<ProjectAnchor> = {
  load: loadProject,
  detail: (_ctx, project) => ({
    ...card("project", project.id, project.name, { status: project.status, when: iso(project.updatedAt) }),
    summary: clip([project.summary, project.notes].filter(Boolean).join(" · "), 900),
    facts: { status: project.status, aliases: project.aliases, createdAt: iso(project.createdAt) },
  }),
  relations: [
    {
      rel: "open_tasks",
      label: "Open tasks",
      run: async (ctx, project, page) =>
        (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...OPEN_TASK, projectId: project.id }, orderBy: [{ due: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }], ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row, null)),
    },
    {
      rel: "deliverables",
      label: "Deliverables",
      run: async (ctx, project, page) =>
        (await ctx.db.deliverable.findMany({ where: { userId: ctx.userId, deletedAt: null, projectId: project.id }, orderBy: [{ status: "asc" }, { due: { sort: "asc", nulls: "last" } }], ...take(page), select: { id: true, title: true, status: true, due: true, owner: true } })).map((row) =>
          card("deliverable", row.id, row.title, { status: row.status, due: iso(row.due), detail: row.owner }),
        ),
    },
    {
      rel: "people",
      label: "People",
      run: async (ctx, project, page) =>
        (await ctx.db.projectPerson.findMany({ where: { projectId: project.id, person: { deletedAt: null } }, orderBy: { createdAt: "asc" }, ...take(page), select: { role: true, person: { select: { id: true, name: true, role: true, relationship: true } } } })).map((link) =>
          card("person", link.person.id, link.person.name, { role: link.role ?? link.person.role, detail: link.person.relationship }),
        ),
    },
    {
      rel: "repos",
      label: "Repositories",
      run: async (ctx, project, page) =>
        (await ctx.db.projectRepo.findMany({ where: { projectId: project.id, repo: { deletedAt: null } }, ...take(page), select: { repo: { select: { id: true, fullName: true, description: true } } } })).map((link) => card("repo", link.repo.id, link.repo.fullName, { detail: clip(link.repo.description, 120) || null })),
    },
    { rel: "meetings", label: "Meetings", run: (ctx, project, page) => projectMeetings(ctx, { projectId: project.id }, page) },
    {
      rel: "done_tasks",
      label: "Recently done",
      run: async (ctx, project, page) => (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...DONE_TASK, projectId: project.id }, orderBy: { completedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row, null)),
    },
    { rel: "files", label: "Files", run: (ctx, project, page) => filesTagged(ctx, "projectIds", project.id, page) },
    { rel: "items", label: "Saved from apps", run: (ctx, project, page) => savedItems(ctx, { projectId: project.id }, page) },
    {
      rel: "sources",
      label: "Linked app containers",
      run: async (ctx, project, page) =>
        (await ctx.db.projectLink.findMany({ where: { projectId: project.id, userId: ctx.userId }, ...take(page), select: { id: true, source: true, containerId: true, containerName: true } })).map((row) => ({
          ref: null,
          kind: "link",
          id: row.id,
          title: row.containerName || row.containerId,
          detail: row.source,
          path: null,
        })),
    },
    { rel: "mentioned_in", label: "Mentioned in", run: (ctx, project, page) => mentionedIn(ctx, "project", project.id, page) },
  ],
};

type PersonAnchor = NonNullable<Awaited<ReturnType<typeof loadPerson>>>;

function loadPerson(ctx: GraphCtx, id: string) {
  return ctx.db.person.findFirst({
    where: { id, userId: ctx.userId, deletedAt: null },
    select: { id: true, name: true, email: true, role: true, team: true, relationship: true, lastInteraction: true, updatedAt: true },
  });
}

/** Tasks that name this person, by id or by their exact name (older rows and the assistant's free names). */
const personTasks = (person: PersonAnchor): Prisma.TaskWhereInput => ({ OR: [{ people: { has: person.id } }, { people: { has: person.name } }] });

const personSpec: KindSpec<PersonAnchor> = {
  load: loadPerson,
  detail: (_ctx, person) => ({
    ...card("person", person.id, person.name, { role: person.role, detail: person.relationship ?? null, when: iso(person.lastInteraction) }),
    summary: [person.role, person.team, person.relationship ? `to you: ${person.relationship}` : null, person.email].filter(Boolean).join(" · "),
    facts: { email: person.email, role: person.role, team: person.team, relationship: person.relationship, lastInteraction: iso(person.lastInteraction) },
  }),
  relations: [
    {
      rel: "projects",
      label: "Projects",
      run: async (ctx, person, page) =>
        (await ctx.db.projectPerson.findMany({ where: { personId: person.id, project: { userId: ctx.userId, deletedAt: null } }, ...take(page), select: { role: true, project: { select: { id: true, name: true, status: true } } } })).map((link) =>
          card("project", link.project.id, link.project.name, { role: link.role, status: link.project.status }),
        ),
    },
    {
      rel: "open_tasks",
      label: "Open tasks with them",
      run: async (ctx, person, page) =>
        (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...OPEN_TASK, AND: [personTasks(person), { NOT: { labels: { has: "waiting-on" } } }] }, orderBy: [{ due: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }], ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)),
    },
    {
      rel: "waiting_on",
      label: "Waiting on them",
      run: async (ctx, person, page) =>
        (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...OPEN_TASK, labels: { has: "waiting-on" }, ...personTasks(person) }, orderBy: [{ due: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }], ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)),
    },
    {
      rel: "meetings",
      label: "Meetings",
      run: async (ctx, person, page) => {
        const window = page.offset + page.limit + 1;
        const [notes, sessions] = await Promise.all([
          ctx.db.meetingNote.findMany({ where: { userId: ctx.userId, deletedAt: null, personIds: { has: person.id } }, orderBy: { occurredAt: "desc" }, take: window, select: { id: true, title: true, occurredAt: true, askedAt: true, project: { select: { name: true } } } }),
          ctx.db.meetingSession.findMany({ where: { userId: ctx.userId, deletedAt: null, personIds: { has: person.id }, meetingNoteId: null }, orderBy: { startedAt: "desc" }, take: window, select: { id: true, title: true, startedAt: true, project: { select: { name: true } } } }),
        ]);
        const rows = [
          ...notes.map((row) => ({ id: row.id, title: row.title, at: row.occurredAt ?? row.askedAt, kind: "note" as const, projectName: row.project?.name ?? null })),
          ...sessions.map((row) => ({ id: row.id, title: row.title, at: row.startedAt, kind: "session" as const, projectName: row.project?.name ?? null })),
        ].sort((a, b) => b.at.getTime() - a.at.getTime());
        return slicePage(rows, page).map(meetingCard);
      },
    },
    {
      rel: "done_tasks",
      label: "Done together",
      run: async (ctx, person, page) => (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...DONE_TASK, ...personTasks(person) }, orderBy: { completedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)),
    },
    { rel: "files", label: "Files", run: (ctx, person, page) => filesTagged(ctx, "personIds", person.id, page) },
    { rel: "mentioned_in", label: "Mentioned in", run: (ctx, person, page) => mentionedIn(ctx, "person", person.id, page) },
  ],
};

export type MeetingAnchor = NonNullable<Awaited<ReturnType<typeof loadMeeting>>>;

/** A meeting by its note id or its notes session id; a session linked to a note is that note. */
export async function loadMeeting(ctx: GraphCtx, id: string) {
  const noteSelect = { id: true, title: true, occurredAt: true, askedAt: true, source: true, externalSource: true, answer: true, comment: true, prompt: true, extraction: true, projectId: true, repoId: true, personIds: true, eventArtifactId: true, artifactId: true, seriesKey: true, aiStatus: true, project: { select: { id: true, name: true } }, repo: { select: { id: true, fullName: true } } } satisfies Prisma.MeetingNoteSelect;
  let note = await ctx.db.meetingNote.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: noteSelect });
  let session = note
    ? await ctx.db.meetingSession.findFirst({ where: { userId: ctx.userId, deletedAt: null, meetingNoteId: note.id }, select: { id: true, title: true, notes: true, recap: true, startedAt: true, endedAt: true, status: true, projectId: true, personIds: true, artifactId: true, seriesKey: true } })
    : await ctx.db.meetingSession.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true, title: true, notes: true, recap: true, startedAt: true, endedAt: true, status: true, projectId: true, personIds: true, artifactId: true, seriesKey: true, meetingNoteId: true } });
  if (!note && session && "meetingNoteId" in session && session.meetingNoteId) {
    note = await ctx.db.meetingNote.findFirst({ where: { id: session.meetingNoteId, userId: ctx.userId, deletedAt: null }, select: noteSelect });
  }
  if (!note && !session) return null;
  const extraction = (note?.extraction && typeof note.extraction === "object" ? note.extraction : {}) as Record<string, unknown>;
  const ai = (extraction.ai && typeof extraction.ai === "object" ? extraction.ai : null) as Record<string, unknown> | null;
  return {
    id: note?.id ?? session!.id,
    noteId: note?.id ?? null,
    sessionId: session?.id ?? null,
    title: note?.title ?? session!.title,
    at: note ? (note.occurredAt ?? note.askedAt) : session!.startedAt,
    source: note?.source ?? "live",
    origin: note?.externalSource ?? null,
    projectId: note?.projectId ?? session?.projectId ?? null,
    project: note?.project ?? null,
    repo: note?.repo ?? null,
    personIds: [...new Set([...(note?.personIds ?? []), ...(session?.personIds ?? [])])],
    eventId: note?.eventArtifactId ?? note?.artifactId ?? session?.artifactId ?? null,
    seriesKey: note?.seriesKey ?? session?.seriesKey ?? null,
    aiStatus: note?.aiStatus ?? null,
    hasTranscript: Boolean(note?.prompt?.trim()),
    notes: session?.notes ?? (note?.source === "live" ? note.answer : "") ?? "",
    summary: String(ai?.summary ?? "") || (note && note.source !== "live" ? note.answer : "") || session?.recap || "",
    decisions: [...new Set([...stringList(ai?.decisions), ...stringList(extraction.decisions)])].slice(0, 12),
    actionItems: Array.isArray(extraction.actionItems) ? (extraction.actionItems as Array<{ text?: string; mine?: boolean; owner?: { name?: string | null } | null; completed?: boolean }>) : [],
    waitingOn: Array.isArray(extraction.waitingOn) ? (extraction.waitingOn as Array<{ text?: string; owner?: { name?: string | null } }>) : [],
    openQuestions: stringList(ai?.openQuestions).slice(0, 8),
    ai,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === "string" && row.trim().length > 0).map((row) => row.trim()) : [];
}

const meetingSpec: KindSpec<MeetingAnchor> = {
  load: loadMeeting,
  detail: (_ctx, meeting) => ({
    ...meetingCard({ id: meeting.id, title: meeting.title, at: meeting.at, kind: meeting.noteId ? "note" : "session", projectName: meeting.project?.name ?? null }),
    summary: clip(meeting.summary || meeting.notes, 1200),
    facts: {
      source: meeting.origin ?? meeting.source,
      project: meeting.project?.name ?? null,
      hasTranscript: meeting.hasTranscript,
      decisions: meeting.decisions,
      myActionItems: meeting.actionItems.filter((item) => item.mine && !item.completed).map((item) => clip(item.text, 200)).slice(0, 12),
      waitingOn: meeting.waitingOn.map((item) => `${item.owner?.name ?? "Someone"}: ${clip(item.text, 160)}`).slice(0, 10),
      openQuestions: meeting.openQuestions,
      aiStatus: meeting.aiStatus,
    },
  }),
  relations: [
    { rel: "project", label: "Project", run: async (ctx, meeting) => (meeting.projectId ? (await ctx.db.project.findMany({ where: { id: meeting.projectId, userId: ctx.userId, deletedAt: null }, select: { id: true, name: true } })).map((row) => card("project", row.id, row.name)) : []) },
    { rel: "people", label: "People", run: async (ctx, meeting, page) => slicePage(await peopleCards(ctx, meeting.personIds, meeting.projectId), page) },
    {
      rel: "tasks",
      label: "Tasks from this meeting",
      run: async (ctx, meeting, page) => (meeting.noteId ? (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, meetingNoteId: meeting.noteId }, orderBy: { createdAt: "asc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)) : []),
    },
    {
      rel: "earlier",
      label: "Earlier in this series",
      run: async (ctx, meeting, page) => {
        if (!meeting.seriesKey) return [];
        const rows = await meetingsInSeries(ctx.db, ctx.userId, { seriesKey: meeting.seriesKey, before: meeting.at, excludeIds: [meeting.noteId ?? "", meeting.sessionId ?? ""], personIds: meeting.personIds, projectId: meeting.projectId, limit: page.offset + page.limit + 1 });
        return slicePage(rows, page).map((row) => meetingCard({ id: row.id, title: row.title, at: row.at, kind: row.kind }));
      },
    },
    {
      rel: "later",
      label: "Later in this series",
      run: async (ctx, meeting, page) => {
        if (!meeting.seriesKey) return [];
        const rows = await meetingsInSeries(ctx.db, ctx.userId, { seriesKey: meeting.seriesKey, after: meeting.at, excludeIds: [meeting.noteId ?? "", meeting.sessionId ?? ""], personIds: meeting.personIds, projectId: meeting.projectId, limit: page.offset + page.limit + 1 });
        return slicePage(rows, page).map((row) => meetingCard({ id: row.id, title: row.title, at: row.at, kind: row.kind }));
      },
    },
    {
      rel: "event",
      label: "Calendar event",
      run: async (ctx, meeting) => {
        if (!meeting.eventId) return [];
        const event = await ctx.db.artifact.findFirst({ where: { id: meeting.eventId, userId: ctx.userId, kind: "event", AND: [visibleArtifacts(ctx.userId)] }, select: { id: true, title: true, ts: true } });
        return event ? [card("event", event.id, event.title || "Event", { when: iso(event.ts) })] : [];
      },
    },
    { rel: "repo", label: "Repository", run: async (_ctx, meeting) => (meeting.repo ? [card("repo", meeting.repo.id, meeting.repo.fullName)] : []) },
  ],
};

type DeliverableAnchor = NonNullable<Awaited<ReturnType<typeof loadDeliverable>>>;

function loadDeliverable(ctx: GraphCtx, id: string) {
  return ctx.db.deliverable.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true, title: true, status: true, due: true, owner: true, notes: true, project: { select: { id: true, name: true } } } });
}

const deliverableSpec: KindSpec<DeliverableAnchor> = {
  load: loadDeliverable,
  detail: (_ctx, row) => ({ ...card("deliverable", row.id, row.title, { status: row.status, due: iso(row.due), detail: row.project.name }), summary: clip(row.notes, 700), facts: { owner: row.owner, project: row.project.name } }),
  relations: [
    { rel: "project", label: "Project", run: async (_ctx, row) => [card("project", row.project.id, row.project.name)] },
    { rel: "tasks", label: "Tasks", run: async (ctx, row, page) => (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, deliverableId: row.id }, orderBy: { updatedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((task) => taskCard(task)) },
    { rel: "files", label: "Files", run: (ctx, row, page) => filesTagged(ctx, "deliverableIds", row.id, page) },
    { rel: "mentioned_in", label: "Mentioned in", run: (ctx, row, page) => mentionedIn(ctx, "deliverable", row.id, page) },
  ],
};

type RepoAnchor = NonNullable<Awaited<ReturnType<typeof loadRepo>>>;

function loadRepo(ctx: GraphCtx, id: string) {
  return ctx.db.repo.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true, fullName: true, description: true, url: true, defaultBranch: true, languages: true, myRole: true } });
}

const repoSpec: KindSpec<RepoAnchor> = {
  load: loadRepo,
  detail: (_ctx, repo) => ({ ...card("repo", repo.id, repo.fullName), summary: clip(repo.description, 600), facts: { url: repo.url, defaultBranch: repo.defaultBranch, languages: repo.languages, myRole: repo.myRole } }),
  relations: [
    { rel: "projects", label: "Projects", run: async (ctx, repo, page) => (await ctx.db.projectRepo.findMany({ where: { repoId: repo.id, project: { userId: ctx.userId, deletedAt: null } }, ...take(page), select: { project: { select: { id: true, name: true, status: true } } } })).map((link) => card("project", link.project.id, link.project.name, { status: link.project.status })) },
    { rel: "open_tasks", label: "Open tasks", run: async (ctx, repo, page) => (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...OPEN_TASK, repoId: repo.id }, orderBy: { updatedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)) },
    { rel: "meetings", label: "Meetings", run: (ctx, repo, page) => projectMeetings(ctx, { repoId: repo.id }, page) },
    { rel: "done_tasks", label: "Recently done", run: async (ctx, repo, page) => (await ctx.db.task.findMany({ where: { userId: ctx.userId, deletedAt: null, ...ON_BOARD, ...DONE_TASK, repoId: repo.id }, orderBy: { completedAt: "desc" }, ...take(page), select: TASK_CARD_SELECT })).map((row) => taskCard(row)) },
    { rel: "items", label: "Saved from apps", run: (ctx, repo, page) => savedItems(ctx, { repoId: repo.id }, page) },
    { rel: "files", label: "Files", run: (ctx, repo, page) => filesTagged(ctx, "repoIds", repo.id, page) },
  ],
};

type FileAnchor = NonNullable<Awaited<ReturnType<typeof loadFile>>>;

function loadFile(ctx: GraphCtx, id: string) {
  return ctx.db.document.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true, filename: true, mediaType: true, byteSize: true, pageCount: true, updatedAt: true, projectIds: true, personIds: true, taskIds: true, repoIds: true, deliverableIds: true } });
}

function taggedCards(kind: "project" | "person" | "repo" | "deliverable") {
  return async (ctx: GraphCtx, ids: string[], page: Page): Promise<ItemCard[]> => {
    const list = slicePage(ids.filter(isUuid), page);
    if (!list.length) return [];
    const where = { id: { in: list }, userId: ctx.userId, deletedAt: null };
    if (kind === "project") return (await ctx.db.project.findMany({ where, select: { id: true, name: true } })).map((row) => card(kind, row.id, row.name));
    if (kind === "person") return (await ctx.db.person.findMany({ where, select: { id: true, name: true, role: true } })).map((row) => card(kind, row.id, row.name, { role: row.role }));
    if (kind === "repo") return (await ctx.db.repo.findMany({ where, select: { id: true, fullName: true } })).map((row) => card(kind, row.id, row.fullName));
    return (await ctx.db.deliverable.findMany({ where, select: { id: true, title: true, status: true, due: true } })).map((row) => card(kind, row.id, row.title, { status: row.status, due: iso(row.due) }));
  };
}

const fileSpec: KindSpec<FileAnchor> = {
  load: loadFile,
  detail: (_ctx, file) => ({ ...card("file", file.id, file.filename, { when: iso(file.updatedAt) }), summary: `${file.mediaType}, ${file.byteSize} bytes${file.pageCount ? `, ${file.pageCount} pages` : ""}`, facts: { mediaType: file.mediaType, byteSize: file.byteSize, pages: file.pageCount } }),
  relations: [
    { rel: "projects", label: "Projects", run: (ctx, file, page) => taggedCards("project")(ctx, file.projectIds, page) },
    { rel: "people", label: "People", run: (ctx, file, page) => taggedCards("person")(ctx, file.personIds, page) },
    {
      rel: "tasks",
      label: "Tasks",
      run: async (ctx, file, page) => {
        const ids = slicePage(file.taskIds.filter(isUuid), page);
        return ids.length ? (await ctx.db.task.findMany({ where: { id: { in: ids }, userId: ctx.userId, deletedAt: null }, select: TASK_CARD_SELECT })).map((row) => taskCard(row)) : [];
      },
    },
    { rel: "repos", label: "Repositories", run: (ctx, file, page) => taggedCards("repo")(ctx, file.repoIds, page) },
    { rel: "deliverables", label: "Deliverables", run: (ctx, file, page) => taggedCards("deliverable")(ctx, file.deliverableIds, page) },
    { rel: "pages", label: "Pages made from it", run: async (ctx, file, page) => (await ctx.db.taskPage.findMany({ where: { userId: ctx.userId, deletedAt: null, sourceFileId: file.id }, ...take(page), select: { id: true, title: true, taskId: true, task: { select: TASK_CARD_SELECT } } })).map((row) => (row.task ? taskCard(row.task) : card("page", row.id, row.title))) },
    { rel: "mentioned_in", label: "Mentioned in", run: (ctx, file, page) => mentionedIn(ctx, "file", file.id, page) },
  ],
};

type PageAnchor = NonNullable<Awaited<ReturnType<typeof loadPage>>>;

function loadPage(ctx: GraphCtx, id: string) {
  return ctx.db.taskPage.findFirst({ where: { id, userId: ctx.userId, deletedAt: null }, select: { id: true, title: true, taskId: true, parentId: true, notesSnapshot: true, updatedAt: true, parent: { select: { id: true, title: true, deletedAt: true } } } });
}

const pageSpec: KindSpec<PageAnchor> = {
  load: loadPage,
  detail: (_ctx, page) => ({ ...card("page", page.id, page.title || "Untitled page", { when: iso(page.updatedAt) }), summary: clip(page.notesSnapshot, 700), facts: {} }),
  relations: [
    { rel: "mentions", label: "Mentions", run: async (ctx, row, page) => (await ctx.db.taskPageMention.findMany({ where: { pageId: row.id }, ...take(page), select: { kind: true, entityId: true, label: true } })).map((mention) => card(mentionGraphKind(mention.kind), mention.entityId, mention.label)) },
    { rel: "parent", label: "Inside", run: async (_ctx, row) => (row.parent && !row.parent.deletedAt ? [card("page", row.parent.id, row.parent.title || "Untitled page")] : []) },
    { rel: "children", label: "Pages inside", run: async (ctx, row, page) => (await ctx.db.taskPage.findMany({ where: { userId: ctx.userId, deletedAt: null, parentId: row.id }, orderBy: { updatedAt: "desc" }, ...take(page), select: { id: true, title: true, updatedAt: true } })).map((child) => card("page", child.id, child.title || "Untitled page", { when: iso(child.updatedAt) })) },
    { rel: "files", label: "Files", run: async (ctx, row, page) => slicePage((await filesOnPage(ctx.db as PrismaClient, ctx.userId, row.id)).map((file) => card("file", file.id, file.filename)), page) },
  ],
};

type EventAnchor = NonNullable<Awaited<ReturnType<typeof loadEvent>>>;

function loadEvent(ctx: GraphCtx, id: string) {
  // A member of a shared space never sees the owner's calendar (sharing/context.ts PRIVATE_ARTIFACT_KINDS).
  return ctx.db.artifact.findFirst({ where: { id, userId: ctx.userId, kind: "event", deletedAt: null, AND: [visibleArtifacts(ctx.userId)] }, select: { id: true, title: true, ts: true, participants: true, metadata: true, projectId: true, url: true } });
}

const eventSpec: KindSpec<EventAnchor> = {
  load: loadEvent,
  detail: (_ctx, event) => {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    return { ...card("event", event.id, event.title || "Event", { when: iso(event.ts) }), summary: [meta.location, meta.joinUrl ? "online meeting" : null].filter(Boolean).join(" · "), facts: { end: meta.end ?? null, organizer: meta.organizer ?? null, joinUrl: meta.joinUrl ?? null } };
  },
  relations: [
    {
      rel: "meetings",
      label: "Notes for this meeting",
      run: async (ctx, event, page) => {
        const [notes, sessions] = await Promise.all([
          ctx.db.meetingNote.findMany({ where: { userId: ctx.userId, deletedAt: null, OR: [{ eventArtifactId: event.id }, { artifactId: event.id }] }, select: { id: true, title: true, occurredAt: true, askedAt: true } }),
          ctx.db.meetingSession.findMany({ where: { userId: ctx.userId, deletedAt: null, artifactId: event.id, meetingNoteId: null }, select: { id: true, title: true, startedAt: true } }),
        ]);
        return slicePage([...notes.map((row) => meetingCard({ id: row.id, title: row.title, at: row.occurredAt ?? row.askedAt })), ...sessions.map((row) => meetingCard({ id: row.id, title: row.title, at: row.startedAt, kind: "session" }))], page);
      },
    },
    {
      rel: "people",
      label: "Attendees in People",
      run: async (ctx, event, page) => {
        const emails = (Array.isArray(event.participants) ? (event.participants as Array<{ email?: string | null }>) : []).map((row) => row.email?.toLowerCase()).filter((value): value is string => Boolean(value));
        if (!emails.length) return [];
        const identities = await ctx.db.personIdentity.findMany({ where: { userId: ctx.userId, kind: "email", value: { in: emails }, person: { deletedAt: null } }, select: { person: { select: { id: true, name: true, role: true, relationship: true } } } });
        const people = new Map(identities.map((row) => [row.person.id, row.person]));
        return slicePage([...people.values()].map((person) => card("person", person.id, person.name, { role: person.role, detail: person.relationship })), page);
      },
    },
    { rel: "project", label: "Project", run: async (ctx, event) => (event.projectId ? (await ctx.db.project.findMany({ where: { id: event.projectId, userId: ctx.userId, deletedAt: null }, select: { id: true, name: true } })).map((row) => card("project", row.id, row.name)) : []) },
  ],
};

const SPECS: Record<GraphKind, KindSpec<any>> = {
  task: taskSpec,
  project: projectSpec,
  person: personSpec,
  repo: repoSpec,
  deliverable: deliverableSpec,
  meeting: meetingSpec,
  file: fileSpec,
  page: pageSpec,
  event: eventSpec,
};

/** The relations one kind has, for help text and validation. */
export function relationsOf(kind: GraphKind): Array<{ rel: string; label: string }> {
  return SPECS[kind].relations.map(({ rel, label }) => ({ rel, label }));
}

export interface NeighborOptions {
  /** One relation, paged with `offset`. Omitted: every relation, `limit` items each. */
  rel?: string;
  limit?: number;
  offset?: number;
}

export class GraphError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

/**
 * One record and what it links to. A task page resolves to its task. Null when the record does not
 * exist in this space (or is in Trash).
 */
export async function itemNeighbors(ctx: GraphCtx, input: ItemRef, options: NeighborOptions = {}): Promise<Neighborhood | null> {
  let ref = input;
  if (ref.kind === "page") {
    const page = await ctx.db.taskPage.findFirst({ where: { id: ref.id, userId: ctx.userId, deletedAt: null }, select: { taskId: true } });
    if (page?.taskId) ref = { kind: "task", id: page.taskId };
  }
  const spec = SPECS[ref.kind];
  const anchor = await spec.load(ctx, ref.id);
  if (!anchor) return null;
  const limit = Math.min(Math.max(options.limit ?? (options.rel ? 20 : 6), 1), 50);
  const offset = Math.max(options.offset ?? 0, 0);
  const relations = options.rel ? spec.relations.filter((relation) => relation.rel === options.rel) : spec.relations;
  if (options.rel && !relations.length) {
    throw new GraphError(`A ${ref.kind} has no relation “${options.rel}”. Use one of: ${spec.relations.map((relation) => relation.rel).join(", ")}.`);
  }
  const [detail, groups] = await Promise.all([
    spec.detail(ctx, anchor),
    Promise.all(
      relations.map(async (relation) => {
        const rows = await relation.run(ctx, anchor, { limit, offset: options.rel ? offset : 0 });
        return { rel: relation.rel, label: relation.label, ...paged(rows, { limit, offset }) };
      }),
    ),
  ]);
  return { item: detail, groups: options.rel ? groups : groups.filter((group) => group.items.length > 0) };
}
