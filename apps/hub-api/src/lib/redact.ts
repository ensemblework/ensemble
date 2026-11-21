const QUERY = /([?&](?:ticket|token|access_token|refresh_token|id_token|code|code_verifier|request|mcp_request|state|api_key|apikey|client_secret|password|secret|key)=)[^&#\s]*/gi;

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

/** Words in a name (a key, a variable, a header, a flag, a URL parameter) that make its value a secret, whatever it looks like. */
const SECRET_WORDS = new Set([
  "secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "passphrase", "pass", "pwd", "auth", "authorization", "credential",
  "credentials", "cookie", "cookies", "pin", "otp", "sig", "signature", "apikey", "privatekey", "accesskey", "secretkey",
]);
/** Two words in a row that do: `api key`, `X-Api-Key`, `access_key`. */
const SECRET_PAIRS: ReadonlyArray<readonly [string, string]> = [["api", "key"], ["access", "key"], ["private", "key"], ["secret", "key"], ["session", "token"]];

/** Whether a name says its value is a secret: `apiKey`, `X-Api-Key`, `DB_PASSWORD`, `pin`, `sig`, `X-Amz-Signature`; not `author`, `pinned`, `key`. */
export function secretName(name: string): boolean {
  const words = name.slice(0, 200).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  return SECRET_PAIRS.some(([first, second]) => words.some((word, index) => word === first && words[index + 1] === second));
}

// Every pattern below is bounded, so a long line costs time in proportion to its length (no backtracking over it).
/** `Bearer …`, `Basic …`, `token …` credentials, in a header or anywhere. */
const CREDENTIAL = /\b(bearer|basic|token)\s{1,8}[A-Za-z0-9._~+/=-]{6,4096}/gi;
/** `NAME=value`, `NAME: value` and `"name": "value"` whose name says secret (checked by `secretName`). */
const ASSIGNED = /([A-Za-z_][A-Za-z0-9_.-]{0,63})(["']?\s{0,4}[=:](?!\/\/)\s{0,4})("[^"\n]{0,512}"?|'[^'\n]{0,512}'?|[^\s"'&,;)?#]{1,4096})/g;
/** `--token value`, `-password value`: a flag whose name says secret, then its value. */
const FLAG_VALUE = /(--?[A-Za-z][A-Za-z0-9-]{0,40})\s{1,8}([^\s"'-][^\s"']{0,4096})/g;
/** URL parameters that carry a key or a code under a plain name. */
const URL_SECRET = /([?&;](?:key|code|state|ticket)=)[^&#\s"']{1,4096}/gi;
const URL_LOGIN = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,256}:)[^\s@/]{1,256}@/gi;
const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/** A string's secrets replaced, in time linear in its length (see `redactArgs`). */
function redactString(text: string): string {
  return hideSecretValues(text)
    .replace(KEY_BLOCK, "[redacted private key]")
    .replace(URL_LOGIN, "$1[redacted]@")
    .replace(CREDENTIAL, "$1 [redacted]")
    .replace(URL_SECRET, "$1[redacted]")
    // `Authorization: Bearer [redacted]` keeps its scheme: the credential after it is already gone.
    .replace(ASSIGNED, (all, name: string, between: string, value: string) => (secretName(name) && !/^(?:bearer|basic|token)$/i.test(value) ? `${name}${between}[redacted]` : all))
    .replace(FLAG_VALUE, (all, flag: string, value: string) => (secretName(flag) && value !== "[redacted]" ? `${flag} [redacted]` : all))
    .replace(SHAPED, "[redacted]");
}

/**
 * Tool arguments as a record or a label may keep them (a failed call's input, a journal's labels), with their secrets
 * replaced by `[redacted]`. A value under a key whose name says secret (`password`, `pass`, `passphrase`, `auth`, `pin`,
 * `token`, `apiKey`, `X-Api-Key`, `sig`…: `secretName`) is replaced at any depth, and in a JSON string that holds an object
 * or a list too. In any other string: `NAME=value`, `NAME: value` and `--name value` whose name says secret (a header
 * inside a command, an env assignment, a flag), `Bearer`/`Basic` credentials, secret URL parameters (`token=`, `sig=`,
 * `X-Amz-Signature=`, `key=`), passwords in URLs, private key blocks, known token shapes and the saved run secrets.
 * Linear in the input's length. Nothing is cut: callers cut after.
 */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const text = value.trim();
    if (depth < 8 && (text.startsWith("{") || text.startsWith("[")) && text.length <= 1_000_000) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return JSON.stringify(redactArgs(parsed, depth + 1));
      } catch {
        // Not JSON: a string like any other.
      }
    }
    return redactString(value);
  }
  if (depth >= 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactArgs(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, secretName(key) && item !== null && typeof item !== "boolean" ? "[redacted]" : redactArgs(item, depth + 1)]),
  );
}
