/**
 * Provider failures, matching apps/agent-runtime/ensemble_agent/provider_error.py.
 * `message` is the composed sentence (Python's exc.message). `describe()` is str(exc).
 */

export const DECRYPT_MESSAGE = "This stored key can't be decrypted — re-enter it in Settings → Models.";

export class DecryptError extends Error {
  readonly statusCode = 409;
  constructor(message = DECRYPT_MESSAGE) {
    super(message);
    this.name = "DecryptError";
  }
}

export class ModelAuthError extends Error {
  readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "ModelAuthError";
  }
}

/** A failure that already has the HTTP status the Python runtime would return. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CallError";
  }
}

export class ProviderError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly quotaId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    kind: string,
    message: string,
    quotaId: string | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.kind = kind;
    this.quotaId = quotaId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  describe(): string {
    const parts = [`status=${this.status}`, `kind=${this.kind}`];
    if (this.retryAfterSeconds != null) parts.push(`retryAfter=${formatRetryNumber(this.retryAfterSeconds)}`);
    if (this.quotaId) parts.push(`quotaId=${this.quotaId}`);
    parts.push(this.message);
    return parts.join(" ");
  }
}

const MESSAGE_LIMIT = 800;
const DELAY = /^(\d+(?:\.\d+)?)(ms|s)$/;
const ZERO_LIMIT = /(?:"(?:quotaValue|quotaLimit|limit)"\s*:\s*"?0(?:\.0+)?"?|\blimit\s*[:=]?\s*0\b)/i;

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  mistral: "Mistral",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  ollama: "Ollama",
};

export function friendlyKeyError(provider: string, status: number): string {
  const name = PROVIDER_NAMES[provider] ?? (provider || "The provider");
  if (status === 400 || status === 401 || status === 403) {
    if (provider === "google") {
      return "Google rejected this key (check it was copied fully and the Generative Language API is enabled).";
    }
    return `${name} rejected this key (check it was copied fully).`;
  }
  if (status === 429) return `${name} is rate-limiting this key. Wait a moment and try again.`;
  return `That key did not work for ${name}.`;
}

export function parseProviderError(
  status: number,
  bodyText: string,
  headers: Headers | Record<string, string> | null | undefined,
): ProviderError {
  const parsed = googleError(bodyText || "");
  const headerDelay = retryAfterHeader(headers);
  const retryAfter = headerDelay != null ? headerDelay : parsed.retryAfter;
  const kind = kindFor(status, bodyText || "", parsed.quotaId, parsed.limitZero);
  return new ProviderError(status, kind, composeMessage(parsed.message, parsed.quotaId, retryAfter), parsed.quotaId, retryAfter);
}

export function statusForProvider(status: number): number {
  return status === 429 || status === 503 || status === 400 || status === 404 ? status : 502;
}

/** What hub-api's HTTP client should surface for a runtime JSON error body. */
export function errorFromRuntimeBody(status: number, text: string): { message: string; statusCode: number } {
  let message = text.slice(0, 500);
  const statusCode = status === 503 || status === 400 || status === 429 || status === 404 ? status : 502;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string" && detail.trim()) message = detail.slice(0, 500);
    else if (detail && typeof detail === "object") {
      const record = detail as { message?: unknown };
      if (typeof record.message === "string" && record.message.trim()) message = record.message.slice(0, 800);
    }
  } catch {
    // not JSON
  }
  return { message, statusCode };
}

function kindFor(status: number, bodyText: string, quotaId: string | null, limitZero: boolean): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 429) return isQuota(bodyText, quotaId, limitZero) ? "quota" : "rate_limit";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status >= 500 && status <= 599) return "other";
  return "other";
}

function isQuota(bodyText: string, quotaId: string | null, limitZero: boolean): boolean {
  const haystack = bodyText.toLowerCase();
  const ident = (quotaId ?? "").toLowerCase();
  if (["per-day", "per day", "per_day", "perday"].some((token) => haystack.includes(token))) return true;
  if (ident.includes("per_day") || ident.includes("perday")) return true;
  if (haystack.includes("resource_exhausted") || haystack.includes("resource exhausted")) return true;
  return limitZero;
}

function googleError(bodyText: string): { message: string; quotaId: string | null; retryAfter: number | null; limitZero: boolean } {
  let message = bodyText.trim();
  let quotaId: string | null = null;
  let quotaMetric: string | null = null;
  let retryAfter: number | null = null;
  let limitZero = ZERO_LIMIT.test(bodyText);
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { message: message || "The model provider returned an error.", quotaId: null, retryAfter: null, limitZero };
  }
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const error = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
  let details: unknown[] = [];
  if (error) {
    if (typeof error.message === "string" && error.message.trim()) message = error.message.trim();
    if (Array.isArray(error.details)) details = error.details;
  } else if (record && typeof record.message === "string") {
    message = record.message.trim();
  }
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const row = detail as Record<string, unknown>;
    const kind = String(row["@type"] ?? "");
    if ("retryDelay" in row || kind.endsWith("RetryInfo")) {
      const parsed = parseDelay(row.retryDelay);
      if (parsed != null) retryAfter = parsed;
    }
    const violations = row.violations;
    if (!Array.isArray(violations)) continue;
    if (!(kind.endsWith("QuotaFailure") || "violations" in row)) continue;
    for (const violation of violations) {
      if (!violation || typeof violation !== "object") continue;
      const item = violation as Record<string, unknown>;
      if (quotaId == null && item.quotaId) quotaId = String(item.quotaId);
      if (quotaMetric == null && item.quotaMetric) quotaMetric = String(item.quotaMetric);
      for (const key of ["quotaValue", "quotaLimit", "limit"]) {
        if (isZero(item[key])) limitZero = true;
      }
    }
  }
  if (quotaId == null) quotaId = quotaMetric;
  if (!message) message = "The model provider returned an error.";
  return { message, quotaId, retryAfter, limitZero };
}

function clip(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 3) return text.slice(0, Math.max(room, 0));
  return `${text.slice(0, room - 3).trimEnd()}...`;
}

function composeMessage(message: string, quotaId: string | null, retryAfter: number | null): string {
  const text = (message || "").trim() || "The model provider returned an error.";
  const required: string[] = [];
  if (quotaId) required.push(quotaId);
  if (retryAfter != null) required.push(`retryDelay=${formatRetry(retryAfter)}`);
  if (!required.length) return clip(text, MESSAGE_LIMIT);
  const missingFrom = (value: string) => required.filter((part) => !value.includes(part));
  if (text.length <= MESSAGE_LIMIT && missingFrom(text).length === 0) return text;
  let trailer = ` (${required.join(", ")})`;
  if (trailer.length >= MESSAGE_LIMIT) return trailer.trim().slice(0, MESSAGE_LIMIT);
  let body = clip(text, MESSAGE_LIMIT - trailer.length);
  const stillMissing = missingFrom(body);
  if (!stillMissing.length) return body;
  trailer = ` (${stillMissing.join(", ")})`;
  if (trailer.length >= MESSAGE_LIMIT) return trailer.trim().slice(0, MESSAGE_LIMIT);
  body = clip(text, MESSAGE_LIMIT - trailer.length);
  if (!body) return trailer.trim();
  return body + trailer;
}

function formatRetry(seconds: number): string {
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds}s`;
}

function formatRetryNumber(seconds: number): string {
  if (Number.isInteger(seconds)) return String(seconds);
  return String(seconds);
}

function isZero(value: unknown): boolean {
  if (value == null || typeof value === "boolean") return false;
  if (typeof value === "string" && !value.trim()) return false;
  const number = typeof value === "number" ? value : Number(typeof value === "string" ? value.trim() : Number.NaN);
  return Number.isFinite(number) && number === 0;
}

function parseDelay(value: unknown): number | null {
  if (value && typeof value === "object") {
    const row = value as { seconds?: unknown; nanos?: unknown };
    const seconds = Number(row.seconds ?? 0);
    const nanos = Number(row.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return seconds + nanos / 1_000_000_000;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = DELAY.exec(text);
  if (!match) {
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(match[1]);
  return match[2] === "ms" ? number / 1000 : number;
}

function headerValue(headers: Headers | Record<string, string> | null | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const folded = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === folded) return String(value);
  }
  return null;
}

function retryAfterHeader(headers: Headers | Record<string, string> | null | undefined): number | null {
  const raw = headerValue(headers, "retry-after");
  if (raw == null) return null;
  return parseRetryAfter(raw);
}

function parseRetryAfter(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber);
  const when = Date.parse(text);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
}
