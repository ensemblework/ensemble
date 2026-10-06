import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { APP_DYNAMIC_PREFIXES, APP_EXACT_ROUTES, isAppRoute } from "./app-routes";
import { middleware } from "../middleware";

const APP = join(import.meta.dirname, "../app");

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pageFiles(path, out);
    else if (name === "page.tsx") out.push(path);
  }
  return out;
}

function routeOf(file: string): string | null {
  const rel = relative(APP, file).replace(/\\/g, "/").replace(/(^|\/)page\.tsx$/, "");
  const parts = rel.split("/").filter((part) => part && !part.startsWith("("));
  if (parts.some((part) => part.startsWith("[..."))) return null;
  const route = `/${parts.map((part) => (part.startsWith("[") ? ":id" : part)).join("/")}`;
  return route === "/" ? "/" : route.replace(/\/$/, "");
}

test("the middleware route list matches the pages on disk", () => {
  const seen = new Set<string>();
  for (const file of pageFiles(APP)) {
    const route = routeOf(file);
    if (!route || route === "/missing") continue;
    seen.add(route);
    if (route.includes(":id")) {
      const prefix = route.slice(0, route.indexOf(":id"));
      assert.ok(APP_DYNAMIC_PREFIXES.includes(prefix), prefix);
      assert.equal(isAppRoute(`${prefix}abc`), true);
      assert.equal(isAppRoute(`${prefix}abc/more`), false);
    } else {
      assert.equal(isAppRoute(route), true, route);
    }
  }
  for (const route of APP_EXACT_ROUTES) assert.equal(seen.has(route), true, route);
  assert.equal(isAppRoute("/missing"), false);
  assert.equal(isAppRoute("/no-such-page"), false);
  assert.equal(isAppRoute("/code/nope"), false);
});

test("a signed-out unknown URL is the standalone 404, and a real page still asks for login", async () => {
  const unknown = await middleware(new NextRequest("http://localhost:3000/no-such-page"));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("location"), null);
  assert.match(unknown.headers.get("x-middleware-rewrite") ?? "", /\/missing$/);
  const today = await middleware(new NextRequest("http://localhost:3000/today"));
  assert.match(today.headers.get("location") ?? "", /\/login\?next=%2Ftoday$/);
});

test("recovery and verification pages work without a browser session", async () => {
  for (const path of ["/forgot", "/reset", "/verify"]) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
    assert.equal(response.headers.get("location"), null, path);
    assert.equal(response.headers.get("x-middleware-next"), "1", path);
  }
});

test("a signed-in data request for an unknown URL stays in the app", async () => {
  const response = await middleware(
    new NextRequest("http://localhost:3000/no-such-page", {
      headers: { rsc: "1", cookie: "ensemble_session=present" },
    }),
  );
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  const hub = readFileSync(join(APP, "(hub)/not-found.tsx"), "utf8");
  const shell = readFileSync(join(APP, "(hub)/lost/page.tsx"), "utf8");
  const catchAll = readFileSync(join(APP, "(hub)/[...slug]/page.tsx"), "utf8");
  assert.match(hub, /BrandStatus kind="404" shell/);
  assert.match(shell, /BrandStatus kind="404" shell/);
  assert.match(catchAll, /notFound\(\)/);
});

test("a signed-in document for an unknown URL is a 404 inside the hub", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ onboardingComplete: true, appearance: { accent: "violet", accentAt: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const response = await middleware(
      new NextRequest("http://localhost:3000/no-such-page", {
        headers: { cookie: "ensemble_session=present" },
      }),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("x-middleware-rewrite") ?? "", /\/lost$/);
    assert.match(response.headers.get("set-cookie") ?? "", /ensemble_accent=violet(?:@|%40)1/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a stale session on an unknown URL still goes to login", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
  try {
    const response = await middleware(
      new NextRequest("http://localhost:3000/no-such-page", {
        headers: { accept: "text/html", cookie: "ensemble_session=stale" },
      }),
    );
    assert.match(response.headers.get("location") ?? "", /\/login\?next=%2Fno-such-page$/);
  } finally {
    globalThis.fetch = original;
  }
});
