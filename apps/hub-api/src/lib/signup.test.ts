import assert from "node:assert/strict";
import test from "node:test";
import { INVITE_ONLY, signupMode, signupPermitted } from "./signup.js";

test("production closes signup after the first account when the allowlist is unset", () => {
  assert.equal(signupMode({ production: true, allowlist: undefined, hasAccounts: false }), "open");
  assert.equal(signupMode({ production: true, allowlist: "  ", hasAccounts: true }), "closed");
  assert.equal(signupPermitted({ email: "ada@example.com", production: true, allowlist: undefined, hasAccounts: true }), false);
  assert.equal(signupPermitted({ email: "ada@example.com", production: true, allowlist: undefined, hasAccounts: false }), true);
});

test("dev stays open when the allowlist is unset", () => {
  assert.equal(signupMode({ production: false, allowlist: undefined, hasAccounts: true }), "open");
  assert.equal(signupPermitted({ email: "ada@example.com", production: false, allowlist: undefined, hasAccounts: true }), true);
});

test("an allowlist matches emails and *@domain patterns", () => {
  const allowlist = "Ada@Example.com, *@school.edu";
  assert.equal(signupMode({ production: true, allowlist, hasAccounts: true }), "allowlist");
  const base = { production: true, allowlist, hasAccounts: true };
  assert.equal(signupPermitted({ ...base, email: "ada@example.com" }), true);
  assert.equal(signupPermitted({ ...base, email: "pupil@school.edu" }), true);
  assert.equal(signupPermitted({ ...base, email: "pupil@sub.school.edu" }), false);
  assert.equal(signupPermitted({ ...base, email: "other@example.com" }), false);
  assert.equal(signupPermitted({ ...base, email: "ada@example.com.evil" }), false);
  assert.equal(INVITE_ONLY.includes("invite only"), true);
});
