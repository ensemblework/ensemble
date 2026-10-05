import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { publicApiUrl } from "../connectors/oauth.js";
import { appendLedger } from "../lib/ledger.js";
import { requireBrowserSession } from "../bridge/auth.js";
import { newApiToken } from "../lib/auth.js";
import { ENSEMBLE_SOURCE } from "../workspace/guard.js";

const RECENT_MS = 3 * 60 * 1000;
const HTTP_PORT = process.env.CONTEXT_BRIDGE_PORT ?? "4010";

/** Loopback health check. The browser cannot call this port reliably (no CORS), so the Hub asks. */
async function httpBridgeUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean; service?: string };
    return body.ok === true && body.service === "context-bridge";
  } catch {
    return false;
  }
}

export async function connectRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/connect/bridge", async (request) => {
    const bridgeScript = join(ENSEMBLE_SOURCE, "apps/context-bridge/dist/index.js");
    const tokens = await prisma.apiToken.findMany({
      where: { userId: request.userId, revokedAt: null, scope: "bridge" },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
    });
    const httpUp = await httpBridgeUp();
    const latest = tokens.reduce((max, row) => Math.max(max, row.lastUsedAt?.getTime() ?? 0), 0);
    const connected = latest > 0 && Date.now() - latest < RECENT_MS;
    return {
      repoRoot: ENSEMBLE_SOURCE,
      bridgeScript,
      node: process.execPath,
      hubApiUrl: `http://127.0.0.1:${env.HUB_API_PORT}`,
      publicApiUrl: publicApiUrl(),
      httpUrl: `http://127.0.0.1:${HTTP_PORT}/mcp`,
      platform: platform(),
      built: existsSync(bridgeScript),
      httpUp,
      state: connected ? "connected" : httpUp ? "running" : "not_running",
      tokens,
    };
  });

  /** A leaked key must not mint another key. Session, no-login bypass, or the desktop shell. */
  app.post("/api/connect/token", async (request) => {
    requireBrowserSession(request);
    const body = z.object({ name: z.string().trim().min(1).max(60).optional() }).parse(request.body ?? {});
    if (request.authVia === "bypass") {
      await prisma.user.upsert({
        where: { id: request.userId },
        create: { id: request.userId, email: `${request.userId}@ensemble.local`, name: "Local (no account)" },
        update: {},
      });
    }
    const name = body.name ?? "Read-only connection";
    const { token, hash, prefix } = newApiToken();
    const row = await prisma.apiToken.create({
      data: { userId: request.userId, name, tokenHash: hash, prefix, scope: "bridge" },
    });
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: "token.create",
      payload: { name, prefix, scope: "bridge" },
    });
    return { id: row.id, token, prefix };
  });
}
