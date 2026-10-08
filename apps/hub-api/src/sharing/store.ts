/**
 * Sharing: contacts, space members, single shared items, and the one ownership transfer.
 * The rules people see are in docs/29_SHARING.md. Limits live here so a paid plan can raise
 * them in one place.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isHosted } from "../lib/hosted-access.js";
import { copySettings, MAX_SPACES } from "../spaces/store.js";
import { PRIVATE_ARTIFACT_KINDS, SHARE_KINDS, type ShareKind } from "./context.js";
import { VIEW_ONLY_KINDS } from "./policy.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_CONTACTS = 5;
export const MAX_MEMBERS = 2;
export const MAX_TRANSFERS = 1;
const SPACE_EMAIL = "@spaces.ensemble.invalid";
const ACTIVE_JOBS = ["running", "claimed", "stopping", "waiting_approval"] as const;

export class SharingError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 429 = 400) {
    super(message);
    this.name = "SharingError";
  }
}

export type Person = { id: string; name: string; initials: string; avatar: string | null; email: string; exact: boolean; contact: boolean };

export function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (email.split("@")[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * `ak•••••e@gmail.com`: the first two and the last letter, enough to tell two people with one
 * name apart, not enough to mail them. Short names keep only their first letter.
 */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (local.length <= 4) return `${local.slice(0, 1)}•••@${domain}`;
  const hidden = Math.max(3, Math.min(8, local.length - 3));
  return `${local.slice(0, 2)}${"•".repeat(hidden)}${local.slice(-1)}@${domain}`;
}

export function displayName(name: string, email: string): string {
  const trimmed = name.trim();
  return trimmed && !trimmed.includes("@") ? trimmed : (email.split("@")[0] ?? "Someone");
}

const searchBudget = new Map<string, { count: number; reset: number }>();

/** At most 40 searches a minute per account, so the directory cannot be walked. */
function spendSearch(accountId: string): void {
  const now = Date.now();
  const row = searchBudget.get(accountId);
  if (!row || row.reset < now) {
    searchBudget.set(accountId, { count: 1, reset: now + 60_000 });
    return;
  }
  row.count += 1;
  if (row.count > 40) throw new SharingError("Too many searches. Wait a minute and try again.", 429);
}

/**
 * People with an Ensemble account, by name or email. Emails are masked unless what you typed
 * is that exact address (you already know it). Spaces and unverified hosted accounts never show.
 */
export async function searchPeople(db: Db, accountId: string, rawQuery: string): Promise<Person[]> {
  const q = rawQuery.trim();
  if (q.length < 2) return [];
  spendSearch(accountId);
  const lower = q.toLowerCase();
  const contacts = new Set((await db.contact.findMany({ where: { ownerId: accountId }, select: { contactId: true } })).map((row) => row.contactId));
  const rows = await db.user.findMany({
    where: {
      ownerId: null,
      id: { not: accountId },
      NOT: { email: { endsWith: SPACE_EMAIL } },
      ...(isHosted() ? { emailVerifiedAt: { not: null } } : {}),
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { startsWith: lower, mode: "insensitive" } },
        { authIdentities: { some: { email: { equals: lower, mode: "insensitive" } } } },
      ],
    },
    select: { id: true, name: true, email: true, avatar: true, authIdentities: { select: { email: true } } },
    take: 25,
  });
  const scored = rows.map((row) => {
    const emails = [row.email, ...row.authIdentities.map((item) => item.email ?? "")].map((value) => value.toLowerCase());
    const exact = emails.includes(lower);
    const name = displayName(row.name, row.email);
    const score = (contacts.has(row.id) ? 0 : 10) + (exact ? 0 : 5) + (name.toLowerCase().startsWith(lower) ? 0 : 2);
    return {
      score,
      person: { id: row.id, name, initials: initialsOf(row.name, row.email), avatar: row.avatar ?? null, email: exact ? q : maskEmail(row.email), exact, contact: contacts.has(row.id) },
    };
  });
  return scored
    .sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name))
    .slice(0, 8)
    .map((row) => row.person);
}

async function personRow(db: Db, id: string) {
  const row = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, ownerId: true } });
  if (!row || row.ownerId || row.email.endsWith(SPACE_EMAIL)) return null;
  return row;
}

/** The spaces an account owns: its own row and every space row it owns. */
export async function ownedSpaceIds(db: Db, accountId: string): Promise<string[]> {
  const owned = await db.user.findMany({ where: { ownerId: accountId }, select: { id: true } });
  return [accountId, ...owned.map((row) => row.id)];
}

/** The space, if this account owns it. Sharing is managed by the owner only. */
export async function requireOwnedSpace(db: Db, accountId: string, spaceId: string) {
  const space = await db.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true, name: true, spaceName: true } });
  if (!space || (space.id !== accountId && space.ownerId !== accountId)) throw new SharingError("Only the space's owner can share it.", 403);
  return space;
}

export type ContactRow = { id: string; name: string; initials: string; avatar: string | null; email: string; spaces: number; items: number; addedAt: string };

export async function listContacts(db: Db, accountId: string): Promise<ContactRow[]> {
  const spaces = await ownedSpaceIds(db, accountId);
  const rows = await db.contact.findMany({
    where: { ownerId: accountId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, contact: { select: { id: true, name: true, email: true, avatar: true } } },
  });
  const out: ContactRow[] = [];
  for (const row of rows) {
    const [members, items] = await Promise.all([
      db.spaceMember.count({ where: { accountId: row.contact.id, spaceId: { in: spaces } } }),
      db.share.count({ where: { recipientId: row.contact.id, spaceId: { in: spaces } } }),
    ]);
    out.push({
      id: row.contact.id,
      name: displayName(row.contact.name, row.contact.email),
      initials: initialsOf(row.contact.name, row.contact.email), avatar: row.contact.avatar ?? null,
      email: maskEmail(row.contact.email),
      spaces: members,
      items,
      addedAt: row.createdAt.toISOString(),
    });
  }
  return out;
}

/** Adds a contact when there is room. Already a contact: nothing changes. */
export async function ensureContact(db: Db, accountId: string, personId: string): Promise<void> {
  if (personId === accountId) throw new SharingError("You already have access to your own work.");
  const person = await personRow(db, personId);
  if (!person) throw new SharingError("That person does not have an Ensemble account.", 404);
  const existing = await db.contact.findUnique({ where: { ownerId_contactId: { ownerId: accountId, contactId: personId } } });
  if (existing) return;
  const count = await db.contact.count({ where: { ownerId: accountId } });
  if (count >= MAX_CONTACTS) {
    throw new SharingError(`You can share with up to ${MAX_CONTACTS} people. Remove someone from your contacts in Settings, Sharing, to add another.`, 409);
  }
  await db.contact.create({ data: { ownerId: accountId, contactId: personId } });
}

/** Removes a contact and, at once, everything this account shared with them. */
export async function removeContact(db: PrismaClient, accountId: string, personId: string): Promise<{ spaces: number; items: number }> {
  return db.$transaction(async (tx) => {
    const spaces = await ownedSpaceIds(tx, accountId);
    const members = await tx.spaceMember.deleteMany({ where: { accountId: personId, spaceId: { in: spaces } } });
    const items = await tx.share.deleteMany({ where: { recipientId: personId, spaceId: { in: spaces } } });
    await tx.contact.deleteMany({ where: { ownerId: accountId, contactId: personId } });
    return { spaces: members.count, items: items.count };
  });
}

export type MemberRow = { id: string; name: string; initials: string; avatar: string | null; email: string; role: "viewer" | "editor"; addedAt: string };

export async function listMembers(db: Db, spaceId: string): Promise<MemberRow[]> {
  const rows = await db.spaceMember.findMany({
    where: { spaceId },
    orderBy: { createdAt: "asc" },
    select: { role: true, createdAt: true, account: { select: { id: true, name: true, email: true, avatar: true } } },
  });
  return rows.map((row) => ({
    id: row.account.id,
    name: displayName(row.account.name, row.account.email),
    initials: initialsOf(row.account.name, row.account.email), avatar: row.account.avatar ?? null,
    email: maskEmail(row.account.email),
    role: row.role === "viewer" ? "viewer" : "editor",
    addedAt: row.createdAt.toISOString(),
  }));
}

function spaceLabel(space: { name: string; spaceName: string | null; ownerId: string | null }): string {
  if (space.ownerId) return space.spaceName || "Untitled space";
  return space.spaceName || `${space.name.trim().split(/\s+/)[0] || "My"}'s space`;
}

async function notify(db: Db, recipientId: string, title: string, body: string, url: string): Promise<void> {
  await db.notification.create({ data: { userId: recipientId, kind: "share", title: title.slice(0, 200), body: body.slice(0, 500), url } });
}

export async function addMember(db: PrismaClient, accountId: string, spaceId: string, personId: string, role: "viewer" | "editor"): Promise<MemberRow[]> {
  await db.$transaction(async (tx) => {
    const space = await requireOwnedSpace(tx, accountId, spaceId);
    if (personId === accountId) throw new SharingError("You already own this space.");
    const already = await tx.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId, accountId: personId } } });
    if (already) {
      await tx.spaceMember.update({ where: { id: already.id }, data: { role } });
      return;
    }
    if ((await tx.spaceMember.count({ where: { spaceId } })) >= MAX_MEMBERS) {
      throw new SharingError(`A space can be shared with ${MAX_MEMBERS} people. Remove someone to add another.`, 409);
    }
    await ensureContact(tx, accountId, personId);
    await tx.spaceMember.create({ data: { spaceId, accountId: personId, role, addedBy: accountId } });
    const owner = await tx.user.findUniqueOrThrow({ where: { id: accountId }, select: { name: true, email: true } });
    const ownerName = displayName(owner.name, owner.email);
    await notify(tx, personId, `${ownerName} shared the space “${spaceLabel(space)}” with you`, role === "editor" ? "You can view and edit it." : "You can view it.", "/shared");
  });
  return listMembers(db, spaceId);
}

export async function removeMember(db: PrismaClient, accountId: string, spaceId: string, personId: string): Promise<void> {
  await requireOwnedSpace(db, accountId, spaceId);
  await db.spaceMember.deleteMany({ where: { spaceId, accountId: personId } });
}

/** A member leaves a space shared with them. */
export async function leaveSpace(db: PrismaClient, accountId: string, spaceId: string): Promise<void> {
  const left = await db.spaceMember.deleteMany({ where: { spaceId, accountId } });
  if (!left.count) throw new SharingError("That space is not shared with you.", 404);
  await db.user.updateMany({ where: { id: accountId, lastSpaceId: spaceId }, data: { lastSpaceId: null } });
}

/** The item's title, or null when the space has no such item. */
export async function resourceTitle(db: Db, spaceId: string, kind: ShareKind, id: string): Promise<string | null> {
  switch (kind) {
    case "page": {
      const row = await db.taskPage.findFirst({ where: { id, userId: spaceId, taskId: null }, select: { title: true } });
      return row ? row.title || "Untitled" : null;
    }
    case "task": {
      const row = await db.task.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { title: true } });
      return row ? row.title || "Untitled task" : null;
    }
    case "diagram": {
      const row = await db.blockDiagram.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { title: true } });
      return row?.title ?? null;
    }
    case "plot":
    case "plot_space": {
      const row = await db.plot.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { title: true } });
      return row?.title ?? null;
    }
    case "skill": {
      const row = await db.skill.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { name: true } });
      return row?.name ?? null;
    }
    case "meeting": {
      const session = await db.meetingSession.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { title: true } });
      if (session) return session.title || "Meeting";
      const note = await db.meetingNote.findFirst({ where: { id, userId: spaceId, deletedAt: null }, select: { title: true } });
      return note ? note.title || "Meeting" : null;
    }
    case "board":
      return id === spaceId ? "Board" : null;
    case "workspace":
      return id === spaceId ? "Workspace" : null;
    case "code":
      return id === spaceId ? "Code" : null;
  }
}

export type ShareRow = { id: string; person: { id: string; name: string; initials: string; avatar: string | null; email: string }; role: "view" | "edit"; createdAt: string };

export async function listItemShares(db: Db, spaceId: string, kind: ShareKind, resourceId: string): Promise<ShareRow[]> {
  const rows = await db.share.findMany({
    where: { spaceId, kind, resourceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, createdAt: true, recipient: { select: { id: true, name: true, email: true, avatar: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    person: { id: row.recipient.id, name: displayName(row.recipient.name, row.recipient.email), initials: initialsOf(row.recipient.name, row.recipient.email), avatar: row.recipient.avatar ?? null, email: maskEmail(row.recipient.email) },
    role: row.role === "edit" ? "edit" : "view",
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function shareItem(
  db: PrismaClient,
  accountId: string,
  input: { spaceId: string; kind: ShareKind; resourceId: string; personId: string; role: "view" | "edit" },
): Promise<ShareRow[]> {
  if (!(SHARE_KINDS as readonly string[]).includes(input.kind)) throw new SharingError("That cannot be shared.");
  const role = VIEW_ONLY_KINDS.has(input.kind) ? "view" : input.role;
  await db.$transaction(async (tx) => {
    await requireOwnedSpace(tx, accountId, input.spaceId);
    if (input.personId === accountId) throw new SharingError("You already have access to your own work.");
    const title = await resourceTitle(tx, input.spaceId, input.kind, input.resourceId);
    if (title === null) throw new SharingError("That item is no longer in this space.", 404);
    await ensureContact(tx, accountId, input.personId);
    const existing = await tx.share.findUnique({
      where: { spaceId_kind_resourceId_recipientId: { spaceId: input.spaceId, kind: input.kind, resourceId: input.resourceId, recipientId: input.personId } },
    });
    if (existing) {
      await tx.share.update({ where: { id: existing.id }, data: { role, title } });
      return;
    }
    const share = await tx.share.create({
      data: { spaceId: input.spaceId, kind: input.kind, resourceId: input.resourceId, title, recipientId: input.personId, role, createdBy: accountId },
    });
    const owner = await tx.user.findUniqueOrThrow({ where: { id: accountId }, select: { name: true, email: true } });
    await notify(tx, input.personId, `${displayName(owner.name, owner.email)} shared “${title}” with you`, role === "edit" ? "You can view and edit it." : "You can view it.", `/shared/${share.id}`);
  });
  return listItemShares(db, input.spaceId, input.kind, input.resourceId);
}

export async function updateShare(db: PrismaClient, accountId: string, shareId: string, role: "view" | "edit"): Promise<void> {
  const share = await db.share.findUnique({ where: { id: shareId }, select: { spaceId: true, kind: true } });
  if (!share) throw new SharingError("That share is gone.", 404);
  await requireOwnedSpace(db, accountId, share.spaceId);
  await db.share.update({ where: { id: shareId }, data: { role: VIEW_ONLY_KINDS.has(share.kind as ShareKind) ? "view" : role } });
}

/** The owner stops sharing, or the recipient removes it from their list. */
export async function deleteShare(db: PrismaClient, accountId: string, shareId: string): Promise<void> {
  const share = await db.share.findUnique({ where: { id: shareId }, select: { spaceId: true, recipientId: true } });
  if (!share) return;
  if (share.recipientId !== accountId) await requireOwnedSpace(db, accountId, share.spaceId);
  await db.share.delete({ where: { id: shareId } });
}

export type SharedWithMe = {
  spaces: Array<{ id: string; name: string; icon: string | null; owner: { id: string; name: string; initials: string; avatar: string | null }; role: "viewer" | "editor"; since: string }>;
  items: Array<{ id: string; kind: ShareKind; title: string; role: "view" | "edit"; owner: { id: string; name: string; initials: string; avatar: string | null }; spaceName: string; since: string; openedAt: string | null }>;
};

export async function sharedWithMe(db: Db, accountId: string): Promise<SharedWithMe> {
  const [members, shares] = await Promise.all([
    db.spaceMember.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
      select: { role: true, createdAt: true, space: { select: { id: true, name: true, spaceName: true, spaceIcon: true, ownerId: true, email: true } } },
    }),
    db.share.findMany({
      where: { recipientId: accountId },
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, title: true, role: true, createdAt: true, openedAt: true, space: { select: { id: true, name: true, spaceName: true, ownerId: true, email: true } } },
    }),
  ]);
  const ownerIds = [...new Set([...members.map((row) => row.space.ownerId ?? row.space.id), ...shares.map((row) => row.space.ownerId ?? row.space.id)])];
  const owners = new Map(
    (await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true, avatar: true } })).map((row) => [
      row.id,
      { id: row.id, name: displayName(row.name, row.email), initials: initialsOf(row.name, row.email), avatar: row.avatar ?? null },
    ]),
  );
  const ownerOf = (space: { id: string; ownerId: string | null }) => owners.get(space.ownerId ?? space.id) ?? { id: space.ownerId ?? space.id, name: "Someone", initials: "?", avatar: null };
  return {
    spaces: members.map((row) => ({
      id: row.space.id,
      name: spaceLabel(row.space),
      icon: row.space.spaceIcon,
      owner: ownerOf(row.space),
      role: row.role === "viewer" ? "viewer" : "editor",
      since: row.createdAt.toISOString(),
    })),
    items: shares
      .filter((row) => (SHARE_KINDS as readonly string[]).includes(row.kind))
      .map((row) => ({
        id: row.id,
        kind: row.kind as ShareKind,
        title: row.title || "Untitled",
        role: row.role === "edit" ? "edit" : "view",
        owner: ownerOf(row.space),
        spaceName: spaceLabel(row.space),
        since: row.createdAt.toISOString(),
        openedAt: row.openedAt?.toISOString() ?? null,
      })),
  };
}

/**
 * Hands a space to one of its members, once. The space's content stays; everything private to
 * the old owner leaves with them: connected apps, model keys, devices, editor keys, settings.
 * The old owner stays on as an editor, so nobody loses their work.
 */
export async function transferSpace(db: PrismaClient, accountId: string, spaceId: string, toId: string): Promise<void> {
  if (spaceId === accountId) throw new SharingError("Your first space is your account. Only spaces you created can change owner.");
  await db.$transaction(async (tx) => {
    const space = await requireOwnedSpace(tx, accountId, spaceId);
    if (!space.ownerId) throw new SharingError("Your first space is your account. Only spaces you created can change owner.");
    if ((await tx.spaceTransfer.count({ where: { spaceId } })) >= MAX_TRANSFERS) {
      throw new SharingError("This space has already changed owner once. It cannot change owner again.", 409);
    }
    const member = await tx.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId, accountId: toId } } });
    if (!member) throw new SharingError("Share the space with them first. Ownership goes to someone who already has it.", 400);
    if (await tx.workspaceJob.count({ where: { userId: spaceId, status: { in: [...ACTIVE_JOBS, "queued"] } } })) {
      throw new SharingError("Stop or cancel the agent runs in this space before handing it over.", 409);
    }
    if ((await tx.user.count({ where: { ownerId: toId } })) + 1 >= MAX_SPACES) {
      throw new SharingError("They already have the most spaces an account can have.", 409);
    }
    // They keep the old owner as an editor. That needs a free contact slot on their side.
    const theirs = await tx.contact.findUnique({ where: { ownerId_contactId: { ownerId: toId, contactId: accountId } } });
    if (!theirs && (await tx.contact.count({ where: { ownerId: toId } })) >= MAX_CONTACTS) {
      throw new SharingError("Their contact list is full, so they could not keep you on the space. Ask them to make room first.", 409);
    }

    // Private to the old owner: connected apps, model keys, devices, editor keys, preferences.
    await tx.authToken.deleteMany({ where: { userId: spaceId } });
    await tx.mcpConnection.deleteMany({ where: { userId: spaceId } });
    await tx.modelCredential.deleteMany({ where: { userId: spaceId } });
    await tx.apiToken.updateMany({ where: { userId: spaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.device.updateMany({ where: { userId: spaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.preference.deleteMany({ where: { userId: spaceId, OR: [{ key: "hub.settings" }, { key: { startsWith: "ui." } }] } });
    await tx.share.deleteMany({ where: { spaceId } });
    // What the old owner's connected apps brought in (their inbox, chats, calendar) leaves with them.
    await tx.artifact.deleteMany({ where: { userId: spaceId, kind: { in: [...PRIVATE_ARTIFACT_KINDS] } } });
    await tx.syncState.deleteMany({ where: { userId: spaceId } });
    // "Null" means the owner on these rows. Name the old owner on theirs, and make the new owner's own rows the owner's.
    await tx.assistantConversation.updateMany({ where: { userId: spaceId, accountId: null }, data: { accountId } });
    await tx.assistantConversation.updateMany({ where: { userId: spaceId, accountId: toId }, data: { accountId: null } });
    await tx.pageDiscussion.updateMany({ where: { userId: spaceId, authorAccountId: null }, data: { authorAccountId: accountId } });
    await tx.pageDiscussion.updateMany({ where: { userId: spaceId, authorAccountId: toId }, data: { authorAccountId: null } });
    await tx.workspaceJob.updateMany({ where: { userId: spaceId, runnerAccountId: null }, data: { runnerAccountId: accountId } });
    await tx.workspaceJob.updateMany({ where: { userId: spaceId, runnerAccountId: toId }, data: { runnerAccountId: null } });
    // Undo across a change of owner would mix two people's histories.
    await tx.undoEntry.deleteMany({ where: { userId: spaceId } });

    const position = (await tx.user.count({ where: { ownerId: toId } })) + 1;
    const owner = await tx.user.findUniqueOrThrow({ where: { id: toId }, select: { name: true, gender: true, profession: true, organization: true, heardFrom: true, profileCompletedAt: true, emailVerifiedAt: true, tester: true } });
    await tx.user.update({ where: { id: spaceId }, data: { ownerId: toId, spacePosition: position, ...owner } });
    await tx.spaceMember.delete({ where: { id: member.id } });
    // Other members stay only if they are also the new owner's contacts.
    const others = await tx.spaceMember.findMany({ where: { spaceId }, select: { id: true, accountId: true } });
    for (const other of others) {
      const known = await tx.contact.findUnique({ where: { ownerId_contactId: { ownerId: toId, contactId: other.accountId } } });
      if (!known) await tx.spaceMember.delete({ where: { id: other.id } });
    }
    if (!theirs) await tx.contact.create({ data: { ownerId: toId, contactId: accountId } });
    await tx.spaceMember.create({ data: { spaceId, accountId, role: "editor", addedBy: toId } });
    await tx.spaceTransfer.create({ data: { spaceId, fromAccountId: accountId, toAccountId: toId } });
    await tx.user.updateMany({ where: { id: accountId, lastSpaceId: spaceId }, data: { lastSpaceId: null } });
    const from = await tx.user.findUniqueOrThrow({ where: { id: accountId }, select: { name: true, email: true } });
    await notify(tx, toId, `${displayName(from.name, from.email)} gave you the space “${space.spaceName || "Untitled space"}”`, "You own it now. Your settings and keys start fresh there.", "/settings?tab=spaces");
  });
  // The new owner's settings, not the old owner's, for the space they now own.
  await copySettings(db, toId, spaceId);
}
