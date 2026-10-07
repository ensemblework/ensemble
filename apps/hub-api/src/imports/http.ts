/**
 * HTTP for importers: one request at a time per import, a small gap between
 * calls, Retry-After on 429 and 503, and errors that never echo a token.
 */
import { ImportError, type ImportHttp, type ImportHttpRequest } from "./types.js";

export interface ImportHttpOptions {
  signal: AbortSignal;
  /** Minimum milliseconds between requests. */
  gapMs?: number;
  /** Headers on every request (auth). Never logged. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  label: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const MAX_WAIT_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ImportError("The import was cancelled.", 409));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ImportError("The import was cancelled.", 409));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Seconds or an HTTP date; falls back to exponential backoff. */
export function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

function friendlyStatus(label: string, status: number): string {
  if (status === 401) return `${label} did not accept the token. Check it, or connect the account again.`;
  if (status === 403) return `${label} refused access. The token may lack permission for this workspace or project.`;
  if (status === 404) return `${label} could not find that. It may have been moved, or the token cannot see it.`;
  if (status === 429) return `${label} is rate limiting this import. Try again in a few minutes.`;
  return `${label} answered with an error (${status}).`;
}

export function createImportHttp(options: ImportHttpOptions): ImportHttp {
  const gap = options.gapMs ?? 120;
  const fetcher = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 4;
  let last = 0;
  return {
    async json<T>(url: string, init: ImportHttpRequest = {}): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait, options.signal);
        last = Date.now();
        if (options.signal.aborted) throw new ImportError("The import was cancelled.", 409);
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
        let response: Response;
        try {
          response = await fetcher(url, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            headers: {
              Accept: "application/json",
              ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
              ...options.headers,
              ...init.headers,
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: AbortSignal.any([options.signal, timeout]),
          });
        } catch (error) {
          if (options.signal.aborted) throw new ImportError("The import was cancelled.", 409);
          if (attempt < maxRetries) {
            await sleep(retryAfterMs(null, attempt), options.signal);
            continue;
          }
          throw new ImportError(`${options.label} could not be reached${timeout.aborted ? " in time" : ""}.`, 502, { cause: error });
        }
        if (response.status === 429 || response.status === 503 || (response.status >= 500 && attempt < 2)) {
          if (attempt < maxRetries) {
            await response.body?.cancel().catch(() => undefined);
            await sleep(retryAfterMs(response.headers.get("retry-after"), attempt), options.signal);
            continue;
          }
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ImportError(friendlyStatus(options.label, response.status), response.status === 401 || response.status === 403 ? 400 : 502);
        }
        const text = await response.text();
        try {
          return (text ? JSON.parse(text) : {}) as T;
        } catch {
          throw new ImportError(`${options.label} sent a reply Ensemble could not read.`, 502);
        }
      }
    },
  };
}
