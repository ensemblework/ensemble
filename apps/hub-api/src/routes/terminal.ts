/**
 * The human-only terminal (docs/16 §5).
 *
 * Who: a browser session that unlocked with a platform passkey (Touch ID).
 * No agent, API token or internal call can produce one; they are refused
 * before anything else is checked. Registering a passkey needs the account
 * password as well, so a stolen session cookie alone cannot enrol one.
 *
 * What: an allow-list, one argv at a time, run under the same Seatbelt
 * profile as agent commands, confined to the folder the terminal is in.
 * The ledger records the command, folder and exit code — never the output.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config.js";
import { requireHostTerminal } from "../lib/hosted-access.js";
import { streamCorsHeaders } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { readCookie, verifyPassword, accountIdOf } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { declareModule } from "../lib/module-gate.js";
import { humanOnlyRefusal } from "../lib/terminal-human.js";
import { blockedReason, checkGit, checkProgram, gitHardening, GuardError, jailPath, parseCommand, within, workspaceRoot } from "../workspace/guard.js";
import { killGroup, runCommand } from "../workspace/runner.js";

const COOKIE = "ensemble_terminal";
const IDLE_MS = 30 * 60_000;
const MAX_MS = 8 * 3600_000;
const RP_NAME = "Ensemble";

const sessions = new Map<string, { userId: string; created: number; lastUsed: number }>();
const challenges = new Map<string, { challenge: string; expires: number; kind: "register" | "unlock" }>();

function rememberChallenge(userId: string, value: { challenge: string; expires: number; kind: "register" | "unlock" }) {
  const now = Date.now();
  for (const [key, row] of challenges) if (row.expires <= now) challenges.delete(key);
  while (challenges.size > 100) {
    const oldest = challenges.keys().next().value;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
  challenges.set(userId, value);
}

function origins(): string[] {
  const base = env.HUB_WEB_ORIGIN.replace(/\/$/, "");
  return [base, base.replace("127.0.0.1", "localhost")];
}

function rpId(request: FastifyRequest): string {
  const origin = request.headers.origin ?? env.HUB_WEB_ORIGIN;
  return new URL(origin).hostname;
}

/** A body that is not a passkey response: the caller's mistake, so a 400 with a clear reason, never a 500 from inside the verifier. */
class BadPasskeyResponse extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

/** The JSON shape @simplewebauthn/browser posts. Checked before the verifier, which throws plain errors on anything else. */
function credentialShape<T extends z.ZodRawShape>(response: T) {
  return z
    .object({
      id: z.string().min(1),
      rawId: z.string().min(1),
      type: z.literal("public-key"),
      response: z.object(response).passthrough(),
      clientExtensionResults: z.record(z.unknown()).default({}),
    })
    .passthrough();
}
const RegistrationCredential = credentialShape({ clientDataJSON: z.string().min(1), attestationObject: z.string().min(1) });
const UnlockCredential = credentialShape({ clientDataJSON: z.string().min(1), authenticatorData: z.string().min(1), signature: z.string().min(1) });

function passkeyResponse<T extends z.ZodTypeAny>(schema: T, response: unknown, again: string): z.infer<T> {
  const parsed = schema.safeParse(response);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = ["response", ...(issue?.path ?? [])].join(".");
  throw new BadPasskeyResponse(`That is not a passkey response (${where}: ${issue?.message ?? "invalid"}). ${again}`);
}

/** The verifier throws (not returns false) on a credential it cannot read or that names the wrong origin or challenge: a bad request too. */
async function verifying<T>(run: () => Promise<T>, again: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new BadPasskeyResponse(`That passkey response is not valid. ${again}`, { cause: error });
  }
}

/** Refuses anything that is not a person in the Hub's own browser tab. */
function humanOnly(request: FastifyRequest): void {
  const refusal = humanOnlyRefusal({ authVia: request.authVia, origin: request.headers.origin, webOrigins: origins() });
  if (refusal) throw new GuardError(refusal);
}

function unlocked(request: FastifyRequest): string | null {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  const now = Date.now();
  if (!session || session.userId !== request.userId || now - session.lastUsed > IDLE_MS || now - session.created > MAX_MS) {
    if (session) sessions.delete(token);
    return null;
  }
  session.lastUsed = now;
  return token;
}

function sessionInfo(token: string | null) {
  const session = token ? sessions.get(token) : null;
  if (!session) return { unlocked: false, expiresAt: null };
  return { unlocked: true, expiresAt: new Date(Math.min(session.lastUsed + IDLE_MS, session.created + MAX_MS)).toISOString() };
}

async function roots(app: FastifyInstance, userId: string): Promise<string[]> {
  const settings = await loadSettings(app.prisma, userId);
  const jobs = await app.prisma.workspaceJob.findMany({ where: { userId, externalRoot: { not: null } }, select: { externalRoot: true }, distinct: ["externalRoot"] });
  const candidates = [...settings.terminal.roots, ...jobs.map((job) => job.externalRoot!)];
  const allowed = [await workspaceRoot()];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || blockedReason(candidate)) continue;
    if (await stat(candidate).then((info) => info.isDirectory()).catch(() => false)) allowed.push(candidate);
  }
  return [...new Set(allowed)];
}

function scopeOf(allowed: string[], path: string): string | null {
  return allowed.filter((root) => within(root, path)).sort((a, b) => b.length - a.length)[0] ?? null;
}

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/^git reset .*--hard/, "This throws away uncommitted changes."],
  [/^git clean\b/, "This deletes untracked files."],
  [/^git push .*--force-with-lease/, "This rewrites the remote branch."],
  [/^git branch .*(-D|--delete)/, "This deletes a branch."],
  [/^git checkout -- /, "This discards changes in those files."],
  [/^git restore (?!--staged)/, "This discards changes in those files."],
  [/^rm .*-[a-zA-Z]*r/, "This deletes folders recursively."],
];

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "code");
  app.addHook("preHandler", async (request) => requireHostTerminal(request.userId));
  const { prisma } = app;

  app.get("/api/terminal/status", async (request) => {
    const settings = await loadSettings(prisma, request.userId);
    const passkeys = await prisma.terminalPasskey.findMany({ where: { userId: request.userId }, orderBy: { createdAt: "asc" } });
    return {
      enabled: settings.terminal.enabled,
      ...sessionInfo(unlocked(request)),
      passkeys: passkeys.map((key) => ({ id: key.id, label: key.label, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null })),
      roots: await roots(app, request.userId),
      home: await workspaceRoot(),
    };
  });

  app.post("/api/terminal/passkeys/options", async (request) => {
    humanOnly(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: accountIdOf(request) } });
    if (!user.passwordHash) throw new GuardError("Terminal passkey enrollment requires an account password. OAuth-only sign-in is valid, but password or reauthentication enrollment support is required before adding a terminal passkey.");
    const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
    if (!(await verifyPassword(password, user.passwordHash))) throw new GuardError("That password is not right.");
    const existing = await prisma.terminalPasskey.findMany({ where: { userId: request.userId } });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId(request),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: "none",
      excludeCredentials: existing.map((key) => ({ id: key.id, transports: key.transports as never })),
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    });
    rememberChallenge(request.userId, { challenge: options.challenge, expires: Date.now() + 5 * 60_000, kind: "register" });
    return options;
  });

  app.post("/api/terminal/passkeys/verify", async (request) => {
    humanOnly(request);
    const body = z.object({ response: z.unknown(), label: z.string().max(80).default("This Mac") }).parse(request.body);
    const pending = challenges.get(request.userId);
    challenges.delete(request.userId);
    if (!pending || pending.kind !== "register" || pending.expires < Date.now()) throw new GuardError("That took too long. Start again.");
    const response = passkeyResponse(RegistrationCredential, body.response, "Start again.");
    const result = await verifying(
      () =>
        verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: origins(),
          expectedRPID: rpId(request),
          requireUserVerification: true,
        }),
      "Start again.",
    );
    if (!result.verified || !result.registrationInfo) throw new GuardError("The passkey could not be verified.");
    const credential = result.registrationInfo.credential;
    await prisma.terminalPasskey.create({
      data: {
        id: credential.id,
        userId: request.userId,
        rpId: rpId(request),
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label: body.label,
      },
    });
    await appendLedger({ userId: request.userId, actor: "me", action: "terminal.passkey.add", payload: { label: body.label } });
    return { ok: true };
  });

  app.delete("/api/terminal/passkeys/:id", async (request, reply) => {
    humanOnly(request);
    if (!unlocked(request)) throw new GuardError("Unlock the terminal first.");
    const { id } = request.params as { id: string };
    await prisma.terminalPasskey.deleteMany({ where: { id, userId: request.userId } });
    await appendLedger({ userId: request.userId, actor: "me", action: "terminal.passkey.remove", payload: {} });
    return reply.code(204).send();
  });

  app.post("/api/terminal/unlock/options", async (request) => {
    humanOnly(request);
    const keys = await prisma.terminalPasskey.findMany({ where: { userId: request.userId } });
    if (!keys.length) throw new GuardError("Set up Touch ID for the terminal first.");
    const options = await generateAuthenticationOptions({
      rpID: rpId(request),
      allowCredentials: keys.map((key) => ({ id: key.id, transports: key.transports as never })),
      userVerification: "required",
    });
    rememberChallenge(request.userId, { challenge: options.challenge, expires: Date.now() + 2 * 60_000, kind: "unlock" });
    return options;
  });

  app.post("/api/terminal/unlock/verify", async (request, reply) => {
    humanOnly(request);
    const body = z.object({ response: z.unknown() }).parse(request.body);
    const pending = challenges.get(request.userId);
    challenges.delete(request.userId);
    if (!pending || pending.kind !== "unlock" || pending.expires < Date.now()) throw new GuardError("That took too long. Try again.");
    const response = passkeyResponse(UnlockCredential, body.response, "Try again.");
    const key = await prisma.terminalPasskey.findFirst({ where: { id: response.id, userId: request.userId } });
    if (!key) throw new GuardError("That passkey is not registered for the terminal.");
    const result = await verifying(
      () =>
        verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: origins(),
          expectedRPID: rpId(request),
          requireUserVerification: true,
          credential: { id: key.id, publicKey: new Uint8Array(key.publicKey), counter: key.counter, transports: key.transports as never },
        }),
      "Try again.",
    );
    if (!result.verified) throw new GuardError("Touch ID did not verify.");
    await prisma.terminalPasskey.update({ where: { id: key.id }, data: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    for (const [key, value] of sessions) {
      if (now - value.lastUsed > IDLE_MS || now - value.created > MAX_MS) sessions.delete(key);
    }
    while (sessions.size > 100) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    sessions.set(token, { userId: request.userId, created: now, lastUsed: now });
    reply.header("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Path=/api/terminal; SameSite=Strict; Max-Age=${MAX_MS / 1000}`);
    await appendLedger({ userId: request.userId, actor: "me", action: "terminal.unlock", payload: {} });
    return sessionInfo(token);
  });

  app.post("/api/terminal/lock", async (request, reply) => {
    const token = readCookie(request, COOKIE);
    if (token) {
      killGroup(`term:${token}`);
      sessions.delete(token);
    }
    reply.header("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/api/terminal; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.post("/api/terminal/kill", async (request) => {
    humanOnly(request);
    const token = unlocked(request);
    return { killed: token ? killGroup(`term:${token}`) : 0 };
  });

  /** Resolves `cd`: relative paths stay in the current scope; absolute ones may jump to another allowed root. */
  app.post("/api/terminal/cd", async (request) => {
    humanOnly(request);
    if (!unlocked(request)) throw new GuardError("The terminal is locked.");
    const body = z.object({ cwd: z.string(), path: z.string().default("") }).parse(request.body);
    const allowed = await roots(app, request.userId);
    const scope = scopeOf(allowed, body.cwd);
    if (!scope) throw new GuardError("That folder is outside what the terminal may use.");
    const target = body.path.trim() === "" || body.path.trim() === "~" ? scope : body.path.trim();
    if (isAbsolute(target)) {
      const next = scopeOf(allowed, resolve(target));
      if (!next) throw new GuardError(`${target} is outside the folders the terminal may use.`);
      const real = await jailPath(next, resolve(target), true);
      if (!(await stat(real)).isDirectory()) throw new GuardError("That is not a folder.");
      return { cwd: real, scope: next };
    }
    const real = await jailPath(scope, resolve(body.cwd, target), true);
    if (!(await stat(real)).isDirectory()) throw new GuardError("That is not a folder.");
    return { cwd: real, scope };
  });

  app.post("/api/terminal/run", async (request: FastifyRequest, reply: FastifyReply) => {
    humanOnly(request);
    const token = unlocked(request);
    if (!token) return reply.code(401).send({ error: "The terminal is locked. Unlock with Touch ID." });
    const settings = await loadSettings(prisma, request.userId);
    if (!settings.terminal.enabled) throw new GuardError("The terminal is turned off in Settings.");
    const body = z.object({ cwd: z.string(), line: z.string().min(1).max(4000), confirmed: z.boolean().default(false) }).parse(request.body);
    const allowed = await roots(app, request.userId);
    const scope = scopeOf(allowed, body.cwd);
    if (!scope) throw new GuardError("That folder is outside what the terminal may use.");
    const cwd = await jailPath(scope, body.cwd, true);
    const argv = parseCommand(body.line.trim());
    const program = checkProgram(argv, { who: "human", sandboxed: true, network: true });
    let full = argv;
    if (program === "git") {
      checkGit(argv, { delivery: "push", who: "human" });
      full = ["git", ...gitHardening(true, settings.terminal.commitAuthor), ...argv.slice(1)];
    }
    const warning = DESTRUCTIVE.find(([pattern]) => pattern.test(body.line.trim()))?.[1];
    if (warning && !body.confirmed) return reply.code(428).send({ confirm: warning });

    reply.hijack();
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    };
    Object.assign(headers, streamCorsHeaders(request.headers.origin, hubCorsPolicy()));
    reply.raw.writeHead(200, headers);
    let closed = false;
    const controller = new AbortController();
    reply.raw.on("close", () => {
      closed = true;
      controller.abort();
    });
    try {
      const result = await runCommand({
        userId: request.userId,
        argv: full,
        cwd,
        root: scope,
        sandboxed: process.platform === "darwin",
        network: true,
        useCredentials: true,
        who: "human",
        timeoutMs: 15 * 60_000,
        signal: controller.signal,
        group: `term:${token}`,
        onChunk: (text) => {
          if (!closed) reply.raw.write(text);
        },
      });
      if (!closed) reply.raw.write(`${result.timedOut ? "\n[stopped after 15 minutes]" : ""}\n\u0000${result.exitCode}`);
      await appendLedger({ userId: request.userId, actor: "me", action: "terminal.run", payload: { argv: argv.slice(0, 20), cwd, exitCode: result.exitCode } });
    } catch (error) {
      if (!closed) reply.raw.write(`${error instanceof Error ? error.message : String(error)}\n\u0000127`);
    } finally {
      reply.raw.end();
    }
  });
}
