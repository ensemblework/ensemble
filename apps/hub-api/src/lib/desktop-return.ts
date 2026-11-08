/**
 * On a computer's own runtime, a connected app's sign-in finishes in the system browser, which has no
 * Ensemble page to go back to. It lands on a small page this runtime serves instead
 * (`GET /api/desktop/connected`, desktop/account.ts); the app's window sees the new connection itself.
 */
export function desktopReturnUrl(ok: boolean, what: string): string | null {
  if (process.env.ENSEMBLE_DESKTOP !== "1") return null;
  const base = (process.env.HUB_API_PUBLIC_URL?.trim() || `http://127.0.0.1:${process.env.HUB_API_PORT ?? 4000}`).replace(/\/+$/, "");
  return `${base}/api/desktop/connected?${new URLSearchParams({ ok: ok ? "1" : "0", what: what.slice(0, 60) })}`;
}
