/**
 * Connecting with a pasted personal token. Each token is checked against the
 * provider once before it is stored (encrypted, through saveAccount).
 */
import { z } from "zod";
import type { AccountProvider } from "./accounts.js";
import { meetingSource } from "./meetings/index.js";
import { MEETING_VENDORS, MeetingTokenError } from "./meetings/types.js";

export const TOKEN_PROVIDERS = [
  "github",
  "slack",
  "linear",
  "notion",
  "atlassian",
  "trello",
  "asana",
  "todoist",
  "clickup",
  "monday",
  "figma",
  "vercel",
  "azure_devops",
  "zendesk",
  "front",
  "hubspot",
  "zotero",
  ...MEETING_VENDORS,
] as const;
export type TokenProvider = (typeof TOKEN_PROVIDERS)[number];

export const TokenBody = z.object({
  token: z.string().trim().min(10).max(4096),
  email: z.string().trim().email().max(320).optional(),
  site: z.string().trim().max(255).optional(),
  key: z.string().trim().min(8).max(256).optional(),
});
export type TokenBody = z.infer<typeof TokenBody>;

export interface ValidatedToken {
  /** What is stored (encrypted) as the access token. */
  secret: string;
  account: string;
  meta: Record<string, unknown>;
}

export class TokenRejectedError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

/** Notion API version for token checks. */
export const NOTION_VERSION = "2025-09-03";

const TIMEOUT_MS = 15_000;

async function call(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new TokenRejectedError("Could not reach the service to check that token. Try again.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

const rejected = (label: string, detail: string | number): never => {
  throw new TokenRejectedError(`${label} rejected that token (${detail}).`);
};

/** Jira Cloud sites only; a free-form host would let the server be pointed anywhere. */
export function atlassianSite(raw: string | undefined): string {
  const host = (raw ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.(atlassian\.net|jira\.com)$/.test(host)) {
    throw new TokenRejectedError("Enter your Jira site, like yourteam.atlassian.net.");
  }
  return host;
}

/** Azure DevOps organization name from "fieldnote", "https://dev.azure.com/fieldnote/…" or "fieldnote.visualstudio.com". */
export function azureOrg(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/^https?:\/\//i, "");
  const match = /^dev\.azure\.com\/([^/?#]+)/i.exec(value) ?? /^([^./?#]+)\.visualstudio\.com/i.exec(value);
  const org = match ? match[1]! : value.replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org)) throw new TokenRejectedError("Enter your Azure DevOps organization, like fieldnote or https://dev.azure.com/fieldnote.");
  return org;
}

/** Zendesk host from "fieldnote", "fieldnote.zendesk.com" or a Zendesk link. Only *.zendesk.com, so the server cannot be pointed anywhere else. */
export function zendeskHost(raw: string | undefined): string {
  let host = (raw ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  if (host && !host.includes(".")) host = `${host}.zendesk.com`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.zendesk\.com$/.test(host)) throw new TokenRejectedError("Enter your Zendesk subdomain, like fieldnote or fieldnote.zendesk.com.");
  return host;
}

/** Figma team id from a team link (…/files/team/123/… or …/files/<org>/team/123/…) or the bare id. Empty means no team. */
export function figmaTeamId(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match = /figma\.com\/files\/(?:[^/?#]+\/)?team\/(\d{3,25})/i.exec(value) ?? /^(\d{3,25})$/.exec(value);
  if (!match) throw new TokenRejectedError("Paste a Figma team link like https://www.figma.com/files/team/123456/Fieldnote, or leave it empty.");
  return match[1]!;
}

/** The vendor's own words for a refusal, without the token if it was echoed back. */
const said = (detail: unknown, token: string, status: number): string | number =>
  typeof detail === "string" && detail.trim() ? detail.split(token).join("[token]").slice(0, 200) : status;

const basicAuth = (credentials: string): string => `Basic ${Buffer.from(credentials).toString("base64")}`;

export async function validateToken(provider: TokenProvider, input: TokenBody): Promise<ValidatedToken> {
  const token = input.token;
  const meetings = meetingSource(provider);
  if (meetings) {
    try {
      const checked = await meetings.check(token);
      return { secret: token, account: checked.account, meta: checked.meta };
    } catch (error) {
      if (error instanceof MeetingTokenError) throw new TokenRejectedError(error.message);
      throw error;
    }
  }
  switch (provider) {
    case "github": {
      const res = await call("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Ensemble" } });
      if (!res.ok) rejected("GitHub", res.status);
      return { secret: token, account: (res.body as { login: string }).login, meta: { via: "token" } };
    }
    case "slack": {
      const res = await call("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${token}` } });
      const body = (res.body ?? {}) as { ok?: boolean; error?: string; user?: string; team?: string; team_id?: string; user_id?: string; url?: string };
      if (!body.ok) rejected("Slack", body.error ?? res.status);
      return {
        secret: token,
        account: `${body.user} @ ${body.team}`,
        meta: { via: "token", teamId: body.team_id ?? null, slackUserId: body.user_id ?? null, url: body.url ?? null },
      };
    }
    case "linear": {
      const res = await call("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query: "{ viewer { email } }" }),
      });
      const body = (res.body ?? {}) as { data?: { viewer: { email: string } }; errors?: Array<{ message: string }> };
      if (!body.data) rejected("Linear", body.errors?.[0]?.message ?? res.status);
      return { secret: token, account: body.data!.viewer.email, meta: { via: "token", auth: "key" } };
    }
    case "notion": {
      const res = await call("https://api.notion.com/v1/users/me", {
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) rejected("Notion", (res.body as { message?: string } | null)?.message ?? res.status);
      const body = res.body as { id?: string; name?: string; bot?: { workspace_name?: string } };
      const workspace = body.bot?.workspace_name ?? null;
      return { secret: token, account: workspace ?? body.name ?? "Notion", meta: { via: "token", workspaceName: workspace, botId: body.id ?? null } };
    }
    case "atlassian": {
      if (!input.email) throw new TokenRejectedError("Enter the email address you sign in to Atlassian with.");
      const site = atlassianSite(input.site);
      const credentials = `${input.email}:${token}`;
      const res = await call(`https://${site}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`, Accept: "application/json" },
      });
      if (!res.ok) rejected("Jira", res.status);
      const body = res.body as { emailAddress?: string; displayName?: string; accountId?: string };
      return {
        secret: credentials,
        account: `${body.emailAddress ?? input.email} @ ${site}`,
        meta: { via: "token", auth: "basic", site, email: input.email, accountId: body.accountId ?? null },
      };
    }
    case "trello": {
      const key = input.key;
      if (!key) throw new TokenRejectedError("Enter your Trello API key as well as the token.");
      if (/^ATTA/i.test(key)) throw new TokenRejectedError("That's a Trello token in the API key field. The API key is the 32-character code on your Power-Up's API key tab; the token goes in Token.");
      if (key === token || /^[0-9a-f]{32}$/i.test(token)) {
        throw new TokenRejectedError("That's your API key in the Token field. Trello's token comes from the Token link next to your API key, and starts with ATTA.");
      }
      if (!/^[A-Za-z0-9]+$/.test(key) || !/^[A-Za-z0-9]+$/.test(token)) throw new TokenRejectedError("That Trello API key or token has characters Trello never uses.");
      // A Power-Up's Secret is 64 hex characters, but so are tokens made before Trello's ATTA format, so Trello decides and its refusal names the Secret.
      const secretLike = /^[0-9a-f]{64}$/i.test(token);
      const res = await call("https://api.trello.com/1/members/me?fields=username,fullName", {
        headers: { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`, Accept: "application/json" },
      });
      if (res.status === 401) {
        throw new TokenRejectedError(
          secretLike
            ? "That looks like your Power-Up's Secret. Trello's token comes from the Token link next to your API key, and starts with ATTA."
            : "Trello didn't accept that API key and token together. Make sure the token was made with the Token link for this same API key.",
        );
      }
      if (!res.ok) rejected("Trello", res.status);
      const body = res.body as { username?: string; fullName?: string };
      return { secret: token, account: body.username ?? body.fullName ?? "Trello", meta: { via: "token", key } };
    }
    case "asana": {
      const res = await call("https://app.asana.com/api/1.0/users/me", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (!res.ok) rejected("Asana", res.status);
      const user = (res.body as { data?: { email?: string; name?: string } }).data ?? {};
      return { secret: token, account: user.email ?? user.name ?? "Asana", meta: { via: "token" } };
    }
    case "todoist": {
      const res = await call("https://api.todoist.com/api/v1/user", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) rejected("Todoist", res.status);
      const body = res.body as { email?: string; full_name?: string };
      return { secret: token, account: body.email ?? body.full_name ?? "Todoist", meta: { via: "token" } };
    }
    case "clickup": {
      const res = await call("https://api.clickup.com/api/v2/user", { headers: { Authorization: token } });
      if (!res.ok) rejected("ClickUp", (res.body as { err?: string } | null)?.err ?? res.status);
      const user = (res.body as { user?: { email?: string; username?: string } }).user ?? {};
      return { secret: token, account: user.email ?? user.username ?? "ClickUp", meta: { via: "token" } };
    }
    case "monday": {
      const res = await call("https://api.monday.com/v2", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { name email } }" }),
      });
      const body = (res.body ?? {}) as { data?: { me?: { name?: string; email?: string } }; errors?: Array<{ message: string }>; error_message?: string };
      if (!res.ok || !body.data?.me) rejected("monday.com", body.errors?.[0]?.message ?? body.error_message ?? res.status);
      return { secret: token, account: body.data!.me!.email ?? body.data!.me!.name ?? "monday.com", meta: { via: "token" } };
    }
    case "figma": {
      const teamId = figmaTeamId(input.site);
      const headers = { "X-Figma-Token": token };
      const res = await call("https://api.figma.com/v1/me", { headers });
      const refusal = res.body as { err?: string; message?: string } | null;
      if (!res.ok) rejected("Figma", said(refusal?.err ?? refusal?.message, token, res.status));
      const me = res.body as { id?: string; email?: string; handle?: string };
      let teamName: string | null = null;
      if (teamId) {
        const team = await call(`https://api.figma.com/v1/teams/${teamId}/projects`, { headers });
        if (!team.ok) throw new TokenRejectedError(`Figma would not list that team's projects (${team.status}). Check the team link and that the token can read projects.`);
        teamName = (team.body as { name?: string } | null)?.name ?? null;
      }
      return { secret: token, account: me.email ?? me.handle ?? "Figma", meta: { via: "token", figmaUserId: me.id ?? null, teamId, teamName } };
    }
    case "vercel": {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      const res = await call("https://api.vercel.com/v2/user", { headers });
      if (!res.ok) rejected("Vercel", said((res.body as { error?: { message?: string } } | null)?.error?.message, token, res.status));
      const user = (res.body as { user?: { id?: string; email?: string; username?: string; defaultTeamId?: string | null } }).user ?? {};
      const listed = await call("https://api.vercel.com/v2/teams?limit=20", { headers });
      const teams = listed.ok ? ((listed.body as { teams?: Array<{ id?: string; slug?: string; name?: string }> } | null)?.teams ?? []) : [];
      return {
        secret: token,
        account: user.username ?? user.email ?? "Vercel",
        meta: {
          via: "token",
          username: user.username ?? null,
          defaultTeamId: user.defaultTeamId ?? null,
          teams: teams.filter((team) => team.id).map((team) => ({ id: team.id!, slug: team.slug ?? team.id!, name: team.name ?? team.slug ?? team.id! })),
        },
      };
    }
    case "azure_devops": {
      const org = azureOrg(input.site);
      const headers = { Authorization: basicAuth(`:${token}`), Accept: "application/json" };
      const res = await call(`https://dev.azure.com/${org}/_apis/projects?$top=1&api-version=7.1`, { headers });
      // A bad PAT can get a 203 with the HTML sign-in page instead of a 401.
      if (!res.ok || res.status === 203 || !Array.isArray((res.body as { value?: unknown } | null)?.value)) rejected("Azure DevOps", res.status === 203 ? 401 : res.status);
      const identity = await call(`https://dev.azure.com/${org}/_apis/connectionData`, { headers });
      const user = (identity.body as { authenticatedUser?: { id?: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } } } | null)?.authenticatedUser;
      const who = user?.properties?.Account?.$value ?? user?.providerDisplayName;
      return { secret: token, account: who ? `${who} @ ${org}` : org, meta: { via: "token", auth: "basic", org, azureUserId: user?.id ?? null } };
    }
    case "zendesk": {
      if (!input.email) throw new TokenRejectedError("Enter the email address of the Zendesk agent the token belongs to.");
      const host = zendeskHost(input.site);
      const credentials = `${input.email}/token:${token}`;
      const res = await call(`https://${host}/api/v2/users/me.json`, { headers: { Authorization: basicAuth(credentials), Accept: "application/json" } });
      if (!res.ok) rejected("Zendesk", res.status);
      const user = (res.body as { user?: { id?: number | null; email?: string | null; role?: string } } | null)?.user;
      if (!user?.id) throw new TokenRejectedError("Zendesk did not accept that email and token together.");
      if (user.role === "end-user") throw new TokenRejectedError("That Zendesk login is an end user. Use the email and token of an agent or admin.");
      return {
        secret: credentials,
        account: `${user.email ?? input.email} @ ${host}`,
        meta: { via: "token", auth: "basic", site: host, email: input.email, zendeskUserId: user.id, role: user.role ?? null },
      };
    }
    case "front": {
      const res = await call("https://api2.frontapp.com/me", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (!res.ok) rejected("Front", said((res.body as { _error?: { message?: string } } | null)?._error?.message, token, res.status));
      const me = res.body as { id?: string; name?: string };
      return { secret: token, account: me.name ?? "Front", meta: { via: "token", frontCompanyId: me.id ?? null } };
    }
    case "hubspot": {
      const res = await call("https://api.hubapi.com/account-info/v3/details", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (!res.ok) rejected("HubSpot", said((res.body as { message?: string } | null)?.message, token, res.status));
      const body = res.body as { portalId?: number; uiDomain?: string };
      if (!body.portalId) rejected("HubSpot", "no account id");
      const uiDomain = body.uiDomain && /^app(-[a-z0-9]+)?\.hubspot\.com$/.test(body.uiDomain) ? body.uiDomain : "app.hubspot.com";
      return { secret: token, account: `HubSpot ${body.portalId}`, meta: { via: "token", portalId: body.portalId, uiDomain } };
    }
    case "zotero":
      return zoteroKey(token);
  }
  throw new TokenRejectedError("That service does not take a pasted token.");
}

interface ZoteroAccess {
  library?: boolean;
  notes?: boolean;
  write?: boolean;
}

/** Group libraries saved at connect; searches cover the first few (connectors/items/sources/zotero.ts). */
const ZOTERO_MAX_GROUPS = 10;

async function zoteroKey(token: string): Promise<ValidatedToken> {
  if (!/^[A-Za-z0-9]{10,64}$/.test(token)) throw new TokenRejectedError("That doesn't look like a Zotero API key. Copy the key zotero.org shows after you save it: letters and digits only.");
  const headers = { "Zotero-API-Key": token, "Zotero-API-Version": "3", Accept: "application/json" };
  const res = await call("https://api.zotero.org/keys/current", { headers });
  if (res.status === 403 || res.status === 401) throw new TokenRejectedError("Zotero didn't accept that API key.");
  if (!res.ok) rejected("Zotero", res.status);
  const body = (res.body ?? {}) as { userID?: number; username?: string; displayName?: string; access?: { user?: ZoteroAccess; groups?: Record<string, { library?: boolean; write?: boolean }> } };
  const userID = Number(body.userID);
  if (!Number.isSafeInteger(userID) || userID <= 0) throw new TokenRejectedError("Zotero didn't say whose key that is. Try again, or create a new key.");
  const user = body.access?.user ?? {};
  const grants = body.access?.groups ?? {};
  const readable = (id: number) => Boolean(grants.all?.library || grants[String(id)]?.library);
  let groups: Array<{ id: number; name: string; write: boolean }> = [];
  if (Object.values(grants).some((grant) => grant?.library)) {
    const listed = await call(`https://api.zotero.org/users/${userID}/groups?limit=100`, { headers });
    const rows = listed.ok && Array.isArray(listed.body) ? (listed.body as Array<{ id?: number; data?: { name?: string } }>) : [];
    groups = rows
      .filter((row): row is { id: number; data?: { name?: string } } => typeof row?.id === "number" && Number.isSafeInteger(row.id) && row.id > 0 && readable(row.id))
      .slice(0, ZOTERO_MAX_GROUPS)
      .map((row) => ({ id: row.id, name: String(row.data?.name ?? `Group ${row.id}`).slice(0, 120), write: Boolean(grants.all?.write || grants[String(row.id)]?.write) }));
  }
  if (!user.library && !groups.length) throw new TokenRejectedError("This key can't read your library. Edit the key and tick Allow library access.");
  return {
    secret: token,
    account: body.username || body.displayName || `Zotero user ${userID}`,
    meta: { via: "token", userID, username: body.username ?? null, library: Boolean(user.library), notes: Boolean(user.notes), write: Boolean(user.write), groups },
  };
}

export const isTokenProvider = (value: string): value is TokenProvider & AccountProvider => (TOKEN_PROVIDERS as readonly string[]).includes(value);
