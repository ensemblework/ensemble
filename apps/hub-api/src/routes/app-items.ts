/**
 * Items in connected apps: search and read them, attach them to a task or
 * project as context, turn one into a task, add an app's people, and post an
 * update back on a task's linked issue. Docs: docs/31_CONNECTORS_IN_USE.md, API rows in docs/02.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppItemKind } from "@ensemble/shared-types";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";
import {
  attachedItems,
  attachItem,
  connectedItemSources,
  detachItem,
  importPeople,
  postUpdate,
  readItem,
  refreshAttached,
  searchItems,
  taskFromItem,
  updateTargetFor,
} from "../connectors/items/index.js";

const KINDS = [
  "page",
  "database",
  "repo",
  "issue",
  "pull_request",
  "board",
  "card",
  "project",
  "task",
  "file",
  "channel",
  "person",
  "ticket",
  "conversation",
  "contact",
  "company",
  "deal",
  "design",
  "deployment",
  "dashboard",
  "work_item",
  "invoice",
  "record",
  "meeting",
  "video",
  "attachment",
] as const satisfies readonly AppItemKind[];

const Kind = z.enum(KINDS);
const SourceId = z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/);
const ItemRef = z.object({ source: SourceId, kind: Kind, id: z.string().trim().min(1).max(300) });
const Uuid = z.string().uuid();

const limiter = new MemoryRateLimiter();
const LIMITS = {
  search: { limit: 120, windowMs: 10 * 60_000, error: "Too many searches. Wait a minute and try again." },
  write: { limit: 60, windowMs: 10 * 60_000, error: "Too many changes in a row. Wait a minute and try again." },
  people: { limit: 10, windowMs: 60 * 60_000, error: "People can be added from an app a few times an hour. Try again later." },
} as const;

function overLimit(request: FastifyRequest, reply: FastifyReply, bucket: keyof typeof LIMITS): boolean {
  const rule = LIMITS[bucket];
  const wait = limiter.take(`app-items-${bucket}:${request.userId}`, rule.limit, rule.windowMs);
  if (wait === null) return false;
  reply.header("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
  void reply.code(429).send({ error: rule.error });
  return true;
}

export async function appItemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/app-items/sources", async (request) => {
    await requireVerifiedUser(request.userId);
    return { sources: await connectedItemSources(request.userId, app.prisma) };
  });

  app.get("/api/app-items/search", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const query = z
      .object({ source: SourceId.optional(), q: z.string().max(300).default(""), kind: Kind.optional(), limit: z.coerce.number().int().min(1).max(25).optional() })
      .parse(request.query);
    if (overLimit(request, reply, "search")) return reply;
    return searchItems(request.userId, query);
  });

  app.post("/api/app-items/read", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const ref = ItemRef.parse(request.body ?? {});
    if (overLimit(request, reply, "search")) return reply;
    return { item: await readItem(request.userId, ref) };
  });

  app.get("/api/app-items/attached", async (request) => {
    await requireVerifiedUser(request.userId);
    const query = z
      .object({ taskId: Uuid.optional(), projectId: Uuid.optional() })
      .refine((value) => value.taskId || value.projectId, { message: "Send taskId or projectId." })
      .parse(request.query);
    return { items: await attachedItems(request.userId, query, app.prisma) };
  });

  app.post("/api/app-items/attach", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const body = ItemRef.extend({ taskId: Uuid.optional(), projectId: Uuid.optional() })
      .refine((value) => value.taskId || value.projectId, { message: "Send taskId or projectId." })
      .parse(request.body ?? {});
    if (overLimit(request, reply, "write")) return reply;
    return { item: await attachItem(request.userId, body, app.prisma) };
  });

  app.post("/api/app-items/attached/:artifactId/refresh", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { artifactId } = z.object({ artifactId: Uuid }).parse(request.params);
    if (overLimit(request, reply, "write")) return reply;
    return { item: await refreshAttached(request.userId, artifactId, app.prisma) };
  });

  app.delete("/api/app-items/attached/:artifactId", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { artifactId } = z.object({ artifactId: Uuid }).parse(request.params);
    const from = z.object({ taskId: Uuid.optional(), projectId: Uuid.optional() }).parse(request.query);
    await detachItem(request.userId, artifactId, from, app.prisma);
    return reply.code(204).send();
  });

  app.post("/api/app-items/task", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const body = ItemRef.extend({ projectId: Uuid.optional() }).parse(request.body ?? {});
    if (overLimit(request, reply, "write")) return reply;
    return taskFromItem(request.userId, body, app.prisma);
  });

  app.post("/api/app-items/people", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { source } = z.object({ source: SourceId }).parse(request.body ?? {});
    if (overLimit(request, reply, "people")) return reply;
    return importPeople(request.userId, source, app.prisma);
  });

  app.get("/api/app-items/update-target", async (request) => {
    await requireVerifiedUser(request.userId);
    const { taskId } = z.object({ taskId: Uuid }).parse(request.query);
    return { target: await updateTargetFor(request.userId, taskId, app.prisma) };
  });

  app.post("/api/app-items/update", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const body = z.object({ taskId: Uuid, body: z.string().trim().min(1).max(20_000) }).parse(request.body ?? {});
    if (overLimit(request, reply, "write")) return reply;
    return postUpdate(request.userId, body.taskId, body.body, app.prisma);
  });
}
