/** Uses the isolated mobile-ui-fixture.ts API and a local Hub. No hosted accounts or models. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.HUB_WEB ?? "http://localhost:3092";
const API = process.env.HUB_API ?? "http://localhost:4092";
for (const origin of [WEB, API]) assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const fixture = JSON.parse(readFileSync(process.env.MOBILE_FIXTURE_PATH ?? "/tmp/ensemble-mobile-ui.json", "utf8"));
const response = await fetch(`${API}/api/workspace`, { headers: { cookie: fixture.cookie } });
assert.equal(response.status, 200);
const original = await response.json();
assert.ok(original.running.length);
const shots = process.env.RUNS_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const fits = async page => assert.equal(await page.locator("#main-content").evaluate(el => el.scrollWidth <= el.clientWidth + 2), true, `${page.url()} fits`);

async function openContext(width, modules = "runs,workspace") {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, reducedMotion: "reduce" });
  const [name, ...value] = fixture.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: WEB }]);
  const page = await context.newPage();
  const errors = [], forbidden = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  const board = structuredClone(original);
  const base = board.running[0];
  board.maxConcurrent = 3;
  board.queued = [{ ...base, id: "fixture-queued", status: "queued", title: `Next task ${"LongUnbrokenTitle".repeat(12)}`, waitingFor: "Same folder as another task: it starts when that one ends.", position: 1 }];
  board.waiting = [{ ...base, id: "fixture-waiting", status: "waiting_approval", title: "Choose the implementation approach" }];
  await page.route("**/api/shell", async route => {
    const response = await route.fetch();
    const shell = await response.json();
    shell.modules = [...shell.modules.split(",").filter(id => id !== "runs" && id !== "workspace"), ...modules.split(",").filter(Boolean)].join(",");
    await route.fulfill({ response, json: shell });
  });
  await page.route("**/api/workspace", async route => {
    if (!modules.includes("workspace")) forbidden.push("workspace");
    await route.fulfill({ json: board });
  });
  let historyError = false;
  await page.route("**/api/runs?*", async route => {
    if (!modules.includes("runs")) forbidden.push("runs");
    if (historyError) return route.fulfill({ status: 503, json: { error: "Run history is temporarily unavailable" } });
    await route.continue();
  });
  await page.route("**/api/agent/pause", async route => {
    assert.equal(route.request().method(), "POST"); writes.push("pause"); board.paused = true;
    await route.fulfill({ json: { stopped: board.running.length, cancelled: 0 } });
  });
  await page.route("**/api/agent/resume", async route => {
    assert.equal(route.request().method(), "POST"); writes.push("resume"); board.paused = false;
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/agent/jobs/fixture-queued/stop", async route => {
    assert.equal(route.request().method(), "POST"); writes.push("cancel"); board.queued = [];
    await route.fulfill({ json: {} });
  });
  return { context, page, errors, forbidden, writes, failHistory: value => { historyError = value; } };
}

try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const { context, page, errors, forbidden, writes, failHistory } = await openContext(width);
    await page.goto(`${WEB}/workspace`);
    await page.waitForURL(/\/runs$/);
    await page.locator("[data-run-queue] .tile").first().waitFor();
    await page.getByRole("button", { name: /^Preview the run/ }).first().waitFor();
    assert.equal(await page.locator('a[href="/workspace"]').count(), 0, "Workspace is not a navigation tab");
    for (const name of ["Up next", "Working now", "Needs you"]) await page.getByRole("region", { name, exact: true }).waitFor();
    assert.equal(await page.getByText("Recently done", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Stopped or failed", { exact: true }).count(), 0);
    assert.equal(await page.locator("[data-run-queue]").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), width < 1024 ? 1 : 3);
    assert.ok(await page.getByRole("region", { name: "Working now", exact: true }).getByText("2 active · 3 slots").count(), "waiting jobs count towards occupied slots");
    assert.ok(await page.getByRole("region", { name: "Up next", exact: true }).getByTestId("job-waiting-for").count());
    await fits(page);
    if (shots) await page.screenshot({ path: `${shots}/runs-${width}.png`, fullPage: true });
    const bounds = await page.locator("#main-content").boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 70;
    if (width < 768) {
      const scroll = await page.context().newCDPSession(page);
      await scroll.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 12; step++) {
        await scroll.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
      }
      await scroll.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await scroll.detach();
    } else {
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 200);
    }
    await page.waitForFunction(() => document.querySelector("#main-content").scrollTop > 0);
    await page.locator("#main-content").evaluate(el => { el.scrollTop = 0; });
    await page.getByRole("button", { name: "About run slots", exact: true }).click();
    await page.getByRole("tooltip").waitFor();
    assert.match(await page.getByRole("tooltip").innerText(), /one extra job/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Assign task", exact: true }).click();
    await page.getByRole("dialog", { name: "Assign to agent", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Pause all", exact: true }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("button", { name: "Pause all", exact: true }).waitFor();
    await page.getByRole("region", { name: "Up next", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Nothing queued.", { exact: true }).waitFor();
    assert.deepEqual(writes, ["pause", "resume", "cancel"]);
    await page.getByRole("region", { name: "Needs you", exact: true }).locator(".tile").click();
    await page.locator(".task-peek").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Preview the run/ }).first().click();
    await page.getByRole("tab", { name: /Traces/ }).click();
    assert.equal(await page.locator(".run-sheet").evaluate(el => el.scrollWidth <= el.clientWidth + 2), true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: /^Show all runs/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Preview the run"]').length === 14);
    assert.equal(await page.getByRole("button", { name: /^Preview the run/ }).count(), 14);
    failHistory(true);
    await page.reload();
    await page.getByText("Run history is temporarily unavailable", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-run-queue]").isVisible(), true, "history errors do not hide live work");
    failHistory(false);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: /^Preview the run/ }).first().waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    await context.close();
    console.log(`Combined Runs: ${width}px passed`);
  }
  for (const modules of ["workspace", "runs", ""]) {
    const { context, page, forbidden, errors } = await openContext(390, modules);
    await page.goto(`${WEB}/runs`);
    if (modules === "workspace") {
      await page.locator("[data-run-queue]").waitFor();
      assert.equal(await page.getByRole("region", { name: "Recent runs", exact: true }).count(), 0);
    } else if (modules === "runs") {
      await page.getByRole("button", { name: /^Preview the run/ }).first().waitFor();
      assert.equal(await page.locator("[data-run-queue]").count(), 0);
    } else {
      await page.getByRole("button", { name: "Enable Runs", exact: true }).waitFor();
      assert.equal(await page.locator("[data-run-queue]").count(), 0);
    }
    await fits(page);
    assert.deepEqual(forbidden, [], "disabled modules never make API reads");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Runs module isolation: ${modules || "neither"} passed`);
  }
  const { context, page, errors } = await openContext(390);
  await page.goto(`${WEB}/workspace?run=${fixture.runId}`);
  await page.waitForURL(new RegExp(`/runs\\?run=${fixture.runId}$`));
  await page.getByRole("tab", { name: /Traces/ }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  console.log("Workspace bookmarks retain run deep links.");
} finally { await browser.close(); }
