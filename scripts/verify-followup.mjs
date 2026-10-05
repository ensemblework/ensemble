/**
 * Functional checks and screenshots for the follow-up fixes.
 *
 *   WEB=http://localhost:3000 node scripts/verify-followup.mjs
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB ?? "http://localhost:3000";
const API = process.env.API ?? "http://127.0.0.1:4000";
const SHOTS = process.env.SHOTS ?? "/opt/cursor/artifacts/after2";
const EMAIL = process.env.BENCH_EMAIL ?? "baseline-1790654001983@ensemble.local";
const PASSWORD = process.env.BENCH_PASSWORD ?? "baseline-pass-1";
const REVIEW = process.env.REVIEW ?? "1ffb1026-05f5-4b62-af37-d2458173639e";

mkdirSync(SHOTS, { recursive: true });

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

function intersects(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function contrast(fg, bg) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const parse = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => Number(p.trim()));
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] ?? 1];
  };
  const f = parse(fg);
  const b = parse(bg);
  if (!f || !b) return null;
  const L1 = lum(f);
  const L2 = lum(b);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// --- signed-out: middleware redirect, no hub chrome ---
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__bad = [];
    const needles = ["Proposed todos", "No deliverables yet", "My focus", "Offline"];
    const scan = () => {
      const text = document.body?.textContent || "";
      for (const needle of needles) {
        if (text.includes(needle) && !window.__bad.includes(needle)) window.__bad.push(needle);
      }
    };
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
  let status = 0;
  page.on("response", (res) => {
    if (res.url().replace(/\/$/, "") === `${WEB}/today`) status = res.status();
  });
  await page.goto(`${WEB}/today`, { waitUntil: "load" });
  const bad = await page.evaluate(() => window.__bad);
  check("signed-out redirects", page.url().includes("/login") && (status === 307 || status === 302), `status ${status} url ${page.url()}`);
  check("signed-out paints no hub chrome", bad.length === 0, bad.join(", "));
  await context.close();
}

// --- revoked session is rejected immediately ---
{
  const value = await login();
  const me = await fetch(`${API}/api/auth/me`, { headers: { cookie: `ensemble_session=${value}` } });
  check("session works before revoke", me.status === 200, String(me.status));
  const id = createHash("sha256").update(value).digest("hex");
  execSync(`sudo -u postgres psql -d ensemble -c "DELETE FROM sessions WHERE id='${id}'"`);
  const again = await fetch(`${API}/api/auth/me`, { headers: { cookie: `ensemble_session=${value}` } });
  check("revoked session is 401 immediately", again.status === 401, String(again.status));
}

const cookie = await login();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addCookies([{ name: "ensemble_session", value: cookie, url: WEB }]);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 240));
});
page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 240)));

await page.goto(`${WEB}/today`, { waitUntil: "load" });
await page.getByText("Reply to Priya with the latency numbers").first().waitFor({ timeout: 20000 });
await page.screenshot({ path: `${SHOTS}/today.png` });

// palette
await page.keyboard.press("Control+k");
await page.getByRole("dialog", { name: "Command palette" }).waitFor();
await page.waitForTimeout(150);
const outline = await page.getByPlaceholder("Jump to a page or task").evaluate((el) => {
  const style = getComputedStyle(el);
  return { style: style.outlineStyle, color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset };
});
const outlineGone = outline.style === "none" || outline.color === "rgba(0, 0, 0, 0)" || outline.width === "0px";
check("palette input has no square focus outline", outlineGone, JSON.stringify(outline));
const list = page.locator("#command-list");
await list.evaluate((el) => {
  el.scrollTop = el.scrollHeight;
});
const last = page.locator('#command-list [role="option"]').last();
const lastBox = await last.boundingBox();
const dialogBox = await page.getByRole("dialog", { name: "Command palette" }).boundingBox();
const lastInside = lastBox && dialogBox && lastBox.y + lastBox.height <= dialogBox.y + dialogBox.height + 1;
check("palette last row is inside the dialog", Boolean(lastInside), JSON.stringify({ lastBox, dialogBox }));
await page.screenshot({ path: `${SHOTS}/palette-open.png` });
await page.keyboard.press("Escape");

// shortcuts
await page.keyboard.press("?");
const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
await sheet.waitFor();
const sheetText = await sheet.innerText();
check("shortcuts say Ctrl on this platform", sheetText.includes("Ctrl+K") && !sheetText.includes("⌘"), sheetText.split("\n").slice(0, 6).join(" | "));
await page.getByRole("button", { name: "Close" }).click();
await sheet.waitFor({ state: "hidden" });

// save-on-open
const pagePuts = [];
page.on("request", (req) => {
  if (req.method() === "PUT" && req.url().includes("/page")) pagePuts.push(req.url());
});
await page.getByText("Bump the retry helper and open a PR").first().click();
await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 15000 });
await page.waitForTimeout(1200);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("opening a task does not save the page", pagePuts.length === 0, pagePuts.join(" "));
await page.getByText("Bump the retry helper and open a PR").first().click();
await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 15000 });
await page.waitForTimeout(500);
const toast = await page.getByText("This page changed in another tab").count();
check("reopening within 2s does not conflict", toast === 0, `toasts ${toast} puts ${pagePuts.length}`);
const askWhilePeek = await page.getByRole("button", { name: "Ask Ensemble" }).count();
check("ask pill hides while a task panel is open", askWhilePeek === 0, String(askWhilePeek));
await page.keyboard.press("Escape");

// partial invalidation
const homeHits = [];
const taskHits = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/api/today/home")) homeHits.push(url);
  if (url.includes("/api/tasks") && req.method() === "GET") taskHits.push(url);
});
const taskId = await page.evaluate(async () => {
  const response = await fetch("/api/tasks", { credentials: "include" });
  const data = await response.json();
  const task = data.tasks.find((row) => row.title.includes("Bump the retry helper"));
  return task?.id ?? null;
});
homeHits.length = 0;
taskHits.length = 0;
await page.evaluate(async (id) => {
  await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priority: "p1" }),
  });
}, taskId);
await page.waitForTimeout(1500);
check("task change refetches /api/tasks", taskHits.length > 0, `tasks ${taskHits.length}`);
check("task change does not refetch /api/today/home", homeHits.length === 0, `home ${homeHits.length}`);

// assistant error keeps the draft
await page.getByRole("button", { name: "Ask Ensemble" }).click();
const composer = page.getByPlaceholder("Ask, or tell me what to change. @ to mention…");
await composer.fill("Where is the retry helper?");
await composer.press("Enter");
const banner = page.locator("a[href='/settings#models']").locator("xpath=..");
await banner.waitFor({ timeout: 20000 });
const reason = (await banner.innerText()).replace(/\s+/g, " ");
const kept = await composer.inputValue();
check("assistant shows the runtime reason", !reason.includes("Something went wrong") && reason.length > 20, reason);
check("assistant keeps the typed message", kept.includes("Where is the retry helper"), kept);
check("assistant links to model settings", reason.includes("Settings"), reason);
await page.getByRole("button", { name: "Close" }).click();

// board scroll + shot
await page.locator("aside").getByRole("link", { name: "Board", exact: true }).click();
await page.waitForURL("**/board");
await page.locator("[data-column='waiting']").waitFor();
const scroller = page.locator(".overflow-x-auto").first();
const metrics = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
await scroller.evaluate((el) => {
  el.scrollLeft = el.scrollWidth;
});
await page.waitForTimeout(50);
const column = await page.locator("[data-column='waiting']").boundingBox();
const port = await scroller.boundingBox();
const columnFits = column && port && column.x + column.width <= port.x + port.width + 2 && column.x >= port.x - 2;
check(
  "board 4th column scrolls fully into view",
  Boolean(columnFits) && metrics.scrollWidth > metrics.clientWidth,
  JSON.stringify({ metrics, column, port }),
);
await scroller.evaluate((el) => {
  const column = el.querySelector("[data-column='waiting']");
  if (!column) return;
  const delta = column.getBoundingClientRect().right - el.getBoundingClientRect().right;
  el.scrollLeft += Math.max(0, delta + 12);
});
await page.screenshot({ path: `${SHOTS}/board.png` });

// context graph + people
await page.locator("aside").getByRole("link", { name: "Context", exact: true }).click();
await page.waitForURL("**/context");
await page.getByText("Last interaction").first().waitFor();
const label = page.getByText("Last interaction").first();
const labelBox = await label.boundingBox();
const clockBox = await label.locator("xpath=following-sibling::*[1]").locator("svg").boundingBox();
const gap = labelBox && clockBox ? clockBox.x - (labelBox.x + labelBox.width) : -1;
check("people label does not collide with the clock", gap >= 4, `gap ${gap}`);
await page.getByRole("tab", { name: "Graph" }).click();
const graph = page.locator("div.overflow-auto").filter({ has: page.locator("svg") }).first();
await graph.waitFor({ timeout: 15000 });
const skillsHeader = graph.getByText("Skills", { exact: true });
await skillsHeader.waitFor({ timeout: 15000 });
await graph.evaluate((el) => {
  el.scrollLeft = el.scrollWidth;
});
await page.waitForTimeout(50);
const skills = await skillsHeader.boundingBox();
const graphBox = await graph.boundingBox();
const skillsFit =
  skills && graphBox && skills.x >= graphBox.x - 1 && skills.x + skills.width <= graphBox.x + graphBox.width + 2;
check("graph skills column scrolls fully into view", Boolean(skillsFit), JSON.stringify({ skills, graphBox }));
await page.screenshot({ path: `${SHOTS}/context-graph.png` });

// metrics copy + ask pill clearance
await page.locator("aside").getByRole("link", { name: "Metrics", exact: true }).click();
await page.waitForURL("**/metrics");
await page.getByText("Token counts come back").waitFor({ timeout: 15000 });
const metricsText = await page.locator("main").innerText();
check("metrics does not show -0 min", !/-0(\.0)? min/.test(metricsText), (metricsText.match(/.{0,20}-0.{0,12}/) || []).join(" | "));
check("metrics does not say 1 calls", !/\b1 calls\b/.test(metricsText));
const note = page.getByText("Token counts come back");
await note.scrollIntoViewIfNeeded();
await page.evaluate(() => {
  const main = document.querySelector("main");
  if (main) main.scrollTop = main.scrollHeight;
});
await page.waitForTimeout(100);
const noteBox = await note.boundingBox();
const askBox = await page.getByRole("button", { name: "Ask Ensemble" }).boundingBox();
check("ask pill does not cover the metrics note", !intersects(noteBox, askBox), JSON.stringify({ noteBox, askBox }));

// light board contrast
await page.locator("aside").getByRole("link", { name: "Board", exact: true }).click();
await page.getByTitle("Switch to light").click();
await page.locator("[data-column='proposed'] .tag").first().waitFor();
await page.waitForTimeout(150);
const samples = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll("[data-column] .tag, header .tag")].slice(0, 8);
  return nodes.map((node) => {
    const style = getComputedStyle(node);
    return { text: node.textContent?.trim() ?? "", color: style.color, background: style.backgroundColor };
  });
});
const ratios = samples.map((sample) => ({ ...sample, ratio: contrast(sample.color, sample.background) }));
const worst = ratios.reduce((min, sample) => (sample.ratio != null && sample.ratio < min ? sample.ratio : min), 21);
check("light pills meet WCAG AA", ratios.length > 0 && worst >= 4.5, `worst ${worst.toFixed(2)} ${JSON.stringify(ratios)}`);
await page.screenshot({ path: `${SHOTS}/board-light.png` });
await page.getByTitle("Switch to dark").click();

// narrow drawer
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${WEB}/today`, { waitUntil: "load" });
await page.getByText("My focus").waitFor({ timeout: 15000 });
const side = page.locator('nav[aria-label="Primary"]');
check("sidebar is not on screen at 390px", (await side.count()) === 0, `count ${await side.count()}`);
await page.getByLabel("Toggle sidebar").click();
await side.waitFor({ state: "visible", timeout: 5000 });
const openBox = await side.boundingBox();
check("menu opens the sidebar drawer", Boolean(openBox && openBox.width > 100 && openBox.x >= 0), JSON.stringify(openBox));

// one layout trace on a cold today
{
  const traced = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await traced.addCookies([{ name: "ensemble_session", value: cookie, url: WEB }]);
  const tracePage = await traced.newPage();
  const client = await traced.newCDPSession(tracePage);
  const events = [];
  client.on("Tracing.dataCollected", (payload) => events.push(...payload.value));
  const finished = new Promise((resolve) => client.once("Tracing.tracingComplete", resolve));
  await client.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline" });
  await tracePage.goto(`${WEB}/today`, { waitUntil: "commit" });
  await tracePage.getByText("Reply to Priya with the latency numbers").first().waitFor({ timeout: 20000 });
  await tracePage.waitForTimeout(300);
  await client.send("Tracing.end");
  await finished;
  const layouts = events.filter((event) => event.name === "Layout" && event.ph === "X" && event.dur > 0);
  const max = layouts.reduce((hi, event) => Math.max(hi, event.dur), 0) / 1000;
  console.log("layout max ms", Math.round(max), "events", layouts.length, "over 100", layouts.filter((e) => e.dur > 100000).length);
  check("cold today layout pass stays under 150ms", max < 150, `${max.toFixed(0)} ms`);
  await traced.close();
}

const unexpected = consoleErrors.filter((line) => !/favicon|model-keys|Failed to load resource|503|404/.test(line));
check("no unexpected console errors", unexpected.length === 0, unexpected.slice(0, 5).join(" || "));

await browser.close();
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("verify-followup passed");
