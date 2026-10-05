/**
 * Workspace canvas with the sample tables: clipped tiles, ghost drag, solid dialogs,
 * the three upload states, the focus editor, and a multi-panel PDF.
 * Run: node apps/hub-web/e2e/plots-workspace.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OUT = process.env.PLOT_SHOTS ?? "/opt/cursor/artifacts/plots-workspace";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { cookie: `ensemble_session=${session}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text || "null") };
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

function overlaps(items) {
  return items.some((item, index) => items.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const col = Number(item.col);
    const row = Number(item.row);
    return col < Number(other.col) + Number(other.w) && col + Number(item.w) > Number(other.col)
      && row < Number(other.row) + Number(other.h) && row + Number(item.h) > Number(other.row);
  }));
}

function extraCsv() {
  const lines = ["step,loss,note"];
  for (let step = 1; step <= 700; step += 1) {
    lines.push(`${step},${(2.2 / step).toFixed(4)},padding-${step}-xxxxxxxx`);
  }
  return lines.join("\n");
}

function rasterPdf(pdfPath, pngPath) {
  if (existsSync("/usr/bin/pdftoppm")) {
    execFileSync("pdftoppm", ["-png", "-r", "140", "-f", "1", "-l", "1", pdfPath, pngPath.replace(/\.png$/, "")]);
    const produced = pngPath.replace(/\.png$/, "-1.png");
    if (existsSync(produced)) writeFileSync(pngPath, readFileSync(produced));
    return;
  }
  const code = `
import sys
path, out = sys.argv[1], sys.argv[2]
import pymupdf
doc = pymupdf.open(path)
page = doc[0]
pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
pix.save(out)
`;
  const pythons = ["/tmp/ensemble-py/bin/python", "python3"].filter((bin) => existsSync(bin) || bin === "python3");
  let last = null;
  for (const python of pythons) {
    try {
      execFileSync(python, ["-c", code, pdfPath, pngPath], { stdio: "inherit" });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, colorScheme: "light" });
  try {
    await page.addInitScript(() => {
      const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}");
      if (raw.accent === "rose" && (raw.theme === "light" || raw.theme === "dark")) return;
      localStorage.setItem("ensemble.appearance", JSON.stringify({
        ...raw,
        theme: "light",
        accent: "rose",
        accentAt: Date.now() + 10_000_000,
      }));
    });
    const email = `canvas-${Date.now().toString(36)}@ensemble.test`;
    const signup = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "plot-pass-1", name: "Analyst" }),
    });
    if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
    const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
    const onboard = await authed(session, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }) });
    assert.equal(onboard.status, 200, onboard.text);
    const appearance = await authed(session, "/api/settings", { method: "PATCH", body: JSON.stringify({ appearance: { theme: "light", accent: "rose", accentCustom: null } }) });
    assert.equal(appearance.status, 200, appearance.text);
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-feature-landing=plots]").waitFor();
    const enabled = await authed(session, "/api/settings/modules", { method: "PUT", body: JSON.stringify({ id: "plots", on: true }) });
    assert.equal(enabled.status, 200, enabled.text);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-canvas]").waitFor();
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
    assert.equal(accent, "#be185d", accent);
    assert.equal(await page.locator("[data-shared-columns]").count(), 0);
    assert.equal(await page.locator("[data-duplicate-links]").count(), 0);

    await page.locator("[data-plot-sample]").first().click();
    await page.locator("[data-sample-mark]").waitFor();
    await page.locator("[data-plot-tile]").nth(4).waitFor();
    await page.locator("[data-plot-tile] canvas").nth(4).waitFor({ timeout: 20000 });
    await page.waitForTimeout(700);
    const positions = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => ({
      col: node.getAttribute("data-col"),
      row: node.getAttribute("data-row"),
      w: node.getAttribute("data-w"),
      h: node.getAttribute("data-h"),
    })));
    assert.equal(positions.length, 5);
    assert.equal(overlaps(positions), false, JSON.stringify(positions));
    const clipped = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => {
      const tile = node.getBoundingClientRect();
      const canvas = node.querySelector("canvas");
      if (!canvas) return false;
      const box = canvas.getBoundingClientRect();
      return box.width > 40 && box.left >= tile.left - 1 && box.right <= tile.right + 1 && box.top >= tile.top - 1 && box.bottom <= tile.bottom + 1;
    }));
    assert.deepEqual(clipped, [true, true, true, true, true], JSON.stringify(clipped));
    await shot(page, "01-canvas");

    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}");
      raw.theme = "dark";
      raw.accent = "rose";
      raw.accentAt = Date.now() + 20_000_000;
      localStorage.setItem("ensemble.appearance", JSON.stringify(raw));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-tile]").nth(3).waitFor();
    await page.locator("[data-plot-tile] canvas").nth(3).waitFor({ timeout: 20000 });
    const darkPositions = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => ({
      col: node.getAttribute("data-col"),
      row: node.getAttribute("data-row"),
      w: node.getAttribute("data-w"),
      h: node.getAttribute("data-h"),
    })));
    assert.deepEqual(darkPositions, positions);
    const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
    assert.equal(dark, "#f0a0b8", dark);
    await page.waitForTimeout(500);
    await shot(page, "10-canvas-dark");
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}");
      raw.theme = "light";
      raw.accent = "rose";
      raw.accentAt = Date.now() + 30_000_000;
      localStorage.setItem("ensemble.appearance", JSON.stringify(raw));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-tile] canvas").nth(3).waitFor({ timeout: 20000 });

    const tile = page.locator("[data-plot-tile]").first();
    const header = await tile.locator("header").boundingBox();
    assert.ok(header);
    await page.mouse.move(header.x + 28, header.y + 8);
    await page.mouse.down();
    await page.mouse.move(header.x + 460, header.y + 30, { steps: 10 });
    await page.locator("[data-tile-ghost]").waitFor();
    const mid = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const visualOverlap = mid.some((item, index) => mid.some((other, otherIndex) => index !== otherIndex && (
      item.x < other.x + other.width - 2 && item.x + item.width > other.x + 2 && item.y < other.y + other.height - 2 && item.y + item.height > other.y + 2
    )));
    assert.equal(visualOverlap, false, JSON.stringify(mid));
    await shot(page, "02-drag-ghost");
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => ({
      col: node.getAttribute("data-col"),
      row: node.getAttribute("data-row"),
      w: node.getAttribute("data-w"),
      h: node.getAttribute("data-h"),
    })));
    assert.equal(overlaps(moved), false, JSON.stringify(moved));

    await page.waitForTimeout(600);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-tile]").nth(3).waitFor();
    const persisted = await page.locator("[data-plot-tile]").evaluateAll((nodes) => nodes.map((node) => ({
      col: node.getAttribute("data-col"),
      row: node.getAttribute("data-row"),
      w: node.getAttribute("data-w"),
      h: node.getAttribute("data-h"),
    })));
    assert.deepEqual(persisted, moved);

    await page.getByRole("button", { name: "Add tile" }).click();
    await page.locator("[data-gallery]").waitFor();
    await page.getByRole("heading", { name: "Add tile" }).waitFor();
    const panelOpacity = await page.locator(".plot-dialog-panel").evaluate((node) => getComputedStyle(node).opacity);
    assert.equal(panelOpacity, "1");
    await shot(page, "03-gallery");
    await page.locator(".plot-dialog-panel").getByRole("button", { name: "Close" }).click();
    await page.locator("[data-gallery]").waitFor({ state: "hidden" });

    await page.locator("[data-plot-upload]").click();
    await page.locator("[data-upload-start]").waitFor();
    await page.getByRole("heading", { name: "Add data" }).waitFor();
    await shot(page, "04-upload-start");
    const progress = page.waitForFunction(() => {
      const node = document.querySelector("[data-upload-percent]");
      if (!node) return false;
      const value = Number(node.getAttribute("data-upload-percent"));
      return value >= 40 && value <= 60;
    }, null, { timeout: 15000 });
    await page.locator("[data-plot-file]").setInputFiles({
      name: "extra-loss.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(extraCsv()),
    });
    await progress;
    await shot(page, "05-upload-progress");
    await page.locator("[data-column-summary]").waitFor({ timeout: 20000 });
    await page.locator("[data-duplicate-links]").waitFor();
    await page.getByText("extra-loss").waitFor();
    await page.getByLabel("loss type").waitFor();
    await shot(page, "06-upload-summary");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.locator("[data-column-summary]").waitFor({ state: "hidden" });
    await page.locator(".plot-dialog-panel").getByRole("button", { name: "Close" }).click();
    await page.locator("[data-upload-start]").waitFor({ state: "hidden" });

    await page.locator("[data-plot-tile]").first().hover();
    await page.locator("[data-plot-tile]").first().getByRole("button", { name: "Open" }).click();
    const focus = page.locator("[data-plot-focus]");
    await focus.waitFor();
    await focus.locator("[data-plot-encode]").waitFor();
    await focus.getByRole("tab", { name: "Style", exact: true }).click();
    await focus.locator("[data-grid-controls]").waitFor();
    assert.equal(await focus.getByRole("tab", { name: "Lines", exact: true }).count(), 0);
    await focus.getByRole("tab", { name: "Code", exact: true }).click();
    await focus.locator("[data-plot-code]").waitFor();
    await focus.getByRole("tab", { name: "Export", exact: true }).click();
    await focus.locator("[data-plot-export]").waitFor();
    await focus.getByRole("tab", { name: "Encode", exact: true }).click();
    await focus.locator("[data-plot-encode]").waitFor();
    await page.waitForTimeout(400);
    await shot(page, "07-focus");
    await page.locator("[data-plot-focus]").getByRole("button", { name: "Back" }).click();
    await page.locator("[data-plot-focus]").waitFor({ state: "hidden" });

    await page.locator("[data-export-figure]").click();
    await page.locator("[data-export-dialog]").waitFor();
    await page.locator("[data-export-preview] img").waitFor({ timeout: 45000 });
    await page.getByLabel("Figure width inches").waitFor();
    assert.equal(await page.getByRole("button", { name: "ICML" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "NeurIPS" }).count(), 0);
    assert.equal(await page.getByText("Publication export").count(), 0);
    await shot(page, "08-export-dialog");
    const download = page.waitForEvent("download", { timeout: 30000 });
    await page.locator("[data-export-format=pdf]").click();
    const file = await download;
    mkdirSync(OUT, { recursive: true });
    const pdfPath = `${OUT}/figure.pdf`;
    await file.saveAs(pdfPath);
    const pdf = readFileSync(pdfPath);
    assert.ok(pdf.length > 2000, `pdf too small: ${pdf.length}`);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    rasterPdf(pdfPath, `${OUT}/09-export-pdf.png`);
    assert.ok(existsSync(`${OUT}/09-export-pdf.png`));

    await page.locator(".plot-dialog-panel").getByRole("button", { name: "Close" }).click();
    console.log("workspace e2e ok", JSON.stringify(persisted));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
