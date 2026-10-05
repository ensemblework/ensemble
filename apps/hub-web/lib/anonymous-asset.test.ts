import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { isAnonymousAsset } from "./anonymous-asset";
import { middleware, config } from "../middleware";

const ASSETS = [
  "/icon.svg",
  "/favicon.ico",
  "/robots.txt",
  "/apple-icon.png",
  "/apple-icon",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/site.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/brand-icon-128.png",
  "/brand-icon-512.png",
  "/og-image.png",
  "/opengraph-image",
  "/opengraph-image.png",
  "/twitter-image",
  "/twitter-image.png",
  "/offline.html",
  "/404.html",
  "/500.html",
];

test("brand files are anonymous assets and hub routes are not", () => {
  for (const path of ASSETS) assert.equal(isAnonymousAsset(path), true, path);
  assert.equal(isAnonymousAsset("/today"), false);
  assert.equal(isAnonymousAsset("/login"), false);
  assert.equal(isAnonymousAsset("/icon-192.png.bak"), false);
});

test("the middleware matcher skips brand files and still runs for the hub", () => {
  const source = config.matcher[0];
  assert.equal(typeof source, "string");
  const pattern = new RegExp(`^${source}$`);
  for (const path of ASSETS) assert.equal(pattern.test(path), false, path);
  assert.equal(pattern.test("/templates/semester-desk.svg"), false);
  assert.equal(pattern.test("/fonts/figtree.woff2"), false);
  assert.equal(pattern.test("/api/plots/datasets"), false);
  assert.equal(pattern.test("/api/context/documents"), false);
  assert.equal(pattern.test("/health"), false);
  assert.equal(pattern.test("/today"), true);
  assert.equal(pattern.test("/login"), true);
  const file = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(file, /isAnonymousAsset\(pathname\)/);
});

test("scrapers can request /opengraph-image without a session", () => {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /source: "\/opengraph-image", destination: "\/og-image.png"/);
  assert.match(config, /source: "\/opengraph-image.png", destination: "\/og-image.png"/);
});

test("template and font files are not rewritten to the 404", async () => {
  const response = await middleware(
    new NextRequest("http://localhost:3000/templates/semester-desk.svg", {
      headers: { accept: "text/html", cookie: "ensemble_session=present" },
    }),
  );
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
});

test("a signed-out request for the apple icon is not sent to login", async () => {
  const response = await middleware(new NextRequest("http://localhost:3000/apple-icon.png"));
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
