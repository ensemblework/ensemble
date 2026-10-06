import { randomBytes } from "node:crypto";
import { env } from "../config.js";
import { hashPassword } from "./auth.js";
import { prisma } from "./prisma.js";

const LOCAL_EMAIL = "local@ensemble.desktop";

/** One local account so the bundled UI opens signed in. The password is random and not stored. */
export async function ensureDesktopUser(id = env.ENSEMBLE_DEV_USER_ID): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id }, include: { authIdentities: { select: { id: true } } } });
  if (existing && (existing.passwordHash || existing.authIdentities.length)) {
    if (!existing.onboardingCompletedAt) {
      await prisma.user.update({ where: { id }, data: { onboardingCompletedAt: new Date() } });
    }
    return id;
  }
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      email: LOCAL_EMAIL,
      name: "Local",
      passwordHash,
      onboardingCompletedAt: new Date(),
      onboardingRole: "engineer",
    },
    update: {
      passwordHash,
      onboardingCompletedAt: existing?.onboardingCompletedAt ?? new Date(),
    },
  });
  return id;
}
