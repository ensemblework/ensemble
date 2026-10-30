/**
 * Filling a sign-in page for its owner (B11): a saved login, or one they typed on the web sealed for
 * this computer. The broker's own code finds the fields and fills them with Playwright (user name,
 * then password, then a one-time code, a step at a time as the site asks), and presses Enter. The
 * values go from this process into the page and nowhere else: never to a model, a log, a trace or a
 * screenshot (the tab is sensitive the whole time). Then the signed-in check: the condition the work
 * declared (a URL pattern or a selector), or by default no sign-in field left on the site's own page.
 */
import type { Locator, Page } from "playwright-core";
import { CODE_FIELD, firstVisible, isSignInPath, loginFields, PASSWORD_FIELD, safeOrigin, USERNAME_FIELD } from "./detect.js";

export type LoginValues = { username?: string | null; password?: string | null; code?: (() => string | null) | null };
export type SignedInCondition = { urlPattern?: string; selector?: string };

const STEP_MS = 8_000;

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
    const code = await firstVisible(page, CODE_FIELD);
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

/**
 * A glob over a URL as `browser_wait` takes it: `**` any characters, `*` any but `/`; `/…/` is a
 * regular expression. A glob without `?` is matched without the query and fragment, so a sign-in page's
 * `?next=/dashboard` is not the dashboard.
 */
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

/**
 * Whether the tab is signed in to `origin`: the declared condition when there is one; else the tab is
 * on that site with no password or code field, and no user name field on a sign-in address.
 */
export async function signedInCheck(page: Page, origin: string, condition?: SignedInCondition | null): Promise<{ ok: boolean; reason: string }> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  const url = page.url();
  if (condition?.urlPattern) {
    const ok = urlMatches(condition.urlPattern, url);
    return { ok, reason: ok ? "" : "The tab is not on the signed-in page yet." };
  }
  if (condition?.selector) {
    const ok = await page.locator(condition.selector).first().isVisible().catch(() => false);
    return { ok, reason: ok ? "" : "The signed-in page is not showing yet." };
  }
  const here = safeOrigin(url);
  if (here !== origin) return { ok: false, reason: `The tab is on ${here ?? "another page"}, not ${origin}.` };
  const fields = await loginFields(page);
  if (fields.passwords > 0) return { ok: false, reason: "The sign-in form is still on the page." };
  if (fields.codes > 0 && isSignInPath(url)) return { ok: false, reason: "The site is asking for a one-time code." };
  if (fields.usernames > 0 && isSignInPath(url)) return { ok: false, reason: "The sign-in form is still on the page." };
  return { ok: true, reason: "" };
}
