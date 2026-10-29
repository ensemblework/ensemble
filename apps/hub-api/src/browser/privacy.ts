/**
 * What a capture must not show (ensemble-node design E§8.4): password and one-time-code fields are
 * masked at the source, origins the owner marked are never captured or always previewed first,
 * and saved secret values or key-shaped strings on the page hold a capture for the owner instead
 * of sending it. Secret values are matched here, in the runtime, and are never passed into a page.
 */
import { redactKeys } from "../lib/redact.js";

export type PrivacyRules = {
  /** Values of the owner's saved secrets (run secrets, saved logins). Never shown in a capture. */
  secretValues?: readonly string[];
  /** Sites never captured: no screenshot, video, snapshot or live view. */
  neverCapture?: readonly string[];
  /** Sites whose captures are always held for the owner to preview before they are sent. */
  previewFirst?: readonly string[];
};

/** Shorter values are too likely to match ordinary text (same floor as lib/redact.ts). */
export const SECRET_MIN_LENGTH = 6;

/**
 * Fields masked in every screenshot and whose values never appear in a snapshot. Elements a page
 * or the owner marks with `data-ensemble-sensitive` (or `data-sensitive`) count too.
 */
export const SENSITIVE_SELECTOR = [
  'input[type="password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete~="cc-number" i]',
  'input[autocomplete~="cc-csc" i]',
  'input[name="otp" i]',
  'input[id="otp" i]',
  'input[name^="otp" i]',
  'input[name$="_otp" i]',
  'input[name$="-otp" i]',
  'input[name*="totp" i]',
  'input[name*="passcode" i]',
  "[data-ensemble-sensitive]",
  "[data-sensitive]",
].join(", ");

/**
 * How a site entry matches a page. `https://mail.example.com` is that origin exactly;
 * `example.com` or `*.example.com` is the host and every host under it, on any scheme or port.
 */
export function matchesSite(url: string, entry: string): boolean {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return false;
  }
  const rule = entry.trim().toLowerCase();
  if (!rule) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(rule)) {
    try {
      return new URL(rule).origin === page.origin;
    } catch {
      return false;
    }
  }
  const host = rule.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const pageHost = page.hostname.toLowerCase();
  return pageHost === host || pageHost.endsWith(`.${host}`);
}

/** At most this many sites in each of the owner's lists. */
export const MAX_SITES = 200;

/**
 * A site as the owner's lists keep it (`matchesSite`): an origin (`https://mail.example.com`), or a
 * host that covers its subdomains (`example.com`; `*.example.com` and a path or port are taken off).
 * Null when it names no site.
 */
export function normalizeSite(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value || value.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.origin : null;
    } catch {
      return null;
    }
  }
  const host = value.replace(/^\*\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,62}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,62}[a-z0-9_])?)*$/.test(host) ? host : null;
}

/** The owner's two lists as kept: each site normalized once, or the first entry that names no site. */
export function siteLists(input: { never: readonly string[]; preview: readonly string[] }): { never: string[]; preview: string[] } | { error: string } {
  const bad = [...input.never, ...input.preview].find((site) => !normalizeSite(site));
  if (bad !== undefined) return { error: `“${bad.slice(0, 80)}” is not a site: give a host such as example.com, or an address such as https://mail.example.com.` };
  const list = (sites: readonly string[]) => [...new Set(sites.map((site) => normalizeSite(site)!))].slice(0, MAX_SITES);
  return { never: list(input.never), preview: list(input.preview) };
}

/** "never" wins over "preview"; null when the owner set nothing for this page. */
export function siteRule(url: string, rules: PrivacyRules): "never" | "preview" | null {
  if ((rules.neverCapture ?? []).some((entry) => matchesSite(url, entry))) return "never";
  if ((rules.previewFirst ?? []).some((entry) => matchesSite(url, entry))) return "preview";
  return null;
}

export type SecretHits = {
  /** How many saved secret values appear in the text. The values are not returned. */
  savedSecrets: number;
  /** How many distinct key-shaped strings (tokens, API keys, private keys) appear. */
  keyLike: number;
};

const TOKEN_SPLIT = /[\s"'`<>()[\]{},;|]+/;

/** Saved secret values and key-shaped strings in a page's text or a transcript. */
export function findSecrets(text: string, rules: PrivacyRules): SecretHits {
  const values = (rules.secretValues ?? []).filter((value) => value.length >= SECRET_MIN_LENGTH);
  const savedSecrets = values.filter((value) => text.includes(value)).length;
  const shapes = new Set<string>();
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) shapes.add("private key");
  for (const token of text.split(TOKEN_SPLIT)) {
    if (token.length >= 12 && redactKeys(token) !== token) shapes.add(token);
  }
  return { savedSecrets, keyLike: shapes.size };
}

export function hasSecrets(hits: SecretHits): boolean {
  return hits.savedSecrets > 0 || hits.keyLike > 0;
}

/** Why a capture is held, in the owner's words. */
export function holdReason(hits: SecretHits): string | null {
  if (hits.savedSecrets) return "It shows one of your saved secret values.";
  if (hits.keyLike) return "It shows something that looks like a key or token.";
  return null;
}

/**
 * Text with saved secret values and key shapes replaced: what a model may read. Each value is also
 * looked for as it appears inside a quoted string (an aria snapshot escapes `"` and `\`).
 */
export function hideSecrets(text: string, rules: PrivacyRules): string {
  let out = text;
  const values = (rules.secretValues ?? []).filter((value) => value.length >= SECRET_MIN_LENGTH).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) if (out.includes(value)) out = out.split(value).join("[hidden]");
  return redactKeys(out);
}

const VALUE_ROLES = /^\s*- (?:textbox|searchbox|spinbutton|combobox)\b/;
const REF = /\[ref=([a-z0-9]+)\]/;

/**
 * Refs of fields in an aria snapshot that show a value: candidates for the sensitive-field check.
 * The value is on the field's line, or (when the field also has a placeholder) on lines under it.
 */
export function valueFieldRefs(snapshot: string): string[] {
  const refs: string[] = [];
  for (const line of snapshot.split("\n")) {
    if (!VALUE_ROLES.test(line)) continue;
    const ref = REF.exec(line);
    const rest = ref ? line.slice(ref.index) : "";
    if (ref && (/\]:\s*\S/.test(rest) || /:\s*$/.test(rest))) refs.push(ref[1]!);
  }
  return refs;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The snapshot with the values of the given fields hidden, then secrets and key shapes hidden.
 * Everything under such a field's line goes too (a multi-line value, or the `- text:` that carries
 * the value when the field has a placeholder), except its placeholder.
 */
export function redactSnapshot(snapshot: string, sensitiveRefs: ReadonlySet<string>, rules: PrivacyRules): string {
  const out: string[] = [];
  let hidingBelow = -1;
  for (const line of snapshot.split("\n")) {
    if (hidingBelow >= 0) {
      if (line.trim() && indentOf(line) > hidingBelow) {
        if (/^\s*- \/placeholder:/.test(line)) out.push(line);
        continue;
      }
      hidingBelow = -1;
    }
    const ref = REF.exec(line);
    const colon = ref && sensitiveRefs.has(ref[1]!) ? line.indexOf("]:", ref.index) : -1;
    if (colon < 0) {
      out.push(line);
      continue;
    }
    out.push(`${line.slice(0, colon + 2)} [hidden]`);
    hidingBelow = indentOf(line);
  }
  return hideSecrets(out.join("\n"), rules);
}
