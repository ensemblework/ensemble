import assert from "node:assert/strict";
import test from "node:test";
import { signInHints } from "./sign-in-hints.js";

test("known sign-in failures get a hint; a trace id is never taken for a tenant", () => {
  assert.deepEqual(signInHints("AADSTS530035: Access has been blocked by security defaults.\nTrace ID: 0a1b2c3d-1111-2222-3333-444455556666"), [
    "Device-code sign-in is blocked by this account's security defaults: run plain `az login` (browser sign-in) instead.",
  ]);
  assert.deepEqual(signInHints("Authentication failed against tenant 11111111-2222-3333-4444-555555555555.\nNo subscriptions found for mira@example.com."), [
    "It signed in, but found no subscription to use: run `az login --tenant 11111111-2222-3333-4444-555555555555`, and `az account list --all` to see every subscription.",
  ]);
  assert.deepEqual(signInHints("Trace ID: 0a1b2c3d-1111-2222-3333-444455556666\nNo subscriptions found for mira@example.com."), [], "no tenant listed: no hint");
  assert.deepEqual(signInHints("Login succeeded."), []);
});
