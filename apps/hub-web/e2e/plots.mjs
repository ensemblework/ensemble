/**
 * Drop a CSV, build a dual-axis combo with a threshold, restyle it, and export.
 * Matplotlib PDF and custom code need the agent runtime. Those steps record a skip
 * when the runtime is down so the browser flow can still be checked.
 *
 * Run: node apps/hub-web/e2e/plots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OUT = process.env.PLOT_SHOTS ?? "/opt/cursor/artifacts/plots";

const CSV = "month,revenue,cost\nJan,12000,8000\nFeb,15000,9000\nMar,18000,11000\nApr,14000,10000\n";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text || "null") };
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function pick(page, label, option) {
  await page.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function setAxis(page, name, side) {
  const group = page.getByRole("radiogroup", { name: `${name} axis` });
  await group.getByRole("radio", { name: side === "right" ? "Right" : "Left" }).click();
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const notes = [];
  try {
    const email = `plots-${Date.now().toString(36)}@ensemble.test`;
    const signup = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "plot-pass-1", name: "Analyst" }),
    });
    if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
    const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
    const onboard = await authed(session, "/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
    });
    assert.equal(onboard.status, 200, onboard.text);

    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-feature-landing=plots]").waitFor();
    await shot(page, "01-landing-light");
    const enabled = await authed(session, "/api/settings/modules", { method: "PUT", body: JSON.stringify({ id: "plots", on: true }) });
    assert.equal(enabled.status, 200, enabled.text);
    assert.match(enabled.json().modules, /plots/);

    await page.reload({ waitUntil: "domcontentloaded" });
    // The canvas replaced the saved-plot list. A new plot still opens in the studio.
    const created = await authed(session, "/api/plots", {
      method: "POST",
      body: JSON.stringify({ title: "Sales" }),
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));
    await page.goto(`${WEB}/plots/${created.json().plot.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-drop]").waitFor();
    await shot(page, "02-drop-light");

    await page.locator("[data-plot-file]").setInputFiles({ name: "sales.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
    await page.locator("[data-plot-chart]").waitFor({ timeout: 20000 });
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await page.locator("[data-plot-preview]").waitFor();
    await shot(page, "03-preview-light");

    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await pick(page, "Chart type", "Combo");
    await page.getByRole("button", { name: "X axis", exact: true }).click();
    await page.getByRole("option", { name: "month" }).click();
    await page.getByRole("button", { name: "Y series", exact: true }).click();
    const cost = page.getByRole("option", { name: /cost/ });
    if ((await cost.getAttribute("aria-selected")) !== "true") await cost.click();
    await page.keyboard.press("Escape");
    await setAxis(page, "cost", "right");
    await page.locator("[data-plot-chart]").waitFor();
    await shot(page, "04-dual-axis-light");

    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Revenue and cost");
    await pick(page, "Palette", "Okabe–Ito");
    await shot(page, "05-style-light");

    await page.getByRole("tab", { name: "Code", exact: true }).click();
    await page.locator("[data-plot-code]").waitFor();
    await shot(page, "06-code-light");
    await page.getByRole("button", { name: "Run" }).click();
    await page.locator("[data-plot-figure]").waitFor({ timeout: 20000 });
    await page.locator("[data-plot-figure]").scrollIntoViewIfNeeded();
    const codeText = await page.locator("[data-plot-code]").innerText();
    if (/not available|failed|Traceback/i.test(codeText)) notes.push(`custom code: ${codeText.slice(0, 240)}`);
    else notes.push("custom code ran");
    await shot(page, "07-code-result-light");
    await shot(page, "17-code-split");

    await page.getByRole("tab", { name: "Export", exact: true }).click();
    await page.locator("[data-plot-export]").waitFor();
    await shot(page, "08-export-light");

    const download = async (name) => {
      const [file] = await Promise.all([
        page.waitForEvent("download", { timeout: 20000 }),
        page.getByRole("button", { name, exact: true }).click(),
      ]);
      const path = await file.path();
      assert.ok(path, name);
      notes.push(`${name} downloaded`);
    };
    await download("PNG 1×");
    await download("SVG");
    await download("CSV");

    const pdf = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);
    await page.getByRole("button", { name: "Matplotlib PDF" }).click();
    const pdfFile = await pdf;
    if (pdfFile) notes.push("matplotlib pdf downloaded");
    else notes.push("matplotlib pdf skipped or failed (runtime may be down)");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
    await shot(page, "09-export-dark");

    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await page.locator("[data-grid-controls]").waitFor();
    assert.equal(await page.getByRole("tab", { name: "Lines", exact: true }).count(), 0);
    await shot(page, "10-grid-light");

    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await page.locator("[data-plot-preview]").waitFor();
    await pick(page, "revenue type", "Category");
    await shot(page, "11-types-light");
    await pick(page, "revenue type", "Number");

    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await pick(page, "Chart type", "Grouped bar");
    await page.getByRole("button", { name: "Y series", exact: true }).click();
    await page.keyboard.press("Escape");
    await setAxis(page, "cost", "left");
    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await pick(page, "Palette", "Okabe–Ito");
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, "12-grouped-light");
    await pick(page, "Chart type", "Stacked bar");
    await page.waitForTimeout(400);
    await shot(page, "13-stacked-light");
    await pick(page, "Chart type", "Pie");
    await page.getByRole("radio", { name: "Both" }).click();
    await page.waitForTimeout(400);
    await shot(page, "14-pie-light");

    const rose = await authed(session, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appearance: { theme: "dark", accent: "rose", accentCustom: null } }),
    });
    assert.equal(rose.status, 200, rose.text.slice(0, 200));
    await page.evaluate(() => {
      localStorage.setItem(
        "ensemble.appearance",
        JSON.stringify({ theme: "dark", textScale: 100, font: "system", motion: "expressive", reduceMotion: false, accent: "rose", accentCustom: null, accentAt: Date.now() }),
      );
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-chart]").waitFor({ timeout: 20000 });
    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await pick(page, "Palette", "Accent");
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await pick(page, "Chart type", "Combo");
    await page.getByRole("button", { name: "Y series", exact: true }).click();
    await page.keyboard.press("Escape");
    await setAxis(page, "cost", "right");
    await page.locator("[data-plot-chart]").waitFor();
    await page.waitForTimeout(500);
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    notes.push(`accent ${accent}`);
    await shot(page, "15-dark-rose");

    const rows = ["t,signal"];
    for (let i = 0; i < 100_000; i += 1) rows.push(`${i},${Math.sin(i / 40).toFixed(5)}`);
    const uploaded = await authed(session, "/api/plots/datasets", {
      method: "POST",
      body: JSON.stringify({ name: "signal", filename: "signal.csv", text: rows.join("\n") }),
    });
    assert.equal(uploaded.status, 201, uploaded.text.slice(0, 300));
    const big = await authed(session, "/api/plots", {
      method: "POST",
      body: JSON.stringify({
        title: "100k signal",
        datasetId: uploaded.json().dataset.id,
        config: {
          chart: "line",
          x: "t",
          series: [{ y: "signal", axis: "left" }],
          palette: "okabe-ito",
          title: "100k signal",
          yTitleLeft: "signal",
          xTitle: "t",
        },
      }),
    });
    assert.equal(big.status, 201, big.text.slice(0, 300));
    await authed(session, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appearance: { theme: "light", accent: "indigo", accentCustom: null } }),
    });
    await page.evaluate(() => {
      localStorage.setItem(
        "ensemble.appearance",
        JSON.stringify({ theme: "light", textScale: 100, font: "system", motion: "expressive", reduceMotion: false, accent: "indigo", accentCustom: null, accentAt: Date.now() }),
      );
    });
    await page.goto(`${WEB}/plots/${big.json().plot.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-chart] canvas").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => Boolean(document.querySelector("[data-plot-chart]") && document.querySelector("[data-plot-chart]").__plotChart));
    const canvas = await page.locator("[data-plot-chart] canvas").boundingBox();
    if (canvas) {
      await page.mouse.move(canvas.x + canvas.width * 0.42, canvas.y + canvas.height * 0.45);
      for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -160);
    }
    await page.evaluate(() => {
      const chart = document.querySelector("[data-plot-chart]").__plotChart;
      chart?.dispatchAction({ type: "dataZoom", start: 40, end: 43 });
    });
    await page.waitForTimeout(500);
    await shot(page, "16-zoom-100k");
    notes.push("100k zoom shot");

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/notes.txt`, notes.join("\n"));
    console.log(notes.join("\n"));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
