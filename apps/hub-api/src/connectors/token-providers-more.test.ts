/**
 * Pasted tokens for Figma, Vercel, Azure DevOps, Zendesk, Front, HubSpot, Trello and Zotero: what is
 * checked, what is stored, and refusals. Fetch is mocked; nothing reaches the vendors.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../runtime/test-env.js";
import { CONNECTOR_CATALOG, CONNECTOR_GUIDES } from "@ensemble/shared-types";
import { azureOrg, figmaTeamId, TOKEN_PROVIDERS, TokenRejectedError, validateToken, zendeskHost } from "./token-providers.js";

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

test("Trello: the API key and token go together in Trello's OAuth header, and the key is kept", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const token = "ATTA0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0011223344";
  respond = ({ url }) => (url.startsWith("https://api.trello.com/1/members/me") ? json({ username: "mirachen", fullName: "Mira Chen" }) : json({}, 404));
  const saved = await validateToken("trello", { token, key });
  assert.deepEqual(saved, { secret: token, account: "mirachen", meta: { via: "token", key } });
  assert.equal(seen[0]!.headers.authorization, `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`);
});

test("Trello: a pasted Power-Up Secret is named as the Secret; a token for another key is explained", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const secret = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
  respond = () => new Response("invalid token", { status: 401 });
  await refused(validateToken("trello", { token: secret, key }), secret, /That looks like your Power-Up's Secret\. Trello's token comes from the Token link next to your API key, and starts with ATTA\./);

  const otherKeysToken = "ATTA99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa9988";
  await refused(
    validateToken("trello", { token: otherKeysToken, key }),
    otherKeysToken,
    /Trello didn't accept that API key and token together\. Make sure the token was made with the Token link for this same API key\./,
  );

  // Tokens from before the ATTA format are 64 hex characters too; Trello still decides.
  respond = () => json({ username: "mirachen" });
  assert.equal((await validateToken("trello", { token: secret, key })).account, "mirachen");
});

test("Trello: a key and token in the wrong fields are caught before Trello is asked", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const token = "ATTA0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0011223344";
  await refused(validateToken("trello", { token: key, key: token }), token, /token in the API key field/);
  await refused(validateToken("trello", { token: key, key }), "ATTA-not-sent", /That's your API key in the Token field/);
  await refused(validateToken("trello", { token }), token, /Enter your Trello API key/);
  assert.equal(seen.length, 0, "Trello was not called");
});

test("every provider that takes a pasted token has a step-by-step guide", () => {
  for (const provider of TOKEN_PROVIDERS) {
    const entry = CONNECTOR_CATALOG.find((row) => row.provider === provider && row.auth.includes("token"));
    assert.ok(entry, `${provider} is in the catalog with a token option`);
    assert.ok(CONNECTOR_GUIDES[entry.id]?.steps.length, `${provider} has a guide`);
  }
});

test("Zotero: the key names its owner, keeps its library, notes and write access, and the group libraries it can read", async () => {
  const token = "P9xKfieldnoteMiraKey0001";
  respond = ({ url }) => {
    if (url === "https://api.zotero.org/keys/current") {
      return json({
        key: token,
        userID: 4412001,
        username: "mira_chen",
        displayName: "Mira Chen",
        access: { user: { library: true, notes: true, write: false, files: true }, groups: { all: { library: true, write: false } } },
      });
    }
    if (url === "https://api.zotero.org/users/4412001/groups?limit=100") return json([{ id: 99001, data: { name: "Fieldnote Reading Group" } }, { id: "nope", data: { name: "Broken" } }]);
    return json({}, 404);
  };
  const saved = await validateToken("zotero", { token });
  assert.deepEqual(saved, {
    secret: token,
    account: "mira_chen",
    meta: { via: "token", userID: 4412001, username: "mira_chen", library: true, notes: true, write: false, groups: [{ id: 99001, name: "Fieldnote Reading Group", write: false }] },
  });
  assert.equal(seen[0]!.headers["zotero-api-key"], token);
  assert.equal(seen[0]!.headers["zotero-api-version"], "3");
  assert.ok(seen.every((request) => !request.url.includes(token)), "the key only travels in a header");

  // Per-group grants: only the groups the key may read, each with its own write access.
  respond = ({ url }) => {
    if (url === "https://api.zotero.org/keys/current") {
      return json({ userID: 4412001, username: "mira_chen", access: { user: { library: true, notes: false, write: true }, groups: { "99002": { library: true, write: true } } } });
    }
    if (url === "https://api.zotero.org/users/4412001/groups?limit=100") return json([{ id: 99001, data: { name: "Not shared with the key" } }, { id: 99002, data: { name: "Thesis lab" } }]);
    return json({}, 404);
  };
  const lab = await validateToken("zotero", { token });
  assert.deepEqual(lab.meta.groups, [{ id: 99002, name: "Thesis lab", write: true }]);
  assert.equal(lab.meta.write, true);
  assert.equal(lab.meta.notes, false);
});

test("Zotero: refuses a key it can't use, with what to change", async () => {
  const token = "P9xKfieldnoteMiraKey0002";
  respond = () => json({ userID: 4412001, username: "mira_chen", access: { user: { library: false, notes: false, write: false } } });
  await refused(validateToken("zotero", { token }), token, /This key can't read your library\. Edit the key and tick Allow library access\./);
  assert.equal(seen.length, 1, "no group lookup without group access");

  respond = () => new Response("Invalid key", { status: 403 });
  await refused(validateToken("zotero", { token }), token, /Zotero didn't accept that API key\./);

  respond = () => json({ access: { user: { library: true } } });
  await refused(validateToken("zotero", { token }), token, /didn't say whose key/);

  seen = [];
  await refused(validateToken("zotero", { token: "my zotero password" }), "my zotero password", /doesn't look like a Zotero API key/);
  assert.equal(seen.length, 0, "Zotero was not called");
});
