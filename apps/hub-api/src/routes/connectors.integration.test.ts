/**
 * Connector store HTTP contract: catalog state and isolation, OAuth start
 * scopes per product, hosted verification, token validation, product toggles
 * and disconnect. Every vendor call is answered by a mocked fetch.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { connectorRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
const APP_ENV = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "AUTH_MICROSOFT_CLIENT_ID", "AUTH_MICROSOFT_CLIENT_SECRET",
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET",
  "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET", "ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET",
  "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "DOCUSIGN_CLIENT_ID", "DOCUSIGN_CLIENT_SECRET",
  "GOOGLE_PICKER_API_KEY", "GOOGLE_PROJECT_NUMBER", "ENSEMBLE_SCHEDULED_FETCH",
];
for (const name of APP_ENV) delete process.env[name];
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://api.example.test";
process.env.ENSEMBLE_OPERATOR_EMAILS = "operator@example.test";
process.env.GOOGLE_CLIENT_ID = "google-connector-client.apps.example";
process.env.GOOGLE_CLIENT_SECRET = "google-connector-secret";
// Microsoft has only a sign-in app: connectors borrow it.
process.env.AUTH_MICROSOFT_CLIENT_ID = "microsoft-signin-client-id";
process.env.AUTH_MICROSOFT_CLIENT_SECRET = "microsoft-signin-secret";

const harness: HttpHarness = await createHttpHarness();
const { saveAccount, getAccount } = await import("../connectors/accounts.js");
const { saveSettings, loadSettings } = await import("../lib/settings.js");
const { providerAccessToken } = await import("../connectors/tokens.js");
const covered = new Map<string, Set<RouteCheck>>();

const G = "https://www.googleapis.com/auth/";

type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  calls.push({ url, init });
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;

function mock(prefix: string, reply: Handler): void {
  handlers.unshift({ match: (url) => url.startsWith(prefix), reply });
}

function resetMocks(): void {
  handlers.length = 0;
  calls.length = 0;
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(connectorRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted connector coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await harness.close();
    process.env = originalEnv;
  }
});

function track(method: string, route: string, check: RouteCheck): void {
  const key = `${method} ${route}`;
  const checks = covered.get(key) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(key, checks);
}

async function call(user: HttpUser | null, method: InjectOptions["method"], url: string, route: string, check: RouteCheck, payload?: unknown, cookie?: string) {
  const request: InjectOptions = {
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }),
    ...(cookie ? { headers: { cookie } } : {}),
  };
  const response = user ? await user.inject(request) : await harness.app.inject(request);
  track(String(method), route, check);
  return response;
}

async function verified(email: string): Promise<HttpUser> {
  const user = await harness.asUser(email);
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return user;
}

/** The `name=value` of the connect cookie a /start response set. */
function connectCookie(response: { headers: Record<string, unknown> }, provider: string): { pair: string; header: string } {
  const raw = response.headers["set-cookie"];
  const header = (Array.isArray(raw) ? raw : [raw]).map(String).find((line) => line.startsWith(`ensemble_connect_${provider}=`));
  assert.ok(header, `no connect cookie for ${provider}`);
  return { pair: header.split(";")[0]!, header };
}

const scopeList = (url: string): string[] => (new URL(url).searchParams.get("scope") ?? "").split(" ").filter(Boolean);

type Entry = { id: string; state: { connected: boolean; account: string | null; appReady: boolean; oauthReady: boolean; products: Record<string, boolean>; needsConsent: string[]; sources: Record<string, { enabled: boolean; lastSyncAt: string | null; lastError: string | null }>; mcp?: { status: string; toolCount: number; lastError: string | null } } };

test("catalog merges the shared list with each person's own state", async () => {
  resetMocks();
  const mira = await verified("mira.catalog@fieldnote.example");
  const arjun = await verified("arjun.catalog@fieldnote.example");
  await saveAccount(mira.id, "google", {
    accessToken: "mira-google-access",
    refreshToken: "mira-google-refresh",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["openid", `${G}gmail.readonly`],
    account: "mira@fieldnote.example",
    meta: { via: "oauth" },
  });
  await saveSettings(harness.prisma, mira.id, { connections: { gmail: { enabled: true } } });
  await harness.prisma.syncState.create({ data: { userId: mira.id, connector: "gmail", lastSyncAt: new Date("2026-10-06T09:00:00Z"), lastError: null, itemCount: 3 } });
  await harness.prisma.mcpConnection.create({
    data: { userId: mira.id, serverId: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", status: "connected", tools: [{ name: "search" }, { name: "fetch" }] },
  });

  const mine = await call(mira, "GET", "/api/connectors/catalog", "/api/connectors/catalog", "happy-path");
  assert.equal(mine.statusCode, 200, mine.body);
  const entries = mine.json<{ entries: Entry[] }>().entries;
  assert.ok(entries.length > 10);
  const google = entries.find((row) => row.id === "google_workspace")!;
  assert.equal(google.state.connected, true);
  assert.equal(google.state.account, "mira@fieldnote.example");
  assert.equal(google.state.appReady, true);
  assert.equal(google.state.oauthReady, true);
  assert.deepEqual(google.state.products, { gmail: true, calendar: true, drive_docs: true, drive_search: false });
  assert.deepEqual(google.state.needsConsent.sort(), ["calendar", "drive_docs"]);
  assert.deepEqual(google.state.sources.gmail, { enabled: true, lastSyncAt: "2026-10-06T09:00:00.000Z", lastError: null });
  assert.equal(google.state.sources.google_calendar?.enabled, false);
  const microsoft = entries.find((row) => row.id === "microsoft_365")!;
  assert.equal(microsoft.state.connected, false);
  assert.equal(microsoft.state.oauthReady, true, "falls back to the Microsoft sign-in app");
  assert.ok("outlook" in microsoft.state.sources && "teams" in microsoft.state.sources);
  const zoom = entries.find((row) => row.id === "zoom")!;
  assert.equal(zoom.state.appReady, false, "no Zoom app on this server");
  const notion = entries.find((row) => row.id === "notion")!;
  assert.equal(notion.state.appReady, true, "Notion can still connect with a token or MCP");
  assert.deepEqual(notion.state.mcp, { status: "connected", toolCount: 2, lastError: null });

  const theirs = await call(arjun, "GET", "/api/connectors/catalog", "/api/connectors/catalog", "isolation");
  assert.equal(theirs.statusCode, 200, theirs.body);
  const other = theirs.json<{ entries: Entry[] }>().entries;
  const otherGoogle = other.find((row) => row.id === "google_workspace")!;
  assert.equal(otherGoogle.state.connected, false);
  assert.equal(otherGoogle.state.account, null);
  assert.equal(otherGoogle.state.sources.gmail?.lastSyncAt, null);
  assert.equal(other.find((row) => row.id === "notion")!.state.mcp, undefined);
  assert.equal(calls.length, 0, "the catalog never calls a vendor");
});

test("Connect asks only for the scopes of the products that are on", async () => {
  resetMocks();
  const mira = await verified("mira.start@fieldnote.example");
  const google = await call(mira, "GET", "/api/connectors/google/start?products=gmail,drive_docs&returnTo=%2Fsettings%3Ftab%3Dconnections", "/api/connectors/:provider/start", "happy-path");
  assert.equal(google.statusCode, 200, google.body);
  const googleUrl = new URL(google.json<{ url: string }>().url);
  assert.equal(googleUrl.origin + googleUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(googleUrl.searchParams.get("client_id"), "google-connector-client.apps.example");
  assert.equal(googleUrl.searchParams.get("redirect_uri"), "http://api.example.test/api/connectors/google/callback");
  assert.equal(googleUrl.searchParams.get("include_granted_scopes"), "true");
  assert.equal(googleUrl.searchParams.get("access_type"), "offline");
  assert.equal(googleUrl.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(scopeList(googleUrl.href), ["openid", "email", "profile", `${G}gmail.readonly`, `${G}drive.file`]);

  const defaults = await call(mira, "GET", "/api/connectors/google/start", "/api/connectors/:provider/start", "happy-path");
  const defaultScopes = scopeList(defaults.json<{ url: string }>().url);
  assert.ok(defaultScopes.includes(`${G}calendar.events`) && defaultScopes.includes(`${G}calendar.calendarlist.readonly`));
  assert.ok(!defaultScopes.includes(`${G}drive.readonly`), "Search all of Drive is off by default");
  assert.ok(!defaultScopes.includes(`${G}calendar.readonly`));

  const microsoft = await call(mira, "GET", "/api/connectors/microsoft/start?products=outlook_mail,teams", "/api/connectors/:provider/start", "happy-path");
  assert.equal(microsoft.statusCode, 200, microsoft.body);
  const msUrl = new URL(microsoft.json<{ url: string }>().url);
  assert.equal(msUrl.origin + msUrl.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(msUrl.searchParams.get("client_id"), "microsoft-signin-client-id");
  assert.deepEqual(scopeList(msUrl.href), ["openid", "email", "profile", "offline_access", "User.Read", "Mail.Read", "Chat.Read"]);
  assert.ok(msUrl.searchParams.get("code_challenge"));

  const unknown = await call(mira, "GET", "/api/connectors/google/start?products=gmail,photos", "/api/connectors/:provider/start", "invalid-input");
  assert.equal(unknown.statusCode, 400, unknown.body);
  const empty = await call(mira, "GET", "/api/connectors/google/start?products=", "/api/connectors/:provider/start", "invalid-input");
  assert.equal(empty.statusCode, 400, empty.body);
  const noApp = await call(mira, "GET", "/api/connectors/zoom/start", "/api/connectors/:provider/start", "invalid-input");
  assert.equal(noApp.statusCode, 409, noApp.body);
  assert.match(noApp.json<{ error: string }>().error, /not set up on this server/);
  const notOAuth = await call(mira, "GET", "/api/connectors/todoist/start", "/api/connectors/:provider/start", "invalid-input");
  assert.equal(notOAuth.statusCode, 400, notOAuth.body);
  assert.equal(calls.length, 0);
});

test("hosted: unverified people are blocked, verified non-operators connect end to end", async (t) => {
  resetMocks();
  const unverified = await harness.asUser("new.person@fieldnote.example");
  const member = await verified("mira.hosted@fieldnote.example");
  process.env.NODE_ENV = "production";
  t.after(() => {
    process.env.NODE_ENV = "test";
  });

  const blocked = await call(unverified, "GET", "/api/connectors/google/start", "/api/connectors/:provider/start", "hosted-verification");
  assert.equal(blocked.statusCode, 403, blocked.body);
  const blockedToken = await call(unverified, "POST", "/api/connectors/todoist/token", "/api/connectors/:provider/token", "hosted-verification", { token: "todoist-token-0123456789" });
  assert.equal(blockedToken.statusCode, 403, blockedToken.body);
  const appAdmin = await call(member, "PUT", "/api/connectors/apps/google", "/api/connectors/apps/:provider", "hosted-verification", { clientId: "someone-else-client", clientSecret: "someone-else-secret" });
  assert.equal(appAdmin.statusCode, 403, appAdmin.body);

  const started = await call(member, "GET", "/api/connectors/google/start?products=gmail,calendar&returnTo=%2Fsettings%3Ftab%3Dconnections%26connector%3Dgoogle_workspace", "/api/connectors/:provider/start", "hosted-verification");
  assert.equal(started.statusCode, 200, started.body);
  const url = new URL(started.json<{ url: string }>().url);
  const state = url.searchParams.get("state")!;
  const challenge = url.searchParams.get("code_challenge")!;
  const flow = connectCookie(started, "google");
  assert.match(flow.header, /HttpOnly/);
  assert.match(flow.header, /Secure/);
  assert.match(flow.header, /SameSite=Lax/);

  let verifier = "";
  mock("https://oauth2.googleapis.com/token", (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "google-code");
    assert.equal(body.get("client_secret"), "google-connector-secret");
    verifier = body.get("code_verifier") ?? "";
    return Response.json({
      access_token: "google-access-new",
      refresh_token: "google-refresh-new",
      expires_in: 3599,
      scope: `openid https://www.googleapis.com/auth/userinfo.email ${G}gmail.readonly ${G}calendar.events ${G}calendar.calendarlist.readonly`,
    });
  });
  mock("https://openidconnect.googleapis.com/v1/userinfo", () => Response.json({ email: "mira@fieldnote.example" }));
  const done = await call(
    null,
    "GET",
    `/api/connectors/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
    "/api/connectors/:provider/callback",
    "happy-path",
    undefined,
    `${member.cookie}; ${flow.pair}`,
  );
  assert.equal(done.statusCode, 302, done.body);
  assert.ok(String(done.headers["set-cookie"]).includes("ensemble_connect_google=; "), "the connect cookie is cleared");
  const back = new URL(String(done.headers.location));
  assert.equal(back.origin, "http://hub.example.test");
  assert.equal(back.pathname, "/settings");
  assert.equal(back.searchParams.get("connector"), "google_workspace");
  assert.equal(back.searchParams.get("connected"), "google");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "PKCE verifier matches the challenge");

  const stored = await getAccount(member.id, "google", false, false);
  assert.equal(stored?.account, "mira@fieldnote.example");
  assert.equal(stored?.refreshToken, "google-refresh-new");
  assert.equal(stored?.meta.via, "oauth");
  assert.ok(stored?.scopes.includes(`${G}calendar.events`));
  const settings = await loadSettings(harness.prisma, member.id);
  assert.deepEqual(settings.connectorProducts.google_workspace, { gmail: true, calendar: true, drive_docs: false, drive_search: false });
  assert.equal(settings.connections.gmail?.enabled, true);
  assert.equal(settings.connections.google_calendar?.enabled, true);

  const replay = await call(null, "GET", `/api/connectors/google/callback?code=google-code&state=${encodeURIComponent(state)}`, "/api/connectors/:provider/callback", "invalid-input", undefined, `${member.cookie}; ${flow.pair}`);
  assert.equal(replay.statusCode, 302);
  assert.match(new URL(String(replay.headers.location)).searchParams.get("connectError") ?? "", /expired/);
  const cancelled = await call(null, "GET", "/api/connectors/google/callback?error=access_denied&state=nope", "/api/connectors/:provider/callback", "invalid-input");
  assert.equal(new URL(String(cancelled.headers.location)).searchParams.get("connectError"), "access_denied");
});

test("hosted: a consent link opened by someone else, or with no session, saves nothing", async (t) => {
  resetMocks();
  const attacker = await verified("attacker.csrf@example.test");
  const victim = await verified("mira.csrf@fieldnote.example");
  process.env.NODE_ENV = "production";
  t.after(() => {
    process.env.NODE_ENV = "test";
  });
  mock("https://oauth2.googleapis.com/token", () => Response.json({ access_token: "victim-access", refresh_token: "victim-refresh", expires_in: 3599, scope: `${G}gmail.readonly` }));
  mock("https://openidconnect.googleapis.com/v1/userinfo", () => Response.json({ email: "mira@fieldnote.example" }));
  const callback = (state: string, cookie: string | undefined, check: RouteCheck) =>
    call(null, "GET", `/api/connectors/google/callback?code=victim-code&state=${encodeURIComponent(state)}`, "/api/connectors/:provider/callback", check, undefined, cookie);
  const startAs = async (user: HttpUser) => {
    const started = await call(user, "GET", "/api/connectors/google/start?products=gmail", "/api/connectors/:provider/start", "happy-path");
    assert.equal(started.statusCode, 200, started.body);
    return { state: new URL(started.json<{ url: string }>().url).searchParams.get("state")!, flow: connectCookie(started, "google") };
  };
  const refused = (response: { statusCode: number; headers: Record<string, unknown> }) => {
    assert.equal(response.statusCode, 302);
    const back = new URL(String(response.headers.location));
    assert.equal(back.searchParams.get("connected"), null);
    assert.match(back.searchParams.get("connectError") ?? "", /Ensemble account that started connecting/);
  };

  // The attacker starts, then gets the victim's browser (signed in as the victim) to finish.
  const attack = await startAs(attacker);
  refused(await callback(attack.state, victim.cookie, "hosted-verification"));
  // Even if the victim's browser somehow carried the attacker's flow cookie, the session must match.
  const planted = await startAs(attacker);
  refused(await callback(planted.state, `${victim.cookie}; ${planted.flow.pair}`, "isolation"));
  // No Ensemble session at the callback.
  const anonymous = await startAs(attacker);
  refused(await callback(anonymous.state, anonymous.flow.pair, "hosted-verification"));
  // The right account in a different browser (no flow cookie).
  const otherBrowser = await startAs(attacker);
  refused(await callback(otherBrowser.state, attacker.cookie, "hosted-verification"));

  assert.equal(calls.filter((row) => row.url.startsWith("https://oauth2.googleapis.com/token")).length, 0, "the code is never exchanged");
  assert.equal(await getAccount(attacker.id, "google", false, false), null);
  assert.equal(await getAccount(victim.id, "google", false, false), null);
  assert.equal(await harness.prisma.authToken.count({ where: { userId: { in: [attacker.id, victim.id] } } }), 0);

  // The person who started, in the browser that started, still connects.
  const own = await startAs(victim);
  const done = await callback(own.state, `${victim.cookie}; ${own.flow.pair}`, "happy-path");
  assert.equal(new URL(String(done.headers.location)).searchParams.get("connected"), "google");
  assert.equal((await getAccount(victim.id, "google", false, false))?.account, "mira@fieldnote.example");
  assert.equal(await getAccount(attacker.id, "google", false, false), null);
});

test("pasted tokens are checked with the provider before they are stored", async () => {
  resetMocks();
  const mira = await verified("mira.tokens@fieldnote.example");
  mock("https://api.notion.com/v1/users/me", (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer ntn_fieldnote_secret_123");
    assert.ok((headers.get("notion-version") ?? "") >= "2022-06-28");
    return Response.json({ object: "user", id: "bot-1", type: "bot", name: "Ensemble", bot: { workspace_name: "Fieldnote" } });
  });
  const notion = await call(mira, "POST", "/api/connectors/notion/token", "/api/connectors/:provider/token", "happy-path", { token: "ntn_fieldnote_secret_123" });
  assert.equal(notion.statusCode, 200, notion.body);
  assert.equal(notion.json<{ account: string }>().account, "Fieldnote");
  const notionToken = await providerAccessToken(mira.id, "notion");
  assert.equal(notionToken?.token, "ntn_fieldnote_secret_123");
  assert.equal(notionToken?.extra?.workspaceName, "Fieldnote");

  mock("https://api.notion.com/v1/users/me", () => Response.json({ message: "API token is invalid." }, { status: 401 }));
  const badNotion = await call(mira, "POST", "/api/connectors/notion/token", "/api/connectors/:provider/token", "invalid-input", { token: "ntn_wrong_secret_456" });
  assert.equal(badNotion.statusCode, 400, badNotion.body);
  assert.doesNotMatch(badNotion.body, /ntn_wrong_secret_456/);
  assert.equal((await providerAccessToken(mira.id, "notion"))?.token, "ntn_fieldnote_secret_123", "a rejected token leaves the old one");

  mock("https://fieldnote.atlassian.net/rest/api/3/myself", (_url, init) => {
    const expected = `Basic ${Buffer.from("mira@fieldnote.example:atlassian-api-token-1").toString("base64")}`;
    assert.equal(new Headers(init?.headers).get("authorization"), expected);
    return Response.json({ emailAddress: "mira@fieldnote.example", displayName: "Mira Chen", accountId: "acc-1" });
  });
  const jira = await call(mira, "POST", "/api/connectors/atlassian/token", "/api/connectors/:provider/token", "happy-path", {
    email: "mira@fieldnote.example",
    token: "atlassian-api-token-1",
    site: "https://Fieldnote.atlassian.net/",
  });
  assert.equal(jira.statusCode, 200, jira.body);
  const jiraToken = await providerAccessToken(mira.id, "atlassian");
  assert.equal(jiraToken?.token, "mira@fieldnote.example:atlassian-api-token-1");
  assert.deepEqual({ site: jiraToken?.extra?.site, auth: jiraToken?.extra?.auth }, { site: "fieldnote.atlassian.net", auth: "basic" });

  const before = calls.length;
  const elsewhere = await call(mira, "POST", "/api/connectors/atlassian/token", "/api/connectors/:provider/token", "invalid-input", {
    email: "mira@fieldnote.example",
    token: "atlassian-api-token-1",
    site: "169.254.169.254",
  });
  assert.equal(elsewhere.statusCode, 400, elsewhere.body);
  assert.equal(calls.length, before, "a non-Atlassian site is never fetched");

  mock("https://api.todoist.com/api/v1/user", () => Response.json({ email: "mira@fieldnote.example", full_name: "Mira Chen" }));
  const todoist = await call(mira, "POST", "/api/connectors/todoist/token", "/api/connectors/:provider/token", "happy-path", { token: "0123456789abcdef0123" });
  assert.equal(todoist.statusCode, 200, todoist.body);
  assert.equal(todoist.json<{ account: string }>().account, "mira@fieldnote.example");

  const short = await call(mira, "POST", "/api/connectors/todoist/token", "/api/connectors/:provider/token", "invalid-input", { token: "short" });
  assert.equal(short.statusCode, 400, short.body);
  const unknown = await call(mira, "POST", "/api/connectors/box/token", "/api/connectors/:provider/token", "invalid-input", { token: "0123456789abcdef0123" });
  assert.equal(unknown.statusCode, 400, unknown.body);
});

test("turning on a product without its access asks to reconnect; turning one off applies now", async () => {
  resetMocks();
  const mira = await verified("mira.products@fieldnote.example");
  const arjun = await verified("arjun.products@fieldnote.example");
  await saveAccount(mira.id, "google", {
    accessToken: "mira-products-access",
    refreshToken: "mira-products-refresh",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["openid", `${G}gmail.readonly`, `${G}calendar.events`, `${G}calendar.calendarlist.readonly`, `${G}drive.file`],
    account: "mira@fieldnote.example",
    meta: { via: "oauth" },
  });
  await saveSettings(harness.prisma, mira.id, { connections: { gmail: { enabled: true }, google_calendar: { enabled: true } } });

  const search = await call(mira, "PUT", "/api/connectors/google_workspace/products", "/api/connectors/:id/products", "happy-path", { products: { drive_search: true } });
  assert.equal(search.statusCode, 200, search.body);
  const reconnect = search.json<{ reconnect: boolean; url: string; needs: string[] }>();
  assert.equal(reconnect.reconnect, true);
  assert.deepEqual(reconnect.needs, ["drive_search"]);
  assert.ok(scopeList(reconnect.url).includes(`${G}drive.readonly`));
  assert.equal(new URL(reconnect.url).searchParams.get("include_granted_scopes"), "true");
  assert.equal((await loadSettings(harness.prisma, mira.id)).connectorProducts.google_workspace?.drive_search, false, "saved only after approval");

  const off = await call(mira, "PUT", "/api/connectors/google_workspace/products", "/api/connectors/:id/products", "happy-path", { products: { calendar: false } });
  assert.equal(off.statusCode, 200, off.body);
  const state = off.json<Entry["state"] & { reconnect?: boolean }>();
  assert.equal(state.reconnect, undefined);
  assert.equal(state.products.calendar, false);
  assert.equal(state.sources.google_calendar?.enabled, false);
  assert.equal(state.sources.gmail?.enabled, true);

  const theirs = await call(arjun, "PUT", "/api/connectors/google_workspace/products", "/api/connectors/:id/products", "isolation", { products: { calendar: true, gmail: false } });
  assert.equal(theirs.statusCode, 200, theirs.body);
  assert.equal(theirs.json<Entry["state"]>().connected, false);
  const miraAfter = await loadSettings(harness.prisma, mira.id);
  assert.equal(miraAfter.connectorProducts.google_workspace?.calendar, false);
  assert.equal(miraAfter.connectorProducts.google_workspace?.gmail, true);
  assert.equal(miraAfter.connections.gmail?.enabled, true);

  const missing = await call(mira, "PUT", "/api/connectors/not_a_connector/products", "/api/connectors/:id/products", "unknown-id", { products: { gmail: true } });
  assert.equal(missing.statusCode, 404, missing.body);
  const badProduct = await call(mira, "PUT", "/api/connectors/google_workspace/products", "/api/connectors/:id/products", "invalid-input", { products: { photos: true } });
  assert.equal(badProduct.statusCode, 400, badProduct.body);
  const badShape = await call(mira, "PUT", "/api/connectors/google_workspace/products", "/api/connectors/:id/products", "invalid-input", { products: { gmail: "yes" } });
  assert.equal(badShape.statusCode, 400, badShape.body);
  assert.equal(calls.length, 0);
});

test("disconnect revokes, removes the token, switches sources off and can delete what was read", async () => {
  resetMocks();
  const mira = await verified("mira.disconnect@fieldnote.example");
  const arjun = await verified("arjun.disconnect@fieldnote.example");
  for (const user of [mira, arjun]) {
    await saveAccount(user.id, "google", {
      accessToken: `${user.id}-access`,
      refreshToken: `${user.id}-refresh`,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: [`${G}gmail.readonly`, `${G}calendar.events`],
      account: user.email,
      meta: { via: "oauth" },
    });
    await saveSettings(harness.prisma, user.id, { connections: { gmail: { enabled: true }, google_calendar: { enabled: true } } });
    await harness.prisma.artifact.createMany({
      data: [
        { userId: user.id, kind: "email", externalId: `${user.id}-gmail-1`, ts: new Date(), title: "Budget", text: "Numbers", url: "https://mail.google.com/mail/u/0/#all/t1", metadata: {} },
        { userId: user.id, kind: "event", externalId: `${user.id}-event-1`, ts: new Date(), title: "Standup", text: "", metadata: { source: "google" } },
        { userId: user.id, kind: "email", externalId: `outlook:${user.id}-1`, ts: new Date(), title: "Outlook stays", text: "", metadata: { source: "outlook" } },
      ],
    });
    await harness.prisma.syncState.create({ data: { userId: user.id, connector: "gmail", lastSyncAt: new Date() } });
  }
  let revokedToken = "";
  mock("https://oauth2.googleapis.com/revoke", (_url, init) => {
    revokedToken = new URLSearchParams(String(init?.body)).get("token") ?? "";
    return new Response(null, { status: 200 });
  });

  const done = await call(mira, "DELETE", "/api/connectors/google?deleteData=1", "/api/connectors/:provider", "happy-path");
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json(), { ok: true, revoked: true, deleted: 2 });
  assert.equal(revokedToken, `${mira.id}-refresh`);
  assert.equal(await getAccount(mira.id, "google", false, false), null);
  const settings = await loadSettings(harness.prisma, mira.id);
  assert.equal(settings.connections.gmail?.enabled, false);
  assert.equal(settings.connections.google_calendar?.enabled, false);
  const left = await harness.prisma.artifact.findMany({ where: { userId: mira.id }, select: { title: true } });
  assert.deepEqual(left.map((row) => row.title), ["Outlook stays"]);
  assert.equal(await harness.prisma.syncState.count({ where: { userId: mira.id, connector: "gmail" } }), 0);

  track("DELETE", "/api/connectors/:provider", "isolation");
  assert.ok(await getAccount(arjun.id, "google", false, false), "someone else's connection is untouched");
  assert.equal(await harness.prisma.artifact.count({ where: { userId: arjun.id } }), 3);
  assert.equal((await loadSettings(harness.prisma, arjun.id)).connections.gmail?.enabled, true);

  const again = await call(mira, "DELETE", "/api/connectors/google", "/api/connectors/:provider", "happy-path");
  assert.deepEqual(again.json(), { ok: true, revoked: false, deleted: 0 });
  const bad = await call(mira, "DELETE", "/api/connectors/box", "/api/connectors/:provider", "invalid-input");
  assert.equal(bad.statusCode, 400, bad.body);
});

test("Google Picker settings need the operator's keys and a drive.file grant", async (t) => {
  resetMocks();
  const mira = await verified("mira.picker@fieldnote.example");
  const missing = await call(mira, "GET", "/api/connectors/google/picker", "/api/connectors/google/picker", "invalid-input");
  assert.equal(missing.statusCode, 409, missing.body);
  process.env.GOOGLE_PICKER_API_KEY = "picker-api-key";
  process.env.GOOGLE_PROJECT_NUMBER = "123456789012";
  t.after(() => {
    delete process.env.GOOGLE_PICKER_API_KEY;
    delete process.env.GOOGLE_PROJECT_NUMBER;
  });
  const notConnected = await call(mira, "GET", "/api/connectors/google/picker", "/api/connectors/google/picker", "happy-path");
  assert.equal(notConnected.statusCode, 200, notConnected.body);
  assert.equal(notConnected.json<{ accessToken: string | null }>().accessToken, null);

  // The browser gets a token narrowed to drive.file from the refresh token; the stored grant is untouched.
  await saveAccount(mira.id, "google", {
    accessToken: "picker-stored-access",
    refreshToken: "picker-refresh",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: [`${G}gmail.readonly`, `${G}drive.file`],
    account: "mira@fieldnote.example",
    meta: { via: "oauth" },
  });
  mock("https://oauth2.googleapis.com/token", (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "picker-refresh");
    assert.equal(body.get("scope"), `${G}drive.file`);
    return Response.json({ access_token: "picker-narrow-access", expires_in: 3600, scope: `${G}drive.file` });
  });
  const ready = await call(mira, "GET", "/api/connectors/google/picker", "/api/connectors/google/picker", "happy-path");
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json(), { apiKey: "picker-api-key", appId: "123456789012", accessToken: "picker-narrow-access", origin: "http://hub.example.test" });
  const stored = await getAccount(mira.id, "google", false, false);
  assert.equal(stored?.accessToken, "picker-stored-access");
  assert.ok(stored?.scopes.includes(`${G}gmail.readonly`));

  // If Google answers with the broader grant, nothing is handed to the browser.
  mock("https://oauth2.googleapis.com/token", () =>
    Response.json({ access_token: "picker-broad-access", expires_in: 3600, scope: `${G}gmail.readonly ${G}drive.file` }),
  );
  const broad = await call(mira, "GET", "/api/connectors/google/picker", "/api/connectors/google/picker", "happy-path");
  assert.equal(broad.json<{ accessToken: string | null }>().accessToken, null);
});

test("app setup lists every OAuth provider with its redirect URI", async () => {
  resetMocks();
  const mira = await verified("mira.apps@fieldnote.example");
  const apps = await call(mira, "GET", "/api/connectors/apps", "/api/connectors/apps", "happy-path");
  assert.equal(apps.statusCode, 200, apps.body);
  const list = apps.json<{ apps: Array<{ provider: string; configured: boolean; source: string | null; redirectUri: string }> }>().apps;
  const microsoft = list.find((row) => row.provider === "microsoft")!;
  assert.deepEqual({ configured: microsoft.configured, source: microsoft.source }, { configured: true, source: "signin" });
  assert.equal(list.find((row) => row.provider === "docusign")?.redirectUri, "http://api.example.test/api/connectors/docusign/callback");
  const bad = await call(mira, "PUT", "/api/connectors/apps/todoist", "/api/connectors/apps/:provider", "invalid-input", { clientId: "client-id-1", clientSecret: "client-secret-1" });
  assert.equal(bad.statusCode, 400, bad.body);
});
