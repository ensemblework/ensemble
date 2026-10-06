import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { requireBrowserSession } from "../bridge/auth.js";
import { newApiToken, sha256 } from "../lib/auth.js";
import { authWebOrigin } from "../lib/auth-email.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { clientAddress } from "../lib/rate-limit.js";
import { createDevicePairing } from "../devices/pairing.js";

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`);
const EXPIRES_IN_SECONDS = 600;
const INTERVAL_SECONDS = 5;
const SCOPES = ["mcp", "runner"] as const;
type CliScope = (typeof SCOPES)[number];

const StartBody = z.object({
  clientName: z.string().trim().min(1).max(80),
  platform: z.string().trim().max(32).default(""),
  version: z.string().trim().max(32).default(""),
  scopes: z.array(z.enum(SCOPES)).min(1).max(2),
});

const UserCodeBody = z.object({
  userCode: z.string().min(1).max(32),
  scopes: z.array(z.enum(SCOPES)).max(2).default([]),
  decision: z.enum(["approve", "deny"]),
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

    if (scopes.includes("runner")) await requireVerifiedUser(request.userId);
    // Secrets are minted at the one-time exchange, so nothing usable is stored here.
    const won = await app.prisma.cliAuthRequest.updateMany({
      where: { id: row.id, status: "pending", consumedAt: null, expiresAt: { gt: now } },
      data: { status: "approved", userId: request.userId, approvedScopes: scopes, decidedAt: now },
    });
    if (won.count !== 1) return reply.code(404).send({ error: "Login request not found." });
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: "cli.auth.approve",
      payload: { requestId: row.id, clientName: row.clientName, platform: row.platform, scopes },
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
    if (runner) await requireVerifiedUser(userId);

    const minted = newApiToken();
    const issued = await app.prisma.$transaction(async (tx) => {
      const claimed = await tx.cliAuthRequest.updateMany({
        where: { id: row.id, status: "approved", consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now, requestIp: null },
      });
      if (claimed.count !== 1) return null;
      const token = await tx.apiToken.create({
        data: {
          userId,
          name: `Ensemble CLI on ${row.clientName}`.slice(0, 80),
          tokenHash: minted.hash,
          prefix: minted.prefix,
          scope: "bridge",
        },
      });
      const pairing = runner ? await createDevicePairing(tx, userId, now) : null;
      await tx.cliAuthRequest.update({ where: { id: row.id }, data: { tokenId: token.id, pairingId: pairing?.pairing.id ?? null } });
      return { tokenId: token.id, pairing };
    });
    if (!issued) return reply.code(400).send(tokenError("expired_token"));

    return {
      token: minted.token,
      tokenId: issued.tokenId,
      scopes: row.approvedScopes,
      account: { email: row.user.email, name: row.user.name },
      apiBase: requestedOrigin(request),
      appUrl: authWebOrigin(),
      ...(issued.pairing ? { pairingCode: issued.pairing.code, pairingExpiresAt: issued.pairing.expiresAt.toISOString() } : {}),
    };
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
