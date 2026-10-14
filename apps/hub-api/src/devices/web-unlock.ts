/**
 * The web terminal's lock (docs/16 §5, docs/25 §4.8). The terminal on a paired computer opens from
 * Ensemble on the web only after a passkey (Touch ID, Windows Hello, a phone or security key) unlocks
 * it in this browser: 30 minutes idle, 8 hours at most, then locked again. No agent, API key, MCP
 * client or the assistant can produce a passkey response, and every route here refuses anything but a
 * signed-in browser on Ensemble's own page. Adding a passkey needs the account password, or a code
 * mailed to the account when it signs in with Google or GitHub, so a stolen session alone cannot enrol one.
 *
 * Sessions live in Redis (any process, survives a restart); the cookie holds a random token whose
 * hash is the key. Passkeys are `TerminalPasskey` rows whose `rpId` is the web's host name.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { accountIdOf, readCookie, verifyPassword } from "../lib/auth.js";
import { emailConfigured, newPasskeyCode, sendPasskeyCode } from "../lib/auth-email.js";
import { appendLedger } from "../lib/ledger.js";
import { passkeyResponse, RegistrationCredential, UnlockCredential, verifying } from "../lib/passkey-shape.js";
import { publishDeviceFrame } from "./revoke-notify.js";

export const WEB_TERMINAL_COOKIE = "ensemble_web_terminal";
export const IDLE_MS = 30 * 60_000;
export const MAX_MS = 8 * 3600_000;
const RP_NAME = "Ensemble";
const CODE_TTL_SECONDS = 600;
const CODE_ATTEMPTS = 5;

type Session = { userId: string; created: number; lastUsed: number; runs: Array<{ deviceId: string; runId: string }> };
type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(...keys: string[]): Promise<unknown> };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionKey = (token: string) => `ensemble:webterm:session:${hash(token)}`;
const challengeKey = (userId: string) => `ensemble:webterm:challenge:${userId}`;
const codeKey = (userId: string) => `ensemble:webterm:code:${userId}`;

class Refused extends Error {
  readonly expose = true;
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The web's own page: the origin passkeys belong to. */
function webOrigin(): string {
  return env.HUB_WEB_ORIGIN.replace(/\/$/, "");
}

export function webRpId(): string {
  return new URL(webOrigin()).hostname;
}

function origins(): string[] {
  const base = webOrigin();
  return [...new Set([base, base.replace("127.0.0.1", "localhost")])];
}

/**
 * Refuses anything but a person signed in to Ensemble's own page in a browser: no API key, agent, MCP
 * client or internal call. A change must name the page as its `Origin`; browsers leave `Origin` off a
 * same-origin GET, so a read may come without one (the unlock cookie is `SameSite=Strict` either way),
 * but never with another page's.
 */
export function requireWebPerson(request: FastifyRequest): void {
  if (request.authVia !== "session") throw new Refused(403, "The terminal opens only from Ensemble in your browser, signed in. Keys, agents and the assistant are refused.");
  const origin = request.headers.origin;
  const read = request.method === "GET" || request.method === "HEAD";
  if (origin ? !origins().includes(origin) : !read) throw new Refused(403, "The terminal only accepts requests from the Ensemble page itself.");
}

function secureCookie(): string {
  return webOrigin().startsWith("https://") ? "; Secure" : "";
}

async function readSession(redis: Redisish, request: FastifyRequest): Promise<{ token: string; session: Session } | null> {
  const token = readCookie(request, WEB_TERMINAL_COOKIE);
  if (!token) return null;
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  let session: Session;
  try {
    session = JSON.parse(raw) as Session;
  } catch {
    return null;
  }
  const now = Date.now();
  if (session.userId !== accountIdOf(request) || now - session.lastUsed > IDLE_MS || now - session.created > MAX_MS) {
    await redis.del(sessionKey(token));
    return null;
  }
  return { token, session };
}

async function writeSession(redis: Redisish, token: string, session: Session): Promise<void> {
  const left = Math.max(1, Math.ceil((session.created + MAX_MS - Date.now()) / 1000));
  await redis.set(sessionKey(token), JSON.stringify(session), "EX", left);
}

export function expiresAt(session: Session): string {
  return new Date(Math.min(session.lastUsed + IDLE_MS, session.created + MAX_MS)).toISOString();
}

/** The unlocked session for this request, its idle clock reset; or a 401. Every terminal call goes through here. */
export async function requireUnlocked(redis: Redisish, request: FastifyRequest): Promise<{ token: string; session: Session }> {
  requireWebPerson(request);
  const found = await readSession(redis, request);
  if (!found) throw new Refused(401, "The terminal is locked. Unlock it with your passkey.");
  found.session.lastUsed = Date.now();
  await writeSession(redis, found.token, found.session);
  return found;
}

/** Remembers a command this session started, so locking stops it. */
export async function rememberRun(redis: Redisish, unlocked: { token: string; session: Session }, run: { deviceId: string; runId: string }): Promise<void> {
  unlocked.session.runs = [...(unlocked.session.runs ?? []).slice(-19), run];
  await writeSession(redis, unlocked.token, unlocked.session);
}

async function rememberChallenge(redis: Redisish, userId: string, kind: "register" | "unlock", challenge: string): Promise<void> {
  await redis.set(challengeKey(userId), JSON.stringify({ kind, challenge }), "EX", kind === "register" ? 300 : 120);
}

async function takeChallenge(redis: Redisish, userId: string, kind: "register" | "unlock"): Promise<string | null> {
  const raw = await redis.get(challengeKey(userId));
  await redis.del(challengeKey(userId));
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as { kind: string; challenge: string };
    return row.kind === kind ? row.challenge : null;
  } catch {
    return null;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function webUnlockRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  const redis = app.redis as unknown as Redisish;
  const rpId = webRpId;

  const passkeysOf = (userId: string) => prisma.terminalPasskey.findMany({ where: { userId, rpId: rpId() }, orderBy: { createdAt: "asc" } });

  app.get("/api/web-terminal/status", async (request) => {
    const userId = accountIdOf(request);
    const found = request.authVia === "session" ? await readSession(redis, request) : null;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    const keys = await passkeysOf(userId);
    return {
      unlocked: Boolean(found),
      expiresAt: found ? expiresAt(found.session) : null,
      passkeys: keys.map((key) => ({ id: key.id, label: key.label, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null })),
      password: Boolean(user?.passwordHash),
      emailCode: emailConfigured(),
    };
  });

  // A code to the account's address, for an account with no password.
  app.post("/api/web-terminal/passkeys/code", async (request) => {
    requireWebPerson(request);
    const userId = accountIdOf(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const code = newPasskeyCode();
    await redis.set(codeKey(userId), JSON.stringify({ hash: hash(`${userId}:${code}`), attempts: 0 }), "EX", CODE_TTL_SECONDS);
    await sendPasskeyCode(user, code);
    return { sent: true, to: user.email.replace(/^(.).*(@.*)$/, "$1…$2") };
  });

  app.post("/api/web-terminal/passkeys/options", async (request) => {
    requireWebPerson(request);
    const userId = accountIdOf(request);
    const body = z.object({ password: z.string().min(1).max(500).optional(), code: z.string().min(1).max(20).optional() }).parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (body.password) {
      if (!(await verifyPassword(body.password, user.passwordHash))) throw new Refused(403, "That password is not right.");
    } else if (body.code) {
      const raw = await redis.get(codeKey(userId));
      const row = raw ? (JSON.parse(raw) as { hash: string; attempts: number }) : null;
      if (!row || row.attempts >= CODE_ATTEMPTS) throw new Refused(403, "That code has expired. Send a new one.");
      if (!sameText(row.hash, hash(`${userId}:${body.code.trim().toUpperCase()}`))) {
        await redis.set(codeKey(userId), JSON.stringify({ ...row, attempts: row.attempts + 1 }), "EX", CODE_TTL_SECONDS);
        throw new Refused(403, "That code is not right.");
      }
      await redis.del(codeKey(userId));
    } else {
      throw new Refused(400, user.passwordHash ? "Enter your Ensemble password." : "Enter the code we mailed you.");
    }
    const existing = await passkeysOf(userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId(),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: "none",
      excludeCredentials: existing.map((key) => ({ id: key.id, transports: key.transports as never })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await rememberChallenge(redis, userId, "register", options.challenge);
    return options;
  });

  app.post("/api/web-terminal/passkeys/verify", async (request) => {
    requireWebPerson(request);
    const userId = accountIdOf(request);
    const body = z.object({ response: z.unknown(), label: z.string().max(80).default("This device") }).parse(request.body);
    const challenge = await takeChallenge(redis, userId, "register");
    if (!challenge) throw new Refused(400, "That took too long. Start again.");
    const response = passkeyResponse(RegistrationCredential, body.response, "Start again.");
    const result = await verifying(
      () =>
        verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origins(),
          expectedRPID: rpId(),
          requireUserVerification: true,
        }),
      "Start again.",
    );
    if (!result.verified || !result.registrationInfo) throw new Refused(400, "The passkey could not be verified.");
    const credential = result.registrationInfo.credential;
    await prisma.terminalPasskey.create({
      data: { id: credential.id, userId, rpId: rpId(), publicKey: Buffer.from(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [], label: body.label },
    });
    await appendLedger({ userId, actor: "me", action: "terminal.web.passkey_add", payload: { label: body.label } });
    return { ok: true };
  });

  app.delete("/api/web-terminal/passkeys/:id", async (request, reply) => {
    await requireUnlocked(redis, request);
    const userId = accountIdOf(request);
    const { id } = request.params as { id: string };
    await prisma.terminalPasskey.deleteMany({ where: { id, userId, rpId: rpId() } });
    await appendLedger({ userId, actor: "me", action: "terminal.web.passkey_remove", payload: {} });
    return reply.code(204).send();
  });

  app.post("/api/web-terminal/unlock/options", async (request) => {
    requireWebPerson(request);
    const userId = accountIdOf(request);
    const keys = await passkeysOf(userId);
    if (!keys.length) throw new Refused(409, "Add a passkey for the terminal first.");
    const options = await generateAuthenticationOptions({
      rpID: rpId(),
      allowCredentials: keys.map((key) => ({ id: key.id, transports: key.transports as never })),
      userVerification: "required",
    });
    await rememberChallenge(redis, userId, "unlock", options.challenge);
    return options;
  });

  app.post("/api/web-terminal/unlock/verify", async (request, reply: FastifyReply) => {
    requireWebPerson(request);
    const userId = accountIdOf(request);
    const body = z.object({ response: z.unknown() }).parse(request.body);
    const challenge = await takeChallenge(redis, userId, "unlock");
    if (!challenge) throw new Refused(400, "That took too long. Try again.");
    const response = passkeyResponse(UnlockCredential, body.response, "Try again.");
    const key = await prisma.terminalPasskey.findFirst({ where: { id: response.id, userId, rpId: rpId() } });
    if (!key) throw new Refused(403, "That passkey is not set up for the terminal.");
    const result = await verifying(
      () =>
        verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origins(),
          expectedRPID: rpId(),
          requireUserVerification: true,
          credential: { id: key.id, publicKey: new Uint8Array(key.publicKey), counter: key.counter, transports: key.transports as never },
        }),
      "Try again.",
    );
    if (!result.verified) throw new Refused(403, "The passkey did not verify.");
    await prisma.terminalPasskey.update({ where: { id: key.id }, data: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: Session = { userId, created: now, lastUsed: now, runs: [] };
    await writeSession(redis, token, session);
    reply.header("Set-Cookie", `${WEB_TERMINAL_COOKIE}=${token}; HttpOnly; Path=/api; SameSite=Strict; Max-Age=${MAX_MS / 1000}${secureCookie()}`);
    await appendLedger({ userId, actor: "me", action: "terminal.web.unlock", payload: {} });
    return { unlocked: true, expiresAt: expiresAt(session) };
  });

  // Lock now: the session ends and the commands it started are stopped.
  app.post("/api/web-terminal/lock", async (request, reply) => {
    const found = await readSession(redis, request);
    if (found) {
      for (const run of found.session.runs ?? []) publishDeviceFrame(run.deviceId, "terminal.request", { id: `kill-${run.runId}`, op: "kill", runId: run.runId });
      await redis.del(sessionKey(found.token));
    }
    reply.header("Set-Cookie", `${WEB_TERMINAL_COOKIE}=; HttpOnly; Path=/api; SameSite=Strict; Max-Age=0${secureCookie()}`);
    return { ok: true };
  });
}
