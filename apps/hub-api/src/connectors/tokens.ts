/**
 * One way for tools, importers and syncs to get a usable provider token.
 *
 * Callers never read oauth_tokens directly: this refreshes expiring tokens,
 * checks that the scopes a product needs were granted, and turns "not
 * connected" into an error the person can act on.
 */
import { getAccount, type AccountProvider } from "./accounts.js";
import { googleAccessToken } from "./oauth.js";

export interface ProviderToken {
  token: string;
  account: string | null;
  scopes: string[];
  /** Provider-specific values saved at connect time, e.g. Atlassian cloudId or DocuSign base URI. */
  extra?: Record<string, string>;
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

/** A fresh token for this person's own connection, or null when they have not connected the provider. */
export async function providerAccessToken(userId: string, provider: AccountProvider): Promise<ProviderToken | null> {
  if (provider === "google") {
    const google = await googleAccessToken(userId);
    if (!google) return null;
    const account = await getAccount(userId, "google", false);
    return { token: google.token, account: google.account, scopes: account?.scopes ?? [] };
  }
  const account = await getAccount(userId, provider, false, false);
  if (!account) return null;
  return { token: account.accessToken, account: account.account, scopes: account.scopes };
}

export function hasScopes(token: ProviderToken, scopes: readonly string[]): boolean {
  const granted = new Set(token.scopes);
  return scopes.every((scope) => granted.has(scope));
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
  const missing = scopes.filter((scope) => !token.scopes.includes(scope));
  if (missing.length) {
    throw new ConnectorNotConnectedError(
      provider,
      `${label} is connected without the access this needs. Turn it on in Settings → Connections and approve the new permission.`,
      missing,
    );
  }
  return token;
}
