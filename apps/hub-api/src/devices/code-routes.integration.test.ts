/**
 * The Code tab and terminal on Ensemble on the web for a paired computer (protocol 4), against
 * Postgres: only the computer's owner in a signed-in browser, only listed calls, the computer's own
 * switches, and a terminal that needs a passkey unlock. The computer is simulated: it hears frames on
 * its event stream and answers through its own routes with its device key. The passkey is a software
 * authenticator (P-256), so registration and unlock run through the real WebAuthn verifier.
 */
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { ZodError } from "zod";
import "../config.js";
import { deviceTokenRejected, readOnlyTokenRejected } from "../bridge/auth.js";
import { setMailSenderForTests } from "../lib/auth-email.js";
import { hashPassword, identify, sha256 } from "../lib/auth.js";
import { memoryRedis } from "../lib/memory-redis.js";
import { prisma } from "../lib/prisma.js";
import { sseHub } from "../lib/sse.js";
import "../types.js";
import { deviceCodeRoutes } from "./code-routes.js";
import { deviceRoutes } from "./routes.js";

const ORIGIN = (process.env.HUB_WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const RP_ID = new URL(ORIGIN).hostname;

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function install(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    const who = await identify(request);
    if (!who) return reply.code(401).send({ error: "Sign in to Ensemble first." });
    request.userId = who.userId;
    request.authVia = who.via;
    request.tokenScope = who.tokenScope;
    request.tokenId = who.tokenId;
    request.modules = who.modules ?? "code";
    const denied = readOnlyTokenRejected(who.tokenScope, request.method, path) ?? deviceTokenRejected(who.tokenScope, request.method, path);
    if (denied) return reply.code(403).send({ error: denied });
  });
}

async function sessionFor(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { id: sha256(raw), userId, expiresAt: new Date(Date.now() + 86_400_000), modules: "code" } });
  return raw;
}

async function keyFor(userId: string, scope: "device" | "full"): Promise<{ token: string; id: string }> {
  const token = `ens_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.apiToken.create({ data: { userId, name: `test ${scope}`, tokenHash: sha256(token), prefix: token.slice(0, 8), scope } });
  return { token, id: row.id };
}

/** A passkey in software: registers and signs like a platform authenticator with user verification. */
function softwarePasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  const id = isoBase64URL.fromBuffer(credentialId);
  const rpHash = createHash("sha256").update(RP_ID).digest();
  let count = 0;
  const client = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    id,
    register(challenge: string) {
      const cose = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x)],
        [-3, isoBase64URL.toBuffer(jwk.y)],
      ]);
      const counter = Buffer.alloc(4);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), counter, Buffer.alloc(16), length, credentialId, Buffer.from(isoCBOR.encode(cose as never))]);
      const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]) as never);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: isoBase64URL.fromBuffer(client("webauthn.create", challenge)), attestationObject: isoBase64URL.fromBuffer(attestation), transports: ["internal"] },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    sign(challenge: string) {
      count += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counter]);
      const clientData = client("webauthn.get", challenge);
      const signer = createSign("SHA256");
      signer.update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]));
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: isoBase64URL.fromBuffer(clientData), authenticatorData: isoBase64URL.fromBuffer(authData), signature: isoBase64URL.fromBuffer(signer.sign(privateKey)) },
        clientExtensionResults: {},
      };
    },
  };
}

function cookiesOf(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.map((value) => value.split(";")[0]).join("; ");
}

test("the web's Code tab and terminal reach the owner's computer only, through its own answers and a passkey", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const user = await prisma.user.create({ data: { email: `code-web-${stamp}@ensemble.test`, name: "Code", passwordHash: await hashPassword("right password"), emailVerifiedAt: new Date() } });
  const other = await prisma.user.create({ data: { email: `code-web-other-${stamp}@ensemble.test`, name: "Other", emailVerifiedAt: new Date() } });
  const deviceKey = await keyFor(user.id, "device");
  const fullKey = await keyFor(user.id, "full");
  const device = await prisma.device.create({
    data: { userId: user.id, name: "Studio Mac", platform: "darwin", appVersion: "0.3.8", tokenId: deviceKey.id, lastSeenAt: new Date(), capabilities: { code: true, browseFiles: true, webEdit: true, webTerminal: true } },
  });
  const oldKey = await keyFor(user.id, "device");
  const old = await prisma.device.create({ data: { userId: user.id, name: "Old Mac", platform: "darwin", appVersion: "0.3.7", tokenId: oldKey.id, lastSeenAt: new Date(), capabilities: { browseFiles: true } } });
  const redis = memoryRedis();
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", redis as never);
  install(app);
  await app.register(deviceRoutes);
  await app.register(deviceCodeRoutes);
  const session = await sessionFor(user.id);
  const otherSession = await sessionFor(other.id);
  const browser = (extra: Record<string, string> = {}) => ({ cookie: `ensemble_session=${session}`, origin: ORIGIN, ...extra });
  const asDevice = { authorization: `Bearer ${deviceKey.token}` };

  // The simulated computer: answers what it hears on its stream, with its device key.
  const heard: Array<{ event: string; data: Record<string, unknown> }> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${device.id}`) return;
    const data = frame.data as Record<string, unknown> & { id: string };
    heard.push({ event: frame.event, data });
    setTimeout(async () => {
      if (frame.event === "code.request") {
        await app.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, headers: asDevice, payload: { status: 200, body: { echo: { method: data.method, path: data.path, query: data.query } } } });
      }
      if (frame.event === "terminal.request" && data.op === "status") {
        await app.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, headers: asDevice, payload: { status: 200, body: { roots: ["/work"], home: "/work" } } });
      }
      if (frame.event === "terminal.request" && data.op === "run") {
        await app.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, headers: asDevice, payload: { status: 202, body: { runId: data.id } } });
        await app.inject({ method: "POST", url: `/api/devices/self/terminal-runs/${data.id}/output`, headers: asDevice, payload: { seq: 0, text: "On branch main\n" } });
        await app.inject({ method: "POST", url: `/api/devices/self/terminal-runs/${data.id}/output`, headers: asDevice, payload: { seq: 1, text: "", done: true, exitCode: 0 } });
      }
    }, 10);
  });
  const code = (headers: Record<string, string>, payload: unknown, id = device.id) => app.inject({ method: "POST", url: `/api/devices/${id}/code`, headers, payload: payload as object });

  try {
    // A Code call goes to the computer and comes back as its answer.
    const reviews = await code(browser(), { method: "GET", path: "/api/code/reviews", query: { filter: "all" } });
    assert.equal(reviews.statusCode, 200, reviews.body);
    assert.deepEqual((reviews.json() as { echo: unknown }).echo, { method: "GET", path: "/api/code/reviews", query: { filter: "all" } });
    assert.equal(heard[0]!.event, "code.request");

    // Only a signed-in browser on Ensemble's page, only the owner, only listed calls.
    assert.equal((await code({ authorization: `Bearer ${fullKey.token}`, origin: ORIGIN }, { method: "GET", path: "/api/code/reviews" })).statusCode, 403, "an API key is refused");
    assert.equal((await code(browser({ origin: "https://evil.example" }), { method: "GET", path: "/api/code/reviews" })).statusCode, 403, "another page is refused");
    assert.equal((await code({ cookie: `ensemble_session=${otherSession}`, origin: ORIGIN }, { method: "GET", path: "/api/code/reviews" })).statusCode, 404, "someone else's computer");
    assert.equal((await code(browser(), { method: "POST", path: "/api/code/folders/resolve", body: { path: "/" } })).statusCode, 403);
    assert.equal((await code(browser(), { method: "GET", path: "/api/terminal/status" })).statusCode, 403);
    const before = heard.length;
    assert.match((await code(browser(), { method: "GET", path: "/api/code/reviews" }, old.id)).body, /CLI 0\.3\.8/, "an older computer is asked to update");
    assert.equal(heard.length, before, "refused calls never reach the computer");

    // The computer's own switches, as it reports them, stop writes before they are sent.
    await prisma.device.update({ where: { id: device.id }, data: { capabilities: { code: true, browseFiles: true, webEdit: false, webTerminal: true } } });
    const commit = await code(browser(), { method: "POST", path: "/api/code/scm/commit", body: { repo: "/work/r", message: "m" } });
    assert.equal(commit.statusCode, 409);
    assert.match(commit.body, /ensemble web edit on/);
    await prisma.device.update({ where: { id: device.id }, data: { capabilities: { code: true, browseFiles: true, webEdit: true, webTerminal: true } } });
    const saved = await code(browser(), { method: "PUT", path: "/api/code/file", body: { repo: "/work/r", path: "a.ts", content: "x" } });
    assert.equal(saved.statusCode, 200);
    assert.ok(await prisma.auditLedger.findFirst({ where: { userId: user.id, action: "code.web" } }), "a change from the web is in the ledger");

    // A computer from before the IDE's calls (0.3.8) is asked to update for them; its first calls still work.
    await prisma.device.update({ where: { id: device.id }, data: { capabilities: { code: true, browseFiles: true, webEdit: true, webTerminal: true } } });
    const older = await code(browser(), { method: "GET", path: "/api/code/versions", query: { repo: "/work/r", path: "a.ts" } });
    assert.equal(older.statusCode, 409);
    assert.match(older.body, /CLI 0\.3\.9/);
    assert.equal((await code(browser(), { method: "GET", path: "/api/code/reviews" })).statusCode, 200);
    await prisma.device.update({ where: { id: device.id }, data: { capabilities: { code: true, codeApi: 2, browseFiles: true, webEdit: true, webTerminal: true } } });
    assert.equal((await code(browser(), { method: "GET", path: "/api/code/versions", query: { repo: "/work/r", path: "a.ts" } })).statusCode, 200);

    // Offline: a clear refusal, nothing sent.
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
    assert.match((await code(browser(), { method: "GET", path: "/api/code/reviews" })).body, /offline/);
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

    // The terminal is locked until a passkey unlocks it.
    const terminal = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: `/api/devices/${device.id}/terminal`, headers, payload: payload as object });
    assert.equal((await terminal(browser(), { op: "status" })).statusCode, 401);
    const status = await app.inject({ method: "GET", url: "/api/web-terminal/status", headers: browser() });
    assert.deepEqual((status.json() as { unlocked: boolean; passkeys: unknown[]; password: boolean }).unlocked, false);

    // Adding a passkey needs the password (or a mailed code), and only from the page in a browser.
    assert.equal((await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/options", headers: { authorization: `Bearer ${fullKey.token}`, origin: ORIGIN }, payload: { password: "right password" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/options", headers: browser(), payload: { password: "wrong" } })).statusCode, 403);
    const passkey = softwarePasskey();
    const registration = await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/options", headers: browser(), payload: { password: "right password" } });
    assert.equal(registration.statusCode, 200, registration.body);
    const added = await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/verify", headers: browser(), payload: { response: passkey.register((registration.json() as { challenge: string }).challenge), label: "Test key" } });
    assert.equal(added.statusCode, 200, added.body);

    // Unlock: a fresh challenge signed by the passkey.
    const unlockOptions = await app.inject({ method: "POST", url: "/api/web-terminal/unlock/options", headers: browser(), payload: {} });
    const unlocked = await app.inject({ method: "POST", url: "/api/web-terminal/unlock/verify", headers: browser(), payload: { response: passkey.sign((unlockOptions.json() as { challenge: string }).challenge) } });
    assert.equal(unlocked.statusCode, 200, unlocked.body);
    const lockCookie = cookiesOf(unlocked);
    assert.match(lockCookie, /ensemble_web_terminal=/);
    assert.match(String(unlocked.headers["set-cookie"]), /HttpOnly/);
    const open = (extra: Record<string, string> = {}) => browser({ cookie: `ensemble_session=${session}; ${lockCookie}`, ...extra });
    assert.equal(((await app.inject({ method: "GET", url: "/api/web-terminal/status", headers: open() })).json() as { unlocked: boolean }).unlocked, true);
    // The unlock is this browser's: the same cookie with an API key is still refused.
    assert.equal((await terminal({ authorization: `Bearer ${fullKey.token}`, origin: ORIGIN, cookie: lockCookie }, { op: "status" })).statusCode, 403);

    const there = await terminal(open(), { op: "status" });
    assert.deepEqual(there.json(), { roots: ["/work"], home: "/work" });
    // A browser leaves Origin off a same-origin GET: the output still reads; another page's Origin never does.
    const { origin: _origin, ...sameOrigin } = open();
    void _origin;
    assert.equal((await app.inject({ method: "GET", url: "/api/web-terminal/status", headers: sameOrigin })).statusCode, 200);
    const started = await terminal(open(), { op: "run", cwd: "/work", line: "git status" });
    assert.equal(started.statusCode, 202, started.body);
    const runId = (started.json() as { runId: string }).runId;
    let after = -1;
    let text = "";
    for (let i = 0; i < 10; i += 1) {
      const out = await app.inject({ method: "GET", url: `/api/devices/${device.id}/terminal/output?run=${runId}&after=${after}`, headers: sameOrigin });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as { chunks: Array<{ seq: number; text: string }>; done: boolean; exitCode: number | null };
      for (const chunk of body.chunks) {
        text += chunk.text;
        after = chunk.seq;
      }
      if (body.done) {
        assert.equal(body.exitCode, 0);
        break;
      }
    }
    assert.equal(text, "On branch main\n");
    assert.equal((await app.inject({ method: "GET", url: `/api/devices/${device.id}/terminal/output?run=${runId}&after=-1`, headers: open({ origin: "https://evil.example" }) })).statusCode, 403);
    assert.equal((await terminal({ ...sameOrigin }, { op: "status" })).statusCode, 403, "a change without the page's Origin is refused");
    assert.ok(await prisma.auditLedger.findFirst({ where: { userId: user.id, action: "terminal.web.run" } }));
    // Another computer cannot post into this run's output.
    const stray = await app.inject({ method: "POST", url: `/api/devices/self/terminal-runs/${runId}/output`, headers: { authorization: `Bearer ${oldKey.token}` }, payload: { seq: 2, text: "x" } });
    assert.equal(stray.statusCode, 410);

    // Lock now: the cookie no longer opens anything.
    await app.inject({ method: "POST", url: "/api/web-terminal/lock", headers: open(), payload: {} });
    assert.equal((await terminal(open(), { op: "status" })).statusCode, 401);

    // An account with no password confirms a new passkey with a code mailed to it.
    const mailed: string[] = [];
    setMailSenderForTests(async (message) => {
      mailed.push(message.subject);
    });
    const noPassword = { cookie: `ensemble_session=${otherSession}`, origin: ORIGIN };
    const sent = await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/code", headers: noPassword, payload: {} });
    assert.equal(sent.statusCode, 200, sent.body);
    const mailedCode = mailed[0]?.match(/([A-Z0-9]{6})$/)?.[1] ?? "";
    assert.equal((await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/options", headers: noPassword, payload: { code: "WRONG1" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/web-terminal/passkeys/options", headers: noPassword, payload: { code: mailedCode } })).statusCode, 200);
  } finally {
    stop();
    setMailSenderForTests(null);
    await app.close();
    for (const id of [user.id, other.id]) {
      await prisma.terminalPasskey.deleteMany({ where: { userId: id } });
      await prisma.auditLedger.deleteMany({ where: { userId: id } });
      await prisma.device.deleteMany({ where: { userId: id } });
      await prisma.apiToken.deleteMany({ where: { userId: id } });
      await prisma.session.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
  }
});
