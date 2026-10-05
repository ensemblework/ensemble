import type { PrismaClient } from "@prisma/client";

/**
 * A marketplace apply replaces the signup starters with that desk's sample rows.
 * Signup itself stores a marketplace id and keeps those starters.
 */
export async function hidesSignupStarters(prisma: PrismaClient, userId: string): Promise<boolean> {
  const [user, applied] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { activeTemplateId: true } }),
    prisma.templateApplication.findFirst({ where: { userId }, select: { id: true } }),
  ]);
  return Boolean(user?.activeTemplateId?.startsWith("mkt.") && applied);
}
