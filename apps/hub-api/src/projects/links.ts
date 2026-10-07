/**
 * Project links (docs/03 §4.8): a source container such as a Slack channel, a
 * GitHub repo or a Linear project is mapped to a project once, and every
 * artifact and proposed todo that later arrives from it lands in that project.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Sources a link can name. Imports bring their own (asana, todoist, clickup, monday) too. */
export const LINK_SOURCES = [
  "slack",
  "github",
  "linear",
  "jira",
  "notion",
  "trello",
  "asana",
  "todoist",
  "clickup",
  "monday",
  "google_drive",
  "calendar",
  "teams",
] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export interface Container {
  source: string;
  id: string;
  name?: string | null;
}

/** GitHub repos are compared as lowercase owner/name; an import's "repo:" prefix is dropped. Other ids are kept as sent. */
export function containerKey(source: string, id: string): string {
  const trimmed = id.trim();
  if (source === "github") return trimmed.replace(/^repo:/i, "").toLowerCase();
  return trimmed;
}

type LinkRow = { source: string; containerId: string; projectId: string };
const cache = new Map<string, { at: number; rows: LinkRow[] }>();
const TTL_MS = 30_000;

export function forgetLinkCache(userId: string): void {
  cache.delete(userId);
}

async function linksFor(userId: string, db: Db): Promise<LinkRow[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = await db.projectLink.findMany({
    where: { userId, project: { deletedAt: null } },
    select: { source: true, containerId: true, projectId: true },
  });
  cache.set(userId, { at: Date.now(), rows });
  if (cache.size > 256) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return rows;
}

/** The project the first linked container belongs to, in the order given (most specific first). */
export async function projectForContainers(userId: string, containers: readonly Container[] | undefined, db: Db = prisma): Promise<string | null> {
  if (!containers?.length) return null;
  const rows = await linksFor(userId, db);
  if (!rows.length) return null;
  for (const container of containers) {
    const key = containerKey(container.source, container.id);
    const hit = rows.find((row) => row.source === container.source && row.containerId === key);
    if (hit) return hit.projectId;
  }
  return null;
}

/** Imports remember the container a project came from, so syncs from the same container land there. A link the person set to a live project is kept. */
export async function rememberImportLink(db: Db, userId: string, projectId: string, source: string, ref: string, name: string): Promise<void> {
  if (source === "csv") return;
  const containerId = containerKey(source, ref);
  if (!containerId) return;
  const existing = await db.projectLink.findUnique({
    where: { userId_source_containerId: { userId, source, containerId } },
    select: { id: true, projectId: true, project: { select: { deletedAt: true } } },
  });
  if (existing && (existing.projectId === projectId || !existing.project.deletedAt)) return;
  if (existing) await db.projectLink.update({ where: { id: existing.id }, data: { projectId, containerName: name.slice(0, 200), createdBy: "import" } });
  else await db.projectLink.create({ data: { userId, projectId, source, containerId, containerName: name.slice(0, 200), createdBy: "import" } });
  forgetLinkCache(userId);
}

/** The live project an existing link maps this container to, if any. */
export async function linkedProject(db: Db, userId: string, source: string, ref: string): Promise<string | null> {
  if (source === "csv") return null;
  const row = await db.projectLink.findUnique({
    where: { userId_source_containerId: { userId, source, containerId: containerKey(source, ref) } },
    select: { project: { select: { id: true, deletedAt: true } } },
  });
  return row && !row.project.deletedAt ? row.project.id : null;
}
