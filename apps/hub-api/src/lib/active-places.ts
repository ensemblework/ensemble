import type { PrismaClient, Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { accountIdOf, readCookie, SESSION_COOKIE, sha256 } from "./auth.js";
import { lockUserTransaction } from "./user-lock.js";

export const PLACE_HEADER = "x-ensemble-place";
export const PLACE_ACCOUNT_HEADER = "x-ensemble-place-account";
export const PLACE_LEASE_MS = 60_000;
export const PLACE_LIMIT = 3;
export const PlaceInput = z.object({
  id: z.string().uuid(),
  seq: z.number().int().min(1).max(2_147_483_647),
  surface: z.enum(["hub", "node", "desktop"]),
  accountId: z.string().min(1).max(256).optional(),
});
type Db = PrismaClient | Prisma.TransactionClient;

async function lockPlaceSession(tx: Prisma.TransactionClient, userId: string, sessionId: string) {
  // Session deletion cascades to places, so lock the session before a place row.
  const sessions = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND expires_at > clock_timestamp() FOR KEY SHARE`;
  if (!sessions.length) throw Object.assign(new Error("Sign in to Ensemble first."), { statusCode: 401 });
}

export function placeSession(request: FastifyRequest): string {
  if (request.authVia !== "session") throw Object.assign(new Error("Open places need a browser sign-in."), { statusCode: 403 });
  return sha256(readCookie(request, SESSION_COOKIE) ?? "");
}

export function placeLabel(agent: string): string {
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const computer = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Macintosh|Mac OS/.test(agent) ? "Mac" : /Linux/.test(agent) ? "Linux" : "this computer";
  return `${browser} on ${computer}`;
}

export async function activePlaces(db: Db, userId: string, now = new Date()) {
  return db.activePlace.findMany({
    where: { userId, released: false, revoked: false, lastSeen: { gt: new Date(now.getTime() - PLACE_LEASE_MS) }, session: { expiresAt: { gt: now } } },
    orderBy: [{ lastSeen: "asc" }, { windowId: "asc" }],
    select: { windowId: true, surface: true, label: true, lastSeen: true },
  });
}

export async function heartbeatPlace(db: PrismaClient, request: FastifyRequest, input: z.infer<typeof PlaceInput>, replace?: string | "oldest") {
  const userId = accountIdOf(request);
  const sessionId = placeSession(request);
  if (input.accountId && input.accountId !== userId) return { allowed: false, code: "PLACE_ACCOUNT_CHANGED", accountId: userId, places: [] };
  return db.$transaction(async (tx) => {
    await lockUserTransaction(tx, userId);
    await lockPlaceSession(tx, userId, sessionId);
    const now = new Date();
    const key = { userId, windowId: input.id };
    const existing = await tx.activePlace.findUnique({ where: { userId_windowId: key } });
    const places = await activePlaces(tx, userId, now);
    const held = places.some((place) => place.windowId === input.id);
    if (existing && input.seq <= existing.seq) {
      return { allowed: held, code: existing.revoked ? "PLACE_REPLACED" : "PLACE_EXPIRED", places };
    }
    if (replace !== undefined) {
      const target = replace === "oldest" ? places.find((place) => place.windowId !== input.id)?.windowId : replace;
      if (target && target !== input.id) {
        await tx.activePlace.updateMany({ where: { userId, windowId: target, revoked: false }, data: { revoked: true } });
      }
    } else if (existing?.revoked) {
      return { allowed: false, code: "PLACE_REPLACED", places };
    }
    const others = (await activePlaces(tx, userId, now)).filter((place) => place.windowId !== input.id);
    if (others.length >= PLACE_LIMIT) return { allowed: false, code: "PLACE_LIMIT", places: others };
    const label = placeLabel(String(request.headers["user-agent"] ?? ""));
    const data = { sessionId, surface: input.surface, label, lastSeen: now, seq: input.seq, released: false, revoked: false };
    await tx.activePlace.upsert({ where: { userId_windowId: key }, create: { ...key, ...data }, update: data });
    return { allowed: true, places: await activePlaces(tx, userId, now) };
  });
}

export async function releasePlace(db: PrismaClient, request: FastifyRequest, input: z.infer<typeof PlaceInput>) {
  const userId = accountIdOf(request);
  const sessionId = placeSession(request);
  if (input.accountId && input.accountId !== userId) throw Object.assign(new Error("Your account changed. Open Ensemble again."), { statusCode: 409, code: "PLACE_ACCOUNT_CHANGED" });
  // Keep the sequence so a delayed heartbeat cannot bring a closed tab back.
  await db.$transaction(async (tx) => {
    await lockUserTransaction(tx, userId);
    await lockPlaceSession(tx, userId, sessionId);
    const key = { userId, windowId: input.id };
    const current = await tx.activePlace.findUnique({ where: { userId_windowId: key } });
    if (current && current.seq >= input.seq) return;
    await tx.activePlace.upsert({
      where: { userId_windowId: key },
      create: { ...key, sessionId, seq: input.seq, surface: input.surface, label: placeLabel(String(request.headers["user-agent"] ?? "")), lastSeen: new Date(), released: true },
      update: { released: true, seq: input.seq, sessionId },
    });
  });
}

export async function checkPlace(db: PrismaClient, request: FastifyRequest) {
  const id = request.headers[PLACE_HEADER];
  if (request.authVia !== "session" || id === undefined) return null;
  const userId = accountIdOf(request);
  const place = typeof id === "string" && z.string().uuid().safeParse(id).success
    ? await db.activePlace.findUnique({ where: { userId_windowId: { userId, windowId: id } } })
    : null;
  if (place && !place.revoked && !place.released && place.lastSeen.getTime() > Date.now() - PLACE_LEASE_MS) return null;
  return { error: "Choose an open place to continue here.", code: place?.revoked ? "PLACE_REPLACED" : "PLACE_EXPIRED", places: await activePlaces(db, userId) };
}

export function checkPlaceAccount(request: FastifyRequest) {
  const expected = request.headers[PLACE_ACCOUNT_HEADER];
  if (request.authVia === "session" && expected !== undefined && expected !== accountIdOf(request)) {
    return { error: "Your account changed. Open Ensemble again.", code: "PLACE_ACCOUNT_CHANGED", places: [] };
  }
  return null;
}
