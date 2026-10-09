/**
 * Stores normalized import items. Re-running an import finds rows by
 * (external_source, external_id) and updates them instead of adding copies.
 * Page bodies the person has edited since the last import are kept.
 */
import { Prisma, type PrismaClient, type TaskStatus } from "@prisma/client";
import { PageDocument, type PageNode } from "@ensemble/shared-types";
import { inferComplexity } from "../lib/complexity.js";
import { markdownToNodes, pageSearchText } from "../pages/markdown.js";
import { separateLists } from "./markdown.js";
import {
  cleanLabels,
  cleanPeople,
  cleanTitle,
  dueToDate,
  mapPriority,
  resolveStatus,
  splitDescription,
} from "./mapping.js";
import type { ImportAs, ImportCounts, ImportItem, WritePlan } from "./types.js";
import { linkedProject, rememberImportLink } from "../projects/links.js";

type Tx = Prisma.TransactionClient;

export const CREATED_CAP = 10_000;
const MAX_PAGE_MARKDOWN = 200_000;
const IMPORT_MARKER = "import";

export interface CreatedIds {
  tasks: string[];
  pages: string[];
  projects: string[];
  /** True once more rows were created than the lists keep. Undo then also matches by time. */
  truncated: boolean;
}

export interface WriterState {
  userId: string;
  plan: WritePlan;
  counts: ImportCounts;
  created: CreatedIds;
  /** "id:<external id>" or "name:<lower name>" → project id. */
  projects: Map<string, string>;
  nextOrder: number | null;
}

export function newWriterState(userId: string, plan: WritePlan, counts: ImportCounts, created?: CreatedIds): WriterState {
  return {
    userId,
    plan,
    counts,
    created: created ?? { tasks: [], pages: [], projects: [], truncated: false },
    projects: new Map(),
    nextOrder: null,
  };
}

function remember(state: WriterState, list: "tasks" | "pages" | "projects", id: string): void {
  const ids = state.created[list];
  if (ids.length < CREATED_CAP) ids.push(id);
  else state.created.truncated = true;
}

function effectiveKind(item: ImportItem, importAs: Record<string, ImportAs>): "task" | "page" | "project" {
  if (item.kind === "project") return "project";
  const choice = item.containerId ? importAs[item.containerId] : undefined;
  if (choice === "pages") return "page";
  if (choice === "tasks") return "task";
  return item.kind;
}

// ── projects ────────────────────────────────────────────────────────────────

async function uniqueName(tx: Tx, userId: string, base: string): Promise<string> {
  for (let n = 2; n < 50; n += 1) {
    const name = `${base} (${n})`;
    if (!(await tx.project.findFirst({ where: { userId, name }, select: { id: true } }))) return name;
  }
  return `${base} (${Date.now()})`;
}

export async function ensureProject(tx: Tx, state: WriterState, ref: string | null | undefined, name: string | null | undefined, summary?: string | null): Promise<string | null> {
  const title = cleanTitle(name ?? "").slice(0, 200);
  if (!ref && (!name || title === "Untitled")) return null;
  const key = ref ? `id:${ref}` : `name:${title.toLowerCase()}`;
  const cached = state.projects.get(key);
  if (cached) return cached;
  const { userId } = state;
  const externalSource = state.plan.externalSource;
  const remember_ = (id: string) => {
    state.projects.set(key, id);
    return id;
  };
  if (ref) {
    const linked = await tx.project.findFirst({ where: { userId, externalSource, externalId: ref }, select: { id: true, deletedAt: true } });
    if (linked) {
      if (linked.deletedAt) {
        await tx.project.update({ where: { id: linked.id }, data: { deletedAt: null } });
        remember(state, "projects", linked.id);
        state.counts.projects.created += 1;
      } else state.counts.projects.linked += 1;
      await rememberImportLink(tx, userId, linked.id, externalSource, ref, title);
      return remember_(linked.id);
    }
    // "This board is Project Atlas", set on the project page, wins over making a new project.
    const chosen = await linkedProject(tx, userId, externalSource, ref);
    if (chosen) {
      state.counts.projects.linked += 1;
      return remember_(chosen);
    }
  }
  const byName = await tx.project.findFirst({
    where: { userId, name: { equals: title, mode: "insensitive" } },
    select: { id: true, deletedAt: true, externalSource: true, externalId: true },
  });
  if (byName && !byName.deletedAt && !(ref && byName.externalSource === externalSource && byName.externalId && byName.externalId !== ref)) {
    state.counts.projects.linked += 1;
    if (ref) await rememberImportLink(tx, userId, byName.id, externalSource, ref, title);
    return remember_(byName.id);
  }
  if (byName?.deletedAt && !byName.externalId) {
    await tx.project.update({
      where: { id: byName.id },
      data: { deletedAt: null, ...(ref ? { externalSource, externalId: ref } : {}) },
    });
    remember(state, "projects", byName.id);
    state.counts.projects.created += 1;
    if (ref) await rememberImportLink(tx, userId, byName.id, externalSource, ref, title);
    return remember_(byName.id);
  }
  const project = await tx.project.create({
    data: {
      userId,
      name: byName ? await uniqueName(tx, userId, title) : title,
      summary: (summary ?? "").slice(0, 2000),
      createdBy: "me",
      confidence: 1,
      evidence: [`Imported from ${state.plan.sourceLabel}`],
      ...(ref ? { externalSource, externalId: ref } : {}),
    },
    select: { id: true },
  });
  remember(state, "projects", project.id);
  state.counts.projects.created += 1;
  if (ref) await rememberImportLink(tx, userId, project.id, externalSource, ref, title);
  return remember_(project.id);
}

// ── pages ───────────────────────────────────────────────────────────────────

type Marker = { id: string; kind: string; data?: Record<string, unknown> };

function marker(revision: number): Marker[] {
  return [{ id: IMPORT_MARKER, kind: IMPORT_MARKER, data: { revision } }];
}

/** True when nobody edited the page since an import wrote it (a save drops the marker or bumps the revision). */
export function pageUntouched(page: { revision: number; content: unknown; annotations: unknown }): boolean {
  if (!page.content) return true;
  const list = Array.isArray(page.annotations) ? (page.annotations as Marker[]) : [];
  const mark = list.find((entry) => entry?.kind === IMPORT_MARKER);
  return Boolean(mark && Number(mark.data?.revision) === page.revision);
}

function breadcrumb(state: WriterState, item: ImportItem): PageNode[] {
  const parts: PageNode[] = [{ type: "text", text: `Imported from ${state.plan.sourceLabel}`, marks: [{ type: "italic" }] }];
  if (item.parentTitle) parts.push({ type: "text", text: ` · in ${item.parentTitle}`, marks: [{ type: "italic" }] });
  if (item.url && /^https?:\/\//.test(item.url)) {
    parts.push({ type: "text", text: " · " });
    parts.push({ type: "text", text: "Open original", marks: [{ type: "link", attrs: { href: item.url } }] });
  }
  return [{ type: "paragraph", content: parts }];
}

function documentFor(markdown: string, lead: PageNode[] = []): PageDocument {
  markdown = separateLists(markdown);
  const body = markdown.length > MAX_PAGE_MARKDOWN ? `${markdown.slice(0, MAX_PAGE_MARKDOWN)}\n\n(The rest of this page was too long to import.)` : markdown;
  return PageDocument.parse({ type: "doc", content: [...lead, ...(body.trim() ? markdownToNodes(body) : [{ type: "paragraph" }])] });
}

/** Stable JSON: Postgres jsonb reorders keys, so compare with sorted keys. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

async function writeTaskPage(
  tx: Tx,
  state: WriterState,
  task: { id: string; title: string },
  existing: { id: string; revision: number; content: unknown; annotations: unknown } | null,
  markdown: string,
): Promise<void> {
  const content = documentFor(markdown);
  if (existing) {
    if (!pageUntouched(existing)) return;
    if (same(existing.content, content)) return;
    const revision = existing.revision + 1;
    await tx.taskPage.update({
      where: { id: existing.id },
      data: {
        revision,
        content: content as Prisma.InputJsonValue,
        annotations: marker(revision) as Prisma.InputJsonValue,
        searchText: pageSearchText(task.title, content, ""),
      },
    });
    return;
  }
  await tx.taskPage.create({
    data: {
      userId: state.userId,
      taskId: task.id,
      revision: 1,
      content: content as Prisma.InputJsonValue,
      annotations: marker(1) as Prisma.InputJsonValue,
      notesSnapshot: "",
      searchText: pageSearchText(task.title, content, ""),
    },
  });
}

async function writePages(tx: Tx, state: WriterState, items: ImportItem[]): Promise<void> {
  if (!items.length) return;
  const { userId } = state;
  const externalSource = state.plan.externalSource;
  const existing = await tx.taskPage.findMany({
    where: { userId, externalSource, externalId: { in: items.map((item) => item.externalId) } },
    select: { id: true, revision: true, content: true, annotations: true, title: true, externalId: true, deletedAt: true },
  });
  const byId = new Map(existing.map((row) => [row.externalId!, row]));
  for (const item of items) {
    const title = cleanTitle(item.title);
    const markdown = [item.description ?? "", item.pageMarkdown ?? ""].filter((part) => part.trim()).join("\n\n");
    const content = documentFor(markdown, breadcrumb(state, item));
    const found = byId.get(item.externalId);
    if (found) {
      if (found.deletedAt || !pageUntouched(found)) {
        state.counts.pages.keptEdits += 1;
        continue;
      }
      if (found.title === title && same(found.content, content)) {
        state.counts.pages.unchanged += 1;
        continue;
      }
      const revision = found.revision + 1;
      await tx.taskPage.update({
        where: { id: found.id },
        data: {
          title,
          revision,
          content: content as Prisma.InputJsonValue,
          annotations: marker(revision) as Prisma.InputJsonValue,
          searchText: pageSearchText(title, content, ""),
        },
      });
      state.counts.pages.updated += 1;
      continue;
    }
    const page = await tx.taskPage.create({
      data: {
        userId,
        taskId: null,
        title,
        revision: 1,
        content: content as Prisma.InputJsonValue,
        annotations: marker(1) as Prisma.InputJsonValue,
        notesSnapshot: "",
        searchText: pageSearchText(title, content, ""),
        externalSource,
        externalId: item.externalId,
      },
      select: { id: true },
    });
    remember(state, "pages", page.id);
    state.counts.pages.created += 1;
  }
}

// ── tasks ───────────────────────────────────────────────────────────────────

function timeOf(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

async function writeTasks(tx: Tx, state: WriterState, items: ImportItem[]): Promise<void> {
  if (!items.length) return;
  const { userId, plan } = state;
  const externalSource = plan.externalSource;
  const existing = await tx.task.findMany({
    where: { userId, externalSource, externalId: { in: items.map((item) => item.externalId) } },
    include: { page: { select: { id: true, revision: true, content: true, annotations: true } } },
  });
  const byId = new Map(existing.map((row) => [row.externalId!, row]));
  if (state.nextOrder === null) {
    const last = await tx.task.findFirst({ where: { userId, deletedAt: null }, orderBy: { boardOrder: "desc" }, select: { boardOrder: true } });
    state.nextOrder = (last?.boardOrder ?? 0) + 1;
  }
  const now = new Date();
  const fresh: Array<{ item: ImportItem; data: Prisma.TaskCreateManyInput; page: string | null }> = [];
  for (const item of items) {
    const title = cleanTitle(item.title);
    const split = splitDescription(item.description, item.pageMarkdown);
    const status: TaskStatus = resolveStatus(item, plan.statusMap);
    const closed = status === "done" || status === "dropped";
    const projectId = await ensureProject(tx, state, item.projectRef, item.projectName);
    const fields = {
      title,
      description: split.description,
      status,
      priority: mapPriority(item.priority),
      due: dueToDate(item.dueDate),
      startsAt: dueToDate(item.startDate),
      people: cleanPeople(item.assignees ?? []),
      labels: cleanLabels(item.labels ?? []),
      sourceUrl: item.url && /^https?:\/\//.test(item.url) ? item.url.slice(0, 2000) : null,
    };
    const completedAt = closed ? dueToDate(item.completedAt) ?? now : null;
    const found = byId.get(item.externalId);
    if (found) {
      const revive = Boolean(found.deletedAt);
      const changed =
        revive ||
        found.title !== fields.title ||
        found.description !== fields.description ||
        found.status !== fields.status ||
        found.priority !== fields.priority ||
        timeOf(found.due) !== timeOf(fields.due) ||
        timeOf(found.startsAt) !== timeOf(fields.startsAt) ||
        found.people.join("\u0000") !== fields.people.join("\u0000") ||
        found.labels.join("\u0000") !== fields.labels.join("\u0000") ||
        found.sourceUrl !== fields.sourceUrl ||
        (projectId !== null && found.projectId !== projectId);
      if (changed) {
        const wasClosed = found.status === "done" || found.status === "dropped";
        await tx.task.update({
          where: { id: found.id },
          data: {
            ...fields,
            ...(projectId ? { projectId } : {}),
            ...(revive ? { deletedAt: null } : {}),
            completedAt: closed ? (wasClosed ? found.completedAt ?? completedAt : completedAt) : null,
          },
        });
        if (found.status !== fields.status) {
          await tx.taskTransition.create({
            data: { userId, taskId: found.id, fromStatus: found.status, toStatus: fields.status, fromOwner: found.owner, toOwner: found.owner, actor: "me", reason: "import" },
          });
        }
        if (revive) {
          remember(state, "tasks", found.id);
          state.counts.tasks.created += 1;
        } else state.counts.tasks.updated += 1;
      } else state.counts.tasks.unchanged += 1;
      if (split.page) await writeTaskPage(tx, state, { id: found.id, title: fields.title }, found.page, split.page);
      continue;
    }
    fresh.push({
      item,
      page: split.page,
      data: {
        userId,
        ...fields,
        notes: "",
        owner: "me",
        complexity: inferComplexity({ title, description: split.description }),
        projectId,
        sourceKind: plan.sourceKind,
        sourceRef: `import:${externalSource}`,
        createdBy: "me",
        boardOrder: state.nextOrder++,
        completedAt,
        externalSource,
        externalId: item.externalId,
      },
    });
  }
  if (!fresh.length) return;
  const rows = await tx.task.createManyAndReturn({
    data: fresh.map((entry) => entry.data),
    select: { id: true, title: true, status: true, externalId: true },
  });
  await tx.taskTransition.createMany({
    data: rows.map((row) => ({ userId, taskId: row.id, fromStatus: null, toStatus: row.status, fromOwner: null, toOwner: "me" as const, actor: "me" as const, reason: "imported" })),
  });
  const pages = new Map(fresh.map((entry) => [entry.item.externalId, entry.page]));
  for (const row of rows) {
    remember(state, "tasks", row.id);
    state.counts.tasks.created += 1;
    const page = pages.get(row.externalId!);
    if (page) await writeTaskPage(tx, state, row, null, page);
  }
}

/** Writes one batch in one transaction. Items are grouped so projects exist before tasks link to them. */
export async function writeBatch(prisma: PrismaClient, state: WriterState, items: ImportItem[]): Promise<void> {
  const groups = { project: [] as ImportItem[], task: [] as ImportItem[], page: [] as ImportItem[] };
  const seen = new Set<string>();
  for (const item of items) {
    const kind = effectiveKind(item, state.plan.importAs);
    const key = `${kind}:${item.externalId}`;
    if (!item.externalId || seen.has(key)) {
      state.counts.skipped += 1;
      continue;
    }
    seen.add(key);
    groups[kind].push(item);
  }
  // Roll the counters back if the transaction fails, so a retry does not double count.
  const before = JSON.stringify(state.counts);
  const createdBefore = { tasks: state.created.tasks.length, pages: state.created.pages.length, projects: state.created.projects.length };
  const projectsBefore = new Map(state.projects);
  const orderBefore = state.nextOrder;
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const item of groups.project) await ensureProject(tx, state, item.externalId, item.title, item.description);
        await writeTasks(tx, state, groups.task);
        await writePages(tx, state, groups.page);
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (error) {
    Object.assign(state.counts, JSON.parse(before) as ImportCounts);
    state.created.tasks.length = createdBefore.tasks;
    state.created.pages.length = createdBefore.pages;
    state.created.projects.length = createdBefore.projects;
    state.projects = projectsBefore;
    state.nextOrder = orderBefore;
    throw error;
  }
}
