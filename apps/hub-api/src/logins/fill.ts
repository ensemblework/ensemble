/**
 * Filling a sign-in page for its owner (B11): a saved login, or one they typed on the web sealed for
 * this computer. The broker's own code finds the fields and fills them with Playwright (user name,
 * then password, then a one-time code, a step at a time as the site asks), and presses Enter. The
 * values go from this process into the page and nowhere else: never to a model, a log, a trace or a
 * screenshot (the tab is sensitive the whole time). Then the signed-in check: the condition the work
 * declared (a URL pattern or a selector), or by default no sign-in field left on the site's own page,
 * which must not be a human check (logins/watch.ts).
 */
import type { Frame, Locator, Page } from "playwright-core";
import { CODE_FIELD, firstVisible, loginFields, PASSWORD_FIELD, USERNAME_FIELD, type FieldCount } from "./detect.js";
import { judge, playwrightProbe, urlMatches, type LoginPurpose, type SignedInCondition } from "./watch.js";

export type LoginValues = { username?: string | null; password?: string | null; code?: (() => string | null) | null };
export type { SignedInCondition };

const STEP_MS = 8_000;
/** A visible field a person types a code into when the site names it otherwise (`smsCode`, `passcode`, `pin`). */
const TYPING_FIELD = ['input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[type="tel"]', 'input[type="number"]', 'input[type="text"]', "input:not([type])"].map((selector) => `${selector}:not([type="hidden"]):visible`).join(", ");

/** The one visible field to type into, over the page's frames; null when there is none, or more than one (a search box beside it). */
async function onlyTypingField(page: Page): Promise<{ frame: Frame; field: Locator } | null> {
  let found: { frame: Frame; field: Locator } | null = null;
  let count = 0;
  for (const frame of page.frames().slice(0, 20)) {
    const fields = frame.locator(TYPING_FIELD);
    const here = await fields.count().catch(() => 0);
    if (!here) continue;
    count += here;
    if (count > 1) return null;
    found = { frame, field: fields.first() };
  }
  return found;
}

/** Presses Enter in a field and waits for the page to move on: a navigation, or the field going away. */
async function submit(page: Page, field: Locator): Promise<void> {
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: STEP_MS }).catch(() => null);
  await field.press("Enter", { timeout: STEP_MS });
  await Promise.race([navigated, field.waitFor({ state: "hidden", timeout: STEP_MS }).catch(() => null)]);
  await page.waitForLoadState("domcontentloaded", { timeout: STEP_MS }).catch(() => undefined);
}

/**
 * Fills what the page asks for, step by step, at most once each: the user name (on its own page when
 * the site asks for it first), the password, then a one-time code. Returns which were filled.
 */
export async function fillLogin(page: Page, values: LoginValues): Promise<{ filled: Array<"username" | "password" | "code"> }> {
  const filled: Array<"username" | "password" | "code"> = [];
  for (let step = 0; step < 4; step += 1) {
    const password = await firstVisible(page, PASSWORD_FIELD);
    if (password && values.password && !filled.includes("password")) {
      const user = await password.frame.locator(USERNAME_FIELD).first();
      if (values.username && !filled.includes("username") && (await user.count().catch(() => 0)) > 0) {
        await user.fill(values.username, { timeout: STEP_MS });
        filled.push("username");
      }
      await password.field.fill(values.password, { timeout: STEP_MS });
      filled.push("password");
      await submit(page, password.field);
      continue;
    }
    // A code goes into a code field; else, once the user name and password are in, into the page's one field (as logins/detect.ts codePrompt asks for it).
    const signInDone = (!values.username || filled.includes("username")) && (!values.password || filled.includes("password"));
    const code = (await firstVisible(page, CODE_FIELD)) ?? (values.code && !password && signInDone && !filled.includes("code") ? await onlyTypingField(page) : null);
    if (code && values.code && !filled.includes("code")) {
      const value = values.code();
      if (!value) break;
      await code.field.fill(value, { timeout: STEP_MS });
      filled.push("code");
      await submit(page, code.field);
      continue;
    }
    const user = password ? null : await firstVisible(page, USERNAME_FIELD);
    if (user && values.username && !filled.includes("username")) {
      await user.field.fill(values.username, { timeout: STEP_MS });
      filled.push("username");
      await submit(page, user.field);
      continue;
    }
    break;
  }
  return { filled };
}

export { urlMatches };

/**
 * Whether the tab is signed in to `origin`, asked now (I'm done, a check from the chat): the declared
 * condition when there is one; else the tab is on that site with no password or code field, and no
 * user name field on a sign-in address. A page that is a human check is never signed in. For a human
 * check (`purpose`), whether its challenge is gone.
 */
export async function signedInCheck(page: Page, origin: string, condition?: SignedInCondition | null, purpose: LoginPurpose = "sign_in"): Promise<{ ok: boolean; reason: string; challenge: string | null }> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  const probe = playwrightProbe(page, page.context());
  const signs = await probe.signs();
  const judged = judge(signs, { origin, purpose, condition, selectorVisible: condition?.selector ? await probe.visible(condition.selector) : null });
  return { ok: judged.ok, reason: judged.reason, challenge: judged.challenge };
}

/** What a page shows before a fill, to tell whether the fill changed anything: its address (without the fragment) and its sign-in fields. */
export async function formState(page: Page): Promise<{ url: string; fields: FieldCount }> {
  return { url: page.url().split("#")[0]!, fields: await loginFields(page).catch(() => ({ passwords: 0, newPasswords: 0, usernames: 0, codes: 0, others: 0 })) };
}

/** Whether the page moved on after a fill: another address, or fewer sign-in fields. */
export function formChanged(before: { url: string; fields: FieldCount }, after: { url: string; fields: FieldCount }): boolean {
  if (before.url !== after.url) return true;
  return after.fields.passwords < before.fields.passwords || after.fields.codes !== before.fields.codes || after.fields.usernames < before.fields.usernames;
}
