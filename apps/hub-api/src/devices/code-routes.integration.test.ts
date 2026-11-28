/**
 * The Code tab and terminal on Ensemble on the web for a paired computer (protocol 4), against
 * Postgres: only the computer's owner in a signed-in browser, only listed calls, the computer's own
 * switches, and a terminal that opens for that browser session with no other step. The computer is
 * simulated: it hears frames on its event stream and answers through its own routes with its device key.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { deviceTokenRejected, readOnlyTokenRejected } from "../bridge/auth.js";
import { identify, sha256 } from "../lib/auth.js";
import { memoryRedis } from "../lib/memory-redis.js";
import { prisma } from "../lib/prisma.js";
import { sseHub } from "../lib/sse.js";
import "../types.js";
import { deviceCodeRoutes } from "./code-routes.js";
import { deviceRoutes } from "./routes.js";

const ORIGIN = (process.env.HUB_WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");

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
    const code = (error as { code?: string }).code;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
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

test("the web's Code tab and terminal reach the owner's computer only, through its own answers, for the signed-in browser", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const user = await prisma.user.create({ data: { email: `code-web-${stamp}@ensemble.test`, name: "Code", emailVerifiedAt: new Date() } });
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

    // The terminal opens for the signed-in browser at once: no passkey, no code, no unlock.
    const terminal = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: `/api/devices/${device.id}/terminal`, headers, payload: payload as object });
    const open = (extra: Record<string, string> = {}) => browser(extra);
    // Keys, bridge and device tokens are refused, even naming the page; so is another page.
    assert.equal((await terminal({ authorization: `Bearer ${fullKey.token}`, origin: ORIGIN }, { op: "status" })).statusCode, 403, "an API key is refused");
    assert.equal((await terminal({ ...asDevice, origin: ORIGIN }, { op: "status" })).statusCode, 403, "the computer's own key is refused");
    assert.equal((await terminal(browser({ origin: "https://evil.example" }), { op: "status" })).statusCode, 403, "another page is refused");
    // The unlock and passkey routes are gone.
    for (const url of ["/api/web-terminal/status", "/api/web-terminal/unlock/options", "/api/web-terminal/passkeys/options"]) {
      assert.equal((await app.inject({ method: url.endsWith("status") ? "GET" : "POST", url, headers: browser(), payload: url.endsWith("status") ? undefined : {} })).statusCode, 404, url);
    }

    const there = await terminal(open(), { op: "status" });
    assert.deepEqual(there.json(), { roots: ["/work"], home: "/work" });
    // A browser leaves Origin off a same-origin GET: the output still reads; another page's Origin never does.
    const { origin: _origin, ...sameOrigin } = open();
    void _origin;
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

  } finally {
    stop();
    await app.close();
    for (const id of [user.id, other.id]) {
      await prisma.auditLedger.deleteMany({ where: { userId: id } });
      await prisma.device.deleteMany({ where: { userId: id } });
      await prisma.apiToken.deleteMany({ where: { userId: id } });
      await prisma.session.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
  }
});
