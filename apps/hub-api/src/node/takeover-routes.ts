/**
 * The owner's side of a takeover (node/takeovers.ts, B21): open one for a sign-in card's tab, a run's
 * tab or a live card's terminal or tab (watch it, or take control), start it with the channel's secret sealed for the computer, fetch encrypted frames, send
 * encrypted input, and end it (Stop, or I'm done). Only from a signed-in browser session, never a key or
 * an agent; every call after the first carries the capability (`x-ensemble-takeover`).
 */
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readCookie, SESSION_COOKIE, sha256 } from "../lib/auth.js";
import { SealedShape } from "../credentials/seal.js";
import { ChannelMessage, type ChannelMessage as Message } from "../remote/contract.js";
import { wireMessage } from "./store.js";
import { controlTakeover, createTakeover, finishTakeover, nextFrame, ownTakeover, relayInput, startTakeover, TakeoverError } from "./takeovers.js";

const Target = z.union([
  z.object({ loginCardId: z.string().min(1).max(100) }).strict(),
  z.object({ jobId: z.string().uuid(), tab: z.string().regex(/^t\d{1,9}$/).optional() }).strict(),
  z.object({ liveCardId: z.string().min(1).max(100) }).strict(),
]);

function browserSession(request: FastifyRequest): string {
  if (request.authVia !== "session") throw new TakeoverError("Open the browser from the Ensemble Node page you are signed in to.", 403, "browser_only");
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) throw new TakeoverError("Sign in again.", 401);
  return sha256(cookie);
}

const controllerOf = (request: FastifyRequest) => {
  const header = request.headers["x-ensemble-takeover"];
  return Array.isArray(header) ? header[0] : header;
};

export async function registerTakeoverRoutes(app: FastifyInstance, account: (request: FastifyRequest) => string): Promise<void> {
  const fail = (error: unknown, reply: { code(status: number): { send(body: unknown): unknown } }) => {
    if (error instanceof TakeoverError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    throw error;
  };
  const own = async (request: FastifyRequest) => ownTakeover(app, account(request), browserSession(request), (request.params as { id: string }).id, controllerOf(request));

  app.post("/api/node/takeovers", async (request, reply) => {
    try {
      const target = Target.safeParse(request.body);
      if (!target.success) return reply.code(400).send({ error: "Name the sign-in card (loginCardId), the run (jobId) or the live card (liveCardId) to open." });
      return await createTakeover(app, account(request), browserSession(request), target.data);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.post("/api/node/takeovers/:id/start", async (request, reply) => {
    try {
      const body = z.object({ sealed: SealedShape }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Send the takeover's key sealed for the computer." });
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      return await startTakeover(app, await own(request), body.data.sealed, origin);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.get("/api/node/takeovers/:id/frames", async (request, reply) => {
    try {
      const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
      const record = await own(request);
      const gone = new AbortController();
      reply.raw.on("close", () => gone.abort());
      reply.header("Cache-Control", "no-store");
      return await nextFrame(app, record, after, gone.signal);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.post("/api/node/takeovers/:id/input", { bodyLimit: 80_000 }, async (request, reply) => {
    try {
      const message = ChannelMessage.safeParse(request.body);
      if (!message.success) return reply.code(400).send({ error: "That input could not be read." });
      await relayInput(app, await own(request), message.data as Message);
      return { ok: true };
    } catch (error) {
      return fail(error, reply);
    }
  });

  // A live view: take control of the node's tab or terminal, or go back to watching.
  app.post("/api/node/takeovers/:id/control", async (request, reply) => {
    try {
      const body = z.object({ on: z.boolean() }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Say whether to take control (on: true) or watch (on: false)." });
      return await controlTakeover(app, await own(request), body.data.on);
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.post("/api/node/takeovers/:id/end", async (request, reply) => {
    try {
      const { done } = z.object({ done: z.boolean().default(false) }).strict().parse(request.body ?? {});
      const ended = await finishTakeover(app, await own(request), done);
      return { ...ended, card: ended.card ? wireMessage(ended.card) : null };
    } catch (error) {
      return fail(error, reply);
    }
  });
}
