import assert from "node:assert/strict";
import test from "node:test";
import { INVITE_ONLY, signupMode, signupPermitted } from "./signup.js";

test("production stays open after the first account unless explicitly closed", () => {
  assert.equal(signupMode({ production: true, allowlist: undefined, hasAccounts: false }), "open");
  assert.equal(signupMode({ production: true, allowlist: "  ", hasAccounts: true }), "open");
  assert.equal(signupPermitted({ email: "ada@example.com", production: true, allowlist: undefined, hasAccounts: true }), true);
  assert.equal(signupPermitted({ email: "ada@example.com", production: true, allowlist: undefined, hasAccounts: false }), true);
});

test("explicit modes provide a kill switch and an empty allowlist fails closed", () => {
  assert.equal(signupMode({ mode: "closed", allowlist: "*@example.com" }), "closed");
  assert.equal(signupPermitted({ email: "ada@example.com", mode: "closed", allowlist: undefined }), false);
  assert.equal(signupPermitted({ email: "ada@example.com", mode: "allowlist", allowlist: undefined }), false);
  assert.equal(signupPermitted({ email: "ada@example.com", mode: "open", allowlist: "other@example.com" }), true);
  assert.throws(() => signupMode({ mode: "oops", allowlist: undefined }), /ENSEMBLE_SIGNUP_MODE/);
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
