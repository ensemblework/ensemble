import { ensembleCookieName, normalizeCookieDomain } from "@ensemble/shared-types/cookie-site";

/** Options that clear the session cookie, including a shared Domain. */
export function sessionCookieDelete(domainRaw: string | undefined, namespace?: string): { name: string; path: "/"; domain?: string } {
  const domain = normalizeCookieDomain(domainRaw);
  const name = ensembleCookieName("session", namespace);
  if (!domain) return { name, path: "/" };
  return { name, path: "/", domain };
}
