import type { Prisma, PrismaClient } from "@prisma/client";
import { zonedParts } from "../lib/clock.js";
import { loadSettings } from "../lib/settings.js";

type Db = PrismaClient | Prisma.TransactionClient;
export const BRIEF_PROMPT_KEY = "ui.morning-brief-prompt";

/** One offer per account, across spaces, tabs and computers. UI preferences survive data erasure. */
export async function briefPromptAvailable(db: Db, accountId: string): Promise<boolean> {
  if (await db.preference.findUnique({ where: { userId_key: { userId: accountId, key: BRIEF_PROMPT_KEY } } })) return false;
  const [account, settings, spaces] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: accountId }, select: { createdAt: true } }),
    loadSettings(db, accountId),
    db.user.findMany({ where: { OR: [{ id: accountId }, { ownerId: accountId }] }, select: { id: true } }),
  ]);
  if (zonedParts(settings.timezone, account.createdAt).date >= zonedParts(settings.timezone).date) return false;
  return Boolean(await db.notification.findFirst({ where: { userId: { in: spaces.map(row => row.id) }, kind: "morning_brief" }, select: { id: true } }));
}

export async function finishBriefPrompt(db: Db, accountId: string, state: "dismissed" | "saved"): Promise<void> {
  await db.preference.upsert({
    where: { userId_key: { userId: accountId, key: BRIEF_PROMPT_KEY } },
    create: { userId: accountId, key: BRIEF_PROMPT_KEY, value: { state }, source: "system" },
    update: { value: { state }, deletedAt: null },
  });
}

/** The unique preference makes concurrent first opens a single offer; record it before showing. */
export async function claimBriefPrompt(db: Db, accountId: string): Promise<boolean> {
  if (!(await briefPromptAvailable(db, accountId))) return false;
  const result = await db.preference.createMany({
    data: [{ userId: accountId, key: BRIEF_PROMPT_KEY, value: { state: "shown" }, source: "system" }],
    skipDuplicates: true,
  });
  return result.count === 1;
}
