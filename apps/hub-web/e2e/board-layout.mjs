/**
 * Board columns scroll on their own row, under an opaque toolbar, and a small
 * vertical drag does not fling the page between top and bottom.
 * Run: node apps/hub-web/e2e/board-layout.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const WIDTHS = [1024, 1280, 1440];

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
  if (!response.ok) throw new Error(`${path} ${response.status} ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

async function layout(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector(".board-chrome");
    const scroller = document.querySelector("[data-board-hscroll]");
    const column = document.querySelector("[data-column='todo'] .board-column");
    if (!chrome || !scroller || !column) return null;
    const chromeBox = chrome.getBoundingClientRect();
    const scrollBox = scroller.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    const style = getComputedStyle(chrome);
    return {
      chromeBottom: chromeBox.bottom,
      scrollTop: scrollBox.top,
      scrollLeft: scrollBox.left,
      chromeLeft: chromeBox.left,
      columnTop: columnBox.top,
      columnHeight: columnBox.height,
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      overflowX: getComputedStyle(scroller).overflowX,
      overflowY: getComputedStyle(scroller).overflowY,
      chromeBg: style.backgroundColor,
    };
  });
}

async function main() {
  const email = `board-layout-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "board-layout-pass-1", name: "Board" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  await authed(session, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }) });
  for (let index = 0; index < 6; index += 1) {
    await authed(session, "/api/tasks", { method: "POST", body: JSON.stringify({ title: `Layout card ${index + 1}`, status: "todo" }) });
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-column=todo] [data-bdg-card]").first().waitFor();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const box = await layout(page);
      assert.ok(box, `missing board at ${width}`);
      assert.ok(box.scrollTop >= box.chromeBottom - 1, `${width} columns overlap the toolbar ${JSON.stringify(box)}`);
      assert.ok(box.columnTop >= box.chromeBottom - 1, `${width} column paints through the toolbar ${JSON.stringify(box)}`);
      assert.equal(box.overflowX, "auto", `${width} overflow-x ${box.overflowX}`);
      assert.equal(box.overflowY, "hidden", `${width} overflow-y ${box.overflowY}`);
      assert.ok(box.scrollWidth > box.clientWidth, `${width} columns do not scroll inside the row ${JSON.stringify(box)}`);
      assert.notEqual(box.chromeBg, "rgba(0, 0, 0, 0)", `${width} toolbar is transparent`);
      const before = box.chromeLeft;
      await page.locator("[data-board-hscroll]").evaluate((node) => {
        node.scrollLeft = 180;
      });
      const after = await layout(page);
      assert.ok(Math.abs(after.chromeLeft - before) < 2, `${width} toolbar moved with the columns`);
      assert.ok(after.scrollTop >= after.chromeBottom - 1, `${width} scrolled columns overlap the toolbar`);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    const card = page.locator("[data-bdg-card]").filter({ hasText: "Layout card 1" }).first();
    await card.waitFor();
    const start = await card.boundingBox();
    assert.ok(start);
    const mainScroll = () => page.locator("main").evaluate((node) => node.scrollTop);
    const before = await mainScroll();
    await page.mouse.move(start.x + 24, start.y + 16);
    await page.mouse.down();
    await page.mouse.move(start.x + 24, start.y - 28, { steps: 8 });
    await page.waitForTimeout(120);
    const mid = await mainScroll();
    await page.mouse.move(start.x + 24, start.y + 36, { steps: 8 });
    await page.waitForTimeout(120);
    const after = await mainScroll();
    await page.mouse.up();
    assert.ok(Math.abs(mid - before) < 48, `mouse drag scrolled the page ${before} -> ${mid}`);
    assert.ok(Math.abs(after - before) < 48, `mouse drag ended scrolled ${before} -> ${after}`);

    const touch = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, colorScheme: "dark" });
    await touch.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    const touchPage = await touch.newPage();
    await touchPage.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
    const touchCard = touchPage.locator("[data-bdg-card]").filter({ hasText: "Layout card 2" }).first();
    await touchCard.waitFor();
    const touchBox = await touchCard.boundingBox();
    assert.ok(touchBox);
    const touchBefore = await touchPage.locator("main").evaluate((node) => node.scrollTop);
    const client = await touchPage.context().newCDPSession(touchPage);
    const finger = { x: touchBox.x + 20, y: touchBox.y + 16 };
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: finger.x, y: finger.y }] });
    await touchPage.waitForTimeout(420);
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: finger.x, y: finger.y - 30 }] });
    await touchPage.waitForTimeout(150);
    const touchMid = await touchPage.locator("main").evaluate((node) => node.scrollTop);
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: finger.x, y: finger.y + 24 }] });
    await touchPage.waitForTimeout(150);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const touchAfter = await touchPage.locator("main").evaluate((node) => node.scrollTop);
    assert.ok(Math.abs(touchMid - touchBefore) < 48, `touch drag scrolled the page ${touchBefore} -> ${touchMid}`);
    assert.ok(Math.abs(touchAfter - touchBefore) < 48, `touch drag ended scrolled ${touchBefore} -> ${touchAfter}`);
    await touch.close();
    console.log("board layout ok");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
