/**
 * Absolute origin for Open Graph and Twitter URLs.
 * Hosting starts on a public subdomain (DuckDNS or otherwise). The value is
 * whatever the operator set; this never invents localhost or a production host.
 */
export function publicSiteUrl(raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): URL | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}
