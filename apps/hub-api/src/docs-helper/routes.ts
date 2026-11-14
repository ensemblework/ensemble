import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { z } from "zod";
import { documentationIndex } from "./grounding.js";
import { answerQuestion, callIncludedDocs, scopeRefusal } from "./answer.js";
import { outsideDocs } from "./policy.js";
import { admitDocs, docsAddress } from "./limits.js";
import { docsHistory, docsIdentity } from "./history.js";
import { endSession } from "../lib/auth.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";
import { authWebOrigin } from "../lib/auth-email.js";

import { DOCS_ASK_PATH, DOCS_ORIGIN, DOCS_RETURN } from "./paths.js";
export { isDocsPath } from "./paths.js";
export const docsCors: FastifyCorsOptions = { origin: DOCS_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"], allowedHeaders: ["Content-Type", "x-ensemble-docs-account"], exposedHeaders: ["Retry-After"] };
const Question = z.object({ question: z.string().trim().min(1).max(500), remember: z.boolean().optional() }).strict();
export type DocsDependencies = { index: ReturnType<typeof documentationIndex>; call: typeof callIncludedDocs; admit: (address: string) => Promise<number> };
const historyRate = new MemoryRateLimiter();

export async function docsHelperRoutes(app: FastifyInstance, options: { dependencies?: DocsDependencies } = {}) {
  const deps = options.dependencies ?? { index: documentationIndex(), call: callIncludedDocs, admit: (address: string) => admitDocs(app.redis, address) };
  const history = docsHistory(app.prisma);
  const identity = (request: FastifyRequest) => docsIdentity(app.prisma, request);
  const sameAccount = (request: FastifyRequest, id: string) => request.headers["x-ensemble-docs-account"] === id;
  const changed = { error: "Your sign-in changed. Reload your docs history before continuing.", code: "DOCS_ACCOUNT_CHANGED" };
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "GET") {
      const wait = historyRate.take(docsAddress(request), 120, 60_000);
      if (wait) return reply.header("Retry-After", Math.ceil(wait / 1000)).code(429).send({ error: "Too many requests. Please try again shortly." });
    }
  });
  app.get("/api/docs/session", async (request) => {
    const who = await identity(request);
    return { user: who ? { id: who.id, name: who.name } : null, loginUrl: `${authWebOrigin()}/login?next=${encodeURIComponent(DOCS_RETURN)}` };
  });
  app.get("/api/docs/history", async (request, reply) => {
    const who = await identity(request);
    if (!who) return reply.code(401).send({ error: "Sign in to view your docs history." });
    if (!sameAccount(request, who.id)) return reply.code(409).send(changed);
    const { before } = z.object({ before: z.string().uuid().optional() }).parse(request.query);
    return history.list(who.id, before);
  });
  app.delete("/api/docs/history", async (request, reply) => {
    const who = await identity(request);
    if (!who) return reply.code(401).send({ error: "Sign in to manage your docs history." });
    if (request.headers.origin !== DOCS_ORIGIN) return reply.code(403).send({ error: "Open the documentation site to manage its history." });
    if (!sameAccount(request, who.id)) return reply.code(409).send(changed);
    await history.clear(who.id);
    return reply.code(204).send();
  });
  app.post("/api/docs/logout", { bodyLimit: 2048 }, async (request, reply) => {
    if (request.headers.origin !== DOCS_ORIGIN) return reply.code(403).send({ error: "Open the documentation site to sign out." });
    const who = await identity(request);
    if (who && !sameAccount(request, who.id)) return reply.code(409).send(changed);
    await endSession(request, reply);
    return reply.code(204).send();
  });
  app.post(DOCS_ASK_PATH, { bodyLimit: 2048 }, async (request, reply) => {
    const parsed = Question.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ask a question using 1 to 500 characters." });
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", disconnected);
    try {
      const wait = await deps.admit(docsAddress(request));
      if (wait > 0) return reply.header("Retry-After", String(wait)).code(429).send({ error: "The docs helper has reached its limit. Please try again later or use search." });
      if (parsed.data.remember && request.headers.origin !== DOCS_ORIGIN) return reply.code(403).send({ error: "Open the documentation site to save chat history." });
      // A guest request does not even look up a cookie, and cannot write any transcript.
      const who = parsed.data.remember ? await identity(request) : null;
      if (parsed.data.remember && !who) return reply.code(401).send({ error: "Your sign-in expired. Sign in again to save this question." });
      if (who && !sameAccount(request, who.id)) return reply.code(409).send(changed);
      const generation = who ? await history.begin(who.id) : null;
      const answer = outsideDocs(parsed.data.question) ? scopeRefusal() : await answerQuestion(parsed.data.question, await deps.index(), (payload) => deps.call(payload, fetch, controller.signal));
      if (controller.signal.aborted) return;
      if (!who || generation === null) return answer;
      const turn = await history.save(who, generation, parsed.data.question, answer);
      return { ...answer, saved: Boolean(turn), turn };
    } catch {
      return reply.code(503).send({ error: "The docs helper could not answer. Try again or use search." });
    } finally { reply.raw.removeListener("close", disconnected); }
  });
}
