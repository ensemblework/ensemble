/**
 * Accounts, sessions and personal API tokens.
 *
 * Browser requests carry an httpOnly session cookie. Editor hooks and the
 * Context Bridge carry `Authorization: Bearer ens_…`. agent-runtime carries
 * the internal token plus x-ensemble-user. ENSEMBLE_DEV_AUTH_BYPASS keeps the old
 * single-user localhost mode for scripts and tests.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { FULL_MODULE_SET } from "@ensemble/shared-types";
import { env } from "../config.js";
import { normalizeCookieDomain } from "@ensemble/shared-types/cookie-site";
import { knownTokenScope } from "../bridge/auth.js";
import { sessionCookieHeader, sessionCookieSecure } from "./cookie.js";
import { prisma } from "./prisma.js";
import { openableSpace, SPACE_COOKIE } from "../spaces/store.js";
import { SHARE_KINDS, type Access, type ShareKind } from "../sharing/context.js";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

export const SESSION_COOKIE = "ensemble_session";
const SESSION_DAYS = 30;

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt:")) return false;
  const [, salt, hash] = stored.split(":");
  const expected = Buffer.from(hash!, "base64");
  const derived = await scryptAsync(password, Buffer.from(salt!, "base64"), expected.length);
  return timingSafeEqual(derived, expected);
}

function desktopTokenMatches(authorization: string | undefined, secret: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || !secret) return false;
  const given = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || given.length === 0) return false;
  return timingSafeEqual(given, expected);
}

export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function appendCookie(reply: FastifyReply, header: string): void {
  const current = reply.getHeader("Set-Cookie");
  const cookies = typeof current === "string" ? [current] : Array.isArray(current) ? current : [];
  reply.header("Set-Cookie", [...cookies, header]);
}

function cookieSecure(request: FastifyRequest): boolean {
  return sessionCookieSecure({
    nodeEnv: process.env.NODE_ENV,
    protocol: request.protocol,
    forwardedProto: request.headers["x-forwarded-proto"],
  });
}

export async function startSession(reply: FastifyReply, userId: string, request: FastifyRequest): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { moduleSet: true, lastSpaceId: true } });
  const agent = request.headers["user-agent"];
  const userAgent = Array.isArray(agent) ? (agent[0] ?? "") : (agent ?? "");
  await prisma.session.create({
    data: {
      id: sha256(token),
      userId,
      userAgent: userAgent.slice(0, 200),
      expiresAt,
      modules: user?.moduleSet ?? FULL_MODULE_SET,
    },
  });
  appendCookie(reply, sessionCookieHeader(SESSION_COOKIE, token, SESSION_DAYS * 86_400, cookieSecure(request), sessionCookieDomain()));
  // A new sign-in reopens the space used last. Anything else (or a deleted space) is the account's own.
  const last = await openableSpace(prisma, userId, user?.lastSpaceId);
  appendCookie(reply, sessionCookieHeader(SPACE_COOKIE, last?.id ?? "", last ? 400 * 86_400 : 0, cookieSecure(request), sessionCookieDomain()));
}

function sessionCookieDomain(): string | null {
  return normalizeCookieDomain(process.env.ENSEMBLE_COOKIE_DOMAIN);
}

export async function endSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  appendCookie(reply, sessionCookieHeader(SESSION_COOKIE, "", 0, cookieSecure(request), sessionCookieDomain()));
  appendCookie(reply, sessionCookieHeader(SPACE_COOKIE, "", 0, cookieSecure(request), sessionCookieDomain()));
}

export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = `ens_${randomBytes(24).toString("base64url")}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 8) };
}

export type AuthVia = "session" | "token" | "internal" | "bypass" | "desktop";
export type TokenScope = "full" | "bridge" | "device";

/**
 * `userId` is whose data the request reads and writes: the active Ensemble space.
 * `accountId` is who signed in. They differ only inside a space other than the account's own.
 */
export type Identity = { userId: string; accountId?: string; via: AuthVia; tokenScope?: TokenScope; tokenId?: string; modules: string | null; access?: Access };

export const SHARE_HEADER = "x-ensemble-share";

/** The signed-in account. Falls back to userId where nothing set it (service calls, test apps). */
export function accountIdOf(request: { userId: string; accountId?: string }): string {
  return request.accountId ?? request.userId;
}

/** True when the signed-in person owns the open space (always, outside sharing). */
export function ownsOpenSpace(request: { access?: Access }): boolean {
  return !request.access || request.access.kind === "owner";
}

/** The space whose settings apply to you: the open one if it is yours, else your own account. */
export function settingsUserOf(request: { userId: string; accountId?: string; access?: Access }): string {
  return ownsOpenSpace(request) ? request.userId : accountIdOf(request);
}

/**
 * Browser sign-ins open the space named by the space cookie: one you own, or one shared with
 * you as a member. The share header opens a single item shared with you instead, and wins over
 * the cookie. Tokens and service calls never read either.
 */
async function inSpace(request: FastifyRequest, who: Identity): Promise<Identity> {
  const account = who.userId;
  const header = request.headers[SHARE_HEADER];
  const shareId = Array.isArray(header) ? header[0] : header;
  if (shareId) {
    const share = await prisma.share.findFirst({
      where: { id: shareId, recipientId: account },
      select: { id: true, kind: true, resourceId: true, role: true, space: { select: { id: true, moduleSet: true, ownerId: true } } },
    });
    if (!share || !(SHARE_KINDS as readonly string[]).includes(share.kind)) return { ...who, accountId: account, access: { kind: "gone" } };
    return {
      ...who,
      userId: share.space.id,
      accountId: account,
      modules: share.space.moduleSet,
      access: {
        kind: "share",
        shareId: share.id,
        resource: share.kind as ShareKind,
        resourceId: share.resourceId,
        role: share.role === "edit" ? "edit" : "view",
        ownerId: share.space.ownerId ?? share.space.id,
      },
    };
  }
  const space = await openableSpace(prisma, account, readCookie(request, SPACE_COOKIE));
  if (!space) return { ...who, accountId: account, access: { kind: "owner" } };
  return {
    ...who,
    userId: space.id,
    accountId: account,
    modules: space.moduleSet,
    access: space.member ? { kind: "member", role: space.member.role, ownerId: space.member.ownerId } : { kind: "owner" },
  };
}

async function modulesForUser(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { moduleSet: true } });
  return user?.moduleSet ?? null;
}

export async function identify(request: FastifyRequest): Promise<Identity | null> {
  const internal = request.headers["x-ensemble-internal"];
  if (internal && internal === env.ENSEMBLE_INTERNAL_TOKEN) {
    const user = request.headers["x-ensemble-user"];
    const userId = (Array.isArray(user) ? user[0] : user) || env.ENSEMBLE_DEV_USER_ID;
    return { userId, via: "internal", modules: await modulesForUser(userId) };
  }
  const authorization = request.headers.authorization;
  if (desktopTokenMatches(authorization, process.env.ENSEMBLE_DESKTOP_TOKEN)) {
    const userId = env.ENSEMBLE_DEV_USER_ID;
    return inSpace(request, { userId, via: "desktop", tokenScope: "full", modules: await modulesForUser(userId) });
  }
  if (authorization?.startsWith("Bearer ens_")) {
    const row = await prisma.apiToken.findUnique({
      where: { tokenHash: sha256(authorization.slice(7)) },
      include: { user: { select: { moduleSet: true } } },
    });
    if (!row || row.revokedAt) return null;
    const tokenScope = knownTokenScope(row.scope);
    if (!tokenScope) return null;
    void prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { userId: row.userId, via: "token", tokenScope, tokenId: row.id, modules: row.user.moduleSet };
  }
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) {
    const session = await prisma.session.findUnique({ where: { id: sha256(cookie) } });
    if (session && session.expiresAt > new Date()) return inSpace(request, { userId: session.userId, via: "session", modules: session.modules });
  }
  if (env.ENSEMBLE_DEV_AUTH_BYPASS) return inSpace(request, { userId: env.ENSEMBLE_DEV_USER_ID, via: "bypass", modules: await modulesForUser(env.ENSEMBLE_DEV_USER_ID) });
  return null;
}
