import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { prisma } from "../lib/prisma.js";
import { runInScope } from "./context.js";
import { memberDecision, shareDecision } from "./policy.js";

/**
 * Runs the rest of the request inside its scope (who is acting, in which space). Must be a
 * callback hook that calls `done` inside `run`, so every later hook and the handler inherit it.
 */
export function scopeHook(request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void {
  if (!request.userId) return done();
  runInScope({ spaceId: request.userId, accountId: request.accountId ?? request.userId, access: request.access ?? { kind: "owner" } }, () => done());
}

async function firstName(id: string): Promise<string> {
  const row = await prisma.user.findUnique({ where: { id }, select: { name: true } });
  const first = row?.name.trim().split(/\s+/)[0];
  return first && !first.includes("@") ? first : "the owner";
}

function datasetIds(config: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if ((key === "datasetId" || key === "dataset") && typeof item === "string") ids.add(item);
      else walk(item, depth + 1);
    }
  };
  walk(config, 0);
  return ids;
}

/**
 * Enforces the sharing policy (policy.ts) for anyone who is not the space owner. Runs before
 * every handler, after the body is parsed, so share rules can bind to body fields.
 */
export async function sharingGate(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const access = request.access;
  if (!access || access.kind === "owner" || !request.userId) return;
  const url = request.routeOptions.url ?? "";
  if (access.kind === "gone") return reply.code(404).send({ error: "This share was removed, or it is not yours." });

  if (access.kind === "share") {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    // A shared plot space also opens the datasets its tiles draw from, and nothing else.
    if (access.resource === "plot_space" && request.method === "GET" && url === "/api/plots/datasets/:id") {
      const space = await prisma.plot.findFirst({ where: { id: access.resourceId, userId: request.userId }, select: { config: true } });
      if (space && params.id && datasetIds(space.config).has(params.id)) return;
      return reply.code(403).send({ error: "This link only opens the item that was shared with you." });
    }
    const decision = shareDecision(access, request.method, url, { params, query: (request.query ?? {}) as Record<string, unknown>, body: request.body });
    if (!decision.allow) return reply.code(decision.status).send({ error: decision.message });
    if (decision.personal) request.userId = request.accountId ?? request.userId;
    return;
  }

  const decision = memberDecision(request.method, url, access.role, "");
  if (!decision.allow) {
    const name = await firstName(access.ownerId);
    const message = decision.message.includes("Only ") ? `Only ${name} can do this in their space.` : decision.message;
    return reply.code(decision.status).send({ error: message });
  }
  if (decision.personal) request.userId = request.accountId ?? request.userId;
}
