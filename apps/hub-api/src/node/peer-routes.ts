/**
 * Routes for rooms with other people (docs/35 §12): each person's own settings for a room (trust,
 * away, shareable items), status cards, the room's shared space, peer requests, and Share to room. Registered from
 * node/routes.ts with `registerPeerRoutes(app)`. Every route acts for the signed-in account and only
 * for a room it is a person in; a person changes only their own settings.
 */
import type { FastifyInstance } from "fastify";
import type { NodeRoom, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { truncateText } from "../lib/text.js";
import { wireMessage } from "./store.js";
import { nodeAccount } from "./routes.js";
import { acceptRequest, cancelRequest, createPeerRequest, declineRequest, NewRequest, shareMessage, watchPeerMissions, wireRequest } from "./peer-requests.js";
import { answerSpaceOffer, bindSpace, roomBoard, RoomSpaceError, spaceView, unbindSpace } from "./room-space.js";
import { statusCard, statusCards } from "./status-cards.js";
import { personRow, prefsOf, SHAREABLE_KINDS, shareableItem, TrustPatch, trustView, updatePrefs } from "./trust.js";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The room, if it has other people in it and this account is one of its people. */
async function peopleRoom(prisma: PrismaClient, accountId: string, id: string): Promise<NodeRoom> {
  const room = await prisma.nodeRoom.findUnique({ where: { id } });
  if (!room || room.archivedAt || !(await personRow(prisma, id, accountId))) throw fail(404, "That room is not available.");
  if (room.kind !== "room") throw fail(400, "This is for rooms with other people.");
  return room;
}

export async function registerPeerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  // Missions made for a request settle its card when they end.
  watchPeerMissions(app);

  const me = async (roomId: string, accountId: string) => {
    const row = await personRow(prisma, roomId, accountId);
    if (!row) throw fail(404, "That room is not available.");
    return row;
  };

  // ── trust: what my lead may do for each person here without asking ───────────────────────

  app.get("/api/node/rooms/:id/trust", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { trust: await trustView(prisma, room.id, await me(room.id, accountId)) };
  });

  app.put("/api/node/rooms/:id/trust", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z
      .object({
        everyone: TrustPatch.optional(),
        people: z.record(z.string().uuid(), TrustPatch.nullable()).optional(),
        budget: z.number().min(0).max(10_000_000).nullable().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const others = new Set((await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, nodeId: null, userId: { not: accountId } }, select: { userId: true } })).map((row) => row.userId));
    for (const id of Object.keys(body.people ?? {})) if (!others.has(id)) throw fail(400, "Settings are for people in this room.");
    const row = await me(room.id, accountId);
    await updatePrefs(prisma, row.id, (prefs) => {
      const people = { ...(prefs.trust?.people ?? {}) };
      for (const [id, patch] of Object.entries(body.people ?? {})) {
        if (patch === null) delete people[id];
        else people[id] = { ...(people[id] ?? {}), ...patch };
      }
      return {
        ...prefs,
        trust: { everyone: { ...(prefs.trust?.everyone ?? {}), ...(body.everyone ?? {}) }, people },
        ...(body.budget !== undefined ? { budget: body.budget } : {}),
      };
    });
    return { trust: await trustView(prisma, room.id, await me(room.id, accountId)) };
  });

  // ── status cards and away ─────────────────────────────────────────────────────────────────

  /** Every person's status card, as I may see it (my own in full). */
  app.get("/api/node/rooms/:id/status", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { cards: await statusCards(prisma, room, { viewerId: accountId }) };
  });

  /** I am away (until a time, with a note), or back. My lead says so and leaves work requests for me. */
  app.put("/api/node/rooms/:id/status", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z
      .object({ away: z.boolean(), until: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().max(200).nullable().optional() })
      .strict()
      .parse(request.body ?? {});
    if (body.away && body.until && Date.parse(body.until) <= Date.now()) throw fail(400, "Pick a time that is still to come.");
    const row = await me(room.id, accountId);
    await updatePrefs(prisma, row.id, (prefs) => ({
      ...prefs,
      away: body.away ? { since: new Date().toISOString(), until: body.until ? new Date(body.until).toISOString() : null, note: body.note?.trim() ? truncateText(body.note.trim(), 200) : null } : null,
    }));
    return { card: await statusCard(prisma, room, accountId, { viewerId: accountId }) };
  });

  // ── items I marked shareable in this room ─────────────────────────────────────────────────

  app.get("/api/node/rooms/:id/shareable", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { items: prefsOf(await me(room.id, accountId)).shareable ?? [] };
  });

  /** Marks one of my pages, tasks or files shareable in this room (my lead may then quote it here), or takes it back. */
  app.put("/api/node/rooms/:id/shareable", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z
      .object({ kind: z.enum(SHAREABLE_KINDS), id: z.string().uuid(), spaceId: z.string().uuid().optional(), shared: z.boolean() })
      .strict()
      .parse(request.body ?? {});
    const row = await me(room.id, accountId);
    const item = body.shared ? await shareableItem(prisma, accountId, body) : null;
    if (body.shared && !item) throw fail(404, "That item is not available to you.");
    const prefs = await updatePrefs(prisma, row.id, (current) => {
      const rest = (current.shareable ?? []).filter((entry) => !(entry.kind === body.kind && entry.id === body.id));
      return { ...current, shareable: item ? [...rest, { ...item, addedAt: new Date().toISOString() }] : rest };
    });
    return { items: prefs.shareable ?? [] };
  });

  // ── the room's shared space (docs/35 §12.11) ──────────────────────────────────────────────

  const spaceCall = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RoomSpaceError) throw fail(error.statusCode, error.message);
      throw error;
    }
  };

  /** Which space holds the room's work, my role there, and my membership offer. */
  app.get("/api/node/rooms/:id/space", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return spaceView(app, room, accountId);
  });

  /** The space's board, for the room's Board tab: only for its owner and members. */
  app.get("/api/node/rooms/:id/board", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return roomBoard(app, room, accountId);
  });

  /** The room's creator links a space they own (`spaceId`), or makes one for the room (`create`). */
  app.put("/api/node/rooms/:id/space", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z
      .union([z.object({ spaceId: z.string().uuid() }).strict(), z.object({ create: z.literal(true), name: z.string().trim().min(1).max(60).optional() }).strict()])
      .parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    await spaceCall(() => bindSpace(app, room, accountId, body));
    return spaceView(app, await prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } }), accountId);
  });

  app.delete("/api/node/rooms/:id/space", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    await spaceCall(() => unbindSpace(app, room, accountId));
    return { ok: true };
  });

  /** I take, or leave, the offer to join the room's space as an editor (separate from joining the room). */
  app.post("/api/node/rooms/:id/space/join", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ join: z.boolean().default(true) }).strict().parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    await spaceCall(() => answerSpaceOffer(app, room, accountId, body.join));
    return spaceView(app, room, accountId);
  });

  // ── peer requests ─────────────────────────────────────────────────────────────────────────

  app.get("/api/node/rooms/:id/requests", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const joined = (await me(room.id, accountId)).joinedAt;
    const rows = await prisma.nodePeerRequest.findMany({ where: { roomId: room.id, createdAt: { gte: joined } }, orderBy: { createdAt: "desc" }, take: 100 });
    return { requests: await Promise.all(rows.map((row) => wireRequest(prisma, row, accountId))) };
  });

  /** A question, share, review or work request to another person here, through their lead. */
  app.post("/api/node/rooms/:id/requests", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = NewRequest.parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    const made = await createPeerRequest(app, { room, fromAccountId: accountId, ...body });
    return reply.code(201).send({ request: await wireRequest(prisma, made, accountId) });
  });

  // `mode` answers the one question of a proposed task in the room's space: private work with a shared result (default) or a shared run.
  const Accept = z.object({ text: z.string().trim().min(1).max(4000).optional(), always: z.boolean().optional(), mode: z.enum(["private", "shared"]).optional() }).strict();
  app.post("/api/node/requests/:id/accept", async (request) => {
    const accountId = nodeAccount(request);
    const body = Accept.parse(request.body ?? {});
    const done = await acceptRequest(app, accountId, (request.params as { id: string }).id, body);
    return { request: await wireRequest(prisma, done, accountId) };
  });

  app.post("/api/node/requests/:id/decline", async (request) => {
    const accountId = nodeAccount(request);
    const body = z.object({ note: z.string().max(1000).optional() }).strict().parse(request.body ?? {});
    const done = await declineRequest(app, accountId, (request.params as { id: string }).id, body);
    return { request: await wireRequest(prisma, done, accountId) };
  });

  app.post("/api/node/requests/:id/cancel", async (request) => {
    const accountId = nodeAccount(request);
    const done = await cancelRequest(app, accountId, (request.params as { id: string }).id);
    return { request: await wireRequest(prisma, done, accountId) };
  });

  // ── share to room ─────────────────────────────────────────────────────────────────────────

  /** Publishes one of my private messages, or my own node's private reply, in the room: as me, or through my lead. */
  app.post("/api/node/messages/:id/share", async (request, reply) => {
    const accountId = nodeAccount(request);
    const body = z.object({ as: z.enum(["me", "lead"]).default("me") }).strict().parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    const message = await shareMessage(app, accountId, (request.params as { id: string }).id, body.as);
    return reply.code(201).send({ message: wireMessage(message) });
  });
}
