/**
 * The live stream talks to hub-api directly. Vercel closes a proxied
 * response at about 120 seconds, so the EventSource must not use the
 * Next rewrite. Ordinary `/api` calls still go through that rewrite.
 * Cross-origin EventSource sends the session cookie only when
 * withCredentials is set.
 */
export function eventsStreamUrl(hubApi: string): string {
  const trimmed = hubApi.replace(/\/$/, "");
  const base = trimmed.includes("localhost") ? trimmed.replaceAll("localhost", "127.0.0.1") : trimmed;
  return `${base}/api/events`;
}

export function eventSourceInit(): { withCredentials: true } {
  return { withCredentials: true };
}

/** Live co-editing steps from the stream (`page.steps`), re-dispatched on `window` for open pages. */
export const PAGE_STEPS_EVENT = "ensemble:page-steps";
/** The stream reconnected after a drop: live pages fetch the steps they missed. */
export const LIVE_REOPENED_EVENT = "ensemble:live-reopened";
