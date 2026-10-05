import { normalizeCookieDomain } from "@ensemble/shared-types/cookie-site";

/** Options that clear the session cookie, including a shared Domain. */
export function sessionCookieDelete(domainRaw: string | undefined): { name: "ensemble_session"; path: "/"; domain?: string } {
  const domain = normalizeCookieDomain(domainRaw);
  if (!domain) return { name: "ensemble_session", path: "/" };
  return { name: "ensemble_session", path: "/", domain };
}
