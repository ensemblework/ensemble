import type { PrismaClient } from "@prisma/client";

/** Live read. Config caches env at import, and tests set this after that. */
export function envDevTools(): boolean {
  // Production never opens the desk switcher or developer routes from this flag.
  if (process.env.NODE_ENV === "production") return false;
  const value = process.env.ENSEMBLE_DEV_TOOLS;
  return value === "1" || value === "true";
}

/** Testers, and any account while the dev-tools flag is on, may switch desks. */
export async function canSwitchDesks(prisma: PrismaClient, userId: string): Promise<boolean> {
  if (envDevTools()) return true;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tester: true } });
  return user?.tester === true;
}

/** A season that has ended may still return to Default. That is not a persona switch. */
export async function seasonEnded(prisma: PrismaClient, userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { templateExpiresAt: true, activeTemplateId: true },
  });
  return Boolean(
    user?.templateExpiresAt &&
      user.templateExpiresAt.getTime() < Date.now() &&
      user.activeTemplateId &&
      user.activeTemplateId !== "default",
  );
}
