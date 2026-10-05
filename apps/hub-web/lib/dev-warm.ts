/**
 * Next.js turns Link prefetch off in development, so the first click on a
 * route compiles it. A compile of a few seconds looks like the click did
 * nothing. Ask the dev server for each route once, after Today has painted,
 * so a later click is already compiled.
 */
const ROUTES = ["/metrics", "/settings", "/board", "/needs-me", "/code", "/workspace", "/runs", "/context", "/meetings", "/recap", "/diagrams", "/skills", "/plots", "/marketplace"];

export function startDevWarm(): () => void {
  if (process.env.NODE_ENV !== "development") return () => {};
  let cancelled = false;
  // Wait until the page's own requests have gone quiet. A sooner loop keeps
  // Playwright's networkidle from settling, and it races the first click.
  const start = window.setTimeout(() => {
    void (async () => {
      for (const href of ROUTES) {
        if (cancelled) return;
        try {
          await fetch(href, {
            credentials: "same-origin",
            headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Url": href },
            signal: AbortSignal.timeout(12_000),
          });
        } catch {
          // The dev server is busy compiling something else.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    })();
  }, 8_000);
  return () => {
    cancelled = true;
    window.clearTimeout(start);
  };
}
