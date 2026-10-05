import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieHeader, sessionCookieSecure } from "./cookie.js";

test("local http dev does not mark the session cookie Secure", () => {
  assert.equal(sessionCookieSecure({ nodeEnv: "development", protocol: "http" }), false);
  assert.equal(sessionCookieSecure({ protocol: "http" }), false);
  assert.equal(sessionCookieSecure({}), false);
});

test("production or HTTPS marks the session cookie Secure", () => {
  assert.equal(sessionCookieSecure({ nodeEnv: "production", protocol: "http" }), true);
  assert.equal(sessionCookieSecure({ nodeEnv: "development", protocol: "https" }), true);
  assert.equal(sessionCookieSecure({ protocol: "http", forwardedProto: "https" }), true);
  assert.equal(sessionCookieSecure({ forwardedProto: ["https,http"] }), true);
  assert.equal(sessionCookieSecure({ forwardedProto: "http" }), false);
});

test("the cookie keeps HttpOnly and SameSite, and adds Secure only when asked", () => {
  const open = sessionCookieHeader("ensemble_session", "abc", 10, false);
  assert.match(open, /^ensemble_session=abc; HttpOnly; Path=\/; SameSite=Lax; Max-Age=10$/);
  assert.equal(open.includes("Secure"), false);
  const locked = sessionCookieHeader("ensemble_session", "", 0, true);
  assert.match(locked, /^ensemble_session=; HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=0$/);
  const shared = sessionCookieHeader("ensemble_session", "abc", 10, true, ".example.com");
  assert.match(shared, /^ensemble_session=abc; HttpOnly; Secure; Path=\/; Domain=\.example\.com; SameSite=Lax; Max-Age=10$/);
});
