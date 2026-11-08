import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { bridgeAuthRejected } from "./auth.js";
import { DATA_GAPS } from "./gaps.js";
import { nodeOverview } from "../node/routes.js";
import { fileFor, overviewFor } from "../repo/locate.js";
import { RepoReadError } from "../repo/read.js";
import { GraphError } from "../context/graph/neighbors.js";
import { GRAPH_KINDS, parseItemRef } from "../context/graph/refs.js";
import { SEARCH_KINDS, type SearchKind } from "../context/graph/search.js";
import {
  buildBrief,
  itemContext,
  itemPacket,
  READ_KIND_LIST,
  readKindOf,
  listDecisions,
  listDiagrams,
  listPlots,
  listDeliverables,
  listMeetings,
  listPeople,
  listProjects,
  listRepos,
  listSkills,
  listTasks,
  readItem,
  searchHub,
  todayBriefing,
} from "./service.js";

const Status = z.enum(["proposed", "todo", "in_progress", "waiting_approval", "blocked", "done", "dropped"]);

const listLimit = z.coerce.number().int().min(1).max(50).default(20);
const briefLimit = z.coerce.number().int().min(1).max(20).default(8);

/**
 * Read surface for the Context Bridge. Every route here is GET; the process-wide guard
 * (`bridgeMethodRejected`, app.ts) rejects other methods outside /api/bridge/write/
 * (write-routes.ts). There is no Prisma client in the bridge process; this is the only way it reads.
 */
export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.addHook("preHandler", async (request, reply) => {
    const message = bridgeAuthRejected(request.authVia, env.ENSEMBLE_INTERNAL_TOKEN);
    if (message) return reply.code(401).send({ error: message });
  });

  app.get("/api/bridge/gaps", async () => ({
    gaps: DATA_GAPS,
    reads: [
      "tasks",
      "projects",
      "repos",
      "skills",
      "deliverables",
      "meetings (calendar artifacts)",
      "people",
      "decisions (Needs me)",
      "today",
      "context (one record and everything linked to it)",
      "artifacts and meeting notes via search, brief, read, and context",
    ],
  }));

  app.get("/api/bridge/today", async (request) => todayBriefing(prisma, request.userId));

  /** Ensemble Node at a glance, read-only: the CLI's Node tab (docs/35 §11). */
  app.get("/api/bridge/node", async (request) => nodeOverview(prisma, request.userId));

  app.get("/api/bridge/tasks", async (request) => {
    const query = z.object({ status: Status.optional(), q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listTasks(prisma, request.userId, query);
  });

  app.get("/api/bridge/tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "task", id, 0, 8000);
    if (!item.found) return reply.code(404).send({ error: "Task not found." });
    return item.item;
  });

  app.get("/api/bridge/projects", async (request) => {
    const query = z.object({ q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listProjects(prisma, request.userId, query);
  });

  app.get("/api/bridge/projects/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "project", id, 0, 8000);
    if (!item.found) return reply.code(404).send({ error: "Project not found." });
    return item.item;
  });

  app.get("/api/bridge/diagrams", async (request) => {
    const query = z.object({ q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listDiagrams(prisma, request.userId, query);
  });

  app.get("/api/bridge/plots", async (request) => {
    const query = z.object({ q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listPlots(prisma, request.userId, query);
  });

  app.get("/api/bridge/plots/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "plot", id, 0, 8000, request.modules);
    if (!item.found) return reply.code(404).send({ error: "Plot not found." });
    return item.item;
  });

  app.get("/api/bridge/diagrams/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "diagram", id, 0, 8000, request.modules);
    if (!item.found) return reply.code(404).send({ error: "Diagram not found." });
    return item.item;
  });

  app.get("/api/bridge/repos", async (request) => {
    const query = z.object({ q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listRepos(prisma, request.userId, query);
  });

  app.get("/api/bridge/repos/:id/overview", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    try {
      return await overviewFor(prisma, request.userId, id);
    } catch (error) {
      if (error instanceof RepoReadError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/bridge/repos/:id/file", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ path: z.string().min(1).max(400) }).parse(request.query);
    try {
      return await fileFor(prisma, request.userId, id, query.path);
    } catch (error) {
      if (error instanceof RepoReadError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/bridge/repos/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "repo", id, 0, 8000);
    if (!item.found) return reply.code(404).send({ error: "Repository not found." });
    return item.item;
  });

  app.get("/api/bridge/skills", async (request) => {
    const query = z
      .object({
        q: z.string().optional(),
        limit: listLimit,
        includeDisabled: z.enum(["true", "false"]).optional(),
      })
      .parse(request.query);
    return listSkills(prisma, request.userId, {
      q: query.q,
      limit: query.limit,
      includeDisabled: query.includeDisabled === "true",
    });
  });

  app.get("/api/bridge/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "skill", id, 0, 8000, request.modules);
    if (!item.found) return reply.code(404).send({ error: "Skill not found." });
    return item.item;
  });

  app.get("/api/bridge/deliverables", async (request) => {
    const query = z
      .object({ limit: listLimit, includeCompleted: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    return listDeliverables(prisma, request.userId, {
      limit: query.limit,
      includeCompleted: query.includeCompleted === "true",
    });
  });

  app.get("/api/bridge/meetings", async (request, reply) => {
    const query = z.object({ from: z.string().optional(), to: z.string().optional(), limit: listLimit }).parse(request.query);
    for (const key of ["from", "to"] as const) {
      if (query[key] && Number.isNaN(new Date(query[key]!).getTime())) {
        return reply.code(400).send({ error: `${key} is not a date.` });
      }
    }
    return listMeetings(prisma, request.userId, query);
  });

  app.get("/api/bridge/people", async (request) => {
    const query = z.object({ q: z.string().optional(), limit: listLimit }).parse(request.query);
    return listPeople(prisma, request.userId, query);
  });

  app.get("/api/bridge/people/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = await readItem(prisma, request.userId, "person", id, 0, 4000);
    if (!item.found) return reply.code(404).send({ error: "Person not found." });
    return item.item;
  });

  app.get("/api/bridge/decisions", async (request) => {
    const query = z.object({ limit: listLimit }).parse(request.query);
    return listDecisions(prisma, request.userId, query);
  });

  app.get("/api/bridge/search", async (request, reply) => {
    const query = z
      .object({ q: z.string().min(1).max(300), limit: briefLimit, kinds: z.string().max(200).optional(), near: z.string().max(400).optional() })
      .parse(request.query);
    if (!query.q.trim()) return reply.code(400).send({ error: "Pass ?q= with the text to search for." });
    const asked = (query.kinds ?? "").split(",").map((kind) => kind.trim().toLowerCase()).filter(Boolean);
    const unknown = asked.filter((kind) => !(SEARCH_KINDS as readonly string[]).includes(kind));
    if (unknown.length) return reply.code(400).send({ error: `Unknown kind ${unknown.join(", ")}. kinds is a comma list of: ${SEARCH_KINDS.join(", ")}.` });
    const near = query.near ? parseItemRef(query.near) : null;
    if (query.near && !near) return reply.code(400).send({ error: "near must name a record: ensemble://<kind>/<id> or a Hub link." });
    return searchHub(prisma, request.userId, query.q.trim(), { limit: query.limit, kinds: asked as SearchKind[], near }, request.modules);
  });

  app.get("/api/bridge/context", async (request, reply) => {
    const query = z
      .object({
        item: z.string().min(1).max(400),
        kind: z.string().max(40).optional(),
        rel: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        offset: z.coerce.number().int().min(0).max(5000).optional(),
        format: z.enum(["json", "packet"]).default("json"),
      })
      .parse(request.query);
    const ref = parseItemRef(query.item, query.kind);
    if (!ref) {
      return reply.code(400).send({
        error: `Name a record: ensemble://<kind>/<id> (kind is one of ${GRAPH_KINDS.join(", ")}), a Hub link, or an id with kind.`,
      });
    }
    try {
      const result =
        query.format === "packet"
          ? await itemPacket(prisma, request.userId, ref, request.modules)
          : await itemContext(prisma, request.userId, ref, { rel: query.rel, limit: query.limit, offset: query.offset }, request.modules);
      if (!result) return reply.code(404).send({ error: "Not found in this Ensemble space, or it is in Trash." });
      return result;
    } catch (error) {
      if (error instanceof GraphError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/bridge/read", async (request, reply) => {
    const query = z
      .object({
        kind: z.string(),
        id: z.string().uuid(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(8000).default(4000),
      })
      .parse(request.query);
    const kind = readKindOf(query.kind);
    if (!kind) {
      return reply.code(400).send({ error: `kind must be one of: ${READ_KIND_LIST} (meeting and file also work).` });
    }
    const item = await readItem(prisma, request.userId, kind, query.id, query.offset, query.limit, request.modules);
    if (!item.found) return reply.code(404).send({ error: "Not found, or it was deleted." });
    return item.item;
  });

  app.get("/api/bridge/brief", async (request) => {
    const query = z
      .object({
        query: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional(),
        task: z.string().max(400).optional(),
        limit: briefLimit,
      })
      .parse(request.query);
    return buildBrief(prisma, request.userId, query, request.modules);
  });
}
