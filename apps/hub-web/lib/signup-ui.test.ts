import assert from "node:assert/strict";
import test from "node:test";
import { INVITE_ONLY, safeLoginNext, showInviteNote, signupPanel } from "./signup-ui";

test("a closed signup shows the invite-only panel", () => {
  assert.equal(signupPanel("signup", "closed"), "closed");
  assert.equal(signupPanel("signup", "open"), "form");
  assert.equal(signupPanel("signup", "allowlist"), "form");
  assert.equal(signupPanel("login", "closed"), "form");
  assert.equal(showInviteNote("closed"), true);
  assert.equal(showInviteNote("allowlist"), true);
  assert.equal(showInviteNote("open"), false);
  assert.match(INVITE_ONLY, /invite only/i);
});

test("post-login next paths cannot become cross-origin browser redirects", () => {
  assert.equal(safeLoginNext("/today?from=login"), "/today?from=login");
  for (const value of [null, "//evil.example", "/\\evil.example", "https://evil.example", "/\nevil.example"]) {
    assert.equal(safeLoginNext(value), null);
  }
});
