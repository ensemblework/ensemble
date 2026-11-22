/**
 * A saved secret typed by reference (`$NAME`) into a password field on the screen: never shown to the
 * agent. A secret saved without destinations goes into any password field; one limited to websites
 * goes only into their pages (lib/run-secrets.ts).
 */
import type { PrismaClient } from "@prisma/client";
import { savedSecret } from "../../lib/run-secrets.js";

export async function secretFor(prisma: PrismaClient, userId: string, name: string, origin: string | null): Promise<string | null> {
  const saved = await savedSecret(prisma, userId, name).catch(() => null);
  if (!saved) return null;
  if (!saved.allow.length) return saved.value;
  return origin && saved.allow.includes(origin) ? saved.value : null;
}
