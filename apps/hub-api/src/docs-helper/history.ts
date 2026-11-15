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
    async chats(userId: string, before?: string) {
      if (before && !await db.docsChatTurn.findFirst({ where: { userId, chatId: before }, select: { id: true } })) throw Object.assign(new Error("Chat not found."), { statusCode: 404 });
      const rows = await db.$queryRaw<{ id: string; title: string; updatedAt: Date }[]>`
        WITH chats AS (
          SELECT chat_id, MAX(created_at) AS updated_at FROM docs_chat_turns WHERE user_id = ${userId} GROUP BY chat_id
        )
        SELECT c.chat_id AS id, c.updated_at AS "updatedAt",
          (SELECT LEFT(t.question, 120) FROM docs_chat_turns t WHERE t.user_id = ${userId} AND t.chat_id = c.chat_id ORDER BY t.created_at, t.id LIMIT 1) AS title
        FROM chats c
        WHERE ${before ?? null}::text IS NULL OR (c.updated_at, c.chat_id) < (SELECT updated_at, chat_id FROM chats WHERE chat_id = ${before ?? null})
        ORDER BY c.updated_at DESC, c.chat_id DESC LIMIT 31`;
      return { chats: rows.slice(0, 30), before: rows.length > 30 ? rows[29]!.id : null };
    },
    async list(userId: string, before?: string, requestedChat?: string) {
      const latest = !requestedChat ? await db.docsChatTurn.findFirst({ where: { userId, ...(before ? { id: before } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { chatId: true } }) : null;
      const chatId = requestedChat ?? latest?.chatId ?? "legacy";
      const cursor = before ? await db.docsChatTurn.findFirst({ where: { id: before, userId, chatId }, select: { id: true, createdAt: true } }) : null;
      if (before && !cursor) throw Object.assign(new Error("History item not found."), { statusCode: 404 });
      const rows = await db.docsChatTurn.findMany({
        where: { userId, chatId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 31,
        select: { id: true, question: true, answer: true, found: true, sources: true, createdAt: true },
      });
      const more = rows.length > 30;
      const page = rows.slice(0, 30);
      return { chatId, turns: page.reverse(), before: more ? page[0]!.id : null };
    },
    async save(who: DocsIdentity, generation: string, question: string, result: HelperAnswer, chatId = "legacy") {
      return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ generation: string }[]>`SELECT generation FROM docs_chats WHERE user_id = ${who.id} FOR UPDATE`;
        if (rows[0]?.generation !== generation || !await tx.session.findFirst({ where: { id: who.sessionId, userId: who.id, expiresAt: { gt: new Date() } }, select: { id: true } })) return null;
        return tx.docsChatTurn.create({ data: { userId: who.id, chatId, question, ...result, sources: result.sources as Prisma.InputJsonValue }, select: { id: true, question: true, answer: true, found: true, sources: true, createdAt: true } });
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
