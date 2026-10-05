import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { bridgeAuthRejected } from "./auth.js";
import { DATA_GAPS } from "./gaps.js";
import { fileFor, overviewFor } from "../repo/locate.js";
import { RepoReadError } from "../repo/read.js";
import {
  buildBrief,
  isReadKind,
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
 * Read-only HTTP surface for the Context Bridge.
 * Every route is GET. The process-wide guard in index.ts rejects other methods
 * before they reach a handler. There is no Prisma client in the bridge process;
 * this is the only way it reads.
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
      "artifacts and meeting notes via search, brief, and read",
    ],
  }));

  app.get("/api/bridge/today", async (request) => todayBriefing(prisma, request.userId));

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
    const query = z.object({ q: z.string().min(1), limit: briefLimit }).parse(request.query);
    if (!query.q.trim()) return reply.code(400).send({ error: "Pass ?q= with the text to search for." });
    return searchHub(prisma, request.userId, query.q.trim(), query.limit, request.modules);
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
    if (!isReadKind(query.kind)) {
      return reply.code(400).send({
        error: "kind must be one of: task, project, repo, skill, deliverable, person, artifact, document, meeting_note, approval, decision, page.",
      });
    }
    const item = await readItem(prisma, request.userId, query.kind, query.id, query.offset, query.limit, request.modules);
    if (!item.found) return reply.code(404).send({ error: "Not found, or it was deleted." });
    return item.item;
  });

  app.get("/api/bridge/brief", async (request) => {
    const query = z
      .object({
        query: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional(),
        limit: briefLimit,
      })
      .parse(request.query);
    return buildBrief(prisma, request.userId, query, request.modules);
  });
}
