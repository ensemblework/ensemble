/**
 * Sign-ins waiting for the owner (B11, docs/35 §8.16). When the broker's heuristics (logins/detect.ts)
 * or the work itself (`browser_login_needed`) say a tab needs its owner to sign in, the tab is marked
 * sensitive at once (no snapshot, screenshot, recording, trace or live view; no agent action) and a
 * login waits here, keeping the tab open, until the owner answers on the card: use the saved login,
 * sign in on this computer (then "I'm done"), type it on the web sealed for this computer, or not now.
 * Then the broker's own code fills the page, checks the signed-in condition, and gives the tab back
 * to the work; never a value. Sign-ins stay in the owner's browser profile for the next task.
 */
import { randomBytes } from "node:crypto";
import { BrowserError, type BrowserBroker } from "../browser/broker.js";
import { appendLedger } from "../lib/ledger.js";
import { env } from "../config.js";
import { isLoopbackOrigin, loginSignals, safeOrigin } from "./detect.js";
import { fillLogin, signedInCheck, type LoginValues, type SignedInCondition } from "./fill.js";
import { hasLogin, loginFor, markLoginUsed, saveLogin } from "./store.js";
import { totpCode } from "./totp.js";

/** How long a sign-in waits here for its owner, at most (a background card expires sooner on the web). */
export const LOGIN_WAIT_MS = 2 * 3600_000;
/** The tab's lease is renewed this often while its sign-in waits. */
const KEEP_EVERY_MS = 60_000;
const FINISHED_KEPT = 200;

export type LoginStatus = "waiting" | "signed_in" | "declined" | "expired" | "ended";
export type LoginOutcome = { loginId: string; status: Exclude<LoginStatus, "waiting">; origin: string; tab: string; message: string };

/** What the work and the web hear about a waiting sign-in: never a value. */
export type LoginInfo = {
  loginId: string;
  origin: string;
  tab: string;
  profile: string | null;
  reasons: string[];
  /** A login is saved on this computer for this site. */
  saved: boolean;
  /** This computer can show the tab in a window for its owner. */
  display: boolean;
  /** The owner can control the tab from the web (B21). */
  takeover: boolean;
  expiresAt: string;
};

export type LoginResolution = { status: "signed_in" | "waiting" | "failed" | "shown" | "no_window" | "declined" | "expired" | "gone" | "busy"; message?: string; savedNow?: boolean };

type Login = {
  id: string;
  broker: BrowserBroker;
  operation: string;
  tab: string;
  origin: string;
  profile: string | null;
  reasons: string[];
  signedIn: SignedInCondition | null;
  expiresAt: number;
  status: LoginStatus;
  /** The card on the web that answers it, once known: a sealed answer must be for that card. */
  decisionId: string | null;
  busy: boolean;
  keep: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
  waiters: Array<(outcome: LoginOutcome) => void>;
};

const waiting = new Map<string, Login>();
const finished = new Map<string, LoginOutcome>();
/** Sites an operation's sign-in settled for: the heuristics only hint there afterwards, so a refusal is not asked again. */
const settled = new Map<string, Map<string, LoginStatus>>();
/** Operations told once that a page of their own computer looks like a sign-in. */
const hinted = new Set<string>();

const ledger = (action: string, payload: Record<string, string | boolean | string[] | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action, payload }).catch(() => undefined);

function info(login: Login): LoginInfo {
  return {
    loginId: login.id,
    origin: login.origin,
    tab: login.tab,
    profile: login.profile,
    reasons: login.reasons,
    saved: hasLogin(login.origin),
    display: login.profile !== null && login.broker.hasWindow(),
    takeover: false,
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

/**
 * Hands a tab to its owner to sign in to `origin`: sensitive at once, kept open while it waits. A tab
 * already waiting keeps its sign-in.
 */
export async function raiseLogin(broker: BrowserBroker, input: { operation: string; tab: string; origin: string; reasons: string[]; signedIn?: SignedInCondition | null; waitMs?: number }): Promise<LoginInfo> {
  const existing = [...waiting.values()].find((item) => item.tab === input.tab && item.operation === input.operation);
  if (existing) return info(existing);
  const tab = broker.ownerTab(input.tab);
  if (tab.operation !== input.operation) throw new BrowserError("not_yours", `Tab ${input.tab} belongs to other work.`);
  await broker.markSensitive(input.tab, true);
  // A window already on the screen comes to the front for the owner; one without a window waits for "Sign in on the computer".
  if (!tab.headless && broker.hasWindow()) await tab.page.bringToFront().catch(() => undefined);
  const id = `lg_${randomBytes(16).toString("hex")}`;
  const waitMs = Math.min(input.waitMs ?? LOGIN_WAIT_MS, LOGIN_WAIT_MS);
  const login: Login = {
    id,
    broker,
    operation: input.operation,
    tab: input.tab,
    origin: input.origin,
    profile: tab.profile,
    reasons: input.reasons.slice(0, 6).map((reason) => reason.slice(0, 200)),
    signedIn: input.signedIn ?? null,
    expiresAt: Date.now() + waitMs,
    status: "waiting",
    decisionId: null,
    busy: false,
    keep: setInterval(() => keepAlive(login), KEEP_EVERY_MS),
    deadline: setTimeout(() => void finish(login, "expired", `Nobody signed in to ${input.origin} in time.`), waitMs),
    waiters: [],
  };
  login.keep.unref();
  login.deadline.unref();
  waiting.set(id, login);
  broker.keepTab(input.tab, KEEP_EVERY_MS * 5);
  await ledger("login.needed", { origin: login.origin, operation: login.operation, reasons: login.reasons });
  return info(login);
}

function keepAlive(login: Login): void {
  try {
    login.broker.ownerTab(login.tab);
    login.broker.keepTab(login.tab, KEEP_EVERY_MS * 5);
  } catch {
    void finish(login, "ended", `The tab for ${login.origin} closed.`);
  }
}

/** Ends a sign-in: the tab is given back to its work (left blank first unless signed in), and whoever waits hears how it ended. */
async function finish(login: Login, status: Exclude<LoginStatus, "waiting">, message: string): Promise<LoginOutcome> {
  const outcome: LoginOutcome = { loginId: login.id, status, origin: login.origin, tab: login.tab, message };
  if (login.status !== "waiting") return finished.get(login.id) ?? outcome;
  login.status = status;
  clearInterval(login.keep);
  clearTimeout(login.deadline);
  waiting.delete(login.id);
  finished.set(login.id, outcome);
  while (finished.size > FINISHED_KEPT) finished.delete(finished.keys().next().value!);
  const sites = settled.get(login.operation) ?? new Map<string, LoginStatus>();
  sites.set(login.origin, status);
  settled.set(login.operation, sites);
  try {
    const tab = login.broker.ownerTab(login.tab);
    // Whatever was typed into a sign-in that did not finish is cleared before the work may read the tab again.
    if (status !== "signed_in") await tab.page.goto("about:blank", { timeout: 10_000 }).catch(() => undefined);
    await login.broker.markSensitive(login.tab, false);
  } catch {
    // The tab is gone.
  }
  await ledger(`login.${status}`, { origin: login.origin, operation: login.operation });
  for (const resolve of login.waiters.splice(0)) resolve(outcome);
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
    signal?.addEventListener("abort", () => void finish(login, "ended", "The work stopped."), { once: true });
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
}

/** Ends an operation's waiting sign-ins (its work ended). */
export async function endLoginsFor(operation: string): Promise<void> {
  for (const login of [...waiting.values()]) if (login.operation === operation) await finish(login, "ended", "The work that needed it ended.");
  settled.delete(operation);
  for (const key of [...hinted]) if (key.startsWith(`${operation}\u0000`)) hinted.delete(key);
}

async function checkNow(login: Login, failed: LoginResolution["status"]): Promise<LoginResolution> {
  let page;
  try {
    page = login.broker.ownerTab(login.tab).page;
  } catch {
    await finish(login, "ended", `The tab for ${login.origin} closed.`);
    return { status: "gone", message: "Its tab closed." };
  }
  const check = await signedInCheck(page, login.origin, login.signedIn);
  if (check.ok) {
    await finish(login, "signed_in", `Signed in to ${login.origin}.`);
    return { status: "signed_in" };
  }
  return { status: failed, message: check.reason };
}

/**
 * The owner's answer on the card. `typed`: values they typed on the web, opened here from a box sealed
 * for this computer (logins/answer.ts), filled, and saved here when they asked and it worked.
 */
export async function resolveLogin(id: string, action: "saved" | "local" | "typed" | "done" | "decline" | "expire", typed?: { values: LoginValues; save: boolean }): Promise<LoginResolution> {
  const login = waiting.get(id);
  if (!login) {
    const done = finished.get(id);
    if (done) return { status: done.status === "signed_in" ? "signed_in" : done.status === "declined" ? "declined" : done.status === "expired" ? "expired" : "gone", message: done.message };
    return { status: "gone", message: "That sign-in is no longer waiting on this computer: its work ended or its tab closed." };
  }
  if (action === "decline") {
    await finish(login, "declined", `The owner chose not to sign in to ${login.origin} now.`);
    return { status: "declined" };
  }
  if (action === "expire") {
    await finish(login, "expired", `Nobody signed in to ${login.origin} in time.`);
    return { status: "expired" };
  }
  if (login.busy) return { status: "busy", message: "Still working on the last answer." };
  login.busy = true;
  try {
    login.broker.keepTab(login.tab, KEEP_EVERY_MS * 5);
    if (action === "local") {
      const shown = await login.broker.showTab(login.tab);
      return shown.shown ? { status: "shown" } : { status: "no_window", message: shown.message };
    }
    if (action === "done") return await checkNow(login, "waiting");
    const page = login.broker.ownerTab(login.tab).page;
    if (action === "saved") {
      const saved = loginFor(login.origin);
      if (!saved) return { status: "failed", message: `No login is saved for ${login.origin} on this computer.` };
      const seed = saved.totp;
      await fillLogin(page, { username: saved.username, password: saved.password, code: seed ? () => totpCode(seed) : null });
      markLoginUsed(login.origin);
      const result = await checkNow(login, "failed");
      await ledger("login.filled", { origin: login.origin, via: "saved", signedIn: result.status === "signed_in" });
      return result.status === "signed_in" ? result : { ...result, message: `Still not signed in after filling the saved login: ${result.message ?? "the site wants something else"}` };
    }
    if (!typed) return { status: "failed", message: "Nothing was typed." };
    await fillLogin(page, typed.values);
    const result = await checkNow(login, "failed");
    await ledger("login.filled", { origin: login.origin, via: "typed", signedIn: result.status === "signed_in" });
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
  return { login: await raiseLogin(broker, { operation, tab: tabId, origin: signals.origin, reasons: signals.reasons }) };
}

/**
 * `browser_login_needed`: the work asks its owner to sign in, in one of its own tabs. The site is the
 * one named (http or https), else the tab's own.
 */
export async function askForLogin(broker: BrowserBroker, operation: string, tabId: string, input: { origin?: string; signedIn?: SignedInCondition; reason?: string }): Promise<LoginInfo> {
  let tab;
  try {
    tab = broker.ownerTab(tabId);
  } catch {
    throw new BrowserError("not_found", `There is no tab ${tabId}. Open one with browser_open.`);
  }
  if (tab.operation !== operation) throw new BrowserError("not_yours", `Tab ${tabId} belongs to other work. Open your own tab.`);
  const origin = input.origin ? safeOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.origin) ? input.origin : `https://${input.origin}`) : safeOrigin(tab.page.url());
  if (!origin) throw new BrowserError("bad_input", input.origin ? `“${input.origin.slice(0, 80)}” is not a site address (https://…).` : "The tab is not on a web page. Open the site's sign-in page first, or name the site with origin.");
  return raiseLogin(broker, { operation, tab: tabId, origin, reasons: [input.reason?.trim() || "the work asked for it"], signedIn: input.signedIn ?? null });
}

/** What the work reads while its sign-in waits. */
export function waitingNote(login: LoginInfo): string {
  return `Tab ${login.tab} needs the owner to sign in to ${login.origin}; it is paused (no reading, screenshots or actions) until they do. Never ask for the password and never type one yourself.`;
}

/** What the work reads when its sign-in ended. */
export function outcomeNote(outcome: LoginOutcome): string {
  if (outcome.status === "signed_in") return `Signed in to ${outcome.origin}. Tab ${outcome.tab} is yours again: take a new snapshot and carry on.`;
  if (outcome.status === "declined") return `The owner chose not to sign in to ${outcome.origin} now (login_required). Do not try to sign in yourself: finish without it, or report the step blocked with what it needs.`;
  if (outcome.status === "expired") return `Nobody signed in to ${outcome.origin} in time (login_required). Report the step blocked with what it needs.`;
  return `The sign-in to ${outcome.origin || "the site"} ended: ${outcome.message}`;
}
