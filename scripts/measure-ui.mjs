/**
 * Production measurements for the Hub.
 *
 *   WEB=http://localhost:3000 node scripts/measure-ui.mjs
 *
 * Writes JSON to $OUT (default /tmp/measure-ui.json). SQL counts require
 * Postgres logging and sudo; set SKIP_SQL=1 to skip them.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.API ?? "http://127.0.0.1:4000";
const WEB = process.env.WEB ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "/tmp/measure-ui.json";
const LOG = process.env.PG_LOG ?? "/var/log/postgresql/postgresql-16-main.log";
const EMAIL = process.env.BENCH_EMAIL ?? "baseline-1790654001983@ensemble.local";
const PASSWORD = process.env.BENCH_PASSWORD ?? "baseline-pass-1";

function quantile(sorted, q) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

async function login() {
  let response = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    response = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Baseline" }),
    });
  }
  const raw = response.headers.getSetCookie?.() ?? [];
  const setCookie = raw.find((c) => c.startsWith("ensemble_session=")) ?? response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("ensemble_session=")) throw new Error(`login failed ${response.status}`);
  return cookie;
}

async function timed(cookie, path, samples = 20) {
  const times = [];
  let bytes = 0;
  let status = 0;
  let encoding = null;
  for (let i = 0; i < samples + 3; i++) {
    const start = performance.now();
    const response = await fetch(`${API}${path}`, { headers: { cookie, "accept-encoding": "gzip" } });
    const buf = await response.arrayBuffer();
    const ms = performance.now() - start;
    status = response.status;
    encoding = response.headers.get("content-encoding");
    bytes = buf.byteLength;
    if (i >= 3) times.push(ms);
  }
  times.sort((a, b) => a - b);
  return {
    path,
    status,
    bytes,
    encoding,
    p50: Number(quantile(times, 0.5).toFixed(2)),
    p95: Number(quantile(times, 0.95).toFixed(2)),
  };
}

function logSize() {
  return execSync(`sudo wc -c < ${LOG}`).toString().trim();
}

async function queryCount(cookie, path) {
  await fetch(`${API}${path}`, { headers: { cookie } });
  const offset = logSize();
  const start = performance.now();
  const response = await fetch(`${API}${path}`, { headers: { cookie } });
  await response.arrayBuffer();
  const ms = performance.now() - start;
  await new Promise((r) => setTimeout(r, 80));
  const text = execSync(`sudo tail -c +${Number(offset) + 1} ${LOG}`).toString();
  const lines = text.split("\n").filter((line) => line.includes("duration:") && line.includes("LOG:"));
  const useful = lines.filter((line) => !/workspace_jobs/.test(line) && !/pg_stat/.test(line));
  return { path, ms: Number(ms.toFixed(2)), status: response.status, logLines: useful.length };
}

const cookie = await login();
const now = new Date();
const day = now.getDay();
const startDay = new Date(now);
startDay.setHours(0, 0, 0, 0);
if (day === 0) startDay.setDate(startDay.getDate() + 1);
else if (day === 6) startDay.setDate(startDay.getDate() + 2);
else startDay.setDate(startDay.getDate() - (day - 1));
const endDay = new Date(startDay);
endDay.setDate(startDay.getDate() + 5);
const from = encodeURIComponent(startDay.toISOString());
const to = encodeURIComponent(endDay.toISOString());

const paths = [
  "/api/auth/me",
  "/api/shell",
  `/api/today/home?from=${from}&to=${to}`,
  "/api/approvals",
  "/api/decisions?status=pending",
  "/api/connections",
  "/api/tasks",
  "/api/settings",
  "/api/deliverables",
  "/api/reminders",
  `/api/calendar?from=${from}&to=${to}`,
  "/api/runs?take=10",
  "/api/people",
  "/api/projects",
  "/api/repos",
  "/api/preferences",
  "/api/artifacts",
  "/api/documents",
  "/api/context/graph",
  "/api/skills",
  "/api/workspace",
  "/api/code/repos",
  "/api/code/reviews?filter=needs&expired=false",
  "/api/metrics/summary",
  "/api/entities",
  "/api/activity",
];

const latencies = [];
for (const path of paths) {
  const row = await timed(cookie, path);
  latencies.push(row);
  console.log("lat", row.p50, row.p95, row.bytes, row.encoding, row.status, path);
}

let queryCounts = [];
if (process.env.SKIP_SQL !== "1") {
  execSync(`sudo -u postgres psql -d ensemble -c "ALTER SYSTEM SET log_min_duration_statement = 0;" -c "SELECT pg_reload_conf();"`);
  await new Promise((r) => setTimeout(r, 200));
  try {
    for (const path of paths) {
      const row = await queryCount(cookie, path);
      queryCounts.push(row);
      console.log("sql", row.logLines, path);
    }
  } finally {
    execSync(`sudo -u postgres psql -d ensemble -c "ALTER SYSTEM SET log_min_duration_statement = -1;" -c "SELECT pg_reload_conf();"`);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addCookies([
  { name: "ensemble_session", value: cookie.split("=")[1], url: WEB },
]);
const page = await context.newPage();
const reqs = [];
page.on("response", (res) => {
  const url = res.url();
  if (url.includes("/api/")) reqs.push(`${res.status()} ${url.split("?")[0].replace(WEB, "").replace(API, "")}`);
});
const t0 = Date.now();
await page.goto(`${WEB}/today`, { waitUntil: "load" });
await page.waitForSelector("text=Reply to Priya with the latency numbers", { timeout: 20000 });
const timeToContent = Date.now() - t0;
await page.waitForTimeout(600);
const todayCold = {
  timeToContent,
  requests: [...new Set(reqs)],
};

const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const routes = [
  ["/board", "New task"],
  ["/needs-me", "Ensemble approvals"],
  ["/runs", "Recent runs"],
  ["/context", "People"],
  ["/skills", "Skill library"],
  ["/workspace", "Workspace"],
  ["/code", "Code"],
  ["/metrics", "Metrics"],
  ["/settings", "Make Ensemble work your way"],
  ["/today", "My focus"],
];
const navs = [];
for (const [href, marker] of routes) {
  const seen = [];
  const onRes = (res) => {
    if (res.url().includes("/api/")) seen.push(res.url().split("?")[0]);
  };
  page.on("response", onRes);
  const start = Date.now();
  await page.click(`aside a[href="${href}"]`);
  await page.waitForURL(`**${href}`, { timeout: 10000 });
  const shellMs = Date.now() - start;
  await page.waitForFunction(has(marker), { timeout: 8000 });
  const dataMs = Date.now() - start;
  page.off("response", onRes);
  navs.push({ href, shellMs, dataMs, requests: [...new Set(seen)].length });
  console.log("nav", shellMs, dataMs, href);
}

let lighthouse = null;
try {
  const { default: lighthouseRun } = await import("lighthouse");
  const chromeLauncher = await import("chrome-launcher");
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"] });
  const result = await lighthouseRun(`${WEB}/login`, {
    port: chrome.port,
    output: "json",
    onlyCategories: ["performance"],
    logLevel: "error",
  });
  const audits = result.lhr.audits;
  lighthouse = {
    score: result.lhr.categories.performance.score,
    lcp: audits["largest-contentful-paint"]?.numericValue,
    tbt: audits["total-blocking-time"]?.numericValue,
    cls: audits["cumulative-layout-shift"]?.numericValue,
    fcp: audits["first-contentful-paint"]?.numericValue,
  };
  await chrome.kill();
  console.log("lh", lighthouse);
} catch (error) {
  lighthouse = { error: String(error).slice(0, 400) };
}

await browser.close();
const report = { latencies, queryCounts, todayCold, navs, lighthouse };
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("WROTE", OUT);
