/**
 * Writes for people, projects, repos, deliverables, and reminders.
 * REST routes and assistant tools both call these.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Actor, Prisma, PrismaClient } from "@prisma/client";
import { isHmTime, isIsoDate, nextNotificationAt, parseDue } from "../lib/clock.js";
import { recordUndoInTransaction } from "../lib/undo.js";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

function titleDoc(title: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }] };
}

export function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

const OWNED = ["project", "person", "deliverable", "repo", "reminder", "task"] as const;
type OwnedKind = (typeof OWNED)[number];

/** A write may only use a row this user can see. Missing and foreign ids are the same 404. */
export async function assertOwned(db: Db, userId: string, kind: OwnedKind, id: string): Promise<void> {
  const delegate = db[kind] as unknown as { findFirst: (args: unknown) => Promise<{ id: string } | null> };
  const row = await delegate.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
  if (!row) throw notFound(`That ${kind} was not found.`);
}

export async function createPerson(
  tx: Tx,
  userId: string,
  input: { name: string; email?: string | null; role?: string | null; team?: string | null },
  actor: Actor,
) {
  const person = await tx.person.create({
    data: {
      userId,
      name: input.name,
      email: input.email ?? null,
      role: input.role ?? null,
      team: input.team ?? null,
      upn: input.email ?? null,
    },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Added ${person.name}`,
    kind: "create",
    actor,
    subject: "person",
    href: "/context",
    inverse: { op: "delete", model: "person", id: person.id, data: person as unknown as Record<string, unknown> },
    forward: { op: "create", model: "person", id: person.id, data: person as unknown as Record<string, unknown> },
  });
  return person;
}

export async function updatePerson(
  tx: Tx,
  userId: string,
  id: string,
  patch: { name?: string; email?: string | null; role?: string | null; team?: string | null },
  actor: Actor,
) {
  const existing = await tx.person.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw notFound("That person was not found.");
  const person = await tx.person.update({ where: { id }, data: patch });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Updated ${person.name}`,
    kind: "update",
    actor,
    subject: "person",
    inverse: {
      op: "update",
      model: "person",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: person as unknown as Record<string, unknown>,
    },
    forward: {
      op: "update",
      model: "person",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: person as unknown as Record<string, unknown>,
    },
  });
  return person;
}

export async function createProject(tx: Tx, userId: string, input: { name: string; summary?: string }, actor: Actor) {
  const project = await tx.project.create({
    data: { userId, name: input.name, summary: input.summary ?? "", createdBy: actor },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Created “${project.name}”`,
    kind: "create",
    actor,
    subject: "project",
    href: `/projects/${project.id}`,
    inverse: { op: "delete", model: "project", id: project.id, data: project as unknown as Record<string, unknown> },
    forward: { op: "create", model: "project", id: project.id, data: project as unknown as Record<string, unknown> },
  });
  return project;
}

export async function createDeliverable(
  tx: Tx,
  userId: string,
  input: { projectId?: string | null; projectName?: string | null; title: string; due?: string | null; notes?: string; owner?: string | null },
  actor: Actor,
) {
  let projectId = input.projectId ?? null;
  if (projectId) await assertOwned(tx, userId, "project", projectId);
  if (!projectId && input.projectName) {
    const project = await tx.project.findFirst({
      where: { userId, deletedAt: null, name: { equals: input.projectName, mode: "insensitive" } },
    });
    if (!project) throw Object.assign(new Error(`No project named “${input.projectName}”.`), { statusCode: 400 });
    projectId = project.id;
  }
  if (!projectId) throw Object.assign(new Error("A deliverable needs a project."), { statusCode: 400 });
  const row = await tx.deliverable.create({
    data: {
      userId,
      projectId,
      title: input.title,
      notes: input.notes ?? "",
      owner: input.owner ?? null,
      due: parseDue(input.due) ?? null,
      createdBy: actor,
    },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Added deliverable “${row.title}”`,
    kind: "create",
    actor,
    subject: "deliverable",
    href: `/projects/${projectId}`,
    inverse: { op: "delete", model: "deliverable", id: row.id, data: row as unknown as Record<string, unknown> },
    forward: { op: "create", model: "deliverable", id: row.id, data: row as unknown as Record<string, unknown> },
  });
  return row;
}

export async function updateDeliverable(
  tx: Tx,
  userId: string,
  id: string,
  patch: { title?: string; notes?: string; status?: "upcoming" | "completed"; due?: string | null; owner?: string | null; pinned?: boolean },
  actor: Actor,
) {
  const existing = await tx.deliverable.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw notFound("That deliverable was not found.");
  const row = await tx.deliverable.update({
    where: { id },
    data: {
      title: patch.title,
      notes: patch.notes,
      status: patch.status,
      owner: patch.owner,
      pinned: patch.pinned,
      due: parseDue(patch.due),
      completedAt: patch.status === "completed" ? new Date() : patch.status === "upcoming" ? null : undefined,
    },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Updated “${row.title}”`,
    kind: "update",
    actor,
    subject: "deliverable",
    inverse: {
      op: "update",
      model: "deliverable",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: row as unknown as Record<string, unknown>,
    },
    forward: {
      op: "update",
      model: "deliverable",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: row as unknown as Record<string, unknown>,
    },
  });
  return row;
}

export async function linkRepo(tx: Tx, userId: string, input: { projectId?: string; projectName?: string; fullName: string }, actor: Actor) {
  const fullName = input.fullName.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("A repo is owner/name, for example encode/httpx.");
  let projectId = input.projectId;
  if (!projectId && input.projectName) {
    const project = await tx.project.findFirst({
      where: { userId, deletedAt: null, name: { equals: input.projectName, mode: "insensitive" } },
    });
    if (!project) throw Object.assign(new Error(`No project named “${input.projectName}”.`), { statusCode: 400 });
    projectId = project.id;
  }
  if (!projectId) throw Object.assign(new Error("Say which project to link the repo to."), { statusCode: 400 });
  const project = await tx.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  if (!project) throw Object.assign(new Error("That project was not found."), { statusCode: 404 });
  const repo = await tx.repo.upsert({
    where: { userId_fullName: { userId, fullName } },
    create: { userId, fullName, url: `https://github.com/${fullName}`, tracked: true },
    update: { deletedAt: null },
  });
  await tx.projectRepo.upsert({
    where: { projectId_repoId: { projectId, repoId: repo.id } },
    create: { projectId, repoId: repo.id, addedBy: actor },
    update: {},
  });
  return { project, repo };
}

export async function unlinkRepo(tx: Tx, userId: string, input: { projectId: string; repoId: string }) {
  const project = await tx.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
  if (!project) throw notFound("That project was not found.");
  await tx.projectRepo.deleteMany({ where: { projectId: input.projectId, repoId: input.repoId } });
  return project;
}

export function assertReminderInput(dueDate: string, dueTime?: string | null): void {
  if (!isIsoDate(dueDate)) {
    throw new Error("dueDate must be YYYY-MM-DD. Resolve words like “tomorrow” using today's date from the prompt.");
  }
  if (dueTime && !isHmTime(dueTime)) throw new Error("dueTime must be HH:MM in 24-hour time.");
}

export async function createReminder(
  tx: Tx,
  userId: string,
  input: { title: string; dueDate: string; dueTime?: string | null; timeZone: string },
  actor: Actor,
) {
  assertReminderInput(input.dueDate, input.dueTime);
  const token = randomUUID();
  const reminder = await tx.reminder.create({
    data: {
      userId,
      title: input.title,
      titleContent: titleDoc(input.title),
      dueDate: input.dueDate,
      dueTime: input.dueTime ?? null,
      timeZone: input.timeZone,
      nextNotificationAt: nextNotificationAt(input.dueDate, input.dueTime, input.timeZone),
      actionTokenHash: createHash("sha256").update(token).digest("hex"),
    },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Reminder “${reminder.title}”`,
    kind: "create",
    actor,
    subject: "reminder",
    href: "/today",
    inverse: { op: "delete", model: "reminder", id: reminder.id, data: reminder as unknown as Record<string, unknown> },
    forward: { op: "create", model: "reminder", id: reminder.id, data: reminder as unknown as Record<string, unknown> },
  });
  return reminder;
}

export async function updateReminder(
  tx: Tx,
  userId: string,
  id: string,
  patch: { title?: string; dueDate?: string; dueTime?: string | null; timeZone?: string },
  actor: Actor,
) {
  const existing = await tx.reminder.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw notFound("That reminder was not found.");
  const dueDate = patch.dueDate ?? existing.dueDate;
  const dueTime = patch.dueTime === undefined ? existing.dueTime : patch.dueTime;
  const timeZone = patch.timeZone ?? existing.timeZone;
  assertReminderInput(dueDate, dueTime);
  const reminder = await tx.reminder.update({
    where: { id },
    data: {
      title: patch.title,
      titleContent: patch.title ? titleDoc(patch.title) : undefined,
      dueDate,
      dueTime,
      timeZone,
      nextNotificationAt: nextNotificationAt(dueDate, dueTime, timeZone),
      lastNotifiedAt: null,
    },
  });
  await recordUndoInTransaction(tx, {
    userId,
    label: `Updated reminder “${reminder.title}”`,
    kind: "update",
    actor,
    subject: "reminder",
    inverse: {
      op: "update",
      model: "reminder",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: reminder as unknown as Record<string, unknown>,
    },
    forward: {
      op: "update",
      model: "reminder",
      id,
      before: existing as unknown as Record<string, unknown>,
      after: reminder as unknown as Record<string, unknown>,
    },
  });
  return reminder;
}

const TRASH_MODELS = ["task", "project", "person", "skill", "document", "repo", "deliverable", "reminder"] as const;
export type TrashKind = (typeof TRASH_MODELS)[number] | "comment";

export async function softDelete(tx: Tx, userId: string, kind: TrashKind, id: string, actor: Actor): Promise<{ label: string }> {
  const now = new Date();
  if (kind === "comment") {
    const row = await tx.pageDiscussion.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) throw notFound("That comment was not found.");
    await tx.pageDiscussion.update({ where: { id }, data: { deletedAt: now } });
    return { label: "Comment" };
  }
  const delegate = tx[kind] as unknown as {
    findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
    update: (args: unknown) => Promise<Record<string, unknown>>;
  };
  const existing = await delegate.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw notFound(`That ${kind} was not found.`);
  const updated = await delegate.update({ where: { id }, data: { deletedAt: now } });
  const label = String(existing.title ?? existing.name ?? existing.fullName ?? existing.filename ?? kind);
  await recordUndoInTransaction(tx, {
    userId,
    label: `Moved “${label}” to Trash`,
    kind: "delete",
    actor,
    subject: kind,
    inverse: {
      op: "update",
      model: kind,
      id,
      before: existing,
      after: updated,
    },
    forward: {
      op: "update",
      model: kind,
      id,
      before: existing,
      after: updated,
    },
  });
  return { label };
}

export async function restoreOne(db: Db, userId: string, kind: TrashKind, id: string): Promise<void> {
  if (kind === "comment") {
    const result = await db.pageDiscussion.updateMany({ where: { id, userId, deletedAt: { not: null } }, data: { deletedAt: null } });
    if (result.count === 0) throw notFound("That comment was not found.");
    return;
  }
  const delegate = db[kind] as unknown as { updateMany: (args: unknown) => Promise<{ count: number }> };
  const result = await delegate.updateMany({ where: { id, userId, deletedAt: { not: null } }, data: { deletedAt: null } });
  if (result.count === 0) throw notFound(`That ${kind} was not found.`);
}
