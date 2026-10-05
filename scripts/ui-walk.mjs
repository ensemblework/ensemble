/**
 * Click through every Hub page on a running production server.
 *
 *   WEB=http://localhost:3000 SHOTS=/opt/cursor/artifacts/after node scripts/ui-walk.mjs
 *
 * Uses the system Chrome. Signup is exercised, then the seeded account is used
 * so Board, Needs me, and Today have real rows.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB ?? "http://localhost:3000";
const API = process.env.API ?? "http://127.0.0.1:4000";
const SHOTS = process.env.SHOTS ?? "/opt/cursor/artifacts/after";
const EMAIL = process.env.BENCH_EMAIL ?? "baseline-1790654001983@ensemble.local";
const PASSWORD = process.env.BENCH_PASSWORD ?? "baseline-pass-1";

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const ignored = (text) =>
  /favicon|model-keys|ERR_FAILED|Failed to load resource|503|404/.test(text);

function watch(page, bucket) {
  page.on("console", (msg) => {
    if (msg.type() === "error") bucket.push(msg.text().slice(0, 400));
  });
  page.on("pageerror", (err) => bucket.push(`pageerror: ${String(err).slice(0, 400)}`));
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Today renders an h1 on the desk and on the classic canvas. */
async function seeToday(page) {
  await page.getByRole("heading", { name: "Today", level: 1 }).waitFor({ timeout: 20000 });
}

const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
watch(page, errors);

const signupEmail = `walk-${Date.now()}@ensemble.local`;
await page.goto(`${WEB}/signup`, { waitUntil: "load" });
await page.getByLabel("Name").fill("Walk");
await page.getByLabel("Email").fill(signupEmail);
await page.getByLabel("Password").fill("walk-pass-1");
await shot(page, "signup");
await page.click('button[type="submit"]');
await page.waitForURL((url) => !url.pathname.startsWith("/signup"), { timeout: 20000 });
await page.waitForTimeout(400);

await context.clearCookies();
await page.goto(`${WEB}/login`, { waitUntil: "load" });
await page.getByLabel("Email").fill(EMAIL);
await page.getByLabel("Password").fill(PASSWORD);
await shot(page, "login");
await page.click('button[type="submit"]');
await seeToday(page);
await page.waitForTimeout(500);
await shot(page, "today");

await page.locator("aside").getByRole("link", { name: "Board", exact: true }).click();
await page.waitForURL("**/board");
await page.waitForSelector("text=New task", { timeout: 10000 });
const card = page.getByText("Write the ranker ADR").first();
const column = page.locator('[data-column="in_progress"]');
await card.dragTo(column, { targetPosition: { x: 40, y: 80 } });
await page.waitForTimeout(500);
await page.locator('button[title^="Undo"]').click({ timeout: 2000 }).catch(() => undefined);
await page.waitForTimeout(300);
await shot(page, "board");

const stops = [
  ["Needs me", "**/needs-me", "needs-me", "Ensemble approvals"],
  ["Runs", "**/runs", "runs", "Recent runs"],
  ["Context", "**/context", "context", null],
  ["Skills", "**/skills", "skills", "Skill library"],
  ["Workspace", "**/workspace", "workspace", "Workspace"],
  ["Code", "**/code", "code", "Code"],
  ["Metrics", "**/metrics", "metrics", "Metrics"],
  ["Settings", "**/settings", "settings", "Make Ensemble work your way"],
];

for (const [label, url, name, marker] of stops) {
  await page.locator("aside").getByRole("link", { name: label }).click();
  await page.waitForURL(url, { timeout: 10000 });
  if (name === "context") await page.getByRole("heading", { name: "Context", level: 1 }).waitFor({ timeout: 10000 });
  else await page.waitForFunction((text) => document.body.innerText.includes(text), marker, { timeout: 10000 });
  await page.waitForTimeout(350);
  await shot(page, name);
}

await page.goto(`${WEB}/context?view=widgets`, { waitUntil: "load" });
await page.getByRole("tab", { name: "People" }).waitFor({ timeout: 10000 });
for (const tab of ["Projects", "Repos", "Preferences", "Sources", "Artifacts & sync"]) {
  await page.getByRole("tab", { name: tab }).click();
  await page.waitForTimeout(250);
}
await page.getByRole("tab", { name: "Graph" }).click();
await page.waitForSelector("canvas", { timeout: 10000 });
await page.waitForFunction(() => document.querySelector("canvas")?.dataset.sample, { timeout: 10000 });
await page.waitForTimeout(200);
await shot(page, "context-graph");
const sample = await page.locator("canvas").evaluate((node) => node.dataset.sample || "200,200");
const [sx, sy] = sample.split(",").map((n) => Number(n));
const box = await page.locator("canvas").boundingBox();
if (box) {
  await page.mouse.move(box.x + sx, box.y + sy);
  await page.waitForTimeout(250);
  await shot(page, "context-graph-hover");
  await page.mouse.move(box.x + 30, box.y + box.height - 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height - 70, { steps: 6 });
  await page.mouse.up();
}
await page.getByRole("button", { name: "Zoom in" }).click();
await page.getByRole("button", { name: "Zoom out" }).click();

await page.goto(`${WEB}/code/review`, { waitUntil: "load" });
await page.waitForFunction(
  () => document.body.innerText.includes("Back to Code") || document.body.innerText.includes("Filter files"),
  { timeout: 10000 },
);
await shot(page, "code-review");

await page.goto(`${WEB}/today`, { waitUntil: "load" });
await seeToday(page);
await page.getByRole("button", { name: "Ask Ensemble", exact: true }).click();
await page.waitForSelector("text=Writes wait until you apply them", { timeout: 8000 });
await shot(page, "assistant-open");
await page.getByRole("button", { name: "Close" }).click();
await page.waitForSelector('button[aria-label="Ask Ensemble"]', { timeout: 5000 });

await page.locator("aside").getByRole("button", { name: /Jump to/ }).click();
await page.waitForSelector('input[placeholder="Jump to a page or task"]', { timeout: 5000 });
await page.keyboard.press("Escape");

await page.goto(`${WEB}/settings`, { waitUntil: "load" });
await page.waitForSelector("text=Accent", { timeout: 10000 });
await shot(page, "settings");
for (const preset of ["Tide", "Ember"]) {
  await page.getByRole("button", { name: `Accent ${preset}` }).click();
  await page.waitForTimeout(250);
  const slug = preset.toLowerCase();
  if (preset === "Tide") await shot(page, "settings-accent");
  await page.goto(`${WEB}/today`, { waitUntil: "load" });
  await seeToday(page);
  await shot(page, `today-${slug}`);
  await page.goto(`${WEB}/board`, { waitUntil: "load" });
  await page.waitForSelector("text=New task", { timeout: 10000 });
  await shot(page, `board-${slug}`);
  await page.goto(`${WEB}/settings`, { waitUntil: "load" });
  await page.waitForSelector("text=Accent", { timeout: 10000 });
}
await page.locator('input[aria-label="Custom accent"]').evaluate((node) => {
  const input = node;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, "#d946ef");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase() !== "#7c6af7");
await page.getByRole("button", { name: "Accent Indigo" }).click();
await page.waitForTimeout(200);

await page.getByTitle("Switch to light").click();
await page.goto(`${WEB}/today`, { waitUntil: "load" });
await seeToday(page);
await shot(page, "today-light");
await page.getByTitle("Switch to dark").click();

await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${WEB}/today`, { waitUntil: "load" });
await seeToday(page);
await shot(page, "today-390");
for (const [href, marker] of [
  ["/board", "New task"],
  ["/context", "People"],
  ["/settings", "Accent"],
]) {
  await page.goto(`${WEB}${href}`, { waitUntil: "load" });
  await page.waitForFunction((text) => document.body.innerText.includes(text), marker, { timeout: 10000 });
}
await page.setViewportSize({ width: 1280, height: 800 });

await browser.close();

const unexpected = [...new Set(errors.filter((line) => !ignored(line)))];
const pageErrors = unexpected.filter((line) => line.startsWith("pageerror"));
const consoleErrors = unexpected.filter((line) => !line.startsWith("pageerror"));
const report = {
  signupEmail,
  shots: SHOTS,
  pageErrors,
  consoleErrors,
  ignored: [...new Set(errors.filter((line) => ignored(line)))].slice(0, 20),
};
writeFileSync(`${SHOTS}/walk.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (pageErrors.length || consoleErrors.length) {
  console.error("walk failed", API);
  process.exit(1);
}
