/**
 * Module gate against Postgres. Cookie, bearer, and internal header.
 * Skips when the database is down.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { BadPathError, MODULE_DENIED, moduleDenied, normalizePath } from "@ensemble/shared-types";
import { enforceRouteModule } from "./lib/module-gate.js";
import "./config.js";
import { env } from "./config.js";
import { identify, newApiToken, sha256 } from "./lib/auth.js";
import { prisma } from "./lib/prisma.js";
import "./types.js";

const PATHS = [
  ["GET", "/api/code/repos"],
  ["POST", "/api/code/decide"],
  ["GET", "/api/code/file"],
  ["POST", "/api/code/scm/commit"],
  ["POST", "/api/terminal/run"],
  ["GET", "/api/terminal/status"],
  ["GET", "/api/workspace"],
  ["GET", "/api/workspace/checkouts"],
  ["POST", "/api/agent/assign"],
  ["GET", "/api/agent/state"],
  ["POST", "/api/agent/pause"],
  ["POST", "/api/activity/job/stop"],
  ["GET", "/api/runs"],
  ["DELETE", "/api/runs/job"],
  ["GET", "/api/metrics/summary"],
  ["POST", "/api/ledger/verify"],
  ["GET", "/api/skills"],
  ["POST", "/api/skills"],
  ["GET", "/api/bridge/skills"],
  ["GET", "/api/bridge/skills/one"],
];

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function gatedApp() {
  const app = Fastify();
  let writes = 0;
  app.addHook("onRequest", async (request, reply) => {
    const who = await identify(request);
    if (!who) return reply.code(401).send({ error: "Sign in." });
    request.userId = who.userId;
    request.authVia = who.via;
    request.modules = who.modules;
    let path: string;
    try {
      path = normalizePath(request.url);
    } catch (error) {
      if (error instanceof BadPathError) return reply.code(400).send({ error: "Malformed path." });
      throw error;
    }
    if (moduleDenied(path, who.modules)) return reply.code(404).send({ error: MODULE_DENIED });
  });
  app.addHook("preHandler", enforceRouteModule);
  const ok = async () => ({ ok: true });
  const wrote = async () => {
    writes += 1;
    return { ok: true, writes };
  };
  app.get("/api/skills", ok);
  app.post("/api/skills", wrote);
  app.get("/api/code/reviews", ok);
  app.get("/api/runs", ok);
  app.get("/api/bridge/skills", ok);
  app.get("/api/bridge/read", ok);
  app.all("/*", ok);
  return { app, writes: () => writes };
}

test("removed modules 404 for cookie, bearer, and internal, and core routes stay open", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await prisma.user.create({
    data: { email: `mod-${Date.now()}@ensemble.test`, name: "Closed", moduleSet: "" },
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { id: sha256(token), userId: owner.id, expiresAt: new Date(Date.now() + 60_000), modules: "" },
  });
  const api = newApiToken();
  await prisma.apiToken.create({
    data: { userId: owner.id, name: "hook", tokenHash: api.hash, prefix: api.prefix, scope: "full" },
  });
  const gated = await gatedApp();
  const app = gated.app;
  const vias = [
    { name: "cookie", headers: { cookie: `ensemble_session=${token}` } },
    { name: "bearer", headers: { authorization: `Bearer ${api.token}` } },
    { name: "internal", headers: { "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN, "x-ensemble-user": owner.id } },
  ];
  try {
    for (const via of vias) {
      for (const [method, url] of PATHS) {
        const response = await app.inject({ method: method as "GET", url, headers: via.headers });
        assert.equal(response.statusCode, 404, `${via.name} ${method} ${url}`);
        assert.equal((response.json() as { error: string }).error, MODULE_DENIED);
      }
      const home = await app.inject({ method: "GET", url: "/api/today/home", headers: via.headers });
      assert.equal(home.statusCode, 200, via.name);
      const disguised = [
        ["GET", "/api/%73kills"],
        ["POST", "/api/%73kills"],
        ["GET", "/api/%2573kills"],
        ["GET", "/API/SKILLS"],
        ["GET", "//api//skills"],
        ["GET", "/api/skills/"],
        ["GET", "/api/./skills"],
        ["GET", "/api/skills;x"],
        ["GET", "/api/skills?x=1"],
        ["GET", "/api/%63ode/reviews"],
        ["GET", "/api/run%73"],
        ["GET", "/api/skills/../skills"],
      ] as const;
      for (const [method, url] of disguised) {
        const response = await app.inject({ method, url, headers: via.headers });
        assert.equal(response.statusCode, 404, `${via.name} ${method} ${url}`);
        assert.equal((response.json() as { error: string }).error, MODULE_DENIED);
      }
      const broken = await app.inject({ method: "GET", url: "/api/%", headers: via.headers });
      assert.equal(broken.statusCode, 400, via.name);
    }
    assert.equal(gated.writes(), 0);
    const open = await prisma.user.create({
      data: { email: `mod-open-${Date.now()}@ensemble.test`, name: "Open" },
    });
    const openToken = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: {
        id: sha256(openToken),
        userId: open.id,
        expiresAt: new Date(Date.now() + 60_000),
        modules: "code,metrics,runs,skills,workspace",
      },
    });
    const allowed = await app.inject({ method: "GET", url: "/api/code/repos", headers: { cookie: `ensemble_session=${openToken}` } });
    assert.equal(allowed.statusCode, 200);
    const encodedOpen = await app.inject({ method: "GET", url: "/api/%73kills", headers: { cookie: `ensemble_session=${openToken}` } });
    assert.equal(encodedOpen.statusCode, 200);
    await prisma.session.deleteMany({ where: { userId: open.id } });
    await prisma.user.delete({ where: { id: open.id } });
  } finally {
    await app.close();
    await prisma.apiToken.deleteMany({ where: { userId: owner.id } });
    await prisma.session.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});

async function sessionFor(label: string, modules: string) {
  const owner = await prisma.user.create({
    data: { email: `mod-${label}-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: label, moduleSet: modules },
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { id: sha256(token), userId: owner.id, expiresAt: new Date(Date.now() + 60_000), modules },
  });
  return { owner, headers: { cookie: `ensemble_session=${token}` } };
}

test("diagrams off closes diagram paths and keeps code; code off keeps diagrams and closes repo reads", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const gated = await gatedApp();
  const app = gated.app;
  const noDiagrams = await sessionFor("nodiagrams", "code,metrics,runs,skills,workspace");
  const noCode = await sessionFor("nocode", "diagrams,metrics,runs,skills,workspace");
  const status = async (headers: Record<string, string>, method: string, url: string) =>
    (await app.inject({ method: method as "GET", url, headers })).statusCode;
  try {
    const diagramPaths = [
      ["GET", "/diagrams"],
      ["GET", "/diagrams/abc"],
      ["GET", "/api/diagrams"],
      ["POST", "/api/diagrams"],
      ["GET", "/api/diagrams/links"],
      ["GET", "/api/%64iagrams"],
      ["GET", "/api/bridge/diagrams/abc"],
    ];
    const repoReadPaths = [
      ["GET", "/api/themes/search"],
      ["GET", "/api/bridge/repos/abc/overview"],
      ["GET", "/api/bridge/repos/abc/file"],
      ["GET", "/api/code/repos"],
    ];
    for (const [method, url] of diagramPaths) {
      assert.equal(await status(noDiagrams.headers, method, url), 404, `diagrams off ${method} ${url}`);
      assert.equal(await status(noCode.headers, method, url), 200, `code off ${method} ${url}`);
    }
    for (const [method, url] of repoReadPaths) {
      assert.equal(await status(noDiagrams.headers, method, url), 200, `diagrams off ${method} ${url}`);
      assert.equal(await status(noCode.headers, method, url), 404, `code off ${method} ${url}`);
    }
    for (const headers of [noDiagrams.headers, noCode.headers]) {
      assert.equal(await status(headers, "GET", "/api/bridge/repos"), 200);
      assert.equal(await status(headers, "GET", "/api/today/home"), 200);
    }
  } finally {
    await app.close();
    const ids = [noDiagrams.owner.id, noCode.owner.id];
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
