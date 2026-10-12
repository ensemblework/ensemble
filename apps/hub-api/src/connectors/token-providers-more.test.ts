/**
 * Pasted tokens for Figma, Vercel, Azure DevOps, Zendesk, Front and HubSpot: what is
 * checked, what is stored, and refusals. Fetch is mocked; nothing reaches the vendors.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../runtime/test-env.js";
import { azureOrg, figmaTeamId, TokenRejectedError, validateToken, zendeskHost } from "./token-providers.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let seen: Seen[] = [];
let respond: (request: Seen) => Response = () => json({ message: "not mocked" }, 404);
const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Seen = {
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function refused(promise: Promise<unknown>, token: string, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TokenRejectedError, String(error));
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(token), "the token never appears in the error");
    return true;
  });
}

test("Figma: checks the token, then the optional team link, and keeps the team id", async () => {
  const token = "figd_mira_secret_token_1234";
  respond = ({ url }) => {
    if (url === "https://api.figma.com/v1/me") return json({ id: "u-77", email: "mira@fieldnote.example", handle: "Mira Chen" });
    if (url === "https://api.figma.com/v1/teams/1234567/projects") return json({ name: "Fieldnote", projects: [{ id: "88", name: "Atlas app" }] });
    return json({ status: 404, err: "Not found" }, 404);
  };
  const saved = await validateToken("figma", { token, site: "https://www.figma.com/files/team/1234567/Fieldnote?fuid=9" });
  assert.equal(saved.secret, token);
  assert.equal(saved.account, "mira@fieldnote.example");
  assert.deepEqual(saved.meta, { via: "token", figmaUserId: "u-77", teamId: "1234567", teamName: "Fieldnote" });
  assert.equal(seen[0]!.headers["x-figma-token"], token);

  seen = [];
  const noTeam = await validateToken("figma", { token, site: "" });
  assert.equal(noTeam.meta.teamId, null);
  assert.equal(seen.length, 1, "no team link, no team lookup");

  assert.equal(figmaTeamId("https://www.figma.com/files/998877/team/1234567/Fieldnote"), "1234567");
  assert.throws(() => figmaTeamId("https://www.figma.com/design/AbCdEf123456/Atlas"), TokenRejectedError);

  respond = () => json({ status: 403, err: `Invalid token ${token}` }, 403);
  await refused(validateToken("figma", { token }), token, /Figma rejected that token \(Invalid token \[token\]\)/);
});

test("Vercel: saves the username and the teams to search", async () => {
  const token = "vercel-mira-secret-0001";
  respond = ({ url }) => {
    if (url === "https://api.vercel.com/v2/user") return json({ user: { id: "u1", email: "mira@fieldnote.example", username: "mira-fieldnote", defaultTeamId: "team_fieldnote01" } });
    if (url.startsWith("https://api.vercel.com/v2/teams")) return json({ teams: [{ id: "team_fieldnote01", slug: "fieldnote", name: "Fieldnote" }, { slug: "no-id" }] });
    return json({}, 404);
  };
  const saved = await validateToken("vercel", { token });
  assert.equal(saved.account, "mira-fieldnote");
  assert.deepEqual(saved.meta, { via: "token", username: "mira-fieldnote", defaultTeamId: "team_fieldnote01", teams: [{ id: "team_fieldnote01", slug: "fieldnote", name: "Fieldnote" }] });
  assert.equal(seen[0]!.headers.authorization, `Bearer ${token}`);

  respond = () => json({ error: { code: "forbidden", message: "Not authorized", invalidToken: true } }, 403);
  await refused(validateToken("vercel", { token }), token, /Vercel rejected that token \(Not authorized\)/);
});

test("Azure DevOps: the organization is checked, the PAT goes as Basic with an empty user", async () => {
  const token = "azure-pat-mira-secret-1234567890";
  assert.equal(azureOrg("https://dev.azure.com/fieldnote/Field%20App"), "fieldnote");
  assert.equal(azureOrg("fieldnote.visualstudio.com"), "fieldnote");
  assert.equal(azureOrg(" fieldnote "), "fieldnote");
  assert.throws(() => azureOrg("evil.example/fieldnote"), TokenRejectedError);
  assert.throws(() => azureOrg(""), TokenRejectedError);

  respond = ({ url }) => {
    if (url === "https://dev.azure.com/fieldnote/_apis/projects?$top=1&api-version=7.1") return json({ count: 1, value: [{ id: "p1", name: "Field App" }] });
    if (url === "https://dev.azure.com/fieldnote/_apis/connectionData") {
      return json({ authenticatedUser: { id: "az-user-1", providerDisplayName: "Mira Chen", properties: { Account: { $value: "mira@fieldnote.example" } } } });
    }
    return json({}, 404);
  };
  const saved = await validateToken("azure_devops", { token, site: "https://dev.azure.com/fieldnote" });
  assert.equal(saved.secret, token);
  assert.equal(saved.account, "mira@fieldnote.example @ fieldnote");
  assert.deepEqual(saved.meta, { via: "token", auth: "basic", org: "fieldnote", azureUserId: "az-user-1" });
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from(`:${token}`).toString("base64")}`);

  // A bad PAT can come back as a 203 sign-in page.
  respond = () => new Response("<html>Sign in</html>", { status: 203, headers: { "content-type": "text/html" } });
  await refused(validateToken("azure_devops", { token, site: "fieldnote" }), token, /Azure DevOps rejected that token \(401\)/);

  seen = [];
  await refused(validateToken("azure_devops", { token, site: "https://evil.example" }), token, /Azure DevOps organization/);
  assert.equal(seen.length, 0);
});

test("Zendesk: subdomain, agent email and token together, stored as Zendesk's Basic credentials", async () => {
  const token = "zd-mira-secret-token-0001";
  assert.equal(zendeskHost("fieldnote"), "fieldnote.zendesk.com");
  assert.equal(zendeskHost("https://Fieldnote.zendesk.com/agent/tickets/5"), "fieldnote.zendesk.com");
  assert.throws(() => zendeskHost("fieldnote.zendesk.com.evil.example"), TokenRejectedError);
  assert.throws(() => zendeskHost("evil.example"), TokenRejectedError);

  respond = ({ url }) =>
    url === "https://fieldnote.zendesk.com/api/v2/users/me.json" ? json({ user: { id: 9001, name: "Mira Chen", email: "mira@fieldnote.example", role: "agent" } }) : json({}, 404);
  const saved = await validateToken("zendesk", { token, email: "mira@fieldnote.example", site: "fieldnote" });
  assert.equal(saved.secret, `mira@fieldnote.example/token:${token}`);
  assert.equal(saved.account, "mira@fieldnote.example @ fieldnote.zendesk.com");
  assert.deepEqual(saved.meta, { via: "token", auth: "basic", site: "fieldnote.zendesk.com", email: "mira@fieldnote.example", zendeskUserId: 9001, role: "agent" });
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from(`mira@fieldnote.example/token:${token}`).toString("base64")}`);

  respond = () => json({ user: { id: null, name: "Anonymous user", role: "end-user" } });
  await refused(validateToken("zendesk", { token, email: "mira@fieldnote.example", site: "fieldnote" }), token, /did not accept that email and token/);
  respond = () => json({ user: { id: 12, name: "Customer", role: "end-user" } });
  await refused(validateToken("zendesk", { token, email: "mira@fieldnote.example", site: "fieldnote" }), token, /end user/);
  respond = () => json({ error: "Couldn't authenticate you" }, 401);
  await refused(validateToken("zendesk", { token, email: "mira@fieldnote.example", site: "fieldnote" }), token, /Zendesk rejected that token \(401\)/);
  seen = [];
  await refused(validateToken("zendesk", { token, site: "fieldnote" }), token, /email address/);
  assert.equal(seen.length, 0);
});

test("Front: the company token names the company", async () => {
  const token = "front-company-token-secret-1";
  respond = ({ url }) => (url === "https://api2.frontapp.com/me" ? json({ id: "cmp_fieldnote", name: "Fieldnote" }) : json({}, 404));
  const saved = await validateToken("front", { token });
  assert.deepEqual(saved, { secret: token, account: "Fieldnote", meta: { via: "token", frontCompanyId: "cmp_fieldnote" } });
  assert.equal(seen[0]!.headers.authorization, `Bearer ${token}`);

  respond = () => json({ _error: { status: 401, title: "Unauthenticated", message: `Bad token ${token}` } }, 401);
  await refused(validateToken("front", { token }), token, /Front rejected that token \(Bad token \[token\]\)/);
});

test("HubSpot: the portal id names the account and the UI host is kept for links", async () => {
  const token = "pat-na1-mira-secret-0001";
  respond = ({ url }) => (url === "https://api.hubapi.com/account-info/v3/details" ? json({ portalId: 4410021, uiDomain: "app-eu1.hubspot.com", accountType: "STANDARD" }) : json({}, 404));
  const saved = await validateToken("hubspot", { token });
  assert.deepEqual(saved, { secret: token, account: "HubSpot 4410021", meta: { via: "token", portalId: 4410021, uiDomain: "app-eu1.hubspot.com" } });

  respond = () => json({ portalId: 4410021, uiDomain: "evil.example" });
  assert.equal((await validateToken("hubspot", { token })).meta.uiDomain, "app.hubspot.com");

  respond = () => json({ status: "error", message: "Authentication credentials not found." }, 401);
  await refused(validateToken("hubspot", { token }), token, /HubSpot rejected that token \(Authentication credentials not found\.\)/);
});
