/**
 * Click-to-ready timings for the two editors and cold Today.
 *
 *   WEB=http://localhost:3000 RUNS=3 node scripts/measure-open.mjs
 *
 * A fresh browser context per run (empty cache). Times are performance.now()
 * inside the page: navigation start → first task text, pointerdown → .ProseMirror,
 * pointerdown on the file tab → .cm-editor.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB ?? "http://localhost:3000";
const API = process.env.API ?? "http://127.0.0.1:4000";
const RUNS = Number(process.env.RUNS ?? 3);
const OUT = process.env.OUT ?? "/tmp/measure-open.json";
const EMAIL = process.env.BENCH_EMAIL ?? "baseline-1790654001983@ensemble.local";
const PASSWORD = process.env.BENCH_PASSWORD ?? "baseline-pass-1";
const REVIEW = process.env.REVIEW ?? "1ffb1026-05f5-4b62-af37-d2458173639e";
const TASK = "Reply to Priya with the latency numbers";
const OPEN = "Bump the retry helper and open a PR";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function login() {
  const response = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login ${response.status}`);
  const raw = response.headers.getSetCookie?.() ?? [];
  const setCookie = raw.find((entry) => entry.startsWith("ensemble_session=")) ?? "";
  const value = setCookie.split(";")[0]?.slice("ensemble_session=".length);
  if (!value) throw new Error("no session cookie");
  return value;
}

async function watchToday(page) {
  await page.addInitScript((needle) => {
    window.__taskAt = 0;
    window.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__long.push({ start: entry.startTime, dur: entry.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // optional
    }
    const scan = () => {
      if (window.__taskAt) return;
      if ((document.body?.textContent || "").includes(needle)) window.__taskAt = performance.now();
    };
    const tick = () => {
      scan();
      if (!window.__taskAt) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, TASK);
}

async function arm(page, selector) {
  await page.evaluate((sel) => {
    window.__down = 0;
    window.__ready = 0;
    window.__longAfter = 0;
    const mark = () => {
      if (!window.__down) window.__down = performance.now();
    };
    document.addEventListener("pointerdown", mark, true);
    const seen = () => {
      if (window.__ready || !document.querySelector(sel)) return;
      window.__ready = performance.now();
    };
    new MutationObserver(seen).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    try {
      new PerformanceObserver((list) => {
        if (!window.__down) return;
        for (const entry of list.getEntries()) window.__longAfter += entry.duration;
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // long tasks are diagnostic only
    }
  }, selector);
}

async function readOpen(page) {
  await page.waitForFunction(() => window.__ready > 0 && window.__down > 0, { timeout: 15000 });
  return page.evaluate(() => ({
    ms: Math.round((window.__ready - window.__down) * 10) / 10,
    long: Math.round(window.__longAfter * 10) / 10,
  }));
}

async function oneRun(browser, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "ensemble_session", value: cookie, url: WEB }]);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await watchToday(page);
  const navStart = Date.now();
  await page.goto(`${WEB}/today`, { waitUntil: "commit" });
  await page.getByText(TASK).first().waitFor({ state: "visible", timeout: 20000 });
  const today = await page.evaluate((wall) => ({
    taskMs: Math.round(window.__taskAt * 10) / 10,
    wallMs: wall,
    long: (window.__long || []).map((entry) => ({
      start: Math.round(entry.start),
      dur: Math.round(entry.dur),
    })),
  }), Date.now() - navStart);

  await arm(page, ".ProseMirror");
  await page.getByText(OPEN).first().click();
  await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 20000 });
  const peek = await readOpen(page);
  const chunks = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /block-editor|peek-panel|tiptap|file-editor|codemirror/i.test(entry.name))
      .map((entry) => ({
        name: entry.name.split("/").slice(-1)[0].slice(0, 80),
        start: Math.round(entry.startTime),
        end: Math.round(entry.responseEnd),
        dur: Math.round(entry.duration),
      })),
  );

  await page.goto(`${WEB}/code/review?review=${REVIEW}`, { waitUntil: "commit" });
  const fileTab = page.getByRole("button", { name: "file", exact: true });
  await fileTab.waitFor({ state: "visible", timeout: 20000 });
  await arm(page, ".cm-editor");
  await fileTab.click();
  await page.locator(".cm-editor").waitFor({ state: "visible", timeout: 20000 });
  const file = await readOpen(page);

  await context.close();
  return { today: today.taskMs || today.wallMs, todayInPage: today.taskMs, todayWall: today.wallMs, todayLong: today.long, peek, file, chunks };
}

const cookie = await login();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const runs = [];
for (let i = 0; i < RUNS; i++) {
  const run = await oneRun(browser, cookie);
  runs.push(run);
  console.log(
    JSON.stringify({
      run: i + 1,
      today: run.today,
      peek: run.peek,
      file: run.file,
      todayLong: run.todayLong,
      chunks: run.chunks,
    }),
  );
}
await browser.close();

const summary = {
  web: WEB,
  runs: runs.length,
  todayMs: runs.map((run) => run.today),
  peekMs: runs.map((run) => run.peek.ms),
  peekLong: runs.map((run) => run.peek.long),
  fileMs: runs.map((run) => run.file.ms),
  fileLong: runs.map((run) => run.file.long),
  median: {
    today: median(runs.map((run) => run.today)),
    peek: median(runs.map((run) => run.peek.ms)),
    file: median(runs.map((run) => run.file.ms)),
  },
};
writeFileSync(OUT, JSON.stringify({ summary, runs }, null, 2));
console.log("MEDIAN", JSON.stringify(summary.median));
