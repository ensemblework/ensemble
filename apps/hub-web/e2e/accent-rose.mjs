/**
 * Rose replaces the default indigo accent on the main pages.
 * Run: node apps/hub-web/e2e/accent-rose.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const INDIGO = new Set(["rgb(124, 106, 247)", "rgb(83, 70, 214)", "rgb(157, 143, 255)", "rgb(145, 127, 248)"]);

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("no session");
  return pair[1];
}

const email = `rose-${Date.now().toString(36)}@ensemble.test`;
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "rose-pass-1", name: "Rose" }),
});
if (!signup.ok) throw new Error(await signup.text());
const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
const onboard = await fetch(`${API}/api/onboarding`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
  body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
});
if (!onboard.ok) throw new Error(await onboard.text());

function offenders(indigo) {
  const bad = [];
  const props = ["color", "backgroundColor", "borderTopColor", "outlineColor"];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest('[aria-label="Accent Indigo"]')) continue;
    const cs = getComputedStyle(el);
    for (const prop of props) {
      if (indigo.includes(cs[prop])) bad.push(`${el.tagName}.${String(el.className).slice(0, 60)} ${prop} ${cs[prop]}`);
    }
  }
  const probe = document.createElement("div");
  probe.className = "diagram-group";
  document.body.appendChild(probe);
  const border = getComputedStyle(probe).borderTopColor;
  probe.remove();
  if (indigo.includes(border)) bad.push(`diagram-group border ${border}`);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase();
  return { bad: bad.slice(0, 12), accent };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Accent Rose" }).click();
  await page.getByText("All settings saved").waitFor({ timeout: 8000 });
  await page.waitForFunction(() => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase();
    return accent && accent !== "#7c6af7" && accent !== "#5346d6";
  });
  const rose = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase()));
  for (const path of ["/today", "/board", "/diagrams", "/context", "/settings"]) {
    await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded" });
    await page.locator("aside.app-sidebar").filter({ visible: true }).waitFor();
    const result = await page.evaluate(offenders, [...INDIGO]);
    assert.equal(result.accent, rose, `${path} accent ${result.accent}`);
    assert.deepEqual(result.bad, [], `${path} ${result.bad.join(" | ")}`);
  }
  await page.getByRole("radio", { name: "Light" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const light = await page.evaluate(offenders, [...INDIGO]);
  assert.notEqual(light.accent, "#5346d6");
  assert.deepEqual(light.bad, [], light.bad.join(" | "));
  console.log("rose accent ok", { rose, light: light.accent });
} finally {
  await browser.close();
}
