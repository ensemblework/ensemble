/**
 * One undo stack per user (docs/design/assistant-trash-comments.md §20).
 *
 * An entry stores the fields that changed, plus the row's updatedAt after the
 * write. Undo and redo touch only those fields, and only when they still hold
 * the recorded values. A mismatch drops the entry and returns 409 so a bad
 * row can never sit on top of the stack.
 *
 * Undo of a create moves the row to Trash. It never hard-deletes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Prisma, type Actor, type PrismaClient } from "@prisma/client";
import { Settings } from "@ensemble/shared-types";
import { appendLedger } from "./ledger.js";
import { sseHub } from "./sse.js";
import { lockUserTransaction } from "./user-lock.js";
import { actorFor, isVisitor } from "../sharing/context.js";

export type UndoModel =
  | "task"
  | "taskPage"
  | "project"
  | "deliverable"
  | "person"
  | "skill"
  | "meetingNote"
  | "repo"
  | "preference"
  | "contextSuppression"
  | "run"
  | "reminder"
  | "document"
  | "watcher";

export type UndoKind = "create" | "update" | "delete" | "batch";

/** Legacy op shape. New entries store patches; this remains so existing callers compile. */
export type UndoOp =
  | { op: "create"; model: UndoModel; id: string; data: Record<string, unknown> }
  | { op: "update"; model: UndoModel; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { op: "delete"; model: UndoModel; id: string; data: Record<string, unknown> }
  | { op: "batch"; ops: UndoOp[] };

export type UndoPatch = {
  model: UndoModel;
  id: string;
  kind: "create" | "update" | "delete";
  fields: Record<string, { before: unknown; after: unknown }>;
  version: string | null;
  undoVersion?: string | null;
};

const DATE_TAG = "$date";
const SKIP = new Set(["updatedAt", "createdAt", "id", "userId"]);

const JSON_NULLABLE: Record<UndoModel, readonly string[]> = {
  task: ["blockedQuestion"],
  taskPage: ["content"],
  project: [],
  deliverable: [],
  person: [],
  skill: ["proposedChanges"],
  meetingNote: ["extraction"],
  repo: [],
  preference: [],
  contextSuppression: [],
  run: ["checkpoint", "question"],
  reminder: ["titleContent"],
  document: ["parseError", "enrichmentError"],
  watcher: [],
};

const DELEGATE: Record<UndoModel, string> = {
  task: "task",
  taskPage: "taskPage",
  project: "project",
  deliverable: "deliverable",
  person: "person",
  skill: "skill",
  meetingNote: "meetingNote",
  repo: "repo",
  preference: "preference",
  contextSuppression: "contextSuppression",
  run: "run",
  reminder: "reminder",
  document: "document",
  watcher: "watcher",
};

const TRASHABLE = new Set<UndoModel>([
  "task",
  "taskPage",
  "project",
  "deliverable",
  "person",
  "skill",
  "meetingNote",
  "repo",
  "reminder",
  "document",
]);

export class UndoConflict extends Error {
  readonly statusCode = 409;
  constructor(label: string) {
    super(`“${label}” was changed since; undo skipped`);
    this.name = "UndoConflict";
  }
}

type Db = Prisma.TransactionClient | PrismaClient;

type Group = { patches: UndoPatch[]; labels: string[] };

const groups = new AsyncLocalStorage<Group>();
const lastIds = new WeakMap<object, string>();

export function encodeSnapshot(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeSnapshot);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encodeSnapshot(item)]));
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec[DATE_TAG] === "string") return new Date(rec[DATE_TAG] as string);
    return Object.fromEntries(Object.entries(rec).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

export function decodeSnapshot(model: UndoModel, value: unknown): Record<string, unknown> {
  const decoded = decodeValue(value) as Record<string, unknown>;
  for (const field of JSON_NULLABLE[model]) {
    if (decoded[field] === null) decoded[field] = Prisma.DbNull;
  }
  return decoded;
}

export function sameValue(left: unknown, right: unknown): boolean {
  const a = decodeValue(left);
  const b = decodeValue(right);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === "string") return a.toISOString() === new Date(b).toISOString();
  if (b instanceof Date && typeof a === "string") return b.toISOString() === new Date(a).toISOString();
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function versionOf(row: Record<string, unknown> | null | undefined): string | null {
  const value = row?.updatedAt;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  const tagged = value && typeof value === "object" ? (value as Record<string, unknown>)[DATE_TAG] : undefined;
  return typeof tagged === "string" ? new Date(tagged).toISOString() : null;
}

export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { before: unknown; after: unknown }> {
  const fields: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SKIP.has(key)) continue;
    if (!sameValue(before[key], after[key])) fields[key] = { before: encodeSnapshot(before[key]), after: encodeSnapshot(after[key]) };
  }
  return fields;
}

function patchesFromCall(kind: UndoKind, forward: UndoOp): UndoPatch[] {
  if (forward.op === "batch") return forward.ops.flatMap((child) => patchesFromCall(child.op === "update" ? "update" : child.op === "create" ? "create" : "delete", child));
  if (kind === "create" || forward.op === "create") {
    const data = forward.op === "create" ? forward.data : forward.op === "delete" ? forward.data : {};
    const model = forward.model;
    const id = forward.id;
    if (model === "watcher") {
      return [{ model, id, kind: "create", fields: { status: { before: "cancelled", after: "active" } }, version: null }];
    }
    return [{ model, id, kind: "create", fields: { deletedAt: { before: null, after: null } }, version: versionOf(data) }];
  }
  if (forward.op === "update") {
    return [
      {
        model: forward.model,
        id: forward.id,
        kind: kind === "delete" ? "delete" : "update",
        fields: diffFields(forward.before, forward.after),
        version: versionOf(forward.after),
      },
    ];
  }
  const data = forward.data;
  return [{ model: forward.model, id: forward.id, kind: "create", fields: { deletedAt: { before: null, after: null } }, version: versionOf(data) }];
}

function delegate(db: Db, model: UndoModel): {
  findFirst: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
} {
  return db[DELEGATE[model] as keyof Db] as never;
}

async function depthFor(db: Db, userId: string): Promise<number> {
  const row = await db.preference.findFirst({ where: { userId, key: "hub.settings", deletedAt: null }, select: { value: true } });
  const parsed = Settings.safeParse(row?.value ?? {});
  const depth = parsed.success ? parsed.data.undoDepth : 5;
  return Math.min(20, Math.max(3, depth));
}

async function writeEntry(
  db: Prisma.TransactionClient,
  input: { userId: string; label: string; kind: UndoKind; actor?: Actor; subject: string; href?: string; source?: string; patches: UndoPatch[] },
): Promise<string> {
  await lockUserTransaction(db, input.userId);
  // Each person in a space has their own undo history (null: the owner).
  const actorAccountId = actorFor(input.userId);
  // Someone on a public link with no account has no undo history (and no users row to point at).
  if (isVisitor(actorAccountId)) return randomUUID();
  await db.undoEntry.deleteMany({ where: { userId: input.userId, actorAccountId, undoneAt: { not: null } } });
  const last = await db.undoEntry.findFirst({ where: { userId: input.userId }, orderBy: { seq: "desc" }, select: { seq: true } });
  const seq = (last?.seq ?? 0n) + 1n;
  const id = randomUUID();
  const ops = encodeSnapshot(input.patches) as Prisma.InputJsonValue;
  await db.undoEntry.create({
    data: {
      id,
      userId: input.userId,
      actorAccountId,
      seq,
      label: input.label.slice(0, 240),
      kind: input.patches.length > 1 ? "batch" : input.kind,
      actor: input.actor ?? "me",
      subject: input.subject,
      href: input.href,
      inverse: ops,
      forward: ops,
      ops,
      source: input.source ?? (input.actor === "agent" ? "assistant" : "ui"),
      groupId: id,
    },
  });
  const depth = await depthFor(db, input.userId);
  const extras = await db.undoEntry.findMany({
    where: { userId: input.userId, actorAccountId, undoneAt: null },
    orderBy: { seq: "desc" },
    skip: depth,
    select: { id: true },
  });
  if (extras.length) await db.undoEntry.deleteMany({ where: { id: { in: extras.map((row) => row.id) } } });
  lastIds.set(db, id);
  return id;
}

export async function recordUndoInTransaction(
  db: Prisma.TransactionClient,
  input: {
    userId: string;
    label: string;
    kind: UndoKind;
    actor?: Actor;
    subject: string;
    href?: string;
    inverse: UndoOp;
    forward: UndoOp;
  },
): Promise<string> {
  const patches = patchesFromCall(input.kind, input.forward);
  const group = groups.getStore();
  if (group) {
    group.patches.push(...patches);
    group.labels.push(input.label);
    return "grouped";
  }
  return writeEntry(db, { ...input, patches });
}

/** Several writes inside one transaction become one stack entry. */
export async function withUndoGroup<T>(db: Prisma.TransactionClient, meta: { userId: string; actor?: Actor; subject: string; href?: string }, fn: () => Promise<T>): Promise<{ result: T; undoEntryId: string | null }> {
  await lockUserTransaction(db, meta.userId);
  const group: Group = { patches: [], labels: [] };
  const result = await groups.run(group, fn);
  if (!group.patches.length) return { result, undoEntryId: null };
  const label = group.labels.length === 1 ? group.labels[0]! : group.labels.join("; ");
  const undoEntryId = await writeEntry(db, {
    userId: meta.userId,
    label,
    kind: group.patches.length > 1 ? "batch" : group.patches[0]!.kind,
    actor: meta.actor,
    subject: meta.subject,
    href: meta.href,
    patches: group.patches,
  });
  return { result, undoEntryId };
}

export function lastUndoId(db: object): string | undefined {
  return lastIds.get(db);
}

function readPatches(entry: { ops: unknown; forward: unknown }): UndoPatch[] {
  const ops = Array.isArray(entry.ops) ? (entry.ops as UndoPatch[]) : [];
  if (ops.length && ops.every((patch) => patch && typeof patch === "object" && "fields" in patch)) return ops;
  return [];
}

async function loadRow(db: Db, patch: UndoPatch): Promise<Record<string, unknown> | null> {
  return delegate(db, patch.model).findFirst({ where: { id: patch.id } });
}

function mismatch(patch: UndoPatch, row: Record<string, unknown> | null, direction: "undo" | "redo"): string | null {
  if (!row) return "missing";
  if (patch.kind === "create" && patch.model === "watcher") {
    const status = String(row.status ?? "");
    if (direction === "undo" && status !== "active") return "status";
    if (direction === "redo" && status !== "cancelled") return "status";
    return null;
  }
  if (patch.kind === "create") {
    const trashed = row.deletedAt != null;
    if (direction === "undo") {
      if (trashed) return "deletedAt";
      if (patch.version && !sameValue(row.updatedAt, patch.version)) return "version";
    } else if (!trashed || (patch.undoVersion && !sameValue(row.updatedAt, patch.undoVersion))) return "deletedAt";
    return null;
  }
  const side = direction === "undo" ? "after" : "before";
  for (const [key, pair] of Object.entries(patch.fields)) {
    if (!sameValue(row[key], pair[side])) return key;
  }
  if (direction === "undo" && patch.version && !sameValue(row.updatedAt, patch.version)) return "version";
  if (direction === "redo" && patch.undoVersion && !sameValue(row.updatedAt, patch.undoVersion)) return "version";
  return null;
}

async function applyPatch(db: Db, userId: string, patch: UndoPatch, direction: "undo" | "redo"): Promise<void> {
  const now = new Date();
  const rowDelegate = delegate(db, patch.model);
  if (patch.kind === "create") {
    if (patch.model === "watcher") {
      await rowDelegate.update({
        where: { id: patch.id },
        data: direction === "undo" ? { status: "cancelled", cancelledAt: now } : { status: "active", cancelledAt: null },
      });
      return;
    }
    if (!TRASHABLE.has(patch.model)) throw new UndoConflict(patch.id);
    await rowDelegate.update({ where: { id: patch.id }, data: { deletedAt: direction === "undo" ? now : null } });
    return;
  }
  const data: Record<string, unknown> = {};
  for (const [key, pair] of Object.entries(patch.fields)) {
    data[key] = direction === "undo" ? pair.before : pair.after;
  }
  data.updatedAt = now;
  await rowDelegate.update({ where: { id: patch.id }, data: decodeSnapshot(patch.model, data) });
  const status = patch.fields.status;
  const owner = patch.fields.owner;
  if (patch.model === "task" && status) {
    const fromStatus = String(direction === "undo" ? status.after : status.before);
    const toStatus = String(direction === "undo" ? status.before : status.after);
    if (fromStatus && toStatus && fromStatus !== toStatus && fromStatus !== "undefined" && toStatus !== "undefined") {
      await db.taskTransition.create({
        data: {
          userId,
          taskId: patch.id,
          fromStatus: fromStatus as never,
          toStatus: toStatus as never,
          ...(owner
            ? {
                fromOwner: (direction === "undo" ? owner.after : owner.before) as never,
                toOwner: (direction === "undo" ? owner.before : owner.after) as never,
              }
            : {}),
          actor: "me",
          reason: direction,
        },
      });
    }
  }
}

async function flipStoredCalls(db: PrismaClient, userId: string, entryId: string, direction: "undo" | "redo"): Promise<void> {
  const nextState = direction === "undo" ? "undone" : "ok";
  const rewrite = (calls: Array<Record<string, unknown>>) => {
    let changed = false;
    const next = calls.map((call) => {
      if (call.undoEntryId !== entryId) return call;
      changed = true;
      return { ...call, state: nextState };
    });
    return changed ? next : null;
  };
  try {
    const messages = await db.assistantMessage.findMany({ where: { userId, role: "assistant" }, orderBy: { createdAt: "desc" }, take: 24 });
    for (const message of messages) {
      const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as Array<Record<string, unknown>>) : [];
      const next = rewrite(calls);
      if (next) await db.assistantMessage.update({ where: { id: message.id }, data: { toolCalls: next as Prisma.InputJsonValue } });
    }
    const replies = await db.ensembleReply.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 24 });
    for (const reply of replies) {
      const calls = Array.isArray(reply.toolCalls) ? (reply.toolCalls as Array<Record<string, unknown>>) : [];
      const next = rewrite(calls);
      if (next) await db.ensembleReply.update({ where: { id: reply.id }, data: { toolCalls: next as Prisma.InputJsonValue } });
    }
  } catch {
    // The row change already committed. A stale card label must not fail the undo.
  }
}

async function runEntry(db: PrismaClient, userId: string, entryId: string | undefined, direction: "undo" | "redo"): Promise<{ label: string; entryId: string }> {
  const actorAccountId = actorFor(userId);
  const entry = entryId
    ? await db.undoEntry.findFirst({ where: { id: entryId, userId, actorAccountId } })
    : direction === "undo"
      ? await db.undoEntry.findFirst({ where: { userId, actorAccountId, undoneAt: null }, orderBy: { seq: "desc" } })
      : await db.undoEntry.findFirst({ where: { userId, actorAccountId, undoneAt: { not: null } }, orderBy: { undoneAt: "desc" } });
  if (!entry) throw Object.assign(new Error(direction === "undo" ? "Nothing to undo." : "Nothing to redo."), { statusCode: 204 });
  if (direction === "undo" && entry.undoneAt) throw new UndoConflict(entry.label);
  if (direction === "redo" && !entry.undoneAt) throw new UndoConflict(entry.label);
  const patches = readPatches(entry);
  if (!patches.length) {
    await db.undoEntry.delete({ where: { id: entry.id } });
    throw new UndoConflict(entry.label);
  }
  const ordered = direction === "undo" ? [...patches].reverse() : patches;
  try {
    await db.$transaction(async (tx) => {
      for (const patch of ordered) {
        const row = await loadRow(tx, patch);
        const why = mismatch(patch, row, direction);
        if (why) throw new UndoConflict(entry.label);
      }
      for (const patch of ordered) await applyPatch(tx, userId, patch, direction);
      const stamped = patches.map((patch) => ({ ...patch }));
      for (const patch of stamped) {
        const fresh = await loadRow(tx, patch);
        const stamp = versionOf(fresh);
        if (direction === "undo") patch.undoVersion = stamp;
        else if (stamp) patch.version = stamp;
      }
      await tx.undoEntry.update({
        where: { id: entry.id },
        data: {
          undoneAt: direction === "undo" ? new Date() : null,
          ops: encodeSnapshot(stamped) as Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    await db.undoEntry.delete({ where: { id: entry.id } }).catch(() => undefined);
    if (error instanceof UndoConflict) throw error;
    throw new UndoConflict(entry.label);
  }
  await flipStoredCalls(db, userId, entry.id, direction);
  await appendLedger({ userId, actor: entry.actor, action: direction, payload: { id: entry.id, label: entry.label } });
  const [undoable, redoable] = await Promise.all([
    db.undoEntry.count({ where: { userId, actorAccountId, undoneAt: null } }),
    db.undoEntry.count({ where: { userId, actorAccountId, undoneAt: { not: null } } }),
  ]);
  sseHub.publish(userId, {
    event: "undo.changed",
    data: { entryId: entry.id, direction, label: entry.label, canUndo: undoable > 0, canRedo: redoable > 0 },
  });
  return { label: entry.label, entryId: entry.id };
}

export async function undoLast(db: PrismaClient, userId: string, entryId?: string): Promise<{ label: string; entryId: string }> {
  return runEntry(db, userId, entryId, "undo");
}

export async function redoLast(db: PrismaClient, userId: string, entryId?: string): Promise<{ label: string; entryId: string }> {
  return runEntry(db, userId, entryId, "redo");
}
