import assert from "node:assert/strict";
import test, { after } from "node:test";

// Deliberately unreachable account DB. This public endpoint must not resolve any identity.
process.env.DATABASE_URL = "postgresql://docs_test:docs_test@127.0.0.1:1/docs_test";
process.env.REDIS_URL = "memory://docs-test";
process.env.ENSEMBLE_DEV_AUTH_BYPASS = "false";
process.env.ENSEMBLE_DESKTOP = "0";
const { buildApp } = await import("../app.js");
const { prisma } = await import("../lib/prisma.js");
const { redis } = await import("../lib/redis.js");
const { corsPolicy } = await import("../lib/cors-origin.js");
const app = await buildApp({ logger: false, corsPolicy: corsPolicy("https://app.ensemblework.com", false), docsHelper: { dependencies: {
  admit: async () => 0,
  index: async () => ({ version: 1, pages: [{ title: "Tasks", path: "/tasks/", sections: [{ heading: "Assign a task", url: "https://docs.ensemblework.com/tasks/#assign", text: "Use Assign to start a task run." }] }] }),
  call: async () => JSON.stringify({ found: true, answer: "Use Assign to start a task run.", citations: [1] }),
} } });
after(async () => { await app.close(); await prisma.$disconnect(); await redis.quit(); });

test("public helper ignores account cookies, API keys and internal identity headers", async () => {
  for (const headers of [{}, { authorization: "Bearer ens_invalid", cookie: "ensemble_session=invalid", "x-ensemble-user": "private-account", "x-ensemble-internal": "invalid", "x-ensemble-share": "private-space" }]) {
    const response = await app.inject({ method: "POST", url: "/api/docs/ask", headers, payload: { question: "How do I assign a task?" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().found, true);
    assert.equal(response.headers["set-cookie"], undefined);
  }
});
test("CORS permits the docs POST without credentials and does not widen other routes", async () => {
  const allowed = await app.inject({ method: "OPTIONS", url: "/api/docs/ask", headers: { origin: "https://docs.ensemblework.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], "https://docs.ensemblework.com");
  assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
  const denied = await app.inject({ method: "GET", url: "/api/tasks", headers: { origin: "https://docs.ensemblework.com" } });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});
test("a public miss is a normal answer; arbitrary paths and oversized bodies stay rejected", async () => {
  const miss = await app.inject({ method: "POST", url: "/api/docs/ask", payload: { question: "zzzzquasar" } });
  assert.equal(miss.statusCode, 200);
  assert.equal(miss.json().found, false);
  assert.equal((await app.inject({ method: "POST", url: "/api/docs/ask/other", payload: { question: "task" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/docs/ask", payload: { question: "x".repeat(3000) } })).statusCode, 413);
});
