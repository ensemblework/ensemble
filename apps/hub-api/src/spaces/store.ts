/**
 * Ensemble spaces.
 *
 * A space is a `users` row whose `ownerId` is the signed-in account. Every record in
 * Ensemble is scoped by user id, so a space shares nothing with the account's other
 * spaces: tasks, pages, people, connectors, settings, model keys, files, tokens. The
 * account row is itself the first space.
 *
 * The active space is the `ensemble_space` cookie. `identify` (lib/auth.ts) honours it
 * only when the row is owned by the signed-in account, so a forged value can at most
 * pick another of your own spaces.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Settings } from "@ensemble/shared-types";
import { normalizeCookieDomain } from "@ensemble/shared-types/cookie-site";
import { sessionCookieHeader, sessionCookieSecure } from "../lib/cookie.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const SPACE_COOKIE = "ensemble_space";
export const MAX_SPACES = 12;
const COOKIE_DAYS = 400;

/** Not deliverable and not a login: `.invalid` is reserved (RFC 2606). */
export function spaceEmail(): string {
  return `space-${randomUUID()}@spaces.ensemble.invalid`;
}

function cookieSecure(request: FastifyRequest): boolean {
  return sessionCookieSecure({ nodeEnv: process.env.NODE_ENV, protocol: request.protocol, forwardedProto: request.headers["x-forwarded-proto"] });
}

/** Opens `spaceId` for this browser. Null clears the cookie, which means the account's own space. */
export function spaceCookieHeader(request: FastifyRequest, spaceId: string | null): string {
  const domain = normalizeCookieDomain(process.env.ENSEMBLE_COOKIE_DOMAIN);
  return sessionCookieHeader(SPACE_COOKIE, spaceId ?? "", spaceId ? COOKIE_DAYS * 86_400 : 0, cookieSecure(request), domain);
}

export function setSpaceCookie(reply: FastifyReply, request: FastifyRequest, spaceId: string | null): void {
  const current = reply.getHeader("Set-Cookie");
  const cookies = typeof current === "string" ? [current] : Array.isArray(current) ? current : [];
  reply.header("Set-Cookie", [...cookies, spaceCookieHeader(request, spaceId)]);
}

/** The space the cookie names, when the account owns it. */
export async function ownedSpace(db: Db, accountId: string, spaceId: string | null | undefined) {
  if (!spaceId || spaceId === accountId) return null;
  return db.user.findFirst({ where: { id: spaceId, ownerId: accountId }, select: { id: true, moduleSet: true } });
}

/**
 * A space this account may open: one it owns, or one shared with it as a member. Null for the
 * account's own first space (no cookie needed) and for anything else.
 */
export async function openableSpace(db: Db, accountId: string, spaceId: string | null | undefined) {
  if (!spaceId || spaceId === accountId) return null;
  const owned = await db.user.findFirst({ where: { id: spaceId, ownerId: accountId }, select: { id: true, moduleSet: true } });
  if (owned) return { id: owned.id, moduleSet: owned.moduleSet, member: null };
  const member = await db.spaceMember.findUnique({
    where: { spaceId_accountId: { spaceId, accountId } },
    select: { role: true, space: { select: { id: true, moduleSet: true, ownerId: true } } },
  });
  if (!member) return null;
  return {
    id: member.space.id,
    moduleSet: member.space.moduleSet,
    member: { role: member.role === "viewer" ? ("viewer" as const) : ("editor" as const), ownerId: member.space.ownerId ?? member.space.id },
  };
}

/** The account a user id belongs to: itself, or the owner of a space. */
export async function accountOf(db: Db, userId: string): Promise<string> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { ownerId: true } });
  return row?.ownerId ?? userId;
}

export type SpaceSummary = {
  id: string;
  name: string;
  icon: string | null;
  primary: boolean;
  role: string | null;
  templateId: string | null;
  createdAt: string;
};

export function defaultSpaceName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first && !first.includes("@") ? `${first}'s space` : "My space";
}

export async function listSpaces(db: Db, accountId: string): Promise<{ account: { sync: boolean; role: string | null }; spaces: SpaceSummary[] }> {
  const account = await db.user.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, name: true, spaceName: true, spaceIcon: true, onboardingRole: true, onboardingTemplateId: true, createdAt: true, spaceSettingsSync: true },
  });
  const owned = await db.user.findMany({
    where: { ownerId: accountId },
    orderBy: [{ spacePosition: "asc" }, { createdAt: "asc" }],
    select: { id: true, spaceName: true, spaceIcon: true, onboardingRole: true, onboardingTemplateId: true, createdAt: true },
  });
  return {
    account: { sync: account.spaceSettingsSync, role: account.onboardingRole },
    spaces: [
      {
        id: account.id,
        name: account.spaceName || defaultSpaceName(account.name),
        icon: account.spaceIcon,
        primary: true,
        role: account.onboardingRole,
        templateId: account.onboardingTemplateId,
        createdAt: account.createdAt.toISOString(),
      },
      ...owned.map((row) => ({
        id: row.id,
        name: row.spaceName || "Untitled space",
        icon: row.spaceIcon,
        primary: false,
        role: row.onboardingRole,
        templateId: row.onboardingTemplateId,
        createdAt: row.createdAt.toISOString(),
      })),
    ],
  };
}

/** Account fields a space mirrors: who you are, not what you work on. */
const MIRRORED = { name: true, gender: true, profession: true, organization: true, heardFrom: true, profileCompletedAt: true, emailVerifiedAt: true, tester: true } as const;

/** Copies the account's identity fields onto every space it owns. Call after a profile or verification change. */
export async function mirrorAccount(db: Db, accountId: string): Promise<void> {
  const account = await db.user.findUnique({ where: { id: accountId }, select: { ...MIRRORED, ownerId: true } });
  if (!account || account.ownerId) return;
  const { ownerId: _owner, ...fields } = account;
  await db.user.updateMany({ where: { ownerId: accountId }, data: fields });
}

export async function createSpaceUser(db: Db, accountId: string, input: { name: string; icon: string | null }): Promise<string> {
  const account = await db.user.findUniqueOrThrow({ where: { id: accountId }, select: { ...MIRRORED, ownerId: true } });
  if (account.ownerId) throw Object.assign(new Error("Spaces belong to an account, not to another space."), { statusCode: 400 });
  const count = await db.user.count({ where: { ownerId: accountId } });
  if (count + 1 >= MAX_SPACES) throw Object.assign(new Error(`You can have up to ${MAX_SPACES} spaces. Delete one to make room.`), { statusCode: 409 });
  const { ownerId: _owner, ...fields } = account;
  const row = await db.user.create({
    data: {
      ...fields,
      email: spaceEmail(),
      ownerId: accountId,
      spaceName: input.name,
      spaceIcon: input.icon,
      spacePosition: count + 1,
    },
  });
  return row.id;
}

/** Parts of Settings that belong to a space's own data, never copied or synced. */
const SPACE_ONLY_SETTINGS = ["connections", "connectorProducts", "code"] as const;
/** Model keys only. Paired-device and git tokens reach into a space's data. */
const SPACE_ONLY_CREDENTIALS = ["ensemble_device", "github_git"];
const SETTINGS_KEY = "hub.settings";

/**
 * Makes `to` use `from`'s settings: the settings document (minus connected apps, code
 * folders and the template's assistant tone), model keys, and `ui.*` preferences such as
 * keyboard shortcuts.
 */
export async function copySettings(db: Db, from: string, to: string): Promise<void> {
  if (from === to) return;
  const [source, target] = await Promise.all([
    db.preference.findFirst({ where: { userId: from, key: SETTINGS_KEY, deletedAt: null } }),
    db.preference.findFirst({ where: { userId: to, key: SETTINGS_KEY, deletedAt: null } }),
  ]);
  if (source) {
    const src = Settings.parse(source.value ?? {});
    const dst = Settings.parse(target?.value ?? {});
    const next = Settings.parse({
      ...src,
      ...Object.fromEntries(SPACE_ONLY_SETTINGS.map((key) => [key, dst[key]])),
      assistant: { ...src.assistant, actAs: dst.assistant.actAs },
    });
    await db.preference.upsert({
      where: { userId_key: { userId: to, key: SETTINGS_KEY } },
      create: { userId: to, key: SETTINGS_KEY, value: next as Prisma.InputJsonValue, source: "me" },
      update: { value: next as Prisma.InputJsonValue, source: "me", deletedAt: null },
    });
  }

  const keys = await db.modelCredential.findMany({ where: { userId: from, provider: { notIn: SPACE_ONLY_CREDENTIALS } } });
  await db.modelCredential.deleteMany({ where: { userId: to, provider: { notIn: SPACE_ONLY_CREDENTIALS } } });
  for (const row of keys) {
    await db.modelCredential.create({ data: { userId: to, provider: row.provider, secret: row.secret, hint: row.hint, baseUrl: row.baseUrl, updatedAt: row.updatedAt } });
  }

  const prefs = await db.preference.findMany({ where: { userId: from, key: { startsWith: "ui." }, deletedAt: null } });
  await db.preference.updateMany({ where: { userId: to, key: { startsWith: "ui.", notIn: prefs.map((row) => row.key) } }, data: { deletedAt: new Date() } });
  for (const row of prefs) {
    await db.preference.upsert({
      where: { userId_key: { userId: to, key: row.key } },
      create: { userId: to, key: row.key, value: row.value as Prisma.InputJsonValue, source: "me", confidence: 1 },
      update: { value: row.value as Prisma.InputJsonValue, source: "me", confidence: 1, deletedAt: null },
    });
  }
}

/** All spaces of an account, the account first. */
export async function spaceIds(db: Db, accountId: string): Promise<string[]> {
  const owned = await db.user.findMany({ where: { ownerId: accountId }, select: { id: true } });
  return [accountId, ...owned.map((row) => row.id)];
}

/**
 * After a settings, model-key, or `ui.*` write in `userId`'s space: when the account keeps
 * settings in sync, every other space gets the same. A failure here never fails the write.
 */
export async function mirrorSettings(db: PrismaClient, userId: string): Promise<void> {
  try {
    const me = await db.user.findUnique({ where: { id: userId }, select: { ownerId: true } });
    if (!me) return;
    const accountId = me.ownerId ?? userId;
    const account = await db.user.findUnique({ where: { id: accountId }, select: { spaceSettingsSync: true } });
    if (!account?.spaceSettingsSync) return;
    for (const id of await spaceIds(db, accountId)) if (id !== userId) await copySettings(db, userId, id);
  } catch (error) {
    console.warn("[spaces] settings sync failed", error instanceof Error ? error.message : error);
  }
}
