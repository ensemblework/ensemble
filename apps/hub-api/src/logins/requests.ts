/**
 * Sign-ins waiting for the owner (B11, docs/35 §8.16). When the broker's heuristics (logins/detect.ts)
 * or the work itself (`browser_login_needed`) say a tab needs its owner, to sign in or to pass a human
 * check (`purpose`), the tab is marked sensitive at once (no snapshot, screenshot, recording, trace or
 * live view; no agent action) and a login waits here, keeping the tab open, until it is done. It is
 * seen done by itself (logins/watch.ts: the tab, or the clean browser the owner uses, looked at every
 * two seconds and after each page load), or the owner answers on the card: sign in from the web or in
 * a window on this computer, both in a clean browser (logins/clean-signin.ts) whose session then moves
 * into the tab; use the saved login; type it on the web sealed for this computer (and a one-time code
 * when the site asks for one); not now. The broker's own code fills the page and checks the signed-in
 * condition; never a value goes anywhere. Then the tab is given back to the work. Sign-ins stay in the
 * owner's browser profile for the next task.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { BrowserError, type BrowserBroker } from "../browser/broker.js";
import type { CleanCookie } from "../browser/clean.js";
import { addCookies } from "../browser/session-cookies.js";
import { appendLedger } from "../lib/ledger.js";
import { env } from "../config.js";
import type { LoginStatePost } from "../remote/contract.js";
import { CleanBusyError, CleanSignIn, closeCleanBrowsers } from "./clean-signin.js";
import { approvalPrompt, codePrompt, cookieOfSite, identityHostOf, isLoopbackOrigin, isSignInPath, loginFields, loginSignals, safeOrigin, sessionLike, siteOf } from "./detect.js";
import { fillLogin, formChanged, formState, signedInCheck, type LoginValues, type SignedInCondition } from "./fill.js";
import { hasLogin, loginFor, markLoginUsed, saveLogin } from "./store.js";
import { totpCode } from "./totp.js";
import { pageChallenge, playwrightProbe, Watch, type LoginPurpose } from "./watch.js";

/** How long a sign-in waits here for its owner, at most (a background card expires sooner on the web). */
export const LOGIN_WAIT_MS = 2 * 3600_000;
/** The tab's lease is renewed this often while its sign-in waits. */
const KEEP_EVERY_MS = 60_000;
/** A waiting sign-in is looked at this often, and soon after each page load. */
const LOOK_EVERY_MS = 2_000;
const AFTER_LOAD_MS = 600;
const FINISHED_KEPT = 200;
/** Local storage moved from the clean browser into the tab, at most. */
const MAX_STORAGE_ITEMS = 500;
const MAX_STORAGE_CHARS = 2_000_000;

export type { LoginPurpose };
export type LoginStatus = "waiting" | "signed_in" | "passed" | "declined" | "expired" | "ended";
export type LoginOutcome = { loginId: string; status: Exclude<LoginStatus, "waiting">; origin: string; tab: string; message: string; purpose?: LoginPurpose; operation?: string };
/** How a sign-in was seen done: in the node's tab, a window on this computer, the owner's remote view, or the node's own check. */
export type LoginVia = NonNullable<LoginStatePost["via"]>;

/** What the work and the web hear about a waiting sign-in: never a value. */
export type LoginInfo = {
  loginId: string;
  origin: string;
  tab: string;
  profile: string | null;
  /** `sign_in`: the owner's account; `human_check`: a person must pass a check on the page. */
  purpose: LoginPurpose;
  reasons: string[];
  /** A login is saved on this computer for this site. */
  saved: boolean;
  /** This computer can open a window for its owner to sign in. */
  display: boolean;
  /** The owner can sign in from the web, end to end (B21, takeover/session.ts). */
  takeover: boolean;
  expiresAt: string;
};

export type LoginResolution = { status: "signed_in" | "passed" | "needs_code" | "waiting" | "failed" | "shown" | "no_window" | "declined" | "expired" | "gone" | "busy"; message?: string; savedNow?: boolean; code?: string };

/** The owner's answers on the card, and `check` (the same as I'm done, asked from the chat or by the node). */
export type LoginAction = "saved" | "local" | "typed" | "code" | "done" | "check" | "decline" | "expire";

type Login = {
  id: string;
  broker: BrowserBroker;
  operation: string;
  tab: string;
  origin: string;
  profile: string | null;
  purpose: LoginPurpose;
  reasons: string[];
  signedIn: SignedInCondition | null;
  expiresAt: number;
  status: LoginStatus;
  /** The card on the web that answers it, once known: a sealed answer must be for that card. */
  decisionId: string | null;
  busy: boolean;
  keep: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
  /** The automatic watch of the node's tab (paused while a clean browser is open for it). */
  watch: Watch;
  look: NodeJS.Timeout;
  looking: boolean;
  watched: { page: Page; listener: () => void } | null;
  /** The clean browser the owner signs in with, while it is open, and how they reached it. */
  clean: { session: CleanSignIn; via: "window" | "takeover" } | null;
  /** A takeover of the tab itself controls it (the fallback when no clean browser starts). */
  controlled: boolean;
  /** Raised because the page asked to sign in (the broker's heuristics), not only because the work said so. */
  pageAsked: boolean;
  /** What the site asks for after a typed login (`needs_code`). */
  codeHint: string | null;
  /** A typed login the owner asked to save, kept until the sign-in it began is done (a code or an approval came after it). */
  pendingSave: { username: string; password: string } | null;
  /** The clean browser's sign-in being moved into the tab: an I'm done meanwhile hears how that went. */
  finishing: Promise<LoginResolution> | null;
  waiters: Array<(outcome: LoginOutcome) => void>;
};

const waiting = new Map<string, Login>();
const finished = new Map<string, LoginOutcome>();
/** Sites an operation's sign-in settled for: the heuristics only hint there afterwards, so a refusal is not asked again. */
const settled = new Map<string, Map<string, LoginStatus>>();
/** Operations told once that a page of their own computer looks like a sign-in. */
const hinted = new Set<string>();

/**
 * Sign-ins ending (`finished`, with the outcome) and clean browsers closing on their own (`cleanClosed`,
 * `{loginId, reason}`): a takeover showing one ends with it (takeover/session.ts).
 */
export const loginEvents = new EventEmitter();
loginEvents.setMaxListeners(50);

type StateSink = (loginId: string, state: LoginStatePost) => Promise<unknown>;
let stateSink: StateSink | null = null;

/** Set by the remote loop while it is connected: a sign-in that changed here by itself is told to the web (`ROUTES.loginState`). */
export function setLoginStateSink(next: StateSink | null): void {
  stateSink = next;
}

/**
 * Tells the web a sign-in changed here by itself, when the web knows it: a node's (its tool answer raised
 * the card) or one a card answered or a run raised on the web. A run started on this computer stays here.
 */
function tell(login: Login, state: LoginStatePost): void {
  if (!stateSink || (!login.operation.startsWith("node:") && login.decisionId === null)) return;
  void stateSink(login.id, state).catch(() => undefined);
}

const ledger = (action: string, payload: Record<string, string | boolean | string[] | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action, payload }).catch(() => undefined);

function info(login: Login): LoginInfo {
  return {
    loginId: login.id,
    origin: login.origin,
    tab: login.tab,
    profile: login.profile,
    purpose: login.purpose,
    reasons: login.reasons,
    saved: login.purpose === "sign_in" && hasLogin(login.origin),
    display: login.broker.hasWindow(),
    takeover: true,
    expiresAt: new Date(login.expiresAt).toISOString(),
  };
}

/** A waiting sign-in, by id. */
export function waitingLogin(id: string): LoginInfo | null {
  const login = waiting.get(id);
  return login ? info(login) : null;
}

/** The waiting sign-in of a tab, if any. */
export function loginOfTab(tab: string): LoginInfo | null {
  const login = [...waiting.values()].find((item) => item.tab === tab);
  return login ? info(login) : null;
}

/** The operation a waiting sign-in belongs to (the takeover that resumes it checks the same tab). */
export function loginOperation(id: string): string | null {
  return waiting.get(id)?.operation ?? null;
}

/** What a sign-in is for, in words: "sign in to X" or "pass the human check on X". */
const what = (login: Pick<Login, "purpose" | "origin">) => (login.purpose === "human_check" ? `pass the human check on ${login.origin}` : `sign in to ${login.origin}`);

/**
 * Hands a tab to its owner to sign in to `origin` (or pass a human check there): sensitive at once,
 * kept open while it waits, and watched. A tab already waiting keeps its sign-in.
 */
export async function raiseLogin(broker: BrowserBroker, input: { operation: string; tab: string; origin: string; reasons: string[]; signedIn?: SignedInCondition | null; purpose?: LoginPurpose; waitMs?: number; pageAsked?: boolean }): Promise<LoginInfo> {
  const existing = [...waiting.values()].find((item) => item.tab === input.tab && item.operation === input.operation);
  if (existing) return info(existing);
  const tab = broker.ownerTab(input.tab);
  if (tab.operation !== input.operation) throw new BrowserError("not_yours", `Tab ${input.tab} belongs to other work.`);
  await broker.markSensitive(input.tab, true);
  // A window already on the screen comes to the front for the owner.
  if (!tab.headless && broker.hasWindow()) await tab.page.bringToFront().catch(() => undefined);
  const id = `lg_${randomBytes(16).toString("hex")}`;
  const waitMs = Math.min(input.waitMs ?? LOGIN_WAIT_MS, LOGIN_WAIT_MS);
  const purpose = input.purpose ?? "sign_in";
  const login: Login = {
    id,
    broker,
    operation: input.operation,
    tab: input.tab,
    origin: input.origin,
    profile: tab.profile,
    purpose,
    reasons: input.reasons.slice(0, 6).map((reason) => reason.slice(0, 200)),
    signedIn: input.signedIn ?? null,
    expiresAt: Date.now() + waitMs,
    status: "waiting",
    decisionId: null,
    busy: false,
    keep: setInterval(() => keepAlive(login), KEEP_EVERY_MS),
    deadline: setTimeout(() => void finish(login, "expired", `Nobody did it in time: ${what({ purpose, origin: input.origin })}.`, { tell: true }), waitMs),
    watch: new Watch({ origin: input.origin, purpose, condition: input.signedIn ?? null, requireChallenge: true }),
    look: setInterval(() => void look(login), LOOK_EVERY_MS),
    looking: false,
    watched: null,
    clean: null,
    controlled: false,
    pageAsked: input.pageAsked === true,
    codeHint: null,
    pendingSave: null,
    finishing: null,
    waiters: [],
  };
  login.keep.unref();
  login.deadline.unref();
  login.look.unref();
  waiting.set(id, login);
  broker.keepTab(input.tab, KEEP_EVERY_MS * 5);
  watchLoads(login, tab.page);
  // A first look at once: what the page shows when the owner is asked is what a change is measured from.
  setTimeout(() => void look(login), 0).unref();
  await ledger("login.needed", { origin: login.origin, operation: login.operation, purpose, reasons: login.reasons });
  return info(login);
}

function keepAlive(login: Login): void {
  try {
    login.broker.ownerTab(login.tab);
    login.broker.keepTab(login.tab, KEEP_EVERY_MS * 5);
  } catch {
    void finish(login, "ended", `The tab for ${login.origin} closed.`, { tell: true });
  }
}

/** Looks again soon after each page load of the node's tab (its page changes when its browser restarts). */
function watchLoads(login: Login, page: Page): void {
  if (login.watched?.page === page) return;
  if (login.watched) login.watched.page.off("load", login.watched.listener);
  const listener = () => setTimeout(() => void look(login), AFTER_LOAD_MS).unref();
  page.on("load", listener);
  login.watched = { page, listener };
}

/** The automatic watch of the node's tab: finishes the sign-in when it is seen done there. */
async function look(login: Login): Promise<void> {
  if (login.status !== "waiting" || login.busy || login.looking || login.clean) return;
  login.looking = true;
  try {
    let tab;
    try {
      tab = login.broker.ownerTab(login.tab);
    } catch {
      // Closed, or its browser restarting with a window: the lease keeper ends a sign-in whose tab is gone.
      return;
    }
    watchLoads(login, tab.page);
    const seen = await login.watch.observe(playwrightProbe(tab.page, tab.context));
    if (seen.done && seen.status && login.status === "waiting" && !login.busy && !login.clean) {
      await finish(login, seen.status, seen.status === "passed" ? `The human check on ${login.origin} was passed.` : `Signed in to ${login.origin}.`, { tell: true, via: login.controlled ? "takeover" : "computer" });
    }
  } catch {
    // The page changed under the look; the next one sees it.
  } finally {
    login.looking = false;
  }
}

/** Ends a sign-in: the tab is given back to its work (left blank first unless it is done), and whoever waits hears how it ended. */
async function finish(login: Login, status: Exclude<LoginStatus, "waiting">, message: string, options: { tell?: boolean; via?: LoginVia } = {}): Promise<LoginOutcome> {
  const outcome: LoginOutcome = { loginId: login.id, status, origin: login.origin, tab: login.tab, message, purpose: login.purpose, operation: login.operation };
  if (login.status !== "waiting") return finished.get(login.id) ?? outcome;
  login.status = status;
  clearInterval(login.keep);
  clearTimeout(login.deadline);
  clearInterval(login.look);
  if (login.watched) login.watched.page.off("load", login.watched.listener);
  login.watched = null;
  waiting.delete(login.id);
  finished.set(login.id, outcome);
  while (finished.size > FINISHED_KEPT) finished.delete(finished.keys().next().value!);
  const sites = settled.get(login.operation) ?? new Map<string, LoginStatus>();
  sites.set(login.origin, status);
  settled.set(login.operation, sites);
  if (status === "signed_in") savePending(login);
  login.pendingSave = null;
  const clean = login.clean;
  login.clean = null;
  if (clean) await clean.session.close(status === "signed_in" || status === "passed" ? status : "ended").catch(() => undefined);
  try {
    const tab = login.broker.ownerTab(login.tab);
    // Whatever was typed into a sign-in that did not finish is cleared before the work may read the tab again.
    if (status !== "signed_in" && status !== "passed") await tab.page.goto("about:blank", { timeout: 10_000 }).catch(() => undefined);
    await login.broker.markSensitive(login.tab, false);
  } catch {
    // The tab is gone.
  }
  await ledger(`login.${status}`, { origin: login.origin, operation: login.operation, purpose: login.purpose, via: options.via ?? null });
  for (const resolve of login.waiters.splice(0)) resolve(outcome);
  loginEvents.emit("finished", outcome);
  if (options.tell) tell(login, { status, message: message.slice(0, 500), ...(options.via ? { via: options.via } : {}) });
  return outcome;
}

/** Waits until a sign-in ends; at once for one that already has. A stopped run declines it. */
export function waitForLogin(id: string, signal?: AbortSignal): Promise<LoginOutcome> {
  const done = finished.get(id);
  if (done) return Promise.resolve(done);
  const login = waiting.get(id);
  if (!login) return Promise.resolve({ loginId: id, status: "ended", origin: "", tab: "", message: "That sign-in is no longer waiting." });
  return new Promise((resolve) => {
    login.waiters.push(resolve);
    signal?.addEventListener("abort", () => void finish(login, "ended", "The work stopped.", { tell: true }), { once: true });
  });
}

/** Binds a sign-in to the card that answers it, the first time one is named; another card cannot answer it then. */
export function bindDecision(id: string, decisionId: string): boolean {
  const login = waiting.get(id);
  if (!login) return true;
  login.decisionId ??= decisionId;
  return login.decisionId === decisionId;
}

/** Ends every waiting sign-in: this computer stopped taking work from the web, so nobody can answer them. */
export async function endAllLogins(message: string): Promise<void> {
  for (const login of [...waiting.values()]) await finish(login, "ended", message);
  await closeCleanBrowsers().catch(() => undefined);
}

/** Ends an operation's waiting sign-ins (its work ended). */
export async function endLoginsFor(operation: string): Promise<void> {
  for (const login of [...waiting.values()]) if (login.operation === operation) await finish(login, "ended", "The work that needed it ended.", { tell: true });
  settled.delete(operation);
  for (const key of [...hinted]) if (key.startsWith(`${operation}\u0000`)) hinted.delete(key);
}

/** A takeover of the tab itself (the fallback without a clean browser) starts or ends: a sign-in seen done meanwhile was done there. */
export function markLoginControlled(id: string, on: boolean): void {
  const login = waiting.get(id);
  if (login) login.controlled = on;
}

const done = (purpose: LoginPurpose): "signed_in" | "passed" => (purpose === "human_check" ? "passed" : "signed_in");

/** Checks the node's tab now (I'm done, a check): signed in (or through the check), it ends. */
async function checkTab(login: Login, failed: LoginResolution["status"], via: LoginVia, tellWeb: boolean): Promise<LoginResolution> {
  let tab;
  try {
    tab = login.broker.ownerTab(login.tab);
  } catch {
    await finish(login, "ended", `The tab for ${login.origin} closed.`, { tell: tellWeb });
    return { status: "gone", message: "Its tab closed." };
  }
  const check = await signedInCheck(tab.page, login.origin, login.signedIn, login.purpose);
  if (check.ok) {
    const status = done(login.purpose);
    await finish(login, status, status === "passed" ? `The human check on ${login.origin} was passed.` : `Signed in to ${login.origin}.`, { tell: tellWeb, via });
    return { status };
  }
  return { status: failed, message: check.reason };
}

/**
 * The clean browser's sign-in is done: its cookies (and the site's local storage) move into the node's
 * profile, the node's tab opens where the clean browser ended (or reloads), and must then pass the
 * check itself. A human check ends passed even when the site still shows its check to the tab.
 */
async function carryOver(login: Login, session: CleanSignIn): Promise<{ ok: boolean; reason: string }> {
  const tab = login.broker.ownerTab(login.tab);
  const cookies = await session.cookiesToCarry();
  const moved = await addCookies(tab.context, cookies);
  let storage = (await session.storageOf(login.origin).catch(() => [] as Array<[string, string]>)).slice(0, MAX_STORAGE_ITEMS);
  let size = 0;
  storage = storage.filter(([key, value]) => (size += key.length + value.length) <= MAX_STORAGE_CHARS);
  const landing = session.landing();
  const target = landing ?? (/^https?:/i.test(tab.page.url()) ? tab.page.url() : login.origin);
  await tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  if (storage.length && safeOrigin(tab.page.url()) === login.origin) {
    const set = await tab.page
      .evaluate((items) => {
        const store = (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
        for (const [key, value] of items) store.setItem(key, value);
        return true;
      }, storage)
      .catch(() => false);
    if (set) await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  }
  let last = { ok: false, reason: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    last = await signedInCheck(tab.page, login.origin, login.signedIn, login.purpose).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message.split("\n")[0]! : "The tab could not be read." }));
    if (last.ok) break;
  }
  await ledger("login.carried", { origin: login.origin, operation: login.operation, cookies: String(moved), storage: String(storage.length), ok: last.ok });
  return last;
}

/** Finishes a sign-in the clean browser saw done (or the owner said so): carried into the tab, checked there. */
async function finishClean(login: Login, session: CleanSignIn, via: LoginVia, tellWeb: boolean): Promise<LoginResolution> {
  const status = done(login.purpose);
  let carried: { ok: boolean; reason: string };
  try {
    carried = await carryOver(login, session);
  } catch (error) {
    carried = { ok: false, reason: error instanceof Error ? error.message.split("\n")[0]! : "The tab could not take the session." };
  }
  if (carried.ok || login.purpose === "human_check") {
    const note = carried.ok ? "" : ` The site still shows a check in Ensemble's browser (${carried.reason}); it may let only a person's browser through.`;
    await finish(login, status, `${status === "passed" ? `The human check on ${login.origin} was passed.` : `Signed in to ${login.origin}.`}${note}`, { tell: tellWeb, via });
    return { status, ...(note ? { message: note.trim() } : {}) };
  }
  const message = `You signed in, but ${login.origin} did not take the session in Ensemble's browser: ${carried.reason} Try again, or sign in another way.`;
  if (login.clean?.session === session) login.clean = null;
  await session.close("not_carried").catch(() => undefined);
  loginEvents.emit("cleanClosed", { loginId: login.id, reason: "not_carried" });
  if (tellWeb) tell(login, { status: "waiting", message: message.slice(0, 500), via });
  return { status: "waiting", message };
}

/**
 * Opens the clean browser for a sign-in (`window`: on this computer's screen; else for a takeover from
 * the web), at the node tab's page, with the tab's own cookies for the site. Replaces one already open.
 */
export async function openCleanSignIn(id: string, mode: "window" | "takeover"): Promise<CleanSignIn> {
  const login = waiting.get(id);
  if (!login) throw new BrowserError("not_found", "That sign-in is no longer waiting on this computer.");
  const tab = login.broker.ownerTab(login.tab);
  const spec = login.broker.cleanSignIn(tab.profile);
  if (!spec) throw new BrowserError("unavailable", "There is no Chromium with a window on this computer for signing in.");
  const url = /^https?:/i.test(tab.page.url()) ? tab.page.url() : login.origin;
  const site = siteOf(login.origin);
  // The tab's own cookies for the site (not an identity provider's, which the clean browser keeps itself), so a sign-in begun there goes on.
  const seed: CleanCookie[] =
    site && !identityHostOf(login.origin)
      ? (await tab.context.cookies().catch(() => [])).filter((cookie) => cookieOfSite(cookie.domain, site) && sessionLike(cookie.name)).map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }))
      : [];
  const previous = login.clean;
  login.clean = null;
  if (previous) {
    await previous.session.close("replaced").catch(() => undefined);
    loginEvents.emit("cleanClosed", { loginId: login.id, reason: "replaced" });
  }
  const session = await CleanSignIn.open({ loginId: id, origin: login.origin, purpose: login.purpose, condition: login.signedIn, url, spec, dataHome: login.broker.dataFolder(), window: mode === "window", seed, asked: login.pageAsked || login.watch.askedOnce });
  if (login.status !== "waiting") {
    await session.close("ended");
    throw new BrowserError("not_found", "That sign-in is no longer waiting on this computer.");
  }
  login.clean = { session, via: mode };
  session.on("done", () => {
    if (login.finishing || login.clean?.session !== session || login.status !== "waiting" || login.busy) return;
    login.busy = true;
    login.finishing = finishClean(login, session, mode, true).finally(() => {
      login.busy = false;
      login.finishing = null;
    });
  });
  session.once("closed", (reason: string) => {
    if (login.clean?.session !== session) return;
    login.clean = null;
    loginEvents.emit("cleanClosed", { loginId: login.id, reason });
  });
  await ledger("login.clean_opened", { origin: login.origin, operation: login.operation, purpose: login.purpose, via: mode });
  return session;
}

/** The clean browser a sign-in is open in, if any. */
export function cleanSignInOf(id: string): CleanSignIn | null {
  return waiting.get(id)?.clean?.session ?? null;
}

/** Closes a sign-in's clean browser without ending the sign-in (a takeover stopped); it keeps waiting. */
export async function closeCleanSignIn(id: string, reason: string): Promise<void> {
  const login = waiting.get(id);
  const clean = login?.clean;
  if (!login || !clean) return;
  login.clean = null;
  await clean.session.close(reason).catch(() => undefined);
}

/** Asked now: the clean browser when one is open (its page decides), else the node's tab. */
async function checkNow(login: Login, failed: LoginResolution["status"], via: LoginVia, tellWeb: boolean): Promise<LoginResolution> {
  const clean = login.clean;
  if (clean) {
    const judged = await clean.session.check().catch(() => null);
    if (judged?.ok) return finishClean(login, clean.session, clean.via, tellWeb);
    // The tab itself may be signed in (the owner did it another way meanwhile).
    const tab = await checkTab(login, failed, via, tellWeb);
    if (tab.status !== failed) return tab;
    return { status: failed, message: judged?.reason || tab.message };
  }
  return checkTab(login, failed, via, tellWeb);
}

const resolutionOf = (outcome: LoginOutcome): LoginResolution => ({
  status: outcome.status === "signed_in" || outcome.status === "passed" || outcome.status === "declined" || outcome.status === "expired" ? outcome.status : "gone",
  message: outcome.message,
});

/** Saves the typed login the owner asked to keep, once the sign-in it began is done. Whether it was saved; null when none waited. */
function savePending(login: Login): boolean | null {
  const pending = login.pendingSave;
  login.pendingSave = null;
  if (!pending) return null;
  try {
    saveLogin({ origin: login.origin, username: pending.username, password: pending.password });
    return true;
  } catch {
    return false;
  }
}

/**
 * After a fill: asked for a code, signed in, asked for an approval, or still not. Only a page that moved
 * on can be signed in, and a code field on it means it is not yet.
 */
async function afterFill(login: Login, page: Page, before: { url: string; fields: Awaited<ReturnType<typeof loginFields>> }, filled: string[], via: "saved" | "typed" | "code"): Promise<LoginResolution> {
  if (!filled.length) return { status: "failed", message: via === "code" ? "There is no field for a code on the page." : "There is no sign-in form on the page to fill in." };
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  const after = await formState(page);
  const changed = formChanged(before, after);
  const check = await signedInCheck(page, login.origin, login.signedIn, "sign_in");
  const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const hint = check.challenge ? null : codePrompt({ text, fields: after.fields });
  const needsCode = (): LoginResolution => {
    login.codeHint = hint;
    return { status: "needs_code", message: via === "code" ? `The site did not take that code. ${hint}` : hint! };
  };
  if (hint && after.fields.codes > 0) return needsCode();
  if (check.ok && changed) {
    const saved = login.pendingSave ? savePending(login) : null;
    await finish(login, "signed_in", `Signed in to ${login.origin}.`, { via: "computer" });
    return { status: "signed_in", ...(saved !== null ? { savedNow: saved } : {}) };
  }
  if (hint) return needsCode();
  const approval = check.challenge ? null : approvalPrompt(text);
  if (approval) return { status: "waiting", message: approval };
  return { status: "failed", message: !changed && check.ok ? "The page did not change after filling it in: the sign-in did not go through." : check.reason || "The site wants something else." };
}

/**
 * The owner's answer on the card (or `check`: the same as I'm done, asked from the chat or by the node).
 * `typed`: values they typed on the web, opened here from a box sealed for this computer
 * (logins/answer.ts), filled, and saved here when they asked and it worked; `code`: the one-time code
 * the site asks for after one.
 */
export async function resolveLogin(id: string, action: LoginAction, typed?: { values: LoginValues; save: boolean }, options: { via?: LoginVia; tell?: boolean } = {}): Promise<LoginResolution> {
  const login = waiting.get(id);
  if (!login) {
    const outcome = finished.get(id);
    if (outcome) return resolutionOf(outcome);
    return { status: "gone", message: "That sign-in is no longer waiting on this computer: its work ended or its tab closed." };
  }
  if (action === "decline") {
    await finish(login, "declined", `The owner chose not to ${what(login)} now.`);
    return { status: "declined" };
  }
  if (action === "expire") {
    await finish(login, "expired", `Nobody did it in time: ${what(login)}.`);
    return { status: "expired" };
  }
  if (login.purpose === "human_check" && (action === "saved" || action === "typed" || action === "code")) {
    return { status: "failed", message: `This is a human check on ${login.origin}, not a sign-in: open it and pass it yourself.` };
  }
  // The clean browser was just seen done and its session is moving into the tab: that is the answer.
  if (login.finishing && (action === "done" || action === "check")) return login.finishing;
  if (login.busy) return { status: "busy", message: "Still working on the last answer." };
  login.busy = true;
  try {
    login.broker.keepTab(login.tab, KEEP_EVERY_MS * 5);
    if (action === "local") {
      if (!login.broker.hasWindow()) return { status: "no_window", message: "This computer has no screen to show the browser on." };
      try {
        await openCleanSignIn(login.id, "window");
        return { status: "shown" };
      } catch (error) {
        if (error instanceof CleanBusyError) return { status: "busy", message: error.message };
        // No clean browser here: the node's own browser comes to the screen instead.
        const shown = await login.broker.showTab(login.tab);
        const why = error instanceof Error ? error.message.split("\n")[0]! : "it did not start";
        return shown.shown ? { status: "shown", message: `Ensemble's sign-in browser could not open (${why}), so the node's own browser is on the screen.` } : { status: "no_window", message: shown.message };
      }
    }
    if (action === "done" || action === "check") return await checkNow(login, "waiting", options.via ?? "computer", options.tell ?? false);
    const page = login.broker.ownerTab(login.tab).page;
    const before = await formState(page);
    if (action === "saved") {
      const saved = loginFor(login.origin);
      if (!saved) return { status: "failed", message: `No login is saved for ${login.origin} on this computer.` };
      const seed = saved.totp;
      const { filled } = await fillLogin(page, { username: saved.username, password: saved.password, code: seed ? () => totpCode(seed) : null });
      markLoginUsed(login.origin);
      const result = await afterFill(login, page, before, filled, "saved");
      await ledger("login.filled", { origin: login.origin, via: "saved", signedIn: result.status === "signed_in" });
      return result.status === "signed_in" || result.status === "needs_code" || result.status === "waiting" ? result : { ...result, message: `Still not signed in after filling the saved login: ${result.message ?? "the site wants something else"}` };
    }
    if (!typed) return { status: "failed", message: "Nothing was typed." };
    if (action === "code") {
      if (!typed.values.code) return { status: "failed", message: "Type the code the site asks for." };
      const { filled } = await fillLogin(page, { code: typed.values.code });
      const result = await afterFill(login, page, before, filled, "code");
      await ledger("login.filled", { origin: login.origin, via: "code", signedIn: result.status === "signed_in" });
      return result;
    }
    const { filled } = await fillLogin(page, typed.values);
    const result = await afterFill(login, page, before, filled, "typed");
    await ledger("login.filled", { origin: login.origin, via: "typed", signedIn: result.status === "signed_in" });
    if (result.status === "needs_code" || result.status === "waiting") {
      // Saved once the code or the approval that follows signs in.
      if (typed.save && typed.values.username && typed.values.password) login.pendingSave = { username: typed.values.username, password: typed.values.password };
      return result;
    }
    if (result.status !== "signed_in") return { ...result, message: `Still not signed in: ${result.message ?? "the site wants something else"} Check what you typed, or sign in another way.` };
    if (typed.save && typed.values.username && typed.values.password) {
      try {
        saveLogin({ origin: login.origin, username: typed.values.username, password: typed.values.password });
        return { ...result, savedNow: true };
      } catch (error) {
        return { ...result, savedNow: false, message: `Signed in, but not saved: ${error instanceof Error ? error.message : "it could not be saved"}` };
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "The browser could not do that.";
    return { status: "failed", message };
  } finally {
    login.busy = false;
  }
}

/**
 * `browser_login_check`: the work checks a tab's waiting sign-in now (its owner said they did it). Done,
 * it ends (and the web hears it); not yet, it keeps waiting and says why.
 */
export async function checkLoginOfTab(broker: BrowserBroker, operation: string, tabId: string): Promise<{ status: "signed_in" | "passed" | "waiting"; message: string }> {
  let tab;
  try {
    tab = broker.ownerTab(tabId);
  } catch {
    throw new BrowserError("not_found", `There is no tab ${tabId}. Open one with browser_open.`);
  }
  if (tab.operation !== operation) throw new BrowserError("not_yours", `Tab ${tabId} belongs to other work. Open your own tab.`);
  const login = [...waiting.values()].find((item) => item.tab === tabId && item.operation === operation);
  if (!login) {
    const outcome = [...finished.values()].reverse().find((item) => item.tab === tabId && item.operation === operation);
    if (outcome && (outcome.status === "signed_in" || outcome.status === "passed")) return { status: outcome.status, message: outcomeNote(outcome) };
    throw new BrowserError("not_found", `No sign-in or human check waits on tab ${tabId}.`);
  }
  const result = await resolveLogin(login.id, "check", undefined, { via: "check", tell: true });
  if (result.status === "signed_in" || result.status === "passed") return { status: result.status, message: outcomeNote(finished.get(login.id) ?? { loginId: login.id, status: result.status, origin: login.origin, tab: tabId, message: "", purpose: login.purpose }) };
  return { status: "waiting", message: `Still waiting for the owner to ${what(login)}${result.message ? `: ${result.message}` : "."} The card stays open; never ask for a password or code in the chat.` };
}

/**
 * After a call navigated or acted on a tab: raises a sign-in when the page clearly asks for one, on
 * the owner's profile and another site; only a hint on this computer's own addresses (usually the app
 * the work builds), in a private tab (a clean context for testing), or where the owner already
 * answered for this work.
 */
export async function checkForLogin(broker: BrowserBroker, operation: string, tabId: string, input: { requested?: string | null; status?: number | null } = {}): Promise<{ login?: LoginInfo; note?: string } | null> {
  let tab;
  try {
    tab = broker.ownerTab(tabId);
  } catch {
    return null;
  }
  if (tab.operation !== operation || tab.sensitive) return null;
  const signals = await loginSignals(tab.page, input).catch(() => null);
  if (!signals?.needed || !signals.origin || !safeOrigin(signals.origin)) return null;
  const before = settled.get(operation)?.get(signals.origin);
  if (tab.profile === null || isLoopbackOrigin(signals.origin) || before) {
    const key = `${operation}\u0000${signals.origin}`;
    if (hinted.has(key)) return null;
    hinted.add(key);
    if (before === "declined" || before === "expired") return { note: `The owner did not sign in to ${signals.origin} for this work: do not try to sign in yourself.` };
    return { note: `This page looks like a sign-in (${signals.reasons[0]}). If the work needs the owner's account here, call browser_login_needed; never type a password yourself.` };
  }
  return { login: await raiseLogin(broker, { operation, tab: tabId, origin: signals.origin, reasons: signals.reasons, pageAsked: true }) };
}

/** Words of a human check in the work's reason. */
const HUMAN_WORDS = /\b(?:human|captcha|robot|bot check|are you a person|verify you are|cloudflare|challenge)\b/i;

/**
 * `browser_login_needed`: the work asks its owner to sign in (or pass a human check), in one of its own
 * tabs. The site is the one named (http or https), else the tab's own. A page the broker sees is a human
 * check, with no sign-in form on it, is raised as one whatever the work said.
 */
export async function askForLogin(broker: BrowserBroker, operation: string, tabId: string, input: { origin?: string; signedIn?: SignedInCondition; reason?: string; purpose?: LoginPurpose }): Promise<LoginInfo> {
  let tab;
  try {
    tab = broker.ownerTab(tabId);
  } catch {
    throw new BrowserError("not_found", `There is no tab ${tabId}. Open one with browser_open.`);
  }
  if (tab.operation !== operation) throw new BrowserError("not_yours", `Tab ${tabId} belongs to other work. Open your own tab.`);
  const origin = input.origin ? safeOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.origin) ? input.origin : `https://${input.origin}`) : safeOrigin(tab.page.url());
  if (!origin) throw new BrowserError("bad_input", input.origin ? `“${input.origin.slice(0, 80)}” is not a site address (https://…).` : "The tab is not on a web page. Open the site's sign-in page first, or name the site with origin.");
  const reason = input.reason?.trim() || "";
  const challenge = tab.sensitive ? null : await pageChallenge(tab.page).catch(() => null);
  let purpose: LoginPurpose = input.purpose ?? (HUMAN_WORDS.test(reason) ? "human_check" : "sign_in");
  if (challenge && purpose === "sign_in") {
    // A sign-in form with a captcha on it is still a sign-in.
    const fields = await loginFields(tab.page).catch(() => null);
    if (!fields || !(fields.passwords > 0 || ((fields.usernames > 0 || fields.codes > 0) && isSignInPath(tab.page.url())))) purpose = "human_check";
  }
  const reasons = [...(challenge && purpose === "human_check" ? [`the page shows ${challenge}`] : []), reason || (purpose === "human_check" ? "the work met a human check" : "the work asked for it")];
  return raiseLogin(broker, { operation, tab: tabId, origin, reasons, signedIn: input.signedIn ?? null, purpose });
}

/** What the work reads while its sign-in waits. */
export function waitingNote(login: LoginInfo): string {
  if (login.purpose === "human_check") return `Tab ${login.tab} shows a human check on ${login.origin}; it is paused (no reading, screenshots or actions) until the owner passes it. Never try to solve it yourself.`;
  return `Tab ${login.tab} needs the owner to sign in to ${login.origin}; it is paused (no reading, screenshots or actions) until they do. Never ask for the password and never type one yourself.`;
}

/** What the work reads when its sign-in ended. */
export function outcomeNote(outcome: LoginOutcome): string {
  const extra = /still shows a check/.test(outcome.message) ? ` ${outcome.message.replace(/^[^.]*\.\s*/, "")}` : "";
  if (outcome.status === "signed_in") return `Signed in to ${outcome.origin}. Tab ${outcome.tab} is yours again: take a new snapshot and carry on.`;
  if (outcome.status === "passed") return `The owner passed the human check on ${outcome.origin}. Tab ${outcome.tab} is yours again: take a new snapshot and carry on.${extra}`;
  if (outcome.status === "declined") return `The owner chose not to ${outcome.purpose === "human_check" ? "pass the human check on" : "sign in to"} ${outcome.origin} now (login_required). Do not try to do it yourself: finish without it, or report the step blocked with what it needs.`;
  if (outcome.status === "expired") return `Nobody ${outcome.purpose === "human_check" ? "passed the human check on" : "signed in to"} ${outcome.origin} in time (login_required). Report the step blocked with what it needs.`;
  return `The sign-in to ${outcome.origin || "the site"} ended: ${outcome.message}`;
}
