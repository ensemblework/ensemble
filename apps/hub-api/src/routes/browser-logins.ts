/**
 * Saved logins on this computer (logins/store.ts, docs/35 §8.16), for `ensemble browser logins`,
 * `save-login` and `forget-login`: sites and user names out, never a password or seed; values only in.
 * Only Ensemble on the person's own computer keeps them; the web refuses.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { forgetLogin, listLogins, loginOrigin, LoginStoreError, saveLogin } from "../logins/store.js";

const onComputer = () => process.env.ENSEMBLE_DESKTOP === "1";
const ELSEWHERE = "Logins are kept on your own computer. Save one there with `ensemble browser save-login <site>`.";

export async function browserLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/browser/logins", async (_request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    return { logins: listLogins() };
  });

  app.put("/api/browser/logins", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const body = z
      .object({ origin: z.string().min(1).max(300), username: z.string().min(1).max(320), password: z.string().min(1).max(1024), totp: z.string().min(1).max(400).optional() })
      .strict()
      .parse(request.body);
    try {
      const saved = saveLogin(body);
      await appendLedger({ userId: request.userId, actor: "me", action: "login.save", payload: { origin: saved.origin, from: "computer", totp: saved.totp } });
      return { login: saved };
    } catch (error) {
      if (error instanceof LoginStoreError || (error as { statusCode?: number }).statusCode === 400) return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.delete("/api/browser/logins", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { origin } = z.object({ origin: z.string().min(1).max(300) }).parse(request.query);
    try {
      const site = loginOrigin(origin);
      const forgotten = forgetLogin(site);
      if (forgotten) await appendLedger({ userId: request.userId, actor: "me", action: "login.forget", payload: { origin: site } });
      return { forgotten, origin: site };
    } catch (error) {
      if (error instanceof LoginStoreError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
