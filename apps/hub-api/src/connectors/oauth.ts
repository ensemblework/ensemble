/**
 * Browser OAuth for connectors: consent screen → callback → oauth_tokens.
 *
 * The person clicking Connect never sees a client secret. The instance holds
 * one OAuth app per provider (env, or Settings → Connections → app setup).
 */
import { randomBytes } from "node:crypto";
import { env } from "../config.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { getAccount, oauthApp, saveAccount, type AccountProvider } from "./accounts.js";

interface ProviderSpec {
  authorize: string;
  token: string;
  scopes: string[];
  extra?: Record<string, string>;
  whoami: (token: string) => Promise<string | null>;
}

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const SPECS: Partial<Record<AccountProvider, ProviderSpec>> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: GOOGLE_SCOPES,
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    async whoami(token) {
      const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return null;
      return ((await response.json()) as { email?: string }).email ?? null;
    },
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user", "read:org"],
    async whoami(token) {
      const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Ensemble" } });
      if (!response.ok) return null;
      return ((await response.json()) as { login?: string }).login ?? null;
    },
  },
};

export const OAUTH_PROVIDERS = Object.keys(SPECS) as AccountProvider[];

export const publicApiUrl = (): string =>
  (process.env.HUB_API_PUBLIC_URL ?? `http://localhost:${env.HUB_API_PORT}`).replace(/\/$/, "");

export const redirectUri = (provider: string): string => `${publicApiUrl()}/api/connectors/${provider}/callback`;

const pending = new Map<string, { userId: string; provider: AccountProvider; returnTo: string; expires: number }>();

export async function beginOAuth(userId: string, provider: AccountProvider, returnTo: string): Promise<string> {
  await requireHostAccess(userId, "Connector OAuth (operator beta)");
  const spec = SPECS[provider];
  if (!spec) throw Object.assign(new Error(`${provider} does not use a browser sign-in.`), { statusCode: 400 });
  const app = await oauthApp(provider);
  if (!app) {
    throw Object.assign(
      new Error(
        provider === "google"
          ? "Google sign-in is not turned on yet. The person who hosts this Ensemble sets it up once."
          : `Set up the ${provider} app first (Settings → Connections).`,
      ),
      { statusCode: 409 },
    );
  }
  for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
  while (pending.size > 64) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  const state = randomBytes(24).toString("base64url");
  pending.set(state, { userId, provider, returnTo, expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: spec.scopes.join(" "),
    state,
    ...spec.extra,
  });
  return `${spec.authorize}?${params}`;
}

export async function finishOAuth(provider: string, code: string, state: string): Promise<{ userId: string; returnTo: string; account: string | null }> {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.provider !== provider || entry.expires < Date.now()) {
    throw new Error("This sign-in link expired. Press Connect again.");
  }
  await requireHostAccess(entry.userId, "Connector OAuth (operator beta)");
  const spec = SPECS[entry.provider]!;
  const app = (await oauthApp(entry.provider))!;
  const response = await fetch(spec.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri(entry.provider),
      grant_type: "authorization_code",
    }),
  });
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `Token exchange failed (${response.status}).`);
  }
  const account = await spec.whoami(body.access_token);
  await saveAccount(entry.userId, entry.provider, {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
    scopes: (body.scope ?? spec.scopes.join(" ")).split(/[ ,]+/).filter(Boolean),
    account,
  });
  return { userId: entry.userId, returnTo: entry.returnTo, account };
}

/** A usable Google access token, refreshed when it is within a minute of expiring. */
export async function googleAccessToken(userId: string): Promise<{ token: string; account: string | null } | null> {
  await requireHostAccess(userId, "Google connector OAuth (operator beta)");
  const account = await getAccount(userId, "google", false);
  if (!account) return null;
  if (account.expiresAt.getTime() > Date.now() + 60_000) return { token: account.accessToken, account: account.account };
  if (!account.refreshToken) throw new Error("Google access expired and there is no refresh token. Connect Google again.");
  const app = await oauthApp("google");
  if (!app) throw new Error("The Google app is no longer configured. Set it up again in Settings → Connections.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Google refused to refresh access (${body.error_description ?? body.error ?? response.status}). Connect Google again.`);
  }
  await saveAccount(userId, "google", {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    scopes: account.scopes,
    account: account.account,
  });
  return { token: body.access_token, account: account.account };
}
