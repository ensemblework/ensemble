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

/** A visible password field. */
export const PASSWORD_FIELD = 'input[type="password"]:visible';
/** A visible user name or email field (never a password, hidden, check or button field). */
export const USERNAME_FIELD = [
  'input[type="email"]',
  'input[autocomplete~="username"]',
  'input[autocomplete~="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[id*="login" i]',
]
  .map((selector) => `${selector}:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):visible`)
  .join(", ");
/** A visible one-time code field. */
export const CODE_FIELD = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="totp" i]',
  'input[name*="mfa" i]',
  'input[name*="2fa" i]',
  'input[name*="twofactor" i]',
  'input[name*="two_factor" i]',
  'input[name*="verification_code" i]',
  'input[name="code"]',
  'input[id="code"]',
]
  .map((selector) => `${selector}:not([type="hidden"]):visible`)
  .join(", ");

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

type FieldCount = { passwords: number; newPasswords: number; usernames: number; codes: number };

/** Runs in the page: counts visible password (and new-password), user name and code fields. Selectors come without `:visible`. */
function countFields(groups: Array<[string, "passwords" | "usernames" | "codes"]>): FieldCount {
  const w = globalThis as unknown as PageWindow;
  const count: FieldCount = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0 };
  for (const [selector, key] of groups) {
    const fields = w.document.querySelectorAll(selector);
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.getClientRects().length === 0 || w.getComputedStyle(field).visibility === "hidden") continue;
      count[key] += 1;
      if (key === "passwords" && (field.getAttribute("autocomplete") ?? "").toLowerCase().includes("new-password")) count.newPasswords += 1;
    }
  }
  return count;
}

const IN_PAGE: Array<[string, "passwords" | "usernames" | "codes"]> = [
  [PASSWORD_FIELD.replace(/:visible/g, ""), "passwords"],
  [USERNAME_FIELD.replace(/:visible/g, ""), "usernames"],
  [CODE_FIELD.replace(/:visible/g, ""), "codes"],
];

const MAX_FRAMES = 20;

/** The page's visible sign-in fields, over all its frames. */
export async function loginFields(page: Page): Promise<FieldCount> {
  const total: FieldCount = { passwords: 0, newPasswords: 0, usernames: 0, codes: 0 };
  for (const frame of page.frames().slice(0, MAX_FRAMES)) {
    const found = await frame.evaluate(countFields, IN_PAGE).catch(() => null);
    if (!found) continue;
    total.passwords += found.passwords;
    total.newPasswords += found.newPasswords;
    total.usernames += found.usernames;
    total.codes += found.codes;
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
