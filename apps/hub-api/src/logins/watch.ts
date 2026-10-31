/**
 * Seeing a sign-in or a human check done without being told (docs/35 §8.16.1). While a sign-in waits,
 * its page is looked at every two seconds and after each page load: the node's own tab (Playwright,
 * `playwrightProbe`), or the clean browser the owner signs in with (`cleanProbe`, no page script). A
 * sign-in counts as done only by a change: the page asked to sign in first (a sign-in form, a code, an
 * identity provider, another site), then it is the site itself with no sign-in form, not a step of
 * signing in, not a human check, loaded, and the site's sign-in state changed meanwhile (a session
 * cookie or a sign-in key in its storage; not analytics or bot-check cookies). A condition the work
 * declared (a URL pattern or a selector) replaces the page rules and needs no storage change. A human
 * check counts as passed when its challenge is gone and the page has loaded, seen twice. A human-check
 * page is never "signed in".
 */
import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import type { CleanCookie, CleanPage, CleanSigns } from "../browser/clean.js";
import { humanCheck } from "../browser/human-check.js";
import { AUTH_STORAGE_KEY, cookieOfSite, countFieldsOf, isSignInFlow, isSignInPath, loginFields, safeOrigin, sessionLike, siteOf, type FieldCount } from "./detect.js";

export type LoginPurpose = "sign_in" | "human_check";
export type SignedInCondition = { urlPattern?: string; selector?: string };

/** What a page shows, as the judge needs it. */
export type Signs = { url: string; title: string; text: string; frames: string[]; fields: FieldCount; loaded: boolean };

/** A site's sign-in state, one way: its session-like cookies, and its storage's sign-in keys when read on a page of the site (else null). */
export type Fingerprint = { cookies: string; storage: string | null };

/** How to read a page: its signs, whether a selector is shown, and a fingerprint of a site's sign-in state. */
export type Probe = {
  signs(): Promise<Signs>;
  visible(selector: string): Promise<boolean>;
  storage(origin: string): Promise<Fingerprint>;
};

export type Judged = {
  /** Signed in (`sign_in`) or through the check (`human_check`), by the page alone. */
  ok: boolean;
  /** The page still asks for the owner: a sign-in form, a code, an identity provider, another site, a challenge. */
  asking: boolean;
  /** The human check it shows, if any. */
  challenge: string | null;
  /** Why not, in a sentence for the owner. */
  reason: string;
};

const MAX_TEXT = 20_000;
const MAX_FRAMES = 20;

const isWeb = (url: string) => /^https?:/i.test(url);

/** A glob over a URL as `browser_wait` takes it (`**` any characters, `*` any but `/`), or a `/regular expression/`; see fill.ts. */
export function urlMatches(pattern: string, url: string): boolean {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }
  let target = url;
  if (!pattern.includes("?")) {
    try {
      const parsed = new URL(url);
      target = `${parsed.origin}${parsed.pathname}`;
    } catch {
      target = url.split(/[?#]/)[0]!;
    }
  }
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(target);
}

/** Whether a page is on the site a sign-in is for: its origin, or another address of the same site. */
export function onSite(url: string, origin: string): boolean {
  const here = safeOrigin(url);
  if (!here) return false;
  if (here === origin) return true;
  const site = siteOf(url);
  return site !== null && site === siteOf(origin);
}

/**
 * What a page says about a sign-in, now: never signed in on a human check, or on a step of signing in or
 * out (a sign-in address, a code, a consent screen, an identity provider's page). `strict` (the automatic
 * watch): a page still loading says nothing.
 */
export function judge(signs: Signs, input: { origin: string; purpose: LoginPurpose; condition?: SignedInCondition | null; selectorVisible?: boolean | null; strict?: boolean }): Judged {
  const challenge = isWeb(signs.url) ? humanCheck({ title: signs.title, text: signs.text, frames: signs.frames, status: null }) : null;
  if (input.purpose === "human_check") {
    if (challenge) return { ok: false, asking: true, challenge, reason: `The page still shows ${challenge}.` };
    if (!isWeb(signs.url)) return { ok: false, asking: false, challenge: null, reason: "The tab is not on a web page." };
    if (input.strict && !signs.loaded) return { ok: false, asking: false, challenge: null, reason: "The page is still loading." };
    return { ok: true, asking: false, challenge: null, reason: "" };
  }
  if (challenge) return { ok: false, asking: true, challenge, reason: `The page shows ${challenge}, not the signed-in site.` };
  if (input.strict && !signs.loaded) return { ok: false, asking: false, challenge: null, reason: "The page is still loading." };
  const condition = input.condition;
  if (condition?.urlPattern) {
    const ok = urlMatches(condition.urlPattern, signs.url);
    return { ok, asking: !ok && isWeb(signs.url), challenge: null, reason: ok ? "" : "The tab is not on the signed-in page yet." };
  }
  if (condition?.selector) {
    const ok = input.selectorVisible === true;
    return { ok, asking: !ok && isWeb(signs.url), challenge: null, reason: ok ? "" : "The signed-in page is not showing yet." };
  }
  if (!onSite(signs.url, input.origin)) {
    const here = safeOrigin(signs.url);
    return { ok: false, asking: here !== null, challenge: null, reason: `The tab is on ${here ?? "another page"}, not ${input.origin}.` };
  }
  const fields = signs.fields;
  if (fields.passwords > 0) return { ok: false, asking: true, challenge: null, reason: "The sign-in form is still on the page." };
  if (fields.codes > 0 && isSignInPath(signs.url)) return { ok: false, asking: true, challenge: null, reason: "The site is asking for a one-time code." };
  if (fields.usernames > 0 && isSignInPath(signs.url)) return { ok: false, asking: true, challenge: null, reason: "The sign-in form is still on the page." };
  if (isSignInFlow(signs.url, input.origin)) return { ok: false, asking: true, challenge: null, reason: "The page is still a step of signing in." };
  return { ok: true, asking: false, challenge: null, reason: "" };
}

const digest = (parts: string[]) => createHash("sha256").update(parts.sort().join("\u0001")).digest("base64url");

/** A short, one-way fingerprint of a site's sign-in state: its session-like cookies, and the sign-in keys of its storage when read on the site. Never kept or sent. */
export function storageFingerprint(cookies: ReadonlyArray<{ name: string; value: string; domain: string; path?: string }>, origin: string, storage: ReadonlyArray<[string, string]> | null = null): Fingerprint {
  const site = siteOf(origin);
  const jar = cookies
    .filter((cookie) => site !== null && cookieOfSite(cookie.domain, site) && sessionLike(cookie.name))
    .map((cookie) => `${cookie.domain}\u0000${cookie.path ?? "/"}\u0000${cookie.name}\u0000${cookie.value}`);
  return { cookies: digest(jar), storage: storage === null ? null : digest(storage.filter(([key]) => AUTH_STORAGE_KEY.test(key)).map(([key, value]) => `${key}\u0000${value}`)) };
}

/** Whether a site's sign-in state changed: its cookies, or its storage when both looks read it. */
export function fingerprintChanged(before: Fingerprint | null, now: Fingerprint | null): boolean {
  if (!before || !now) return false;
  return before.cookies !== now.cookies || (before.storage !== null && now.storage !== null && before.storage !== now.storage);
}

export type Observation = { done: boolean; status?: "signed_in" | "passed"; judged: Judged };

/**
 * The automatic watch of one sign-in. `requireChallenge` (a human check in the node's own tab): passed
 * only after the challenge was seen there; in the clean browser the check may never show at all.
 * `askedElsewhere` (a clean browser opened for a node's tab that asked to sign in): when its first look
 * at a loaded page already shows the site signed in, that browser was signed in before, and it is done.
 */
export class Watch {
  private asked = false;
  private baseline: Fingerprint | null = null;
  private challenged = false;
  private clearOnce = false;
  private looked = false;

  constructor(private readonly input: { origin: string; purpose: LoginPurpose; condition: SignedInCondition | null; requireChallenge: boolean; askedElsewhere?: boolean }) {}

  /** Whether the page asked for the owner at some point (a form, an identity provider, a challenge). */
  get askedOnce(): boolean {
    return this.asked || this.challenged;
  }

  /**
   * Looks at the page that decides (the sign-in's own page). `askedAside`: another page of the sign-in
   * (a popup on the identity provider) asked in this look; the state a change is measured from is taken
   * here, on this page, as every later look takes it.
   */
  async observe(probe: Probe, askedAside = false): Promise<Observation> {
    if (askedAside && this.input.purpose === "sign_in") await this.noteAsking(probe);
    const signs = await probe.signs();
    const selector = this.input.condition?.selector;
    const judged = judge(signs, { ...this.input, selectorVisible: selector ? await probe.visible(selector).catch(() => false) : null, strict: true });
    if (this.input.purpose === "human_check") {
      if (judged.challenge) {
        this.challenged = true;
        this.clearOnce = false;
        return { done: false, judged };
      }
      if (!judged.ok || (this.input.requireChallenge && !this.challenged)) return { done: false, judged };
      // Seen clear twice in a row: a challenge between two stages is not taken for the site.
      if (!this.clearOnce) {
        this.clearOnce = true;
        return { done: false, judged };
      }
      return { done: true, status: "passed", judged };
    }
    const first = !this.looked && signs.loaded && /^https?:/i.test(signs.url);
    if (first) this.looked = true;
    if (judged.asking) {
      await this.noteAsking(probe);
      return { done: false, judged };
    }
    if (judged.ok && first && this.input.askedElsewhere) return { done: true, status: "signed_in", judged };
    if (!judged.ok || !this.asked) return { done: false, judged };
    if (this.input.condition?.urlPattern || this.input.condition?.selector) return { done: true, status: "signed_in", judged };
    const now = await probe.storage(this.input.origin).catch(() => null);
    if (!fingerprintChanged(this.baseline, now)) return { done: false, judged: { ...judged, ok: false, reason: `Nothing new from ${this.input.origin} yet: not signed in.` } };
    return { done: true, status: "signed_in", judged };
  }

  /** Looks at another page of the same sign-in (a popup on the identity provider): whether it asks; it can only show that the sign-in is under way. */
  async observeAside(probe: Probe): Promise<boolean> {
    const signs = await probe.signs();
    if (!signs.loaded || !isWeb(signs.url)) return false;
    const judged = judge(signs, { ...this.input, condition: null, strict: true });
    if (this.input.purpose === "human_check") {
      if (judged.challenge) this.challenged = true;
      return false;
    }
    return judged.asking;
  }

  private async noteAsking(probe: Probe): Promise<void> {
    if (this.asked) return;
    this.asked = true;
    this.baseline = await probe.storage(this.input.origin).catch(() => null);
  }
}

/** The address, title, visible text and visible frames of a Playwright page, and whether it has loaded. */
async function pageLook(page: Page): Promise<Omit<Signs, "fields">> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")).slice(0, MAX_TEXT);
  const frames: string[] = [];
  for (const frame of page.frames().slice(1, MAX_FRAMES)) {
    const element = await frame.frameElement().catch(() => null);
    const box = element ? await element.boundingBox().catch(() => null) : null;
    await element?.dispose().catch(() => undefined);
    if (box && box.width >= 40 && box.height >= 30 && box.x + box.width > 0 && box.y + box.height > 0) frames.push(frame.url());
  }
  const loaded = (await page.evaluate(() => (globalThis as unknown as { document: { readyState: string } }).document.readyState).catch(() => "")) === "complete";
  return { url, title, text, frames, loaded };
}

/** The human check a Playwright page shows, if any (browser/human-check.ts). */
export async function pageChallenge(page: Page): Promise<string | null> {
  const look = await pageLook(page);
  return isWeb(look.url) ? humanCheck({ title: look.title, text: look.text, frames: look.frames, status: null }) : null;
}

/** Reads the node's own tab (Ensemble's own code may run in it; the agent cannot). */
export function playwrightProbe(page: Page, context: BrowserContext): Probe {
  return {
    async signs() {
      const [look, fields] = await Promise.all([pageLook(page), loginFields(page).catch(() => ({ passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 }))]);
      return { ...look, fields };
    },
    visible: (selector) => page.locator(selector).first().isVisible().catch(() => false),
    async storage(origin) {
      const cookies = await context.cookies();
      let storage: Array<[string, string]> | null = null;
      if (safeOrigin(page.url()) === origin) {
        storage = await page
          .evaluate(() => {
            const store = (globalThis as unknown as { localStorage: { length: number; key(index: number): string | null; getItem(key: string): string | null } }).localStorage;
            const items: Array<[string, string]> = [];
            for (let index = 0; index < Math.min(store.length, 500); index += 1) {
              const key = store.key(index);
              if (key !== null) items.push([key, (store.getItem(key) ?? "").slice(0, 4096)]);
            }
            return items;
          })
          .catch(() => null);
      }
      return storageFingerprint(cookies, origin, storage);
    },
  };
}

/** Reads a clean browser's page: one DOM snapshot per look, cookies from the browser, storage through DOMStorage. No page script. */
export function cleanProbe(page: CleanPage, cookies: () => Promise<CleanCookie[]>): Probe {
  let snapshot: Promise<CleanSigns> | null = null;
  return {
    async signs() {
      snapshot ??= page.signs();
      const signs = await snapshot;
      return { url: signs.url, title: signs.title, text: signs.text, frames: signs.frames, fields: countFieldsOf(signs.inputs), loaded: signs.loaded };
    },
    visible: async (selector) => (await page.find(selector).catch(() => null)) !== null,
    async storage(origin) {
      const storage = safeOrigin(page.url) === origin ? await page.localStorage(origin).catch(() => null) : null;
      return storageFingerprint(await cookies(), origin, storage);
    },
  };
}
