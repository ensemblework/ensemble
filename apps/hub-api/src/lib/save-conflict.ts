import { compareSave, mergeSaveObject, saveObject, type SaveObject } from "@ensemble/shared-types/save-merge";
import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";

export class SaveConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "SAVE_CONFLICT";
  constructor(readonly current: SaveObject, readonly patch: SaveObject, readonly conflicts: ReturnType<typeof compareSave>["conflicts"]) {
    super("This changed in another place. Choose which version to save.");
  }
  toJSON() { return { error: this.message, code: this.code, current: this.current, patch: this.patch, conflicts: this.conflicts }; }
}

export function saveBase(request: FastifyRequest): SaveObject | undefined {
  const body = request.body;
  if (!saveObject(body) || !Object.hasOwn(body, "_base")) return undefined;
  if (!saveObject(body._base)) throw Object.assign(new Error("Supply the version you edited."), { statusCode: 400 });
  return body._base;
}

export function guardedSave<T extends SaveObject>(current: SaveObject, patch: T, base?: SaveObject): T {
  if (!base) return patch;
  const result = compareSave(base, current, patch);
  if (result.conflicts.length) throw new SaveConflictError(current, result.patch, result.conflicts);
  const complete = Object.fromEntries(Object.entries(result.patch).map(([key, value]) => [
    key, saveObject(value) && saveObject(current[key]) ? mergeSaveObject(current[key], value) : value,
  ]));
  return complete as T;
}

export async function lockSave(tx: Prisma.TransactionClient, table: "people" | "projects" | "repos" | "meeting_sessions" | "tasks" | "deliverables" | "plots" | "assistant_routines" | "page_discussions", userId: string, id: string) {
  // Table names are a closed server-side union; ids remain bound parameters.
  await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE user_id = $1 AND id = $2 FOR NO KEY UPDATE`, userId, id);
}
