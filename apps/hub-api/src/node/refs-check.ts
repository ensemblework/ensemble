/**
 * Links a node's reply gives to Ensemble records (docs/35 §6): every `ensemble://<kind>/<id>` must name
 * a record its owner can open in a space they can open (node/spaces.ts), or the reply links to "This
 * file is not here anymore". The kinds are the ones a reply renders (shared-types `refKind`, and a
 * Node room). `validateRefs` lists the links that do not, with why, for the node's checks before it
 * replies (B1's verifier); an evidence id written as a file says how to make it a file.
 */
import type { PrismaClient } from "@prisma/client";
import { isUuid, refKind } from "@ensemble/shared-types";
import { nodeSpaces } from "./spaces.js";

export type RefProblem = { href: string; kind: string; id: string; problem: string };

const LINK = /ensemble:\/\/([A-Za-z]+)\/([^\s)\]>"'`<]+)/g;

/** The ref kind a link's word names (`file`, `files`, `person`, `room`…), or null for a kind no reply renders. */
function kindOf(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower === "room" || lower === "rooms") return "room";
  return refKind(lower);
}

type Found = (ids: string[], spaces: string[]) => Promise<Set<string>>;

const ids = (rows: Array<{ id: string }>) => new Set(rows.map((row) => row.id));

/** Per kind: which of these ids name a record (not in Trash) in one of the owner's spaces. */
function finders(prisma: PrismaClient, ownerId: string): Record<string, Found> {
  const kept = { deletedAt: null };
  return {
    file: async (list, spaces) => ids(await prisma.document.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    task: async (list, spaces) => ids(await prisma.task.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    page: async (list, spaces) => ids(await prisma.taskPage.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    project: async (list, spaces) => ids(await prisma.project.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    plot: async (list, spaces) => ids(await prisma.plot.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    dataset: async (list, spaces) => ids(await prisma.plotDataset.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    diagram: async (list, spaces) => ids(await prisma.blockDiagram.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    deliverable: async (list, spaces) => ids(await prisma.deliverable.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    skill: async (list, spaces) => ids(await prisma.skill.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    people: async (list, spaces) => ids(await prisma.person.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    repo: async (list, spaces) => ids(await prisma.repo.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    meeting: async (list, spaces) => ids(await prisma.meetingSession.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    reminder: async (list, spaces) => ids(await prisma.reminder.findMany({ where: { id: { in: list }, userId: { in: spaces }, ...kept }, select: { id: true } })),
    room: async (list) => new Set((await prisma.nodeRoomMember.findMany({ where: { roomId: { in: list }, userId: ownerId, nodeId: null, room: { archivedAt: null } }, select: { roomId: true } })).map((row) => row.roomId)),
  };
}

const NAMES: Record<string, string> = {
  file: "file in Ensemble Files",
  task: "task",
  page: "page",
  project: "project",
  plot: "plot",
  dataset: "dataset",
  diagram: "diagram",
  deliverable: "deliverable",
  skill: "skill",
  people: "person",
  repo: "repository",
  meeting: "meeting",
  reminder: "reminder",
  room: "Ensemble Node conversation",
};

/** The id a link's record is looked up by: a plot tile's link names its plot first (`<plot>/<tile>`). */
const lookupId = (kind: string, id: string) => (kind === "plot" ? id.split("/")[0]! : id);

/**
 * The `ensemble://` links in `text` that do not name a record `ownerId` can open, each with why
 * (`problem`), in the order written. Empty when every link is good.
 */
export async function validateRefs(text: string, ownerId: string, prisma: PrismaClient): Promise<RefProblem[]> {
  const links: Array<{ href: string; kind: string | null; word: string; id: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LINK)) {
    const href = match[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(href)) continue;
    seen.add(href);
    let id = href.slice(`ensemble://${match[1]}/`.length);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A broken escape stays as written: it names nothing.
    }
    links.push({ href, kind: kindOf(match[1]!), word: match[1]!.toLowerCase(), id });
  }
  if (!links.length) return [];
  const problems = new Map<string, RefProblem>();
  const wanted = new Map<string, Set<string>>();
  for (const link of links) {
    if (!link.kind) {
      problems.set(link.href, { href: link.href, kind: link.word, id: link.id, problem: `ensemble://${link.word}/… is not a kind of link Ensemble opens. Link only what a tool returned.` });
      continue;
    }
    const key = lookupId(link.kind, link.id);
    if (!isUuid(key)) {
      problems.set(link.href, { href: link.href, kind: link.kind, id: link.id, problem: `“${link.id}” is not an id of a ${NAMES[link.kind] ?? link.kind}. Link only what a tool returned.` });
      continue;
    }
    wanted.set(link.kind, (wanted.get(link.kind) ?? new Set()).add(key));
  }
  if (wanted.size) {
    const spaces = (await nodeSpaces(prisma, ownerId).catch(() => [])).map((space) => space.id);
    const reach = spaces.length ? spaces : [ownerId];
    const find = finders(prisma, ownerId);
    const found = new Map<string, Set<string>>();
    for (const [kind, set] of wanted) found.set(kind, await find[kind]!([...set], reach));
    // An evidence id written as a file: it is a file only once it is saved in Files.
    const fileIds = [...(wanted.get("file") ?? [])].filter((id) => !found.get("file")?.has(id));
    const evidence = fileIds.length ? new Set((await prisma.jobEvidence.findMany({ where: { id: { in: fileIds }, userId: ownerId }, select: { id: true } })).map((row) => row.id)) : new Set<string>();
    for (const link of links) {
      if (!link.kind || problems.has(link.href)) continue;
      const key = lookupId(link.kind, link.id);
      if (found.get(link.kind)?.has(key)) continue;
      const problem =
        link.kind === "file" && evidence.has(key)
          ? "That is evidence (a capture or download), not a file in Ensemble Files. Save it with hub_save_file {evidence} and link the ensemble://file link it returns."
          : `There is no ${NAMES[link.kind] ?? link.kind} with this id that your owner can open (it may be in Trash, or never existed). Link only what a tool returned.`;
      problems.set(link.href, { href: link.href, kind: link.kind, id: link.id, problem });
    }
  }
  return links.filter((link) => problems.has(link.href)).map((link) => problems.get(link.href)!);
}
