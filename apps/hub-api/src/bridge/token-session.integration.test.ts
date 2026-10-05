/**
 * Personal-token minting against Postgres. Skips when the database is down.
 * Loaded without DATABASE_URL, this file does not import the API config.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AuthVia } from "../lib/auth.js";
import { BROWSER_SESSION_REQUIRED, readOnlyTokenRejected } from "./auth.js";

type Loaded = {
  prisma: typeof import("../lib/prisma.js").prisma;
  identify: typeof import("../lib/auth.js").identify;
  newApiToken: typeof import("../lib/auth.js").newApiToken;
  sha256: typeof import("../lib/auth.js").sha256;
  env: typeof import("../config.js").env;
  authRoutes: typeof import("../routes/auth.js").authRoutes;
  connectRoutes: typeof import("../routes/connect.js").connectRoutes;
};

async function load(): Promise<Loaded | null> {
  if (!process.env.DATABASE_URL) return null;
  const [{ prisma }, auth, { env }, { authRoutes }, { connectRoutes }] = await Promise.all([
    import("../lib/prisma.js"),
    import("../lib/auth.js"),
    import("../config.js"),
    import("../routes/auth.js"),
    import("../routes/connect.js"),
  ]);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return null;
  }
  return { prisma, identify: auth.identify, newApiToken: auth.newApiToken, sha256: auth.sha256, env, authRoutes, connectRoutes };
}

function installErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
}

async function mintingApp(api: Loaded): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("prisma", api.prisma);
  installErrors(app);
  app.addHook("onRequest", async (request, reply) => {
    const who = await api.identify(request);
    if (!who) return reply.code(401).send({ error: "Sign in to Ensemble first." });
    request.userId = who.userId;
    request.authVia = who.via;
    request.tokenScope = who.tokenScope;
    request.modules = who.modules;
    const denied = readOnlyTokenRejected(who.tokenScope, request.method, request.url);
    if (denied) return reply.code(403).send({ error: denied });
  });
  app.get("/api/bridge/today", async () => ({ ok: true }));
  await app.register(api.authRoutes);
  await app.register(api.connectRoutes);
  return app;
}

/** Bypass is a process-wide flag. This app sets the via the way identify does, without flipping it. */
async function viaApp(api: Loaded, userId: string, via: AuthVia): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("prisma", api.prisma);
  installErrors(app);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
    request.authVia = via;
    request.modules = null;
  });
  await app.register(api.authRoutes);
  return app;
}

async function user(api: Loaded, label: string) {
  return api.prisma.user.create({
    data: { email: `token-${label}-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: label },
  });
}

async function cleanup(api: Loaded, userId: string) {
  await api.prisma.apiToken.deleteMany({ where: { userId } });
  await api.prisma.session.deleteMany({ where: { userId } });
  await api.prisma.auditLedger.deleteMany({ where: { userId } });
  await api.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("a personal token cannot mint a key; a session still can", async (t) => {
  const api = await load();
  if (!api) return t.skip("Postgres is not reachable");
  const owner = await user(api, "session");
  const cookie = randomBytes(32).toString("base64url");
  await api.prisma.session.create({
    data: { id: api.sha256(cookie), userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  const full = api.newApiToken();
  await api.prisma.apiToken.create({
    data: { userId: owner.id, name: "hook", tokenHash: full.hash, prefix: full.prefix, scope: "full" },
  });
  const app = await mintingApp(api);
  try {
    const minted = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${full.token}` },
      payload: { name: "escalated" },
    });
    assert.equal(minted.statusCode, 403);
    assert.equal(minted.json().error, BROWSER_SESSION_REQUIRED);
    const connect = await app.inject({
      method: "POST",
      url: "/api/connect/token",
      headers: { authorization: `Bearer ${full.token}` },
      payload: { name: "escalated" },
    });
    assert.equal(connect.statusCode, 403);
    assert.equal(connect.json().error, BROWSER_SESSION_REQUIRED);
    const internal = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { "x-ensemble-internal": api.env.ENSEMBLE_INTERNAL_TOKEN, "x-ensemble-user": owner.id },
      payload: { name: "escalated" },
    });
    assert.equal(internal.statusCode, 403);
    assert.equal(internal.json().error, BROWSER_SESSION_REQUIRED);
    assert.equal(await api.prisma.apiToken.count({ where: { userId: owner.id } }), 1);

    const session = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: `ensemble_session=${cookie}` },
      payload: { name: "Editors" },
    });
    assert.equal(session.statusCode, 200);
    const created = session.json() as { id: string; token: string };
    assert.match(created.token, /^ens_/);
    const row = await api.prisma.apiToken.findUnique({ where: { id: created.id } });
    assert.equal(row?.scope, "full");
    assert.equal(row?.userId, owner.id);

    const bridgeKey = await app.inject({
      method: "POST",
      url: "/api/connect/token",
      headers: { cookie: `ensemble_session=${cookie}` },
      payload: { name: "Read-only" },
    });
    assert.equal(bridgeKey.statusCode, 200);
    assert.equal((await api.prisma.apiToken.findUnique({ where: { id: bridgeKey.json().id } }))?.scope, "bridge");

    const listed = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${full.token}` },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.stringify(listed.json()).includes(created.token), false);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: { authorization: `Bearer ${full.token}` },
    });
    assert.equal(revoked.statusCode, 204);
    assert.ok((await api.prisma.apiToken.findUnique({ where: { id: created.id } }))?.revokedAt);
  } finally {
    await app.close();
    await cleanup(api, owner.id);
  }
});

test("desktop and bypass can still create a token", async (t) => {
  const api = await load();
  if (!api) return t.skip("Postgres is not reachable");
  const desktopSecret = randomBytes(24).toString("base64url");
  const previous = process.env.ENSEMBLE_DESKTOP_TOKEN;
  process.env.ENSEMBLE_DESKTOP_TOKEN = desktopSecret;
  const desktopId = api.env.ENSEMBLE_DEV_USER_ID;
  const existingDesktop = await api.prisma.user.findUnique({ where: { id: desktopId } });
  const desktopUser = await api.prisma.user.upsert({
    where: { id: desktopId },
    create: { id: desktopId, email: `${desktopId}@ensemble.test`, name: "Desktop" },
    update: {},
  });
  const bypassId = `bypass-${randomBytes(4).toString("hex")}`;
  const app = await mintingApp(api);
  const bypass = await viaApp(api, bypassId, "bypass");
  try {
    const desktop = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${desktopSecret}` },
      payload: { name: "Desktop editors" },
    });
    assert.equal(desktop.statusCode, 200);
    assert.match((desktop.json() as { token: string }).token, /^ens_/);
    assert.equal((await api.prisma.apiToken.findFirst({ where: { userId: desktopUser.id, name: "Desktop editors" } }))?.scope, "full");

    const local = await bypass.inject({ method: "POST", url: "/api/tokens", payload: { name: "Local editors" } });
    assert.equal(local.statusCode, 200);
    assert.match((local.json() as { token: string }).token, /^ens_/);
    const stored = await api.prisma.user.findUnique({ where: { id: bypassId } });
    assert.equal(stored?.email, `${bypassId}@ensemble.local`);
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DESKTOP_TOKEN;
    else process.env.ENSEMBLE_DESKTOP_TOKEN = previous;
    await app.close();
    await bypass.close();
    await api.prisma.apiToken.deleteMany({ where: { userId: desktopUser.id, name: "Desktop editors" } });
    if (!existingDesktop) await cleanup(api, desktopUser.id);
    await cleanup(api, bypassId);
  }
});

test("an unknown token scope is rejected and a bridge key stays read-only", async (t) => {
  const api = await load();
  if (!api) return t.skip("Postgres is not reachable");
  const owner = await user(api, "scope");
  const unknown = api.newApiToken();
  const unknownRow = await api.prisma.apiToken.create({
    data: { userId: owner.id, name: "future", tokenHash: unknown.hash, prefix: unknown.prefix, scope: "future" },
  });
  const computer = api.newApiToken();
  await api.prisma.apiToken.create({
    data: { userId: owner.id, name: "computer", tokenHash: computer.hash, prefix: computer.prefix, scope: "device" },
  });
  const bridge = api.newApiToken();
  await api.prisma.apiToken.create({
    data: { userId: owner.id, name: "bridge", tokenHash: bridge.hash, prefix: bridge.prefix, scope: "bridge" },
  });
  const full = api.newApiToken();
  await api.prisma.apiToken.create({
    data: { userId: owner.id, name: "full", tokenHash: full.hash, prefix: full.prefix, scope: "full" },
  });
  const app = await mintingApp(api);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const who = await api.identify({ headers: bearer(unknown.token) } as Parameters<Loaded["identify"]>[0]);
    assert.equal(who, null);
    const rejected = await app.inject({ method: "POST", url: "/api/tokens", headers: bearer(unknown.token), payload: { name: "nope" } });
    assert.equal(rejected.statusCode, 401);
    assert.equal((await api.prisma.apiToken.findUnique({ where: { id: unknownRow.id } }))?.lastUsedAt, null);

    const deviceWho = await api.identify({ headers: bearer(computer.token) } as Parameters<Loaded["identify"]>[0]);
    assert.equal(deviceWho?.tokenScope, "device");
    const deviceMint = await app.inject({ method: "POST", url: "/api/tokens", headers: bearer(computer.token), payload: { name: "nope" } });
    assert.equal(deviceMint.statusCode, 403);
    assert.equal(deviceMint.json().error, BROWSER_SESSION_REQUIRED);

    const fullWho = await api.identify({ headers: bearer(full.token) } as Parameters<Loaded["identify"]>[0]);
    assert.equal(fullWho?.via, "token");
    assert.equal(fullWho?.tokenScope, "full");
    const bridgeWho = await api.identify({ headers: bearer(bridge.token) } as Parameters<Loaded["identify"]>[0]);
    assert.equal(bridgeWho?.tokenScope, "bridge");

    const write = await app.inject({ method: "POST", url: "/api/tokens", headers: bearer(bridge.token), payload: { name: "nope" } });
    assert.equal(write.statusCode, 403);
    assert.match(write.json().error, /read-only/);
    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: bearer(bridge.token) });
    assert.equal(list.statusCode, 403);
    assert.match(list.json().error, /read-only/);
    const read = await app.inject({ method: "GET", url: "/api/bridge/today", headers: bearer(bridge.token) });
    assert.equal(read.statusCode, 200);
    assert.equal(await api.prisma.apiToken.count({ where: { userId: owner.id, name: "nope" } }), 0);
  } finally {
    await app.close();
    await cleanup(api, owner.id);
  }
});
