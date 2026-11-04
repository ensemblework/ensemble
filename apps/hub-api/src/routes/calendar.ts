/**
 * The Today calendar (docs/03 §2.4): the merged events of every calendar that
 * feeds it, a Sync for all of them, and calendar links (ICS subscriptions).
 * Owner-only: a space's calendar is never shown to its guests.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { addFeed, CalendarFeedError, feedView, removeFeed, renameFeed } from "../calendar/feeds.js";
import { readCalendar } from "../calendar/read.js";
import { calendarWindow, regroupCalendar, syncCalendars } from "../calendar/sync.js";

const DateInput = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), "Use a valid date.");

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/calendar", async (request) => {
    const query = z
      .object({ from: DateInput, to: DateInput, tz: z.string().max(64).optional() })
      .refine((value) => new Date(value.from) < new Date(value.to), { message: "from must be before to." })
      .parse(request.query);
    return readCalendar(prisma, request.userId, { from: new Date(query.from), to: new Date(query.to), timeZone: query.tz ?? null });
  });

  app.post("/api/calendar/sync", async (request) => syncCalendars(app, request.userId, "button"));

  app.get("/api/calendar/feeds", async (request) => {
    const rows = await prisma.calendarFeed.findMany({ where: { userId: request.userId }, orderBy: { createdAt: "asc" } });
    return { feeds: rows.map(feedView) };
  });

  app.post("/api/calendar/feeds", async (request, reply) => {
    const body = z.object({ url: z.string().min(1).max(2048), name: z.string().max(80).nullish() }).parse(request.body);
    await requireVerifiedUser(request.userId);
    const settings = await loadSettings(prisma, request.userId);
    try {
      const { feed } = await addFeed(prisma, request.userId, body, settings.timezone);
      await appendLedger({ userId: request.userId, actor: "me", action: "calendar.feed.add", payload: { id: feed.id, host: feed.host } });
      const synced = await syncCalendars(app, request.userId, "feed", { feedId: feed.id });
      const outcome = synced.outcomes.find((row) => row.id === feed.id);
      const fresh = await prisma.calendarFeed.findUniqueOrThrow({ where: { id: feed.id } });
      return reply.code(201).send({ feed: feedView(fresh), events: outcome?.items ?? 0, ...(outcome && !outcome.ok ? { warning: outcome.message } : {}) });
    } catch (error) {
      if (error instanceof CalendarFeedError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/api/calendar/feeds/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const feed = await renameFeed(prisma, request.userId, id, body.name);
    if (!feed) return reply.code(404).send({ error: "Calendar link not found." });
    return { feed };
  });

  app.delete("/api/calendar/feeds/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await removeFeed(prisma, request.userId, id))) return reply.code(404).send({ error: "Calendar link not found." });
    const settings = await loadSettings(prisma, request.userId);
    await regroupCalendar(prisma, request.userId, calendarWindow(), settings.timezone);
    await appendLedger({ userId: request.userId, actor: "me", action: "calendar.feed.remove", payload: { id } });
    sseHub.publish(request.userId, { event: "sync", data: { calendar: [{ connector: "ics_calendar", ok: true }] } });
    return reply.code(204).send();
  });
}
