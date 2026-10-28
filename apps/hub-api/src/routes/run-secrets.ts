/**
 * Run secrets on this computer (lib/run-secrets.ts, docs/35 §8.7), for `ensemble secrets`: names only
 * out, a value only in. Only Ensemble on the person's own computer keeps them; the web refuses.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { listRunSecrets, removeRunSecret, saveRunSecret } from "../lib/run-secrets.js";

const onComputer = () => process.env.ENSEMBLE_DESKTOP === "1";
const ELSEWHERE = "Secrets are kept on your own computer. Save one there with `ensemble secrets set <NAME>`, or answer a node's request for it.";

export async function runSecretRoutes(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;

  app.get("/api/run-secrets", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    return { secrets: await listRunSecrets(prisma, request.userId) };
  });

  app.put("/api/run-secrets/:name", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const { value } = z.object({ value: z.string().min(1).max(16 * 1024) }).strict().parse(request.body);
    await saveRunSecret(prisma, request.userId, name, value);
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.save", payload: { name, from: "computer" } });
    return { saved: true, name };
  });

  app.delete("/api/run-secrets/:name", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    if (!(await removeRunSecret(prisma, request.userId, name))) return reply.code(404).send({ error: `There is no secret called ${name} on this computer.` });
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.remove", payload: { name } });
    return reply.code(204).send();
  });
}
