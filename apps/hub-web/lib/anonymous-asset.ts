/**
 * Files a signed-out browser, a PWA install, or a link-preview scraper must
 * be able to fetch. Middleware lets these through and its matcher skips them.
 */
const ANONYMOUS =
  /^\/(?:icon\.svg|favicon\.ico|robots\.txt|apple-icon(?:\.png)?|apple-touch-icon\.png|manifest\.webmanifest|site\.webmanifest|icon(?:-maskable)?-\d+\.png|brand-icon-\d+\.png|og-image\.png|opengraph-image(?:\.png)?|twitter-image(?:\.png)?|offline\.html|404\.html|500\.html)$/;

export function isAnonymousAsset(pathname: string): boolean {
  return ANONYMOUS.test(pathname);
}
