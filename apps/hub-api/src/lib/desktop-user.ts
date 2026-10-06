import { randomBytes } from "node:crypto";
import { env } from "../config.js";
import { hashPassword } from "./auth.js";
import { prisma } from "./prisma.js";

const LOCAL_EMAIL = "local@ensemble.desktop";

/** One local account so the bundled UI opens signed in. The password is random and not stored. */
export async function ensureDesktopUser(id = env.ENSEMBLE_DEV_USER_ID): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id }, include: { authIdentities: { select: { id: true } } } });
  if (existing && (existing.passwordHash || existing.authIdentities.length)) {
    if (!existing.onboardingCompletedAt || !existing.profileCompletedAt) {
      const now = new Date();
      await prisma.user.update({
        where: { id },
        data: {
          onboardingCompletedAt: existing.onboardingCompletedAt ?? now,
          profileCompletedAt: existing.profileCompletedAt ?? now,
        },
      });
    }
    return id;
  }
  const now = new Date();
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      email: LOCAL_EMAIL,
      name: "Local",
      passwordHash,
      onboardingCompletedAt: now,
      profileCompletedAt: now,
      onboardingRole: "engineer",
    },
    update: {
      passwordHash,
      onboardingCompletedAt: existing?.onboardingCompletedAt ?? now,
      profileCompletedAt: existing?.profileCompletedAt ?? now,
    },
  });
  return id;
}
