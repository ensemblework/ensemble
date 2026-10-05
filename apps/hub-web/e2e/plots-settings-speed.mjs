/**
 * Settings scroll, plots encode on a log chart, export controls, and the code panel.
 * Matplotlib preview needs the agent runtime; a down runtime is recorded, not a hard fail,
 * except that the preview must leave the "Rendering…" state.
 *
 * Run: node apps/hub-web/e2e/plots-settings-speed.mjs
 * The runtime-down check stops only the runtime on AGENT_RUNTIME_PORT (default 5055) and restarts it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OUT = process.env.PLOT_SHOTS ?? "/opt/cursor/artifacts/plots";
// The runtime hub-api talks to. Only the process listening on this port is stopped for the
// runtime-down check, and it is started again afterwards.
const RUNTIME_PORT = Number(process.env.AGENT_RUNTIME_PORT ?? 5055);

function runtimePids(port) {
  const tries = [
    ["lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]],
    ["fuser", [`${port}/tcp`]],
  ];
  for (const [command, args] of tries) {
    try {
      const out = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const pids = out.split(/\s+/).map(Number).filter((pid) => pid > 0 && pid !== process.pid);
      if (pids.length) return pids;
    } catch {
      /* not installed, or nothing listening */
    }
  }
  return [];
}

async function startRuntime(port) {
  // The reloader can hold the socket for a moment after SIGTERM; wait for it, then force it.
  for (let attempt = 0; attempt < 40 && runtimePids(port).length; attempt += 1) {
    if (attempt === 20) for (const pid of runtimePids(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const script = fileURLToPath(new URL("../../../scripts/agent-dev.sh", import.meta.url));
  const log = openSync(join(tmpdir(), `ensemble-agent-runtime-${port}.log`), "a");
  spawn("bash", [script], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, AGENT_RUNTIME_PORT: String(port) } }).unref();
}

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
  mkdirSync("docs/screenshots/plots-settings-speed", { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.screenshot({ path: `docs/screenshots/plots-settings-speed/${name}.png` });
}

async function tabsFit(page) {
  return page.locator("[data-plot-tabs]").evaluate((row) => {
    const nodes = [...row.querySelectorAll("[role=tab], [data-plot-fullscreen], [data-plot-back], [data-plot-focus-title]")];
    const boxes = nodes.map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) if (hit(boxes[i], boxes[j])) return "overlap";
    }
    const rowBox = row.getBoundingClientRect();
    if (rowBox.height > 52) return "wrapped";
    const exportTab = [...row.querySelectorAll("[role=tab]")].find((node) => node.textContent === "Export");
    if (!exportTab) return "missing";
    const box = exportTab.getBoundingClientRect();
    if (exportTab.scrollWidth > exportTab.clientWidth + 1) return "clipped";
    if (box.right > rowBox.right + 1 || box.left < rowBox.left) return "clipped";
    return "ok";
  });
}

async function ink(page) {
  await page.locator("[data-plot-focus] canvas, [data-plot-focus] svg").first().waitFor({ timeout: 8000 });
  return page.locator("[data-plot-focus] [data-plot-chart]").evaluate((root) => {
    let best = 0;
    for (const node of root.querySelectorAll("canvas")) {
      const ctx = node.getContext("2d");
      if (!ctx) continue;
      const data = ctx.getImageData(0, 0, node.width, node.height).data;
      let count = 0;
      for (let index = 3; index < data.length; index += 32) if (data[index] > 12) count += 1;
      best = Math.max(best, count);
    }
    for (const node of root.querySelectorAll("svg")) best = Math.max(best, node.querySelectorAll("path, line, circle").length);
    return best;
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  await page.addInitScript(() => {
    localStorage.setItem("ensemble.appearance", JSON.stringify({
      theme: "light",
      textScale: 100,
      font: "system",
      motion: "expressive",
      reduceMotion: false,
      accent: "rose",
      accentCustom: null,
      accentAt: Date.now() + 10_000_000,
    }));
  });
  const notes = [];
  try {
    const email = `speed-${Date.now().toString(36)}@ensemble.test`;
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
    const appearance = await authed(session, "/api/settings", { method: "PATCH", body: JSON.stringify({ appearance: { theme: "light", accent: "rose", accentCustom: null } }) });
    assert.equal(appearance.status, 200, appearance.text);
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);

    await page.setViewportSize({ width: 1280, height: 640 });
    await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-settings-main]").waitFor();
    await page.locator("[data-settings-nav]").waitFor();
    await page.locator("#danger").waitFor({ timeout: 30000 });
    const scrolled = await page.evaluate(() => {
      const main = document.querySelector("[data-settings-main]");
      const nav = document.querySelector("[data-settings-nav]");
      const pageTop = document.scrollingElement?.scrollTop ?? 0;
      const danger = document.getElementById("danger");
      if (danger) main.scrollTop = danger.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      nav.scrollTop = nav.scrollHeight;
      return {
        pageTop,
        main: main.scrollTop,
        nav: nav.scrollTop,
        mainOverflow: getComputedStyle(main).overflowY,
        navOverflow: getComputedStyle(nav).overflowY,
      };
    });
    assert.equal(scrolled.pageTop, 0);
    assert.equal(scrolled.mainOverflow, "auto");
    assert.equal(scrolled.navOverflow, "auto");
    assert.ok(scrolled.main > 100, `main column did not scroll (${scrolled.main})`);
    assert.ok(scrolled.nav > 40, `nav did not scroll on its own (${scrolled.nav})`);
    await shot(page, "settings-columns");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("[data-settings-nav] a[href='#danger']").click();
    await page.waitForTimeout(200);
    const current = (await page.locator("[data-settings-nav] [aria-current=true]").innerText()).trim();
    assert.match(current, /Deleted/, `scroll spy highlighted "${current}"`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-feature-landing=plots]").waitFor({ timeout: 15000 });
    const enabled = await authed(session, "/api/settings/modules", { method: "PUT", body: JSON.stringify({ id: "plots", on: true }) });
    assert.equal(enabled.status, 200, enabled.text);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-sample]").first().click();
    await page.locator("[data-plot-tile=sample-scaling]").waitFor({ timeout: 20000 });
    await page.locator("[data-plot-tile=sample-box]").waitFor();
    await page.locator("[data-plot-chart]").nth(3).waitFor({ timeout: 20000 });
    const tiles = await page.locator("[data-plot-chart]").count();
    assert.ok(tiles >= 4, `expected sample charts, saw ${tiles}`);
    await shot(page, "plots-canvas");

    await page.locator("[data-plot-tile=sample-scaling]").dblclick();
    await page.locator("[data-plot-focus]").waitFor();
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await page.locator("[data-log-axes]").waitFor();
    assert.equal(await page.getByRole("tab", { name: "Lines", exact: true }).count(), 0);
    const origin = await page.locator("[data-log-axes]").boundingBox();
    assert.ok(origin);
    const before = await ink(page);
    assert.ok(before > 10, `chart was blank before toggles (${before})`);

    await page.getByRole("button", { name: "Y series", exact: true }).click();
    const menu = page.getByRole("listbox", { name: "Y series" });
    const checked = menu.locator("[data-checked=true]");
    await checked.first().scrollIntoViewIfNeeded();
    assert.ok(await checked.count() >= 1, "the selected series checkbox is unchecked");
    assert.match((await checked.first().innerText()), /loss/);
    const nameNode = menu.locator("[data-checked=true] [data-column-name]").first();
    await nameNode.scrollIntoViewIfNeeded();
    const nameFit = await nameNode.evaluate((node) => ({ text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1 }));
    assert.equal(nameFit.clipped, false, `column name clipped: ${nameFit.text}`);
    assert.equal(nameFit.text, "loss");
    assert.match(await page.getByRole("button", { name: "Y series", exact: true }).innerText(), /loss/);
    const menuBox = await page.locator("[data-popover]").boundingBox();
    assert.ok(menuBox);
    assert.ok(menuBox.x >= 4 && menuBox.x + menuBox.width <= 1280 - 4, `menu sits outside the viewport (${menuBox.x}, ${menuBox.width})`);
    await shot(page, "encode-multiselect");
    await page.keyboard.press("Escape");
    await page.locator("[data-popover]").waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await page.locator("[data-plot-focus]").count(), 1, "escape closed the editor");
    await page.getByRole("button", { name: "Y series", exact: true }).click();
    await menu.waitFor();
    const options = menu.locator("[role=option]");
    const count = await options.count();
    assert.ok(count > 2, "the column menu should list more than the current series");
    const extra = ["std", "method", "accuracy", "score", "seed", "split"];
    for (const name of extra) {
      const option = menu.getByRole("option", { name: new RegExp(`^${name}\\b`, "i") });
      if ((await option.count()) !== 1) continue;
      if ((await option.getAttribute("aria-selected")) === "true") continue;
      await option.click();
      await page.waitForTimeout(50);
      const drawn = await ink(page);
      assert.ok(drawn > 10, `chart went blank after enabling ${name} (${drawn})`);
      const box = await page.locator("[data-log-axes]").boundingBox();
      assert.ok(box);
      assert.ok(Math.abs(box.y - origin.y) < 8, `log-axis row moved from ${origin.y} to ${box.y}`);
    }
    await page.getByRole("button", { name: "Y series", exact: true }).click();
    const warning = ((await page.locator("[data-plot-encode] [data-plot-warning]").innerText()) ?? "").trim();
    assert.match(warning, /std/);
    assert.match(warning, /method/);
    assert.match(warning, /hidden|another table/);
    assert.doesNotMatch(warning, /step is on another table/);
    const clipped = await page.locator("[data-plot-encode] [data-plot-warning]").evaluate((node) => node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2);
    assert.equal(clipped, false, "the skip warning is clipped");
    assert.equal(await page.locator("[data-plot-focus] [data-plot-chart]").locator("xpath=..").locator("[data-plot-warning]").count(), 0);
    const chips = await page.getByRole("button", { name: "Y series", exact: true }).innerText();
    assert.match(chips, /\+\d+ more|std|method/);
    assert.doesNotMatch(chips, /accurac$/);
    assert.equal(await tabsFit(page), "ok");
    await shot(page, "encode-log-axes");

    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await page.locator("[data-grid-controls]").waitFor();
    await page.locator("[data-tick-controls]").waitFor();
    await page.getByRole("button", { name: "X ticks", exact: true }).click();
    await page.locator("[data-popover]").waitFor();
    await shot(page, "style-menu");
    await page.keyboard.press("Escape");
    await page.locator("[data-popover]").waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await page.locator("[data-plot-focus]").count(), 1);
    const tabsBox = await page.locator("[data-plot-tabs]").boundingBox();
    assert.ok(tabsBox && tabsBox.height < 52, `tab row wrapped (${tabsBox?.height})`);
    await page.locator("[data-grid-controls]").scrollIntoViewIfNeeded();
    await page.locator("[data-tick-controls]").scrollIntoViewIfNeeded();
    for (const label of ["Major X grid", "Major Y grid", "Minor X grid", "Minor Y grid"]) {
      const toggle = page.getByLabel(label);
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    }
    await page.getByLabel("Grid alpha", { exact: true }).fill("0.9");
    await page.getByLabel("Minor grid alpha", { exact: true }).fill("0.75");
    await page.waitForTimeout(150);
    const gridText = await page.locator("[data-grid-controls]").innerText();
    assert.match(gridText, /Major line/);
    assert.match(gridText, /Minor line/);
    assert.match(gridText, /X ticks/);
    assert.match(gridText, /Y ticks/);
    assert.match(gridText, /Mode/);
    assert.match(gridText, /Count/);
    assert.equal(await tabsFit(page), "ok");
    await shot(page, "grid-ticks");
    await page.getByLabel("Minor X grid").click();
    await page.getByRole("button", { name: "X ticks", exact: true }).click();
    await page.getByRole("option", { name: "Fixed step", exact: true }).click();
    await page.getByLabel("X tick step").fill("2");
    await page.getByRole("tab", { name: "Code", exact: true }).click();
    await page.locator("[data-plot-code] .cm-content").waitFor({ timeout: 15000 });
    const code = await page.locator("[data-plot-code] .cm-content").evaluate((node) => {
      const view = node.cmTile?.root?.view;
      return view?.state?.doc?.toString?.() ?? node.textContent ?? "";
    });
    assert.match(code, /grid\(which=/);
    assert.match(code, /MultipleLocator/);
    const wrapping = await page.locator("[data-plot-code] .cm-editor").evaluate((node) => node.classList.contains("cm-lineWrapping"));
    assert.equal(wrapping, false, "the code editor soft-wraps");
    await page.locator("[data-plot-fullscreen]").click();
    await page.getByRole("button", { name: "Exit full screen" }).waitFor();
    const full = await page.locator("[data-plot-panel]").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth + 1 && box.width > window.innerWidth * 0.6;
    });
    assert.equal(full, true, "the full-screen panel fills the editor without overflowing the viewport");
    const header = await page.evaluate(() => {
      const row = document.querySelector("[data-plot-tabs]");
      const back = row?.querySelector("[data-plot-back]");
      const title = row?.querySelector("[data-plot-focus-title]");
      const exit = row?.querySelector("[data-plot-fullscreen]");
      const tabs = [...(row?.querySelectorAll("[role=tab]") ?? [])];
      if (!row || !back || !title || !exit || tabs.length < 4) return "missing";
      const nodes = [back, title, ...tabs, exit];
      const boxes = nodes.map((node) => node.getBoundingClientRect());
      if (boxes.some((box) => box.width < 8 || box.height < 8)) return "hidden";
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) if (hit(boxes[i], boxes[j])) return `overlap ${nodes[i].textContent} ${nodes[j].textContent}`;
      }
      if (row.getBoundingClientRect().height > 52) return "wrapped";
      if (!/Exit full screen/.test(exit.textContent || "")) return "exit";
      const exitBox = exit.getBoundingClientRect();
      if (exitBox.right > window.innerWidth || exitBox.left < row.getBoundingClientRect().left) return "exit off-screen";
      if (document.elementFromPoint(exitBox.left + exitBox.width / 2, exitBox.top + exitBox.height / 2) !== exit && !exit.contains(document.elementFromPoint(exitBox.left + exitBox.width / 2, exitBox.top + exitBox.height / 2))) return "exit covered";
      return "ok";
    });
    assert.equal(header, "ok");
    await shot(page, "code-fullscreen");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-plot-fullscreen]").getAttribute("data-plot-fullscreen"), "0");
    assert.equal(await page.locator("[data-plot-focus]").count(), 1);
    const width = await page.locator("[data-plot-panel]").getAttribute("data-panel-width");
    const handle = page.locator("[data-plot-panel-resize]");
    const handleBox = await handle.boundingBox();
    assert.ok(handleBox);
    await page.mouse.move(handleBox.x + 2, handleBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 80, handleBox.y + 40);
    await page.mouse.up();
    const nextWidth = Number(await page.locator("[data-plot-panel]").getAttribute("data-panel-width"));
    assert.ok(nextWidth >= 280 && nextWidth <= 560, `panel width ${nextWidth} left the limits`);
    assert.notEqual(nextWidth, Number(width));
    await shot(page, "code-panel-resized");

    await page.getByRole("tab", { name: "Style", exact: true }).click();
    await page.getByRole("button", { name: "X ticks", exact: true }).click();
    await page.getByRole("option", { name: "Auto", exact: true }).click();
    await page.getByRole("tab", { name: "Export", exact: true }).click();
    await page.locator("[data-plot-export]").waitFor();
    assert.equal(await page.getByText("Publication export").count(), 0);
    const tileStarted = Date.now();
    const [tilePdf] = await Promise.all([
      page.waitForEvent("download", { timeout: 50000 }),
      page.locator("[data-plot-export]").getByRole("button", { name: "PDF", exact: true }).click(),
    ]);
    assert.ok(await tilePdf.path(), "scaling-law pdf");
    notes.push(`scaling law pdf in ${Date.now() - tileStarted}ms`);
    const [tileSvg] = await Promise.all([
      page.waitForEvent("download", { timeout: 50000 }),
      page.locator("[data-plot-export]").getByRole("button", { name: "SVG", exact: true }).click(),
    ]);
    const svgPath = await tileSvg.path();
    assert.ok(svgPath, "scaling-law svg");
    const svgText = readFileSync(svgPath, "utf8");
    assert.match(svgText, /<svg/i, `svg download was not markup: ${svgText.slice(0, 80)}`);
    mkdirSync(OUT, { recursive: true });
    mkdirSync("docs/screenshots/plots-settings-speed", { recursive: true });
    writeFileSync(`${OUT}/tile-export.svg`, svgText);
    writeFileSync("docs/screenshots/plots-settings-speed/tile-export.svg", svgText);
    const svgPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await svgPage.setContent(`<!doctype html><body style="margin:0;background:#fff">${svgText}</body>`);
    await shot(svgPage, "svg-download");
    await svgPage.close();

    await page.getByRole("button", { name: "Back" }).click();
    const scalingTile = page.locator("[data-plot-tile=sample-scaling]");
    await scalingTile.locator("[data-plot-warning]").waitFor();
    const hiddenLine = (await scalingTile.locator("[data-plot-warning]").innerText()).trim();
    assert.match(hiddenLine, /^\d+ series hidden$/);
    const warningPlace = await scalingTile.evaluate((tile) => {
      const warning = tile.querySelector("[data-plot-warning]");
      const chart = tile.querySelector("[data-plot-chart]");
      if (!warning || !chart) return "missing";
      const note = warning.getBoundingClientRect();
      const plot = chart.getBoundingClientRect();
      const hit = note.top < plot.bottom - 1 && plot.top < note.bottom - 1;
      if (hit) return "overlap";
      if (note.top + 1 < plot.bottom) return "above";
      return "ok";
    });
    assert.equal(warningPlace, "ok", "tile warnings overlap the chart");
    await page.locator("[data-clear-sample]").click();
    await page.locator("[data-plot-sample]").first().click();
    await page.locator("[data-plot-tile=sample-box]").waitFor({ timeout: 20000 });
    await page.locator("[data-plot-tile=sample-scaling] [data-plot-chart]").waitFor({ timeout: 20000 });
    assert.equal(await page.locator("[data-plot-tile=sample-scaling] [data-plot-warning]").count(), 0);
    const boxTile = page.locator("[data-plot-tile=sample-box]");
    await boxTile.waitFor();
    await boxTile.scrollIntoViewIfNeeded();
    await boxTile.locator("canvas, svg").first().waitFor();
    await page.waitForTimeout(200);
    await shot(page, "box-plot");

    const exportButton = page.locator("[data-export-figure]");
    if (await exportButton.count()) {
      await exportButton.click();
      await page.locator("[data-export-dialog]").waitFor({ timeout: 8000 }).catch(() => null);
    }
    if (await page.locator("[data-export-dialog]").count()) {
      const preview = page.locator("[data-export-preview]");
      await preview.waitFor();
      const started = Date.now();
      await page.waitForFunction(() => {
        const root = document.querySelector("[data-export-preview]");
        if (!root) return false;
        return Boolean(root.querySelector("img")) || /try again|not available|did not render|runtime/i.test(root.textContent || "");
      }, null, { timeout: 50000 });
      const elapsed = Date.now() - started;
      const text = await preview.innerText();
      const image = await preview.locator("img").count();
      if (image) notes.push(`export preview in ${elapsed}ms`);
      else notes.push(`export preview error in ${elapsed}ms: ${text.slice(0, 180)}`);
      assert.equal(/Rendering the preview/.test(text), false);
      assert.equal(await page.getByRole("button", { name: "ICML" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "NeurIPS" }).count(), 0);
      assert.equal(await page.getByText("Publication export").count(), 0);
      assert.equal(await page.getByRole("tab", { name: "Lines", exact: true }).count(), 0);
      assert.ok(image > 0, `preview did not render: ${text.slice(0, 180)}`);
      const band = await preview.evaluate((root) => {
        const img = root.querySelector("img");
        if (!img) return 999;
        return img.getBoundingClientRect().top - root.getBoundingClientRect().top;
      });
      assert.ok(band < 8, `preview has a ${band}px empty band`);
      await shot(page, "export-preview");
      const pdfStarted = Date.now();
      const [figurePdf] = await Promise.all([
        page.waitForEvent("download", { timeout: 50000 }),
        page.locator("[data-export-format=pdf]").click(),
      ]);
      assert.ok(await figurePdf.path(), "figure pdf");
      notes.push(`figure pdf in ${Date.now() - pdfStarted}ms`);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      const pids = runtimePids(RUNTIME_PORT);
      assert.ok(pids.length, `no process listening on agent runtime port ${RUNTIME_PORT}`);
      for (const pid of pids) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      }
      let down = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const health = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/health`);
          down = !health.ok;
        } catch {
          down = true;
        }
        if (down) break;
        await page.waitForTimeout(200);
      }
      assert.equal(down, true, "agent runtime stayed up");
      await page.locator("[data-export-figure]").click();
      await page.locator("[data-export-dialog]").waitFor();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor({ timeout: 20000 });
      const failure = await page.locator("[data-export-preview]").innerText();
      assert.match(failure, /not available|try again/i);
      assert.equal(await page.locator("[data-export-preview] img").count(), 0);
      await shot(page, "export-runtime-down");
      notes.push("runtime-down retry shown");
      await startRuntime(RUNTIME_PORT);
      let back = false;
      for (let attempt = 0; attempt < 60 && !back; attempt += 1) {
        await page.waitForTimeout(500);
        back = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/health`).then((r) => r.ok, () => false);
      }
      assert.equal(back, true, "agent runtime did not come back");
      notes.push("runtime restarted");
    }

    console.log(notes.join("\n") || "ok");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
