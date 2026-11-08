import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { requireBrowserSession } from "../bridge/auth.js";
import { newApiToken, sha256, startSession } from "../lib/auth.js";
import { authWebOrigin } from "../lib/auth-email.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { clientAddress } from "../lib/rate-limit.js";
import { createDevicePairing } from "../devices/pairing.js";
import { redis } from "../lib/redis.js";

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`);
const EXPIRES_IN_SECONDS = 600;
const INTERVAL_SECONDS = 5;
/**
 * `mcp`: a key for editors. `runner`: pair this computer for tasks. `web`: sign the desktop app's window in
 * (a one-time handoff, never a stored key). `transfer`: move this computer's local-only data into the
 * account (a one-purpose key, docs/DESKTOP.md §1.3).
 */
const SCOPES = ["mcp", "runner", "web", "transfer"] as const;
type CliScope = (typeof SCOPES)[number];
/** Kept with the approved scopes: the key minted at the exchange may also update tasks through the bridge. */
const WRITE_GRANT = "write";
/** The key may use the account's connected apps through the bridge. */
const APPS_GRANT = "apps";

const StartBody = z.object({
  clientName: z.string().trim().min(1).max(80),
  platform: z.string().trim().max(32).default(""),
  version: z.string().trim().max(32).default(""),
  scopes: z.array(z.enum(SCOPES)).min(1).max(4),
});

const UserCodeBody = z.object({
  userCode: z.string().min(1).max(32),
  scopes: z.array(z.enum(SCOPES)).max(4).default([]),
  decision: z.enum(["approve", "deny"]),
  canWrite: z.boolean().default(true),
  canUseApps: z.boolean().default(true),
});

const TokenBody = z.object({
  deviceCode: z.string().min(1).max(300),
});

function uniqueScopes(values: readonly CliScope[]): CliScope[] {
  return SCOPES.filter((scope) => values.includes(scope));
}

function userCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(raw: string): string | null {
  const normalized = raw.toUpperCase().replace(/[\s-]/g, "");
  return USER_CODE.test(normalized) ? normalized : null;
}

function requestedOrigin(request: FastifyRequest): string {
  const configured = process.env.HUB_API_PUBLIC_URL?.trim();
  if (configured) return new URL(configured).origin;
  const host = request.headers.host ?? "localhost";
  return new URL(`${request.protocol}://${host}`).origin;
}

function tokenError(error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token") {
  return { error };
}

async function createStartRow(app: FastifyInstance, body: z.infer<typeof StartBody>, requestIp: string | null) {
  await app.prisma.cliAuthRequest.updateMany({ where: { expiresAt: { lt: new Date() }, requestIp: { not: null } }, data: { requestIp: null } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deviceCode = randomBytes(32).toString("base64url");
    const rawUserCode = userCode();
    try {
      await app.prisma.cliAuthRequest.create({
        data: {
          deviceCodeHash: sha256(deviceCode),
          userCodeHash: sha256(rawUserCode),
          clientName: body.clientName,
          platform: body.platform,
          version: body.version,
          requestIp,
          requestedScopes: uniqueScopes(body.scopes),
          expiresAt: new Date(Date.now() + EXPIRES_IN_SECONDS * 1000),
        },
      });
      return { deviceCode, rawUserCode };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }
  throw Object.assign(new Error("Could not create a login code. Try again."), { statusCode: 503 });
}

const HANDOFF_SECONDS = 30 * 60;
const handoffKey = (code: string) => `ensemble:auth:handoff:${sha256(code)}`;

async function webHandoff(userId: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await redis.set(handoffKey(code), userId, "EX", HANDOFF_SECONDS);
  return code;
}

export async function cliAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/cli/auth/start", async (request, reply) => {
    const body = StartBody.parse(request.body);
    const address = clientAddress(request);
    const { deviceCode, rawUserCode } = await createStartRow(app, body, address === "unknown" ? null : address.slice(0, 64));
    const verificationUri = `${authWebOrigin()}/link`;
    const userCodeFormatted = formatUserCode(rawUserCode);
    return reply.code(200).send({
      deviceCode,
      userCode: userCodeFormatted,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCodeFormatted)}`,
      expiresIn: EXPIRES_IN_SECONDS,
      interval: INTERVAL_SECONDS,
    });
  });

  app.get("/api/cli/auth/request", async (request, reply) => {
    requireBrowserSession(request);
    const query = z.object({ code: z.string().min(1).max(32) }).parse(request.query);
    const normalized = normalizeUserCode(query.code);
    if (!normalized) return reply.code(404).send({ error: "Login request not found." });
    const row = await app.prisma.cliAuthRequest.findUnique({ where: { userCodeHash: sha256(normalized) } });
    if (!row || row.expiresAt <= new Date() || row.consumedAt) return reply.code(404).send({ error: "Login request not found." });
    return {
      clientName: row.clientName,
      platform: row.platform,
      version: row.version,
      scopes: row.requestedScopes,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      status: row.status,
      requestedFrom: row.requestIp,
      // A hint, not a check: VPNs and IPv4/IPv6 differences also cause a mismatch.
      sameNetwork: row.requestIp ? row.requestIp === clientAddress(request) : null,
    };
  });

  app.post("/api/cli/auth/approve", async (request, reply) => {
    requireBrowserSession(request);
    const body = UserCodeBody.parse(request.body);
    const normalized = normalizeUserCode(body.userCode);
    if (!normalized) return reply.code(404).send({ error: "Login request not found." });
    const row = await app.prisma.cliAuthRequest.findUnique({ where: { userCodeHash: sha256(normalized) } });
    const now = new Date();
    if (!row || row.expiresAt <= now || row.consumedAt || row.status !== "pending") {
      return reply.code(404).send({ error: "Login request not found." });
    }
    const requested = new Set(row.requestedScopes);
    const scopes = uniqueScopes(body.scopes);
    if (scopes.some((scope) => !requested.has(scope))) return reply.code(400).send({ error: "Approved scopes must be a subset of the requested scopes." });
    if (body.decision === "approve" && scopes.length === 0) return reply.code(400).send({ error: "Approve at least one requested scope." });

    if (body.decision === "deny") {
      const won = await app.prisma.cliAuthRequest.updateMany({
        where: { id: row.id, status: "pending", consumedAt: null, expiresAt: { gt: now } },
        data: { status: "denied", userId: request.userId, approvedScopes: [], decidedAt: now, requestIp: null },
      });
      if (won.count !== 1) return reply.code(404).send({ error: "Login request not found." });
      await appendLedger({
        userId: request.userId,
        actor: "me",
        action: "cli.auth.deny",
        payload: { requestId: row.id, clientName: row.clientName, platform: row.platform, scopes: row.requestedScopes },
      });
      return { ok: true, scopes: [] };
    }

    if (scopes.includes("runner") || scopes.includes("transfer")) await requireVerifiedUser(request.userId);
    // Secrets are minted at the one-time exchange, so nothing usable is stored here.
    const won = await app.prisma.cliAuthRequest.updateMany({
      where: { id: row.id, status: "pending", consumedAt: null, expiresAt: { gt: now } },
      data: { status: "approved", userId: request.userId, approvedScopes: [...scopes, ...(body.canWrite ? [WRITE_GRANT] : []), ...(body.canUseApps ? [APPS_GRANT] : [])], decidedAt: now },
    });
    if (won.count !== 1) return reply.code(404).send({ error: "Login request not found." });
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: "cli.auth.approve",
      payload: { requestId: row.id, clientName: row.clientName, platform: row.platform, scopes, canWrite: body.canWrite, canUseApps: body.canUseApps },
    });
    return { ok: true, scopes };
  });

  app.post("/api/cli/auth/token", async (request, reply) => {
    const body = TokenBody.parse(request.body);
    const now = new Date();
    const row = await app.prisma.cliAuthRequest.findUnique({
      where: { deviceCodeHash: sha256(body.deviceCode) },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!row || row.expiresAt <= now || row.consumedAt) return reply.code(400).send(tokenError("expired_token"));

    if (row.status === "pending") {
      if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < INTERVAL_SECONDS * 1000) {
        await app.prisma.cliAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: now } });
        return reply.code(400).send(tokenError("slow_down"));
      }
      await app.prisma.cliAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: now } });
      return reply.code(400).send(tokenError("authorization_pending"));
    }
    if (row.status === "denied") return reply.code(400).send(tokenError("access_denied"));
    const userId = row.userId;
    if (row.status !== "approved" || !userId || !row.user) return reply.code(400).send(tokenError("expired_token"));
    const runner = row.approvedScopes.includes("runner");
    const mcp = row.approvedScopes.includes("mcp");
    const web = row.approvedScopes.includes("web");
    const transfer = row.approvedScopes.includes("transfer");
    const canWrite = row.approvedScopes.includes(WRITE_GRANT);
    const canUseApps = row.approvedScopes.includes(APPS_GRANT);
    if (runner || transfer) await requireVerifiedUser(userId);

    const minted = newApiToken();
    const movingKey = newApiToken();
    const issued = await app.prisma.$transaction(async (tx) => {
      const claimed = await tx.cliAuthRequest.updateMany({
        where: { id: row.id, status: "approved", consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now, requestIp: null },
      });
      if (claimed.count !== 1) return null;
      const token = mcp
        ? await tx.apiToken.create({
            data: {
              userId,
              name: `Ensemble CLI on ${row.clientName}`.slice(0, 80),
              tokenHash: minted.hash,
              prefix: minted.prefix,
              scope: "bridge",
              canWrite,
              canUseApps,
            },
          })
        : null;
      if (transfer) {
        await tx.apiToken.create({ data: { userId, name: `Moving data from ${row.clientName}`.slice(0, 80), tokenHash: movingKey.hash, prefix: movingKey.prefix, scope: "transfer" } });
      }
      const pairing = runner ? await createDevicePairing(tx, userId, now) : null;
      await tx.cliAuthRequest.update({ where: { id: row.id }, data: { tokenId: token?.id ?? null, pairingId: pairing?.pairing.id ?? null } });
      return { tokenId: token?.id ?? null, pairing };
    });
    if (!issued) return reply.code(400).send(tokenError("expired_token"));
    const handoff = web ? await webHandoff(userId) : null;
    if (transfer || web) await appendLedger({ userId, actor: "me", action: "cli.auth.desktop", payload: { requestId: row.id, clientName: row.clientName, web, transfer } });

    return {
      token: mcp ? minted.token : null,
      tokenId: issued.tokenId,
      scopes: uniqueScopes(row.approvedScopes.filter((scope): scope is CliScope => (SCOPES as readonly string[]).includes(scope))),
      canWrite,
      canUseApps,
      account: { email: row.user.email, name: row.user.name },
      // The account a pairing from this exchange belongs to (the desktop app compares it with its current pairing).
      accountId: userId,
      apiBase: requestedOrigin(request),
      appUrl: authWebOrigin(),
      ...(issued.pairing ? { pairingCode: issued.pairing.code, pairingExpiresAt: issued.pairing.expiresAt.toISOString() } : {}),
      ...(handoff ? { webHandoff: handoff } : {}),
      ...(transfer ? { transferToken: movingKey.token } : {}),
    };
  });

  // The desktop app's window opens this once with the code from the exchange above; it becomes a normal
  // signed-in session in that window. The code is single use and lasts 30 minutes (a large move of local data comes first).
  app.get("/api/auth/handoff", async (request, reply) => {
    const query = z.object({ code: z.string().min(20).max(200), to: z.string().max(300).optional() }).parse(request.query);
    const key = handoffKey(query.code);
    const userId = await redis.get(key);
    await redis.del(key);
    const to = query.to && /^\/(?!\/)[^\s\\]*$/.test(query.to) ? query.to : "/today";
    if (!userId) return reply.redirect(`${authWebOrigin()}/login?expired=desktop`, 302);
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return reply.redirect(`${authWebOrigin()}/login`, 302);
    await startSession(reply, userId, request);
    await appendLedger({ userId, actor: "me", action: "auth.desktop_handoff", payload: {} });
    return reply.redirect(`${authWebOrigin()}${to}`, 302);
  });

  app.post("/api/cli/logout", async (request, reply) => {
    if (request.authVia !== "token" || !request.tokenId || (request.tokenScope !== "bridge" && request.tokenScope !== "full")) {
      reply.header("WWW-Authenticate", 'Bearer realm="Ensemble"');
      return reply.code(401).send({ error: "Bearer token required." });
    }
    await app.prisma.apiToken.updateMany({ where: { id: request.tokenId, userId: request.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return reply.code(204).send();
  });
}
