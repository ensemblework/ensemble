import type { PrismaClient } from "@prisma/client";
import { truncateText } from "./text.js";

export async function recordModelProbe(
  prisma: PrismaClient,
  userId: string,
  provider: string,
  model: string,
  kind: string,
  detail: string,
): Promise<void> {
  if (!provider || !model) return;
  await prisma.modelProbe.upsert({
    where: { userId_provider_model: { userId, provider, model } },
    create: { userId, provider, model, kind, detail: truncateText(detail, 400), checkedAt: new Date() },
    update: { kind, detail: truncateText(detail, 400), checkedAt: new Date() },
  });
}
