/**
 * Enter real rows through the inline forms and shoot Chambers, Exam, and Semester.
 * Run: node apps/hub-web/e2e/desk-live-shots.mjs
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = "/opt/cursor/artifacts/desk/live";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function signup(name, email) {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name }),
  });
  if (!response.ok) throw new Error(`signup ${response.status}: ${await response.text()}`);
  return cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
}

async function onboard(page, role, template) {
  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.locator(`[data-role=${role}]`).click();
  await page.locator(`[data-template=${template}]`).click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.waitForURL(/\/today/, { timeout: 20_000 });
  await page.locator("[data-desk]").waitFor();
}

async function add(page, kind, fields) {
  const opener = page.locator(`[data-desk-add="${kind}"]`).first();
  await opener.click();
  await page.locator(`[data-desk-form="${kind}"]`).waitFor();
  for (const [label, value, select] of fields) {
    const control = page.locator(`[data-desk-form="${kind}"]`).getByLabel(label);
    if (select) await control.selectOption(value);
    else await control.fill(value);
  }
  await page.locator(`[data-desk-form="${kind}"]`).getByRole("button", { name: "Save" }).click();
  await page.locator(`[data-desk-form="${kind}"]`).waitFor({ state: "detached" });
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const stamp = Date.now().toString(36);

  const chambers = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await chambers.addCookies([{ name: "ensemble_session", value: await signup("Counsel", `live-law-${stamp}@ensemble.test`), url: WEB }]);
  const law = await chambers.newPage();
  await onboard(law, "lawyer", "matter-desk");
  assert.equal(await law.locator("[data-desk]").getAttribute("data-desk"), "chambers");
  await add(law, "matter", [
    ["Matter", "Rao v Sunrise"],
    ["Order date", "2026-09-02"],
    ["Rule", "30d", true],
    ["Court", "NCDRC"],
  ]);
  await law.getByText("Rao v Sunrise").first().waitFor();
  await add(law, "hearing", [
    ["Matter", "Rao v Sunrise"],
    ["Date", "2026-10-05"],
    ["Court", "Court 32"],
  ]);
  await law.getByText("Court 32").first().waitFor();
  assert.equal(await law.locator("[data-sample]").count(), 0);
  await law.screenshot({ path: `${SHOTS}/chambers-1440.png` });
  await law.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await law.locator("[data-context-lens=chambers]").waitFor();
  await law.getByRole("tab", { name: "Matters" }).click();
  await law.locator("[data-lens-panel=matters]").waitFor();
  await law.getByText("Rao v Sunrise").first().waitFor();
  await law.screenshot({ path: `${SHOTS}/chambers-lens-1440.png` });
  await chambers.close();

  const exam = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await exam.addCookies([{ name: "ensemble_session", value: await signup("Aspirant", `live-exam-${stamp}@ensemble.test`), url: WEB }]);
  const paper = await exam.newPage();
  await onboard(paper, "student", "exam-week");
  assert.equal(await paper.locator("[data-desk]").getAttribute("data-desk"), "exam");
  await add(paper, "exam", [["Exam date", "2027-05-23"]]);
  await paper.locator('[data-widget=countdown][data-desk-tile="live"]').waitFor();
  await paper.locator('[data-widget=countdown]').getByText(/\d+d/).first().waitFor();
  await add(paper, "mock", [
    ["Score", "112"],
    ["Out of", "200"],
    ["Subject", "Polity"],
  ]);
  await paper.getByText("112").first().waitFor();
  await add(paper, "revision", [
    ["Topic", "Fundamental rights"],
    ["Subject", "Polity"],
  ]);
  await paper.getByText("Fundamental rights").first().waitFor();
  assert.equal(await paper.locator("[data-sample]").count(), 0);
  await paper.screenshot({ path: `${SHOTS}/exam-1440.png` });
  await paper.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await paper.getByRole("tab", { name: "Mocks" }).click();
  await paper.locator("[data-lens-panel=mocks]").waitFor();
  await paper.screenshot({ path: `${SHOTS}/exam-lens-1440.png` });
  await exam.close();

  const semester = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await semester.addCookies([{ name: "ensemble_session", value: await signup("Student", `live-sem-${stamp}@ensemble.test`), url: WEB }]);
  const term = await semester.newPage();
  await onboard(term, "student", "semester-desk");
  assert.equal(await term.locator("[data-desk]").getAttribute("data-desk"), "semester");
  await add(term, "slot", [
    ["Class", "Operating systems"],
    ["Day", "3", true],
    ["Start", "09:00"],
    ["End", "10:15"],
    ["Course", "OS"],
  ]);
  await term.getByText("Operating systems").first().waitFor();
  await add(term, "deadline", [
    ["Title", "CN assignment 2"],
    ["Date", "2026-10-06"],
  ]);
  await term.getByText("CN assignment 2").first().waitFor();
  assert.equal(await term.locator("[data-sample]").count(), 0);
  await term.screenshot({ path: `${SHOTS}/semester-1440.png` });
  await term.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await term.getByRole("tab", { name: "Courses" }).click();
  await term.locator("[data-lens-panel=courses]").waitFor();
  await term.screenshot({ path: `${SHOTS}/semester-lens-1440.png` });
  await semester.close();

  await browser.close();
  console.log("desk live shots ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
