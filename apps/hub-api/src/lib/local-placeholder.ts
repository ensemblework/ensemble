import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export async function ensureLocalPlaceholder(prisma: PrismaClient, userId: string): Promise<void> {
  const suffix = createHash("sha256").update(userId).digest("hex");
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, email: `local-${suffix}@ensemble.local`, name: "Local (no account)" },
    update: {},
  });
}
