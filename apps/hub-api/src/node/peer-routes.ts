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
import { answerSpaceOffer, bindSpace, expireOffersFor, roomBoard, roomPages, RoomSpaceError, spaceView, unbindSpace, watchPage } from "./room-space.js";
import { onMemberRevoked } from "../sharing/revoke.js";
import { cameBack, watchRoomEvents } from "./room-events.js";
import { RoomResultError, startRoomTask } from "./room-results.js";
import { PAGE_ROLES, roomDecisions, setPageRole, watchRoomPages } from "./room-pages.js";
import { clearSteward, setSteward, stewardOf } from "./steward.js";
import { publishTo } from "./events.js";
import { inBackground } from "./queue.js";
import { roomPeople } from "./store.js";
import { presenceChanged, statusCard, statusCards } from "./status-cards.js";
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
  // What concerns each person reaches them once, through their lead (node/room-events.ts).
  watchRoomEvents(app);
  // Losing a space withdraws a person's open offers to join it through a room (node/room-space.ts).
  onMemberRevoked(expireOffersFor);
  // Contracts tell the people whose work uses them when they change (node/room-pages.ts).
  watchRoomPages();

  const spaceCall = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RoomSpaceError) throw fail(error.statusCode, error.message);
      throw error;
    }
  };

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
    const wasAway = prefsOf(row).away;
    await updatePrefs(prisma, row.id, (prefs) => ({
      ...prefs,
      // Away again while away keeps when it began: the catch-up covers the whole time.
      away: body.away ? { since: prefs.away?.since ?? new Date().toISOString(), until: body.until ? new Date(body.until).toISOString() : null, note: body.note?.trim() ? truncateText(body.note.trim(), 200) : null } : null,
    }));
    // Back: their lead catches them up on what happened meanwhile.
    if (wasAway && !body.away) inBackground(app, () => cameBack(app, room, accountId, wasAway.since));
    publishTo(await roomPeople(prisma, room.id), "node.cards", { roomId: room.id });
    await presenceChanged(prisma, accountId, room.id);
    return { card: await statusCard(prisma, room, accountId, { viewerId: accountId }) };
  });

  // ── my preferences for this room, and starting my tasks (docs/35 §12.13) ─────────────────

  app.get("/api/node/rooms/:id/prefs", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { prefs: { closeTasks: prefsOf(await me(room.id, accountId)).closeTasks } };
  });

  /** `closeTasks`: a delivered result moves my task to Done (`auto`), or I close it myself (`me`). */
  app.put("/api/node/rooms/:id/prefs", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const body = z.object({ closeTasks: z.enum(["auto", "me"]).optional() }).strict().parse(request.body ?? {});
    const row = await me(room.id, accountId);
    const prefs = await updatePrefs(prisma, row.id, (current) => ({ ...current, ...(body.closeTasks ? { closeTasks: body.closeTasks } : {}) }));
    return { prefs: { closeTasks: prefs.closeTasks ?? "auto" } };
  });

  /** I start one of my tasks on the room's board: my lead plans it in My crew; its result goes to the task and the room. */
  app.post("/api/node/rooms/:id/tasks/:taskId/start", async (request, reply) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const { mode } = z.object({ mode: z.enum(["private", "shared"]).default("private") }).strict().parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    try {
      await startRoomTask(app, room, accountId, z.string().uuid().parse((request.params as { taskId: string }).taskId), mode);
    } catch (error) {
      if (error instanceof RoomResultError) throw fail(error.statusCode, error.message);
      throw error;
    }
    return reply.code(202).send({ started: true });
  });

  // ── pages of the room's space I watch (docs/35 §12.12) ────────────────────────────────────

  app.get("/api/node/rooms/:id/pages", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { pages: await roomPages(app, room, accountId) };
  });

  /** A page of the room's space becomes a contract or the room's decisions log (or only watched again). */
  app.put("/api/node/rooms/:id/pages/:pageId", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const { role } = z.object({ role: z.enum(PAGE_ROLES) }).strict().parse(request.body ?? {});
    await spaceCall(() => setPageRole(app, room, accountId, z.string().uuid().parse((request.params as { pageId: string }).pageId), role));
    return { pages: await roomPages(app, room, accountId) };
  });

  /** The room's logged decisions, newest first (each with the one it replaced). */
  app.get("/api/node/rooms/:id/decisions", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { decisions: await roomDecisions(app, room, accountId) };
  });

  // ── the room's steward (docs/35 §12.14) ───────────────────────────────────────────────────

  app.get("/api/node/rooms/:id/steward", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    return { steward: stewardOf(room) };
  });

  /** I make one of my own nodes here (not my lead) the room's steward, and sponsor it. */
  app.put("/api/node/rooms/:id/steward", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const { nodeId } = z.object({ nodeId: z.string().uuid() }).strict().parse(request.body ?? {});
    await requireVerifiedUser(accountId);
    return { steward: await spaceCall(() => setSteward(app, room, accountId, nodeId)) };
  });

  app.delete("/api/node/rooms/:id/steward", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    await spaceCall(() => clearSteward(app, room, accountId));
    return { steward: null };
  });

  /** I watch a page of the room's linked space (its edits reach me through my lead), or stop. */
  app.put("/api/node/rooms/:id/pages/:pageId/watch", async (request) => {
    const accountId = nodeAccount(request);
    const room = await peopleRoom(prisma, accountId, (request.params as { id: string }).id);
    const { watching } = z.object({ watching: z.boolean() }).strict().parse(request.body ?? {});
    await spaceCall(() => watchPage(app, room, accountId, z.string().uuid().parse((request.params as { pageId: string }).pageId), watching));
    return { pages: await roomPages(app, room, accountId) };
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
