/**
 * When a tab needs its owner to sign in (B11, docs/35 §8.16). The broker's heuristics: a password
 * field on the page (one, not a new-password form), a sign-in address (/login, /signin, /auth, …)
 * that shows a user name or code field, a 401 answer to the page itself, or a redirect to a known
 * identity provider (Google, Microsoft, Apple, Okta, Auth0, GitHub's sign-in, …). Only the runtime's
 * own fixed functions run in the page; nothing here reads a field's value.
 *
 * Functions passed to `evaluate` are serialised into the page: no named inner functions.
 */
import type { Frame, Locator, Page } from "playwright-core";
import type { PageWindow } from "../browser/page-world.js";

/** Paths that are sign-in pages on most sites. */
const SIGN_IN_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign_in|signon|sso|auth|authenticate|authorize|session|sessions|oauth2?|saml|idp|users\/sign_in|account\/login|accounts\/login)(?:\/|$|\.|;)/i;

/** Identity providers a site sends its sign-in to; a few only on their sign-in paths. */
const IDENTITY_HOSTS: ReadonlyArray<{ host: RegExp; path?: RegExp }> = [
  { host: /^accounts\.google\.com$/ },
  { host: /^login\.(?:microsoftonline|live|windows)\.(?:com|net)$/ },
  { host: /\.b2clogin\.com$/ },
  { host: /^(?:appleid|idmsa)\.apple\.com$/ },
  { host: /^github\.com$/, path: /^\/(?:login|session|sessions)(?:\/|$)/ },
  { host: /^gitlab\.com$/, path: /^\/users\/sign_in/ },
  { host: /\.(?:okta|oktapreview|okta-emea)\.com$/ },
  { host: /\.auth0\.com$/ },
  { host: /\.onelogin\.com$/ },
  { host: /^login\.salesforce\.com$/ },
  { host: /^id\.atlassian\.com$/ },
  { host: /^signin\.aws\.amazon\.com$/ },
  { host: /\.amazoncognito\.com$/ },
  { host: /^login\.yahoo\.com$/ },
  { host: /\.duosecurity\.com$/ },
  { host: /^auth\.openai\.com$/ },
];

/** An attribute test of a form field, as a CSS attribute selector says it: `=` exact, `*=` contains, `~=` one of its words; `i` ignores case. */
type FieldRule = [attribute: string, operator: "=" | "*=" | "~=", value: string, ignoreCase?: "i"];

const USERNAME_RULES: FieldRule[] = [
  ["type", "=", "email"],
  ["autocomplete", "~=", "username"],
  ["autocomplete", "~=", "email"],
  ["name", "*=", "user", "i"],
  ["name", "*=", "email", "i"],
  ["name", "*=", "login", "i"],
  ["id", "*=", "user", "i"],
  ["id", "*=", "email", "i"],
  ["id", "*=", "login", "i"],
];
const CODE_RULES: FieldRule[] = [
  ["autocomplete", "=", "one-time-code"],
  ["name", "*=", "otp", "i"],
  ["id", "*=", "otp", "i"],
  ["name", "*=", "totp", "i"],
  ["name", "*=", "mfa", "i"],
  ["name", "*=", "2fa", "i"],
  ["name", "*=", "twofactor", "i"],
  ["name", "*=", "two_factor", "i"],
  ["name", "*=", "verification_code", "i"],
  ["name", "*=", "verificationcode", "i"],
  ["name", "=", "code"],
  ["id", "=", "code"],
  // Microsoft's one-time code, Google's code from a text message.
  ["name", "=", "otc"],
  ["id", "=", "idvPin"],
];
const NOT_USERNAME_TYPES = ["password", "hidden", "checkbox", "radio", "submit", "button"];

const ruleSelector = ([attribute, operator, value, flag]: FieldRule) => `input[${attribute}${operator}"${value}"${flag ? " i" : ""}]`;

/** A visible password field. */
export const PASSWORD_FIELD = 'input[type="password"]:visible';
/** A visible user name or email field (never a password, hidden, check or button field). */
export const USERNAME_FIELD = USERNAME_RULES.map(ruleSelector)
  .map((selector) => `${selector}${NOT_USERNAME_TYPES.map((type) => `:not([type="${type}"])`).join("")}:visible`)
  .join(", ");
/** A visible one-time code field. */
export const CODE_FIELD = CODE_RULES.map(ruleSelector)
  .map((selector) => `${selector}:not([type="hidden"]):visible`)
  .join(", ");

function ruleMatches(attrs: Record<string, string>, [attribute, operator, value, flag]: FieldRule): boolean {
  const raw = attrs[attribute];
  if (raw === undefined) return false;
  const have = flag ? raw.toLowerCase() : raw;
  const want = flag ? value.toLowerCase() : value;
  if (operator === "=") return have === want;
  if (operator === "*=") return have.includes(want);
  return have.split(/\s+/).includes(want);
}

/**
 * What sign-in fields a visible form field is, from its attributes alone (a clean browser's DOM snapshot,
 * browser/clean.ts), by the same rules as `PASSWORD_FIELD`, `USERNAME_FIELD` and `CODE_FIELD`; `other` is any
 * other field a person types into.
 */
export function fieldKinds(attrs: Record<string, string>): { password: boolean; newPassword: boolean; username: boolean; code: boolean; other: boolean } {
  const tag = (attrs.tag ?? "input").toLowerCase();
  const type = (attrs.type ?? "text").toLowerCase();
  const input = tag === "input";
  const password = input && type === "password";
  const username = input && !NOT_USERNAME_TYPES.includes(type) && USERNAME_RULES.some((rule) => ruleMatches(attrs, rule));
  const code = input && type !== "hidden" && CODE_RULES.some((rule) => ruleMatches(attrs, rule));
  const typed = (input && ["text", "tel", "number", "search", "email", "url", ""].includes(type)) || tag === "textarea";
  return { password, newPassword: password && (attrs.autocomplete ?? "").toLowerCase().includes("new-password"), username, code, other: typed && !username && !code && !password };
}

export function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The identity provider a URL is a sign-in page of, or null. */
export function identityHostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return IDENTITY_HOSTS.some((entry) => entry.host.test(host) && (!entry.path || entry.path.test(parsed.pathname))) ? host : null;
  } catch {
    return null;
  }
}

/** Whether a URL's path looks like a sign-in page. */
export function isSignInPath(url: string): boolean {
  try {
    return SIGN_IN_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Steps of signing in or out that are not the signed-in site yet: a forgotten password, signing up, a code, a consent screen, choosing an account. */
const IN_FLOW_PATH = /(?:^|\/)(?:forgot|reset|recover|recovery|password|passwd|register|registration|signup|sign-up|sign_up|join|verify|verification|challenge|mfa|2fa|two-?factor|otp|consent|select[_-]?account|account[_-]?chooser|choose[_-]?account|logout|log-?out|sign-?out|signedout|loggedout)(?:[\/._;-]|$)/i;

/**
 * Whether a URL is a sign-in page or another step of signing in or out: a sign-in address, a forgotten
 * password, a code, a consent screen, an account choice, or an identity provider's page (unless the
 * sign-in is for that provider itself, `origin`).
 */
export function isSignInFlow(url: string, origin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (SIGN_IN_PATH.test(parsed.pathname) || IN_FLOW_PATH.test(parsed.pathname)) return true;
  const identity = identityHostOf(url);
  if (!identity) return false;
  try {
    return !origin || new URL(origin).hostname.toLowerCase() !== identity;
  } catch {
    return true;
  }
}

/** Second-level labels under a two-letter country domain that are not a site of their own (co.uk, com.au). */
const PUBLIC_SECOND = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|mil|ltd|plc)$/;

/**
 * The site a URL belongs to, near enough to compare two addresses: its last two labels (three under
 * co.uk and the like), or this computer's own address with its port. Null for anything not http(s).
 */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return `${host}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const take = labels.at(-1)!.length === 2 && PUBLIC_SECOND.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Whether a cookie's domain belongs to a site (as `siteOf` names it). */
export function cookieOfSite(domain: string, site: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const name = site.replace(/:\d+$/, "");
  return bare === name || bare.endsWith(`.${name}`);
}

/** Cookies that say nothing about signing in: analytics, consent, and bot-management cookies a page sets on any visit. */
const NOT_A_SESSION = /^(?:_ga|_gid|_gat|__utm|_gcl|_fbp|_fbc|_hj|_clck|_clsk|_uet|_pin|_tt|_scid|_sctr|ajs_|amplitude|mp_|optimizely|_dc_gtm|__cf_bm|cf_clearance|_cfuvid|__cflb|_px|pxcts|datadome|ak_bmsc|bm_|_abck|incap_|visid_incap|nlbi_|optanon|cookieconsent|euconsent|consent|__secure-enid|nid$|aec$|1p_jar|__gads|__gpi|ide$|test_cookie|_lr_|intercom-|__stripe|_dd_s|rxvt|dtcookie|dtpc|dtsa|rxvisitor|s_cc|s_sq|s_vi|s_fid|at_check|mbox|kndctr|_rdt|_tq_|li_|lidc|bcookie|ab\.storage|_vwo|_vis_opt|__hs|hubspot|__q_state|_sp_|sp_)/i;

/** Whether a cookie (by its name) may carry a sign-in. */
export function sessionLike(name: string): boolean {
  return !NOT_A_SESSION.test(name);
}

/** Local storage keys that hold a sign-in in a web app. */
export const AUTH_STORAGE_KEY = /token|auth|session|user|account|jwt|access|login|identity|credential|refresh|oidc|msal/i;

/**
 * What a page that asks for a one-time code wants, in words for the owner's card: "Enter the 6-digit code
 * from your authenticator app." Null when the page does not ask for one: no code field, and no words of
 * one beside a field to type it in.
 */
export function codePrompt(input: { text: string; fields: FieldCount }): string | null {
  const text = input.text.slice(0, 20_000);
  // Words of a code count only beside one field to type it in (the one a code is filled into, logins/fill.ts).
  const asks = /\b(?:(?:verification|security|one[- ]time|sign[- ]in|login|authentication|confirmation|access|backup|\d[- ]digit|six[- ]digit)\s+code|enter (?:the |your )?(?:\d[- ]digit )?code|2-step verification|two[- ]step|two[- ]factor|2fa|authenticator app|code we sent|(?:sent|texted|emailed|send) (?:you )?(?:a |the |an )?(?:\d[- ]digit |verification |security |one[- ]time |login |sign[- ]in )?code|verify it'?s you)\b/i.test(text);
  if (!input.fields.codes && !(asks && input.fields.others + input.fields.usernames === 1)) return null;
  if (input.fields.passwords > 0 && !input.fields.codes) return null;
  const digits = /\b(\d)[- ]digit\b/i.exec(text)?.[1] ?? (/\bsix[- ]digit\b/i.test(text) ? "6" : /\beight[- ]digit\b/i.test(text) ? "8" : null);
  const from = /authenticator|authentication app|verification app|totp/i.test(text)
    ? "from your authenticator app"
    : /text message|\bsms\b|texted|sent (?:a code |it )?to (?:your )?(?:phone|mobile|number)|phone number ending|•{2,}\s?\d{2}|\*{2,}\s?\d{2}/i.test(text)
      ? "the site sent to your phone"
      : /e-?mail|inbox/i.test(text)
        ? "the site emailed you"
        : "the site asks for";
  return `Enter the ${digits ? `${digits}-digit ` : ""}code ${from}.`;
}

/**
 * A page that waits for the owner to approve the sign-in on another device (a push to an authenticator
 * app, a prompt on their phone), in words for the card, with the number to tap when the page shows one.
 */
export function approvalPrompt(text: string): string | null {
  const page = text.slice(0, 20_000);
  if (!/\b(?:approve (?:the |this |your )?sign[- ]?in|approve (?:the |this )?request|check your (?:phone|device|mobile)|tap yes|tap the number|open (?:your )?(?:authenticator|the [\w ]{1,30} app)|we sent a (?:notification|prompt|push)|sent a (?:notification|prompt|push)|duo push|confirm (?:it'?s|it is) you on|number matching|enter the number shown)\b/i.test(page)) return null;
  const number = /\b(?:enter the number shown|tap the number|number)\b[^\d]{0,60}\b(\d{2,3})\b/i.exec(page)?.[1];
  return `Approve the sign-in on your phone${number ? ` (tap ${number})` : ""}; Ensemble sees it when you have.`;
}

function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Whether a URL is this computer's own address: such pages only hint at a sign-in, as they are usually the app a run builds. */
export function isLoopbackOrigin(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Visible sign-in fields on a page; `others`: other fields a person types into (text, tel, number), which a code may go in. */
export type FieldCount = { passwords: number; newPasswords: number; usernames: number; codes: number; others: number };

/** The sign-in fields among a clean browser's visible form fields (their attributes). */
export function countFieldsOf(inputs: ReadonlyArray<Record<string, string>>): FieldCount {
  const count: FieldCount = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 };
  for (const attrs of inputs) {
    const kinds = fieldKinds(attrs);
    if (kinds.password) count.passwords += 1;
    if (kinds.newPassword) count.newPasswords += 1;
    if (kinds.username) count.usernames += 1;
    if (kinds.code) count.codes += 1;
    if (kinds.other) count.others += 1;
  }
  return count;
}

/** Runs in the page: counts visible password (and new-password), user name, code and other typing fields. Selectors come without `:visible`. */
function countFields(groups: Array<[string, "passwords" | "usernames" | "codes" | "others"]>): FieldCount {
  const w = globalThis as unknown as PageWindow;
  const count: FieldCount = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 };
  const counted = new Set<unknown>();
  for (const [selector, key] of groups) {
    const fields = w.document.querySelectorAll(selector);
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.getClientRects().length === 0 || w.getComputedStyle(field).visibility === "hidden") continue;
      // `others` (last) are the typing fields no other group counted.
      if (key === "others" && counted.has(field)) continue;
      counted.add(field);
      count[key] += 1;
      if (key === "passwords" && (field.getAttribute("autocomplete") ?? "").toLowerCase().includes("new-password")) count.newPasswords += 1;
    }
  }
  return count;
}

const IN_PAGE: Array<[string, "passwords" | "usernames" | "codes" | "others"]> = [
  [PASSWORD_FIELD.replace(/:visible/g, ""), "passwords"],
  [USERNAME_FIELD.replace(/:visible/g, ""), "usernames"],
  [CODE_FIELD.replace(/:visible/g, ""), "codes"],
  ['input[type="text"], input[type="tel"], input[type="number"], input:not([type])', "others"],
];

const MAX_FRAMES = 20;

/** The page's visible sign-in fields, over all its frames. */
export async function loginFields(page: Page): Promise<FieldCount> {
  const total: FieldCount = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 };
  for (const frame of page.frames().slice(0, MAX_FRAMES)) {
    const found = await frame.evaluate(countFields, IN_PAGE).catch(() => null);
    if (!found) continue;
    total.passwords += found.passwords;
    total.newPasswords += found.newPasswords;
    total.usernames += found.usernames;
    total.codes += found.codes;
    total.others += found.others;
  }
  return total;
}

export type LoginSignals = {
  /** The page clearly asks to sign in. */
  needed: boolean;
  /** What showed it, in words for the owner's card. */
  reasons: string[];
  /** The site to sign in to: the one the work asked for (before a redirect to an identity provider). */
  origin: string | null;
  /** An identity provider the page was sent to, if any. */
  identity: string | null;
};

/**
 * What a page says about signing in. `requested`: the address the work opened (a redirect elsewhere
 * keeps the sign-in about that site); `status`: the page's own HTTP status, when the call loaded it.
 */
export async function loginSignals(page: Page, input: { requested?: string | null; status?: number | null } = {}): Promise<LoginSignals> {
  const url = page.url();
  const here = safeOrigin(url);
  const asked = input.requested ? safeOrigin(input.requested) : null;
  const identity = identityHostOf(url);
  const reasons: string[] = [];
  const fields = await loginFields(page);
  const onePassword = fields.passwords === 1 && fields.newPasswords === 0;
  if (identity && (!asked || new URL(asked).hostname !== identity)) reasons.push(`it was sent to sign in at ${identity}`);
  if (input.status === 401) reasons.push("the page answered 401 (sign-in required)");
  if (onePassword) reasons.push("the page has a password field");
  const signInPage = isSignInPath(url) && (fields.usernames > 0 || fields.codes > 0);
  if (signInPage && !onePassword) reasons.push("it is a sign-in page");
  if (fields.codes > 0 && !onePassword && !signInPage && isSignInPath(url)) reasons.push("it asks for a one-time code");
  const origin = identity && asked ? asked : (here ?? asked);
  return { needed: reasons.length > 0, reasons, origin, identity };
}

/** The first frame with a visible field for `selector`, and that field. */
export async function firstVisible(page: Page, selector: string): Promise<{ frame: Frame; field: Locator } | null> {
  for (const frame of page.frames().slice(0, MAX_FRAMES)) {
    const field = frame.locator(selector).first();
    if ((await field.count().catch(() => 0)) > 0) return { frame, field };
  }
  return null;
}
