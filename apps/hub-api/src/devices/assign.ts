import type { PrismaClient } from "@prisma/client";
import { pullRequestBaseRefusal } from "@ensemble/shared-types";
import { GuardError } from "../workspace/guard.js";
import { trustFolder } from "./constants.js";
import { deviceEngines, devicePullRequestBases, folderLabels } from "./labels.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";

const GITHUB = /^(https:\/\/|git@)[\w.@:/~-]+$/;
const SLUG = /^[\w.-]+\/[\w.-]+$/;

/**
 * `userId` owns the computer. `space` is where the job lives: the same, or a space shared with
 * them (then `runner` is their account and only their own earlier runs can be continued).
 */
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
    /** A coding agent (CODE_ENGINES) or "ensemble". */
    engine?: string;
    /** The run ends in a pull request into this base: the computer must offer pull requests into it. */
    pullRequestBase?: string;
  },
  where: { space: string; runner: string | null } = { space: userId, runner: null },
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
  if (!device) throw new GuardError(where.runner ? "Pick one of your own paired computers." : "That computer is not paired.");
  if (input.engine && input.engine !== "ensemble" && !deviceEngines(device.capabilities).includes(input.engine)) {
    throw new GuardError(`Ensemble on ${device.name} is too old to run ${input.engine === "copilot-cli" ? "GitHub Copilot" : input.engine} there. Update it on that computer (\`ensemble update\`, or the desktop app's update), then assign again.`);
  }
  if (input.pullRequestBase) {
    const offered = devicePullRequestBases(device.capabilities);
    if (!offered) throw new GuardError(`Ensemble on ${device.name} is too old to open pull requests. Update it on that computer (\`ensemble update\`, or the desktop app's update), then assign again.`);
    const refusal = pullRequestBaseRefusal(input.pullRequestBase, offered, device.name);
    if (refusal) throw new GuardError(refusal);
  }

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
      where: { id: input.continueFromJobId, userId: where.space, runnerAccountId: where.runner },
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
  }
  // A code task with neither works in a new empty folder in that computer's Ensemble workspace, as it does here.

  return { deviceId: device.id, name: device.name, folderLabel, repoUrl, continueFrom, resourceKeys };
}
