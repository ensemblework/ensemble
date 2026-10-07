/**
 * "Delete what was read" for one connector: removes the artifacts its sync
 * sources stored and their sync state. Meeting-notes sources also remove the
 * meeting notes they wrote. Todos already created from them stay; they belong
 * to the person now.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { MEETING_VENDORS } from "./meetings/types.js";

const GITHUB = { url: { startsWith: "https://github.com/" } };

/** Artifacts each sync source writes. Gmail and Slack rows predate metadata.source, so they match on their links too. */
const SOURCE_ARTIFACTS: Record<string, Prisma.ArtifactWhereInput> = {
  gmail: { kind: "email", OR: [{ metadata: { path: ["source"], equals: "gmail" } }, { url: { startsWith: "https://mail.google.com/" } }] },
  google_calendar: { kind: "event", metadata: { path: ["source"], equals: "google" } },
  outlook: { kind: "email", externalId: { startsWith: "outlook:" } },
  outlook_calendar: { kind: "event", externalId: { startsWith: "outlook:" } },
  teams: { kind: "chat_msg", externalId: { startsWith: "teams:" } },
  slack: { kind: { in: ["chat_msg", "channel_msg"] }, url: { contains: ".slack.com/archives/" } },
  github: { kind: { in: ["pr", "issue", "pr_comment", "commit"] }, ...GITHUB },
  linear: { kind: "issue", externalId: { startsWith: "linear:" } },
  ...Object.fromEntries(MEETING_VENDORS.map((vendor) => [vendor, { kind: "transcript", externalId: { startsWith: `${vendor}:` } } satisfies Prisma.ArtifactWhereInput])),
};

const MEETING_SOURCES = new Set<string>(MEETING_VENDORS);

export function hasSourceData(source: string): boolean {
  return source in SOURCE_ARTIFACTS;
}

export async function deleteSourceData(prisma: PrismaClient, userId: string, sources: readonly string[]): Promise<number> {
  const filters = sources.map((source) => SOURCE_ARTIFACTS[source]).filter((filter): filter is Prisma.ArtifactWhereInput => Boolean(filter));
  if (!filters.length) return 0;
  const meetings = sources.filter((source) => MEETING_SOURCES.has(source));
  return prisma.$transaction(async (tx) => {
    if (meetings.length) await tx.meetingNote.deleteMany({ where: { userId, externalSource: { in: meetings } } });
    const removed = await tx.artifact.deleteMany({ where: { userId, OR: filters } });
    await tx.syncState.deleteMany({ where: { userId, connector: { in: [...sources] } } });
    return removed.count;
  });
}
