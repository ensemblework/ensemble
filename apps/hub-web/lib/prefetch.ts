import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { isoDate } from "./format";
import { loadToday, seedToday, workWeek } from "./home";

const recent = new Map<string, number>();
const RECENT_MAX = 32;

/** Paths the sidebar prefetch actually requests. Navigation must not abort these. */
const API_PATHS: Record<string, string[]> = {
  "/today": ["/api/today/home"],
  "/board": ["/api/tasks"],
  "/needs-me": ["/api/tasks", "/api/approvals", "/api/decisions"],
  "/runs": ["/api/runs"],
  "/context": ["/api/people"],
  "/skills": ["/api/skills"],
  "/workspace": ["/api/workspace"],
  "/code": ["/api/code/repos", "/api/code/reviews"],
  "/diagrams": ["/api/diagrams"],
  "/metrics": ["/api/metrics/summary"],
  "/meetings": ["/api/meetings/sessions"],
  "/recap": ["/api/recap/week"],
  "/settings": ["/api/settings"],
  "/connect": ["/api/connect/bridge"],
};

/**
 * The desktop static export sets `trailingSlash`, so the address bar and
 * Next's history update use `/runs/`. That is the same page as `/runs`.
 */
export function prefetchRoute(href: string): string {
  if (href.length > 1 && href.endsWith("/")) return href.slice(0, -1);
  return href;
}

export function prefetchApiPaths(href: string): string[] {
  const route = prefetchRoute(href);
  if (route.startsWith("/connect/")) return API_PATHS["/connect"] ?? [];
  return API_PATHS[route] ?? [];
}

/** True when `requestPath` is the data fetch for `href` (query string ignored). */
export function isPrefetchRequest(href: string, requestPath: string): boolean {
  const bare = requestPath.split("?")[0] ?? requestPath;
  return prefetchApiPaths(href).includes(bare);
}

function jobsFor(client: QueryClient, href: string): Array<[unknown[], () => Promise<unknown>]> {
  href = prefetchRoute(href);
  const week = workWeek(0);
  const from = week.start.toISOString();
  const to = week.end.toISOString();
  const jobs: Array<[unknown[], () => Promise<unknown>]> =
    href === "/today"
      ? [
          [
            ["home", from],
            async () => {
              const data = await loadToday(from, to);
              seedToday(client, data, isoDate(week.start));
              return data;
            },
          ],
        ]
      : href === "/board" || href === "/needs-me"
        ? [[["tasks"], api.tasks]]
        : href === "/runs"
          ? [[["runs", false], () => api.runs(10)]]
          : href === "/context"
            ? [[["people"], api.people]]
            : href === "/skills"
              ? [[["skills"], api.skills]]
              : href === "/workspace"
                ? [[["workspace"], api.workspace]]
                : href === "/code"
                  ? [
                      [["code-repos"], api.codeRepos],
                      [["reviews", "needs", false], () => api.reviews("needs", false)],
                    ]
                  : href === "/diagrams"
                    ? [[["diagrams"], api.diagrams]]
                  : href === "/metrics"
                    ? [[["metrics"], api.metrics]]
                    : href === "/meetings"
                      ? [[["meeting-sessions"], api.meetingSessions]]
                      : href === "/recap"
                        ? [[["weekly-recap"], () => api.weeklyRecap()]]
                    : href === "/settings"
                      ? [[["settings"], api.settings]]
                      : href === "/connect" || href.startsWith("/connect/")
                        ? [[["connect-bridge"], api.connectBridge]]
                        : [];
  if (href === "/needs-me") {
    jobs.push([["approvals"], api.approvals], [["decisions"], () => api.decisions()]);
  }
  return jobs;
}

/** Query keys a sidebar hover warms. A click to that page must not cancel them. */
export function prefetchQueryKeys(client: QueryClient, href: string): unknown[][] {
  return jobsFor(client, href).map(([key]) => key);
}

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isPrefetchQuery(client: QueryClient, href: string, queryKey: readonly unknown[]): boolean {
  return prefetchQueryKeys(client, href).some((key) => sameKey(key, queryKey));
}

/** Warm the cache for a sidebar destination. Deduped so a hover doesn't refetch. */
export function prefetchHref(client: QueryClient, href: string): void {
  const now = Date.now();
  const seen = recent.get(href);
  if (seen != null && now - seen < 20_000) {
    recent.delete(href);
    recent.set(href, seen);
    return;
  }
  recent.set(href, now);
  while (recent.size > RECENT_MAX) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
  for (const [queryKey, queryFn] of jobsFor(client, href)) {
    void client.prefetchQuery({ queryKey, queryFn, staleTime: 20_000 });
  }
}
