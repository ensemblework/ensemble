import type { PrismaClient } from "@prisma/client";
import { OPTIONAL_MODULES, parseModules, serializeModules, type OptionalModule } from "@ensemble/shared-types";

const KNOWN = new Set<string>(OPTIONAL_MODULES);

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message);
  (error as { statusCode?: number }).statusCode = statusCode;
  return error;
}

/**
 * Turn one optional module on or off for this account only.
 * Rewrites the user's module set and every session row for that user, so the
 * cookie gate matches without a new login. Does not delete feature data.
 */
export async function setOwnModule(prisma: PrismaClient, userId: string, id: string, on: boolean): Promise<string> {
  if (!KNOWN.has(id)) throw httpError(400, "That isn't a feature you can switch.");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, moduleSet: true } });
  if (!user) throw httpError(404, "No such account.");
  const next = parseModules(user.moduleSet);
  if (on) next.add(id as OptionalModule);
  else next.delete(id as OptionalModule);
  const modules = serializeModules(next);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { moduleSet: modules } }),
    prisma.session.updateMany({ where: { userId }, data: { modules } }),
  ]);
  return modules;
}
