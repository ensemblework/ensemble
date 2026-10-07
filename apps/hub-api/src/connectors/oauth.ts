/**
 * Browser OAuth for connectors: consent screen → callback → oauth_tokens,
 * plus refresh and revoke.
 *
 * The person clicking Connect never sees a client secret. The instance holds
 * one OAuth app per provider: its own env vars, an app saved in Settings →
 * Connections, or the sign-in app of the same provider (accounts.ts).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { normalizeCookieDomain } from "@ensemble/shared-types/cookie-site";
import { env } from "../config.js";
import { sessionCookieHeader, sessionCookieSecure } from "../lib/cookie.js";
import { isHosted, requireVerifiedUser } from "../lib/hosted-access.js";
import { loadSettings } from "../lib/settings.js";
import { prisma } from "../lib/prisma.js";
import { getAccount, oauthApp, saveAccount, type Account, type AccountProvider, type OAuthApp } from "./accounts.js";
import { GOOGLE_PRODUCT_SCOPES, productState, scopesFor, suiteForProvider } from "./products.js";

type Exchange = "form" | "basic-form" | "json" | "basic-json";

export interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  /** Linear returns an array; everyone else a space- or comma-separated string. */
  scope?: string | string[];
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

interface Profile {
  account: string | null;
  meta?: Record<string, unknown>;
}

interface ProviderSpec {
  label: string;
  authorize: string;
  token: string;
  /** Scopes for providers without products. */
  scopes: readonly string[];
  /** Zoom takes scopes from the app configuration, not the URL. */
  scopeParam: "scope" | "user_scope" | null;
  scopeSeparator: " " | ",";
  extra?: Record<string, string>;
  pkce: boolean;
  exchange: Exchange;
  /** Send the scopes again on the code exchange (Microsoft). */
  exchangeScope?: boolean;
  /** Pulls the user token out of a provider-specific response (Slack's authed_user). */
  read?: (body: TokenBody) => TokenBody;
  profile: (token: string, body: TokenBody) => Promise<Profile>;
  revoke?: (account: Account, app: OAuthApp) => Promise<Response>;
}

const TIMEOUT_MS = 15_000;

const timed = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const basic = (app: OAuthApp): string => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

async function readBody<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  const response = await fetch(url, timed({ headers: { Accept: "application/json", ...headers } }));
  if (!response.ok) return null;
  return readBody<T>(response);
}

/** "common" accepts work, school and personal Microsoft accounts; a tenant id limits Connect to one organization. */
const microsoftTenant = (): string => {
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim();
  return tenant && /^[A-Za-z0-9.-]{1,100}$/.test(tenant) ? tenant : "common";
};

const docusignAuthBase = (): string =>
  process.env.DOCUSIGN_ENV?.trim().toLowerCase() === "production" ? "https://account.docusign.com" : "https://account-d.docusign.com";

export const SLACK_USER_SCOPES = ["channels:history", "groups:history", "im:history", "mpim:history", "users:read", "users:read.email"] as const;

export const ZOOM_SCOPES = [
  "user:read:user",
  "meeting:read:list_meetings",
  "cloud_recording:read:list_user_recordings",
  "cloud_recording:read:meeting_transcript",
  "meeting:read:summary",
] as const;

/** Every scope Ensemble may ask Google for. Kept for callers that list them; Connect asks only for the products that are on. */
export const GOOGLE_SCOPES = ["openid", "email", "profile", ...Object.values(GOOGLE_PRODUCT_SCOPES).flat()];

function specFor(provider: AccountProvider): ProviderSpec | undefined {
  switch (provider) {
    case "google":
      return {
        label: "Google",
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        scopes: ["openid", "email", "profile"],
        scopeParam: "scope",
        scopeSeparator: " ",
        extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
        pkce: true,
        exchange: "form",
        async profile(token) {
          const me = await getJson<{ email?: string }>("https://openidconnect.googleapis.com/v1/userinfo", bearer(token));
          return { account: me?.email ?? null };
        },
        revoke(account) {
          return fetch(
            "https://oauth2.googleapis.com/revoke",
            timed({
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: account.refreshToken ?? account.accessToken }),
            }),
          );
        },
      };
    case "microsoft":
      return {
        label: "Microsoft",
        authorize: `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`,
        scopes: ["openid", "email", "profile", "offline_access", "User.Read"],
        scopeParam: "scope",
        scopeSeparator: " ",
        extra: { response_mode: "query" },
        pkce: true,
        exchange: "form",
        exchangeScope: true,
        async profile(token) {
          const me = await getJson<{ id?: string; mail?: string | null; userPrincipalName?: string }>(
            "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",
            bearer(token),
          );
          return { account: me?.mail || me?.userPrincipalName || null, meta: me?.id ? { graphUserId: me.id } : {} };
        },
      };
    case "github":
      return {
        label: "GitHub",
        authorize: "https://github.com/login/oauth/authorize",
        token: "https://github.com/login/oauth/access_token",
        scopes: ["repo", "read:user", "read:org"],
        scopeParam: "scope",
        scopeSeparator: " ",
        pkce: true,
        exchange: "form",
        async profile(token) {
          const me = await getJson<{ login?: string }>("https://api.github.com/user", { ...bearer(token), "User-Agent": "Ensemble" });
          return { account: me?.login ?? null };
        },
        revoke(account, app) {
          return fetch(
            `https://api.github.com/applications/${encodeURIComponent(app.clientId)}/grant`,
            timed({
              method: "DELETE",
              headers: { Authorization: basic(app), Accept: "application/vnd.github+json", "User-Agent": "Ensemble", "Content-Type": "application/json" },
              body: JSON.stringify({ access_token: account.accessToken }),
            }),
          );
        },
      };
    case "linear":
      return {
        label: "Linear",
        authorize: "https://linear.app/oauth/authorize",
        token: "https://api.linear.app/oauth/token",
        scopes: ["read"],
        scopeParam: "scope",
        scopeSeparator: ",",
        pkce: true,
        exchange: "form",
        async profile(token) {
          const response = await fetch(
            "https://api.linear.app/graphql",
            timed({ method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ viewer { email } }" }) }),
          );
          const body = await readBody<{ data?: { viewer?: { email?: string } } }>(response);
          return { account: body?.data?.viewer?.email ?? null, meta: { auth: "bearer" } };
        },
        revoke(account) {
          return fetch("https://api.linear.app/oauth/revoke", timed({ method: "POST", headers: bearer(account.accessToken) }));
        },
      };
    case "notion":
      return {
        label: "Notion",
        authorize: "https://api.notion.com/v1/oauth/authorize",
        token: "https://api.notion.com/v1/oauth/token",
        scopes: [],
        scopeParam: null,
        scopeSeparator: " ",
        extra: { owner: "user" },
        pkce: false,
        exchange: "basic-json",
        async profile(_token, body) {
          const name = typeof body.workspace_name === "string" ? body.workspace_name : null;
          return {
            account: name,
            meta: {
              workspaceName: name,
              workspaceId: typeof body.workspace_id === "string" ? body.workspace_id : null,
              botId: typeof body.bot_id === "string" ? body.bot_id : null,
            },
          };
        },
      };
    case "atlassian":
      return {
        label: "Atlassian",
        authorize: "https://auth.atlassian.com/authorize",
        token: "https://auth.atlassian.com/oauth/token",
        scopes: ["read:jira-work", "read:jira-user", "offline_access"],
        scopeParam: "scope",
        scopeSeparator: " ",
        extra: { audience: "api.atlassian.com", prompt: "consent" },
        pkce: false,
        exchange: "json",
        async profile(token) {
          const sites = await getJson<Array<{ id: string; url: string; name: string; scopes?: string[] }>>(
            "https://api.atlassian.com/oauth/token/accessible-resources",
            bearer(token),
          );
          const site = sites?.find((row) => row.scopes?.includes("read:jira-work")) ?? sites?.[0];
          if (!site) throw new Error("No Jira site was shared with Ensemble. Connect again and pick a site.");
          return { account: site.name, meta: { cloudId: site.id, site: new URL(site.url).host, siteName: site.name, auth: "bearer" } };
        },
      };
    case "slack":
      return {
        label: "Slack",
        authorize: "https://slack.com/oauth/v2/authorize",
        token: "https://slack.com/api/oauth.v2.access",
        scopes: SLACK_USER_SCOPES,
        scopeParam: "user_scope",
        scopeSeparator: ",",
        pkce: false,
        exchange: "form",
        read(body) {
          const user = body.authed_user as TokenBody | undefined;
          if (body.ok === false) return { error: typeof body.error === "string" ? body.error : "slack_error" };
          return user?.access_token ? user : body;
        },
        async profile(token) {
          const me = await getJson<{ ok?: boolean; user?: string; team?: string; user_id?: string; team_id?: string; url?: string }>(
            "https://slack.com/api/auth.test",
            bearer(token),
          );
          if (!me?.ok) return { account: null };
          return { account: `${me.user} @ ${me.team}`, meta: { teamId: me.team_id ?? null, slackUserId: me.user_id ?? null, url: me.url ?? null } };
        },
        revoke(account) {
          return fetch("https://slack.com/api/auth.revoke", timed({ method: "POST", headers: bearer(account.accessToken) }));
        },
      };
    case "zoom":
      return {
        label: "Zoom",
        authorize: "https://zoom.us/oauth/authorize",
        token: "https://zoom.us/oauth/token",
        scopes: ZOOM_SCOPES,
        scopeParam: null,
        scopeSeparator: " ",
        pkce: true,
        exchange: "basic-form",
        async profile(token) {
          const me = await getJson<{ id?: string; email?: string }>("https://api.zoom.us/v2/users/me", bearer(token));
          return { account: me?.email ?? null, meta: me?.id ? { zoomUserId: me.id } : {} };
        },
        revoke(account, app) {
          return fetch(
            "https://zoom.us/oauth/revoke",
            timed({
              method: "POST",
              headers: { Authorization: basic(app), "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: account.accessToken }),
            }),
          );
        },
      };
    case "docusign": {
      const base = docusignAuthBase();
      return {
        label: "Docusign",
        authorize: `${base}/oauth/auth`,
        token: `${base}/oauth/token`,
        scopes: ["signature"],
        scopeParam: "scope",
        scopeSeparator: " ",
        pkce: true,
        exchange: "basic-form",
        async profile(token) {
          const me = await getJson<{
            email?: string;
            accounts?: Array<{ account_id: string; is_default?: boolean; account_name?: string; base_uri: string }>;
          }>(`${base}/oauth/userinfo`, bearer(token));
          const account = me?.accounts?.find((row) => row.is_default) ?? me?.accounts?.[0];
          if (!account) throw new Error("This Docusign login has no account Ensemble can read.");
          return {
            account: me?.email ?? account.account_name ?? null,
            meta: { accountId: account.account_id, baseUri: account.base_uri, accountName: account.account_name ?? null, env: base.includes("account-d") ? "demo" : "production" },
          };
        },
      };
    }
    default:
      return undefined;
  }
}

/** Providers people connect through a browser consent screen. */
export const OAUTH_PROVIDERS: AccountProvider[] = ["google", "microsoft", "github", "linear", "notion", "atlassian", "slack", "zoom", "docusign"];

export const providerLabel = (provider: AccountProvider): string => specFor(provider)?.label ?? provider;

export const publicApiUrl = (): string =>
  (process.env.HUB_API_PUBLIC_URL ?? `http://localhost:${env.HUB_API_PORT}`).replace(/\/$/, "");

export const redirectUri = (provider: string): string => `${publicApiUrl()}/api/connectors/${provider}/callback`;

interface Pending {
  userId: string;
  provider: AccountProvider;
  returnTo: string;
  scopes: string[];
  products?: Record<string, boolean>;
  verifier?: string;
  /** sha256 of the nonce in the browser's connect cookie. */
  browserHash?: Buffer;
  expires: number;
}

const pending = new Map<string, Pending>();

export const CONNECT_FLOW_SECONDS = 600;

/** HttpOnly cookie set by Connect that ties the callback to the browser that pressed it. */
export const connectCookieName = (provider: string): string => `ensemble_connect_${provider}`;

export const newBrowserNonce = (): string => randomBytes(32).toString("base64url");

/**
 * HttpOnly, SameSite=Lax (sent on the provider's top-level redirect back), Secure in
 * production, and on ENSEMBLE_COOKIE_DOMAIN like the session so the Hub's fetch to
 * /start and the provider's redirect to /callback share it. Empty value with 0 clears it.
 */
export function connectCookieHeader(provider: string, value: string, maxAge: number, request: Pick<FastifyRequest, "protocol" | "headers">): string {
  const secure = sessionCookieSecure({ nodeEnv: process.env.NODE_ENV, protocol: request.protocol, forwardedProto: request.headers["x-forwarded-proto"] });
  return sessionCookieHeader(connectCookieName(provider), value, maxAge, secure, normalizeCookieDomain(process.env.ENSEMBLE_COOKIE_DOMAIN));
}

const nonceHash = (nonce: string): Buffer => createHash("sha256").update(nonce).digest();

/** Who is at the callback: the browser's Ensemble session and its connect cookie. */
export interface CallbackBrowser {
  userId: string | null;
  nonce: string | null;
}

export class OAuthBrowserMismatchError extends Error {
  readonly statusCode = 403;
  readonly expose = true;
  constructor() {
    super("Open this from the Ensemble account that started connecting, in the same browser, then press Connect again.");
    this.name = "OAuthBrowserMismatchError";
  }
}

function sameBrowser(entry: Pending, browser: CallbackBrowser): boolean {
  if (!browser.userId || browser.userId !== entry.userId || !browser.nonce || !entry.browserHash) return false;
  const given = nonceHash(browser.nonce);
  return given.length === entry.browserHash.length && timingSafeEqual(given, entry.browserHash);
}

/** The scopes Connect asks for: base plus the products that are on (or the provider's fixed scopes). */
export async function requestedScopes(userId: string, provider: AccountProvider, products?: Record<string, boolean>): Promise<{ scopes: string[]; products?: Record<string, boolean> }> {
  const spec = specFor(provider);
  const suite = suiteForProvider(provider);
  if (!suite) return { scopes: [...(spec?.scopes ?? [])] };
  const chosen = products ?? productState(suite, await loadSettings(prisma, userId));
  return { scopes: scopesFor(suite, chosen), products: chosen };
}

export async function beginOAuth(
  userId: string,
  provider: AccountProvider,
  returnTo: string,
  products?: Record<string, boolean>,
  /** The value of the connect cookie set on this browser. Hosted callbacks without a match are refused. */
  browserNonce?: string,
): Promise<string> {
  await requireVerifiedUser(userId);
  const spec = specFor(provider);
  if (!spec) throw Object.assign(new Error(`${provider} does not use a browser sign-in.`), { statusCode: 400 });
  const app = await oauthApp(provider);
  if (!app) {
    throw Object.assign(
      new Error(`${spec.label} is not set up on this server yet. The person who hosts this Ensemble adds the ${spec.label} app once.`),
      { statusCode: 409, expose: true },
    );
  }
  const requested = await requestedScopes(userId, provider, products);
  for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
  while (pending.size > 256) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = spec.pkce ? randomBytes(32).toString("base64url") : undefined;
  pending.set(state, {
    userId,
    provider,
    returnTo,
    scopes: requested.scopes,
    products: requested.products,
    verifier,
    browserHash: browserNonce ? nonceHash(browserNonce) : undefined,
    expires: Date.now() + CONNECT_FLOW_SECONDS * 1000,
  });
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    state,
    ...(spec.scopeParam && requested.scopes.length ? { [spec.scopeParam]: requested.scopes.join(spec.scopeSeparator) } : {}),
    ...spec.extra,
    ...(verifier ? { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" } : {}),
  });
  return `${spec.authorize}?${params}`;
}

/** Where a callback for this state should send the person back to, without consuming it. */
export function pendingReturnTo(state: string): string | null {
  const entry = pending.get(state);
  return entry && entry.expires >= Date.now() ? entry.returnTo : null;
}

const MICROSOFT_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

/** Scopes as stored: Graph's resource prefix removed so "Mail.Read" matches either form. */
export function normalizeScopes(raw: unknown, fallback: readonly string[]): string[] {
  const text = Array.isArray(raw) ? raw.filter((scope) => typeof scope === "string").join(" ") : typeof raw === "string" ? raw : fallback.join(" ");
  const list = text.split(/[ ,]+/).filter(Boolean);
  return [...new Set(list.map((scope) => scope.replace(MICROSOFT_PREFIX, "")))];
}

const expiry = (expiresIn: number | string | undefined): Date | undefined => {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : undefined;
};

async function tokenRequest(spec: ProviderSpec, app: OAuthApp, fields: Record<string, string>): Promise<{ status: number; ok: boolean; body: TokenBody }> {
  const json = spec.exchange === "json" || spec.exchange === "basic-json";
  const withBasic = spec.exchange === "basic-form" || spec.exchange === "basic-json";
  const payload = withBasic ? fields : { ...fields, client_id: app.clientId, client_secret: app.clientSecret };
  const response = await fetch(
    spec.token,
    timed({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
        ...(withBasic ? { Authorization: basic(app) } : {}),
      },
      body: json ? JSON.stringify(payload) : new URLSearchParams(payload),
    }),
  );
  const raw = (await readBody<TokenBody>(response)) ?? {};
  return { status: response.status, ok: response.ok, body: spec.read ? spec.read(raw) : raw };
}

export interface FinishedOAuth {
  userId: string;
  provider: AccountProvider;
  returnTo: string;
  account: string | null;
  scopes: string[];
  products?: Record<string, boolean>;
}

export async function finishOAuth(provider: string, code: string, state: string, browser: CallbackBrowser): Promise<FinishedOAuth> {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.provider !== provider || entry.expires < Date.now()) {
    throw new Error("This sign-in link expired. Press Connect again.");
  }
  // RFC 6749 §10.12: on a shared server a consent link sent to someone else must not
  // land their account under the sender's. Desktop and local runs have one person and
  // the system browser carries no Ensemble session, so the check is hosted-only.
  if (isHosted() && !sameBrowser(entry, browser)) throw new OAuthBrowserMismatchError();
  await requireVerifiedUser(entry.userId);
  const spec = specFor(entry.provider);
  const app = await oauthApp(entry.provider);
  if (!spec || !app) throw new Error(`${providerLabel(entry.provider)} is no longer set up on this server.`);
  const { ok, status, body } = await tokenRequest(spec, app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(entry.provider),
    ...(entry.verifier ? { code_verifier: entry.verifier } : {}),
    ...(spec.exchangeScope ? { scope: entry.scopes.join(" ") } : {}),
  });
  if (!ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `${spec.label} did not accept the sign-in (${status}).`);
  }
  const profile = await spec.profile(body.access_token, body);
  const scopes = normalizeScopes(body.scope, entry.scopes);
  await saveAccount(entry.userId, entry.provider, {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: expiry(body.expires_in),
    scopes,
    account: profile.account,
    meta: { ...profile.meta, via: "oauth" },
  });
  return { userId: entry.userId, provider: entry.provider, returnTo: entry.returnTo, account: profile.account, scopes, products: entry.products };
}

export class ReconnectNeededError extends Error {
  readonly statusCode = 409;
  readonly expose = true;
  constructor(
    readonly provider: AccountProvider,
    message: string,
  ) {
    super(message);
    this.name = "ReconnectNeededError";
  }
}

const refreshing = new Map<string, Promise<Account>>();

async function refresh(userId: string, account: Account): Promise<Account> {
  const spec = specFor(account.provider);
  const label = providerLabel(account.provider);
  if (!spec || !account.refreshToken) {
    throw new ReconnectNeededError(account.provider, `${label} access expired. Connect ${label} again in Settings → Connections.`);
  }
  const app = await oauthApp(account.provider);
  if (!app) throw new ReconnectNeededError(account.provider, `${label} is no longer set up on this server.`);
  const { ok, status, body } = await tokenRequest(spec, app, { grant_type: "refresh_token", refresh_token: account.refreshToken });
  if (!ok || !body.access_token) {
    throw new ReconnectNeededError(
      account.provider,
      `${label} refused to refresh access (${body.error_description ?? body.error ?? status}). Connect ${label} again.`,
    );
  }
  const next: Account = {
    ...account,
    accessToken: body.access_token,
    // Microsoft, Atlassian and Zoom rotate refresh tokens; the old one stops working.
    refreshToken: body.refresh_token ?? account.refreshToken,
    expiresAt: expiry(body.expires_in) ?? new Date(Date.now() + 3600_000),
    scopes: body.scope ? normalizeScopes(body.scope, account.scopes) : account.scopes,
  };
  await saveAccount(userId, account.provider, {
    accessToken: next.accessToken,
    refreshToken: body.refresh_token ?? null,
    expiresAt: next.expiresAt,
    scopes: next.scopes,
    account: account.account,
  });
  return next;
}

/** The account with a token that is good for at least another minute. Env and CLI tokens are returned as they are. */
export async function freshAccount(userId: string, account: Account): Promise<Account> {
  if (account.source !== "you" || account.expiresAt.getTime() > Date.now() + 60_000) return account;
  const key = `${userId}:${account.provider}`;
  const inflight = refreshing.get(key);
  if (inflight) return inflight;
  const job = refresh(userId, account).finally(() => refreshing.delete(key));
  refreshing.set(key, job);
  return job;
}

/** A usable Google access token, refreshed when it is within a minute of expiring. */
export async function googleAccessToken(userId: string): Promise<{ token: string; account: string | null } | null> {
  await requireVerifiedUser(userId);
  const account = await getAccount(userId, "google", false);
  if (!account) return null;
  const fresh = await freshAccount(userId, account);
  return { token: fresh.accessToken, account: fresh.account };
}

/**
 * A short-lived Google token limited to `scopes`, for handing to the browser
 * (Google Picker). It is minted from the refresh token with a narrower scope
 * and never saved, so the stored token keeps its full grant. Returns null when
 * Google does not return exactly the narrower grant.
 */
export async function googleScopedToken(userId: string, scopes: readonly string[]): Promise<string | null> {
  await requireVerifiedUser(userId);
  const account = await getAccount(userId, "google", false);
  if (!account || account.source !== "you" || !account.refreshToken) return null;
  if (!scopes.every((scope) => account.scopes.includes(scope))) return null;
  const spec = specFor("google");
  const app = await oauthApp("google");
  if (!spec || !app) return null;
  const { ok, body } = await tokenRequest(spec, app, {
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    scope: scopes.join(" "),
  });
  if (!ok || !body.access_token) return null;
  const granted = normalizeScopes(body.scope, []);
  const allowed = new Set([...scopes, "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "email", "profile"]);
  if (!granted.length || granted.some((scope) => !allowed.has(scope))) return null;
  return body.access_token;
}

/** Best effort: tells the provider to forget the grant. Pasted tokens are left alone; they belong to the person. */
export async function revokeAtProvider(account: Account): Promise<boolean> {
  if (account.meta.via !== "oauth") return false;
  const spec = specFor(account.provider);
  const app = await oauthApp(account.provider);
  if (!spec?.revoke || !app) return false;
  try {
    return (await spec.revoke(account, app)).ok;
  } catch {
    return false;
  }
}
