import type { PrismaClient } from "@prisma/client";
import { GuardError } from "../workspace/guard.js";
import { trustFolder } from "./constants.js";
import { folderLabels } from "./labels.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";

const GITHUB = /^(https:\/\/|git@)[\w.@:/~-]+$/;
const SLUG = /^[\w.-]+\/[\w.-]+$/;

export async function deviceAssignment(
  prisma: PrismaClient,
  userId: string,
  input: {
    deviceId: string;
    kind: "research" | "code";
    folder?: string;
    folderLabel?: string;
    repoUrl?: string;
    continueFromJobId?: string;
  },
): Promise<{
  deviceId: string;
  name: string;
  folderLabel: string | null;
  repoUrl: string | null;
  continueFrom: string | null;
  resourceKeys: string[];
}> {
  await requireVerifiedUser(userId);
  const device = await prisma.device.findFirst({ where: { id: input.deviceId, userId, revokedAt: null } });
  if (!device) throw new GuardError("That computer is not paired.");

  const requested = (input.folderLabel ?? input.folder ?? "").trim();
  let folderLabel: string | null = null;
  if (requested) {
    const labels = folderLabels(device.capabilities);
    if (!labels.includes(requested)) throw new GuardError(trustFolder(device.name));
    folderLabel = requested;
  }

  let repoUrl: string | null = null;
  const rawRepo = input.repoUrl?.trim() ?? "";
  if (rawRepo) {
    if (rawRepo.startsWith("/") || rawRepo.startsWith("~")) throw new GuardError(trustFolder(device.name));
    if (SLUG.test(rawRepo)) repoUrl = `https://github.com/${rawRepo}.git`;
    else if (GITHUB.test(rawRepo)) repoUrl = rawRepo;
    else throw new GuardError("Give a repository URL (https://github.com/owner/repo) or owner/repo.");
  }

  let continueFrom: string | null = null;
  const resourceKeys: string[] = [];
  if (input.kind === "code" && input.continueFromJobId) {
    const previous = await prisma.workspaceJob.findFirst({
      where: { id: input.continueFromJobId, userId },
      select: { id: true, kind: true, continueFromJobId: true, folderLabel: true },
    });
    if (!previous || previous.kind !== "code") throw new GuardError("Pick an earlier code task to continue from.");
    continueFrom = previous.id;
    let rootId = previous.id;
    let parent = previous.continueFromJobId;
    for (let hops = 0; parent && hops < 50; hops += 1) {
      rootId = parent;
      parent = (await prisma.workspaceJob.findUnique({ where: { id: parent }, select: { continueFromJobId: true } }))?.continueFromJobId ?? null;
    }
    resourceKeys.push(previous.folderLabel ? `label:${previous.folderLabel}` : `chain:${rootId}`);
  } else if (folderLabel) {
    resourceKeys.push(`label:${folderLabel}`);
  } else if (repoUrl) {
    resourceKeys.push(`repo:${repoUrl}`);
  } else if (input.kind === "code") {
    throw new GuardError(`Pick a folder ${device.name} has shared, or a repository.`);
  }

  return { deviceId: device.id, name: device.name, folderLabel, repoUrl, continueFrom, resourceKeys };
}
