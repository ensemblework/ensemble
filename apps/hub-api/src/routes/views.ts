/**
 * Aggregates for the shell and Today.
 *
 * The individual routes stay. These exist so the first paint is one round trip
 * instead of a fan of them. Nothing here is cached on the server.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { connectionState, listConnectors } from "../connectors/base.js";
import { templateById } from "@ensemble/shared-types/templates";
import { templateByMarketId } from "@ensemble/shared-types/marketplace";
import { envDevTools } from "../lib/dev-tools.js";
import { loadSettings } from "../lib/settings.js";
import { serializeTask } from "./tasks.js";

async function countOrZero(query: Promise<number>): Promise<number> {
  try {
    return await query;
  } catch {
    return 0;
  }
}

export async function viewRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/shell", async (request, reply) => {
    const userId = request.userId;
    const [user, approvals, decisions, settings, sync, undoable, redoable] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      countOrZero(prisma.approval.count({ where: { userId, decision: null } })),
      countOrZero(prisma.agentDecision.count({ where: { userId, status: "pending" } })),
      loadSettings(prisma, userId),
      prisma.syncState.findMany({ where: { userId } }),
      countOrZero(prisma.undoEntry.count({ where: { userId, undoneAt: null } })),
      countOrZero(prisma.undoEntry.count({ where: { userId, undoneAt: { not: null } } })),
    ]);
    if (!user?.passwordHash && request.authVia !== "bypass") return reply.code(401).send({ error: "Sign in." });
    const flags = await Promise.all(
      listConnectors().map(async (connector) => {
        const status = await connectionState(userId, connector);
        const enabled = connector.connect === "builtin" || (settings.connections[connector.id]?.enabled ?? false);
        const state = sync.find((row) => row.connector === connector.id);
        return (
          enabled &&
          connector.connect !== "builtin" &&
          connector.connect !== "later" &&
          (!status.configured || Boolean(state?.lastError))
        );
      }),
    );
    return {
      user: user?.passwordHash
        ? { id: user.id, email: user.email, name: user.name }
        : { id: userId, email: "", name: "Local (no account)" },
      via: request.authVia,
      approvals,
      decisions,
      attention: flags.filter(Boolean).length,
      canUndo: undoable > 0,
      canRedo: redoable > 0,
      onboardingComplete: request.authVia === "bypass" || Boolean(user?.onboardingCompletedAt),
      highlights: user?.onboardingTemplateId ? [...(templateById(user.onboardingTemplateId)?.highlights ?? [])] : [],
      modules: request.modules,
      labels: user?.chromeLabels && typeof user.chromeLabels === "object" ? user.chromeLabels : {},
      activeTemplateId: user?.activeTemplateId ?? null,
      templateName:
        user?.activeTemplateId === "default"
          ? "Default"
          : user?.activeTemplateId
            ? (templateByMarketId(user.activeTemplateId)?.name ?? null)
            : null,
      seasonEnded:
        user?.templateExpiresAt && user.templateExpiresAt.getTime() < Date.now() && user.activeTemplateId && user.activeTemplateId !== "default"
          ? { id: user.activeTemplateId, name: templateByMarketId(user.activeTemplateId)?.name ?? "This template" }
          : null,
      devTools: envDevTools() || Boolean(user?.tester),
      pageWidth: settings.pageWidth,
    };
  });

  app.get("/api/today/home", async (request) => {
    const query = z.object({ from: z.string(), to: z.string() }).parse(request.query);
    const userId = request.userId;
    const [tasks, deliverables, reminders, events, sync, settings] = await Promise.all([
      prisma.task.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      }),
      prisma.deliverable.findMany({
        where: { userId, deletedAt: null, status: "upcoming" },
        orderBy: [{ status: "asc" }, { due: "asc" }, { createdAt: "asc" }],
        include: { project: { select: { id: true, name: true } } },
      }),
      prisma.reminder.findMany({
        where: { userId, deletedAt: null, dismissedAt: null },
        orderBy: [{ dueDate: "asc" }, { dueTime: "asc" }],
        select: { id: true, title: true, dueDate: true, dueTime: true, timeZone: true },
      }),
      prisma.artifact.findMany({
        where: {
          userId,
          kind: "event",
          deletedAt: null,
          ts: { gte: new Date(query.from), lt: new Date(query.to) },
        },
        orderBy: { ts: "asc" },
        select: { id: true, title: true, ts: true, url: true, metadata: true },
      }),
      prisma.syncState.findMany({
        where: { userId, connector: { in: ["google_calendar", "outlook_calendar"] } },
      }),
      loadSettings(prisma, userId),
    ]);
    return {
      tasks: tasks.map(serializeTask),
      deliverables,
      reminders,
      events: events.map((event) => {
        const meta = (event.metadata ?? {}) as { end?: string; allDay?: boolean; joinUrl?: string; location?: string };
        return {
          id: event.id,
          title: event.title,
          start: event.ts.toISOString(),
          end: meta.end ?? null,
          allDay: Boolean(meta.allDay),
          joinUrl: meta.joinUrl ?? event.url ?? null,
          location: meta.location ?? null,
        };
      }),
      sync: sync.map((row) => ({
        connector: row.connector,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        lastError: row.lastError,
      })),
      timezone: settings.timezone,
    };
  });
}
