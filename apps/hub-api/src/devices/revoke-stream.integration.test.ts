/**
 * Removing a computer closes every open device event stream.
 * Postgres holds the device. Redis carries the notice to every hub-api process.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import "../config.js";
import { env } from "../config.js";
import { deviceTokenRejected, readOnlyTokenRejected } from "../bridge/auth.js";
import { identify, sha256 } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import "../types.js";
import { deviceRoutes } from "./routes.js";
import { DEVICE_REVOKED_CHANNEL, startDeviceRevokeBus, stopDeviceRevokeBus } from "./revoke-notify.js";

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
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    const who = await identify(request);
    if (!who) {
      if (path === "/api/devices/register") return;
      return reply.code(401).send({ error: "Sign in to Ensemble first." });
    }
    request.userId = who.userId;
    request.authVia = who.via;
    request.tokenScope = who.tokenScope;
    request.tokenId = who.tokenId;
    request.modules = who.modules ?? "code,diagrams,metrics,runs,skills,workspace";
    const denied = readOnlyTokenRejected(who.tokenScope, request.method, path) ?? deviceTokenRejected(who.tokenScope, request.method, path);
    if (denied) return reply.code(403).send({ error: denied });
  });
}

async function sessionFor(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      id: sha256(raw),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      modules: "code,diagrams,metrics,runs,skills,workspace",
    },
  });
  return raw;
}

async function cleanup(userId: string): Promise<void> {
  await prisma.devicePairing.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

const decoder = new TextDecoder();

type StreamChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, label: string): Promise<StreamChunk> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    reader.read().then(
      (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string, ready: (body: string) => boolean, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let body = text;
  while (!ready(body)) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error(`timed out with ${JSON.stringify(body)}`);
    const next = await readChunk(reader, remaining, `timed out with ${JSON.stringify(body)}`);
    if (next.done) throw new Error(`stream closed early: ${JSON.stringify(body)}`);
    body += decoder.decode(next.value, { stream: true });
  }
  return body;
}

test("revoking a device ends every open event stream", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const bus = await startDeviceRevokeBus();
  assert.equal(bus, true, "Redis pub/sub has to be up so other hub-api processes hear device.revoked");

  const heard: string[] = [];
  const side = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  side.on("error", () => {});
  side.on("message", (_channel, message) => {
    heard.push(message);
  });

  const user = await prisma.user.create({
    data: { email: `revoke-stream-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Revoke stream" },
  });
  const app = Fastify({ forceCloseConnections: true });
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  const session = await sessionFor(user.id);

  try {
    await side.connect();
    await side.subscribe(DEVICE_REVOKED_CHANNEL);

    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: { cookie: `ensemble_session=${session}` } });
    assert.equal(paired.statusCode, 201);
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: {} },
    });
    assert.equal(registered.statusCode, 201);
    const { token, device } = registered.json() as { token: string; device: { id: string } };

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const eventsUrl = `http://127.0.0.1:${address.port}/api/devices/self/events`;

    const open = async () => {
      const response = await fetch(eventsUrl, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body?.getReader();
      assert.ok(reader);
      const text = await readUntil(reader, "", (body) => body.includes(":\n\n"), 2_000);
      return { reader, text };
    };

    const streams = [await open(), await open()];
    const frame = `event: device.revoked\ndata: ${JSON.stringify({ deviceId: device.id, reason: "revoked" })}\n\n`;
    const started = Date.now();
    const closed = Promise.all(streams.map(async (stream) => {
      const deadline = started + 1_000;
      let body = stream.text;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const next = await readChunk(stream.reader, remaining, `stream stayed open: ${JSON.stringify(body)}`);
        if (next.done) return body;
        body += decoder.decode(next.value, { stream: true });
      }
      throw new Error(`stream stayed open: ${JSON.stringify(body)}`);
    }));
    const removed = await fetch(`http://127.0.0.1:${address.port}/api/devices/${device.id}`, {
      method: "DELETE",
      headers: { cookie: `ensemble_session=${session}` },
    });
    assert.equal(removed.status, 204);
    const bodies = await closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `stream closed in ${elapsed}ms`);
    for (const body of bodies) assert.ok(body.includes(frame), body);

    const payload = JSON.stringify({ deviceId: device.id, reason: "revoked" });
    const redisDeadline = Date.now() + 200;
    while (!heard.includes(payload) && Date.now() < redisDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(heard.includes(payload), `redis notice missing: ${JSON.stringify(heard)}`);

    const again = await fetch(eventsUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(again.status, 401);
  } finally {
    side.disconnect(false);
    await stopDeviceRevokeBus();
    await app.close();
    await cleanup(user.id);
  }
});
