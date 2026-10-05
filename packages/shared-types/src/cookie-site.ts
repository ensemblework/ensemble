/**
 * The site (Vercel) and hub-api (the VM) are different origins.
 * A host-only session cookie is stored for whichever host set it.
 * hub-web middleware only sees cookies sent to the site, so the cookie
 * needs Domain set to a parent of both hosts. Browsers reject a Domain
 * that is a public suffix (`.vercel.app`, `.com`), and there is no
 * parent to share across those sites. Login then looks fine on the API
 * and signed-out on every page load.
 */

const PUBLIC_SUFFIXES = new Set([
  "vercel.app",
  "now.sh",
  "github.io",
  "githubusercontent.com",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "pages.dev",
  "workers.dev",
  "netlify.app",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "railway.app",
  "render.com",
  "supabase.co",
]);

export function hostOf(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `.example.com`, or null when the value cannot be a cookie Domain. */
export function normalizeCookieDomain(raw: string | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return null;
  const domain = trimmed.replace(/^\./, "");
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..") || domain.startsWith("-") || domain.endsWith(".")) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
  if (domain === "localhost" || domain.endsWith(".localhost")) return null;
  if (PUBLIC_SUFFIXES.has(domain)) return null;
  return `.${domain}`;
}

export function domainCoversHost(domain: string, host: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const normalized = host.toLowerCase();
  return normalized === bare || normalized.endsWith(`.${bare}`);
}

/** Longest shared suffix that a browser will accept as a cookie Domain. */
export function sharedCookieParent(hostA: string, hostB: string): string | null {
  const a = hostA.toLowerCase().split(".");
  const b = hostB.toLowerCase().split(".");
  const shared: string[] = [];
  for (let i = 1; i <= Math.min(a.length, b.length); i += 1) {
    if (a[a.length - i] !== b[b.length - i]) break;
    shared.unshift(a[a.length - i]!);
  }
  while (shared.length >= 2) {
    const candidate = shared.join(".");
    if (!PUBLIC_SUFFIXES.has(candidate)) return `.${candidate}`;
    shared.shift();
  }
  return null;
}

/**
 * Null when the session cookie can be seen by both origins.
 * A message names the variable to set when production would otherwise
 * store a cookie the site never receives.
 */
export function crossOriginCookieProblem(input: {
  webOrigin: string;
  apiOrigin: string | undefined;
  cookieDomain: string | undefined;
}): string | null {
  const apiRaw = input.apiOrigin?.trim() ?? "";
  if (!apiRaw) return null;
  const web = hostOf(input.webOrigin);
  const api = hostOf(apiRaw);
  if (!web || !api) {
    return `HUB_API_PUBLIC_URL must be an http(s) origin (got "${apiRaw}"). The session cookie is compared with HUB_WEB_ORIGIN so a split site and API do not boot with a cookie the browser will drop.`;
  }
  const configured = input.cookieDomain?.trim() ?? "";
  const domain = normalizeCookieDomain(configured);
  if (configured && !domain) {
    return `ENSEMBLE_COOKIE_DOMAIN "${configured}" is not a parent domain the browser will store. Use a real parent such as .example.com, not a public suffix.`;
  }
  if (web === api) {
    if (domain && !domainCoversHost(domain, web)) {
      return `ENSEMBLE_COOKIE_DOMAIN ${domain} does not cover ${web}. Leave it unset when the site and the API are the same host.`;
    }
    return null;
  }
  const parent = sharedCookieParent(web, api);
  if (!parent) {
    return `HUB_WEB_ORIGIN (${input.webOrigin}) and HUB_API_PUBLIC_URL (${apiRaw}) do not share a parent domain. The API sets ensemble_session. A host-only cookie is not sent to the site, and browsers reject Domain on a public suffix such as vercel.app, so hub-web middleware never sees the session and every visit looks logged out. Put the site and the API under one domain (app.example.com and api.example.com) and set ENSEMBLE_COOKIE_DOMAIN to that parent.`;
  }
  if (!domain || !domainCoversHost(domain, web) || !domainCoversHost(domain, api)) {
    return `HUB_WEB_ORIGIN (${web}) and HUB_API_PUBLIC_URL (${api}) share ${parent}, but ENSEMBLE_COOKIE_DOMAIN is not that parent. Set ENSEMBLE_COOKIE_DOMAIN=${parent}. Without it the cookie stays on the API host, hub-web middleware on ${web} does not receive it, and the next page load is signed out.`;
  }
  return null;
}
