import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { MemoryRateLimiter, classifyRateLimit, consumeRateLimit, rateLimitConfig, rateLimitKey } from "./rate-limit.js";

function request(partial: { method?: string; ip?: string; userId?: string; tokenId?: string; forwarded?: string }): FastifyRequest {
  return {
    method: partial.method ?? "POST",
    ip: partial.ip ?? "203.0.113.4",
    userId: partial.userId,
    tokenId: partial.tokenId,
    headers: partial.forwarded ? { "x-forwarded-for": partial.forwarded } : {},
  } as FastifyRequest;
}

test("the limiter allows a burst and then asks the caller to wait", () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter(() => now);
  assert.equal(limiter.take("login:ip:1", 2, 10_000), null);
  assert.equal(limiter.take("login:ip:1", 2, 10_000), null);
  const wait = limiter.take("login:ip:1", 2, 10_000);
  assert.equal(wait, 10_000);
  assert.equal(limiter.take("login:ip:2", 2, 10_000), null);
  now += 10_000;
  assert.equal(limiter.take("login:ip:1", 2, 10_000), null);
  assert.equal(limiter.take("off", 0, 10_000), null);
});

test("login, signup, model, and token routes are classified", () => {
  assert.equal(classifyRateLimit("POST", "/api/auth/login"), "login");
  assert.equal(classifyRateLimit("POST", "/api/auth/signup"), "signup");
  assert.equal(classifyRateLimit("POST", "/api/assistant/turn"), "model");
  assert.equal(classifyRateLimit("POST", "/api/models/test"), "model");
  assert.equal(classifyRateLimit("GET", "/api/models"), "model");
  assert.equal(classifyRateLimit("PUT", "/api/model-keys/openai"), "model");
  assert.equal(classifyRateLimit("POST", "/api/tokens"), "token");
  assert.equal(classifyRateLimit("POST", "/api/connect/token"), "token");
  assert.equal(classifyRateLimit("POST", "/api/auth/app-token"), "token");
  assert.equal(classifyRateLimit("POST", "/api/apps/editor/token"), "token");
  assert.equal(classifyRateLimit("POST", "/api/devices/register"), "token");
  assert.equal(classifyRateLimit("POST", "/api/devices/self/heartbeat"), "device");
  assert.equal(classifyRateLimit("POST", "/api/devices/self/jobs/job-1/progress"), "device");
  assert.equal(classifyRateLimit("POST", "/api/devices/self/claim"), null);
  assert.equal(classifyRateLimit("POST", "/api/devices/pair"), null);
  assert.equal(classifyRateLimit("GET", "/api/tokens"), null);
  assert.equal(classifyRateLimit("DELETE", "/api/tokens/abc"), null);
  assert.equal(classifyRateLimit("POST", "/api/connectors/slack/token"), null);
  assert.equal(classifyRateLimit("GET", "/api/auth/login"), null);
  assert.equal(classifyRateLimit("POST", "/api/tasks"), null);
});

test("model and token limits follow the user and auth limits follow the address", () => {
  assert.equal(rateLimitKey("model", request({ userId: "user-1" })), "model:user:user-1");
  assert.equal(rateLimitKey("token", request({ userId: "user-1" })), "token:user:user-1");
  assert.equal(rateLimitKey("token", request({})), "token:ip:203.0.113.4");
  assert.equal(rateLimitKey("device", request({ tokenId: "tok-1", userId: "user-1" })), "device:tok-1");
  assert.equal(rateLimitKey("device", request({ userId: "user-1" })), "device:user:user-1");
  assert.equal(rateLimitKey("login", request({ forwarded: "198.51.100.8, 127.0.0.1" })), "login:ip:198.51.100.8");
});

test("env overrides the default windows", () => {
  const config = rateLimitConfig({ ENSEMBLE_RATE_LOGIN_LIMIT: "3", ENSEMBLE_RATE_LOGIN_WINDOW_SEC: "60", ENSEMBLE_RATE_MODEL_LIMIT: "0" });
  assert.equal(config.login.limit, 3);
  assert.equal(config.login.windowMs, 60_000);
  assert.equal(config.model.limit, 0);
  assert.equal(config.signup.limit, 60);
  assert.equal(config.token.limit, 20);
  assert.equal(config.token.windowMs, 900_000);
});

test("token minting uses its own limit", () => {
  const limiter = new MemoryRateLimiter();
  const config = rateLimitConfig({ ENSEMBLE_RATE_TOKEN_LIMIT: "1", ENSEMBLE_RATE_TOKEN_WINDOW_SEC: "60" });
  const req = request({ method: "POST", userId: "user-1" });
  assert.equal(consumeRateLimit(limiter, req, "/api/tokens", config), null);
  const hit = consumeRateLimit(limiter, req, "/api/connect/token", config);
  assert.ok(hit);
  assert.match(hit.error, /keys/i);
  assert.equal(consumeRateLimit(limiter, request({ method: "POST", userId: "user-2" }), "/api/auth/app-token", config), null);
});

test("consumeRateLimit returns 429 details and names the wait", () => {
  const limiter = new MemoryRateLimiter();
  const config = rateLimitConfig({ ENSEMBLE_RATE_LOGIN_LIMIT: "1", ENSEMBLE_RATE_LOGIN_WINDOW_SEC: "30" });
  const req = request({ method: "POST" });
  assert.equal(consumeRateLimit(limiter, req, "/api/auth/login", config), null);
  const hit = consumeRateLimit(limiter, req, "/api/auth/login", config);
  assert.ok(hit);
  assert.match(hit.error, /sign-in/i);
  assert.equal(hit.retryAfterSeconds >= 1, true);
  assert.equal(consumeRateLimit(limiter, req, "/api/tasks", config), null);
});
