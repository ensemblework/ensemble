import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness } from "./http.js";
import { collectRoutes, sampleRoutePath, sortedRoutes, type InventoryRoute } from "../lib/route-inventory.js";
import { corsPolicy } from "../lib/cors-origin.js";

const routes: InventoryRoute[] = [];
const harness = await createHttpHarness({ onRoute: collectRoutes("hosted", routes) });
const { buildApp } = await import("../app.js");
process.env.ENSEMBLE_DESKTOP = "1";
const desktopApp = await buildApp({ logger: false, onRoute: collectRoutes("desktop", routes), corsPolicy: corsPolicy("http://localhost:3000", true) });
await desktopApp.ready();
process.env.ENSEMBLE_DESKTOP = "0";
const user = await harness.asUser();
const device = await harness.asToken(user, "device");
const bridge = await harness.asToken(user, "bridge");
after(async () => {
  await desktopApp.close();
  await harness.close();
});

function appFor(route: InventoryRoute) {
  return route.mode === "hosted" ? harness.app : desktopApp;
}

function requestFor(route: InventoryRoute): InjectOptions {
  return { method: route.method, url: sampleRoutePath(route.path), headers: { host: "localhost" } };
}

for (const route of sortedRoutes(routes)) {
  if (route.auth === "identity" || route.auth === "internal-token" || route.auth === "event-ticket-or-identity") {
    test(`${route.mode}: unauthenticated ${route.method} ${route.path} is 401`, async () => {
      const response = await appFor(route).inject(requestFor(route));
      assert.equal(response.statusCode, 401, response.body);
    });
  }

  if (route.auth !== "cors-preflight") {
    const path = sampleRoutePath(route.path);
    const deviceAllowed = path === "/api/devices/self" || path.startsWith("/api/devices/self/");
    const bridgeAllowed =
      ((path === "/api/bridge" || path.startsWith("/api/bridge/")) && ["GET", "HEAD"].includes(route.method)) ||
      (path === "/mcp" && ["POST", "GET", "DELETE"].includes(route.method)) ||
      (path === "/api/cli/logout" && route.method === "POST");
    if (!deviceAllowed) {
      test(`${route.mode}: device scope denies ${route.method} ${route.path}`, async () => {
        const request = requestFor(route);
        const response = await appFor(route).inject({
          ...request, headers: { ...request.headers, authorization: `Bearer ${device.token}` },
        });
        assert.equal(response.statusCode, 403, response.body);
      });
    }
    if (!bridgeAllowed) {
      test(`${route.mode}: bridge scope denies ${route.method} ${route.path}`, async () => {
        const request = requestFor(route);
        const response = await appFor(route).inject({
          ...request, headers: { ...request.headers, authorization: `Bearer ${bridge.token}` },
        });
        assert.equal(response.statusCode, 403, response.body);
      });
    } else {
      test(`${route.mode}: bridge scope reaches read handler ${route.method} ${route.path}`, async () => {
        const request = requestFor(route);
        const token = path === "/api/cli/logout" ? (await harness.asToken(user, "bridge")).token : bridge.token;
        const response = await appFor(route).inject({
          ...request, headers: { ...request.headers, authorization: `Bearer ${token}` },
        });
        if (path === "/api/cli/logout") assert.equal(response.statusCode, 204, response.body);
        else assert.ok([200, 400, 404, 405, 406].includes(response.statusCode), `${response.statusCode}: ${response.body}`);
      });
    }
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) {
    test(`${route.mode}: malformed JSON or explicit policy rejection for ${route.method} ${route.path}`, async () => {
      const request = requestFor(route);
      const response = await appFor(route).inject({
        ...request,
        payload: '{"broken":',
        headers: {
          ...request.headers,
          cookie: user.cookie,
          "content-type": "application/json",
          ...(route.auth === "internal-token"
            ? { "x-ensemble-internal": process.env.ENSEMBLE_INTERNAL_TOKEN!, "x-ensemble-user": user.id }
            : {}),
        },
      });
      assert.ok([400, 401, 403, 405].includes(response.statusCode), `${response.statusCode}: ${response.body}`);
    });
  }
}

test("the checked-in route inventory exactly matches hosted and desktop registration", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../scripts/route-inventory.json", import.meta.url), "utf8"));
  assert.deepEqual(sortedRoutes(routes), snapshot, "Regenerate the inventory and review coverage for every changed route.");
  assert.ok(routes.some((route) => route.mode === "desktop" && route.path === "/api/remote"));
  assert.ok(!routes.some((route) => route.mode === "hosted" && route.path === "/api/remote"));
});

test("all CORS preflight routes are intentional unauthenticated exceptions", async () => {
  for (const route of routes.filter((entry) => entry.auth === "cors-preflight")) {
    const response = await appFor(route).inject({
      method: "OPTIONS",
      url: "/api/tasks",
      headers: { host: "localhost", origin: "http://localhost:3000", "access-control-request-method": "GET" },
    });
    assert.equal(response.statusCode, 204, response.body);
  }
});

test("expired and malformed session cookies do not turn auth failures into 500", async () => {
  const { SESSION_COOKIE, sha256 } = await import("../lib/auth.js");
  await harness.prisma.session.create({
    data: { id: sha256("expired-http-session"), userId: user.id, expiresAt: new Date(0), modules: null },
  });
  for (const cookie of [`${SESSION_COOKIE}=expired-http-session`, `${SESSION_COOKIE}=unknown-session`, `${SESSION_COOKIE}=%ZZ`]) {
    const response = await harness.app.inject({ method: "GET", url: "/api/tasks", headers: { cookie } });
    assert.equal(response.statusCode, 401, response.body);
  }
});

test("app factory does not listen or install process shutdown handlers", async () => {
  const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };
  const app = await buildApp({ logger: false });
  await app.ready();
  assert.equal(app.server.listening, false);
  assert.deepEqual({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") }, before);
  await app.close();
  const response = await user.inject({ method: "GET", url: "/api/tasks" });
  assert.equal(response.statusCode, 200, response.body);
});
