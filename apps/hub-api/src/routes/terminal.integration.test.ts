/**
 * The human-only terminal against Postgres, end to end: the person's signed-in browser session runs a
 * command at once, and API keys and other pages are refused. Skips when the database is down.
 *
 * The streamed `run` response (hijacked, so its headers are written by hand) carries `Vary: Origin`
 * exactly once, like every other hijacked stream.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { env } from "../config.js";
import { identify, sha256 } from "../lib/auth.js";
import { corsPluginOptions } from "../lib/cors-origin.js";
import { hubCorsPolicy } from "../lib/hub-cors.js";
import { prisma } from "../lib/prisma.js";
import { saveSettings } from "../lib/settings.js";
import "../types.js";
import { workspaceRoot } from "../workspace/guard.js";
import { terminalRoutes } from "./terminal.js";

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

async function cleanup(userId: string): Promise<void> {
  await prisma.apiToken.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function signedIn() {
  const user = await prisma.user.create({
    data: { email: `terminal-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Terminal" },
  });
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { id: sha256(raw), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), modules: MODULES } });
  await saveSettings(prisma, user.id, { terminal: { enabled: true } });
  return { user, session: `ensemble_session=${raw}` };
}

const page = env.HUB_WEB_ORIGIN.replace(/\/$/, "");

test("the signed-in browser runs a command at once, the stream varies on Origin, and nothing else gets in", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  assert.equal(new URL(page).hostname, "localhost", `this test needs HUB_WEB_ORIGIN on localhost, got ${page}`);
  const { user, session } = await signedIn();
  const app = await build();
  const port = (app.server.address() as AddressInfo).port;
  try {
    const human = { cookie: session, origin: page };

    // No set-up step: the session opens the terminal.
    const status = await call(port, "GET", "/api/terminal/status", human);
    assert.equal(status.status, 200, status.body);
    assert.deepEqual(Object.keys(JSON.parse(status.body)).sort(), ["enabled", "home", "roots"]);
    const cd = await call(port, "POST", "/api/terminal/cd", human, { cwd: await workspaceRoot(), path: "." });
    assert.equal(cd.status, 200, cd.body);

    // The real stream: hijacked, headers written by hand.
    const run = await call(port, "POST", "/api/terminal/run", human, { cwd: await workspaceRoot(), line: "ls" });
    assert.equal(run.status, 200, run.body);
    assert.match(String(run.headers["content-type"]), /^text\/plain/);
    assert.ok(run.body.endsWith("\u00000"), `run finished with exit 0: ${JSON.stringify(run.body.slice(-200))}`);
    assertVaryOrigin(run.headers, "streamed run");
    assert.equal(run.headers["access-control-allow-origin"], page);
    assert.equal(run.headers["access-control-allow-credentials"], "true");

    // Refused at humanOnly (no Origin, or another site): no stream.
    for (const origin of [undefined, "https://evil.example"]) {
      const headers: Record<string, string> = { cookie: session };
      if (origin) headers.origin = origin;
      const refused = await call(port, "POST", "/api/terminal/run", headers, { cwd: await workspaceRoot(), line: "ls" });
      assert.equal(refused.status, 403, `${origin}: ${refused.body}`);
      assert.equal(errorOf(refused), "The terminal only accepts requests from the Ensemble page itself.", String(origin));
      assert.equal(refused.headers["access-control-allow-origin"], undefined, String(origin));
    }

    // An API key of the same person, even naming the page, is not a browser session.
    const raw = `ens_${randomBytes(24).toString("base64url")}`;
    await prisma.apiToken.create({ data: { userId: user.id, name: "terminal test", tokenHash: sha256(raw), prefix: raw.slice(0, 8) } });
    for (const [path, body] of [["/api/terminal/run", { cwd: await workspaceRoot(), line: "ls" }], ["/api/terminal/cd", { cwd: await workspaceRoot(), path: "." }], ["/api/terminal/kill", {}]] as const) {
      const keyed = await call(port, "POST", path, { authorization: `Bearer ${raw}`, origin: page }, body);
      assert.equal(keyed.status, 403, `${path}: ${keyed.body}`);
      assert.equal(errorOf(keyed), "The terminal only opens from a signed-in browser. Tokens and agents are refused.", path);
    }
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});
