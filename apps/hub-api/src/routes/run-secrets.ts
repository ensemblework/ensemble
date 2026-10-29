/**
 * Run secrets on this computer (lib/run-secrets.ts, docs/35 §8.7), for `ensemble secrets`: names only
 * out, a value only in. Only Ensemble on the person's own computer keeps them; the web refuses. Also
 * where each may be sent by reference (`allow`), how runs here get them (`mode`), and the fingerprint of
 * the key the web encrypts secrets for (`key`, B12).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { listRunSecrets, removeRunSecret, saveRunSecret, setSecretAllow } from "../lib/run-secrets.js";
import { loadSealKey } from "../credentials/seal-key.js";
import { loadSettings, updateSettings } from "../remote/store.js";
import { wakeRemote } from "../remote/loop.js";

const onComputer = () => process.env.ENSEMBLE_DESKTOP === "1";
const ELSEWHERE = "Secrets are kept on your own computer. Save one there with `ensemble secrets set <NAME>`, or answer a node's request for it.";
const Allow = z.array(z.string().min(1).max(300)).max(20);

export async function runSecretRoutes(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;

  app.get("/api/run-secrets", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    return { secrets: await listRunSecrets(prisma, request.userId), mode: loadSettings().secretsMode };
  });

  // How coding-agent runs here get saved secrets when they name none: every one (compatibility mode) or none.
  app.get("/api/run-secrets/mode", async (_request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    return { mode: loadSettings().secretsMode };
  });

  app.put("/api/run-secrets/mode", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { mode } = z.object({ mode: z.enum(["all", "named"]) }).strict().parse(request.body);
    updateSettings({ secretsMode: mode });
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.mode", payload: { mode } });
    // The web hears the new mode with the next report.
    wakeRemote();
    return { mode };
  });

  // The key the web encrypts secrets for, to compare with the fingerprint the web shows.
  app.get("/api/run-secrets/key", async (_request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const settings = loadSettings();
    const key = settings.pairedAt ? loadSealKey() : null;
    return { paired: Boolean(settings.pairedAt), deviceId: settings.deviceId, sealKey: key?.info ?? null, createdAt: key?.createdAt ?? null };
  });

  app.put("/api/run-secrets/:name", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const { value, allow } = z.object({ value: z.string().min(1).max(16 * 1024), allow: Allow.optional() }).strict().parse(request.body);
    const saved = await saveRunSecret(prisma, request.userId, name, value, allow ? { allow } : {});
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.save", payload: { name, from: "computer", allow: saved.allow } });
    return { saved: true, name, allow: saved.allow };
  });

  // Where a saved secret may be sent by reference (secret_http, git); an empty list makes it an environment secret again.
  app.put("/api/run-secrets/:name/allow", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const { allow } = z.object({ allow: Allow }).strict().parse(request.body);
    const kept = await setSecretAllow(prisma, request.userId, name, allow);
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.allow", payload: { name, allow: kept } });
    return { name, allow: kept };
  });

  app.delete("/api/run-secrets/:name", async (request, reply) => {
    if (!onComputer()) return reply.code(409).send({ error: ELSEWHERE });
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    if (!(await removeRunSecret(prisma, request.userId, name))) return reply.code(404).send({ error: `There is no secret called ${name} on this computer.` });
    await appendLedger({ userId: request.userId, actor: "me", action: "secret.remove", payload: { name } });
    return reply.code(204).send();
  });
}
