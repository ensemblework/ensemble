/**
 * Spot-check desks, the enable landing, the tour, and light/phone layouts.
 * Run: CHROME_PATH=/usr/local/bin/google-chrome node /tmp/step2-shots.mjs
 */
import assert from "node:assert/strict";
import { execSqlChanging } from "./sql-change.mjs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = "/opt/cursor/artifacts/desk/step2";
const stamp = Date.now().toString(36);

const DESKS = [
  ["student", "semester-desk", "semester"],
  ["student", "exam-week", "exam"],
  ["student", "reading-pile", "literature"],
  ["lawyer", "matter-desk", "chambers"],
  ["teacher", "weeks-lessons", "classes"],
  ["manager", "staff-week", "staff"],
  ["engineer", "branch-desk", "branch"],
  ["vibe", "one-idea", "bench"],
];

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

async function api(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

async function settled(page) {
  await page.waitForFunction(() => /@ensemble\.test/.test(document.body.innerText), null, { timeout: 20_000 });
}

/** A fresh desk must paint real tiles, not an empty bento under the sample banner. */
async function assertGhostTiles(page, desk, min = 4) {
  await page.locator(`[data-desk=${desk}] >> visible=true`).waitFor();
  await settled(page);
  await page.waitForFunction(
    (least) => {
      const tiles = [...document.querySelectorAll("[data-desk-tile]")];
      if (tiles.length < least) return false;
      return tiles.every((el) => {
        const box = el.getBoundingClientRect();
        return box.height >= 48 && box.width >= 48 && Number(getComputedStyle(el).opacity) > 0.9;
      });
    },
    min,
    { timeout: 20_000 },
  );
  const pad = await page.locator(`[data-desk=${desk}] >> visible=true`).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(pad >= 32, `${desk} padding ${pad}`);
  const count = await page.locator("[data-desk-tile]").count();
  assert.ok(count >= min, `${desk} rendered ${count} tiles`);
}

const LIVE_ROWS = {
  semester: [
    { kind: "slot", fields: { title: "Algorithms", weekday: "1", start: "09:00", end: "10:15", course: "CS" } },
    { kind: "task", fields: { title: "Problem set 3", day: "2026-10-08" } },
  ],
  exam: [
    { kind: "exam", fields: { day: "2026-11-12" } },
    { kind: "revision", fields: { title: "Thermodynamics", subject: "Physics" } },
    { kind: "deadline", fields: { title: "Admit card", day: "2026-11-01" } },
  ],
  literature: [
    { kind: "paper", fields: { title: "Attention is all you need", words: "2100", stage: "Reading" } },
    { kind: "citation", fields: { from: "Draft", to: "Vaswani 2017" } },
  ],
  chambers: [
    { kind: "matter", fields: { title: "Rao v Sunrise", orderDate: "2026-09-02", rule: "45d", court: "NCDRC" } },
    { kind: "hearing", fields: { title: "Rao hearing", day: "2026-10-06", court: "NCDRC" } },
    { kind: "time", fields: { title: "Rao advice", hours: "1.5" } },
  ],
  classes: [
    { kind: "slot", fields: { title: "Form 4 maths", weekday: "2", start: "09:00", end: "09:45", course: "Maths" } },
    { kind: "concept", fields: { title: "Place value", subject: "Left off at tens" } },
  ],
  staff: [
    { kind: "person", fields: { name: "Priya Shah", capacity: "32", cadence: "14" } },
    { kind: "objective", fields: { title: "Ship the weekly review", progress: "40" } },
  ],
  branch: [
    { kind: "review", fields: { title: "Session cookie" } },
    { kind: "deploy", fields: { name: "hub-web", env: "prod" } },
    { kind: "test", fields: { name: "desk tiles", status: "pass" } },
  ],
  bench: [
    { kind: "part", fields: { name: "M3 screw", qty: "12", status: "out" } },
    { kind: "hold", fields: { title: "Front panel", day: "2026-10-04" } },
    { kind: "test", fields: { name: "Fit check", status: "fail" } },
  ],
};

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });

  for (const [role, template, desk] of DESKS) {
    const session = await signup(role, `${desk}-${stamp}@ensemble.test`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    const page = await context.newPage();
    await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
    await page.locator(`[data-role=${role}]`).click();
    await page.locator(`[data-template=${template}]`).click();
    await page.getByRole("button", { name: "Use this template" }).click();
    await page.waitForURL(/\/today/, { timeout: 20_000 });
    await assertGhostTiles(page, desk);
    await page.screenshot({ path: `${SHOTS}/today-${desk}.png` });
    for (const row of LIVE_ROWS[desk]) {
      const saved = await api(session, "/api/desk/entries", { method: "POST", body: JSON.stringify(row) });
      assert.equal(saved.status, 201, `${desk} ${row.kind} ${JSON.stringify(saved.body)}`);
    }
    await page.reload({ waitUntil: "networkidle" });
    await assertGhostTiles(page, desk);
    await page.locator('[data-desk-tile="live"]').first().waitFor();
    const liveCount = await page.locator('[data-desk-tile="live"]').count();
    assert.ok(liveCount >= 1, `${desk} live tiles ${liveCount}`);
    const adds = await page.locator('[data-desk-tile="live"] [data-desk-add]').allTextContents();
    assert.ok(adds.length >= 1, `${desk} live add actions`);
    assert.ok(adds.every((label) => !/first/i.test(label) && label.startsWith("+ Add")), `${desk} add labels ${adds.join(" | ")}`);
    const hero = page.locator("[data-live-hero] [data-hero-draw]");
    await hero.first().waitFor();
    const heroBox = await hero.first().boundingBox();
    assert.ok(heroBox && heroBox.height >= 120, `${desk} hero height ${heroBox?.height}`);
    await page.screenshot({ path: `${SHOTS}/today-${desk}-live.png` });
    await context.close();
    console.log("today", desk, "ghost+live");
  }

  const session = await signup("Counsel", `flow-${stamp}@ensemble.test`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const page = await context.newPage();
  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.locator("[data-role=lawyer]").click();
  await page.locator("[data-template=matter-desk]").click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.waitForURL(/\/today/, { timeout: 20_000 });
  await settled(page);

  const ghost = page.locator(".ghost").first();
  await ghost.waitFor();
  await ghost.getByRole("button").first().click();
  await page.locator("[data-desk-form]").waitFor();
  await page.locator("[data-desk-form]").getByRole("button", { name: "Close" }).click();

  await page.locator('[data-desk-add="matter"]').first().click();
  const form = page.locator('[data-desk-form="matter"]');
  await form.waitFor();
  await form.getByLabel("Matter").fill("Rao v Sunrise");
  await form.getByLabel("Order date").fill("2026-09-02");
  await form.getByLabel("Rule").selectOption("45d");
  await form.getByLabel("Court").fill("NCDRC");
  await form.getByRole("button", { name: "Save" }).click();
  await form.waitFor({ state: "detached" });
  await page.getByText("Rao v Sunrise").first().waitFor();
  await page.locator("[data-live-band]").waitFor();
  const undo = page.getByRole("status").getByRole("button", { name: "Undo" });
  await undo.waitFor();
  await undo.click();
  await page.waitForTimeout(400);
  assert.equal(await page.getByText("Rao v Sunrise").count(), 0);
  console.log("ghost, add, undo, timeline ok");

  await page.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await page.locator("[data-context-lens=chambers]").waitFor();
  const contextPad = await page.locator("[data-context-lens=chambers]").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(contextPad >= 32, `context padding ${contextPad}`);
  await page.getByRole("tab", { name: "Matters" }).click();
  await page.locator("[data-lens-panel=matters]").waitFor();
  const addToday = page.getByRole("button", { name: "Add it on Today" }).first();
  await addToday.waitFor();
  await page.screenshot({ path: `${SHOTS}/lens-matters.png` });
  await addToday.click();
  await page.waitForURL(/\/today\?form=/);
  await page.locator("[data-desk-form]").waitFor();
  console.log("lens opens today form", page.url());

  for (const id of ["code", "workspace", "runs", "metrics", "diagrams"]) {
    if (id === "diagrams") {
      await page.goto(`${WEB}/settings#features`, { waitUntil: "networkidle" });
      await page.locator("[data-features]").getByRole("switch", { name: "Block diagrams" }).click();
      await page.locator("aside a[href='/diagrams']").waitFor({ state: "detached" });
    }
    await page.goto(`${WEB}/${id}`, { waitUntil: "networkidle" });
    await page.locator(`[data-feature-landing=${id}]`).waitFor();
    await page.locator(`[data-feature-preview=${id}]`).waitFor();
    await page.screenshot({ path: `${SHOTS}/disabled-${id}.png` });
    console.log("disabled", id);
  }
  await page.goto(`${WEB}/code`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Enable Code" }).click();
  await page.locator("[data-tour-step=intro]").waitFor();
  await page.screenshot({ path: `${SHOTS}/tour.png` });
  await page.getByRole("button", { name: "Show suggestions" }).click();
  await page.locator("[data-tour-step=repos]").waitFor();
  await page.getByRole("heading", { name: "Repos", exact: true }).waitFor();
  await page.screenshot({ path: `${SHOTS}/tour-place.png` });
  await page.getByRole("button", { name: "Not now" }).click();
  await page.locator("[data-feature-tour]").waitFor({ state: "detached" });
  await page.locator("aside a[href='/code']").waitFor();
  console.log("enable and tour place ok");

  await page.goto(`${WEB}/settings#features`, { waitUntil: "networkidle" });
  await page.locator("[data-features]").waitFor();
  await page.locator("[data-desk-extras]").waitFor();
  await page.screenshot({ path: `${SHOTS}/settings-features.png` });
  const learning = page.locator("[data-desk-extras]").getByRole("switch", { name: "Learning" });
  await learning.waitFor();
  await learning.click();
  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await settled(page);
  await page.getByText("What I'm learning").waitFor();
  console.log("learning extra on");

  await page.goto(`${WEB}/settings#features`, { waitUntil: "networkidle" });
  const codeSwitch = page.locator("[data-features]").getByRole("switch", { name: "Code" });
  await codeSwitch.click();
  await page.locator("aside a[href='/code']").waitFor({ state: "detached" });
  const reviews = await api(session, "/api/code/reviews");
  assert.equal(reviews.status, 404);
  console.log("code off hides the tab");

  await page.locator('button[title="Switch to light"]').click();
  await page.locator("html[data-theme=light]").waitFor();
  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await settled(page);
  await page.screenshot({ path: `${SHOTS}/today-light.png` });
  console.log("light theme ok");
  await context.close();

  const phoneSession = await signup("Phone", `phone-${stamp}@ensemble.test`);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await phone.addCookies([{ name: "ensemble_session", value: phoneSession, url: WEB }]);
  const narrow = await phone.newPage();
  await narrow.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await narrow.locator("[data-role=student]").click();
  await narrow.locator("[data-template=exam-week]").click();
  await narrow.getByRole("button", { name: "Use this template" }).click();
  await narrow.waitForURL(/\/today/, { timeout: 20_000 });
  await narrow.locator("[data-desk=exam] >> visible=true").waitFor();
  const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow < 8, `phone overflow ${overflow}`);
  await narrow.screenshot({ path: `${SHOTS}/today-phone.png` });
  console.log("phone ok");
  await phone.close();

  const legacySession = await signup("Legacy", `legacy-${stamp}@ensemble.test`);
  const onboarded = await api(legacySession, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  assert.equal(onboarded.status, 200);
  execSqlChanging(
    process.env.DATABASE_URL ?? "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble",
    `UPDATE users SET active_template_id = NULL WHERE email = 'legacy-${stamp}@ensemble.test';`,
    "clear active template",
  );
  const legacy = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await legacy.addCookies([{ name: "ensemble_session", value: legacySession, url: WEB }]);
  const old = await legacy.newPage();
  await old.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await old.locator("[data-widget]").first().waitFor({ timeout: 20_000 });
  assert.equal(await old.locator("[data-desk]").count(), 0);
  await old.screenshot({ path: `${SHOTS}/pre-branch-today.png` });
  console.log("pre-branch canvas ok");

  await browser.close();
  console.log("step2 shots ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
