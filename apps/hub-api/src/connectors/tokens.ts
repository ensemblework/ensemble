/**
 * One way for tools, importers and syncs to get a usable provider token.
 *
 * Callers never read oauth_tokens directly: this refreshes expiring tokens,
 * checks that the scopes a product needs were granted, and turns "not
 * connected" into an error the person can act on.
 */
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { getAccount, type Account, type AccountProvider } from "./accounts.js";
import { freshAccount, ReconnectNeededError } from "./oauth.js";

export interface ProviderToken {
  token: string;
  account: string | null;
  scopes: string[];
  /**
   * Provider-specific values saved at connect time, as strings: Atlassian `cloudId`, `site` and
   * `auth` ("bearer" for OAuth through api.atlassian.com, "basic" for email:token against the site),
   * Trello `key`, DocuSign `accountId`/`baseUri`, Notion `workspaceName`, Linear `auth` ("bearer" or "key"),
   * and `via` ("oauth" or "token").
   */
  extra?: Record<string, string>;
  /** The same details with their original JSON types. */
  meta?: Record<string, unknown>;
}

export class ConnectorNotConnectedError extends Error {
  readonly statusCode = 409;
  readonly expose = true;
  constructor(
    readonly provider: AccountProvider,
    message: string,
    readonly missingScopes: readonly string[] = [],
  ) {
    super(message);
    this.name = "ConnectorNotConnectedError";
  }
}

const stringExtra = (meta: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
      .map(([key, value]) => [key, String(value)]),
  );

async function refreshed(userId: string, account: Account): Promise<Account> {
  try {
    return await freshAccount(userId, account);
  } catch (error) {
    if (error instanceof ReconnectNeededError) throw new ConnectorNotConnectedError(account.provider, error.message);
    throw error;
  }
}

/** A fresh token for this person's own connection, or null when they have not connected the provider. */
export async function providerAccessToken(userId: string, provider: AccountProvider): Promise<ProviderToken | null> {
  await requireVerifiedUser(userId);
  const stored = await getAccount(userId, provider, false, false);
  if (!stored) return null;
  const account = await refreshed(userId, stored);
  return { token: account.accessToken, account: account.account, scopes: account.scopes, extra: stringExtra(account.meta), meta: account.meta };
}

/** For syncs: this person's own token (refreshed), else the local-developer fallback (env vars, gh CLI) where allowed. */
export async function syncAccount(userId: string, provider: AccountProvider): Promise<Account | null> {
  const own = await getAccount(userId, provider, false, false);
  if (own) return refreshed(userId, own);
  return getAccount(userId, provider);
}

const GOOGLE = "https://www.googleapis.com/auth/";

/** A broader grant that covers a narrower one. Keys and values are normalized (lower case, no Graph prefix). */
const IMPLIED: Record<string, readonly string[]> = {
  "files.readwrite": ["files.read"],
  "files.read.all": ["files.read"],
  "files.readwrite.all": ["files.read.all", "files.readwrite", "files.read"],
  "calendars.readwrite": ["calendars.read"],
  "mail.readwrite": ["mail.read"],
  [`${GOOGLE}calendar`]: [`${GOOGLE}calendar.events`, `${GOOGLE}calendar.readonly`, `${GOOGLE}calendar.events.readonly`, `${GOOGLE}calendar.calendarlist.readonly`],
  [`${GOOGLE}calendar.events`]: [`${GOOGLE}calendar.events.readonly`],
  [`${GOOGLE}drive`]: [`${GOOGLE}drive.file`, `${GOOGLE}drive.readonly`],
  [`${GOOGLE}userinfo.email`]: ["email"],
  [`${GOOGLE}userinfo.profile`]: ["profile"],
};

const normalize = (scope: string): string => scope.trim().replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();

function granted(scopes: readonly string[]): Set<string> {
  const set = new Set(scopes.map(normalize));
  for (const scope of [...set]) for (const implied of IMPLIED[scope] ?? []) set.add(implied);
  return set;
}

/** The requested scopes this token does not cover. Case and Graph's resource prefix do not matter. */
export function missingScopes(token: Pick<ProviderToken, "scopes">, scopes: readonly string[]): string[] {
  const have = granted(token.scopes);
  return scopes.filter((scope) => !have.has(normalize(scope)));
}

export function hasScopes(token: Pick<ProviderToken, "scopes">, scopes: readonly string[]): boolean {
  return missingScopes(token, scopes).length === 0;
}

/** Like providerAccessToken, but throws a ConnectorNotConnectedError that tells the person what to connect. */
export async function requireProviderToken(
  userId: string,
  provider: AccountProvider,
  scopes: readonly string[] = [],
  label: string = provider,
): Promise<ProviderToken> {
  const token = await providerAccessToken(userId, provider);
  if (!token) throw new ConnectorNotConnectedError(provider, `${label} is not connected. Connect it in Settings → Connections.`);
  const missing = missingScopes(token, scopes);
  if (missing.length) {
    throw new ConnectorNotConnectedError(
      provider,
      `${label} is connected without the access this needs. Turn it on in Settings → Connections and approve the new permission.`,
      missing,
    );
  }
  return token;
}
