/**
 * WebKit does not reject an aborted fetch with AbortError. It rejects with
 * `TypeError: Load failed`, and it may also report
 * "…/api/settings due to access control checks". Chromium uses AbortError.
 * Those WebKit failures are cancellations only while the signal is already
 * aborted or the document is going away. The same TypeError on a live page
 * is a real network failure.
 */

export class RequestCancelledError extends Error {
  readonly cancelled = true;

  constructor() {
    super("Request cancelled");
    this.name = "AbortError";
  }
}

type QueryContext = {
  queryKey: readonly unknown[];
  client: { getQueryCache: () => unknown };
  signal: AbortSignal;
};

type Tracked = {
  controller: AbortController;
  epoch: number;
  /** Request path, including the query string, so a navigation can keep the page it is opening. */
  path?: string;
  onExternal?: () => void;
  external?: AbortSignal;
};

const tracked = new Set<Tracked>();

let epoch = 0;
let navPending = false;
let unloading = false;
let stacked: AbortSignal | undefined;

export function isPageUnloading(): boolean {
  return unloading;
}

export function setPageUnloading(value: boolean): void {
  unloading = value;
}

export function isWebKitCancelError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /load failed|access control checks/i.test(error.message);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof RequestCancelledError || (error instanceof Error && error.name === "AbortError");
}

/**
 * True when the rejection is a cancelled request, not a down server.
 * `signal.aborted` covers any engine. The WebKit messages count only when
 * that signal has aborted or the page is unloading.
 */
export function isRequestCancelled(
  error: unknown,
  context: { signal?: AbortSignal | null; unloading?: boolean } = {},
): boolean {
  if (isAbortError(error)) return true;
  if (context.signal?.aborted) return true;
  if (context.unloading && isWebKitCancelError(error)) return true;
  return false;
}

/** Call-site helper. Reads the current unload flag. */
export function isSilentCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  return isRequestCancelled(error, { signal, unloading });
}

export function isQueryContext(value: unknown): value is QueryContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { queryKey?: unknown; client?: { getQueryCache?: unknown } };
  return Array.isArray(record.queryKey) && typeof record.client?.getQueryCache === "function";
}

/** React Query passes its context as the first argument of a queryFn. Reading `.signal` opts the query into cancellation. */
export function withQuerySignal<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const first = args[0];
    if (args.length <= 1 && isQueryContext(first)) {
      const signal = first.signal;
      return runWithSignal(signal, () => fn(...([] as unknown as A)));
    }
    return fn(...args);
  };
}

export function bindClient<T extends Record<string, (...args: never[]) => unknown>>(source: T): T {
  const bound = {} as T;
  for (const key of Object.keys(source) as Array<keyof T>) {
    const fn = source[key] as unknown as (...args: unknown[]) => unknown;
    bound[key] = withQuerySignal(fn) as unknown as T[keyof T];
  }
  return bound;
}

export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  const previous = stacked;
  stacked = signal;
  try {
    return fn();
  } finally {
    stacked = previous;
  }
}

export function currentExternalSignal(): AbortSignal | undefined {
  return stacked;
}

export function trackRequest(external?: AbortSignal | null, path?: string): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const entry: Tracked = { controller, epoch, path, external: external ?? undefined };
  if (external) {
    const onExternal = () => {
      if (!controller.signal.aborted) controller.abort(new RequestCancelledError());
    };
    entry.onExternal = onExternal;
    if (external.aborted) onExternal();
    else external.addEventListener("abort", onExternal);
  }
  tracked.add(entry);
  return {
    signal: controller.signal,
    close() {
      tracked.delete(entry);
      if (external && entry.onExternal) external.removeEventListener("abort", entry.onExternal);
    },
  };
}

export function abortAll(): void {
  for (const entry of tracked) {
    if (!entry.controller.signal.aborted) entry.controller.abort(new RequestCancelledError());
  }
}

export function abortOlderThan(nextEpoch: number, keep?: (path: string) => boolean): void {
  for (const entry of tracked) {
    if (entry.epoch < nextEpoch && !entry.controller.signal.aborted) {
      if (keep && entry.path && keep(entry.path)) continue;
      entry.controller.abort(new RequestCancelledError());
    }
  }
}

/**
 * Bump the navigation epoch once per turn and abort requests that started
 * before it. `keep` leaves the destination page's prefetch running so the
 * click does not abort it and start a second fetch. A click and the history
 * update that follows share one turn. Returns false when this turn already
 * started a navigation.
 */
export function beginNavigation(keep?: (path: string) => boolean): boolean {
  if (navPending) return false;
  navPending = true;
  epoch += 1;
  abortOlderThan(epoch, keep);
  queueMicrotask(() => {
    navPending = false;
  });
  return true;
}

export function installFetchGuards(onNavigate: (pathname: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const abortForUnload = () => {
    setPageUnloading(true);
    abortAll();
  };
  // beforeunload can be cancelled. Drop in-flight work, then clear the flag
  // on the next turn if the document is still visible. Fetch rejections are
  // queued before that clear, so they still see the flag.
  const onBeforeUnload = () => {
    abortForUnload();
    queueMicrotask(() => {
      if (document.visibilityState === "visible") setPageUnloading(false);
    });
  };
  const onPageShow = () => setPageUnloading(false);
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (isSilentCancellation(reason) || (isPageUnloading() && isWebKitCancelError(reason))) {
      event.preventDefault();
    }
  };
  const onClick = (event: MouseEvent) => {
    if (isAppNavigation(event)) onNavigate(clickPathname(event));
  };
  const onPop = () => onNavigate(window.location.pathname);

  const originalPush = history.pushState.bind(history);
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    const url = args[2];
    if (url != null && urlChanges(String(url))) onNavigate(pathnameOf(String(url)));
    return originalPush(...args);
  }) as History["pushState"];

  window.addEventListener("pagehide", abortForUnload);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("popstate", onPop);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("click", onClick, true);

  return () => {
    history.pushState = originalPush;
    window.removeEventListener("pagehide", abortForUnload);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("click", onClick, true);
  };
}

function pathnameOf(url: string): string | null {
  try {
    return new URL(url, window.location.href).pathname;
  } catch {
    return null;
  }
}

function clickPathname(event: MouseEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a");
  if (!anchor) return null;
  return pathnameOf(anchor.href);
}

function urlChanges(url: string): boolean {
  try {
    const next = new URL(url, window.location.href);
    return next.origin === window.location.origin && (next.pathname !== window.location.pathname || next.search !== window.location.search);
  } catch {
    return false;
  }
}

function isAppNavigation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a");
  if (!anchor || anchor.hasAttribute("download")) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  return url.pathname !== window.location.pathname || url.search !== window.location.search;
}

/** Test hook. Aborts leftover controllers and clears module state. */
export function resetFetchCancelState(): void {
  abortAll();
  tracked.clear();
  epoch = 0;
  navPending = false;
  unloading = false;
  stacked = undefined;
}
