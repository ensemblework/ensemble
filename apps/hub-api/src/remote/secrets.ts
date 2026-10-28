/**
 * A secret the person typed on the web for this computer (`secret.save`, docs/35 §8.7): stored here,
 * encrypted with this computer's key, and given to its agent runs as an environment variable. The
 * answer says only whether it was saved; the value never goes back.
 */
import { z } from "zod";
import { env } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { appendLedger } from "../lib/ledger.js";
import { saveRunSecret } from "../lib/run-secrets.js";
import type { HostedClient } from "./client.js";

/** `capabilities.secrets`: this computer takes `secret.save` frames. */
export const SECRETS_API = 1;

const SecretSave = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(64), value: z.string().min(1).max(16 * 1024) });

export async function answerSecretSave(client: HostedClient, data: unknown): Promise<void> {
  const parsed = SecretSave.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, { status: 400, body: { error: "That secret could not be read." } });
    return;
  }
  try {
    await saveRunSecret(prisma, env.ENSEMBLE_DEV_USER_ID, parsed.data.name, parsed.data.value);
    await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action: "secret.save", payload: { name: parsed.data.name, from: "web" } }).catch(() => undefined);
    await client.answerCode(parsed.data.id, { status: 200, body: { saved: true, name: parsed.data.name } });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    await client.answerCode(parsed.data.id, { status, body: { error: error instanceof Error ? error.message.slice(0, 300) : "This computer could not save it." } });
  }
}
