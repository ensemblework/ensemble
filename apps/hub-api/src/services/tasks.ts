/**
 * Task writes shared by REST and the assistant. A tool must not skip a field
 * the route would persist, or the bookkeeping (transition, completedAt, undo).
 */
import type { Actor, Prisma, PrismaClient, Task, TaskStatus } from "@prisma/client";
import { inferComplexity } from "../lib/complexity.js";
import { parseDue } from "../lib/clock.js";
import { assertTransition } from "../lib/state-machine.js";
import { recordUndoInTransaction } from "../lib/undo.js";
import { assertOwned } from "./records.js";
import { CreateTask, TaskLabels } from "@ensemble/shared-types";
import { actorFor } from "../sharing/context.js";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export interface TaskDraft {
  title: string;
  description?: string;
  notes?: string;
  owner?: Task["owner"];
  status?: TaskStatus;
  priority?: Task["priority"];
  complexity?: Task["complexity"];
  due?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  people?: string[];
  labels?: string[];
  sourceKind?: Task["sourceKind"];
  todayFocus?: string;
  skillIds?: string[];
  repoId?: string | null;
  deliverableId?: string | null;
  boardOrder?: number;
  /** In a shared space: who a "me" task is with. */
  assignee?: string | null;
  sourceRef?: string;
  taskType?: string | null;
  measure?: number | null;
  startsAt?: string | null;
  matterStage?: string | null;
  court?: string | null;
  orderDate?: string | null;
  subject?: string | null;
  weight?: number | null;
  wordCount?: number | null;
  pipelineStage?: string | null;
  limitationRule?: string | null;
}

export interface TaskPatch extends Partial<TaskDraft> {
  snoozedUntil?: string | null;
  nudgePausedUntil?: string | null;
  pinned?: boolean;
  /** Current title the caller believes this id has. Not stored. */
  matchTitle?: string;
}

/**
 * Who a task is with. "me" is relative: the person acting (null when that is the space's owner).
 * An explicit assignee must be the space's owner or one of its members.
 */
async function resolveAssignee(tx: Tx, spaceId: string, owner: string | undefined, assignee: string | null | undefined): Promise<{ owner?: Task["owner"]; assigneeAccountId?: string | null }> {
  if (assignee !== undefined && assignee !== null) {
    const space = await tx.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
    const spaceOwner = space?.ownerId ?? space?.id ?? spaceId;
    if (assignee === spaceOwner || assignee === spaceId) return { owner: "me", assigneeAccountId: null };
    const member = await tx.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId, accountId: assignee } }, select: { id: true } });
    if (!member) throw Object.assign(new Error("Assign it to someone this space is shared with."), { statusCode: 400 });
    return { owner: "me", assigneeAccountId: assignee };
  }
  if (owner === "me") return { owner: "me", assigneeAccountId: actorFor(spaceId) };
  if (owner === "agent" || owner === "unassigned" || assignee === null) return { owner: owner as Task["owner"] | undefined, assigneeAccountId: null };
  return {};
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const PRIORITY_LABEL: Record<string, string> = { critical: "Critical", p0: "High", p1: "Medium", p2: "Low" };
const STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  todo: "To do",
  in_progress: "In progress",
  waiting_approval: "Waiting for me",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

export function labelPriority(value: string | null | undefined): string {
  if (!value) return "—";
  return PRIORITY_LABEL[value] ?? value;
}

export function labelStatus(value: string | null | undefined): string {
  if (!value) return "—";
  return STATUS_LABEL[value] ?? value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function titlesMatch(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

export async function resolveProjectId(
  db: Db,
  userId: string,
  projectId?: string | null,
  projectName?: string | null,
): Promise<string | null | undefined> {
  if (projectId) {
    await assertOwned(db, userId, "project", projectId);
    return projectId;
  }
  if (!projectName) return projectId;
  const project = await db.project.findFirst({
    where: { userId, deletedAt: null, name: { equals: projectName, mode: "insensitive" } },
    select: { id: true },
  });
  if (!project) {
    throw Object.assign(new Error(`No project named “${projectName}”. Create it first, or use the exact name.`), { statusCode: 400 });
  }
  return project.id;
}

async function nextBoardOrder(db: Db, userId: string): Promise<number> {
  const last = await db.task.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { boardOrder: "desc" },
    select: { boardOrder: true },
  });
  return (last?.boardOrder ?? 0) + 1;
}

async function assertLinked(tx: Tx, userId: string, draft: { deliverableId?: string | null; repoId?: string | null; people?: string[]; skillIds?: string[] }): Promise<void> {
  if (draft.deliverableId) await assertOwned(tx, userId, "deliverable", draft.deliverableId);
  if (draft.repoId) await assertOwned(tx, userId, "repo", draft.repoId);
  for (const person of draft.people ?? []) {
    if (UUID_RE.test(person)) await assertOwned(tx, userId, "person", person);
  }
  for (const id of draft.skillIds ?? []) {
    const skill = await tx.skill.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
    if (!skill) throw Object.assign(new Error("That skill was not found."), { statusCode: 404 });
  }
}

export async function createTask(tx: Tx, userId: string, draft: TaskDraft, actor: Actor, journal = true): Promise<Task> {
  const title = CreateTask.shape.title.parse(draft.title);
  const projectId = await resolveProjectId(tx, userId, draft.projectId, draft.projectName);
  await assertLinked(tx, userId, draft);
  const status = draft.status ?? "proposed";
  const created = await tx.task.create({
    data: {
      userId,
      title,
      description: draft.description ?? "",
      notes: draft.notes ?? "",
      ...(await (async () => {
        const who = await resolveAssignee(tx, userId, draft.owner, draft.assignee);
        return { owner: who.owner ?? draft.owner ?? "unassigned", assigneeAccountId: who.assigneeAccountId ?? null };
      })()),
      status,
      priority: draft.priority ?? "p1",
      complexity: draft.complexity ?? inferComplexity({ title: draft.title, description: draft.description }),
      due: parseDue(draft.due) ?? null,
      projectId: projectId ?? null,
      people: draft.people ?? [],
      labels: draft.labels === undefined ? [] : TaskLabels.parse(draft.labels),
      sourceKind: draft.sourceKind ?? "manual",
      sourceRef: draft.sourceRef ?? (actor === "agent" ? "assistant" : ""),
      todayFocus: draft.todayFocus ?? "auto",
      skillIds: draft.skillIds ?? [],
      repoId: draft.repoId ?? null,
      deliverableId: draft.deliverableId ?? null,
      createdBy: actor,
      boardOrder: draft.boardOrder ?? (await nextBoardOrder(tx, userId)),
      taskType: draft.taskType ?? null,
      measure: draft.measure ?? null,
      startsAt: asDate(draft.startsAt),
      matterStage: draft.matterStage ?? null,
      court: draft.court ?? null,
      orderDate: asDate(draft.orderDate),
      subject: draft.subject ?? null,
      weight: draft.weight ?? null,
      wordCount: draft.wordCount ?? null,
      pipelineStage: draft.pipelineStage ?? null,
      limitationRule: draft.limitationRule ?? null,
      completedAt: status === "done" || status === "dropped" ? new Date() : null,
    },
  });
  await tx.taskTransition.create({
    data: {
      userId,
      taskId: created.id,
      fromStatus: null,
      toStatus: created.status,
      fromOwner: null,
      toOwner: created.owner,
      actor,
      reason: "created",
    },
  });
  if (journal) await recordUndoInTransaction(tx, {
    userId,
    label: `Added “${created.title}”`,
    kind: "create",
    actor,
    subject: "task",
    href: `/tasks/${created.id}`,
    inverse: { op: "delete", model: "task", id: created.id, data: created as unknown as Record<string, unknown> },
    forward: { op: "create", model: "task", id: created.id, data: created as unknown as Record<string, unknown> },
  });
  return created;
}

export async function updateTask(tx: Tx, userId: string, id: string, patch: TaskPatch, actor: Actor): Promise<Task> {
  const existing = await tx.task.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw Object.assign(new Error("That task is not on your board."), { statusCode: 404 });
  const claimed = patch.matchTitle;
  if (claimed && !titlesMatch(claimed, existing.title)) {
    throw Object.assign(
      new Error(`That id is “${existing.title}”, not “${claimed}”. Search by the exact title and use the id it returns.`),
      { statusCode: 409 },
    );
  }
  if (patch.status && patch.status !== existing.status) assertTransition(existing.status, patch.status);
  await assertLinked(tx, userId, patch);
  const projectId =
    patch.projectId !== undefined || patch.projectName
      ? await resolveProjectId(tx, userId, patch.projectId, patch.projectName)
      : undefined;
  const enteringDone = patch.status === "done" || patch.status === "dropped";
  const leavingDone = Boolean(patch.status && patch.status !== "done" && patch.status !== "dropped" && (existing.status === "done" || existing.status === "dropped"));
  const who = await resolveAssignee(tx, userId, patch.owner, patch.assignee);
  const updated = await tx.task.update({
    where: { id },
    data: {
      title: patch.title === undefined ? undefined : CreateTask.shape.title.parse(patch.title),
      description: patch.description,
      notes: patch.notes,
      owner: who.owner ?? patch.owner,
      ...(who.assigneeAccountId !== undefined ? { assigneeAccountId: who.assigneeAccountId } : {}),
      status: patch.status,
      priority: patch.priority,
      complexity: patch.complexity,
      complexitySource: patch.complexity ? (actor === "me" ? "me" : undefined) : undefined,
      due: parseDue(patch.due),
      projectId,
      people: patch.people,
      labels: patch.labels === undefined ? undefined : TaskLabels.parse(patch.labels),
      todayFocus: patch.todayFocus,
      boardOrder: patch.boardOrder,
      repoId: patch.repoId,
      deliverableId: patch.deliverableId,
      skillIds: patch.skillIds,
      taskType: patch.taskType,
      measure: patch.measure,
      pinned: patch.pinned,
      snoozedUntil: patch.snoozedUntil === undefined ? undefined : patch.snoozedUntil ? new Date(patch.snoozedUntil) : null,
      nudgePausedUntil: patch.nudgePausedUntil === undefined ? undefined : patch.nudgePausedUntil ? new Date(patch.nudgePausedUntil) : null,
      completedAt: enteringDone ? new Date() : leavingDone ? null : undefined,
    },
  });
  if (patch.status || patch.owner) {
    await tx.taskTransition.create({
      data: {
        userId,
        taskId: id,
        fromStatus: existing.status,
        toStatus: updated.status,
        fromOwner: existing.owner,
        toOwner: updated.owner,
        actor,
      },
    });
  }
  await recordUndoInTransaction(tx, {
    userId,
    label: `Updated “${updated.title}”`,
    kind: "update",
    actor,
    subject: "task",
    href: `/tasks/${id}`,
    inverse: {
      op: "update",
      model: "task",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    },
    forward: {
      op: "update",
      model: "task",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    },
  });
  return updated;
}

export function taskChangePreview(title: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
  const parts: string[] = [];
  const show = (key: string, label: string, format: (value: unknown) => string = (value) => String(value ?? "—")) => {
    if (after[key] === undefined || after[key] === before[key]) return;
    parts.push(`${label} ${format(before[key])} → ${format(after[key])}`);
  };
  show("title", "title");
  show("status", "status", (value) => labelStatus(String(value ?? "")));
  show("priority", "priority", (value) => labelPriority(String(value ?? "")));
  show("owner", "owner");
  show("due", "due", (value) => (value ? String(value).slice(0, 10) : "none"));
  show("projectName", "project");
  show("complexity", "complexity");
  const rest = parts.length ? parts.join(", ") : "details";
  return `Update “${title}”: ${rest}`;
}
