/**
 * Pages that exist on their own, apart from the hub catch-all.
 * An unknown URL is not in this set: signed-in visitors get the in-shell 404,
 * signed-out visitors get the standalone page.
 */
const EXACT = new Set([
  "/",
  "/login",
  "/signup",
  "/forgot",
  "/reset",
  "/verify",
  "/link",
  "/today",
  "/board",
  "/needs-me",
  "/runs",
  "/context",
  "/skills",
  "/workspace",
  "/code",
  "/code/review",
  "/metrics",
  "/meetings",
  "/recap",
  "/completed",
  "/trash",
  "/connect",
  "/settings",
  "/start",
  "/spaces/new",
  "/shared",
  "/welcome",
  "/unavailable",
  "/diagrams",
  "/plots",
  "/marketplace",
  "/projects",
  "/lost",
]);

/** One dynamic segment under a real page, such as /tasks/:id. */
const ONE_SEGMENT = ["/tasks/", "/pages/", "/projects/", "/plots/", "/diagrams/", "/connect/", "/marketplace/", "/shared/", "/p/"];

export function isAppRoute(pathname: string): boolean {
  if (EXACT.has(pathname)) return true;
  for (const prefix of ONE_SEGMENT) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    if (rest.length > 0 && !rest.includes("/")) return true;
  }
  return false;
}

export const APP_EXACT_ROUTES: readonly string[] = [...EXACT];
export const APP_DYNAMIC_PREFIXES: readonly string[] = ONE_SEGMENT;
