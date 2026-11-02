/**
 * Node's fetch gives up after 300 s without response headers, or between two pieces of a body (undici's
 * `headersTimeout` and `bodyTimeout`). A model call may rightly take longer than that
 * (`ENSEMBLE_MODEL_CALL_TIMEOUT_MS`, 15 minutes), so its requests go through an agent of fetch's own
 * build with neither limit, and the call's AbortSignal is what ends it. The agent's class is taken from
 * fetch's global dispatcher, so it always matches the undici inside this Node.
 */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

type DispatcherClass = new (options: { headersTimeout: number; bodyTimeout: number }) => object;

let untimed: object | null = null;

export function untimedDispatcher(): object | null {
  if (untimed) return untimed;
  try {
    void globalThis.fetch;
    const current = (globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>)[GLOBAL_DISPATCHER];
    if (typeof current?.constructor === "function") untimed = new (current.constructor as DispatcherClass)({ headersTimeout: 0, bodyTimeout: 0 });
  } catch {
    untimed = null;
  }
  return untimed;
}

/** fetch without Node's 300-second header and body limits; pass a signal to bound it. */
export function longFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const dispatcher = untimedDispatcher();
  return globalThis.fetch(input, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
}
