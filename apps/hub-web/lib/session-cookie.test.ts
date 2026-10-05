import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieDelete } from "./session-cookie";

test("middleware clears a parent-domain session cookie on both hosts", () => {
  assert.deepEqual(sessionCookieDelete(".example.com"), { name: "ensemble_session", path: "/", domain: ".example.com" });
  assert.deepEqual(sessionCookieDelete(undefined), { name: "ensemble_session", path: "/" });
  assert.equal(sessionCookieDelete(".vercel.app").domain, undefined);
});
