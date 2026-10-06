import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { exchangeLoginCode, loginAuthorizationUrl, newOAuthFlow } from "./auth-oauth.js";

test("authorization uses identity-only scopes, nonce and S256 PKCE with a fixed callback", () => {
  const before = { ...process.env };
  try {
    process.env.AUTH_GOOGLE_CLIENT_ID = "login-client";
    process.env.AUTH_GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.HUB_API_PUBLIC_URL = "https://api.example.com";
    const flow = newOAuthFlow();
    const url = new URL(loginAuthorizationUrl("google", flow));
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.equal(url.searchParams.get("state"), flow.state);
    assert.equal(url.searchParams.get("nonce"), flow.nonce);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.notEqual(url.searchParams.get("code_challenge"), flow.verifier);
    assert.equal(url.searchParams.get("redirect_uri"), "https://api.example.com/api/auth/oauth/google/callback");
  } finally {
    process.env = before;
  }
});

test("Google and Microsoft identities require signed JWTs, audience, issuer and nonce; Microsoft email is unverified", async () => {
  const before = { ...process.env };
  const original = globalThis.fetch;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] });
  let idToken = "";
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: idToken }), { headers: { "Content-Type": "application/json" } });
  const sign = async (claims: Record<string, unknown>, issuer: string, audience = "test-client") => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience(audience)
    .setSubject("stable-sub").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  try {
    process.env.AUTH_GOOGLE_CLIENT_ID = "test-client";
    process.env.AUTH_GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.AUTH_MICROSOFT_CLIENT_ID = "test-client";
    process.env.AUTH_MICROSOFT_CLIENT_SECRET = "test-secret";
    idToken = await sign({ nonce: "nonce", email: "Mira@example.com", email_verified: true, name: "Mira" }, "https://accounts.google.com");
    assert.deepEqual(await exchangeLoginCode("google", "code", "verifier", "nonce", { keys }), {
      subject: "stable-sub", email: "mira@example.com", name: "Mira", verified: true,
    });
    await assert.rejects(exchangeLoginCode("google", "code", "verifier", "different", { keys }), /did not match/);
    idToken = await sign({ nonce: "nonce", email: "mira@example.com" }, "https://accounts.google.com", "wrong-client");
    await assert.rejects(exchangeLoginCode("google", "code", "verifier", "nonce", { keys }), /aud/);
    idToken = await sign({ nonce: "nonce", email: "mira@example.com" }, "https://wrong.example.com");
    await assert.rejects(exchangeLoginCode("google", "code", "verifier", "nonce", { keys }), /iss/);
    idToken = await sign({ nonce: "nonce", email: "mira@example.com", azp: "different-client" }, "https://accounts.google.com");
    await assert.rejects(exchangeLoginCode("google", "code", "verifier", "nonce", { keys }), /different sign-in client/);
    const tenant = "11111111-1111-4111-8111-111111111111";
    const object = "22222222-2222-4222-8222-222222222222";
    idToken = await sign({ nonce: "nonce", tid: tenant, oid: object, email: "mira@example.com", email_verified: true }, `https://login.microsoftonline.com/${tenant}/v2.0`);
    const microsoft = await exchangeLoginCode("microsoft", "code", "verifier", "nonce", { keys });
    assert.equal(microsoft.subject, `${tenant}:${object}`);
    assert.equal(microsoft.verified, false);
    idToken = await sign({ nonce: "nonce", tid: tenant, oid: object }, `https://login.microsoftonline.com/${tenant}/v2.0`);
    assert.equal((await exchangeLoginCode("microsoft", "code", "verifier", "nonce", { keys })).email, null);
  } finally {
    globalThis.fetch = original;
    process.env = before;
  }
});

test("GitHub login uses only the authenticated primary verified email", async () => {
  const before = { ...process.env };
  const original = globalThis.fetch;
  let verified = true;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).endsWith("/access_token") ? { access_token: "test-access" }
      : String(url).endsWith("/user") ? { id: 42, login: "mira", name: null, email: "untrusted@example.com" }
        : [{ email: "Mira@example.com", primary: true, verified }];
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  try {
    process.env.AUTH_GITHUB_CLIENT_ID = "test-client";
    process.env.AUTH_GITHUB_CLIENT_SECRET = "test-secret";
    assert.deepEqual(await exchangeLoginCode("github", "code", "verifier", "nonce"), {
      subject: "42", email: "mira@example.com", name: "mira", verified: true,
    });
    assert.ok(calls.includes("https://api.github.com/user/emails"));
    verified = false;
    await assert.rejects(exchangeLoginCode("github", "code", "verifier", "nonce"), /Verify your primary GitHub email/);
  } finally {
    globalThis.fetch = original;
    process.env = before;
  }
});
