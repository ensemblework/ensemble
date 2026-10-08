import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireBrowserSession } from "../bridge/auth.js";
import { accountIdOf } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { SHARE_KINDS } from "./context.js";
import { VIEW_ONLY_KINDS } from "./policy.js";
import { presenceIn, updatePresence } from "./presence.js";
import { revokeMember, revokeShare } from "./revoke.js";
import { isPublicKind, linkFor, listLinks, MAX_PUBLIC_LINKS, ownerName, removeLink, rotateLink, setLink } from "./links.js";
import {
  addMember,
  deleteShare,
  displayName,
  initialsOf,
  leaveSpace,
  listContacts,
  listItemShares,
  listMembers,
  MAX_CONTACTS,
  MAX_MEMBERS,
  ownedSpaceIds,
  removeContact,
  removeMember,
  requireOwnedSpace,
  resourceTitle,
  searchPeople,
  shareItem,
  sharedWithMe,
  SharingError,
  transferSpace,
  updateShare,
  ensureContact,
} from "./store.js";

const Id = z.string().trim().min(1).max(64);
const Kind = z.enum(SHARE_KINDS);
const MemberRole = z.enum(["viewer", "editor"]);
const ItemRole = z.enum(["view", "edit"]);
const Point = z.object({ x: z.number().finite(), y: z.number().finite() });
const Presence = z.object({
  tabId: z.string().trim().min(4).max(64),
  route: z.string().max(300).nullable().optional(),
  resource: z.object({ kind: Kind, id: Id }).nullable().optional(),
  cursor: Point.nullable().optional(),
  viewport: Point.extend({ zoom: z.number().finite().min(0.01).max(20) }).nullable().optional(),
  typing: z.boolean().optional(),
  leave: z.boolean().optional(),
});

function browserOnly(request: FastifyRequest): void {
  requireBrowserSession(request);
  if (request.authVia === "token" || request.authVia === "internal") {
    throw new SharingError("Sharing is managed from the Ensemble app.", 403);
  }
}

/** Members and recipients get a live nudge so their lists update without a reload. */
function nudge(accountIds: string[]): void {
  for (const id of new Set(accountIds)) sseHub.publish(id, { event: "sharing.changed", data: {} });
}

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/sharing/people", async (request) => {
    browserOnly(request);
    const { q } = z.object({ q: z.string().max(120).default("") }).parse(request.query);
    return { people: await searchPeople(prisma, accountIdOf(request), q) };
  });

  /** Everything on the Sharing settings tab, in one read. */
  app.get("/api/sharing/overview", async (request) => {
    browserOnly(request);
    const account = accountIdOf(request);
    const spaces = await ownedSpaceIds(prisma, account);
    const [contacts, rows, items, transfers, withMe] = await Promise.all([
      listContacts(prisma, account),
      prisma.user.findMany({ where: { id: { in: spaces } }, select: { id: true, name: true, spaceName: true, spaceIcon: true, ownerId: true, createdAt: true } }),
      prisma.share.findMany({
        where: { spaceId: { in: spaces } },
        orderBy: { createdAt: "desc" },
        select: { id: true, kind: true, title: true, role: true, spaceId: true, resourceId: true, createdAt: true, recipient: { select: { id: true, name: true, email: true, avatar: true } } },
      }),
      prisma.spaceTransfer.findMany({ where: { spaceId: { in: spaces } }, select: { spaceId: true, createdAt: true } }),
      sharedWithMe(prisma, account),
    ]);
    const transferred = new Map(transfers.map((row) => [row.spaceId, row.createdAt.toISOString()]));
    const ordered = [...rows].sort((a, b) => (a.ownerId ? 1 : 0) - (b.ownerId ? 1 : 0) || a.createdAt.getTime() - b.createdAt.getTime());
    const owned = [];
    for (const row of ordered) {
      owned.push({
        id: row.id,
        name: row.ownerId ? row.spaceName || "Untitled space" : row.spaceName || `${displayName(row.name, "").split(/\s+/)[0] || "My"}'s space`,
        icon: row.spaceIcon,
        primary: !row.ownerId,
        members: await listMembers(prisma, row.id),
        transferredAt: transferred.get(row.id) ?? null,
      });
    }
    return {
      limits: { contacts: MAX_CONTACTS, members: MAX_MEMBERS },
      contacts,
      spaces: owned,
      items: items
        .filter((row) => (SHARE_KINDS as readonly string[]).includes(row.kind))
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title || "Untitled",
          role: row.role === "edit" ? "edit" : "view",
          spaceId: row.spaceId,
          resourceId: row.resourceId,
          createdAt: row.createdAt.toISOString(),
          person: { id: row.recipient.id, name: displayName(row.recipient.name, row.recipient.email), initials: initialsOf(row.recipient.name, row.recipient.email), avatar: row.recipient.avatar ?? null },
        })),
      withMe,
    };
  });

  app.get("/api/sharing/contacts", async (request) => {
    browserOnly(request);
    return { limit: MAX_CONTACTS, contacts: await listContacts(prisma, accountIdOf(request)) };
  });

  app.post("/api/sharing/contacts", async (request, reply) => {
    browserOnly(request);
    const { personId } = z.object({ personId: Id }).parse(request.body);
    await ensureContact(prisma, accountIdOf(request), personId);
    return reply.code(201).send({ limit: MAX_CONTACTS, contacts: await listContacts(prisma, accountIdOf(request)) });
  });

  /** Removing a contact takes back every space and item you shared with them, at once. */
  app.delete("/api/sharing/contacts/:id", async (request) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const removed = await removeContact(prisma, accountIdOf(request), id);
    await revokeMember(prisma, await ownedSpaceIds(prisma, accountIdOf(request)), id);
    await appendLedger({ userId: accountIdOf(request), actor: "me", action: "sharing.contact.remove", payload: { contactId: id, ...removed } });
    nudge([id]);
    return { removed, limit: MAX_CONTACTS, contacts: await listContacts(prisma, accountIdOf(request)) };
  });

  app.get("/api/sharing/with-me", async (request) => {
    browserOnly(request);
    return sharedWithMe(prisma, accountIdOf(request));
  });

  /** Who has the space: the owner and its members. Members may read this too. */
  app.get("/api/sharing/spaces/:id/members", async (request) => {
    browserOnly(request);
    const spaceId = Id.parse((request.params as { id: string }).id);
    const account = accountIdOf(request);
    const space = await prisma.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
    const ownerId = space?.ownerId ?? space?.id;
    const member = space ? await prisma.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId, accountId: account } } }) : null;
    if (!space || (ownerId !== account && !member)) throw new SharingError("That space is not shared with you.", 404);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId! }, select: { id: true, name: true, email: true, avatar: true } });
    const transfer = await prisma.spaceTransfer.findUnique({ where: { spaceId } });
    return {
      owner: { id: owner.id, name: displayName(owner.name, owner.email), initials: initialsOf(owner.name, owner.email), avatar: owner.avatar ?? null },
      you: ownerId === account ? "owner" : member!.role === "viewer" ? "viewer" : "editor",
      limit: MAX_MEMBERS,
      members: await listMembers(prisma, spaceId),
      canTransfer: ownerId === account && Boolean(space.ownerId) && !transfer,
      transferredAt: transfer?.createdAt.toISOString() ?? null,
    };
  });

  app.post("/api/sharing/spaces/:id/members", async (request, reply) => {
    browserOnly(request);
    const spaceId = Id.parse((request.params as { id: string }).id);
    const body = z.object({ personId: Id, role: MemberRole.default("editor") }).parse(request.body);
    const members = await addMember(prisma, accountIdOf(request), spaceId, body.personId, body.role);
    await appendLedger({ userId: spaceId, actor: "me", action: "sharing.member.add", payload: { memberId: body.personId, role: body.role } });
    nudge([body.personId]);
    return reply.code(201).send({ limit: MAX_MEMBERS, members });
  });

  app.patch("/api/sharing/spaces/:id/members/:personId", async (request) => {
    browserOnly(request);
    const { id: spaceId, personId } = z.object({ id: Id, personId: Id }).parse(request.params);
    const { role } = z.object({ role: MemberRole }).parse(request.body);
    await requireOwnedSpace(prisma, accountIdOf(request), spaceId);
    const updated = await prisma.spaceMember.updateMany({ where: { spaceId, accountId: personId }, data: { role } });
    if (!updated.count) throw new SharingError("They are not in this space.", 404);
    await appendLedger({ userId: spaceId, actor: "me", action: "sharing.member.role", payload: { memberId: personId, role } });
    nudge([personId]);
    return { limit: MAX_MEMBERS, members: await listMembers(prisma, spaceId) };
  });

  /** The owner removes a member, or a member removes themself (leaves). */
  app.delete("/api/sharing/spaces/:id/members/:personId", async (request, reply) => {
    browserOnly(request);
    const { id: spaceId, personId } = z.object({ id: Id, personId: Id }).parse(request.params);
    const account = accountIdOf(request);
    if (personId === account) await leaveSpace(prisma, account, spaceId);
    else await removeMember(prisma, account, spaceId, personId);
    await revokeMember(prisma, [spaceId], personId);
    await appendLedger({ userId: spaceId, actor: "me", action: personId === account ? "sharing.member.leave" : "sharing.member.remove", payload: { memberId: personId } });
    nudge([personId]);
    return reply.code(204).send();
  });

  app.post("/api/sharing/spaces/:id/transfer", async (request) => {
    browserOnly(request);
    const spaceId = Id.parse((request.params as { id: string }).id);
    const body = z.object({ toId: Id, confirmation: z.string().max(80) }).parse(request.body);
    const space = await requireOwnedSpace(prisma, accountIdOf(request), spaceId);
    if (body.confirmation.trim() !== (space.spaceName ?? "").trim()) throw new SharingError("Type the space's name to hand it over.");
    await transferSpace(prisma, accountIdOf(request), spaceId, body.toId);
    // Everyone's stream on the space was opened under the old roles; they reconnect under the new ones.
    sseHub.close(spaceId);
    await appendLedger({ userId: spaceId, actor: "me", action: "sharing.transfer", payload: { from: accountIdOf(request), to: body.toId } });
    nudge([body.toId]);
    return { transferred: true };
  });

  /** Who a single item is shared with. Only the space's owner sees this. */
  app.get("/api/sharing/items", async (request) => {
    browserOnly(request);
    const query = z.object({ kind: Kind, resourceId: Id }).parse(request.query);
    await requireOwnedSpace(prisma, accountIdOf(request), request.userId);
    return { viewOnly: VIEW_ONLY_KINDS.has(query.kind), shares: await listItemShares(prisma, request.userId, query.kind, query.resourceId) };
  });

  /** Shares one item from the open space. */
  app.post("/api/sharing/items", async (request, reply) => {
    browserOnly(request);
    const body = z.object({ kind: Kind, resourceId: Id, personId: Id, role: ItemRole.default("view") }).parse(request.body);
    const shares = await shareItem(prisma, accountIdOf(request), { spaceId: request.userId, ...body });
    await appendLedger({ userId: request.userId, actor: "me", action: "sharing.item.add", payload: { kind: body.kind, resourceId: body.resourceId, recipientId: body.personId, role: body.role } });
    nudge([body.personId]);
    return reply.code(201).send({ viewOnly: VIEW_ONLY_KINDS.has(body.kind), shares });
  });

  app.patch("/api/sharing/items/:id", async (request) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const { role } = z.object({ role: ItemRole }).parse(request.body);
    await updateShare(prisma, accountIdOf(request), id, role);
    const share = await prisma.share.findUniqueOrThrow({ where: { id }, select: { recipientId: true } });
    nudge([share.recipientId]);
    return { updated: true };
  });

  app.delete("/api/sharing/items/:id", async (request, reply) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const share = await prisma.share.findUnique({ where: { id }, select: { recipientId: true, spaceId: true, kind: true } });
    await deleteShare(prisma, accountIdOf(request), id);
    if (share) revokeShare(share.spaceId, share.recipientId, id);
    if (share) {
      await appendLedger({ userId: share.spaceId, actor: "me", action: "sharing.item.remove", payload: { shareId: id, kind: share.kind } });
      nudge([share.recipientId]);
    }
    return reply.code(204).send();
  });

  /** Who else is here. Someone with one shared item sees only the people on that item. */
  app.get("/api/presence", async (request) => {
    const access = request.access;
    const only = access?.kind === "share" || access?.kind === "link" ? { kind: access.resource, id: access.resourceId } : undefined;
    return { you: accountIdOf(request), people: presenceIn(request.userId, only) };
  });

  app.post("/api/presence", async (request, reply) => {
    const body = Presence.parse(request.body);
    const access = request.access;
    // A shared item's or a public link's viewer is always on that item, and never says where else they are.
    const pinned = access?.kind === "share" || access?.kind === "link" ? { route: null, resource: { kind: access.resource, id: access.resourceId } } : {};
    const visitor =
      access?.kind === "link" && !access.visitor.signedIn
        ? {
            name: access.visitor.name,
            initials: access.visitor.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase(),
            avatar: null,
            emoji: access.visitor.emoji,
            color: access.visitor.color,
            signedIn: false,
          }
        : undefined;
    await updatePresence(prisma, request.userId, accountIdOf(request), { ...body, ...pinned }, visitor);
    return reply.code(204).send();
  });

  // ── Public links ──────────────────────────────────────────────────────

  /** Your public links, across your spaces. */
  app.get("/api/links", async (request) => {
    browserOnly(request);
    return { limit: MAX_PUBLIC_LINKS, links: await listLinks(prisma, accountIdOf(request)) };
  });

  /** The public link for one item in the open space (owner only), and how many of yours are in use. */
  app.get("/api/links/item", async (request) => {
    browserOnly(request);
    const query = z.object({ kind: z.string().max(20), resourceId: Id }).parse(request.query);
    await requireOwnedSpace(prisma, accountIdOf(request), request.userId);
    const used = (await listLinks(prisma, accountIdOf(request))).length;
    return {
      limit: MAX_PUBLIC_LINKS,
      used,
      allowed: isPublicKind(query.kind),
      link: isPublicKind(query.kind) ? await linkFor(prisma, request.userId, query.kind, query.resourceId) : null,
    };
  });

  app.post("/api/links", async (request, reply) => {
    browserOnly(request);
    const body = z.object({ kind: z.string().max(20), resourceId: Id, role: ItemRole.default("view") }).parse(request.body);
    const link = await setLink(prisma, accountIdOf(request), { spaceId: request.userId, ...body });
    await appendLedger({ userId: request.userId, actor: "me", action: "sharing.link.set", payload: { kind: link.kind, resourceId: link.resourceId, role: link.role } });
    sseHub.close(request.userId, (listener) => listener.share?.linkId === link.id);
    return reply.code(201).send({ link, limit: MAX_PUBLIC_LINKS });
  });

  app.delete("/api/links/:id", async (request, reply) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const link = await removeLink(prisma, accountIdOf(request), id);
    await appendLedger({ userId: link.spaceId, actor: "me", action: "sharing.link.remove", payload: { kind: link.kind, resourceId: link.resourceId } });
    sseHub.close(link.spaceId, (listener) => listener.share?.linkId === id);
    return reply.code(204).send();
  });

  /** A new address for the same link. Whoever had the old one loses it. */
  app.post("/api/links/:id/rotate", async (request) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const { row, spaceId } = await rotateLink(prisma, accountIdOf(request), id);
    sseHub.close(spaceId, (listener) => listener.share?.linkId === id);
    return { link: row };
  });

  /** What a public link opens, for whoever holds it. */
  app.get("/api/links/open", async (request, reply) => {
    const access = request.access;
    if (access?.kind !== "link") return reply.code(404).send({ error: "This link doesn't open anything." });
    const title = await resourceTitle(prisma, request.userId, access.resource, access.resourceId);
    if (title === null) return reply.code(404).send({ error: "The owner deleted this." });
    await prisma.publicLink.update({ where: { id: access.linkId }, data: { opens: { increment: 1 }, openedAt: new Date() } }).catch(() => undefined);
    const owner = await ownerName(prisma, access.ownerId);
    return {
      kind: access.resource,
      resourceId: access.resourceId,
      title,
      role: access.role,
      owner: { name: owner.name, initials: initialsOf(owner.name, ""), avatar: owner.avatar },
      you: access.visitor,
    };
  });

  /** What a share link opens, for the person it was shared with. Marks it opened. */
  app.get("/api/sharing/open/:id", async (request) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const share = await prisma.share.findFirst({
      where: { id, recipientId: accountIdOf(request) },
      select: {
        id: true,
        kind: true,
        resourceId: true,
        title: true,
        role: true,
        openedAt: true,
        space: { select: { id: true, name: true, email: true, spaceName: true, ownerId: true } },
      },
    });
    if (!share || !(SHARE_KINDS as readonly string[]).includes(share.kind)) throw new SharingError("This share was removed, or it is not yours.", 404);
    if (!share.openedAt) await prisma.share.update({ where: { id }, data: { openedAt: new Date() } });
    const ownerId = share.space.ownerId ?? share.space.id;
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, name: true, email: true, avatar: true } });
    return {
      id: share.id,
      kind: share.kind,
      resourceId: share.resourceId,
      title: share.title || "Untitled",
      role: VIEW_ONLY_KINDS.has(share.kind as (typeof SHARE_KINDS)[number]) ? "view" : share.role === "edit" ? "edit" : "view",
      spaceId: share.space.id,
      owner: { id: owner.id, name: displayName(owner.name, owner.email), initials: initialsOf(owner.name, owner.email), avatar: owner.avatar ?? null },
    };
  });
}
