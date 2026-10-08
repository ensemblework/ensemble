/**
 * Public links: one item (a page, task, diagram or meeting notes) anyone with the link can
 * open, signed in or not. At most MAX_PUBLIC_LINKS per account for now. A whole space can
 * never be public. Rules for what a link reaches are LINK_RULES in policy.ts.
 */
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { PUBLIC_KINDS, PUBLIC_VIEW_ONLY, type PublicKind } from "./context.js";
import { displayName, ownedSpaceIds, requireOwnedSpace, resourceTitle, SharingError } from "./store.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_PUBLIC_LINKS = 5;
export const LINK_HEADER = "x-ensemble-link";
export const VISITOR_HEADER = "x-ensemble-visitor";

export function isPublicKind(kind: string): kind is PublicKind {
  return (PUBLIC_KINDS as readonly string[]).includes(kind);
}

export function newLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The link a token names, with its space, or null. */
export async function resolveLink(db: Db, token: string | null | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const link = await db.publicLink.findUnique({
    where: { token },
    select: { id: true, kind: true, resourceId: true, role: true, space: { select: { id: true, ownerId: true, moduleSet: true } } },
  });
  if (!link || !isPublicKind(link.kind)) return null;
  const role: "view" | "edit" = link.role === "edit" && !PUBLIC_VIEW_ONLY.has(link.kind) ? "edit" : "view";
  return { id: link.id, kind: link.kind, resourceId: link.resourceId, role, space: link.space, ownerId: link.space.ownerId ?? link.space.id };
}

export type LinkRow = { id: string; token: string; kind: PublicKind; resourceId: string; title: string; role: "view" | "edit"; spaceId: string; createdAt: string; openedAt: string | null; opens: number };

function row(link: { id: string; token: string; kind: string; resourceId: string; title: string; role: string; spaceId: string; createdAt: Date; openedAt: Date | null; opens: number }): LinkRow {
  return {
    id: link.id,
    token: link.token,
    kind: link.kind as PublicKind,
    resourceId: link.resourceId,
    title: link.title || "Untitled",
    role: link.role === "edit" ? "edit" : "view",
    spaceId: link.spaceId,
    createdAt: link.createdAt.toISOString(),
    openedAt: link.openedAt?.toISOString() ?? null,
    opens: link.opens,
  };
}

export async function listLinks(db: Db, accountId: string): Promise<LinkRow[]> {
  const spaces = await ownedSpaceIds(db, accountId);
  const rows = await db.publicLink.findMany({ where: { spaceId: { in: spaces } }, orderBy: { createdAt: "desc" } });
  return rows.map(row);
}

export async function linkFor(db: Db, spaceId: string, kind: PublicKind, resourceId: string): Promise<LinkRow | null> {
  const link = await db.publicLink.findUnique({ where: { spaceId_kind_resourceId: { spaceId, kind, resourceId } } });
  return link ? row(link) : null;
}

/** Turns on (or changes the role of) the public link for one item in a space you own. */
export async function setLink(db: PrismaClient, accountId: string, input: { spaceId: string; kind: string; resourceId: string; role: "view" | "edit" }): Promise<LinkRow> {
  if (!isPublicKind(input.kind)) throw new SharingError("Only pages, tasks, diagrams and meeting notes can be opened to anyone with the link.");
  const kind = input.kind;
  const role = PUBLIC_VIEW_ONLY.has(kind) ? "view" : input.role;
  return db.$transaction(async (tx) => {
    await requireOwnedSpace(tx, accountId, input.spaceId);
    const title = await resourceTitle(tx, input.spaceId, kind, input.resourceId);
    if (title === null) throw new SharingError("That item is no longer in this space.", 404);
    const existing = await tx.publicLink.findUnique({ where: { spaceId_kind_resourceId: { spaceId: input.spaceId, kind, resourceId: input.resourceId } } });
    if (existing) return row(await tx.publicLink.update({ where: { id: existing.id }, data: { role, title } }));
    const spaces = await ownedSpaceIds(tx, accountId);
    if ((await tx.publicLink.count({ where: { spaceId: { in: spaces } } })) >= MAX_PUBLIC_LINKS) {
      throw new SharingError(`You can have ${MAX_PUBLIC_LINKS} public links. Turn one off in Settings › Sharing to make another.`, 409);
    }
    return row(await tx.publicLink.create({ data: { token: newLinkToken(), spaceId: input.spaceId, kind, resourceId: input.resourceId, title, role, createdBy: accountId } }));
  });
}

async function ownLink(db: Db, accountId: string, id: string) {
  const link = await db.publicLink.findUnique({ where: { id } });
  if (!link) throw new SharingError("That link is gone.", 404);
  await requireOwnedSpace(db, accountId, link.spaceId);
  return link;
}

export async function removeLink(db: PrismaClient, accountId: string, id: string) {
  const link = await ownLink(db, accountId, id);
  await db.publicLink.delete({ where: { id } });
  return link;
}

/** A new address for the same link; the old one stops working at once. */
export async function rotateLink(db: PrismaClient, accountId: string, id: string): Promise<{ row: LinkRow; spaceId: string }> {
  const link = await ownLink(db, accountId, id);
  return { row: row(await db.publicLink.update({ where: { id }, data: { token: newLinkToken() } })), spaceId: link.spaceId };
}

export async function ownerName(db: Db, ownerId: string): Promise<{ name: string; avatar: string | null }> {
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true, avatar: true } });
  return { name: owner ? displayName(owner.name, owner.email) : "Someone", avatar: owner?.avatar ?? null };
}
