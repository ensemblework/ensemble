import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { LoginProfile } from "../lib/auth-oauth.js";
import { createHttpHarness, type HttpHarness } from "../test/http.js";
import { authRouteCoverage } from "../test/route-coverage.js";

let harness: HttpHarness;
let profile: LoginProfile;
const mails: Array<{ to: string; text: string }> = [];
const createdIds: string[] = [];
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const observed = new Map<string, { happy: boolean; rejected: boolean }>();
const password = "test-password-only-123";
const address = () => `auth-${randomUUID()}@example.test`;

function cookie(response: LightMyRequestResponse, name = "ensemble_session"): string {
  const header = response.headers["set-cookie"];
  const values = typeof header === "string" ? [header] : header ?? [];
  const found = values.find((value) => value.startsWith(`${name}=`));
  assert.ok(found, `missing ${name} cookie`);
  return found.split(";")[0]!;
}

function mailToken(to: string): string {
  const message = mails.filter((mail) => mail.to === to).at(-1);
  assert.ok(message);
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  assert.ok(token);
  return token;
}

async function signup(email = address()) {
  const response = await harness.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password, name: "Mira", turnstileToken: "test-challenge" } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ user: { id: string; email: string; emailVerified: boolean } }>();
  createdIds.push(body.user.id);
  return { ...body.user, cookie: cookie(response) };
}

async function oauth(provider: "google" | "github" | "microsoft", browserCookie?: string, link = false) {
  const started = await harness.app.inject({
    method: "GET", url: `/api/auth/oauth/${provider}/start${link ? "?link=1" : ""}`,
    headers: browserCookie ? { cookie: browserCookie } : {},
  });
  assert.equal(started.statusCode, 302, started.body);
  const state = new URL(String(started.headers.location)).searchParams.get("state");
  assert.ok(state);
  const flowCookie = cookie(started, "ensemble_login_flow");
  const callback = `/api/auth/oauth/${provider}/callback?code=fake-code&state=${encodeURIComponent(state)}`;
  return {
    callback,
    headers: { cookie: `${flowCookie}${browserCookie ? `; ${browserCookie}` : ""}` },
  };
}

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
  process.env.HUB_API_PUBLIC_URL = "http://api.example.test";
  delete process.env.ENSEMBLE_COOKIE_DOMAIN;
  process.env.ENSEMBLE_SIGNUP_MODE = "open";
  process.env.TURNSTILE_SECRET_KEY = "fake-test-secret";
  for (const provider of ["GOOGLE", "GITHUB", "MICROSOFT"]) {
    process.env[`AUTH_${provider}_CLIENT_ID`] = "test-client";
    process.env[`AUTH_${provider}_CLIENT_SECRET`] = "test-client-secret";
  }
  harness = await createHttpHarness({
    authOAuth: { exchange: async () => profile },
    onResponse(request, reply) {
      const key = `${request.method} ${request.routeOptions.url}`;
      const previous = observed.get(key) ?? { happy: false, rejected: false };
      const errorRedirect = /[?&]error=/.test(String(reply.getHeader("location") ?? ""));
      observed.set(key, {
        happy: previous.happy || (reply.statusCode >= 200 && reply.statusCode < 400 && !errorRedirect),
        rejected: previous.rejected || reply.statusCode >= 400 || errorRedirect,
      });
    },
  });
  const { setMailSenderForTests } = await import("../lib/auth-email.js");
  setMailSenderForTests(async (message) => { mails.push(message); });
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify", "unexpected external call in auth tests");
    return new Response(JSON.stringify({ success: true, hostname: "hub.example.test", action: "signup" }));
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  const { setMailSenderForTests } = await import("../lib/auth-email.js");
  setMailSenderForTests(null);
  if (process.env.ENSEMBLE_TEST_DATABASE_URL && harness) {
    const { deleteAccountData } = await import("../lib/account-data.js");
    for (const id of createdIds) {
      if (await harness.prisma.user.findUnique({ where: { id } })) await deleteAccountData(harness.prisma, id);
    }
  }
  await harness?.close();
  process.env = originalEnv;
  for (const [route, checks] of Object.entries(authRouteCoverage)) {
    assert.ok(observed.has(route), `Unexecuted auth coverage claim: ${route}`);
    if (checks.includes("happy-path")) assert.ok(observed.get(route)?.happy, `Missing auth happy path: ${route}`);
    if (checks.includes("invalid-input")) assert.ok(observed.get(route)?.rejected, `Missing auth rejection contract: ${route}`);
  }
});

test("hosted signup stays open and never gives the first registrant placeholder data", async () => {
  const { env } = await import("../config.js");
  const placeholder = await harness.prisma.user.create({ data: { id: env.ENSEMBLE_DEV_USER_ID, email: address(), name: "Local" } });
  const privateTask = await harness.prisma.task.create({ data: { userId: placeholder.id, title: "Private placeholder task" } });
  process.env.NODE_ENV = "production";
  try {
    const first = await signup();
    const second = await signup();
    assert.notEqual(first.id, placeholder.id);
    assert.notEqual(second.id, first.id);
    assert.equal(first.emailVerified, false);
    const status = await harness.app.inject({ method: "GET", url: "/api/auth/status" });
    assert.equal(status.json().signup, "open");
    assert.deepEqual(status.json().providers, ["google", "github", "microsoft"]);
    assert.doesNotMatch(status.body, /test-client-secret/);
    const task = await harness.app.inject({ method: "GET", url: `/api/tasks/${privateTask.id}`, headers: { cookie: first.cookie } });
    assert.equal(task.statusCode, 404);
    const denied = await harness.app.inject({ method: "POST", url: "/api/assistant/turn", headers: { cookie: first.cookie }, payload: { message: "hello" } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers["content-type"]?.includes("text/event-stream"), false);
  } finally {
    process.env.NODE_ENV = "test";
    const { deleteAccountData } = await import("../lib/account-data.js");
    await deleteAccountData(harness.prisma, placeholder.id);
  }
});

test("verification requires the matching browser account, is hashed, expires and is single use", async () => {
  const user = await signup();
  const token = mailToken(user.email);
  const { sha256 } = await import("../lib/auth.js");
  assert.ok(await harness.prisma.emailToken.findUnique({ where: { id: sha256(token) } }));
  assert.equal(await harness.prisma.emailToken.findUnique({ where: { id: token } }), null);
  const stranger = await harness.asUser();
  const verify = (headers: { cookie?: string } = {}) => harness.app.inject({ method: "POST", url: "/api/auth/verify-email", headers, payload: { token } });
  assert.equal((await verify()).statusCode, 401);
  assert.equal((await verify({ cookie: stranger.cookie })).statusCode, 401);
  assert.equal((await verify({ cookie: user.cookie })).statusCode, 200);
  assert.equal((await verify({ cookie: user.cookie })).statusCode, 400);
  assert.ok((await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt);
  const expired = await signup();
  const expiredToken = mailToken(expired.email);
  await harness.prisma.emailToken.updateMany({ where: { userId: expired.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/verify-email", headers: { cookie: expired.cookie }, payload: { token: expiredToken } })).statusCode, 400);
});

test("resend invalidates the old verification link and scoped tokens cannot request mail", async () => {
  const user = await signup();
  const oldToken = mailToken(user.email);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/resend-verification", headers: { cookie: user.cookie } })).statusCode, 200);
  assert.notEqual(mailToken(user.email), oldToken);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/verify-email", headers: { cookie: user.cookie }, payload: { token: oldToken } })).statusCode, 400);
  const account = await harness.asUser();
  const full = await harness.asToken(account, "full");
  assert.equal((await full.inject({ method: "POST", url: "/api/auth/resend-verification" })).statusCode, 403);
});

test("account validation, signup kill switches and password changes have explicit HTTP contracts", async () => {
  for (const [url, payload] of [
    ["/api/auth/signup", { email: "bad", password: "short" }],
    ["/api/auth/login", { email: "bad", password: password }],
    ["/api/auth/forgot", { email: "bad" }],
    ["/api/auth/reset", { token: "short", password: "short" }],
  ] as const) {
    assert.equal((await harness.app.inject({ method: "POST", url, payload })).statusCode, 400, url);
  }
  const owner = await harness.asUser();
  await harness.prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });
  process.env.ENSEMBLE_SIGNUP_MODE = "closed";
  try {
    const denied = await harness.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: address(), password } });
    assert.equal(denied.statusCode, 403);
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: owner.email, password } });
    assert.equal(login.statusCode, 200);
  } finally {
    process.env.ENSEMBLE_SIGNUP_MODE = "open";
  }
  assert.equal((await owner.inject({ method: "PATCH", url: "/api/auth/me", payload: { password: "new-password-123", current: "wrong" } })).statusCode, 400);
  const changed = await owner.inject({ method: "PATCH", url: "/api/auth/me", payload: { name: "Updated Mira", password: "new-password-123", current: password } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().user.name, "Updated Mira");
  assert.equal((await owner.inject({ method: "GET", url: "/api/auth/me" })).statusCode, 401);
  const newCookie = cookie(changed);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: newCookie } })).statusCode, 204);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: newCookie } })).statusCode, 401);
});

test("password recovery is single-use, revokes sessions and removes unverified pre-hijacked identities", async () => {
  const user = await signup();
  await harness.prisma.authIdentity.create({ data: { userId: user.id, provider: "microsoft", subject: randomUUID(), email: user.email } });
  const known = await harness.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: user.email } });
  const unknown = await harness.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: address() } });
  assert.deepEqual(known.json(), unknown.json());
  const token = mailToken(user.email);
  const reset = () => harness.app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "replacement-password-123" } });
  assert.equal((await reset()).statusCode, 200);
  assert.equal((await reset()).statusCode, 400);
  assert.equal(await harness.prisma.authIdentity.count({ where: { userId: user.id } }), 0);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: user.cookie } })).statusCode, 401);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password } })).statusCode, 401);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: "replacement-password-123" } })).statusCode, 200);
});

test("OAuth state is browser-bound and single-use; passwordless sessions work in me and shell", async () => {
  profile = { subject: randomUUID(), email: address(), name: "Mira", verified: true };
  const flow = await oauth("google");
  const wrong = await harness.app.inject({ method: "GET", url: flow.callback });
  assert.match(String(wrong.headers.location), /error=/);
  const success = await harness.app.inject({ method: "GET", url: flow.callback, headers: flow.headers });
  assert.equal(success.statusCode, 302);
  assert.equal(new URL(String(success.headers.location)).pathname, "/start");
  const session = cookie(success);
  const me = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.hasPassword, false);
  assert.equal(me.json().user.emailVerified, true);
  createdIds.push(me.json().user.id);
  const shell = await harness.app.inject({ method: "GET", url: "/api/shell", headers: { cookie: session } });
  assert.equal(shell.statusCode, 200, shell.body);
  assert.equal(shell.json().user.email, profile.email);
  assert.equal(shell.json().user.hasPassword, false);
  assert.equal(shell.json().user.emailVerified, true);
  const replay = await harness.app.inject({ method: "GET", url: flow.callback, headers: flow.headers });
  assert.match(String(replay.headers.location), /error=/);
  assert.equal(await harness.prisma.authIdentity.count({ where: { userId: me.json().user.id } }), 1);
});

test("unverified provider emails cannot auto-link existing accounts; verified identities link safely", async () => {
  const owner = await harness.asUser();
  await harness.prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });
  profile = { subject: randomUUID(), email: owner.email, name: "Mira", verified: false };
  const microsoft = await oauth("microsoft");
  const rejected = await harness.app.inject({ method: "GET", url: microsoft.callback, headers: microsoft.headers });
  assert.match(String(rejected.headers.location), /error=/);
  assert.equal(await harness.prisma.authIdentity.count({ where: { userId: owner.id } }), 0);
  profile = { ...profile, subject: randomUUID(), verified: true };
  const google = await oauth("google");
  const linked = await harness.app.inject({ method: "GET", url: google.callback, headers: google.headers });
  const me = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookie(linked) } });
  assert.equal(me.json().user.id, owner.id);
  const unverified = await harness.asUser();
  profile = { subject: randomUUID(), email: unverified.email, name: "Mira", verified: true };
  const blocked = await oauth("github");
  assert.match(String((await harness.app.inject({ method: "GET", url: blocked.callback, headers: blocked.headers })).headers.location), /error=/);
});

test("explicit provider linking accepts an absent email, requires fresh login and preserves the last method", async () => {
  const user = await harness.asUser();
  await harness.prisma.user.update({ where: { id: user.id }, data: { passwordHash: null, emailVerifiedAt: new Date() } });
  profile = { subject: randomUUID(), email: null, name: "Mira", verified: false };
  const flow = await oauth("microsoft", user.cookie, true);
  const linked = await harness.app.inject({ method: "GET", url: flow.callback, headers: flow.headers });
  assert.equal(new URL(String(linked.headers.location)).pathname, "/settings");
  const listed = await user.inject({ method: "GET", url: "/api/auth/identities" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().identities[0].provider, "microsoft");
  assert.equal((await user.inject({ method: "DELETE", url: "/api/auth/identities/microsoft" })).statusCode, 400);
  await harness.prisma.authIdentity.create({ data: { userId: user.id, provider: "google", subject: randomUUID(), email: user.email } });
  assert.equal((await user.inject({ method: "DELETE", url: "/api/auth/identities/microsoft" })).statusCode, 204);
  await harness.prisma.session.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(0) } });
  assert.equal((await user.inject({ method: "GET", url: "/api/auth/oauth/microsoft/start?link=1" })).statusCode, 403);
});

test("exports isolate users and omit secrets; erasure revokes tokens and blocks late model/ledger writes", async () => {
  const owner = await harness.asUser();
  const other = await harness.asUser();
  await harness.prisma.task.create({ data: { userId: owner.id, title: "Owned export note" } });
  await harness.prisma.task.create({ data: { userId: other.id, title: "Other private task" } });
  await harness.prisma.preference.create({ data: { userId: owner.id, key: "test.secret", value: { token: "must-not-export", visible: "safe" } } });
  const { writeTable, readOriginal } = await import("../plots/store.js");
  const datasetId = randomUUID();
  const table = { columns: [], rows: [] };
  const hash = writeTable(owner.id, datasetId, table, new Uint8Array([1, 2, 3]));
  await harness.prisma.plotDataset.create({
    data: { id: datasetId, userId: owner.id, name: "Test upload", format: "csv", columns: [], rowCount: 0, byteSize: 3, contentHash: hash },
  });
  const key = await harness.asToken(owner, "full");
  const exported = await owner.inject({ method: "GET", url: "/api/auth/export" });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(exported.body, /Owned export note/);
  assert.doesNotMatch(exported.body, /Other private task|must-not-export|token_hash|password_hash/);
  assert.equal((await key.inject({ method: "GET", url: "/api/auth/export" })).statusCode, 403);
  assert.equal((await owner.inject({ method: "DELETE", url: "/api/auth/account", payload: { confirmation: "not DELETE" } })).statusCode, 400);
  assert.equal((await owner.inject({ method: "DELETE", url: "/api/auth/account", payload: { confirmation: "DELETE", current: password } })).statusCode, 204);
  assert.equal((await owner.inject({ method: "GET", url: "/api/auth/me" })).statusCode, 401);
  assert.equal((await key.inject({ method: "GET", url: "/api/tasks" })).statusCode, 401);
  assert.equal(await harness.prisma.task.count({ where: { userId: owner.id } }), 0);
  assert.equal(readOriginal(owner.id, datasetId), null);
  await assert.rejects(harness.prisma.metricEvent.create({ data: { userId: owner.id, kind: "late model usage" } }), /foreign key/i);
  await assert.rejects(harness.prisma.auditLedger.create({ data: { userId: owner.id, actor: "system", action: "late completion", hash: "test" } }), /foreign key/i);
  assert.equal(await harness.prisma.task.count({ where: { userId: other.id } }), 1);
});
