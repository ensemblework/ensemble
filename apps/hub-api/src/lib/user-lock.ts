import type { Prisma } from "@prisma/client";

export async function lockUserTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Foreign-key inserts hold KEY SHARE; an UPDATE lock upgrade would deadlock.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw new Error("The account no longer exists.");
}
