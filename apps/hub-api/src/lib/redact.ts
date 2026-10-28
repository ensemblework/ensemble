const QUERY = /([?&](?:ticket|token|access_token|refresh_token|id_token|code|api_key|apikey|client_secret|password|secret|key)=)[^&#\s]*/gi;

/** Drop secret query values before a request URL is written to a log. */
export function redactRequestUrl(url: string): string {
  return url.replace(QUERY, "$1[redacted]");
}

const BEARER = /(authorization\s*[:=]\s*bearer\s+)\S+/gi;
const INTERNAL = /(x-ensemble-internal\s*[:=]\s*)\S+/gi;
const SHAPED =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|ens_[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** user:password@ in a URL (git remotes, database URLs). */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
/** .env-style lines whose name says secret: API_KEY=…, export DB_PASSWORD=…, client_secret: … */
const SECRET_LINE = /^(\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|api_?key|private_?key|access_?key|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)["']?[^\s"']{4,}.*$/gim;

const known = new Set<string>();
const SHORTEST_KNOWN = 6;

/** Values of the person's saved run secrets (lib/run-secrets.ts): every redaction here hides them too. */
export function rememberSecretValues(values: Iterable<string>): void {
  for (const value of values) if (value.length >= SHORTEST_KNOWN) known.add(value);
}

/** The text with every remembered secret value replaced. */
export function hideSecretValues(value: string): string {
  let out = value;
  for (const secret of known) if (out.includes(secret)) out = out.split(secret).join("[redacted secret]");
  return out;
}

/** Every string in a JSON value with remembered secret values hidden (what a computer sends to the server). */
export function hideSecretsDeep<T>(value: T): T {
  if (!known.size) return value;
  if (typeof value === "string") return hideSecretValues(value) as T;
  if (Array.isArray(value)) return value.map((item) => hideSecretsDeep(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hideSecretsDeep(item)])) as T;
  }
  return value;
}

/** Strip known secret shapes from a log line. The surrounding text stays. */
export function redactText(value: string): string {
  return redactRequestUrl(hideSecretValues(value))
    .replace(PRIVATE_KEY, "[redacted private key]")
    .replace(BEARER, "$1[redacted]")
    .replace(INTERNAL, "$1[redacted]")
    .replace(URL_PASSWORD, "$1[redacted]@")
    .replace(SECRET_LINE, "$1[redacted]")
    .replace(SHAPED, "[redacted]");
}

/**
 * Only the shapes that are certainly keys: private keys, bearer headers, passwords in URLs and known
 * token formats. Code shown for editing uses this, not `redactText`, whose `name = value` rule would
 * also hide ordinary code such as `password: string`.
 */
export function redactKeys(value: string): string {
  return hideSecretValues(value)
    .replace(PRIVATE_KEY, "[redacted private key]")
    .replace(BEARER, "$1[redacted]")
    .replace(INTERNAL, "$1[redacted]")
    .replace(URL_PASSWORD, "$1[redacted]@")
    .replace(SHAPED, "[redacted]");
}
