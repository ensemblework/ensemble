/**
 * Record links in a node's reply that lead nowhere (docs/35 §6.1): `ensemble://<kind>/<id>` for a file,
 * task, page, plot, project, dataset or diagram that is not its owner's, or is in the Trash. The node's
 * answer check (node/deliverables.ts) sends such a reply back, so a link is only ever to what a tool
 * returned.
 */
import type { PrismaClient } from "@prisma/client";
import { isUuid, refKind } from "@ensemble/shared-types";

export type RefProblem = { href: string; kind: string; id: string; problem: string };

const LINK = /ensemble:\/\/([a-z]+)\/([^\s)\]>"'”]+)/gi;
const CHECKED = new Set(["file", "task", "page", "plot", "project", "dataset", "diagram"]);
const NOUN: Record<string, string> = { file: "file", task: "task", page: "page", plot: "plot", project: "project", dataset: "dataset", diagram: "diagram" };

type Db = Pick<PrismaClient, "document" | "task" | "taskPage" | "plot" | "project" | "plotDataset" | "blockDiagram">;

/** The ids of one kind the owner has (and has not deleted). */
async function existing(prisma: Db, kind: string, ids: string[], ownerId: string): Promise<Set<string>> {
  const where = { id: { in: ids }, userId: ownerId, deletedAt: null };
  const select = { id: true } as const;
  const rows: Array<{ id: string }> =
    kind === "file" ? await prisma.document.findMany({ where, select })
    : kind === "task" ? await prisma.task.findMany({ where, select })
    : kind === "page" ? await prisma.taskPage.findMany({ where: { OR: [{ id: { in: ids } }, { taskId: { in: ids } }], userId: ownerId, deletedAt: null }, select: { id: true, taskId: true } }).then((found) => found.flatMap((row) => [{ id: row.id }, ...(row.taskId ? [{ id: row.taskId }] : [])]))
    : kind === "plot" ? await prisma.plot.findMany({ where, select })
    : kind === "project" ? await prisma.project.findMany({ where, select })
    : kind === "dataset" ? await prisma.plotDataset.findMany({ where, select })
    : await prisma.blockDiagram.findMany({ where, select });
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

/** The `ensemble://` links in `text` that do not lead to one of the owner's records, with why. */
export async function validateRefs(text: string, ownerId: string, prisma: Db): Promise<RefProblem[]> {
  const found = new Map<string, { href: string; kind: string; id: string }>();
  for (const match of text.matchAll(LINK)) {
    const kind = refKind(match[1]!);
    let id = match[2]!.replace(/[.,;:!?]+$/, "");
    try {
      id = decodeURIComponent(id);
    } catch {
      continue;
    }
    if (!kind || !CHECKED.has(kind)) continue;
    const href = `ensemble://${match[1]}/${match[2]!.replace(/[.,;:!?]+$/, "")}`;
    found.set(`${kind}:${id.toLowerCase()}`, { href, kind, id });
  }
  if (!found.size) return [];
  const problems: RefProblem[] = [];
  const byKind = new Map<string, Array<{ href: string; kind: string; id: string }>>();
  for (const link of found.values()) byKind.set(link.kind, [...(byKind.get(link.kind) ?? []), link]);
  for (const [kind, links] of byKind) {
    const valid = links.filter((link) => isUuid(link.id));
    const have = valid.length ? await existing(prisma, kind, valid.map((link) => link.id), ownerId) : new Set<string>();
    for (const link of links) {
      if (!isUuid(link.id)) problems.push({ ...link, problem: `not a ${NOUN[kind]} id` });
      else if (!have.has(link.id.toLowerCase())) problems.push({ ...link, problem: `no such ${NOUN[kind]} in your owner's Ensemble` });
    }
  }
  return problems;
}
