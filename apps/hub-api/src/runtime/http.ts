/** How the in-process runtime sends a request to a model vendor: one fetch hook, timeouts, and retries. */
import { normalizeTransportError } from "../lib/stream-drop.js";
import { ProviderError, parseProviderError } from "./errors.js";
import { runtimeSleep } from "./pace.js";
import { retryPlan, type Json } from "./payload.js";

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

export function setRuntimeFetchForTests(fetchFn: typeof fetch | null): void {
  fetchImpl = fetchFn ?? globalThis.fetch.bind(globalThis);
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function vendorFetch(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  return fetchImpl(url, { ...init, signal: combineSignals(signal, timeoutMs) });
}

export async function sendJson(
  url: string,
  headers: Record<string, string>,
  payload: Json,
  timeoutMs: number,
  signal?: AbortSignal,
  context?: { provider: string; model: string; url: string },
): Promise<Response> {
  try {
    return await vendorFetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) }, timeoutMs, signal);
  } catch (error) {
    if (!context) throw error;
    throw normalizeTransportError(error, context);
  }
}

export async function postWithRetry(
  send: (payload: Json) => Promise<Response>,
  payload: Json,
  options: { retry?: boolean; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<Response> {
  const pause = options.sleep ?? runtimeSleep;
  const retry = options.retry !== false;
  const current = { ...payload };
  let attempt = 0;
  while (true) {
    const response = await send(current);
    if (response.ok) return response;
    const body = await response.text();
    const error = parseProviderError(response.status, body, response.headers);
    if (!retry) throw error;
    const delay = retryPlan(error, attempt);
    if (delay == null) throw error;
    await pause(delay);
    attempt += 1;
  }
}

export async function readJsonObject(response: Response): Promise<Json> {
  try {
    const data = (await response.json()) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ProviderError(502, "other", "The model provider returned a non-JSON response.");
    }
    return data as Json;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(502, "other", "The model provider returned a non-JSON response.");
  }
}
