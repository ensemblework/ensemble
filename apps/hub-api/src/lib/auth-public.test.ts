import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAuthPath } from "./auth-public.js";

test("only registration, recovery, CLI polling and known social login callbacks are anonymous", () => {
  for (const path of ["status", "signup", "login", "logout", "forgot", "reset", "verify-email"]) {
    assert.equal(isPublicAuthPath(`/api/auth/${path}`), true, path);
  }
  for (const path of ["start", "token"]) {
    assert.equal(isPublicAuthPath(`/api/cli/auth/${path}`), true, path);
  }
  for (const provider of ["google", "github", "microsoft"]) {
    for (const path of ["start", "callback"]) assert.equal(isPublicAuthPath(`/api/auth/oauth/${provider}/${path}`), true);
  }
  for (const path of ["me", "identities", "account", "export", "resend-verification", "oauth/unknown/start", "oauth/google/settings"]) {
    assert.equal(isPublicAuthPath(`/api/auth/${path}`), false, path);
  }
});
