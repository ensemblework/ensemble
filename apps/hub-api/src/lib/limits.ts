/**
 * An account's own limits (Settings › Sharing › Limits; `SharingSettings` in shared-types): how many
 * contacts, people per space it owns, people in an Ensemble Node room it makes, and spaces it owns. Its
 * choice, up to `SHARING_CAPS`; the defaults where it chose nothing. Read from the account's own settings
 * row, whoever is asking.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { SharingSettings } from "@ensemble/shared-types";

type Db = PrismaClient | Prisma.TransactionClient;
export type AccountLimits = { contacts: number; members: number; roomPeople: number; spaces: number };

export async function accountLimits(db: Db, accountId: string): Promise<AccountLimits> {
  const row = await db.preference.findFirst({ where: { userId: accountId, key: "hub.settings", deletedAt: null }, select: { value: true } });
  const parsed = SharingSettings.safeParse((row?.value as { sharing?: unknown } | null)?.sharing ?? {});
  return parsed.success ? parsed.data : SharingSettings.parse({});
}
