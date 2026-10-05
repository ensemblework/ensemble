/**
 * Screenshots of the series axis chips in the narrow plot settings panel, with
 * 2 and 4 series and a long series name, in light and dark. Fails if a chip is
 * clipped by the panel or the row scrolls sideways.
 *
 * Run: node apps/hub-web/e2e/plots-axis-chips-wrap.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OUT = process.env.PLOT_SHOTS ?? "docs/screenshots/plots-axis-chips-wrap";
const LONG = "validation_accuracy_smoothed_over_five_seeds";

const rows = Array.from({ length: 20 }, (_, i) => {
  const step = i + 1;
  return [step, (2 / step).toFixed(3), (0.5 + i * 0.02).toFixed(3), (0.45 + i * 0.021).toFixed(3), (0.001 / step).toFixed(5)].join(",");
});
const CSV = `step,loss,accuracy,${LONG},learning_rate\n${rows.join("\n")}\n`;

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { cookie: `ensemble_session=${session}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text || "null") };
}

async function setSeries(page, names) {
  await page.getByRole("button", { name: "Y series", exact: true }).click();
  for (const option of await page.getByRole("option").all()) {
    const name = (await option.locator("[data-column-name]").innerText()).trim();
    const on = (await option.getAttribute("aria-selected")) === "true";
    if (on !== names.includes(name)) await option.click();
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

/** Every chip sits inside the row and the panel, and the row does not scroll. */
async function checkFit(page, count) {
  const fit = await page.locator("[data-series-axes]").evaluate((row) => {
    const panel = row.closest("aside")?.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const chips = [...row.querySelectorAll("[data-series-chip]")].map((chip) => {
      const rect = chip.getBoundingClientRect();
      const label = chip.querySelector("[title]");
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height, title: label?.getAttribute("title"), clipped: label ? label.scrollWidth > label.clientWidth : false };
    });
    return { box: { left: box.left, right: box.right }, panel: panel ? { left: panel.left, right: panel.right } : null, scroll: row.scrollWidth - row.clientWidth, chips, wrap: getComputedStyle(row).flexWrap };
  });
  assert.equal(fit.wrap, "wrap");
  assert.equal(fit.chips.length, count);
  assert.ok(fit.scroll <= 0, `row scrolls by ${fit.scroll}px`);
  for (const chip of fit.chips) {
    assert.ok(chip.left >= fit.box.left - 0.5 && chip.right <= fit.box.right + 0.5, `${chip.title} leaves the row`);
    if (fit.panel) assert.ok(chip.right <= fit.panel.right, `${chip.title} leaves the panel`);
    assert.equal(Math.round(chip.height), 24);
  }
  return fit;
}

async function theme(page, mode) {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), mode);
  await page.waitForTimeout(300);
}

async function shoot(page, name) {
  mkdirSync(OUT, { recursive: true });
  await page.locator("aside").filter({ has: page.locator("[data-series-axes]") }).screenshot({ path: `${OUT}/${name}.png` });
  await page.screenshot({ path: `${OUT}/${name}-page.png` });
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });
  try {
    const email = `chips-${Date.now().toString(36)}@ensemble.test`;
    const signup = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "plot-pass-1", name: "Analyst" }),
    });
    if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
    const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
    assert.equal((await authed(session, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }) })).status, 200);
    assert.equal((await authed(session, "/api/settings", { method: "PATCH", body: JSON.stringify({ appearance: { theme: "light" } }) })).status, 200);
    assert.equal((await authed(session, "/api/settings/modules", { method: "PUT", body: JSON.stringify({ id: "plots", on: true }) })).status, 200);
    const created = await authed(session, "/api/plots", { method: "POST", body: JSON.stringify({ title: "Training curve" }) });
    assert.equal(created.status, 201, created.text.slice(0, 300));

    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/plots/${created.json().plot.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-file]").setInputFiles({ name: "training.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
    await page.locator("[data-plot-chart]").waitFor({ timeout: 20000 });
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await page.getByRole("button", { name: "X axis", exact: true }).click();
    const step = page.getByRole("option", { name: /^step/ });
    if ((await step.getAttribute("aria-selected")) !== "true") await step.click();
    else await page.keyboard.press("Escape");

    await setSeries(page, ["loss", "accuracy"]);
    await page.getByRole("radiogroup", { name: "loss axis" }).getByRole("radio", { name: "Left" }).click();
    await page.getByRole("radiogroup", { name: "accuracy axis" }).getByRole("radio", { name: "Right" }).click();
    await checkFit(page, 2);
    await theme(page, "light");
    await shoot(page, "01-two-series-light");
    await theme(page, "dark");
    await shoot(page, "02-two-series-dark");

    await theme(page, "light");
    await setSeries(page, ["loss", "accuracy", LONG, "learning_rate"]);
    const fit = await checkFit(page, 4);
    const long = fit.chips.find((chip) => chip.title === LONG);
    assert.ok(long?.clipped, "the long name truncates with an ellipsis");
    assert.ok(new Set(fit.chips.map((chip) => Math.round(chip.top))).size > 1, "chips wrap onto a second line");
    await shoot(page, "03-four-series-long-name-light");
    await theme(page, "dark");
    await shoot(page, "04-four-series-long-name-dark");

    // Keyboard: arrow keys move the choice and focus within one chip.
    const group = page.getByRole("radiogroup", { name: "loss axis" });
    await group.getByRole("radio", { name: "Left" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await group.getByRole("radio", { name: "Right" }).getAttribute("aria-checked"), "true");
    assert.equal(await group.getByRole("radio", { name: "Right" }).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await group.getByRole("radio", { name: "Left" }).getAttribute("aria-checked"), "true");

    // The focus editor on the canvas, with its side panel at the narrowest width.
    await page.evaluate(() => localStorage.setItem("ensemble.plots.sidePanel", "280"));
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-canvas]").waitFor();
    await theme(page, "light");
    await page.locator("[data-plot-sample]").first().click();
    await page.locator("[data-plot-tile] canvas").first().waitFor({ timeout: 20000 });
    await page.locator("[data-plot-tile]").first().hover();
    await page.locator("[data-plot-tile]").first().getByRole("button", { name: "Open" }).click();
    const focus = page.locator("[data-plot-focus]");
    await focus.locator("[data-plot-encode]").waitFor();
    assert.equal(await focus.locator("[data-plot-panel]").getAttribute("data-panel-width"), "280");
    const trigger = focus.getByRole("button", { name: "Y series", exact: true });
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await page.getByRole("option").first().waitFor();
    const options = page.getByRole("option");
    let picked = 0;
    for (let index = 0; index < (await options.count()) && picked < 4; index += 1) {
      const option = options.nth(index);
      if (!/number/.test(await option.innerText()) || /^(step|seed)\b/.test(await option.innerText())) continue;
      if ((await option.getAttribute("aria-selected")) !== "true") await option.click();
      picked += 1;
    }
    await page.keyboard.press("Escape");
    await page.getByRole("option").first().waitFor({ state: "hidden" });
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("[data-plot-focus]").count(), 1);
    const xAxis = focus.getByRole("button", { name: "X axis", exact: true });
    await xAxis.click();
    assert.equal(await xAxis.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await xAxis.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("[data-plot-focus]").count(), 1);
    await focus.getByRole("tab", { name: "Style" }).click();
    const palette = focus.getByRole("button", { name: "Palette", exact: true });
    await palette.click();
    assert.equal(await palette.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await palette.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("[data-plot-focus]").count(), 1);
    await focus.getByRole("tab", { name: "Encode" }).click();
    console.log("focus chips:", await focus.locator("[data-series-chip]").allInnerTexts());
    await page.waitForTimeout(400);
    const chips = await focus.locator("[data-series-chip]").count();
    assert.ok(chips >= 2, `${chips} chips`);
    await checkFit(page, chips);
    await focus.locator("[data-plot-panel]").screenshot({ path: `${OUT}/05-focus-panel-280-light.png` });
    await theme(page, "dark");
    await focus.locator("[data-plot-panel]").screenshot({ path: `${OUT}/06-focus-panel-280-dark.png` });
    await page.screenshot({ path: `${OUT}/06-focus-panel-280-dark-page.png` });
    console.log(`axis chips wrap and fit the panel (focus editor: ${chips} series at 280px)`);
    await page.keyboard.press("Escape");
    await page.locator("[data-plot-focus]").waitFor({ state: "detached" });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
