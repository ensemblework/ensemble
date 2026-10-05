import assert from "node:assert/strict";
import test from "node:test";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  allowOriginHeader,
  allowedOrigins,
  corsPluginOptions,
  corsPolicy,
  credentialedCorsHeaders,
  hijackedCorsHeaders,
  streamCorsHeaders,
  webOrigins,
  type CorsPolicy,
} from "./cors-origin.js";
import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";

test("localhost and 127.0.0.1 are both allowed for local dev", () => {
  const allowed = webOrigins("http://localhost:3000");
  assert.equal(allowOriginHeader("http://localhost:3000", allowed), "http://localhost:3000");
  assert.equal(allowOriginHeader("http://127.0.0.1:3000", allowed), "http://127.0.0.1:3000");
  assert.equal(allowOriginHeader("https://evil.example", allowed), undefined);
  assert.equal(allowOriginHeader(undefined, allowed), undefined);
});

test("credentialed CORS echoes only the allowlisted origin", () => {
  const allowed = webOrigins("https://app.example.com");
  assert.deepEqual(credentialedCorsHeaders("https://app.example.com", allowed), {
    "Access-Control-Allow-Origin": "https://app.example.com",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });
  assert.deepEqual(credentialedCorsHeaders("https://evil.example", allowed), {});
});

test("a public https origin is not widened to a star", () => {
  const allowed = webOrigins("https://hub.example");
  assert.equal(allowOriginHeader("https://hub.example", allowed), "https://hub.example");
  assert.equal(allowOriginHeader("http://hub.example", allowed), undefined);
  assert.equal(webOrigins("*").size, 0);
});

function withDesktopEnv<T>(value: string | undefined, run: () => T): T {
  const before = process.env.ENSEMBLE_DESKTOP;
  if (value === undefined) delete process.env.ENSEMBLE_DESKTOP;
  else process.env.ENSEMBLE_DESKTOP = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = before;
  }
}

test("desktop webview origins are allowed only when ENSEMBLE_DESKTOP=1", () => {
  const hosted = withDesktopEnv(undefined, () => allowedOrigins("https://app.example.com"));
  assert.deepEqual([...hosted].sort(), [...webOrigins("https://app.example.com")].sort());
  for (const origin of DESKTOP_WEBVIEW_ORIGINS) assert.equal(hosted.has(origin), false, origin);
  for (const value of ["0", "true", ""]) {
    const other = withDesktopEnv(value, () => allowedOrigins("https://app.example.com"));
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) assert.equal(other.has(origin), false, `${value} ${origin}`);
  }

  const desktop = withDesktopEnv("1", () => allowedOrigins("http://localhost:3000"));
  for (const origin of DESKTOP_WEBVIEW_ORIGINS) assert.equal(desktop.has(origin), true, origin);
  assert.equal(desktop.has("http://localhost:3000"), true);
  assert.equal(desktop.has("http://127.0.0.1:3000"), true);
  assert.equal(desktop.has("https://evil.example"), false);
  assert.equal(desktop.has("*"), false);
});

test("the explicit desktop flag wins over the environment", () => {
  const forcedOff = withDesktopEnv("1", () => allowedOrigins("http://localhost:3000", false));
  assert.equal(forcedOff.has("tauri://localhost"), false);
  const forcedOn = withDesktopEnv(undefined, () => allowedOrigins("http://localhost:3000", true));
  assert.equal(forcedOn.has("tauri://localhost"), true);
});

// Review note 1 on #76: hijacked streams send Vary: Origin whether or not the
// origin is allowed, the way @fastify/cors does, so a cache never mixes them.
const REFUSED_FOR_VARY: Array<string | string[] | undefined> = [
  "https://evil.example",
  "ensemble://localhost.evil.com",
  "http://tauri.localhost.evil.com",
  "null",
  "",
  undefined,
  ["tauri://localhost", "tauri://localhost"],
];

test("streamed responses always send Vary: Origin, for allowed and refused origins", () => {
  const desktop = corsPolicy("http://localhost:3000", true);
  for (const origin of [...DESKTOP_WEBVIEW_ORIGINS, "http://localhost:3000", "http://127.0.0.1:3000"]) {
    assert.deepEqual(
      streamCorsHeaders(origin, desktop),
      { Vary: "Origin", "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" },
      origin,
    );
  }
  for (const origin of REFUSED_FOR_VARY) {
    assert.deepEqual(streamCorsHeaders(origin, desktop), { Vary: "Origin" }, JSON.stringify(origin));
  }

  const hosted = corsPolicy("https://app.example.com", false);
  assert.deepEqual(streamCorsHeaders("https://app.example.com", hosted), {
    Vary: "Origin",
    "Access-Control-Allow-Origin": "https://app.example.com",
    "Access-Control-Allow-Credentials": "true",
  });
  for (const origin of [...DESKTOP_WEBVIEW_ORIGINS, ...REFUSED_FOR_VARY]) {
    assert.deepEqual(streamCorsHeaders(origin, hosted), { Vary: "Origin" }, JSON.stringify(origin));
  }
});

// Review note 2 on #76: desktop mode is read once, into one policy that both
// the plugin and the hijacked responses use.
test("the CORS policy reads ENSEMBLE_DESKTOP once and does not follow later changes", () => {
  const desktop = withDesktopEnv("1", () => corsPolicy("http://localhost:3000"));
  const hosted = withDesktopEnv(undefined, () => corsPolicy("http://localhost:3000"));
  assert.equal(desktop.desktop, true);
  assert.equal(hosted.desktop, false);
  withDesktopEnv(undefined, () => {
    assert.equal(desktop.origins.has("tauri://localhost"), true);
    assert.equal(streamCorsHeaders("tauri://localhost", desktop)["Access-Control-Allow-Origin"], "tauri://localhost");
  });
  withDesktopEnv("1", () => {
    assert.equal(hosted.origins.has("tauri://localhost"), false);
    assert.deepEqual(streamCorsHeaders("tauri://localhost", hosted), { Vary: "Origin" });
  });
  assert.equal(Object.isFrozen(desktop), true);
  assert.equal(withDesktopEnv("1", () => corsPolicy("http://localhost:3000", false)).desktop, false);
});

test("the running hub's policy is computed once per process and shared", async () => {
  // hub-cors.ts reads HUB_WEB_ORIGIN through config.js, which needs a DATABASE_URL string (never connected here).
  const before = { db: process.env.DATABASE_URL, web: process.env.HUB_WEB_ORIGIN };
  process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_cors_test";
  process.env.HUB_WEB_ORIGIN = "https://app.example.com";
  try {
    const { hubCorsPolicy } = await import("./hub-cors.js");
    const first = withDesktopEnv("1", () => hubCorsPolicy());
    assert.equal(first.desktop, true);
    assert.equal(first.origins.has("ensemble://localhost"), true);
    assert.equal(first.origins.has("https://app.example.com"), true);
    // Later env changes do not reach it: the plugin and the streams keep agreeing.
    const later = withDesktopEnv(undefined, () => hubCorsPolicy());
    assert.equal(later, first);
    assert.equal(later.desktop, true);
  } finally {
    if (before.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before.db;
    if (before.web === undefined) delete process.env.HUB_WEB_ORIGIN;
    else process.env.HUB_WEB_ORIGIN = before.web;
  }
});

async function probeBoth(policy: CorsPolicy, origins: string[]) {
  const app = Fastify();
  await app.register(cors, corsPluginOptions(policy));
  // The same shape as the five hijacked routes: skip the plugin, write headers by hand.
  app.post("/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ...streamCorsHeaders(request.headers.origin, policy) });
    reply.raw.end("data: {}\n\n");
  });
  try {
    const rows = [];
    for (const origin of origins) {
      const pre = await app.inject({
        method: "OPTIONS",
        url: "/stream",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
      });
      const stream = await app.inject({ method: "POST", url: "/stream", headers: { origin, "content-type": "application/json" }, payload: "{}" });
      rows.push({ origin, pre, stream });
    }
    return rows;
  } finally {
    await app.close();
  }
}

test("the plugin's preflight and the hijacked stream allow exactly the same origins", async () => {
  const candidates = [
    ...DESKTOP_WEBVIEW_ORIGINS,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://app.example.com",
    "https://evil.example",
    "ensemble://localhost.evil.com",
    "http://tauri.localhost.evil.com",
    "null",
  ];
  for (const policy of [corsPolicy("http://localhost:3000", true), corsPolicy("https://app.example.com", false)]) {
    for (const { origin, pre, stream } of await probeBoth(policy, candidates)) {
      const label = `${origin} desktop=${policy.desktop}`;
      const allowed = policy.origins.has(origin);
      assert.equal(pre.headers["access-control-allow-origin"], allowed ? origin : undefined, `preflight ${label}`);
      assert.equal(stream.statusCode, 200, label);
      assert.equal(stream.headers["access-control-allow-origin"], allowed ? origin : undefined, `stream ${label}`);
      assert.equal(stream.headers["access-control-allow-credentials"], allowed ? "true" : undefined, `stream ${label}`);
      assert.match(String(pre.headers.vary), /\bOrigin\b/, `preflight vary ${label}`);
      assert.equal(stream.headers.vary, "Origin", `stream vary ${label}`);
    }
  }
});

test("hijacked responses get CORS headers from the shared allowlist", () => {
  const credentialed = (origin: string) => ({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });
  withDesktopEnv("1", () => {
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
      assert.deepEqual(hijackedCorsHeaders(origin, "http://localhost:3000"), credentialed(origin));
    }
    assert.deepEqual(hijackedCorsHeaders("http://localhost:3000", "http://localhost:3000"), credentialed("http://localhost:3000"));
    assert.deepEqual(hijackedCorsHeaders("https://evil.example", "http://localhost:3000"), {});
    assert.deepEqual(hijackedCorsHeaders(undefined, "http://localhost:3000"), {});
    assert.deepEqual(hijackedCorsHeaders(["tauri://localhost", "tauri://localhost"], "http://localhost:3000"), {});
  });
  withDesktopEnv(undefined, () => {
    assert.deepEqual(hijackedCorsHeaders("https://app.example.com", "https://app.example.com"), credentialed("https://app.example.com"));
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
      assert.deepEqual(hijackedCorsHeaders(origin, "https://app.example.com"), {}, origin);
    }
    assert.deepEqual(hijackedCorsHeaders("https://evil.example", "https://app.example.com"), {});
  });
});

// Origins that look like an allowed one but are not. The allowlist is an exact
// match, so every one of these must get no CORS headers in either mode.
const LOOKALIKE_ORIGINS = [
  "ensemble://localhost.evil.com",
  "http://ensemble.localhost.evil.com",
  "https://ensemble.localhost.evil.com",
  "tauri://localhost.evil.com",
  "http://tauri.localhost.evil.com",
  "http://evil.ensemble.localhost",
  "http://evil.tauri.localhost",
  "ensemble://evil.localhost",
  "null",
  "",
  " ",
  "*",
  "ENSEMBLE://localhost",
  "ensemble://LOCALHOST",
  "HTTP://ensemble.localhost",
  "http://Ensemble.Localhost",
  "ensemble://localhost/",
  "http://ensemble.localhost/",
  "ensemble://localhost:1",
  "http://ensemble.localhost:80",
  "http://ensemble.localhost:1420",
  " ensemble://localhost",
  "ensemble://localhost ",
  "ensemble://localhost\n",
  "ensemble://localhost, https://evil.example",
  "ensemble://user@localhost",
  "ensemble:localhost",
  "ensemble://localhost%2e",
  "https://app.example.com.evil.com",
  "https://evil-app.example.com",
  "https://app.example.com/",
  "https://APP.example.com",
  "https://app.example.com:443",
  "https://app.example.com:8443",
  "http://app.example.com",
  "http://localhost:3000.evil.com",
  "http://localhost:3000/",
  "http://localhost:3001",
  "http://localhost",
  "http://LOCALHOST:3000",
  "http://[::1]:3000",
];

test("lookalike origins get no CORS headers in desktop or hosted mode", () => {
  for (const hubWebOrigin of ["http://localhost:3000", "https://app.example.com"]) {
    for (const desktop of [true, false]) {
      const allowed = allowedOrigins(hubWebOrigin, desktop);
      for (const origin of LOOKALIKE_ORIGINS) {
        const label = `${JSON.stringify(origin)} web=${hubWebOrigin} desktop=${desktop}`;
        assert.equal(allowed.has(origin), false, label);
        assert.equal(allowOriginHeader(origin, allowed), undefined, label);
        assert.deepEqual(credentialedCorsHeaders(origin, allowed), {}, label);
        assert.deepEqual(hijackedCorsHeaders(origin, hubWebOrigin, desktop), {}, label);
        assert.deepEqual(hijackedCorsHeaders([origin], hubWebOrigin, desktop), {}, label);
      }
    }
  }
});

test("the exact desktop webview origins are allowed in desktop mode", () => {
  const credentialed = (origin: string) => ({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });
  for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
    assert.deepEqual(hijackedCorsHeaders(origin, "http://localhost:3000", true), credentialed(origin), origin);
  }
});

test("hosted mode never adds a webview origin, whatever the web origin or ENSEMBLE_DESKTOP value", () => {
  const webOriginsToTry = [
    "https://app.example.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://ensemble.localhost",
    "ensemble://localhost.evil.com",
  ];
  for (const hubWebOrigin of webOriginsToTry) {
    const hosted = allowedOrigins(hubWebOrigin, false);
    assert.deepEqual([...hosted].sort(), [...webOrigins(hubWebOrigin)].sort(), hubWebOrigin);
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
      // HUB_WEB_ORIGIN itself is the only way a webview-looking origin gets in, and only when an operator sets it.
      if (origin === hubWebOrigin) continue;
      assert.equal(hosted.has(origin), false, `${hubWebOrigin} ${origin}`);
      assert.deepEqual(hijackedCorsHeaders(origin, hubWebOrigin, false), {}, `${hubWebOrigin} ${origin}`);
    }
  }
  for (const value of [undefined, "0", "true", "TRUE", "yes", "on", "1 ", " 1", "01", "", "2"]) {
    withDesktopEnv(value, () => {
      const hosted = allowedOrigins("https://app.example.com");
      assert.deepEqual([...hosted], ["https://app.example.com"], JSON.stringify(value));
      for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
        assert.deepEqual(hijackedCorsHeaders(origin, "https://app.example.com"), {}, `${JSON.stringify(value)} ${origin}`);
      }
    });
  }
});

test("the hosted web origin is matched exactly: no trailing slash, port, case or scheme change", () => {
  const allowed = allowedOrigins("https://app.example.com", false);
  assert.equal(allowOriginHeader("https://app.example.com", allowed), "https://app.example.com");
  for (const origin of ["https://app.example.com/", "https://app.example.com:443", "https://APP.EXAMPLE.COM", "http://app.example.com", "https://app.example.com.", "https://sub.app.example.com"]) {
    assert.equal(allowOriginHeader(origin, allowed), undefined, origin);
  }
});
