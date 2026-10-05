const DEV_HUB_API = "http://127.0.0.1:4000";

export const MISSING_HUB_API =
  'NEXT_PUBLIC_HUB_API is unset. A production build must set it to the public https origin of this Ensemble before `next build`. Dev keeps the localhost default.';

/** Public hub-api origin. Production builds have no localhost fallback. */
export function resolveHubApi(env: { NEXT_PUBLIC_HUB_API?: string; NODE_ENV?: string }): string {
  const value = env.NEXT_PUBLIC_HUB_API?.trim();
  if (value) return value;
  if (env.NODE_ENV === "production") throw new Error(MISSING_HUB_API);
  return DEV_HUB_API;
}
