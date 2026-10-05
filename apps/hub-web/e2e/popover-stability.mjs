/**
 * The limitation-date form must keep a stable screen rect while the pointer
 * moves inside it. A hover rule that rewrites `transform` used to slide the
 * panel by about half its width, then drop hover and slide back.
 *
 * Run: node apps/hub-web/e2e/popover-stability.mjs
 * WebKit: POPOVER_BROWSER=webkit node apps/hub-web/e2e/popover-stability.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const OUT = process.env.POPOVER_ARTIFACTS ?? "/opt/cursor/artifacts/popover-stability";
const SAMPLE_MS = 2000;
const JITTER_PX = 2;
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

const VIEWPORTS = [
  { width: 1440, height: 900, name: "1440x900" },
  { width: 1280, height: 720, name: "1280x720" },
  { width: 1024, height: 640, name: "1024x640" },
  { width: 390, height: 844, name: "390x844" },
];

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
  return { status: response.status, text, json: () => JSON.parse(text) };
}

function span(values) {
  return Math.max(...values) - Math.min(...values);
}

async function settle(page) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
}

async function sample(page, ms = SAMPLE_MS) {
  return page.evaluate(async (duration) => {
    const node = document.querySelector("[data-desk-form]");
    if (!node) return { error: "missing form" };
    const samples = [];
    const start = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        const rect = node.getBoundingClientRect();
        const save = node.querySelector('button[type="submit"]')?.getBoundingClientRect() ?? null;
        samples.push({
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          saveTop: save?.top ?? null,
          saveBottom: save?.bottom ?? null,
          saveLeft: save?.left ?? null,
          saveRight: save?.right ?? null,
        });
        if (now - start < duration) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    const xs = samples.map((row) => row.x);
    const ys = samples.map((row) => row.y);
    const ws = samples.map((row) => row.w);
    const hs = samples.map((row) => row.h);
    const last = samples[samples.length - 1];
    const off = samples.filter((row) => {
      const pad = 1;
      return row.x < -pad || row.y < -pad || row.x + row.w > window.innerWidth + pad || row.y + row.h > window.innerHeight + pad;
    }).length;
    const saveOff = samples.filter((row) => {
      if (row.saveTop == null) return true;
      const pad = 1;
      return row.saveLeft < -pad || row.saveTop < -pad || row.saveRight > window.innerWidth + pad || row.saveBottom > window.innerHeight + pad;
    }).length;
    return {
      frames: samples.length,
      jitterX: Math.max(...xs) - Math.min(...xs),
      jitterY: Math.max(...ys) - Math.min(...ys),
      jitterW: Math.max(...ws) - Math.min(...ws),
      jitterH: Math.max(...hs) - Math.min(...hs),
      x: last.x,
      y: last.y,
      w: last.w,
      h: last.h,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      offFrames: off,
      saveOffFrames: saveOff,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, ms);
}

function jitterOf(reading) {
  return Math.max(reading.jitterX, reading.jitterY, reading.jitterW, reading.jitterH);
}

async function box(page) {
  return page.locator("[data-desk-form]").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
}

async function openForm(page) {
  await page.goto(`${WEB}/today?form=limitation`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-desk=chambers] >> visible=true").waitFor({ timeout: 20_000 });
  await page.locator('[data-desk-form="matter"]').waitFor();
  await page.locator('[data-desk-form="matter"] button[type="submit"]').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const engine = process.env.POPOVER_BROWSER === "webkit" ? "webkit" : "chromium";
  const browser =
    engine === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const email = `pop-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name: "Counsel" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);

  const report = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "dark",
      recordVideo: viewport.name === "1440x900" ? { dir: OUT, size: { width: viewport.width, height: viewport.height } } : undefined,
    });
    await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    const page = await context.newPage();
    await openForm(page);
    await settle(page);
    const resting = await box(page);
    await page.screenshot({ path: `${OUT}/${viewport.name}-rest.png` });

    async function runScenario(name, gesture) {
      await settle(page);
      const origin = await box(page);
      const pending = sample(page);
      await gesture(origin);
      const reading = await pending;
      const driftX = Math.max(Math.abs(reading.minX - origin.x), Math.abs(reading.maxX - origin.x));
      const driftY = Math.max(Math.abs(reading.minY - origin.y), Math.abs(reading.maxY - origin.y));
      const jitter = Math.max(jitterOf(reading), driftX, driftY);
      const row = {
        viewport: viewport.name,
        scenario: name,
        ...reading,
        driftX,
        driftY,
        jitter,
        pass: !reading.error && jitter <= JITTER_PX && reading.offFrames === 0 && reading.saveOffFrames === 0,
      };
      report.push(row);
      console.log(
        `${row.pass ? "ok" : "FAIL"} ${row.viewport} ${name} jitter=${jitter.toFixed(2)}px x=${reading.jitterX.toFixed(2)} y=${reading.jitterY.toFixed(2)} drift=${driftX.toFixed(2)},${driftY.toFixed(2)} off=${reading.offFrames} saveOff=${reading.saveOffFrames} frames=${reading.frames}`,
      );
    }

    await runScenario("hover-gap", async (origin) => {
      const x = origin.x + origin.w * 0.28;
      const y = origin.y + origin.h * 0.72;
      await page.mouse.move(x, y);
      for (let step = 0; step < 12; step += 1) {
        await page.mouse.move(x + (step % 2 === 0 ? 6 : -4), y + (step % 3 === 0 ? 5 : -3));
        await page.waitForTimeout(80);
      }
      await page.screenshot({ path: `${OUT}/${viewport.name}-hover.png` });
    });

    await runScenario("border", async (origin) => {
      const inset = 6;
      const points = [
        [origin.x + inset, origin.y + origin.h / 2],
        [origin.x + origin.w - inset, origin.y + origin.h / 2],
        [origin.x + origin.w / 2, origin.y + inset],
        [origin.x + origin.w / 2, origin.y + origin.h - inset],
        [origin.x + inset, origin.y + inset],
        [origin.x + origin.w - inset, origin.y + origin.h - inset],
      ];
      for (const [x, y] of points) await page.mouse.move(x, y, { steps: 6 });
    });

    const pointOf = async (label) =>
      page.locator('[data-desk-form="matter"]').getByLabel(label).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + Math.min(24, rect.width / 2), y: rect.y + rect.height / 2 };
      });

    await runScenario("rule-dropdown", async (origin) => {
      const target = await pointOf("Rule");
      await page.mouse.move(target.x, target.y);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.mouse.move(origin.x + 36, origin.y + origin.h * 0.55);
    });

    await runScenario("date-field", async () => {
      const target = await pointOf("Order date");
      await page.mouse.move(target.x, target.y);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
    });

    await runScenario("type-matter", async () => {
      const target = await pointOf("Matter");
      await page.mouse.click(target.x, target.y);
      await page.keyboard.type("Rao v Sunrise");
    });

    await runScenario("scroll-page", async () => {
      await page.mouse.move(4, 4);
      await page.mouse.wheel(0, 480);
      await page.waitForTimeout(200);
      await page.mouse.wheel(0, -480);
    });

    await settle(page);
    await page.setViewportSize({ width: Math.max(800, viewport.width - 160), height: Math.max(560, viewport.height - 120) });
    await page.waitForTimeout(300);
    const afterResize = await sample(page, SAMPLE_MS);
    const resizeRow = {
      viewport: viewport.name,
      scenario: "after-resize",
      ...afterResize,
      jitter: jitterOf(afterResize),
      pass: !afterResize.error && jitterOf(afterResize) <= JITTER_PX && afterResize.offFrames === 0 && afterResize.saveOffFrames === 0,
    };
    report.push(resizeRow);
    console.log(
      `${resizeRow.pass ? "ok" : "FAIL"} ${resizeRow.viewport} after-resize jitter=${resizeRow.jitter.toFixed(2)}px off=${afterResize.offFrames} saveOff=${afterResize.saveOffFrames}`,
    );

    console.log(`rest ${viewport.name}`, resting);
    await context.close();
  }

  await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  const failed = report.filter((row) => !row.pass);
  assert.equal(failed.length, 0, `${failed.length} unstable popover scenarios\n${failed.map((row) => `${row.viewport} ${row.scenario} jitter=${row.jitter.toFixed(2)} off=${row.offFrames} saveOff=${row.saveOffFrames}`).join("\n")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
