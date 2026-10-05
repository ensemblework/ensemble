/**
 * The human-only terminal against Postgres, end to end: a software platform
 * authenticator enrols a passkey, unlocks the terminal and runs a command.
 * Skips when the database is down.
 *
 * Pins two follow-ups to #86:
 * - the streamed `run` response (hijacked, so its headers are written by hand)
 *   carries `Vary: Origin` exactly once, like every other hijacked stream;
 * - a malformed passkey body is a 400 with a clear reason, not a 500 thrown
 *   from inside the WebAuthn verifier.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import cors from "@fastify/cors";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { env } from "../config.js";
import { hashPassword, identify, sha256 } from "../lib/auth.js";
import { corsPluginOptions } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { prisma } from "../lib/prisma.js";
import { saveSettings } from "../lib/settings.js";
import "../types.js";
import { workspaceRoot } from "../workspace/guard.js";
import { terminalRoutes } from "./terminal.js";

const PASSWORD = "correct horse battery staple";
const MODULES = "code,diagrams,metrics,runs,skills,workspace";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** The same CORS plugin and error mapping as src/index.ts, so refusals look as they do in production. */
async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Redis);
  await app.register(cors, corsPluginOptions(hubCorsPolicy()));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const expose = statusCode < 500 || (error as { expose?: boolean }).expose === true;
    return reply.code(statusCode).send({ error: expose ? (error as Error).message : "Something went wrong on the Hub." });
  });
  app.addHook("onRequest", async (request, reply) => {
    const who = await identify(request);
    if (!who) return reply.code(401).send({ error: "Sign in to Ensemble first." });
    request.userId = who.userId;
    request.authVia = who.via;
    request.tokenScope = who.tokenScope;
    request.modules = who.modules ?? MODULES;
  });
  await app.register(terminalRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(payload);
  });
}

function errorOf(reply: Reply): string {
  try {
    return String((JSON.parse(reply.body) as { error?: string }).error ?? "");
  } catch {
    return "";
  }
}

/** Vary must name Origin exactly once (a hijacked route that drops it, or sets it twice, fails). */
function assertVaryOrigin(headers: http.IncomingHttpHeaders, label: string) {
  const raw = headers.vary;
  const values = (Array.isArray(raw) ? raw.join(",") : String(raw ?? "")).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  assert.equal(values.filter((value) => value === "origin").length, 1, `${label}: Vary is ${JSON.stringify(raw)}`);
}

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const u8 = (bytes: Buffer) => new Uint8Array(bytes);

/** A platform authenticator in software: one P-256 key, "none" attestation, user verification always on. */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly keys: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {}

  private authData(flags: number, attested?: Uint8Array): Uint8Array {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [createHash("sha256").update(this.rpId).digest(), Buffer.from([flags]), counter];
    if (attested) parts.push(Buffer.from(attested));
    return u8(Buffer.concat(parts));
  }

  register(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, u8(Buffer.from(jwk.x, "base64url"))],
      [-3, u8(Buffer.from(jwk.y, "base64url"))],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = u8(Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, Buffer.from(isoCBOR.encode(cose))]));
    // UP | UV | AT
    const authData = this.authData(0x45, attested);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin: this.origin, crossOrigin: false });
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  assert(challenge: string) {
    this.counter += 1;
    // UP | UV
    const authenticatorData = this.authData(0x05);
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: this.origin, crossOrigin: false });
    const signed = Buffer.concat([Buffer.from(authenticatorData), createHash("sha256").update(clientDataJSON).digest()]);
    const signature = sign("sha256", signed, this.keys.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
      clientExtensionResults: {},
    };
  }
}

async function cleanup(userId: string): Promise<void> {
  await prisma.terminalPasskey.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function signedIn() {
  const user = await prisma.user.create({
    data: { email: `terminal-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Terminal", passwordHash: await hashPassword(PASSWORD) },
  });
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { id: sha256(raw), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), modules: MODULES } });
  await saveSettings(prisma, user.id, { terminal: { enabled: true } });
  return { user, session: `ensemble_session=${raw}` };
}

const page = env.HUB_WEB_ORIGIN.replace(/\/$/, "");

test("the streamed terminal run response varies on Origin, like every other hijacked stream", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  assert.equal(new URL(page).hostname, "localhost", `this test needs HUB_WEB_ORIGIN on localhost, got ${page}`);
  const { user, session } = await signedIn();
  const app = await build();
  const port = (app.server.address() as AddressInfo).port;
  const authenticator = new SoftAuthenticator(page, new URL(page).hostname);
  try {
    const human = { cookie: session, origin: page };

    // Enrol: password, then the platform passkey.
    const options = await call(port, "POST", "/api/terminal/passkeys/options", human, { password: PASSWORD });
    assert.equal(options.status, 200, options.body);
    const enrol = await call(port, "POST", "/api/terminal/passkeys/verify", human, { response: authenticator.register(JSON.parse(options.body).challenge), label: "Test Mac" });
    assert.equal(enrol.status, 200, enrol.body);

    // Locked: refused before anything is streamed, and the CORS plugin's Vary is there.
    const locked = await call(port, "POST", "/api/terminal/run", human, { cwd: await workspaceRoot(), line: "ls" });
    assert.equal(locked.status, 401, locked.body);
    assertVaryOrigin(locked.headers, "locked run");

    // Unlock with the passkey.
    const unlockOptions = await call(port, "POST", "/api/terminal/unlock/options", human, {});
    assert.equal(unlockOptions.status, 200, unlockOptions.body);
    const unlock = await call(port, "POST", "/api/terminal/unlock/verify", human, { response: authenticator.assert(JSON.parse(unlockOptions.body).challenge) });
    assert.equal(unlock.status, 200, unlock.body);
    const terminalCookie = String([unlock.headers["set-cookie"]].flat()[0] ?? "").split(";")[0];
    assert.match(terminalCookie, /^ensemble_terminal=.+/);

    // The real stream: hijacked, headers written by hand.
    const unlocked = { cookie: `${session}; ${terminalCookie}`, origin: page };
    const run = await call(port, "POST", "/api/terminal/run", unlocked, { cwd: await workspaceRoot(), line: "ls" });
    assert.equal(run.status, 200, run.body);
    assert.match(String(run.headers["content-type"]), /^text\/plain/);
    assert.ok(run.body.endsWith("\u00000"), `run finished with exit 0: ${JSON.stringify(run.body.slice(-200))}`);
    assertVaryOrigin(run.headers, "streamed run");
    assert.equal(run.headers["access-control-allow-origin"], page);
    assert.equal(run.headers["access-control-allow-credentials"], "true");

    // Refused at humanOnly (no Origin, or another site): still no stream, still nothing looser than before.
    for (const origin of [undefined, "https://evil.example"]) {
      const headers: Record<string, string> = { cookie: unlocked.cookie };
      if (origin) headers.origin = origin;
      const refused = await call(port, "POST", "/api/terminal/run", headers, { cwd: await workspaceRoot(), line: "ls" });
      assert.equal(refused.status, 403, `${origin}: ${refused.body}`);
      assert.equal(errorOf(refused), "The terminal only accepts requests from the Ensemble page itself.", String(origin));
      assert.equal(refused.headers["access-control-allow-origin"], undefined, String(origin));
    }
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a malformed passkey body is a 400 with a clear reason, never a 500", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const { user, session } = await signedIn();
  const app = await build();
  const port = (app.server.address() as AddressInfo).port;
  const human = { cookie: session, origin: page };
  const authenticator = new SoftAuthenticator(page, new URL(page).hostname);
  const startEnrol = async () => {
    const options = await call(port, "POST", "/api/terminal/passkeys/options", human, { password: PASSWORD });
    assert.equal(options.status, 200, options.body);
    return JSON.parse(options.body).challenge as string;
  };
  try {
    // With no set-up in progress, the answer is unchanged: start again.
    const stale = await call(port, "POST", "/api/terminal/passkeys/verify", human, { response: {} });
    assert.equal(stale.status, 403, stale.body);
    assert.equal(errorOf(stale), "That took too long. Start again.");

    // With a set-up in progress, each malformed body is the caller's mistake.
    const real = authenticator.register("not-the-challenge");
    const malformed: Array<[string, unknown, RegExp]> = [
      ["empty response", { response: {} }, /^That is not a passkey response \(response\.id: Required\)\. Start again\.$/],
      ["string response", { response: "garbage" }, /^That is not a passkey response \(response: Expected object, received string\)\. Start again\.$/],
      ["null response", { response: null }, /^That is not a passkey response \(response: /],
      ["no response at all", {}, /^That is not a passkey response \(response: Required\)/],
      ["wrong type", { response: { ...real, type: "password" } }, /^That is not a passkey response \(response\.type: /],
      ["missing attestation", { response: { ...real, response: { clientDataJSON: real.response.clientDataJSON } } }, /response\.response\.attestationObject: Required/],
      ["unreadable client data", { response: { ...real, response: { clientDataJSON: "bm90IGpzb24", attestationObject: "AAAA" } } }, /^That passkey response is not valid\. Start again\.$/],
      ["wrong challenge", { response: real }, /^That passkey response is not valid\. Start again\.$/],
    ];
    for (const [label, body, message] of malformed) {
      await startEnrol();
      const response = await call(port, "POST", "/api/terminal/passkeys/verify", human, body);
      assert.equal(response.status, 400, `${label}: ${response.body}`);
      assert.match(errorOf(response), message, label);
    }
    // A label that is too long was already a 400, and still is.
    await startEnrol();
    const longLabel = await call(port, "POST", "/api/terminal/passkeys/verify", human, { response: real, label: "x".repeat(81) });
    assert.equal(longLabel.status, 400, longLabel.body);
    assert.equal(await prisma.terminalPasskey.count({ where: { userId: user.id } }), 0, "nothing malformed was enrolled");

    // The well-formed response still enrols.
    const enrol = await call(port, "POST", "/api/terminal/passkeys/verify", human, { response: authenticator.register(await startEnrol()) });
    assert.equal(enrol.status, 200, enrol.body);

    // Unlock has the same verifier and gets the same treatment.
    const startUnlock = async () => {
      const options = await call(port, "POST", "/api/terminal/unlock/options", human, {});
      assert.equal(options.status, 200, options.body);
      return JSON.parse(options.body).challenge as string;
    };
    const assertion = authenticator.assert("not-the-challenge");
    for (const [label, body, message] of [
      ["empty response", { response: {} }, /^That is not a passkey response \(response\.id: Required\)\. Try again\.$/],
      ["missing signature", { response: { ...assertion, response: { ...assertion.response, signature: undefined } } }, /response\.response\.signature: Required/],
      ["garbage signature", { response: { ...assertion, response: { ...assertion.response, authenticatorData: "AAAA" } } }, /^That passkey response is not valid\. Try again\.$/],
    ] as Array<[string, unknown, RegExp]>) {
      await startUnlock();
      const response = await call(port, "POST", "/api/terminal/unlock/verify", human, body);
      assert.equal(response.status, 400, `unlock ${label}: ${response.body}`);
      assert.match(errorOf(response), message, `unlock ${label}`);
    }
    const unlock = await call(port, "POST", "/api/terminal/unlock/verify", human, { response: authenticator.assert(await startUnlock()) });
    assert.equal(unlock.status, 200, unlock.body);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});
