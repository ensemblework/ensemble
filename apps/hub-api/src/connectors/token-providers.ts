/**
 * Connecting with a pasted personal token. Each token is checked against the
 * provider once before it is stored (encrypted, through saveAccount).
 */
import { z } from "zod";
import type { AccountProvider } from "./accounts.js";
import { meetingSource } from "./meetings/index.js";
import { MEETING_VENDORS, MeetingTokenError } from "./meetings/types.js";

export const TOKEN_PROVIDERS = ["github", "slack", "linear", "notion", "atlassian", "trello", "asana", "todoist", "clickup", "monday", ...MEETING_VENDORS] as const;
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
      if (!input.key) throw new TokenRejectedError("Enter your Trello API key as well as the token.");
      if (!/^[A-Za-z0-9]+$/.test(input.key) || !/^[A-Za-z0-9]+$/.test(token)) throw new TokenRejectedError("That Trello key or token has characters Trello never uses.");
      const res = await call("https://api.trello.com/1/members/me?fields=username,fullName", {
        headers: { Authorization: `OAuth oauth_consumer_key="${input.key}", oauth_token="${token}"`, Accept: "application/json" },
      });
      if (!res.ok) rejected("Trello", res.status);
      const body = res.body as { username?: string; fullName?: string };
      return { secret: token, account: body.username ?? body.fullName ?? "Trello", meta: { via: "token", key: input.key } };
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
  }
  throw new TokenRejectedError("That service does not take a pasted token.");
}

export const isTokenProvider = (value: string): value is TokenProvider & AccountProvider => (TOKEN_PROVIDERS as readonly string[]).includes(value);
