/**
 * The owner's side of a sign-in card (node/logins.ts, B11): where typed values go (the computer and
 * its pinned key), and the answer, relayed to the computer. Never a password in the clear: a typed
 * answer is a box sealed in the browser for the computer.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { accountIdOf } from "../lib/auth.js";
import { wireMessage } from "./store.js";
import { answerLoginCard, LoginAnswer, LoginCardError, loginTarget } from "./logins.js";

export async function registerLoginRoutes(app: FastifyInstance, account: (request: FastifyRequest) => string = accountIdOf): Promise<void> {
  app.get("/api/node/logins/:messageId", async (request, reply) => {
    try {
      return await loginTarget(app, account(request), (request.params as { messageId: string }).messageId);
    } catch (error) {
      if (error instanceof LoginCardError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  });

  app.post("/api/node/logins/:messageId", async (request, reply) => {
    const parsed = LoginAnswer.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Answer with saved, local, done or decline, or what you typed sealed for the computer (typed)." });
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    try {
      const done = await answerLoginCard(app, account(request), (request.params as { messageId: string }).messageId, parsed.data, origin);
      return { message: wireMessage(done.message), result: done.result };
    } catch (error) {
      if (error instanceof LoginCardError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  });
}
