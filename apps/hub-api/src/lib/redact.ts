const QUERY = /([?&](?:ticket|token|access_token|refresh_token|id_token|code|api_key|apikey|client_secret|password|secret|key)=)[^&#\s]*/gi;

/** Drop secret query values before a request URL is written to a log. */
export function redactRequestUrl(url: string): string {
  return url.replace(QUERY, "$1[redacted]");
}

const BEARER = /(authorization\s*[:=]\s*bearer\s+)\S+/gi;
const INTERNAL = /(x-ensemble-internal\s*[:=]\s*)\S+/gi;
const SHAPED = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|ens_[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})\b/g;

/** Strip known secret shapes from a log line. The surrounding text stays. */
export function redactText(value: string): string {
  return redactRequestUrl(value).replace(BEARER, "$1[redacted]").replace(INTERNAL, "$1[redacted]").replace(SHAPED, "[redacted]");
}
