import assert from "node:assert/strict";
import test from "node:test";
import { createHostedAccessPolicy, isHosted, operatorEmail } from "./hosted-access.js";

const env = { NODE_ENV: "production", ENSEMBLE_OPERATOR_EMAILS: "operator@example.test, second@example.test" };
const users = {
  operator: { email: "operator@example.test", emailVerifiedAt: new Date() },
  member: { email: "member@example.test", emailVerifiedAt: new Date() },
  unverified: { email: "operator@example.test", emailVerifiedAt: null },
};
const policy = createHostedAccessPolicy(async (id) => users[id as keyof typeof users] ?? null, env);

test("hosted policy preserves development and desktop behavior", async () => {
  assert.equal(isHosted(env), true);
  for (const local of [{ NODE_ENV: "development" }, { ...env, ENSEMBLE_DESKTOP: "1" }]) {
    assert.equal(isHosted(local), false);
    const access = createHostedAccessPolicy(async () => { throw new Error("must not query"); }, local);
    await access.requireVerifiedUser(null);
    await access.requireHostAccess(null, "Code");
    assert.equal(await access.canUseHostCredentials(null), true);
  }
});

test("operator emails are an exact comma-separated allowlist, not a domain or substring", () => {
  assert.equal(operatorEmail("operator@example.test", env), true);
  for (const email of ["Operator@example.test", "example.test", "operator@example.test.evil", ""]) assert.equal(operatorEmail(email, env), false);
});

test("verified BYOK members retain hosted model access, not local execution or host keys", async () => {
  await policy.requireVerifiedUser("member");
  assert.equal(await policy.isOperatorUser("member"), false);
  assert.equal(await policy.canUseHostCredentials("member"), false);
  assert.equal(await policy.canUseHostCredentials(null), false);
  await assert.rejects(policy.requireHostAccess("member", "Code"), { statusCode: 403, code: "HOST_ACCESS_DENIED" });
  await policy.requireHostAccess("operator", "Code");
  assert.equal(await policy.canUseHostCredentials("operator"), true);
});

test("unknown and unverified users fail closed; database errors propagate", async () => {
  await assert.rejects(policy.requireVerifiedUser("unverified"), { statusCode: 403, code: "EMAIL_UNVERIFIED" });
  await assert.rejects(policy.requireHostAccess("unverified", "Code"), { statusCode: 403 });
  assert.equal(await policy.canUseHostCredentials("unverified"), false);
  assert.equal(await policy.isOperatorUser("unverified"), false);
  await assert.rejects(policy.requireVerifiedUser("missing"), { statusCode: 403 });
  const unavailable = createHostedAccessPolicy(async () => { throw new Error("database unavailable"); }, env);
  await assert.rejects(unavailable.canUseHostCredentials("operator"), /database unavailable/);
  await assert.rejects(unavailable.requireVerifiedUser("operator"), /database unavailable/);
});
