import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { readCookie, SESSION_COOKIE, sha256 } from "../lib/auth.js";
import type { HelperAnswer } from "./answer.js";

export type DocsIdentity = { id: string; name: string; sessionId: string };

/** Deliberately does not resolve spaces, API keys, shares, active places or workspace data. */
export async function docsIdentity(db: PrismaClient, request: FastifyRequest): Promise<DocsIdentity | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const session = await db.session.findFirst({ where: { id: sha256(cookie), expiresAt: { gt: new Date() }, user: { ownerId: null } }, select: { id: true, user: { select: { id: true, name: true } } } });
  return session ? { ...session.user, sessionId: session.id } : null;
}

export function docsHistory(db: PrismaClient) {
  return {
    async begin(userId: string) {
      return (await db.docsChat.upsert({ where: { userId }, create: { userId }, update: { userId }, select: { generation: true } })).generation;
    },
    async list(userId: string, before?: string) {
      const cursor = before ? await db.docsChatTurn.findFirst({ where: { id: before, userId }, select: { id: true, createdAt: true } }) : null;
      if (before && !cursor) throw Object.assign(new Error("History item not found."), { statusCode: 404 });
      const rows = await db.docsChatTurn.findMany({
        where: { userId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 31,
        select: { id: true, question: true, answer: true, found: true, sources: true, createdAt: true },
      });
      const more = rows.length > 30;
      const page = rows.slice(0, 30);
      return { turns: page.reverse(), before: more ? page[0]!.id : null };
    },
    async save(who: DocsIdentity, generation: string, question: string, result: HelperAnswer) {
      return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ generation: string }[]>`SELECT generation FROM docs_chats WHERE user_id = ${who.id} FOR UPDATE`;
        if (rows[0]?.generation !== generation || !await tx.session.findFirst({ where: { id: who.sessionId, userId: who.id, expiresAt: { gt: new Date() } }, select: { id: true } })) return null;
        return tx.docsChatTurn.create({ data: { userId: who.id, question, ...result, sources: result.sources as Prisma.InputJsonValue }, select: { id: true, question: true, answer: true, found: true, sources: true, createdAt: true } });
      });
    },
    async clear(userId: string) {
      await db.$transaction(async (tx) => {
        await tx.docsChat.upsert({ where: { userId }, create: { userId }, update: { generation: randomUUID() } });
        await tx.docsChatTurn.deleteMany({ where: { userId } });
      });
    },
  };
}
